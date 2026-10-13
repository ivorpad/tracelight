/**
 * Recording `worker_threads` (docs/PROTOCOL.md "Worker threads"). The main thread's side.
 *
 * `worker_threads.Worker` is replaced (before the program loads) by a subclass that preloads
 * threads/worker.ts in the new isolate (`--import`) and hands it, inside `workerData` (restored
 * before the program reads it), a MessagePort back to this hub and the run's shared counters. The
 * worker instruments its files through the same load hook, with file ids and rids taken from the
 * shared counters, so a rid means the same statement in every thread, and a file both threads load
 * is instrumented once under one id (an alias, checked by a fingerprint of its ranges).
 *
 * Each thread records its own trace, cut into segments at synchronisation points (Recorder.tick);
 * the worker sends its recording here when it exits, or when asked (a `terminate()`, the end of
 * the run). The traces are merged in ticket order (merge.ts): one trace, worker scopes under a
 * scope per worker (parent: the module, depth 1, `thread` set). While a worker runs, the events
 * that carry a step (logs, output, errors, locals) are held, because the steps before them are
 * not numbered yet; they go out when the last worker exits (the run then goes on live with an
 * offset) or when the run ends.
 *
 * A value a worker logged is expanded by that worker while it lives; after it exits, from a
 * snapshot it took on the way out (bounded). Its ids carry the prefix `w<threadId>|`.
 */
import wt, { MessageChannel, type MessagePort } from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';
import * as nodeModule from 'node:module';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COV_ERROR_SOURCE, encodeSteps, NAME } from '../protocol.ts';
import type { Recorder, LocalsEntry, Scope } from '../recorder/recorder.ts';
import type { InstrumentedFile } from '../instrument.ts';
import type { Tracer } from '../tracer.ts';
import { Lane, Merger, remapScope } from './merge.ts';
import { cacheDir } from '../cache.ts';

type Msg = Record<string, any>;

export const SETUP_KEY = '__tracelight_thread__';
/** the shared counters: next file id, next rid, the segment ticket clock */
export const ID_FILE = 0;
export const ID_RANGE = 1;
export const ID_CLOCK = 2;
const PRELOAD = new URL('./boot.mjs', import.meta.url).href;
const WORKER = new URL('./worker.ts', import.meta.url);
const FLUSH_WAIT_MS = 250;
/** events that carry a step of the trace */
const STEP_EVENTS = new Set(['log', 'output', 'error', 'locals', 'trace', 'watch']);

// the originals, for the runtime's own messages (which are not synchronisation points of the program)
export const origPost = wt.MessagePort.prototype.postMessage;
export const origReceive = wt.receiveMessageOnPort;
export const origWait = Atomics.wait as (typed: Int32Array, index: number, value: number, timeout?: number) => string;

export function newIds(): Int32Array {
  return new Int32Array(new SharedArrayBuffer(16));
}

export function clockView(ids: Int32Array): Int32Array {
  return new Int32Array(ids.buffer, ID_CLOCK * 4, 1);
}

let runtime: [string, string][] | null = null;

/**
 * The runtime's modules a worker loads (threads/worker.ts and what it imports), types stripped
 * once here: a worker's preload serves them, which halves its start (no type stripper to load).
 */
function runtimeSources(): [string, string][] {
  if (runtime) return runtime;
  // on disk too, keyed by the runtime's files (the first worker of a run would strip them all, ~80 ms)
  const dir = cacheDir();
  let key = '';
  try {
    const src = fileURLToPath(new URL('../', import.meta.url));
    let h = 0x811c9dc5;
    for (const f of readdirSync(src, { recursive: true }) as string[]) {
      if (!f.endsWith('.ts')) continue;
      const st = statSync(join(src, f));
      for (const c of `${f}:${st.size}:${st.mtimeMs};`) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193);
    }
    key = (h >>> 0).toString(36);
    if (dir) {
      const hit = JSON.parse(readFileSync(join(dir, `worker-runtime-${key}.json`), 'utf8'));
      if (Array.isArray(hit)) return (runtime = hit);
    }
  } catch {
    /* no cache yet */
  }
  const out = new Map<string, string>();
  const todo = [WORKER];
  while (todo.length) {
    const url = todo.pop()!;
    if (out.has(url.href)) continue;
    let text: string;
    try {
      text = readFileSync(url, 'utf8');
      out.set(url.href, nodeModule.stripTypeScriptTypes(text));
    } catch {
      continue; // the worker's own loader takes it
    }
    for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\s(?!type\s)[^;]*?from\s+'(\.{1,2}\/[^']+\.ts)'/g)) todo.push(new URL(m[1]!, url));
  }
  runtime = [...out];
  if (dir && key) {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `worker-runtime-${key}.json`), JSON.stringify(runtime));
    } catch {
      /* read-only cache: strip again next run */
    }
  }
  return runtime;
}

