/**
 * The keeper, as Pyokka's `agent/keep.py` and on the same wire: it keeps a `serve` runner alive
 * after `tracelight run --save --keep` so `expand`, `source` (and `evaluate` once the debugger lands)
 * can reach the finished run.
 *
 * `run --keep` starts `tracelight _keep --socket PATH` detached; the keeper spawns the runner, listens
 * on a Unix socket and multiplexes short-lived clients onto it: a client sends the runner's own
 * request lines, the keeper rewrites `id` to `"c<conn>:<id>"` and restores it on the reply, run
 * events go to the connection that sent that `run`, and `shutdown` (or the runner exiting, or
 * `--idle` seconds without a connection) ends it. `meta.keep = {pid, socket}` in the saved run;
 * `tracelight release run.json` (or `pyokka release`) sends `shutdown`. Pyokka's CLI speaks to it as
 * it does to its own keeper.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { childArgs } from './runner.ts';
import { ENV, NAME } from './protocol.ts';

type Msg = Record<string, any>;

export const DEFAULT_IDLE_S = 4 * 3600;
const BIN = fileURLToPath(new URL(`../bin/${NAME}.mjs`, import.meta.url));

/** a fresh, short socket path (macOS caps AF_UNIX paths at 104 bytes) */
export function socketPath(): string {
  const base = process.env[`${ENV}KEEP_DIR`] || tmpdir();
  mkdirSync(base, { recursive: true });
  return join(base, `${NAME}-keep-${process.pid}-${randomBytes(3).toString('hex')}.sock`);
}

function probe(path: string): Promise<boolean> {
  return new Promise((res) => {
    const s = connect(path);
    s.once('connect', () => {
      s.destroy();
      res(true);
    });
    s.once('error', () => res(false));
  });
}

/** start a keeper for `path` detached; resolves with its pid once the socket accepts */
export async function spawnKeeper(path: string, idleS = DEFAULT_IDLE_S): Promise<number> {
  const proc = spawn(process.execPath, childArgs(BIN).concat(['_keep', '--socket', path, '--idle', String(idleS)]), { detached: true, stdio: 'ignore', env: { ...process.env, NODE_OPTIONS: '' } });
  proc.unref();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`keeper exited with ${proc.exitCode} before listening on ${path}`);
    if (existsSync(path) && (await probe(path))) return proc.pid!;
    await new Promise((r) => setTimeout(r, 20));
  }
  proc.kill();
  throw new Error(`keeper did not start listening on ${path}`);
}

export class Keeper {
  readonly path: string;
  readonly idleS: number;
  readonly runner: ChildProcess;
  readonly pending = new Map<string, [Socket, unknown]>();
  readonly runOwner = new Map<string, Socket>();
  serial = 0;
  connections = 0;
  lastActivity = Date.now();
  stopping = false;
  server = createServer((c) => this.client(c));

