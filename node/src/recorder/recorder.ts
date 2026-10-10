/**
 * The Time Machine's recorder: the trace side of the `__tk` hooks (docs/PROTOCOL.md `trace`).
 *
 * Every statement step is a quad [rid, scopeId, depth, flags] in one growable Int32Array, and
 * every function call a scope {scopeId, rid, name, parent, depth, first, last, returned?, raised?}.
 * The host navigates by index arithmetic over these (src/timeMachine/traceModel.ts), so stepping
 * back, forward, over and out never re-runs anything: recording is the only cost, and it is kept
 * to a few array writes per statement.
 *
 * Which scope a statement belongs to is exact by construction: the instrumenter passes the
 * frame's own `_tk_scope_` to `s`, so steps of async functions that interleave across awaits are
 * attributed to the right call whatever ran in between. What needs tracking is who is *calling*:
 *
 * - `stack` is the synchronous chain of instrumented frames now on the JS stack. `f` pushes, `x`
 *   pops, an `await`/`yield` pops while the frame is suspended (`ap`) and pushes it again on resume
 *   (`aw`). A scope's parent is the top of this stack when it is entered, the
 *   caller frame: a call, the first `next()` of a generator, or a sync caller of an async
 *   function. A callback the event loop runs (a timer, a promise reaction, an emitter fired from
 *   I/O) finds the stack empty and gets the module as parent, so tasks sit side by side
 *   and step over / out follow the right chain.
 * - Resumes that skip `aw` (an awaited promise that rejects, `for await`, a generator resumed with
 *   `throw`) are repaired at the frame's next statement, whose scope argument says who runs. A
 *   microtask queued whenever the stack becomes non-empty clears it: microtasks run only once the
 *   JS stack has unwound, so nothing left on it then is live.
 * - An AsyncLocalStorage store follows the same frames into async continuations. Code that runs
 *   without a hook of its own (a library callback that logs, an HTTP response, a console write
 *   from a timer) is attributed through it to the scope that scheduled it (`attribution()`), and
 *   a scope the event loop entered records that scope as `asyncParent` (a JS addition the host
 *   may ignore; its `parent` stays the module).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { encodeSteps, FLAG_ERROR, FLAG_SCOPE_ENTRY, FLAG_UNWINDING } from '../protocol.ts';
import { cutText, displayText, valueChars, valueText, type ValueText } from './valueText.ts';
import { bareName } from './localsPlan.ts';

/** `f`'s answer when no scope was recorded (past the cap, or quiet): its steps are counted, not kept. */
export const NO_SCOPE = -1;
export const MAX_LOCALS_ENTRIES = 100_000;
/**
 * The first per-call id a `recordFrom` run's debug hooks hand out (recorder/debugHooks.ts): a
 * `_tk_scope_` at or above it belongs to a frame entered before the recording began, and is mapped
 * to a recorded scope (`foreign`) before the recorder uses it.
 */
export const FOREIGN = 1 << 30;
const TRACE_FLUSH_MS = 1000;
const INITIAL_STEPS = 1 << 14;

/** `_tk_rv_` while no return has stored a value: an exception is leaving the frame. */
export const UNSET: unique symbol = Symbol('tk.unset');
/** `_tk_rv_` when the body ran off its end: `returned: null`. */
export const END: unique symbol = Symbol('tk.end');

export interface Scope {
  scopeId: number;
  rid: number;
  name: string;
  parent: number;
  depth: number;
  first: number;
  last: number;
  returned?: string | null;
  returnedTruncated?: true;
  returnedLength?: number;
  raised?: string;
  /** JS: the scope whose code scheduled the callback that entered this one, when the event loop did */
  asyncParent?: number;
  /** a placeholder for another thread's scope (`reserveScope`); never sent */
  foreign?: boolean;
  /** a scope a worker thread ran (threads/merge.ts): the thread, as a debugger pause names it */
  thread?: { name: string; ident: number };
}

export interface LocalsChange {
  name: string;
  text: string;
  truncated?: true;
  length?: number;
}