/** a file both threads may load: the same id and rids when its instrumentation matches */
export interface Alias {
  fileId: number;
  rangeBase: number;
  fp: string;
}

export function fingerprint(info: InstrumentedFile): string {
  const text = JSON.stringify(info.ranges);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return `${info.rangeCount}:${info.statements.length}:${info.functions.length}:${(h >>> 0).toString(36)}`;
}

/**
 * The program's synchronisation points start a new segment: a `postMessage` (any port, a worker,
 * a BroadcastChannel), a synchronous `receiveMessageOnPort`, `Atomics.wait` and `Atomics.notify`.
 * A callback the event loop runs (a message arriving) is one too, in the recorder itself.
 */
export function patchSync(rec: Recorder): void {
  const tick = () => rec.tick(true);
  const wrapPost = (proto: any) => {
    const orig = proto.postMessage;
    if (typeof orig !== 'function' || orig.__tracelight) return;
    const post = function (this: unknown, ...args: unknown[]) {
      tick();
      return orig.apply(this, args);
    };
    (post as any).__tracelight = true;
    Object.defineProperty(proto, 'postMessage', { value: post, writable: true, configurable: true });
  };
  wrapPost(wt.MessagePort.prototype);
  wrapPost(wt.Worker.prototype);
  if (wt.BroadcastChannel) wrapPost(wt.BroadcastChannel.prototype);
  const receive = function (port: any) {
    const r = origReceive(port);
    if (r !== undefined) tick();
    return r;
  };
  (wt as any).receiveMessageOnPort = receive;
  const wait = Atomics.wait;
  (Atomics as any).wait = function (...args: Parameters<typeof Atomics.wait>) {
    const r = (wait as (...a: unknown[]) => string).apply(Atomics, args);
    tick();
    return r;
  };
  const notify = Atomics.notify;
  (Atomics as any).notify = function (...args: Parameters<typeof Atomics.notify>) {
    tick();
    return notify.apply(Atomics, args);
  };
  syncBuiltinESMExports();
}

/** `w<thread>|` on every id and root key of a value tree a worker sends */
export function prefixValues(node: any, prefix: string): void {
  if (!node || typeof node !== 'object') return;
  if (typeof node.id === 'string' && !node.id.startsWith(prefix)) node.id = prefix + node.id;
  if (Array.isArray(node.queryPath) && typeof node.queryPath[0] === 'string' && !node.queryPath[0].startsWith(prefix)) node.queryPath = [prefix + node.queryPath[0], ...node.queryPath.slice(1)];
  for (const k of ['props', 'children', 'items', 'entries']) if (Array.isArray(node[k])) for (const c of node[k]) prefixValues(c, prefix);
  if (node.value && typeof node.value === 'object') prefixValues(node.value, prefix);
}

const PREFIX_RE = /^w(\d+)\|/;

/** what the hub needs of the run child (child.ts RunChild) */
export interface HubHost {
  tracer: Tracer;
  ids: Int32Array;
  mainPath: string;
  root: string;
  mode: string;
  rawConfig: Msg;
  overrides: Map<string, string>;
  markers: unknown[];
  expressionsToEvaluate: Record<string, unknown> | undefined;
  /** an event straight to the runner, past the hub */
  out(event: Msg): void;
  /** `module` or `commonjs` for a source without a file */
  formatOf(source: string): 'module' | 'commonjs';
  /** a live debug run: workers stop for the debugger (agent.ts) */
  readonly debugRun?: boolean;
  /** the function breakpoints a new worker traps on itself */
  functionBreakpoints?(): { function: string; path: string; echo: Record<string, unknown> }[];
  /** a file a worker instrumented, for the debugger (a debug run) */
  fileAdded?(info: InstrumentedFile): void;
  /** instrument `source` as a worker's entry file (its body is the worker's scope) */
  instrumentEntry(path: string, source: string): InstrumentedFile;
}

/** what a worker sends (threads/worker.ts `send`): what it recorded since it last sent */
interface Payload {
  final: boolean;
  /** coverage, timings and error states too (asked for by `flush`, and at exit) */
  full: boolean;
  thread: number;
  entryRid: number;
  /** steps `from..` (under the cap) */
  from: number;
  steps: Int32Array;
  /** statements run */
  n: number;
  /** segment starts since the last send, the last one sent before first again */
  segs: Int32Array;
  /** the scopes created since the last send (all of them when `full`), local ids */
  scopes: Scope[];
  locals: LocalsEntry[];
  hits?: Int32Array;
  times?: [number, { n: number; total: number; min: number; max: number }][];
  errorStates?: [number, number][];
  caught: Msg[];
  uncaught: string | null;
  /** a debugger pause in the worker (agent.ts): its sequence number, and the paused step */
  pause?: number;
  step?: number;
}

