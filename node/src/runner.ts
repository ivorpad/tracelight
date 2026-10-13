/**
 * The long-lived runner: NDJSON requests on stdin, replies and run events on stdout
 * (docs/PROTOCOL.md).
 *
 * Each `run` executes in a child Node process (child.ts) with an IPC channel for run events and
 * pipes for fds 1 and 2, which the runner forwards as `output` events (fd-level writes; writes
 * through `process.stdout` arrive over IPC with their `step`). The runner stamps `runId` and
 * `seq`. A finished child stays alive to answer `expand` and `source` until the next run.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { CAPABILITIES, ENV, NAME, PROTOCOL_VERSION, RUNTIME_VERSION } from './protocol.ts';
import { statementBindings } from './bindings.ts';
import { sourceBindings } from './sourceBindings.ts';
import { dirname, join, resolve } from 'node:path';
import { loadPlugins, runStage } from './plugins.ts';

type Msg = Record<string, any>;

const CHILD = fileURLToPath(new URL('./child.ts', import.meta.url));
const KILL_GRACE_MS = 2000;

/** node flags for a runtime process (type stripping before Node 22.18), then `entry` (the run child by default) */
export function childArgs(entry: string = CHILD, version: string = process.versions.node): string[] {
  const args = ['--disable-warning=ExperimentalWarning'];
  // type stripping is on by default from Node 22.18 / 23.6; earlier releases need the flag
  const [maj, min] = version.split('.').map(Number) as [number, number];
  if (maj < 23 && !(maj === 22 && min >= 18)) args.push('--experimental-strip-types');
  args.push('--stack-trace-limit=64', entry);
  return args;
}

const versions = new Map<string, string>();
/**
 * The Node that runs the program: the request's `node` (`run --node`), else `$${ENV}NODE`, else
 * this one. Another Node must be 22.15 or newer (module.registerHooks).
 */
export function childNode(request: Msg): { exe: string; version: string } {
  const want = (typeof request.node === 'string' && request.node) || process.env[`${ENV}NODE`] || '';
  if (!want || want === process.execPath) return { exe: process.execPath, version: process.versions.node };
  let version = versions.get(want);
  if (version === undefined) {
    const r = spawnSync(want, ['-p', 'process.versions.node'], { encoding: 'utf8', timeout: 10000 });
    if (r.error || r.status !== 0) throw new Error(`cannot run ${want}: ${r.error?.message ?? r.stderr.trim()}`);
    version = r.stdout.trim();
    versions.set(want, version);
  }
  const [maj, min] = version.split('.').map(Number) as [number, number];
  if (maj < 22 || (maj === 22 && min < 15)) throw new Error(`${want} is Node ${version}; ${NAME} needs 22.15 or newer`);
  return { exe: want, version };
}

class Child {
  readonly runId: string;
  readonly proc: ChildProcess;
  readonly started = performance.now();
  seq = 0;
  done = false;
  finishedSent = false;
  timedOut = false;
  stopped = false;
  timer: NodeJS.Timeout | undefined;
  deadline = 0;
  result: Msg | undefined;
  readonly pending = new Map<number, (m: Msg) => void>();
  nextId = 1;
  readonly runner: Runner;
  /** a debug run: requests go to the control pipe, which a paused program can still answer */
  debug = false;
  /** the timeout clock is held while the program is paused */
  heldAt = 0;