export interface LocalsEntry {
  step: number;
  scopeId: number;
  changes: LocalsChange[];
}

export interface RecorderConfig {
  maxTraceSteps?: number;
  recordLocals?: boolean;
  maxValueChars?: number | null;
  /** follow frames into async continuations with AsyncLocalStorage (default true) */
  asyncContext?: boolean;
}

export interface FileInfo {
  filename: string;
  rangeBase: number;
  rangeCount: number;
  statements: number[];
  functionNames: Map<number, string>;
  /** recordLocals: global rid -> the names its `s` getter returns (InstrumentedFile.localNames) */
  localNames?: Map<number, string[]>;
}

export interface Attribution {
  step: number;
  scope: number;
}

type Emit = (event: Record<string, unknown>) => void;

/** Locals getter the instrumenter passes with `s` under recordLocals: the values of `names`, in order. */
export type LocalsGetter = () => unknown[];

export class Recorder {
  readonly cap: number;
  readonly recordLocals: boolean;
  readonly valueChars: number;
  /** statement hits by global rid (coverage reads them too) */
  hits = new Int32Array(1024);
  /** steps executed, recorded or not (`stepsRun`) */
  n = 0;
  /** the last recorded step */
  curStep = 0;
  /** the scope that ran the last statement */
  cur = 0;
  quiet = 0;
  midRun = false;
  /** called for every recorded step (the debugger's stop check) */
  onStep: ((step: number, rid: number, scope: number) => void) | null = null;
  /** an exception leaves frame `sid` (the run's error bookkeeping flags the steps); unset, the recorder flags them itself */
  onException: ((err: unknown, sid: number) => void) | null = null;
  /** about every 1024 steps, after the trace flush check (timings) */
  onPeriodic: (() => void) | null = null;
  /** a hook failed: the run reports it once, the program carries on */
  onError: (e: unknown, where: string) => void = () => {};
  /** recordFrom: the header rid of the function (or module body) a statement belongs to */
  defRidOf: (rid: number) => number = () => 0;
  /** recordFrom: debug-hook ids of frames entered before the recording began -> their recorded scope */
  readonly foreign = new Map<number, number>();
  /**
   * worker_threads (threads/hub.ts): the run's shared ticket counter, set once a second thread
   * records. The trace is cut into segments at the points where threads synchronise (a
   * `postMessage`, a callback the event loop runs after another thread moved, `Atomics.wait`), each
   * stamped with a fresh ticket, and the threads' traces are merged in ticket order. Null in a run
   * without workers: nothing per statement changes.
   */
  clock: Int32Array | null = null;
  /** segment starts, flat [step, ticket, ...]: steps from `step` on belong to `ticket` */
  readonly segs: number[] = [];
  private ticket = 0;
  /**
   * While threads record, the merged trace's deltas replace this recorder's own (threads/hub.ts):
   * called where a delta would go out, then the locals not sent yet follow.
   */
  partialHook: (() => void) | null = null;

  /** step quads, [rid, scopeId, depth, flags] per step; grows, so read it through `buffer` */
  private buf: Int32Array = new Int32Array(INITIAL_STEPS * 4);
  readonly scopes: Scope[] = [{ scopeId: 0, rid: 0, name: '<module>', parent: -1, depth: 0, first: 0, last: 0 }];
  private depthOf: number[] = [0];
  /** the last step of each scope */
  readonly lastOf: number[] = [0];
  private names = new Map<number, string>();
  private files: FileInfo[] = [];

  // the synchronous frame chain, and what the async store was when each frame went on it
  private stack: number[] = [];
  private prevStore: (number | undefined)[] = [];
  private sweepQueued = false;
  /** a debugger holds this thread (threads/worker.ts): its evaluations run microtasks while frames are live */
  sweepHold = false;
  private readonly sweep = (): void => {
    this.sweepQueued = false;
    if (this.sweepHold) return;
    if (this.stack.length) {
      this.stack.length = 0;
      this.prevStore.length = 0;
    }
    this.cur = 0;
  };
  private readonly als: AsyncLocalStorage<number> | null;

