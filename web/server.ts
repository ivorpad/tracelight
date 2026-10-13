/**
 * Tracelight in a browser: a local bridge between one runtime (`<runtime> serve`, NDJSON on stdio,
 * docs/PROTOCOL.md) and the panel page over a WebSocket. The bridge runs the file, re-runs it when
 * it changes on disk (save in VS Code or any editor), relays requests from the page, and lets an
 * agent drive the page over HTTP (`/api/state`, `/api/command`, the `ctl` subcommand).
 *
 *   node dist/web/server.js FILE [--port 4777] [--runtime js|"CMD ARGS"] [--open] [--no-run] [--no-watch]
 *   node dist/web/server.js ctl state | goto N | step into|over|out|back|backOver|backOut | line N | say TEXT [--line N] | clear | run | eval EXPR
 *
 * Binds 127.0.0.1 only. A WebSocket or API call whose Origin or Host is not this server's is
 * refused, so a web page in another tab cannot run code through it. See docs/WEB.md.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { RunnerClient } from '../src/runtime/runnerClient';
import { DEFAULT_RUN_CONFIG } from '../src/config/merge';
import type { DebugBreakpointSpec, DebugExceptionMode, RunConfig, RunEvent, RunRequest, WatchRequest } from '../src/shared/protocol';
import type { AgentCommand, BridgeFile, BridgeProfile, ConfigPatch, BridgeToPage, PageState, PageToBridge, RecentFile, RuntimeInfo } from './bridgeProtocol';
import { summarizeProfile } from './profileSummary';
import { upgrade, type WebSocketConnection } from './ws';
import { applyEvent, emptyRun, type RunData } from './runState';
import { ServerViews } from './serverViews';
import { runtimeRoot } from './runtimeRoot';
import { scratchFunction, runScratch, formatScratchCode, type ScratchRequest } from './scratchpadRuntime';

export const DEFAULT_PORT = 4777;
/** the virtual file `file.read` answers with the bridge's log (Show Logs) */
export const LOG_PATH = 'tracelight://logs';
const RECENT_MAX = 20;

export interface ServerOptions {
  file: string;
  port: number;
  host: string;
  /** `js`, or a whole command line that speaks the protocol on stdio (`node path/to/runtime.js serve`) */
  runtime: string;
  watch: boolean;
  /** false opens the source without an initial execution; explicit runs still work */
  initialRun?: boolean;
  only?: string[];
  open: boolean;
  /** dist/: where the page, the panel bundle and the runtime (`dist/node`) were built to */
  distDir: string;
  /** a command that reads a prompt on stdin and answers (Narrate); else `claude`, else `codex` */
  explainCommand?: string;
  /** where View Recent Files is kept (`recent.json`); `~/.tracelight` by default, '' keeps it in memory */
  stateDir?: string;
}

const LANGUAGES: Record<string, string> = { '.py': 'python', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript', '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'typescript' };

export function languageFor(file: string): string {
  return LANGUAGES[path.extname(file).toLowerCase()] ?? 'plaintext';
}

/** Split a command line on whitespace, keeping "double" or 'single' quoted parts whole. */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

/** The command the bridge spawns for `--runtime`, and the directory it starts in. */
export function runtimeCommand(opts: Pick<ServerOptions, 'runtime' | 'distDir' | 'file'>): { command: string; args: string[]; cwd: string; env: Record<string, string> } {
  if (opts.runtime === 'js') {
    const entry = path.join(runtimeRoot(opts.distDir), 'bin', 'tracelight.mjs');
    if (!fs.existsSync(entry)) throw new Error(`--runtime js needs ${entry}; build the runtime (npm ci --prefix node && npm run build) or pass --runtime "CMD ARGS"`);
    return { command: process.execPath, args: [entry, 'serve'], cwd: path.dirname(opts.file), env: {} };
  }
  const [command, ...args] = splitCommand(opts.runtime);
  if (!command) throw new Error('--runtime is empty');
  return { command, args, cwd: path.dirname(opts.file), env: {} };
}

/**
 * A request may come from this page only: Host must name this server (no DNS rebinding) and an
 * Origin, when the client sends one, must be this server's own.
 */
export function sameOrigin(headers: http.IncomingHttpHeaders, port: number): boolean {
  const local = (host: string) => host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
  const host = headers.host ?? '';
  if (!local(host)) return false;
  const origin = headers.origin;
  if (origin === undefined) return true;
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && local(u.host);
  } catch {
    return false;
  }
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.ttf': 'font/ttf', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