interface WorkerRec {
  thread: number;
  name: string;
  entry: string;
  port: MessagePort;
  flag: Int32Array;
  exited: boolean;
  /** its steps in the merge (null: a nested worker's record in its parent, which only flushes it) */
  lane: Lane | null;
  entryRid: number;
  /** statements it ran */
  n: number;
  /** its scopes, local id -> the latest it sent */
  scopes: Scope[];
  /** local scope ids before this one went out in a delta (or are waiting on their first step) */
  scopesSent: number;
  full: Payload | null;
  caught: Msg[];
  uncaught: string | null;
  /** step-bearing events, in the worker's own numbering (its locals too) */
  events: Msg[];
  emitted: number;
  /** value snapshot taken at exit: id -> node (ids prefixed) */
  values: Map<string, any> | null;
  pending: Map<number, (m: Msg) => void>;
}

export class ThreadHub {
  readonly host: HubHost;
  readonly rec: Recorder;
  readonly workers: WorkerRec[] = [];
  /** paths workers instrumented -> their alias */
  readonly workerFiles = new Map<string, Alias>();
  used = false;
  live = 0;
  /** the merged trace (from the first worker on) */
  merger: Merger | null = null;
  private main: Lane | null = null;
  /** the main thread's step-bearing events not merged yet */
  private queue: Msg[] = [];
  /** merged steps and main-thread scope ids sent in deltas */
  private traceSent = 0;
  private mainScopesSent = 0;
  /** the run ended: every thread's steps merge */
  private ending = false;
  private serial = 0;
  /** a debug run: [pause sequence, merged step, answered sequence, merged steps so far] (agent.ts) */
  pauseCell: Int32Array | null = null;
  /** set by a worker that paused, so a busy main thread looks at its port (`poll`) */
  private readonly signal: Int32Array;

  /**
   * In a worker (a nested worker's parent): the main thread's hub, reached through the worker's
   * own port. A nested worker reports to the main thread directly; its parent keeps a control port
   * to ask it for its recording on `terminate()`.
   */
  readonly toMain: ((m: Msg, transfer: any[]) => void) | null;

  constructor(host: HubHost, toMain: ((m: Msg, transfer: any[]) => void) | null = null, signal: Int32Array | null = null) {
    this.host = host;
    this.rec = host.tracer.rec;
    this.toMain = toMain;
    this.signal = signal ?? new Int32Array(new SharedArrayBuffer(4));
  }

  /** before the program loads: `Worker` records, the synchronisation points tick */
  install(): void {
    patchSync(this.rec);
    const Base = wt.Worker;
    const hub = this;
    class Worker extends Base {
      constructor(filename: string | URL, options?: wt.WorkerOptions) {
        const plan = hub.prepare(filename, options);
        super(plan ? plan.filename : filename, plan ? plan.options : options);
        if (plan) hub.attach(this, plan);
      }
      override terminate(): Promise<number> {
        const r = hub.workers.find((w) => w.thread === this.threadId);
        if (r) hub.flush(r);
        return super.terminate();
      }
    }
    Object.defineProperty(Worker, 'name', { value: 'Worker' });
    (wt as any).Worker = Worker;
    syncBuiltinESMExports();
  }