  // exceptions: the error object a frame saw last (ex is called in every frame it leaves)
  private lastRaised: unknown = UNSET;
  private lastRaisedSeen = new WeakSet<object>();

  // locals: per scope, the last value of each name and its length marker
  private localNames = new Map<number, readonly string[]>();
  /** recordLocals: rid -> which of its names are hoisted `var`s (localsPlan `HOISTED`), when any is */
  private localHoisted = new Map<number, readonly boolean[]>();
  private snaps = new Map<number, Map<string, [unknown, number]>>();
  readonly localsEntries: LocalsEntry[] = [];
  private localsFlushed = 0;

  /** what the partial deltas sent so far: steps, scopes */
  flushedSteps = 0;
  flushedScopes = 0;
  private started = performance.now();
  private lastFlush = this.started;
  finished = false;

  private readonly emit: Emit;

  constructor(emit: Emit, config: RecorderConfig = {}) {
    this.emit = emit;
    this.cap = Math.max(0, Math.trunc(config.maxTraceSteps ?? 999_999));
    this.recordLocals = !!config.recordLocals;
    this.valueChars = valueChars(config.maxValueChars);
    this.als = config.asyncContext === false ? null : new AsyncLocalStorage<number>();
    if (this.als) this.als.enterWith(0);
  }

  /** A file joins the run: its function names and its share of the hits table. */
  addFile(info: FileInfo): void {
    this.files.push(info);
    for (const [rid, name] of info.functionNames) this.names.set(rid, name);
    if (info.localNames) for (const [rid, names] of info.localNames) this.setLocalNames(rid, names);
    const need = info.rangeBase + info.rangeCount;
    if (need > this.hits.length) {
      let size = this.hits.length;
      while (size < need) size *= 2;
      const h = new Int32Array(size);
      h.set(this.hits);
      this.hits = h;
    }
  }

  /** Names the `s` locals getter of statement `rid` returns, in order (recordLocals). */
  setLocalNames(rid: number, names: readonly string[]): void {
    const hoisted = names.map((n) => n.charCodeAt(0) === 37);
    this.localNames.set(rid, hoisted.includes(true) ? names.map(bareName) : names);
    if (hoisted.includes(true)) this.localHoisted.set(rid, hoisted);
    else this.localHoisted.delete(rid);
  }

  // -- the hooks -----------------------------------------------------------------------------

  /** The `__tk` members this recorder implements, bound. */
  hooks(): Record<string, unknown> {
    return {
      s: this.s,
      c: this.c,
      f: this.f,
      x: this.x,
      ex: this.ex,
      ap: this.ap,
      aw: this.aw,
      u: UNSET,
      e: END,
    };
  }

  get buffer(): Int32Array {
    return this.buf;
  }

  /** coverage only */
  readonly c = (rid: number): void => {
    this.hits[rid]!++;
  };

  /** a statement of `scope` is about to run */
  readonly s = (rid: number, scope: number, locals?: LocalsGetter): void => {
    try {
      this.step(rid, scope, locals);
    } catch (e) {
      this.onError(e, 'step');
    }
  };

  private step(rid: number, scope: number, locals?: LocalsGetter): void {
    this.hits[rid]!++;
    if (scope < 0) return;
    // a statement of a recorded frame runs: whatever was quiet is over. An ESM library body that
    // throws never reaches its `qx` (top-level code cannot be wrapped in try/finally)
    if (this.quiet) this.quiet = 0;
    if (scope !== this.cur) this.resync(scope);
    const n = this.n;
    if (n < this.cap) {
      const p = n << 2;
      let buf = this.buf;
      if (p + 4 > buf.length) buf = this.grow();
      buf[p] = rid;
      buf[p + 1] = scope;
      buf[p + 2] = this.depthOf[scope]!;
      buf[p + 3] = 0;
      this.lastOf[scope] = n;
      this.curStep = n;
      this.n = n + 1;
      if (locals !== undefined && this.recordLocals) this.snapshot(n, rid, scope, locals);
      if (this.onStep !== null) this.onStep(n, rid, scope);
    } else this.n = n + 1;
    if ((n & 1023) === 0) this.periodic();
  }