  constructor(runner: Runner, runId: string, request: Msg) {
    this.runner = runner;
    this.runId = runId;
    const node = childNode(request);
    this.proc = spawn(node.exe, childArgs(CHILD, node.version), {
      cwd: request.cwd || undefined,
      env: { ...process.env, ...(request.env ?? {}), NODE_OPTIONS: '' },
      // fd 5: the control pipe of a debug run, read by the child's debugger thread while the program is paused
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'ipc', 'pipe'],
      windowsHide: true,
    });
    this.proc.stdout!.setEncoding('utf8');
    this.proc.stderr!.setEncoding('utf8');
    this.proc.stdout!.on('data', (text: string) => this.event({ type: 'output', stream: 'stdout', text }));
    this.proc.stderr!.on('data', (text: string) => this.event({ type: 'output', stream: 'stderr', text }));
    const events = createInterface({ input: this.proc.stdio[3] as NodeJS.ReadableStream, crlfDelay: Infinity });
    events.on('line', (line) => {
      try {
        this.onMessage(JSON.parse(line));
      } catch (e) {
        this.runner.send({ type: 'runner.error', runId, message: `bad message from the run child: ${(e as Error).message}` });
      }
    });
    // `close`, not `exit`: every line the child wrote on fd 3 has been read by then
    this.proc.on('close', (code, signal) => this.onExit(code, signal));
    this.proc.on('error', (e) => this.runner.send({ type: 'runner.error', runId, message: `run child failed: ${e.message}` }));
    this.debug = !!(request.config?.debug || (Array.isArray(request.breakpoints) && request.breakpoints.length));
    this.proc.stdio[5]?.on('error', () => {}); // a child that exited mid-write
    // PROTOCOL: `run.started` comes first. The VS Code host shows a run's state only from this
    // event on; without it a finished run stays "running" in the panel forever.
    this.event({ type: 'run.started', pid: this.proc.pid ?? 0 });
    this.proc.send({ type: 'run', request });
    const timeout = Number(request.config?.timeoutMs ?? 30000);
    if (timeout > 0 && !request.config?.debug) {
      this.deadline = performance.now() + timeout;
      this.arm();
    }
  }

  arm(): void {
    if (this.timer) clearTimeout(this.timer);
    if (!this.deadline || this.done) return;
    this.timer = setTimeout(() => this.onTimeout(), Math.max(0, this.deadline - performance.now()));
    this.timer.unref();
  }

  onTimeout(): void {
    if (this.done) return;
    if (performance.now() < this.deadline - 1) return this.arm();
    this.timedOut = true;
    this.terminate();
  }

  event(e: Msg): void {
    if (this.finishedSent && e.type !== 'output') return;
    if (e.type === 'debug.paused' && this.deadline && !this.heldAt) {
      this.heldAt = performance.now();
      if (this.timer) clearTimeout(this.timer);
    } else if (e.type === 'debug.resumed' && this.heldAt) {
      this.deadline += performance.now() - this.heldAt;
      this.heldAt = 0;
      this.arm();
    }
    this.runner.send({ ...e, runId: this.runId, seq: ++this.seq });
  }

  onMessage(m: Msg): void {
    if (m.kind === 'event') {
      const e = m.event as Msg;
      if (e.type === 'file.instrumented' && typeof e.instrumentMs === 'number' && this.deadline) {
        this.deadline += e.instrumentMs; // instrumenting never counts as the program running
        this.arm();
      }
      if (e.type === 'runner.error') this.runner.send({ ...e, runId: this.runId });
      else this.event(e);
    } else if (m.kind === 'reply') {
      const cb = this.pending.get(m.id);
      this.pending.delete(m.id);
      cb?.(m.msg);
    } else if (m.kind === 'done') {
      this.done = true;
      this.result = m;
      if (this.timer) clearTimeout(this.timer);
      this.sendFinished(m.exitCode ?? 0);
    }
  }

  sendFinished(exitCode: number | null): void {
    if (this.finishedSent) return;
    this.finishedSent = true;
    const extra = this.result?.extra && typeof this.result.extra === 'object' ? this.result.extra : {};
    this.runner.send({
      ...extra, // plugin fields; the runtime's own win
      type: 'run.finished',
      runId: this.runId,
      seq: ++this.seq,
      exitCode: this.timedOut || this.stopped ? null : exitCode,
      durationMs: Math.round(performance.now() - this.started),
      timedOut: this.timedOut,
      stopped: this.stopped,
      stepCount: this.result?.stepCount ?? 0,
      logCount: this.result?.logCount ?? 0,
    });
  }

  onExit(code: number | null, signal: NodeJS.Signals | null): void {
    for (const [, cb] of this.pending) cb({ type: 'error', message: 'the run child has exited' });
    this.pending.clear();
    if (this.timer) clearTimeout(this.timer);
    if (!this.finishedSent) {
      if (signal && !this.timedOut && !this.stopped) this.runner.send({ type: 'runner.error', runId: this.runId, message: `the run child died from ${signal}` });
      this.sendFinished(code);
    }
  }

  request(msg: Msg): Promise<Msg> {
    if (this.proc.exitCode !== null || (!this.proc.connected && !this.debug)) return Promise.resolve({ type: 'error', message: 'the run has ended and its values are gone; run again' });
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      const ctl = this.proc.stdio[5] as NodeJS.WritableStream | null;
      if (this.debug && ctl) ctl.write(JSON.stringify({ ...msg, id }) + '\n');
      else this.proc.send({ ...msg, id });
    });
  }

  /** ask the child to flush and exit; kill it if it does not within the grace period */
  terminate(): void {
    if (this.proc.exitCode !== null) return;
    if (this.debug) (this.proc.stdio[5] as NodeJS.WritableStream | null)?.write('{"type":"exit"}\n'); // a paused program is let go first
    try {
      if (this.proc.connected) this.proc.send({ type: 'stop' });
    } catch {
      /* gone */
    }
    const kill = setTimeout(() => {
      if (this.proc.exitCode === null) this.proc.kill('SIGKILL');
    }, KILL_GRACE_MS);
    kill.unref();
  }

  kill(): void {
    if (this.proc.exitCode === null) this.proc.kill('SIGKILL');
  }
}

