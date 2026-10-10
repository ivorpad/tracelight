/**
 * The live debugger, main-thread half: decide at each statement whether the program stops.
 *
 * Python stops a thread by blocking it inside the hook while a control thread serves requests.
 * A JavaScript thread cannot wait on itself, so the stop comes from V8: a debug run starts a worker
 * thread (`agent.ts`) whose `node:inspector` session is connected to this thread
 * (`session.connectToMainThread()`). When `onStep` finds a reason it records the candidate and
 * runs a `debugger` statement; V8 suspends this thread and the worker gets `Debugger.paused` with
 * the live call frames. The worker reads the candidate back, evaluates whatever needs the frame (a
 * breakpoint condition, a break-when watch), and either resumes at once or calls `stop()` here,
 * serves requests against the frames with `Debugger.evaluateOnCallFrame`, and calls `resume()`
 * before `Debugger.resume`. Both calls run on this thread while it is suspended (V8 runs
 * inspector-evaluated code on the paused isolate), so `debug.paused` and `debug.resumed` go out
 * through the run's own synchronous emitter, after the flush, in the order Python sends them.
 *
 * Exceptions are V8's (`Debugger.setPauseOnExceptions`), not the hook's: the worker sees them
 * with the throwing frame live and calls `stop()` with reason `exception`.
 *
 * The core calls, from its hooks: `onStep(n, rid, scope)` before every statement and function
 * entry (only while `armed`), `onLeave(scope)` from the `finally` of a frame a step waits on
 * (`pendingSid`), and `fileAdded(file)` as each file is instrumented. Step semantics, breakpoint
 * resolution, the arming cell and `modified` are here; it has two modes (with a recording:
 * scopes from the trace; without: per-call ids and frame exits).
 */
import { parseSync } from 'oxc-parser';
import { resolveBreakpoint, type DebugFile } from './breakpoints.ts';
import { describeFallback, type Described } from './describe.ts';

export const STEP_KINDS = ['into', 'over', 'out'] as const;
export const EXCEPTION_MODES = ['off', 'uncaught', 'raised'] as const;
export type StepKind = (typeof STEP_KINDS)[number];
export type ExceptionMode = (typeof EXCEPTION_MODES)[number];

export interface ScopeEntry {
  scopeId: number;
  name: string;
  rid: number;
  depth: number;
}

/** What the run child gives the debugger. Everything but `emit` and `files` is optional. */
export interface DebugHost {
  /** a recording run: `step` is the trace index and the stack is the scope chain */
  record: boolean;
  /** one run event, written synchronously (the stop must not wait for an event loop turn) */
  emit(event: Record<string, unknown>): void;
  /** the instrumented files so far, in instrumentation order */
  files(): DebugFile[];
  /** before a stop: buffered output, the partial trace, timings and new locals */
  flush?(): void;
  /** recording mode: the scope and its ancestors, innermost first */
  scopeChain?(scope: number): ScopeEntry[];
  /** one value as `{text, valueBag}` under `key` (masked); the fallback is a bounded inspect */
  describe?(value: unknown, name: string, key: string): Described;
  /** serve a request the debugger does not own (`expand`, `source`) and emit its reply */
  handleRequest?(req: Record<string, unknown>): void;
  /** the statement counter now (a trace index with a recording): an exception pause's `step` */
  currentStep?(): number;
  /** recordFrom: start recording at this pause (`rid` of frame `scope`); returns the paused frame's recorded scope and step 0 */
  startRecording?(rid: number, scope: number): { scope: number; step: number };
}

export interface DebuggerOptions {
  /** false: no live debugger, only the watch window (a Time Machine re-run) */
  debug?: boolean;
  stopOnEntry?: boolean;
  breakOnException?: string;
  breakpoints?: BreakpointSpec[];
  /** the run request's `watch` and `traceContext` */
  watch?: { id?: string; exp?: string }[];
  traceContext?: { step?: number; prefetch?: number; mainStep?: number };
  /** `config.recordFrom`: the pause that starts the recording, `"pause"` (the first) or a breakpoint spec */
  recordFrom?: 'pause' | BreakpointSpec | null;
}

export interface BreakpointSpec {
  path?: string;
  line?: number;
  function?: string;
  condition?: string;
}