  /** a function (or an imported module body) is entered: its scope, with a flag-4 step on the header */
  readonly f = (rid: number, locals?: LocalsGetter): number => {
    try {
      const sid = this.enter(rid);
      // an arrow with an expression body: its parameters, read at the entry step
      if (locals !== undefined && sid >= 0 && this.recordLocals) this.snapshot(this.curStep, rid, sid, locals);
      return sid;
    } catch (e) {
      this.onError(e, 'scope');
      return NO_SCOPE;
    }
  };

  private enter(rid: number): number {
    this.hits[rid]!++;
    if (this.quiet) return NO_SCOPE;
    const n = this.n;
    if (n >= this.cap) {
      this.n = n + 1;
      return NO_SCOPE;
    }
    const stack = this.stack;
    const parent = stack.length ? stack[stack.length - 1]! : 0;
    const sid = this.scopes.length;
    const depth = this.depthOf[parent]! + 1;
    const scope: Scope = { scopeId: sid, rid, name: this.names.get(rid) ?? '<function>', parent, depth, first: n, last: n };
    const als = this.als;
    let prev: number | undefined;
    if (als !== null) {
      // while a frame of ours runs, the store is that frame's (set when it went on the stack)
      if (stack.length) prev = parent;
      else {
        prev = als.getStore();
        if (prev !== undefined && prev !== 0) scope.asyncParent = prev;
      }
      als.enterWith(sid);
    }
    this.scopes.push(scope);
    this.depthOf.push(depth);
    this.lastOf.push(n);
    this.push(sid, prev);
    const p = n << 2;
    let buf = this.buf;
    if (p + 4 > buf.length) buf = this.grow();
    buf[p] = rid;
    buf[p + 1] = sid;
    buf[p + 2] = depth;
    buf[p + 3] = FLAG_SCOPE_ENTRY;
    this.curStep = n;
    this.n = n + 1;
    this.cur = sid;
    if (this.onStep !== null) this.onStep(n, rid, sid);
    if ((n & 1023) === 0) this.periodic();
    return sid;
  }

  /**
   * A frame is leaving; `rv` (`_tk_rv_`) says how: the value a `return` stored, END when the body
   * ran off its end, UNSET while an exception leaves. A module body passes no `rv`.
   */
  readonly x = (sid: number, rv?: unknown): void => {
    try {
      if (sid < 0) return;
      this.pop(sid);
      const scope = this.scopes[sid];
      if (scope === undefined || (rv === undefined && scope.name === '<module>')) return;
      if (rv === END) {
        scope.returned = null;
        delete scope.raised;
      } else if (rv === UNSET) {
        // `ex` named the type when the error passed through the frame's catch
        if (scope.raised === undefined) scope.raised = 'Error';
      } else {
        delete scope.raised; // a `finally` that returns swallows the exception
        this.setReturned(scope, rv);
      }
    } catch (e) {
      this.onError(e, 'exit');
    }
  };

  /** an exception is leaving frame `sid` (it is rethrown unchanged) */
  readonly ex = (sid: number, err: unknown): void => {
    try {
      if (sid < 0) return;
      const scope = this.scopes[sid];
      if (scope === undefined) return;
      scope.raised = errorType(err);
      if (this.onException !== null) return this.onException(err, sid);
      // the statement that raised is the frame's last step; a frame the error only passes through
      // flags its call statement as unwinding
      const step = this.lastOf[sid]!;
      if (this.firstSighting(err)) this.flag(step, FLAG_ERROR);
      else this.flag(step, FLAG_UNWINDING);
    } catch (e) {
      this.onError(e, 'exception');
    }
  };

  /** `await x` / `yield x` is about to suspend frame `sid`: the caller (or the event loop) runs next */
  readonly ap = <T>(sid: number, value: T): T => {
    try {
      if (sid > 0) this.pop(sid);
      else if (sid === 0) this.cur = 0;
    } catch (e) {
      this.onError(e, 'await');
    }
    return value;
  };