export class BridgeServer {
  private readonly runner: RunnerClient;
  private readonly runtimeInfo: RuntimeInfo;
  private readonly pages = new Set<WebSocketConnection>();
  private server: http.Server | undefined;
  private watcher: fs.FSWatcher | undefined;
  private file: BridgeFile;
  /** the events of the current run, replayed to a page that connects late */
  private events: RunEvent[] = [];
  private current: { runId: string; content: string; reason: string } | null = null;
  /** the current run folded into models, for Narrate and the tour */
  private runData: RunData | null = null;
  private readonly views: ServerViews;
  /** the Time Machine's watches and where it is, sent with every run until the page changes them */
  private watch: WatchRequest[] = [];
  private traceContext: { step: number; prefetch: number } | undefined;
  /** the live debugger: a runtime of its own, started on first use, and its one run */
  private debugRunner: RunnerClient | undefined;
  private debugRun: { runId: string; content: string; events: RunEvent[] } | null = null;
  private debugCounter = 0;
  private runCounter = 0;
  private nextAgentId = 1;
  private readonly agentWaiters = new Map<number, (r: { result: unknown; error?: string }) => void>();
  private lastState: PageState | null = null;
  private watchTimer: NodeJS.Timeout | undefined;
  /** the content the bridge last wrote, so its own save does not count as an edit from outside */
  private lastWritten: string | undefined;
  private configPatch: ConfigPatch = {};
  /** unsaved content the page ran; later runs (a settings change) keep running it until the disk changes */
  private buffer: string | undefined;
  /** `onDemand`: a change on disk only refreshes the page's text; Run runs it */
  private runMode: 'auto' | 'onSave' | 'onDemand' = 'auto';
  /** the file the bridge started with: Open may only switch to files of its language under its directory */
  private readonly rootFile: string;
  private recent: RecentFile[] = [];
  private lastProfile: string | undefined;
  private profiling = false;

  constructor(private readonly opts: ServerOptions) {
    if (opts.only?.length) this.configPatch.only = opts.only;
    this.file = readBridgeFile(opts.file);
    this.rootFile = this.file.path;
    this.recent = loadRecent(this.recentPath());
    this.remember(this.file);
    const cmd = runtimeCommand(opts);
    this.runtimeInfo = { command: [cmd.command, ...cmd.args].join(' '), ready: null };
    this.runner = new RunnerClient({ command: cmd.command, args: cmd.args, cwd: cmd.cwd, env: cmd.env, version: '1', log: (line) => log(line) });
    this.runner.on('event', (ev) => this.onEvent(ev));
    this.runner.on('runnerError', (message, detail) => this.broadcast({ type: 'runner.error', message, detail }));
    this.runner.on('ready', (ready) => {
      this.runtimeInfo.ready = ready;
      this.broadcast({ type: 'runtime', runtime: this.runtimeInfo });
    });
    this.views = new ServerViews(
      { distDir: opts.distDir, explainCommand: opts.explainCommand },
      () => ({ run: this.runData, mainPath: this.file.path }),
      (m) => this.broadcast(m),
    );
  }