export class Runner {
  child: Child | undefined;
  readonly pluginsStarted = new Set<string>();
  readonly write: (line: string) => void;

  constructor(write: (line: string) => void = (l) => process.stdout.write(l)) {
    this.write = write;
  }

  send(msg: Msg): void {
    this.write(JSON.stringify(msg) + '\n');
  }

  /** `before` of each plugin once per runner process, here in the runner, ahead of its first run */
  async startPlugins(req: Msg, runId: string): Promise<void> {
    const names: string[] = (Array.isArray(req.config?.plugins) ? req.config.plugins.map(String) : []).filter((n: string) => !this.pluginsStarted.has(n));
    if (!names.length) return;
    for (const n of names) this.pluginsStarted.add(n);
    const main = req.file?.path && !req.module ? resolve(String(req.file.path)) : join(resolve(req.cwd ?? process.cwd()), 'noop.js');
    const dirs = [dirname(main), resolve(req.workspaceRoot ?? dirname(main))];
    const report = (message: string) => this.send({ type: 'runner.error', runId, message: message.replace(/ failed in [a-zA-Z]+:/, ' failed to start:') });
    await runStage(await loadPlugins(names, dirs, report, 'before'), 'before', req.config ?? {}, report);
  }

  async dispatch(req: Msg): Promise<void> {
    const id = req.id;
    try {
      switch (req.type) {
        case 'hello':
          this.send({
            type: 'ready', id, language: 'javascript', nodeVersion: process.versions.node, pythonVersion: process.versions.node,
            executable: process.execPath, platform: process.platform, capabilities: CAPABILITIES, runtimeVersion: RUNTIME_VERSION, protocolVersion: PROTOCOL_VERSION,
          });
          return;
        case 'run': {
          if (this.child) this.child.kill();
          const runId = String(req.runId ?? `r-${Date.now()}`);
          childNode(req); // a --node that cannot run is the request's error, before `ok`
          this.send({ type: 'ok', id });
          await this.startPlugins(req, runId);
          this.child = new Child(this, runId, req);
          return;
        }
        case 'stop': {
          const c = this.child;
          if (c && (!req.runId || req.runId === c.runId)) {
            if (!c.done) {
              c.stopped = true;
              c.terminate();
            }
          }
          this.send({ type: 'ok', id });
          return;
        }
        case 'expand':
        case 'source':
        case 'evaluate':
        case 'shadow':
        case 'complete':
        case 'exec':
        case 'debug': {
          const c = this.child;
          if (!c || (req.runId && req.runId !== c.runId)) {
            this.send({ type: 'error', id, message: `run ${req.runId} is not the current run` });
            return;
          }
          const { id: _ignored, ...rest } = req;
          const reply = await c.request(rest);
          this.send({ ...reply, id });
          return;
        }
        case 'bindings':
          try {
            this.send({ type: 'bindings', id, statements: statementBindings(String(req.source ?? ''), req.path ?? 'x.js'), ...(req.identifiers ? { identifiers: sourceBindings(String(req.source ?? ''), req.path ?? 'x.ts') } : {}) });
          } catch (e) {
            this.send({ type: 'error', id, message: `SyntaxError: ${(e as Error).message}` });
          }
          return;
        case 'shutdown':
          this.child?.kill();
          process.exit(0);
        default:
          this.send({ type: 'error', id, message: `unsupported request type ${JSON.stringify(req.type)}` });
      }
    } catch (e) {
      this.send({ type: 'error', id, message: (e as Error).message });
    }
  }

  serve(input: NodeJS.ReadableStream = process.stdin): Promise<void> {
    const rl = createInterface({ input, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let req: Msg;
      try {
        req = JSON.parse(line);
      } catch {
        this.send({ type: 'runner.error', message: `not JSON: ${line.slice(0, 200)}` });
        return;
      }
      void this.dispatch(req);
    });
    return new Promise((resolve) =>
      rl.on('close', () => {
        this.child?.kill();
        resolve();
      }),
    );
  }
}
