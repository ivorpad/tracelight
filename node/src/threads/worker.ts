/**
 * The preload of a recorded worker thread (`--import`, threads/hub.ts). It restores the program's
 * `workerData`, installs `__tk` with the worker's own Tracer and the same load hook as the main
 * thread (file ids and rids from the run's shared counters), and records the worker's statements
 * in its own trace, cut into segments at synchronisation points.
 *
 * Nothing is sent per statement. The recording goes to the main thread's hub at exit, or when
 * the hub asks (a flag it sets, checked every 1024 statements, and a message for an idle
 * worker): the trace, scopes, locals, coverage hits, timings and caught errors so far, and the
 * events that carry a step (logs, output, errors) since the last time. At exit it also keeps a
 * bounded snapshot of the values it logged, so they stay expandable once the isolate is gone.
 * A worker started without the hub's setup (a nested worker) runs as is.
 */
import wt from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';
import { RunChild } from '../child.ts';
import { runConfig } from '../protocol.ts';
import { secrets } from '../secrets.ts';
import { getters } from '../serialize.ts';
import { Tracer } from '../tracer.ts';
import type { InstrumentedFile } from '../instrument.ts';
import { clockView, fingerprint, origPost, prefixValues, SETUP_KEY, ThreadHub } from './hub.ts';
import { debugFile } from '../debug/host.ts';
import { resolveBreakpoint } from '../debug/breakpoints.ts';

type Msg = Record<string, any>;

/** bounds of the exit snapshot of logged values */
const SNAPSHOT_ROOTS = 2000;
const SNAPSHOT_NODES = 50_000;
/** events held for the merge: they carry a step of this worker's trace */
const HELD = new Set(['log', 'output', 'error', 'watch']);
/** what the main thread computes from the merged recording instead */
const DROPPED = new Set(['trace', 'locals', 'coverage', 'time']);

const wd = wt.workerData as Msg | null;
const setup = wd && typeof wd === 'object' ? (wd[SETUP_KEY] as Msg | undefined) : undefined;
if (setup) {
  (wt as any).workerData = wd!.data;
  syncBuiltinESMExports();
  start(setup);
}