  /** frame `sid` resumed after an await or yield */
  readonly aw = <T>(sid: number, value: T): T => {
    try {
      this.resume(sid);
    } catch (e) {
      this.onError(e, 'resume');
    }
    return value;
  };

  private resume(sid: number): void {
    if (sid < 0) return;
    if (sid === 0) {
      // the main module's top-level await: nothing of ours is on the JS stack
      if (this.clock !== null) this.tick(false);
      this.cur = 0;
      if (this.als !== null && this.als.getStore() !== 0) this.als.enterWith(0);
      return;
    }
    const prev = this.als?.getStore();
    this.push(sid, prev);
    this.cur = sid;
    if (this.als !== null && prev !== sid) this.als.enterWith(sid);
  }

  // -- recording from a pause (recordFrom) ------------------------------------------------------

  /**
   * The recording starts at a debugger pause: `frames` are the instrumented frames on the paused
   * stack, outermost first (the debug hooks' shadow stack), each with the debug-hook id its
   * `_tk_scope_` holds. Each gets a scope, parent before child, with `first: 0`; the paused
   * statement `rid` of frame `scope` (0, or one of those ids) becomes step 0, flag 4 when it is a
   * function's entry. `baselines` are silent locals snapshots, so a value from before the switch is
   * not reported as a change. Returns the paused frame's recorded scope.
   */
  startMidRun(frames: { id: number; rid: number }[], rid: number, scope: number, entry: boolean, baselines: { id: number; rid: number; getter: LocalsGetter }[] = []): number {
    this.midRun = true;
    const stack = this.stack;
    stack.length = 0;
    this.prevStore.length = 0;
    const store = this.als?.getStore();
    let parent = 0;
    for (const fr of frames) {
      const sid = this.newScope(fr.rid, parent, 0);
      this.foreign.set(fr.id, sid);
      this.push(sid, stack.length ? parent : store);
      parent = sid;
    }
    let top = scope;
    if (scope >= FOREIGN) top = this.foreign.get(scope) ?? this.adopt(scope, rid);
    else if (scope !== 0) top = 0;
    if (this.als !== null) this.als.enterWith(top);
    if (this.cap > 0) {
      const buf = this.buf;
      buf[0] = rid;
      buf[1] = top;
      buf[2] = this.depthOf[top]!;
      buf[3] = entry ? FLAG_SCOPE_ENTRY : 0;
      this.lastOf[top] = 0;
    }
    this.curStep = 0;
    this.n = 1;
    this.cur = top;
    this.lastFlush = this.started = performance.now();
    if (this.recordLocals) {
      for (const b of baselines) {
        const sid = b.id === 0 ? 0 : this.foreign.get(b.id);
        if (sid !== undefined) this.seedLocals(sid, b.rid, b.getter);
      }
    }
    return top;
  }

  /** The `__tk` members of a recordFrom run once it records: a frame's id from before the switch is mapped first. */
  midRunHooks(): Record<string, unknown> {
    const map = (sid: number): number => (sid >= FOREIGN ? (this.foreign.get(sid) ?? NO_SCOPE) : sid);
    return {
      s: (rid: number, scope: number, locals?: LocalsGetter): void => {
        if (scope >= FOREIGN) {
          try {
            scope = this.foreign.get(scope) ?? this.adopt(scope, rid);
          } catch (e) {
            this.onError(e, 'step');
            return;
          }
        }
        this.s(rid, scope, locals);
      },
      x: (sid: number, rv?: unknown): void => this.x(map(sid), rv),
      ex: (sid: number, err: unknown): void => this.ex(map(sid), err),
      ap: <T>(sid: number, value: T): T => this.ap(map(sid), value),
      // a frame suspended at the switch gets its scope at its next statement (`adopt`)
      aw: <T>(sid: number, value: T): T => (sid >= FOREIGN && !this.foreign.has(sid) ? value : this.aw(map(sid), value)),
    };
  }