export class Breakpoint {
  path: string;
  line: number;
  function: string | null;
  condition: string | null;
  error: string | null = null;
  rid: number | null = null;
  fileId: number | null = null;
  resolvedLine: number | null = null;

  constructor(spec: BreakpointSpec) {
    this.path = String(spec.path ?? '');
    this.line = Number(spec.line ?? 0) | 0;
    this.function = String(spec.function ?? '').trim() || null;
    this.condition = String(spec.condition ?? '').trim() || null;
    if (this.condition) this.error = syntaxError(this.condition);
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = { path: this.path, line: this.line };
    if (this.function) out.function = this.function;
    if (this.condition) out.condition = this.condition;
    if (this.rid !== null) Object.assign(out, { rid: this.rid, fileId: this.fileId, resolvedLine: this.resolvedLine });
    if (this.error) out.error = this.error;
    return out;
  }
}

/** `SyntaxError: ...` when `expression` is not one JavaScript expression, else null. */
export function syntaxError(expression: string): string | null {
  const res = parseSync('tracelight-condition.js', `(${expression}\n)`, { sourceType: 'script' });
  if (res.errors.length) return `SyntaxError: ${res.errors[0]!.message}`;
  const body = res.program.body;
  if (body.length !== 1 || body[0]!.type !== 'ExpressionStatement') return 'SyntaxError: not one expression';
  return null;
}

/** What the worker reads back at a trap: why this statement may stop, and what still needs the frame. */
export interface Candidate {
  n: number;
  rid: number;
  scope: number;
  /** a reason that holds without the frame: start, step, pause, breakpoint (no condition) */
  reason: string | null;
  extra: Record<string, unknown>;
  /** a breakpoint whose condition the worker evaluates in the frame */
  condition: { bp: Record<string, unknown>; expression: string } | null;
  /** break-when watches are set: the worker evaluates them in the frame */
  watches: boolean;
  /** this step is in the Time Machine's watch window: the worker evaluates these and emits `watch` events */
  stepWatches: { id: string; exp: string }[] | null;
}

type Pending = { kind: StepKind; target: number; waitExit: boolean } | { kind: StepKind; allowed: Set<number> | null };

export class Debugger {
  readonly host: DebugHost;
  startPaused: boolean;
  breakpoints: Breakpoint[] = [];
  /** rid -> breakpoint, mutated in place */
  readonly byRid = new Map<number, Breakpoint>();
  watching = false;
  pending: Pending | null = null;
  /** the scope `onLeave` is waited for; -1 while no step waits for a frame exit */
  pendingSid = -1;
  pauseRequested = false;
  /** any reason can fire at a statement: the core's hooks skip `onStep` while false */
  armed = false;
  /** a reason other than a breakpoint is armed: the record: false hooks call `onStep` at every statement only then */
  other = false;
  /** `config.recordFrom`, resolved: the recording starts at the first pause, or at the first pause on this breakpoint's statement */
  recordFrom: 'pause' | Breakpoint | null = null;
  /** the stop being served, for the `record` action to announce again as step 0 */
  private lastStop: { reason: string; extra: Record<string, unknown>; line: number | null; fileId: number } | null = null;
  breakOnException: ExceptionMode;
  modified = false;
  pauses = 0;
  finished = false;
  /** the candidate of the trap in progress, for the worker */
  candidate: Candidate | null = null;
  /** (step, rid, scope) of the stop being served */
  pausedAt: [number, number, number] | null = null;
  private trapping = false;
  private serving = false;
  private serial = 0;
  /** the action `resume()` left for the trap to arm once V8 lets this thread go */
  private resumeAction: { action: string; kind?: string | null } | null = null;

  /** the Time Machine's watch window: steps `lo <= n < hi` evaluate `watches` in the stepping frame */
  stepWatches: { lo: number; hi: number; watches: { id: string; exp: string }[] } | null = null;