  private prepare(filename: string | URL, options: wt.WorkerOptions | undefined): { filename: string | URL; options: wt.WorkerOptions; port: MessagePort; ctl: MessagePort | null; flag: Int32Array; entry: string; name: string; floor: number } | null {
    let entry: string | null = null;
    let evalFile: InstrumentedFile | null = null;
    if (options?.eval) {
      // code, not a file: instrumented here as a file of its own (written out, so the editor can show it)
      if (typeof filename !== 'string') return null;
      const made = this.instrumentEval(filename);
      if (!made) return null;
      evalFile = made;
      entry = made.filename;
    } else try {
      if (filename instanceof URL) entry = filename.protocol === 'file:' ? fileURLToPath(filename) : null;
      else if (typeof filename === 'string') entry = filename.startsWith('file:') ? fileURLToPath(filename) : /^[a-z][a-z0-9+.-]*:/i.test(filename) && !isAbsolute(filename) ? null : resolve(filename);
    } catch {
      entry = null;
    }
    if (!entry) return null;
    if (!evalFile) this.enable();
    this.rec.tick(true); // the worker's first steps come after the statement that created it
    const floor = Atomics.load(clockView(this.host.ids), 0);
    const { port1, port2 } = new MessageChannel();
    const flag = new Int32Array(new SharedArrayBuffer(8));
    // a nested worker: its data port goes to the main thread, this thread keeps a control port
    const ctl = this.toMain ? new MessageChannel() : null;
    const h = this.host;
    this.drainAll();
    const aliases: [string, Alias][] = [];
    for (const f of h.tracer.files) if (f.code !== null || f.ranges.length) aliases.push([f.filename, { fileId: f.fileId, rangeBase: f.rangeBase, fp: fingerprint(f) }]);
    for (const [p, a] of this.workerFiles) if (!aliases.some(([q]) => q === p)) aliases.push([p, a]);
    const setup = {
      port: port2,
      ids: h.ids.buffer,
      flag: flag.buffer,
      entry,
      mainPath: h.mainPath,
      root: h.root,
      mode: h.mode,
      config: h.rawConfig,
      markers: h.markers,
      overrides: [...h.overrides],
      expressionsToEvaluate: h.expressionsToEvaluate ?? {},
      aliases,
      evalFile: evalFile ? { ...evalFile, code: null } : null,
      ctl: ctl?.port2 ?? null,
      signal: this.signal.buffer,
      debug: !!this.host.debugRun,
      fnBreakpoints: this.host.debugRun ? (this.host.functionBreakpoints?.() ?? []) : [],
      runtime: runtimeSources(),
    };
    // the runtime's own flags (type stripping on older Nodes), then the program's, then the preload
    const own = process.execArgv.filter((a) => a === '--experimental-strip-types' || a.startsWith('--disable-warning'));
    const execArgv = [...own, ...(options?.execArgv ?? []), '--import', PRELOAD];
    return {
      // an eval worker skips `--import`: its code loads the preload itself (require of an ES module, on one line)
      filename: evalFile ? `require(${JSON.stringify(fileURLToPath(PRELOAD))});${evalFile.code!}` : filename,
      options: { ...(options ?? {}), execArgv, workerData: { [SETUP_KEY]: setup, data: options?.workerData }, transferList: [...((options?.transferList as any[]) ?? []), port2, ...(ctl ? [ctl.port2] : [])] },
      port: port1,
      ctl: ctl?.port1 ?? null,
      flag,
      entry,
      name: String(options?.name ?? ''),
      floor,
    };
  }

  private evalSerial = 0;

  /** `eval: true` code as a file of the run: written to a temporary path, instrumented as a worker's entry */
  private instrumentEval(code: string): InstrumentedFile | null {
    const h = this.host;
    if (h.formatOf(code) !== 'commonjs') return null; // Node runs eval code as a script
    this.enable();
    let path: string;
    try {
      path = join(mkdtempSync(join(tmpdir(), `${NAME}-eval-`)), `worker-eval-${++this.evalSerial}.js`);
      writeFileSync(path, code);
    } catch {
      return null;
    }
    const info = h.instrumentEntry(path, code);
    return info.code === null ? null : info;
  }

  private enable(): void {
    if (this.used) return;
    this.used = true;
    const rec = this.rec;
    rec.clock = clockView(this.host.ids);
    if (this.toMain) return; // a worker's recording goes to the main thread's hub
    const m = new Merger(rec.cap);
    const main = m.lane(0);
    main.floor = -0.5;
    main.segs = rec.segs;
    // the main thread ran alone so far: its deltas stay valid, the merged ones go on from them
    this.traceSent = rec.flushedSteps;
    this.mainScopesSent = rec.flushedScopes;
    this.merger = m;
    this.main = main;
    rec.partialHook = () => this.partial();
    const periodic = rec.onPeriodic;
    rec.onPeriodic = () => {
      periodic?.();
      this.poll();
    };
  }

  private attach(worker: InstanceType<typeof wt.Worker>, plan: { port: MessagePort; ctl: MessagePort | null; flag: Int32Array; entry: string; name: string; floor: number }): void {
    if (this.toMain && plan.ctl) {
      // nested: the main thread's hub records it; this thread only asks it for its recording on terminate
      const thread = worker.threadId;
      this.toMain({ t: 'nested', thread, entry: plan.entry, name: plan.name, floor: plan.floor, port: plan.port, flag: plan.flag.buffer }, [plan.port]);
      const r = this.newRec(thread, plan.entry, plan.ctl, plan.flag, plan.name, null);
      plan.ctl.unref();
      this.workers.push(r);
      worker.once('exit', () => {
        r.exited = true;
        this.toMain!({ t: 'nestedExit', thread }, []);
      });
      return;
    }
    const r = this.adopt(worker.threadId, plan.entry, plan.port, plan.flag, plan.name, plan.floor);
    // before the program's own exit listeners: its recording is in by then
    worker.once('exit', () => this.onExit(r));
  }