  /** A frame entered before the switch that the stack walk did not see: its scope, with whoever runs it now as parent. */
  private adopt(id: number, rid: number): number {
    const stack = this.stack;
    const sid = this.newScope(this.defRidOf(rid), stack.length ? stack[stack.length - 1]! : 0, this.n);
    this.foreign.set(id, sid);
    return sid;
  }

  private newScope(rid: number, parent: number, first: number): number {
    const sid = this.scopes.length;
    const depth = (this.depthOf[parent] ?? 0) + 1;
    this.scopes.push({ scopeId: sid, rid, name: this.names.get(rid) ?? '<function>', parent, depth, first, last: first });
    this.depthOf.push(depth);
    this.lastOf.push(first);
    return sid;
  }

  /** What a frame holds at the switch, kept as the snapshot its next step diffs against. Nothing is emitted. */
  private seedLocals(scope: number, rid: number, getter: LocalsGetter): void {
    const names = this.localNames.get(rid);
    if (!names || names.length === 0) return;
    this.quiet++;
    try {
      let values: unknown[];
      try {
        values = getter();
      } catch {
        return;
      }
      const prev = new Map<string, [unknown, number]>();
      for (let i = 0; i < names.length; i++) {
        const v = values[i];
        if (typeof v !== 'function') prev.set(names[i]!, [v, sizeOf(v)]);
      }
      this.snaps.set(scope, prev);
    } finally {
      this.quiet--;
    }
  }

  // -- frame chain ---------------------------------------------------------------------------

  private push(sid: number, prev: number | undefined): void {
    if (this.stack.length === 0 && !this.sweepQueued) {
      this.sweepQueued = true;
      queueMicrotask(this.sweep);
      // a callback the event loop runs: after another thread moved, a new segment
      if (this.clock !== null) this.tick(false);
    }
    this.stack.push(sid);
    this.prevStore.push(prev);
  }

  /** `sid` leaves the JS stack (returned or suspended): it and anything left above it come off */
  private pop(sid: number): void {
    const stack = this.stack;
    let i = stack.length - 1;
    while (i >= 0 && stack[i] !== sid) i--;
    if (i < 0) {
      // not on the stack (resumed without `aw`, or already swept): nothing to unwind
      if (this.cur === sid) this.cur = stack.length ? stack[stack.length - 1]! : 0;
      return;
    }
    const prev = this.prevStore[i];
    stack.length = i;
    this.prevStore.length = i;
    this.cur = i ? stack[i - 1]! : 0;
    // back to the store the frame found, none included (a worker a debugger holds at its start
    // evaluates its module where the store was never set)
    if (this.als !== null && this.als.getStore() !== prev) this.als.enterWith(prev as number);
  }

  /** a statement of `scope` runs while the chain says otherwise: the frame resumed without `aw` */
  private resync(scope: number): void {
    const stack = this.stack;
    if (scope === 0) {
      // main-module code only runs with nothing of ours under it
      if (stack.length) {
        stack.length = 0;
        this.prevStore.length = 0;
      }
      this.cur = 0;
      return;
    }
    const i = stack.lastIndexOf(scope);
    if (i >= 0) {
      stack.length = i + 1;
      this.prevStore.length = i + 1;
      if (this.als !== null) this.als.enterWith(scope);
    } else {
      const prev = this.als?.getStore();
      this.push(scope, prev);
      if (this.als !== null && prev !== scope) this.als.enterWith(scope);
    }
    this.cur = scope;
  }

  /**
   * A synchronisation point: the steps from here on start a new segment with a fresh ticket.
   * Unforced, only when another thread took a ticket since this one's last (else nothing can be
   * ordered against them and the segment goes on).
   */
  tick(force: boolean): void {
    const clock = this.clock;
    if (clock === null) return;
    if (!force && Atomics.load(clock, 0) === this.ticket) return;
    const t = Atomics.add(clock, 0, 1) + 1;
    this.ticket = t;
    const at = Math.min(this.n, this.cap);
    const segs = this.segs;
    if (segs.length && segs[segs.length - 2] === at) segs[segs.length - 1] = t;
    else segs.push(at, t);
  }