  get url(): string {
    return `http://127.0.0.1:${this.opts.port}/`;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.onHttp(req, res));
    this.server.on('upgrade', (req, socket) => {
      if (req.url !== '/ws' || !sameOrigin(req.headers, this.opts.port)) {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      const ws = upgrade(req, socket);
      if (ws) this.onPage(ws);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.opts.port, this.opts.host, () => resolve());
    });
    // port 0 asks the OS for one (tests); the origin checks need the real one
    const addr = this.server.address();
    if (addr && typeof addr === 'object') this.opts.port = addr.port;
    if (this.opts.watch) this.watchFile();
    if (this.opts.initialRun !== false) void this.run('start');
  }

  async close(): Promise<void> {
    this.watcher?.close();
    for (const p of this.pages) p.close(1001);
    this.views.dispose();
    await Promise.all([this.runner, this.debugRunner].map((r) => r?.shutdown().catch(() => undefined)));
    this.runner.dispose();
    this.debugRunner?.dispose();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /* ---------- runs ---------- */

  async run(reason: string, content?: string): Promise<void> {
    const runId = `w-${++this.runCounter}`;
    if (content !== undefined) this.buffer = content;
    const text = this.buffer ?? this.file.content;
    if (this.current) void this.runner.stop(this.current.runId);
    this.current = { runId, content: text, reason };
    this.runData = emptyRun(runId, text);
    this.views.reset();
    this.events = [];
    this.broadcast({ type: 'run.begin', runId, content: text, reason });
    log(`run ${runId} of ${this.file.displayName} (${reason})`);
    const dir = path.dirname(this.file.path);
    const request: Omit<RunRequest, 'type' | 'id'> = {
      runId,
      file: { path: this.file.path, displayName: this.file.displayName, content: text },
      workspaceRoot: dir,
      cwd: dir,
      argv: [],
      env: {},
      projectFiles: [],
      // the browser has no settings UI of its own yet: the extension's defaults, with every
      // changed local recorded so the Time Machine can show variables at any step
      config: runConfig(this.configPatch),
      markers: [],
      expressionsToEvaluate: {},
      watch: this.watch,
      ...(this.traceContext && this.watch.length ? { traceContext: this.traceContext } : {}),
      mode: 'normal',
    };
    try {
      await this.runner.run(request);
    } catch (err) {
      this.broadcast({ type: 'runner.error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  private onEvent(ev: RunEvent): void {
    if (!this.current || ev.runId !== this.current.runId) return;
    this.events.push(ev);
    if (this.runData) applyEvent(this.runData, ev);
    this.broadcast({ type: 'event', event: ev });
  }

  /* ---------- the live debugger ---------- */

  private ensureDebugRunner(): RunnerClient {
    if (this.debugRunner) return this.debugRunner;
    const cmd = runtimeCommand(this.opts);
    const r = new RunnerClient({ command: cmd.command, args: cmd.args, cwd: cmd.cwd, env: cmd.env, version: '1', log: (line) => log(`debug: ${line}`) });
    r.on('event', (ev) => {
      const d = this.debugRun;
      if (!d || ev.runId !== d.runId) return;
      d.events.push(ev);
      this.broadcast({ type: 'debug.event', event: ev });
      if (ev.type === 'run.finished') {
        this.debugRun = null;
        this.broadcast({ type: 'debug.end', runId: d.runId });
      }
    });
    r.on('runnerError', (message) => {
      const d = this.debugRun;
      this.debugRun = null;
      if (d) this.broadcast({ type: 'debug.end', runId: d.runId, message });
    });
    this.debugRunner = r;
    return r;
  }

  /** One execution supplies both live pauses and recorded history. */
  async startDebug(breakpoints: DebugBreakpointSpec[], exceptions: DebugExceptionMode, content?: string, stopOnEntry = true): Promise<void> {
    await this.stopDebug();
    const runner = this.ensureDebugRunner();
    const runId = `d-${++this.debugCounter}`;
    const text = content ?? this.buffer ?? this.file.content;
    this.debugRun = { runId, content: text, events: [] };
    this.broadcast({ type: 'debug.begin', runId, content: text, recording: true });
    const dir = path.dirname(this.file.path);
    const base = runConfig(this.configPatch);
    const request: Omit<RunRequest, 'type' | 'id'> = {
      runId,
      file: { path: this.file.path, displayName: this.file.displayName, content: text },
      workspaceRoot: dir,
      cwd: dir,
      argv: [],
      env: {},
      projectFiles: [],
      config: { ...base, debug: true, record: true, stopOnEntry, breakOnException: exceptions, timeoutMs: 0, recordLocals: true, autoLog: false, http: 'off', httpObserve: false },
      breakpoints,
      markers: [],
      expressionsToEvaluate: {},
      watch: [],
      mode: 'normal',
    };
    try {
      await runner.run(request);
    } catch (err) {
      this.debugRun = null;
      this.broadcast({ type: 'debug.end', runId, message: err instanceof Error ? err.message : String(err) });
    }
  }

  async stopDebug(): Promise<void> {
    const d = this.debugRun;
    if (!d || !this.debugRunner) return;
    this.debugRun = null;
    await this.debugRunner.stop(d.runId).catch(() => undefined);
    this.broadcast({ type: 'debug.end', runId: d.runId });
  }

  /* ---------- profile ---------- */

  /** One run in the runtime's profile mode on a runtime of its own (the recorded run stays on screen). */
  async profile(content?: string): Promise<BridgeProfile> {
    if (this.profiling) return { error: 'a profile run is already going' };
    this.profiling = true;
    const cmd = runtimeCommand(this.opts);
    const runner = new RunnerClient({ command: cmd.command, args: cmd.args, cwd: cmd.cwd, env: cmd.env, version: '1', log: (line) => log(`profile: ${line}`) });
    const runId = `p-${++this.runCounter}`;
    const dir = path.dirname(this.file.path);
    const text = content ?? this.buffer ?? this.file.content;
    let result: BridgeProfile;
    try {
      const finished = new Promise<Record<string, unknown>>((resolve, reject) => {
        runner.on('event', (ev) => {
          if (ev.runId === runId && ev.type === 'run.finished') resolve(ev as unknown as Record<string, unknown>);
        });
        runner.on('runnerError', (message) => reject(new Error(message)));
      });
      await runner.run({
        runId,
        file: { path: this.file.path, displayName: this.file.displayName, content: text },
        workspaceRoot: dir,
        cwd: dir,
        argv: [],
        env: {},
        projectFiles: [],
        config: runConfig(this.configPatch),
        markers: [],
        expressionsToEvaluate: {},
        watch: [],
        mode: 'profile',
      });
      const ev = await Promise.race([finished, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the profile run did not finish in 120 s')), 120_000))]);
      const file = (ev['profile'] as { path?: string } | undefined)?.path;
      if (!file || !fs.existsSync(file)) result = { error: 'the runtime did not write a .cpuprofile (does it support profile mode?)' };
      else {
        this.lastProfile = file;
        result = { path: file, summary: summarizeProfile(JSON.parse(fs.readFileSync(file, 'utf8'))) };
      }
    } catch (err) {
      result = { error: err instanceof Error ? err.message : String(err) };
    } finally {
      this.profiling = false;
      await runner.shutdown().catch(() => undefined);
      runner.dispose();
    }
    log(`profile: ${result.error ?? `${result.summary?.rows.length} functions, ${result.path}`}`);
    this.broadcast({ type: 'profile', profile: result });
    return result;
  }

  /* ---------- recent files ---------- */

  private recentPath(): string | undefined {
    const dir = this.opts.stateDir ?? path.join(os.homedir(), '.tracelight');
    return dir ? path.join(dir, 'recent.json') : undefined;
  }

  private remember(file: BridgeFile): void {
    this.recent = [{ path: file.path, displayName: file.displayName, at: Date.now() }, ...this.recent.filter((r) => r.path !== file.path)].slice(0, RECENT_MAX);
    const where = this.recentPath();
    if (!where) return;
    try {
      fs.mkdirSync(path.dirname(where), { recursive: true });
      fs.writeFileSync(where, JSON.stringify(this.recent, null, 1));
    } catch (err) {
      log(`recent files not saved: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The recent files that still exist and that Open would accept. */
  recentFiles(): RecentFile[] {
    return this.recent.filter((r) => this.mayOpen(r.path) === null);
  }

  /** null when `file` may become the main file: it exists, is of the runtime's language, and is the start file's directory or below. */
  private mayOpen(file: string): string | null {
    const full = path.resolve(file);
    const root = path.dirname(this.rootFile) + path.sep;
    if (!full.startsWith(root)) return `${file} is outside ${root}`;
    const family = (f: string) => (['javascript', 'typescript'].includes(languageFor(f)) ? 'js' : languageFor(f));
    if (family(full) !== family(this.rootFile)) return `${path.basename(full)} is not ${languageFor(this.rootFile)}, the runtime this bridge runs`;
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return `no such file: ${file}`;
    return null;
  }

  /** Make `file` the main file: the page shows it, the bridge watches it and runs it. */
  async open(file: string): Promise<string | null> {
    const why = this.mayOpen(file);
    if (why) return why;
    await this.stopDebug();
    if (this.current) await this.runner.stop(this.current.runId).catch(() => undefined);
    this.file = readBridgeFile(file);
    this.buffer = undefined;
    this.lastWritten = undefined;
    this.remember(this.file);
    if (this.opts.watch) {
      this.watcher?.close();
      this.watchFile();
    }
    this.broadcast({ type: 'hello', file: this.file, runtime: this.runtimeInfo, watch: this.opts.watch, canNarrate: this.views.canNarrate() });
    await this.run('open');
    return null;
  }

  private watchFile(): void {
    const dir = path.dirname(this.file.path);
    const base = path.basename(this.file.path);
    // watch the directory: editors that save by rename replace the file's inode
    this.watcher = fs.watch(dir, (_kind, name) => {
      if (name !== base) return;
      if (this.watchTimer) clearTimeout(this.watchTimer);
      this.watchTimer = setTimeout(() => this.onDiskChange(), 80);
    });
  }

  private onDiskChange(): void {
    let next: BridgeFile;
    try {
      next = readBridgeFile(this.file.path);
    } catch {
      return; // mid-save or deleted: the next event brings it back
    }
    if (next.content === this.file.content) return;
    this.file = next;
    if (next.content === this.lastWritten) return; // our own save; the page already ran it
    this.buffer = undefined;
    this.broadcast({ type: 'file', file: next });
    if (this.runMode !== 'onDemand') void this.run('disk');
  }

  /* ---------- pages ---------- */

  private onPage(ws: WebSocketConnection): void {
    this.pages.add(ws);
    ws.on('close', () => this.pages.delete(ws));
    ws.on('message', (text) => {
      let msg: PageToBridge;
      try {
        msg = JSON.parse(text) as PageToBridge;
      } catch {
        return;
      }
      void this.onPageMessage(ws, msg);
    });
    this.sendTo(ws, { type: 'hello', file: this.file, runtime: this.runtimeInfo, watch: this.opts.watch, canNarrate: this.views.canNarrate() });
    if (this.current) {
      this.sendTo(ws, { type: 'run.begin', ...this.current });
      for (const ev of this.events) this.sendTo(ws, { type: 'event', event: ev });
      for (const m of this.views.replay(this.current.runId)) this.sendTo(ws, m);
    }
    if (this.debugRun) {
      this.sendTo(ws, { type: 'debug.begin', runId: this.debugRun.runId, content: this.debugRun.content, recording: true });
      for (const ev of this.debugRun.events) this.sendTo(ws, { type: 'debug.event', event: ev });
    }
  }

  private async onPageMessage(ws: WebSocketConnection, msg: PageToBridge): Promise<void> {
    switch (msg.type) {
      case 'run':
        if (msg.watch !== undefined) this.watch = pickWatches(msg.watch);
        if (msg.traceContext !== undefined) this.traceContext = msg.traceContext && Number.isInteger(msg.traceContext.step) ? { step: msg.traceContext.step, prefetch: Math.max(0, Math.min(200, Number(msg.traceContext.prefetch) || 10)) } : undefined;
        await this.run('page', msg.content);
        return;
      case 'narrate':
        await this.views.narrate();
        return;
      case 'tour':
        if (msg.action === 'narrate') await this.views.narrateTour();
        else await this.views.computeTour();
        return;
      case 'debug.start':
        await this.startDebug(Array.isArray(msg.breakpoints) ? msg.breakpoints : [], msg.exceptions === 'off' || msg.exceptions === 'raised' ? msg.exceptions : 'uncaught', typeof msg.content === 'string' ? msg.content : undefined, msg.stopOnEntry !== false);
        return;
      case 'debug.stop':
        await this.stopDebug();
        return;
      case 'debug.request': {
        const runner = this.debugRunner;
        try {
          if (!runner || !this.debugRun) throw new Error('no debug run');
          const reply = await runner.forward(msg.body);
          this.sendTo(ws, { type: 'reply', id: msg.id, reply });
        } catch (err) {
          this.sendTo(ws, { type: 'reply', id: msg.id, reply: { type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) } });
        }
        return;
      }
      case 'config':
        this.configPatch = { ...this.configPatch, ...pickConfig(msg.patch) };
        await this.run('settings');
        return;
      case 'stop':
        if (this.current) await this.runner.stop(this.current.runId);
        return;
      case 'request': {
        try {
          const requestRunner = 'runId' in msg.body && typeof msg.body.runId === 'string' && msg.body.runId.startsWith('d-') ? this.debugRunner : this.runner;
          if (!requestRunner) throw new Error('no runtime for this run');
          const reply = await requestRunner.forward(msg.body);
          this.sendTo(ws, { type: 'reply', id: msg.id, reply });
        } catch (err) {
          this.sendTo(ws, { type: 'reply', id: msg.id, reply: { type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) } });
        }
        return;
      }
      case 'save':
        this.lastWritten = msg.content;
        fs.writeFileSync(this.file.path, msg.content);
        this.file = { ...this.file, content: msg.content };
        this.buffer = undefined;
        this.sendTo(ws, { type: 'saved', path: this.file.path });
        return;
      case 'profile':
        await this.profile(typeof msg.content === 'string' ? msg.content : undefined);
        return;
      case 'runMode':
        if (msg.mode === 'auto' || msg.mode === 'onSave' || msg.mode === 'onDemand') this.runMode = msg.mode;
        return;
      case 'recent':
        this.sendTo(ws, { type: 'recent', files: this.recentFiles() });
        return;
      case 'open': {
        const why = typeof msg.path === 'string' ? await this.open(msg.path) : 'no path';
        if (why) this.sendTo(ws, { type: 'runner.error', message: `cannot open: ${why}` });
        return;
      }
      case 'file.read': {
        if (msg.path === LOG_PATH) {
          this.sendTo(ws, { type: 'file', file: { path: LOG_PATH, displayName: 'Tracelight logs', language: 'log', content: LOG_LINES.join('\n') + '\n' } });
          return;
        }
        // only files a run instrumented, and the HTTP recording it wrote: the page cannot read arbitrary paths
        const known = [...this.events, ...(this.debugRun?.events ?? [])].some((e) => (e.type === 'file.instrumented' && e.path === msg.path) || (e.type === 'run.finished' && e.http?.file === msg.path));
        if (!known) return;
        try {
          this.sendTo(ws, { type: 'file', file: readBridgeFile(msg.path) });
        } catch {
          /* gone since the run */
        }
        return;
      }
      case 'state':
        this.lastState = msg.state;
        return;
      case 'agent.result': {
        const w = this.agentWaiters.get(msg.id);
        if (w) {
          this.agentWaiters.delete(msg.id);
          w({ result: msg.result, error: msg.error });
        }
        return;
      }
    }
  }

  private sendTo(ws: WebSocketConnection, msg: BridgeToPage): void {
    ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: BridgeToPage): void {
    const text = JSON.stringify(msg);
    for (const p of this.pages) p.send(text);
  }

  /** A command must have exactly one recipient; broadcasting a step executes it more than once. */
  agent(command: AgentCommand, timeoutMs = 10_000): Promise<{ result: unknown; error?: string }> {
    if (!this.pages.size) return Promise.resolve({ result: null, error: `no page is open: open ${this.url} first` });
    if (this.pages.size > 1) return Promise.resolve({ result: null, error: `${this.pages.size} pages are connected. Use tab-bound WebMCP or close duplicate pages before CLI/HTTP control; no command was sent.` });
    const id = this.nextAgentId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.agentWaiters.delete(id);
        resolve({ result: null, error: 'the page did not answer' });
      }, timeoutMs);
      this.agentWaiters.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.broadcast({ type: 'agent', id, command });
    });
  }

  /* ---------- http ---------- */

  private async onHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!sameOrigin(req.headers, this.opts.port)) return reply(res, 403, 'forbidden');
    const url = new URL(req.url ?? '/', this.url);
    if (url.pathname.startsWith('/api/scratchpad/') && req.method === 'POST') {
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return reply(res, 415, 'send application/json');
      try {
        const body = JSON.parse(await readBody(req));
        if (url.pathname === '/api/scratchpad/format') return json(res, 200, { code: formatScratchCode(body.code) });
        if (url.pathname === '/api/scratchpad/prepare') {
          return json(res, 200, scratchFunction(fs.readFileSync(String(body.file), 'utf8'), Number(body.line)));
        }
        if (url.pathname === '/api/scratchpad/run') return json(res, 200, await runScratch(body as ScratchRequest));
        return reply(res, 404, 'not found');
      } catch (e) { return json(res, 400, { error: e instanceof Error ? e.message : String(e) }); }
    }
    if (url.pathname === '/api/state' && req.method === 'GET') {
      const reply = this.pages.size ? await this.agent({ action: 'state' }) : { result: null, error: 'No connected page can confirm visible position' };
      return json(res, reply.error ? 409 : 200, { url: this.url, file: this.file.path, runtime: this.runtimeInfo, pages: this.pages.size, state: reply.result, ...(reply.error ? { error: reply.error } : {}) });
    }
    if (url.pathname === '/api/command' && req.method === 'POST') {
      // a JSON body forces a CORS preflight in any browser, which this server never approves
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return reply(res, 415, 'send application/json');
      let command: AgentCommand;
      try {
        command = JSON.parse(await readBody(req)) as AgentCommand;
      } catch {
        return reply(res, 400, 'bad JSON');
      }
      if (command.action === 'profile') {
        // the bridge runs it; the page shows the table when the answer arrives
        const p = await this.profile();
        return json(res, p.error ? 409 : 200, { result: p.summary ? { path: p.path, totalMs: p.summary.totalMs, rows: p.summary.rows.slice(0, 20) } : null, ...(p.error ? { error: p.error } : {}) });
      }
      const r = await this.agent(command);
      return json(res, r.error ? 409 : 200, r);
    }
    if (req.method !== 'GET') return reply(res, 405, 'method not allowed');
    if (url.pathname === '/api/profile') {
      // the last profile's .cpuprofile, for Chrome DevTools (Performance > Load profile) or VS Code
      if (!this.lastProfile || !fs.existsSync(this.lastProfile)) return reply(res, 404, 'no profile yet: run Profile first');
      res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${path.basename(this.lastProfile)}"` });
      fs.createReadStream(this.lastProfile).pipe(res);
      return;
    }
    return this.serveStatic(url.pathname, res);
  }

  private serveStatic(pathname: string, res: http.ServerResponse): void {
    const rel = pathname === '/' ? 'web/index.html' : decodeURIComponent(pathname.slice(1));
    const full = path.resolve(this.opts.distDir, rel);
    const allowed = [path.join(this.opts.distDir, 'web') + path.sep, path.join(this.opts.distDir, 'webview') + path.sep];
    if (!allowed.some((dir) => full.startsWith(dir)) || !fs.existsSync(full) || !fs.statSync(full).isFile()) return reply(res, 404, 'not found');
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(full).pipe(res);
  }
}

/** Watch requests from a page: an id and an expression each, at most 50. */
export function pickWatches(list: unknown): WatchRequest[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((w): w is WatchRequest => !!w && typeof w === 'object' && typeof (w as WatchRequest).id === 'string' && typeof (w as WatchRequest).exp === 'string')
    .slice(0, 50)
    .map((w) => ({ id: w.id, exp: w.exp }));
}

/** Only the keys a page may set, with the right types; anything else is dropped. */
export function pickConfig(patch: ConfigPatch): ConfigPatch {
  const out: ConfigPatch = {};
  if (Array.isArray(patch.only) && patch.only.every(p => typeof p === 'string')) out.only = patch.only;
  if (typeof patch.autoLog === 'boolean') out.autoLog = patch.autoLog;
  if (typeof patch.libraryCode === 'boolean') out.libraryCode = patch.libraryCode;
  if (typeof patch.recordLocals === 'boolean') out.recordLocals = patch.recordLocals;
  if (typeof patch.maskSecrets === 'boolean') out.maskSecrets = patch.maskSecrets;
  if (typeof patch.timeoutMs === 'number' && patch.timeoutMs >= 0) out.timeoutMs = patch.timeoutMs;
  if (patch.http === 'off' || patch.http === 'record' || patch.http === 'replay') out.http = patch.http;
  return out;
}

/**
 * The run config: the extension's defaults, with every changed local recorded (the browser's Time
 * Machine shows variables at any step, so it is on unless the page turned it off), then the page's patch.
 */
export function runConfig(patch: ConfigPatch): RunConfig {
  const { maskSecrets, ...rest } = patch;
  return {
    ...DEFAULT_RUN_CONFIG,
    recordLocals: true,
    ...rest,
    secrets: { ...DEFAULT_RUN_CONFIG.secrets, ...(maskSecrets === undefined ? {} : { mask: maskSecrets }) },
  };
}

function readBridgeFile(file: string): BridgeFile {
  const full = path.resolve(file);
  return { path: full, displayName: path.basename(full), language: languageFor(full), content: fs.readFileSync(full, 'utf8') };
}

function reply(res: http.ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) req.destroy(new Error('body too large'));
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

let verbose = false;
/** the bridge's recent log lines, for Show Logs (`--verbose` also prints them) */
const LOG_LINES: string[] = [];
function log(line: string): void {
  LOG_LINES.push(`${new Date().toISOString().slice(11, 23)} ${line}`);
  if (LOG_LINES.length > 2000) LOG_LINES.splice(0, LOG_LINES.length - 2000);
  if (verbose) process.stderr.write(`[tracelight web] ${line}\n`);
}

function loadRecent(file: string | undefined): RecentFile[] {
  if (!file) return [];
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return Array.isArray(list) ? list.filter((r): r is RecentFile => !!r && typeof r.path === 'string' && typeof r.displayName === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

/* ---------- command line ---------- */

const USAGE = `usage:
  tracelight-web FILE [--port N] [--runtime js|"CMD ARGS"] [--open] [--no-run] [--no-watch] [--verbose] [--only PATTERN]
  tracelight-web ctl [--port N] state | goto STEP | step into|over|out|back|backOver|backOut | line N
                 | position live|recorded|visible [--focus true|false]
                 | say TEXT [--line N] [--step N] [--file FILE] [--id ID] [--kind explanation|prediction]
                 | clear [--id ID] | values NAME... [--file FILE] [--line N] | values --all|--hide | peek NAME | peek --hide | inspect open|close NAME
                 | scratchpad experiment|open|close|state|update|run|restore [--line N] [--data FILE]
                 | start | stop | run | eval EXPR
                 | var NAME | why NAME [--step N] | watch EXPR [--remove]
                 | break LINE [on|off] [--file FILE] [--if COND] | debug start|restart|continue|step [into|over|out]|pause|stop|state
                 | story | profile
  Step and debug commands take --say TEXT to show a narration bubble at the new position.`;

/** Parse `ctl` arguments into a command. Exported for tests. */
export function parseCtl(args: string[]): AgentCommand {
  const flags = new Map<string, string>();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--remove' || a === '--all' || a === '--hide') flags.set(a.slice(2), '');
    else if (a.startsWith('--')) flags.set(a.slice(2), args[++i] ?? '');
    else rest.push(a);
  }
  const [action, ...words] = rest;
  const say = flags.get('say');
  const int = (v: string | undefined, what: string): number => {
    const n = Number(v);
    if (v === undefined || v === '' || !Number.isInteger(n)) throw new Error(`${what} must be a whole number`);
    return n;
  };
  switch (action) {
    case 'position': {
      const mode = words[0] ?? 'visible';
      if (!['live', 'recorded', 'visible'].includes(mode)) throw new Error('position needs live|recorded|visible');
      return { action, mode: mode as 'live' | 'recorded' | 'visible', ...(flags.has('focus') ? { focus: flags.get('focus') !== 'false' } : {}) };
    }
    case 'state':
    case 'start':
    case 'stop':
    case 'run':
    case 'story':
    case 'profile':
      return { action };
    case 'clear':
      return { action, ...(flags.has('id') ? { noteId: flags.get('id') } : {}) };
    case 'peek':
      if (!words.length && !flags.has('hide')) throw new Error('peek needs NAME or --hide');
      return { action, name: flags.has('hide') ? '' : words.join(' ') };
    case 'scratchpad':
      if (!['experiment', 'open', 'close', 'state', 'update', 'run', 'restore'].includes(words[0] ?? '')) throw new Error('scratchpad needs experiment|open|close|state|update|run|restore');
      return { ...(flags.has('data') ? JSON.parse(fs.readFileSync(flags.get('data')!, 'utf8')) : {}), action, op: words[0], ...(flags.has('line') ? { line: int(flags.get('line'), '--line') } : {}) };
    case 'inspect':
      if (!['open', 'close'].includes(words[0] ?? '') || !words[1]) throw new Error('inspect needs open|close NAME');
      return { action, name: words[1]!, ...(words.length > 2 ? { names: words.slice(1) } : {}), open: words[0] === 'open' };
    case 'values':
      if (flags.has('all') && flags.has('hide')) throw new Error('choose --all or --hide');
      return { action, mode: flags.has('all') ? 'all' : flags.has('hide') ? 'none' : 'selected', ...(words.length ? { names: words } : {}), ...(flags.has('file') ? { file: flags.get('file') } : {}), ...(flags.has('line') ? { line: int(flags.get('line'), '--line') } : {}) };
    case 'goto':
      return { action, step: int(words[0], 'STEP'), ...(say ? { say } : {}) };
    case 'step': {
      const kind = (words[0] ?? 'into') as Extract<AgentCommand, { action: 'step' }>['kind'];
      if (!['next', 'into', 'over', 'out', 'back', 'backOver', 'backOut'].includes(kind)) throw new Error(`unknown step kind ${kind}`);
      return { action, kind, ...(say ? { say } : {}) };
    }
    case 'line':
      return { action, line: int(words[0], 'LINE'), ...(say ? { say } : {}) };
    case 'say':
      return {
        action,
        text: words.join(' '),
        ...(flags.has('line') ? { line: int(flags.get('line'), '--line') } : {}),
        ...(flags.has('step') ? { step: int(flags.get('step'), '--step') } : {}),
        ...(flags.has('file') ? { file: flags.get('file') } : {}),
        ...(flags.has('id') ? { noteId: flags.get('id') } : {}),
        ...(flags.has('kind') ? { kind: flags.get('kind') as 'explanation' | 'prediction' } : {}),
      };
    case 'eval':
      return { action, expression: words.join(' ') };
    case 'var':
      return { action, name: words.join(' ') };
    case 'why':
      return { action, name: words.join(' '), ...(flags.has('step') ? { step: int(flags.get('step'), '--step') } : {}) };
    case 'watch':
      return { action, exp: words.join(' '), ...(flags.has('remove') ? { remove: true } : {}) };
    case 'break':
    case 'breakpoint':
      return { action: 'breakpoint', line: int(words[0], 'LINE'), ...(flags.has('file') ? { file: flags.get('file') } : {}), ...(words[1] === 'on' ? { on: true } : words[1] === 'off' ? { on: false } : {}), ...(flags.has('if') ? { condition: flags.get('if') } : {}) };
    case 'debug': {
      const op = (words[0] ?? 'state') as Extract<AgentCommand, { action: 'debug' }>['op'];
      if (!['start', 'restart', 'continue', 'step', 'pause', 'stop', 'state'].includes(op)) throw new Error(`unknown debug op ${op}`);
      const kind = words[1] as 'into' | 'over' | 'out' | undefined;
      if (op === 'step' && kind && !['into', 'over', 'out'].includes(kind)) throw new Error(`unknown step kind ${kind}`);
      return { action, op, ...(op === 'step' ? { kind: kind ?? 'over' } : {}), ...(say ? { say } : {}) };
    }
    default:
      throw new Error(`unknown command ${action ?? '(none)'}`);
  }
}

async function ctl(args: string[]): Promise<number> {
  let port = Number(process.env['TRACELIGHT_PORT'] ?? DEFAULT_PORT);
  const i = args.indexOf('--port');
  if (i >= 0) {
    port = Number(args[i + 1]);
    args = [...args.slice(0, i), ...args.slice(i + 2)];
  }
  const command = parseCtl(args);
  const base = `http://127.0.0.1:${port}`;
  const res = command.action === 'state'
    ? await fetch(`${base}/api/state`)
    : await fetch(`${base}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) });
  const body = await res.text();
  // Structured values can exceed the stdout buffer. Finish writing before the
  // command entry point exits, including when stdout is piped to an agent.
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(formatJson(body) + '\n', (error) => error ? reject(error) : resolve());
  });
  return res.ok ? 0 : 1;
}

function formatJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
}

export async function main(argv: string[]): Promise<number> {
  if (argv[0] === 'ctl') {
    try {
      return await ctl(argv.slice(1));
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n${USAGE}\n`);
      return 2;
    }
  }
  const opts: ServerOptions = {
    file: '',
    port: Number(process.env['TRACELIGHT_PORT'] ?? DEFAULT_PORT),
    host: '127.0.0.1',
    runtime: process.env['TRACELIGHT_RUNTIME'] ?? '',
    explainCommand: process.env['TRACELIGHT_EXPLAIN_COMMAND'],
    watch: true,
    open: false,
    distDir: path.resolve(__dirname, '..'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--runtime') opts.runtime = argv[++i] ?? '';
    else if (a === '--only') (opts.only ??= []).push(argv[++i] ?? '');
    else if (a === '--open') opts.open = true;
    else if (a === '--no-run') opts.initialRun = false;
    else if (a === '--no-watch') opts.watch = false;
    else if (a === '--verbose') verbose = true;
    else if (a === '-h' || a === '--help') {
      process.stdout.write(USAGE + '\n');
      return 0;
    } else if (!opts.file) opts.file = a;
    else {
      process.stderr.write(`unexpected argument ${a}\n${USAGE}\n`);
      return 2;
    }
  }
  if (!opts.file || !fs.existsSync(opts.file)) {
    process.stderr.write(`${opts.file ? `no such file: ${opts.file}` : 'name a file to run'}\n${USAGE}\n`);
    return 2;
  }
  if (!opts.runtime) {
    const lang = languageFor(opts.file);
    if (lang === 'javascript' || lang === 'typescript') opts.runtime = 'js';
    else {
      process.stderr.write(`Tracelight runs JavaScript and TypeScript; for ${path.basename(opts.file)} pass --runtime "CMD ARGS" (or set TRACELIGHT_RUNTIME) with a command that speaks docs/PROTOCOL.md on stdio\n`);
      return 2;
    }
  }
  const server = new BridgeServer(opts);
  await server.start();
  process.stdout.write(`Tracelight: ${server.url}  (${path.basename(opts.file)}, ${opts.watch ? 're-runs on save' : 'no file watch'}; Ctrl+C stops)\n`);
  if (opts.open) openBrowser(server.url);
  const stop = () => void server.close().finally(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return -1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code >= 0) process.exit(code);
    },
    (err) => {
      process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exit(1);
    },
  );
}