function start(setup: Msg): void {
  const port = setup.port as wt.MessagePort;
  const flag = new Int32Array(setup.flag as SharedArrayBuffer);
  const thread = wt.threadId;
  const prefix = `w${thread}|`;
  const post = (m: Msg) => origPost.call(port, m);
  const held: Msg[] = [];
  let uncaught: string | null = null;

  const child = new RunChild();
  child.ids = new Int32Array(setup.ids as SharedArrayBuffer);
  child.aliases = new Map(setup.aliases);
  child.entry = setup.entry;
  child.mainPath = setup.mainPath;
  child.root = setup.root;
  child.mode = setup.mode === 'snaps' ? 'snaps' : 'normal';
  child.rawConfig = setup.config ?? {};
  child.markers = setup.markers ?? [];
  child.expressionsToEvaluate = setup.expressionsToEvaluate;
  for (const [p, text] of setup.overrides ?? []) child.overrides.set(p, text);
  child.emit = (event: Msg) => {
    if (child.done && event.type !== 'runner.error') return;
    if (DROPPED.has(event.type) || event.type === 'file.instrumented') return;
    if (HELD.has(event.type)) {
      if (event.valueBag) prefixValues(event.valueBag.data, prefix);
      if (typeof event.logId === 'string') event.logId = `${event.logId}@${thread}`;
      held.push(event);
      return;
    }
    post({ t: 'event', event });
  };
  child.onFile = (info: InstrumentedFile, aliased: boolean) => {
    if (aliased) return;
    const shown = info.code?.replace(/\n\/\/# sourceMappingURL=data:[^\n]*$/, '');
    const library = child.kindOf(info.filename) === 'library';
    const event = { type: 'file.instrumented', fileId: info.fileId, path: info.filename, rangeBase: info.rangeBase, ranges: info.ranges, statements: info.statements, functions: info.functions, magic: info.magic, ...(info.walk ? { walk: info.walk } : {}), instrumentedSource: library ? undefined : shown };
    post({ t: 'file', info: { ...info, code: null }, alias: { fileId: info.fileId, rangeBase: info.rangeBase, fp: fingerprint(info) }, event });
  };

  child.config = runConfig(child.rawConfig);
  secrets.configure(child.config.secrets.mask, child.config.secrets.names);
  const tracer = new Tracer(child.config, child.emit, { registry: child.registry, expressionsToEvaluate: child.expressionsToEvaluate as Record<string, any> });
  child.tracer = tracer;
  // `eval: true` code: the main thread instrumented it as this worker's entry
  if (setup.evalFile) tracer.addFile(setup.evalFile as InstrumentedFile);
  (globalThis as any).__tk = tracer.hooks;
  getters.resolve = child.config.resolveGetters;
  getters.invoke = (fn) => {
    tracer.quiet++;
    try {
      return fn();
    } finally {
      tracer.quiet--;
    }
  };
  const rec = tracer.rec;
  rec.clock = clockView(child.ids);
  rec.tick(true); // after the statement that created this worker
  const signal = new Int32Array(setup.signal as SharedArrayBuffer);
  // its own workers (nested) report to the main thread's hub; this one patches the synchronisation points too
  new ThreadHub(child, (m, transfer) => origPost.call(port, m, transfer), signal).install();

  // what went to the hub so far: each send carries what was recorded since
  let stepsSent = 0;
  let segsSent = 0;
  let scopesSent = 0;
  let localsSent = 0;
  /** `light`: the steps, scopes, locals and events since the last send; `full`: coverage, timings and every scope too */
  const send = (kind: 'light' | 'full' | 'final', pause?: number) => {
    const final = kind === 'final';
    const full = kind !== 'light';
    const entry = tracer.byPath.get(child.entry);
    const recorded = rec.recorded;
    const msg: Msg = {
      t: 'data',
      final,
      full,
      thread,
      entryRid: entry ? entry.rangeBase + entry.moduleRid : 0,
      from: stepsSent,
      steps: rec.steps().slice(stepsSent << 2),
      n: rec.n,
      // the last segment start again: a tick at the same step replaces its ticket
      segs: Int32Array.from(rec.segs.slice(Math.max(0, segsSent - 2))),
      scopes: rec.scopeTable(full ? 0 : scopesSent),
      locals: rec.localsEntries.slice(localsSent),
      caught: final ? tracer.caughtEvents() : [],
      uncaught,
      events: held.splice(0),
      values: final ? snapshot(child, prefix) : undefined,
    };
    if (full) {
      const hits: number[] = [];
      const h = rec.hits;
      for (let i = 0; i < h.length; i++) if (h[i]) hits.push(i, h[i]!);
      Object.assign(msg, { hits: Int32Array.from(hits), times: [...tracer.times], errorStates: [...tracer.errorStates] });
    }
    if (pause !== undefined) Object.assign(msg, { pause, step: recorded - 1 });
    stepsSent = recorded;
    segsSent = rec.segs.length;
    scopesSent = rec.scopes.length;
    localsSent = rec.localsEntries.length;
    post(msg);
  };
  // about once a second while it runs: the main thread merges and sends it as it goes
  rec.partialHook = () => send('light');
  let sent = false;
  const answerFlag = () => {
    if (Atomics.load(flag, 0) !== 1 || Atomics.load(flag, 1) !== 0) return;
    rec.tick(true); // what it runs from here on comes after what the asker has merged
    send('full');
    Atomics.store(flag, 1, 1);
    Atomics.notify(flag, 1);
  };
  if (setup.debug) {
    // the debugger stopped this thread (agent.ts): what it ran goes to the hub, merged up to here
    (globalThis as any).__tracelight_pause__ = (seq: number) => {
      rec.sweepHold = true; // the debugger's evaluations from here on run microtasks while frames are live
      rec.tick(true);
      send('light', seq);
      Atomics.add(signal, 0, 1);
      return rec.recorded - 1;
    };
    // before it blocks: a hub that asks meanwhile goes on without it, and loses nothing
    const wait = Atomics.wait;
    (Atomics as any).wait = function (...args: Parameters<typeof Atomics.wait>) {
      send('light');
      return (wait as (...a: unknown[]) => string).apply(Atomics, args);
    };
    debugTraps(child, setup.fnBreakpoints ?? []);
  }
  const periodic = rec.onPeriodic;
  rec.onPeriodic = () => {
    periodic?.();
    answerFlag();
  };
  port.on('message', (m: Msg) => {
    if (m?.t === 'flush') answerFlag();
    else if (m?.t === 'expand') {
      let msg: Msg;
      try {
        msg = child.expand(m.msg);
        prefixValues(msg.node, prefix);
      } catch (e) {
        msg = { type: 'error', message: (e as Error).message };
      }
      post({ t: 'reply', id: m.id, msg });
    }
  });
  port.unref();
  // a nested worker: its parent asks for the recording on terminate through this port
  const ctl = setup.ctl as wt.MessagePort | null;
  if (ctl) {
    ctl.on('message', (m: Msg) => {
      if (m?.t === 'flush') answerFlag();
    });
    ctl.unref();
  }
  process.on('uncaughtExceptionMonitor', (err) => {
    try {
      uncaught = typeof (err as Error)?.stack === 'string' ? (err as Error).stack! : null;
      tracer.reportUncaught(err);
    } catch {
      /* the worker ends anyway */
    }
  });
  process.on('exit', () => {
    if (sent) return;
    sent = true;
    child.done = true;
    send('final');
  });
  child.patchStreams();
  child.installLoader({ markers: child.markers });
}

interface FunctionBreakpoint {
  function: string;
  path: string;
  echo: Record<string, unknown>;
}

/**
 * The debugger's stops in a recorded worker, made by the worker's own hooks, as the main
 * thread's are (debug/debugger.ts): a function breakpoint's entry hook, and the next step a step
 * the debugger asked for lands on (`into`: any; `over`: in the stop's scope or one it was called
 * from; `out`: in one it was called from).
 * The hook calls a `debugger` statement, which the debugger sees as this thread's pause and steps
 * out of (agent.ts), so the thread stops right after the hook, with the statement's step recorded.
 * V8's own stepping cannot do this: it does not stop in the caller of a frame that returns
 * through a `finally`, and every instrumented function does. Function breakpoint names are
 * resolved here, against this thread's files as each is instrumented, so the first call stops.
 * The hooks are wrapped only while there is something to stop at.
 */
function debugTraps(child: RunChild, initial: FunctionBreakpoint[]): void {
  const hooks = child.tracer.hooks;
  const rec = child.tracer.rec;
  const plainS = hooks.s as (...args: unknown[]) => unknown;
  const plainF = hooks.f as (...args: unknown[]) => unknown;
  // its own script, without a URL, so the debugger's blackboxing of the runtime does not skip it
  const trap = new Function('return function __tracelight_trap__() { debugger; }')() as () => void;
  let specs = initial;
  let byRid = new Map<number, Record<string, unknown>>();
  /** a step the debugger asked for: the scopes its next stop may be in (null: any) */
  let step: { kind: string; scopes: Set<number> | null } | null = null;
  let seen = 0;
  const hit = (why: Record<string, unknown>) => {
    rec.sweepHold = true;
    step = null;
    install();
    (globalThis as any).__tracelight_hit__ = why;
    trap();
  };
  /** a new step recorded in a scope the step asked for stops */
  const stepsHere = (): boolean => {
    const n = rec.recorded;
    if (step === null || n === seen) return false;
    seen = n;
    return step.scopes === null || step.scopes.has(rec.steps()[((n - 1) << 2) + 1]!);
  };
  const s = function (this: unknown, ...args: unknown[]) {
    const r = plainS.apply(this, args);
    if (step !== null && stepsHere()) hit({ step: step!.kind });
    return r;
  };
  const f = function (this: unknown, ...args: unknown[]) {
    const scope = plainF.apply(this, args);
    const echo = byRid.get(args[0] as number);
    if (echo !== undefined) hit({ breakpoint: echo });
    else if (step !== null && stepsHere()) hit({ step: step!.kind });
    return scope;
  };
  const install = () => {
    hooks.s = step !== null ? s : plainS;
    hooks.f = step !== null || byRid.size ? f : plainF;
  };
  const resolve = () => {
    byRid = new Map();
    if (specs.length) {
      const files = child.tracer.files.map(debugFile);
      for (const sp of specs) {
        const bp = { path: sp.path ?? '', line: 0, function: sp.function, error: null, rid: null as number | null, fileId: null, resolvedLine: null };
        if (resolveBreakpoint(files, bp) && bp.rid !== null) byRid.set(bp.rid, sp.echo);
      }
    }
    install();
  };
  (globalThis as any).__tracelight_bp__ = (list: FunctionBreakpoint[]) => {
    specs = Array.isArray(list) ? list : [];
    resolve();
  };
  // the debugger, at a stop: the shadow stack stays as it is (the debugger's evaluations run
  // microtasks, the recorder's sweep among them, while this thread's frames are live)
  (globalThis as any).__tracelight_hold__ = () => {
    rec.sweepHold = true;
  };
  // the debugger, at a stop: where the next stop is (null: none, the thread continues)
  (globalThis as any).__tracelight_step__ = (kind: string | null) => {
    setImmediate(() => {
      rec.sweepHold = false;
    });
    const n = rec.recorded;
    seen = n;
    if (!kind || n === 0) step = kind ? { kind, scopes: null } : null;
    else {
      let scope = rec.steps()[((n - 1) << 2) + 1]!;
      if (kind === 'out') scope = rec.scopes[scope]?.parent ?? -1;
      const scopes = new Set<number>();
      for (; scope >= 0 && scopes.size < 10_000; scope = rec.scopes[scope]?.parent ?? -1) scopes.add(scope);
      step = { kind, scopes: kind === 'into' ? null : scopes };
    }
    install();
    return true;
  };
  const onFile = child.onFile;
  child.onFile = (info, aliased) => {
    onFile?.(info, aliased);
    if (specs.length) resolve();
  };
  resolve();
}

/**
 * The values this worker logged, serialised one level deeper than the logs did, newest first and
 * bounded: `expand` answers from it once the worker is gone. Keys and ids carry the prefix.
 */
function snapshot(child: RunChild, prefix: string): [string, unknown][] {
  const out: [string, unknown][] = [];
  const ids = [...child.registry.objects.keys()].reverse().slice(0, SNAPSHOT_ROOTS);
  let nodes = 0;
  const index = (n: any) => {
    if (!n || typeof n !== 'object' || nodes >= SNAPSHOT_NODES) return;
    nodes++;
    if (typeof n.id === 'string' && Array.isArray(n.props) && n.props.length) out.push([n.id, n]);
    for (const k of ['props', 'children', 'items', 'entries']) if (Array.isArray(n[k])) for (const c of n[k]) index(c);
  };
  child.tracer.quiet++;
  try {
    for (const id of ids) {
      if (nodes >= SNAPSHOT_NODES) break;
      try {
        const r = child.expand({ valueId: id, queryPath: [] });
        prefixValues(r.node, prefix);
        index(r.node);
      } catch {
        /* a value that cannot be read again */
      }
    }
  } finally {
    child.tracer.quiet--;
  }
  return out;
}