  private newRec(thread: number, entry: string, port: MessagePort, flag: Int32Array, name: string, lane: Lane | null): WorkerRec {
    // as a debugger pause names it: the worker's `name` option, else `Worker N`
    return { thread, name: name || `Worker ${thread}`, entry, port, flag, exited: false, lane, entryRid: 0, n: 0, scopes: [], scopesSent: 0, full: null, caught: [], uncaught: null, events: [], emitted: 0, values: null, pending: new Map() };
  }

  /** a worker this hub records: its port's messages, counted live until it exits */
  private adopt(thread: number, entry: string, port: MessagePort, flag: Int32Array, name: string, floor: number): WorkerRec {
    this.enable();
    const lane = this.merger!.lane(1);
    lane.floor = floor;
    const r = this.newRec(thread, entry, port, flag, name, lane);
    this.workers.push(r);
    this.live++;
    port.on('message', (m: Msg) => this.onMessage(r, m));
    port.unref();
    return r;
  }

  private onMessage(r: WorkerRec, m: Msg): void {
    switch (m?.t) {
      case 'file': {
        const info = m.info as InstrumentedFile;
        if (!this.host.tracer.files.some((f) => f.fileId === info.fileId)) {
          this.host.tracer.addFile(info);
          this.host.fileAdded?.(info);
        }
        this.workerFiles.set(info.filename, m.alias);
        if (m.event) this.host.out(m.event);
        break;
      }
      case 'event':
        this.host.out(m.event);
        break;
      case 'data':
        this.onData(r, m as unknown as Payload & { events?: Msg[]; values?: [string, any][] });
        break;
      case 'nested':
        if (!this.workers.some((w) => w.thread === m.thread)) this.adopt(m.thread, m.entry, m.port, new Int32Array(m.flag), String(m.name ?? ''), Number(m.floor) || 0);
        break;
      case 'nestedExit': {
        const w = this.workers.find((x) => x.thread === m.thread);
        if (w) this.onExit(w);
        break;
      }
      case 'reply': {
        const cb = r.pending.get(m.id);
        r.pending.delete(m.id);
        cb?.(m.msg);
        break;
      }
    }
  }

  private onData(r: WorkerRec, p: Payload & { events?: Msg[]; values?: [string, any][] }): void {
    r.entryRid = p.entryRid;
    r.n = p.n;
    const lane = r.lane;
    if (lane) {
      lane.addSteps(p.from, p.steps, p.from + (p.steps.length >> 2));
      // a scope id in the merged trace for every scope it sent, before a step of it is placed
      for (const sc of p.scopes) {
        if (lane.scopeMap[sc.scopeId] === undefined) lane.scopeMap[sc.scopeId] = this.rec.reserveScope(sc.depth + lane.depthShift);
        r.scopes[sc.scopeId] = sc;
      }
      lane.addSegs(p.segs);
    }
    if (p.locals.length) r.events.push({ type: 'locals', entries: p.locals });
    if (Array.isArray(p.events)) r.events.push(...p.events);
    if (p.full) r.full = p;
    if (p.caught.length) r.caught = p.caught;
    if (p.uncaught) r.uncaught = p.uncaught;
    if (p.values) r.values = new Map(p.values);
    if (p.final) this.onExit(r, false); // a nested worker's exit: its parent may be gone
    else if (p.pause !== undefined) this.workerPaused(r, p.pause, p.step ?? -1);
    else this.publish();
  }

  private drain(r: WorkerRec): void {
    for (;;) {
      const got = origReceive(r.port);
      if (got === undefined) break;
      this.onMessage(r, got.message as Msg);
    }
  }

  drainAll(): void {
    for (const r of this.workers) this.drain(r);
  }

  /** a worker that still runs sends its recording so far (it checks every 1024 statements, or takes the message when idle) */
  flush(r: WorkerRec): boolean {
    return this.flushAll([r]);
  }