  constructor(host: DebugHost, options: DebuggerOptions = {}) {
    this.host = host;
    this.startPaused = options.debug !== false && options.stopOnEntry !== false;
    this.setStepWatches(options.watch, options.traceContext);
    this.breakOnException = (EXCEPTION_MODES as readonly string[]).includes(options.breakOnException ?? '') ? (options.breakOnException as ExceptionMode) : 'uncaught';
    if (options.recordFrom === 'pause') this.recordFrom = 'pause';
    else if (options.recordFrom && typeof options.recordFrom === 'object') {
      this.recordFrom = new Breakpoint(options.recordFrom);
      resolveBreakpoint(this.host.files(), this.recordFrom);
    }
    this.setBreakpoints(options.breakpoints ?? []);
  }

  // -- arming ------------------------------------------------------------------------------------
  rearm(): void {
    this.other = !this.finished && (this.startPaused || this.pauseRequested || this.pending !== null || this.watching || this.stepWatches !== null);
    this.armed = this.other || (!this.finished && this.byRid.size > 0);
  }

  /**
   * Watch expressions at a step: evaluated in the stepping frame
   * for the steps of `traceContext.step .. + prefetch`, each a `watch` event. A watch that does not
   * parse is one `watch` event with `error` at the window's first step.
   */
  private setStepWatches(watch: DebuggerOptions['watch'], ctx: DebuggerOptions['traceContext']): void {
    if (!watch?.length || !ctx || typeof ctx.step !== 'number') return;
    // a run with worker threads: the window counts the main thread's own statements (the hub merges them)
    const lo = Math.max(0, typeof ctx.mainStep === 'number' ? ctx.mainStep : ctx.step);
    const hi = lo + Math.max(1, Number(ctx.prefetch ?? 10));
    const watches: { id: string; exp: string }[] = [];
    for (const w of watch) {
      const id = String(w?.id ?? `w${watches.length + 1}`);
      const exp = String(w?.exp ?? '').trim();
      if (!exp) continue;
      const err = syntaxError(exp);
      if (err) this.host.emit({ type: 'watch', watchId: id, step: lo, error: err });
      else watches.push({ id, exp });
    }
    if (watches.length) this.stepWatches = { lo, hi, watches };
  }

  requestPause(): { ok: true; paused: boolean } {
    const paused = this.serving;
    if (!paused) {
      this.pauseRequested = true;
      this.rearm();
    }
    return { ok: true, paused };
  }

  // -- breakpoints and watches -------------------------------------------------------------------
  setBreakpoints(specs: BreakpointSpec[]): { breakpoints: Record<string, unknown>[] } {
    const bps: Breakpoint[] = [];
    for (const spec of specs ?? []) {
      if (spec && typeof spec === 'object') bps.push(new Breakpoint(spec));
    }
    const files = this.host.files();
    for (const bp of bps) resolveBreakpoint(files, bp);
    this.breakpoints = bps;
    this.index();
    return { breakpoints: bps.map((bp) => bp.toJSON()) };
  }

  /** the line breakpoints as given, for a worker thread's own V8 breakpoints (a worker runs its files uninstrumented) */
  lineBreakpoints(): { path: string; line: number; condition: string | null; echo: Record<string, unknown> }[] {
    return this.breakpoints.filter((bp) => !bp.function && !bp.error && bp.path && bp.line > 0).map((bp) => ({ path: bp.path, line: bp.line, condition: bp.condition, echo: bp.toJSON() }));
  }

  /** what a recorded worker thread traps on itself (threads/worker.ts): it resolves the names against its own files */
  functionBreakpoints(): { function: string; path: string; echo: Record<string, unknown> }[] {
    return this.breakpoints.filter((bp) => bp.function && !bp.error?.startsWith('SyntaxError')).map((bp) => ({ function: bp.function!, path: bp.path, echo: bp.toJSON() }));
  }

  fileAdded(file: DebugFile): void {
    const files = this.host.files();
    if (this.recordFrom instanceof Breakpoint) resolveBreakpoint(files, this.recordFrom, file);
    let changed = false;
    for (const bp of this.breakpoints) if (resolveBreakpoint(files, bp, file)) changed = true;
    if (changed) this.index();
  }

  private index(): void {
    this.byRid.clear();
    for (const bp of this.breakpoints) if (bp.rid !== null && !this.byRid.has(bp.rid)) this.byRid.set(bp.rid, bp);
    this.rearm();
  }

  /** The worker keeps the watches (it evaluates them); this side only needs to know there are some. */
  setWatching(on: boolean): void {
    this.watching = on;
    this.rearm();
  }