  // -- attribution -----------------------------------------------------------------------------

  /**
   * The step and scope that code without a hook of its own belongs to: the running frame while
   * one of ours is on the JS stack, else the frame whose code scheduled this callback.
   */
  attribution(): Attribution {
    if (this.stack.length === 0 && this.als !== null) {
      const store = this.als.getStore();
      if (store !== undefined && store > 0 && store < this.scopes.length) return { step: this.lastOf[store]!, scope: store };
      if (store === 0) return { step: this.lastOf[0]!, scope: 0 };
    }
    return { step: this.curStep, scope: this.cur };
  }

  /** the step a statement of `rid` in the attributed scope last ran as, else the attributed step */
  stepFor(rid: number): number {
    const at = this.attribution();
    const buf = this.buf;
    for (let i = Math.min(this.n, this.cap) - 1, k = 0; i >= 0 && k < 5000; i--, k++) {
      if (buf[i << 2] === rid && buf[(i << 2) + 1] === at.scope) return i;
    }
    return at.step;
  }

  // -- flags, values -------------------------------------------------------------------------------

  flag(step: number, flag: number): void {
    if (step >= 0 && step < this.n && step < this.cap) this.buf[(step << 2) + 3]! |= flag;
  }

  private firstSighting(err: unknown): boolean {
    if (typeof err === 'object' && err !== null) {
      if (this.lastRaisedSeen.has(err)) return false;
      this.lastRaisedSeen.add(err);
      return true;
    }
    if (this.lastRaised === err && err !== UNSET) return false;
    this.lastRaised = err;
    return true;
  }

  private setReturned(scope: Scope, rv: unknown): void {
    let t: ValueText;
    this.quiet++;
    try {
      t = cutText(displayText(rv), this.valueChars);
    } finally {
      this.quiet--;
    }
    scope.returned = t.text;
    if (t.truncated) {
      scope.returnedTruncated = true;
      if (t.length !== undefined) scope.returnedLength = t.length;
    }
  }

  /** recordLocals: the names whose value changed since this scope's last snapshot (identity, and length for arrays, maps and sets) */
  private snapshot(step: number, rid: number, scope: number, getter: LocalsGetter): void {
    if (this.localsEntries.length >= MAX_LOCALS_ENTRIES) return;
    const names = this.localNames.get(rid);
    if (!names || names.length === 0) return;
    this.quiet++;
    try {
      let values: unknown[];
      try {
        values = getter();
      } catch {
        return; // a name in its temporal dead zone: nothing recorded at this step
      }
      let prev = this.snaps.get(scope);
      if (prev === undefined) {
        prev = new Map();
        this.snaps.set(scope, prev);
      }
      let changes: LocalsChange[] | null = null;
      const hoisted = this.localHoisted.get(rid);
      for (let i = 0; i < names.length; i++) {
        const v = values[i];
        if (typeof v === 'function') continue;
        const len = sizeOf(v);
        const was = prev.get(names[i]!);
        if (was !== undefined && Object.is(was[0], v) && was[1] === len) continue;
        if (was === undefined && v === undefined && hoisted !== undefined && hoisted[i]) {
          prev.set(names[i]!, [v, len]); // a hoisted var before its declaration ran
          continue;
        }
        prev.set(names[i]!, [v, len]);
        const t = valueText(names[i]!, v, this.valueChars);
        (changes ??= []).push({ name: names[i]!, ...t });
      }
      if (changes !== null) this.localsEntries.push({ step, scopeId: scope, changes });
    } finally {
      this.quiet--;
    }
  }

  // -- trace events ----------------------------------------------------------------------------

  private grow(): Int32Array {
    const next = new Int32Array(this.buf.length * 2);
    next.set(this.buf);
    this.buf = next;
    return next;
  }

  /** steps recorded so far (at most the cap) */
  get recorded(): number {
    return Math.min(this.n, this.cap);
  }