  /**
   * Ask the live workers for their recording and wait for them together (250 ms at most). One that
   * does not answer (blocked, or held by the debugger) gets its later steps after a fresh ticket:
   * true when every one answered.
   */
  private flushAll(rs: WorkerRec[]): boolean {
    const asked = rs.filter((r) => !r.exited);
    for (const r of asked) {
      Atomics.store(r.flag, 1, 0);
      Atomics.store(r.flag, 0, 1);
      origPost.call(r.port, { t: 'flush' });
    }
    const until = performance.now() + FLUSH_WAIT_MS;
    let all = true;
    for (const r of asked) {
      const left = Math.max(0, until - performance.now());
      if (Atomics.load(r.flag, 1) === 0) origWait.call(Atomics, r.flag, 1, 0, left);
      Atomics.store(r.flag, 0, 0);
      this.drain(r);
      if (Atomics.load(r.flag, 1) === 0 && !r.exited) {
        all = false;
        r.lane?.restamp(Atomics.add(clockView(this.host.ids), 0, 1) + 1);
      }
    }
    return all;
  }

  private onExit(r: WorkerRec, drain = true): void {
    if (r.exited) return;
    if (drain) this.drain(r);
    if (r.exited) return; // its last message was its exit
    r.exited = true;
    if (r.lane) r.lane.exited = true;
    this.live--;
    for (const cb of r.pending.values()) cb({ type: 'error', message: 'the worker exited' });
    r.pending.clear();
    this.publish();
  }

  /** the worker for a file a worker instrumented first (main thread's load hook) */
  aliasFor(path: string): Alias | undefined {
    if (!this.used) return undefined;
    this.drainAll();
    return this.workerFiles.get(path);
  }

  // -- the merge --------------------------------------------------------------------------------

  /** Merge what can no longer move, then send it: a trace delta and the events whose steps it holds. */
  private publish(): void {
    const m = this.merger;
    if (!m) return;
    const main = this.main!;
    const rec = this.rec;
    main.steps = rec.steps();
    main.n = rec.recorded;
    m.advance(this.ending);
    if (this.pauseCell) Atomics.store(this.pauseCell, 3, m.len);
    if (!this.ending) this.sendDelta(); // at the end the final trace follows instead
    this.sendEvents();
  }

  /** called where the main thread's recorder would send its own delta (about once a second, and before a pause) */
  partial(): void {
    if (this.toMain) return;
    this.drainAll();
    this.publish();
  }

  /**
   * The main thread stops at a debugger pause: the live workers send what they ran, so the steps
   * up to the pause are merged (and sent) before `debug.paused`.
   */
  pause(): void {
    if (!this.merger || this.toMain) return;
    this.flushAll(this.workers.filter((w) => w.lane && !w.exited));
    this.publish();
  }

  /**
   * A worker the debugger stopped (agent.ts) sent what it ran: merged up to its paused step, which
   * goes back to the debugger through `pauseCell`. The main thread's open segment is closed first
   * and the other workers are asked for theirs, so nothing can come before that step any more.
   */
  private workerPaused(r: WorkerRec, seq: number, step: number): void {
    this.rec.tick(true);
    this.flushAll(this.workers.filter((w) => w !== r && w.lane && !w.exited));
    this.publish();
    const cell = this.pauseCell;
    if (!cell || !this.merger || !r.lane) return;
    const g = r.lane.map(step, this.merger.last);
    Atomics.store(cell, 1, g < 0 ? Math.max(0, this.merger.last) : g);
    Atomics.store(cell, 2, seq);
    Atomics.notify(cell, 2);
  }

  /** a worker stopped by the debugger while this thread is busy: looked at every 1024 statements */
  poll(): void {
    if (Atomics.load(this.signal, 0) === 0) return;
    Atomics.store(this.signal, 0, 0);
    this.drainAll();
  }

  private sendDelta(): void {
    const m = this.merger!;
    const scopes = this.readyScopes();
    const from = this.traceSent;
    if (m.len <= from && !scopes.length) return;
    const event: Msg = { type: 'trace', partial: true, offset: from, steps: encodeSteps(m.out.subarray(from << 2, m.len << 2)), scopes, truncated: m.truncated };
    if (this.rec.midRun) event.midRun = true;
    this.traceSent = m.len;
    this.host.out(event);
  }

  /** the scopes not sent yet whose first step is merged: the main thread's in order, then each worker's */
  private readyScopes(): Scope[] {
    const m = this.merger!;
    const main = this.main!;
    const rec = this.rec;
    const out: Scope[] = [];
    const last = m.last;
    for (; this.mainScopesSent < rec.scopes.length; this.mainScopesSent++) {
      const sc = rec.scopes[this.mainScopesSent]!;
      if (sc.foreign) continue;
      const first = main.map(sc.first, last);
      if (first < 0) break;
      const end = main.map(rec.lastOf[sc.scopeId]!, last);
      out.push({ ...sc, first, last: end < first ? first : end });
    }
    for (const w of this.workers) {
      if (!w.lane) continue;
      for (; w.scopesSent < w.scopes.length; w.scopesSent++) {
        const sc = w.scopes[w.scopesSent];
        if (!sc) break;
        const g = this.foreignScope(w, sc);
        if (g.first < 0) break;
        out.push(g);
      }
    }
    return out;
  }