  setExceptionMode(mode: string): { ok: true; mode: ExceptionMode } | null {
    if (!(EXCEPTION_MODES as readonly string[]).includes(mode)) return null;
    this.breakOnException = mode as ExceptionMode;
    return { ok: true, mode: this.breakOnException };
  }

  // -- the hooks ---------------------------------------------------------------------------------
  /** One statement (or a function entry), before it runs. */
  onStep(n: number, rid: number, scope: number): void {
    if (!this.armed || this.trapping || this.serving) return;
    let stepWatches: Candidate['stepWatches'] = null;
    const sw = this.stepWatches;
    if (sw !== null) {
      if (n >= sw.hi) {
        this.stepWatches = null;
        this.rearm();
      } else if (n >= sw.lo) stepWatches = sw.watches;
    }
    let reason: string | null = null;
    const extra: Record<string, unknown> = {};
    if (this.startPaused) {
      this.startPaused = false;
      reason = 'start';
    } else if (this.pending !== null) {
      const kind = this.pendingFires(scope);
      if (kind !== null) {
        reason = 'step';
        extra.kind = kind;
      }
    }
    if (reason === null && this.pauseRequested) reason = 'pause';
    let condition: Candidate['condition'] = null;
    if (reason === null && this.byRid.size) {
      const bp = this.byRid.get(rid);
      if (bp) {
        if (bp.condition && !bp.error) condition = { bp: bp.toJSON(), expression: bp.condition };
        else {
          reason = 'breakpoint';
          extra.breakpoint = bp.toJSON();
        }
      }
    }
    if (reason === null && condition === null && !this.watching && stepWatches === null) return;
    this.candidate = { n, rid, scope, reason, extra, condition, watches: reason === null && this.watching, stepWatches };
    this.trap();
    this.candidate = null;
    const action = this.resumeAction;
    this.resumeAction = null;
    if (action) this.afterResume(action);
  }

  /**
   * The frame a step is waiting on has returned: the step goes on in `caller`, the instrumented
   * frame that called it (the module is 0), or, when the event loop or code that is not
   * instrumented called it (-1), in whatever runs next.
   */
  onLeave(scope: number, caller = -1): void {
    const p = this.pending;
    if (p === null || !('target' in p) || scope !== this.pendingSid) return;
    this.pending = { kind: p.kind, target: caller, waitExit: false };
    this.pendingSid = -1;
  }

  /** The `debugger` statement the worker's session turns into a pause. Kept tiny and separate so its frame is easy to skip. */
  trap(): void {
    this.trapping = true;
    try {
      debugger; // eslint-disable-line no-debugger
    } finally {
      this.trapping = false;
    }
  }

  private pendingFires(scope: number): StepKind | null {
    const p = this.pending;
    if (p === null) return null;
    if ('allowed' in p) return p.allowed === null || p.allowed.has(scope) ? p.kind : null;
    if (!p.waitExit && (p.target < 0 || scope === p.target)) return p.kind;
    return null;
  }