  constructor(path: string, idleS: number) {
    this.path = path;
    this.idleS = idleS;
    this.runner = spawn(process.execPath, childArgs(BIN).concat(['serve']), { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, NODE_OPTIONS: '' } });
    createInterface({ input: this.runner.stdout! }).on('line', (line) => this.fromRunner(line));
    this.runner.on('exit', () => this.stop());
  }

  toRunner(msg: Msg): void {
    try {
      this.runner.stdin!.write(JSON.stringify(msg) + '\n');
    } catch {
      this.stop();
    }
  }

  fromRunner(line: string): void {
    let msg: Msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    let target: Socket | undefined;
    const key = msg.id;
    if (typeof key === 'string' && this.pending.has(key)) {
      const [conn, orig] = this.pending.get(key)!;
      this.pending.delete(key);
      msg.id = orig;
      target = conn;
    } else if ('runId' in msg) target = this.runOwner.get(String(msg.runId));
    if (target && !target.destroyed) target.write(JSON.stringify(msg) + '\n');
  }

  client(conn: Socket): void {
    const serial = ++this.serial;
    this.connections++;
    createInterface({ input: conn }).on('line', (line) => {
      if (!line.trim()) return;
      let req: Msg;
      try {
        req = JSON.parse(line);
      } catch {
        conn.write(JSON.stringify({ type: 'runner.error', message: 'invalid JSON request' }) + '\n');
        return;
      }
      this.lastActivity = Date.now();
      const key = `c${serial}:${req.id}`;
      this.pending.set(key, [conn, req.id]);
      req.id = key;
      if (req.type === 'run') this.runOwner.set(String(req.runId), conn);
      this.toRunner(req);
      if (req.type === 'shutdown') setTimeout(() => this.stop(), 200);
    });
    const gone = () => {
      this.connections--;
      this.lastActivity = Date.now();
    };
    conn.once('close', gone);
    conn.on('error', () => {});
  }

  start(): void {
    try {
      unlinkSync(this.path);
    } catch {
      /* no stale socket */
    }
    this.server.listen(this.path, () => {
      try {
        chmodSync(this.path, 0o600);
      } catch {
        /* best effort */
      }
    });
    const tick = setInterval(() => {
      if (this.connections === 0 && Date.now() - this.lastActivity > this.idleS * 1000) this.stop();
    }, 500);
    tick.unref();
  }

  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.server.close();
    try {
      unlinkSync(this.path);
    } catch {
      /* gone already */
    }
    if (this.runner.exitCode === null) {
      this.toRunner({ type: 'shutdown', id: 'keeper-shutdown' });
      setTimeout(() => this.runner.kill('SIGKILL'), 5000).unref();
    }
    this.runner.once('exit', () => process.exit(0));
    if (this.runner.exitCode !== null) process.exit(0);
  }
}

/** a connection to a keeper: request/reply by id, run events to a listener */
export class KeepLink {
  readonly sock: Socket;
  nextId = 1;
  readonly waiting = new Map<unknown, (m: Msg) => void>();
  onEvent: ((m: Msg) => void) | null = null;

  constructor(sock: Socket) {
    this.sock = sock;
    createInterface({ input: sock }).on('line', (line) => {
      let m: Msg;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.id !== undefined && this.waiting.has(m.id)) {
        const cb = this.waiting.get(m.id)!;
        this.waiting.delete(m.id);
        cb(m);
      } else this.onEvent?.(m);
    });
  }

  static open(path: string): Promise<KeepLink> {
    return new Promise((res, rej) => {
      const s = connect(path);
      s.once('connect', () => res(new KeepLink(s)));
      s.once('error', (e) => rej(new Error(`cannot reach the kept run at ${path}: ${e.message}; run again with --keep`)));
    });
  }

  request(msg: Msg): Promise<Msg> {
    const id = this.nextId++;
    return new Promise((res) => {
      this.waiting.set(id, res);
      this.sock.write(JSON.stringify({ ...msg, id }) + '\n');
    });
  }

  /** run `request` on the kept runner; resolves with its events once `run.finished` arrives */
  run(request: Msg): Promise<{ ready: Msg; events: Msg[]; finished: Msg }> {
    return new Promise((res) => {
      const events: Msg[] = [];
      let ready: Msg = {};
      this.onEvent = (m) => {
        if (m.runId !== request.runId) return;
        events.push(m);
        if (m.type === 'run.finished') res({ ready, events, finished: m });
      };
      void this.request({ type: 'hello' }).then((r) => {
        ready = r;
        void this.request(request);
      });
    });
  }

  close(): void {
    this.sock.end();
  }
}

export function keepMain(args: string[]): number {
  const at = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const path = at('--socket');
  if (!path) {
    process.stderr.write(`usage: ${NAME} _keep --socket PATH [--idle SECONDS]\n`);
    return 2;
  }
  new Keeper(path, Number(at('--idle') ?? DEFAULT_IDLE_S)).start();
  return -1; // stays running
}