  private foreignScope(w: WorkerRec, sc: Scope): Scope {
    return remapScope(sc, w.lane!, this.merger!.last, { thread: { name: w.name, ident: w.thread }, rid: w.entryRid, name: `<worker ${w.thread}>` });
  }

  /** the held events whose steps are merged, in step order (a stable sort: one statement's output stays in order) */
  private sendEvents(): void {
    const batch: Msg[] = [];
    const take = (queue: Msg[], at: number, lane: Lane): number => {
      for (; at < queue.length; at++) {
        const e = queue[at]!;
        const t = this.ready(e, lane);
        if (t === null) break;
        batch.push(t);
        if (e.type === 'locals' && (e.entries as LocalsEntry[]).length) break; // the rest waits
      }
      return at;
    };
    const k = take(this.queue, 0, this.main!);
    this.queue.splice(0, k);
    for (const w of this.workers) if (w.lane) w.emitted = take(w.events, w.emitted, w.lane);
    if (!batch.length) return;
    const at = (e: Msg) => (typeof e.step === 'number' ? e.step : e.type === 'locals' ? (e.entries[0]?.step ?? Infinity) : Infinity);
    if (batch.length > 1) batch.sort((a, b) => at(a) - at(b));
    for (const e of batch) this.host.out(e);
  }

  /**
   * An event in the merged numbering, or null while its step is not merged. A `locals` event goes
   * out as far as its entries are merged; the rest stays in it.
   */
  private ready(e: Msg, lane: Lane): Msg | null {
    const m = this.merger!;
    const last = m.last;
    if (e.type === 'locals') {
      const entries = e.entries as LocalsEntry[];
      let k = 0;
      while (k < entries.length && lane.map(entries[k]!.step, last) >= 0) k++;
      if (k === 0) return null;
      const out = entries.slice(0, k).map((x) => ({ ...x, step: lane.map(x.step, last), scopeId: lane.scope(x.scopeId) }));
      e.entries = entries.slice(k);
      return { ...e, entries: out };
    }
    if (typeof e.step === 'number' && e.step >= 0) {
      if (lane.map(e.step, last) < 0) return null;
    }
    const g = (s: unknown) => {
      if (typeof s !== 'number' || s < 0) return s;
      const v = lane.map(s, last);
      return v < 0 ? Math.max(0, last) : v;
    };
    const out: Msg = { ...e };
    if ('step' in e) out.step = g(e.step);
    if ('lastStep' in e) out.lastStep = g(e.lastStep);
    if (typeof e.scopeId === 'number' && lane !== this.main) out.scopeId = lane.scope(e.scopeId);
    return out;
  }

  /**
   * The child's emit goes through here: true when the hub took the event (held, or sent in the
   * merged numbering).
   */
  route(event: Msg): boolean {
    if (!this.used || this.toMain) return false;
    const type = String(event.type);
    if (type === 'trace') {
      // the recorder's own deltas never go out (the merged ones replace them); its final trace is merged
      if (!event.partial) this.host.out(this.finalTrace(event));
      return true;
    }
    if (!STEP_EVENTS.has(type) && !type.startsWith('debug.')) return false;
    if (event.type === 'locals' && !(event.entries as LocalsEntry[]).length) return true;
    this.queue.push(event);
    if (this.ending || this.live === 0) this.publish();
    else this.sendEvents();
    return true;
  }

  private finalTrace(mainEvent: Msg): Msg {
    const m = this.merger!;
    const main = this.main!;
    const rec = this.rec;
    m.advance(true);
    const last = m.last;
    const foreign = new Map<number, Scope>();
    const threads: Msg[] = [];
    for (const w of this.workers) {
      if (!w.lane) continue;
      for (const sc of w.scopes) if (sc) foreign.set(w.lane.scope(sc.scopeId), this.foreignScope(w, sc));
      threads.push({ thread: w.thread, name: w.name, path: w.entry, scopeId: w.lane.scope(0), stepsRun: w.n });
    }
    const scopes: Scope[] = [];
    for (const sc of mainEvent.scopes as Scope[]) {
      if (sc.foreign) {
        const f = foreign.get(sc.scopeId);
        if (f) scopes.push(f.first < 0 ? { ...f, first: Math.max(0, last), last: Math.max(0, last) } : f);
        continue;
      }
      const first = main.map(sc.first, last);
      const end = main.map(sc.last, last);
      scopes.push({ ...sc, first: first < 0 ? Math.max(0, last) : first, last: end < 0 ? Math.max(0, last) : end });
    }
    const out: Msg = { type: 'trace', steps: encodeSteps(m.steps()), scopes, truncated: m.truncated || !!mainEvent.truncated, threads };
    if (mainEvent.midRun) out.midRun = true;
    if (out.truncated) Object.assign(out, rec.capReport(), { stepsRun: this.stepsRun() });
    return out;
  }