  // -- called by the worker while this thread is suspended ----------------------------------------
  /**
   * Emit the stop. `frameStack` is the worker's frame chain (used without a recording);
   * returns the event so the worker knows the step it reported.
   */
  stop(n: number, rid: number, scope: number, reason: string, extra: Record<string, unknown>, frameStack: Record<string, unknown>[], line: number | null, fileId: number): Record<string, unknown> {
    this.pending = null;
    this.pendingSid = -1;
    this.pauseRequested = false;
    this.pauses += 1;
    this.serving = true;
    if (this.recordsHere(rid)) {
      const started = this.host.startRecording!(rid, scope);
      n = started.step;
      scope = started.scope;
      extra = { ...extra, recordingStarted: true };
    }
    this.pausedAt = [n, rid, scope];
    this.lastStop = { reason, extra: Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'recordingStarted')), line, fileId };
    try {
      this.host.flush?.();
    } catch {
      /* a failed flush must not lose the stop */
    }
    const event = this.pausedEvent(n, rid, scope, reason, extra, frameStack, line, fileId);
    this.host.emit(event);
    return event;
  }

  private pausedEvent(n: number, rid: number, scope: number, reason: string, extra: Record<string, unknown>, frameStack: unknown[], line: number | null, fileId: number): Record<string, unknown> {
    let stack: unknown[] = frameStack;
    let depth = Math.max(0, frameStack.length - 1);
    if (this.host.record && this.host.scopeChain) {
      const chain = this.host.scopeChain(scope);
      // a scope still on the frame chain also carries that frame's own file and line, so a caller
      // shows its call site, not the paused line (a resumed task's awaiter has no frame: none)
      const bySid = new Map<unknown, Record<string, unknown>>();
      for (const f of frameStack) if (f.scopeId !== undefined && !bySid.has(f.scopeId)) bySid.set(f.scopeId, f);
      stack = chain.map((c, i) => {
        if (i === 0) return line !== null ? { ...c, fileId, line } : c;
        const f = bySid.get(c.scopeId);
        return f && typeof f.line === 'number' && f.fileId ? { ...c, fileId: f.fileId, line: f.line } : c;
      });
      depth = chain[0]?.depth ?? 0;
    }
    const event: Record<string, unknown> = {
      type: 'debug.paused', step: n, rid, fileId, line, scopeId: scope, depth, reason,
      thread: { name: 'main', ident: 0 }, stack, ...extra,
    };
    if (this.modified) event.modified = true;
    return event;
  }

  /** a recordFrom run that does not record yet starts at this pause: the first one, or the first on recordFrom's statement */
  private recordsHere(rid: number): boolean {
    const spec = this.recordFrom;
    if (spec === null || this.host.record || !this.host.startRecording) return false;
    return spec === 'pause' || (spec.rid !== null && spec.rid === rid);
  }

  /** The stop ends: remember the action; `onStep` (or the exception path) arms it once V8 resumes. */
  resume(action: string, kind?: string | null): void {
    this.serving = false;
    if (this.trapping) this.resumeAction = { action, kind };
    else this.afterResume({ action, kind }); // an exception pause: no trap frame to come back to
  }

  private afterResume(action: { action: string; kind?: string | null }): void {
    const at = this.pausedAt;
    this.pausedAt = null;
    if (!at) return;
    const [n, , scope] = at;
    if (action.action === 'step') this.armStep((STEP_KINDS as readonly string[]).includes(action.kind ?? '') ? (action.kind as StepKind) : 'into', scope);
    const stepping = this.pending !== null;
    this.host.emit({ type: 'debug.resumed', step: n, action: stepping ? 'step' : 'continue', ...(stepping ? { kind: this.pending!.kind } : {}) });
    this.rearm();
  }

  private armStep(kind: StepKind, scope: number): void {
    if (this.host.record && this.host.scopeChain) {
      const chain = this.host.scopeChain(scope).map((s) => s.scopeId);
      this.pending = { kind, allowed: kind === 'over' ? new Set(chain) : kind === 'out' ? new Set(chain.slice(1)) : null };
      this.pendingSid = -1;
      return;
    }
    if (kind === 'over') this.pending = { kind, target: scope, waitExit: false };
    else if (kind === 'out') this.pending = { kind, target: scope, waitExit: true };
    else this.pending = { kind: 'into', target: -1, waitExit: false };
    this.pendingSid = kind === 'into' ? -1 : scope;
  }

  /**
   * The `record` action at the stop being served: a recordFrom run records from here on, and the
   * pause is announced again as step 0 (`recordingStarted`). A run that records already answers
   * where it is (`already`).
   */
  recordHere(): Record<string, unknown> {
    const at = this.pausedAt;
    if (!at) throw new Error('the program is running; pause it first');
    if (this.host.record) return { ok: true, recording: true, already: true, step: at[0] };
    if (this.recordFrom === null || !this.host.startRecording) throw new Error('this run was started without a recording; start it with recordFrom to record from a pause');
    const [, rid, scope] = at;
    const started = this.host.startRecording(rid, scope);
    this.pausedAt = [started.step, rid, started.scope];
    try {
      this.host.flush?.();
    } catch {
      /* a failed flush must not lose the stop */
    }
    const last = this.lastStop ?? { reason: 'pause', extra: {}, line: null, fileId: 0 };
    this.host.emit(this.pausedEvent(started.step, rid, started.scope, last.reason, { ...last.extra, recordingStarted: true }, [], last.line, last.fileId));
    return { ok: true, recording: true, step: started.step };
  }

  /** One value as `{text, valueBag}`, under a fresh `d:N` id `expand` can open. */
  describe(value: unknown, name: string): Described {
    const key = `d:${++this.serial}`;
    if (this.host.describe) return this.host.describe(value, name, key);
    return describeFallback(value, name, key);
  }

  /** A watch-window value, as a `watch` event. */
  watchValue(value: unknown, watchId: string, step: number, exp: string): void {
    const bag = this.host.describe ? this.host.describe(value, exp, `w:${watchId}`).valueBag : describeFallback(value, exp, `w:${watchId}`).valueBag;
    this.host.emit({ type: 'watch', watchId, step, valueBag: bag });
  }

  watchError(watchId: string, step: number, error: string): void {
    this.host.emit({ type: 'watch', watchId, step, error });
  }

  /** One value's masked one-line text, for a break-when watch (no value id spent). */
  text(value: unknown, name: string): string {
    return this.describe(value, name).text;
  }

  // -- the uncaught pause of an exception whose frames are gone --------------------------------
  /**
   * An exception the worker could not call caught or uncaught at its sighting (it passed an async
   * frame, a library, a promise job) leaves a snapshot here: the raising frames' bindings and where
   * they stood. If it ends the run, `uncaughtPause` stops there, on the innermost
   * frame although it has returned.
   */
  private snapshots = new WeakMap<object, { meta: Record<string, any>; values: unknown[] }>();
  private reported = new WeakSet<object>();
  /** the snapshot the worker serves while an uncaught pause over returned frames is up */
  postmortem: { meta: Record<string, any>; values: unknown[] } | null = null;

  remember(exception: unknown, meta: Record<string, any>, values: unknown[]): void {
    if ((typeof exception === 'object' || typeof exception === 'function') && exception !== null) this.snapshots.set(exception, { meta, values });
  }

  /** this exception has had its `uncaught: true` pause already */
  markUncaught(exception: unknown): void {
    if ((typeof exception === 'object' || typeof exception === 'function') && exception !== null) this.reported.add(exception);
  }

  /** The run is ending on `err`: stop on the frame that raised it, from its snapshot. */
  uncaughtPause(err: unknown): void {
    if (this.finished || this.breakOnException === 'off' || this.trapping || this.serving) return;
    if ((typeof err !== 'object' && typeof err !== 'function') || err === null || this.reported.has(err)) return;
    const snap = this.snapshots.get(err);
    if (!snap) return;
    this.reported.add(err);
    this.postmortem = snap;
    this.candidate = { n: snap.meta.n, rid: snap.meta.rid, scope: snap.meta.scope, reason: 'postmortem', extra: {}, condition: null, watches: false, stepWatches: null };
    try {
      this.trap();
    } finally {
      this.candidate = null;
      this.postmortem = null;
    }
    const action = this.resumeAction;
    this.resumeAction = null;
    // the frames are gone: whatever the action, the run goes on to its end
    if (action) {
      this.afterResume({ action: 'continue' });
      this.pending = null;
      this.rearm();
    }
  }

  /** First sighting of a thrown object: the instrumenter's rethrows show the same object again. */
  private sighted = new WeakSet<object>();
  firstSighting(exception: unknown): boolean {
    if ((typeof exception !== 'object' && typeof exception !== 'function') || exception === null) return true;
    if (this.sighted.has(exception)) return false;
    this.sighted.add(exception);
    return true;
  }

  markModified(): void {
    this.modified = true;
  }

  /** The program has ended: nothing pauses from here; requests are served against the finished run. */
  markFinished(): void {
    this.finished = true;
    this.rearm();
  }

  currentStep(): number {
    return this.host.currentStep?.() ?? -1;
  }

  forward(req: Record<string, unknown>): boolean {
    if (!this.host.handleRequest) return false;
    this.host.handleRequest(req);
    return true;
  }

  /** The files as the worker needs them to name frames, from index `since` on. */
  filesSince(since: number): { fileId: number; path: string; library: boolean; lines: [number, number][] }[] {
    return this.host.files().slice(since).map((f) => ({ fileId: f.fileId, path: f.path, library: !!f.library, lines: [...f.lineRids] }));
  }
}