  /** the step quads recorded so far (a view, not a copy) */
  steps(): Int32Array {
    return this.buf.subarray(0, this.recorded << 2);
  }

  /**
   * A scope id for another thread's scope (threads/hub.ts): the merged trace's ids are this
   * recorder's, so this thread's later scopes go after it. It records nothing here.
   */
  reserveScope(depth: number): number {
    const sid = this.scopes.length;
    this.scopes.push({ scopeId: sid, rid: 0, name: '', parent: 0, depth, first: 0, last: 0, foreign: true });
    this.depthOf.push(depth);
    this.lastOf.push(0);
    return sid;
  }

  scopeTable(start = 0): Scope[] {
    const out: Scope[] = [];
    for (let i = start; i < this.scopes.length; i++) out.push({ ...this.scopes[i]!, last: this.lastOf[i]! });
    return out;
  }

  private periodic(): void {
    const now = performance.now();
    if (now - this.lastFlush >= TRACE_FLUSH_MS && now - this.started >= TRACE_FLUSH_MS) {
      this.lastFlush = now;
      this.flushPartial();
    }
    if (this.onPeriodic !== null) this.onPeriodic();
  }

  /** Mid-run delta: the steps since the last flush and the scopes created since then; nothing new once the cap is reached. */
  flushPartial(): void {
    if (this.partialHook !== null) {
      this.partialHook();
      this.flushLocals();
      return;
    }
    const recorded = this.recorded;
    if (recorded <= this.flushedSteps) return;
    const chunk = this.buf.subarray(this.flushedSteps << 2, recorded << 2);
    const event: Record<string, unknown> = {
      type: 'trace',
      partial: true,
      offset: this.flushedSteps,
      steps: encodeSteps(chunk),
      scopes: this.scopeTable(this.flushedScopes),
      truncated: this.n > this.cap,
    };
    if (this.midRun) event.midRun = true;
    this.emit(event);
    this.flushedSteps = recorded;
    this.flushedScopes = this.scopes.length;
    this.flushLocals();
  }

  private flushLocals(): void {
    for (let i = this.localsFlushed; i < this.localsEntries.length; i += 5000) {
      this.emit({ type: 'locals', entries: this.localsEntries.slice(i, Math.min(i + 5000, this.localsEntries.length)) });
    }
    this.localsFlushed = this.localsEntries.length;
  }

  /** The final, authoritative trace (and the locals not sent yet). Idempotent. */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.flushLocals();
    const truncated = this.n > this.cap;
    const event: Record<string, unknown> = { type: 'trace', steps: encodeSteps(this.steps()), scopes: this.scopeTable(), truncated };
    if (this.midRun) event.midRun = true;
    if (truncated) Object.assign(event, this.capReport());
    this.emit(event);
  }

  /** For a trace cut at the cap: the setting, the statements run, and the five files that ran most. */
  capReport(): { cap: number; stepsRun: number; spentBy: { path: string; steps: number }[] } {
    const spent: { path: string; steps: number }[] = [];
    for (const f of this.files) {
      let n = 0;
      for (const local of f.statements) n += this.hits[f.rangeBase + local] ?? 0;
      if (n) spent.push({ path: f.filename, steps: n });
    }
    spent.sort((a, b) => b.steps - a.steps);
    return { cap: this.cap, stepsRun: this.n, spentBy: spent.slice(0, 5) };
  }
}

function sizeOf(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  if (v instanceof Map || v instanceof Set) return v.size;
  return -1;
}

/** The type name `raised` carries: the error's class, or the thrown value's type. */
export function errorType(err: unknown): string {
  if (err instanceof Error && typeof err.name === 'string' && err.name) return err.name;
  if (err === null) return 'null';
  if (typeof err === 'object' || typeof err === 'function') {
    try {
      const name = (err as { constructor?: { name?: unknown } }).constructor?.name;
      if (typeof name === 'string' && name) return name;
    } catch {
      // a Proxy that throws on get
    }
    return 'Object';
  }
  return typeof err;
}