  /** statements every thread ran */
  stepsRun(): number {
    let n = this.rec.n;
    for (const w of this.workers) if (w.lane) n += w.n;
    return n;
  }

  /**
   * The run ends: the live workers send their recording, the workers' coverage, timings and error
   * states join the main thread's, and the trace is merged. True when `err` (the main thread's
   * uncaught) is a worker's uncaught error the worker already reported.
   */
  beforeFinish(err: unknown): boolean {
    if (!this.used || this.toMain) return false;
    this.flushAll(this.workers.filter((w) => w.lane && !w.exited));
    this.drainAll();
    const t = this.host.tracer;
    for (const w of this.workers) {
      const p = w.full;
      if (!w.lane || !p) continue;
      const hits = t.rec.hits;
      const h = p.hits ?? [];
      for (let i = 0; i + 1 < h.length; i += 2) if (h[i]! < hits.length) hits[h[i]!]! += h[i + 1]!;
      for (const [rid, a] of p.times ?? []) {
        const m = t.times.get(rid);
        if (!m) t.times.set(rid, { ...a });
        else Object.assign(m, { n: m.n + a.n, total: m.total + a.total, min: Math.min(m.min, a.min), max: Math.max(m.max, a.max) });
        t.timesDirty = true;
      }
      for (const [rid, st] of p.errorStates ?? []) if (t.errorStates.get(rid) === undefined || st === COV_ERROR_SOURCE) t.errorStates.set(rid, st);
      // caught exceptions: the worker's groups, in the merged numbering
      w.events.push(...w.caught);
    }
    this.ending = true;
    this.publish();
    const stack = (err as Error | undefined)?.stack;
    return typeof stack === 'string' && this.workers.some((w) => w.uncaught && w.uncaught === stack);
  }

  // -- values ----------------------------------------------------------------------------------

  owns(msg: Msg): boolean {
    return PREFIX_RE.test(String(msg.valueId ?? '')) || PREFIX_RE.test(String(msg.queryPath?.[0] ?? ''));
  }

  /** `expand` of a value a worker logged: the worker while it lives, else its exit snapshot */
  expand(msg: Msg, reply: (m: Msg) => void): void {
    const m = PREFIX_RE.exec(String(msg.valueId ?? '')) ?? PREFIX_RE.exec(String(msg.queryPath?.[0] ?? ''));
    const thread = Number(m![1]);
    const prefix = `w${thread}|`;
    const r = this.workers.find((w) => w.thread === thread);
    if (!r) return reply({ type: 'error', message: `no worker ${thread} in this run` });
    const strip = (s: unknown) => (typeof s === 'string' && s.startsWith(prefix) ? s.slice(prefix.length) : s);
    const inner = { ...msg, valueId: strip(msg.valueId), queryPath: Array.isArray(msg.queryPath) ? msg.queryPath.map(strip) : msg.queryPath };
    if (!r.exited) {
      const id = ++this.serial;
      r.pending.set(id, reply);
      origPost.call(r.port, { t: 'expand', id, msg: inner });
      return;
    }
    const node = r.values?.get(String(msg.valueId ?? '').replace(/ \+$/, ''));
    if (!node) return reply({ type: 'error', message: `worker ${thread} has exited; this value was not kept` });
    reply({ type: 'value', node: rebase(node, Array.isArray(msg.queryPath) ? msg.queryPath : null) });
  }
}

/** a snapshot node, its query paths moved under the path the host asked with */
function rebase(node: any, path: string[] | null): any {
  const from: string[] = Array.isArray(node.queryPath) ? node.queryPath : [];
  if (!path || !path.length) return node;
  const walk = (n: any): any => {
    if (!n || typeof n !== 'object') return n;
    const out: any = Array.isArray(n) ? n.map(walk) : { ...n };
    if (!Array.isArray(n)) {
      for (const k of Object.keys(out)) if (k !== 'queryPath' && out[k] && typeof out[k] === 'object') out[k] = walk(out[k]);
      if (Array.isArray(n.queryPath) && from.every((s, i) => n.queryPath[i] === s)) out.queryPath = [...path, ...n.queryPath.slice(from.length)];
    }
    return out;
  };
  return walk(node);
}
