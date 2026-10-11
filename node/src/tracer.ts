/**
 * The per-run recorder, living in the run child: coverage, trace steps and scopes, logs, timings,
 * returned values, exceptions. Its hooks are the `__tk` global the instrumented code calls (see
 * instrument.ts). Every hook catches its own failures and reports them once as a `system` log,
 * so a bug here never breaks the user's program.
 *
 * The trace itself (steps, scopes, the frame chain across awaits, recorded locals) is the
 * Recorder's (recorder/recorder.ts): its hooks are `s`, `c`, `f`, `x`, `ex`, `ap`, `aw`, and this
 * class reads its tables for logs, errors and coverage. Code that runs without a hook of its own
 * (a console write from a library callback, a timer) is attributed through the recorder's
 * AsyncLocalStorage store to the call that scheduled it (`attributedStep`).
 */
import { format } from 'node:util';
import { fileURLToPath } from 'node:url';
import { sourceColumn, type InstrumentedFile } from './instrument.ts';
import {
  COV_COVERED, COV_ERROR_PATH, COV_ERROR_SOURCE, COV_IGNORED, COV_NOT_RUN, COV_PARTIAL,
  FLAG_ERROR, FLAG_LOG, FLAG_UNWINDING,
  KIND_AUTO_EXPAND, KIND_TIME, KIND_TIME_AUTO_EXPAND,
  type Limits, type RunConfig,
} from './protocol.ts';
import { cutText, LOCALS_CHARS, LOG_CHARS, Registry, serialize, shortText, type ValueNode } from './serialize.ts';
import { secrets } from './secrets.ts';
import { Recorder, END, UNSET, NO_SCOPE, type LocalsGetter, type Scope } from './recorder/recorder.ts';
import type { ChainFrame } from './recorder/debugHooks.ts';

export { END, UNSET, type Scope };

export type Emit = (event: Record<string, any>) => void;

/** what a guarded declaration gets when its initializer threw: destructures to undefined */
const EMPTY: unknown = new Proxy(Object.create(null), {
  get: (_t, key) => (key === Symbol.iterator ? function* () {} : undefined),
});

/** `process.exit` in the run child throws this to stop the program; a guard must let it through */
export const EXIT = Symbol.for('tracelight.exit');
const isExit = (e: unknown) => !!e && typeof e === 'object' && (e as any)[EXIT] === true;

const TIME_FLUSH_MS = 250;
const SCAN_BACK = 5000;
const MAX_CAUGHT_GROUPS = 50;

export interface StackFrame {
  fileId: number;
  line: number;
  col: number;
  rid?: number;
  function: string;
  path: string;
}

interface CaughtGroup {
  errorType: string;
  message: string;
  rid: number;
  fileId: number;
  step: number;
  lastStep: number;
  count: number;
  stack: StackFrame[];
  handledAt?: { fileId: number; line: number; rid: number; function: string; broad: boolean };
}

export class Tracer {
  readonly config: RunConfig;
  readonly emit: Emit;
  readonly registry: Registry;
  readonly expressionsToEvaluate: Record<string, any>;
  files: InstrumentedFile[] = [];
  readonly byPath = new Map<string, InstrumentedFile>();
  rangeTotal = 0;
  /** the trace: steps, scopes, the frame chain, recorded locals */
  readonly rec: Recorder;
  // logs
  logSerial = 0;
  logCount = 0;
  readonly logHits = new Map<number, number>();
  readonly systemMessages = new Set<string>();
  consoleLimitHit = false;
  // timing
  readonly times = new Map<number, { n: number; total: number; min: number; max: number }>();
  timesDirty = false;
  lastTimeFlush = performance.now();
  // exceptions
  readonly seen = new WeakMap<object, { rid: number; step: number; stack: StackFrame[] | null }>();
  readonly caught = new Map<string, CaughtGroup>();
  readonly errorStates = new Map<number, number>();
  finished = false;
  readonly hooks: Record<string, any>;

  constructor(config: RunConfig, emit: Emit, opts: { registry?: Registry; expressionsToEvaluate?: Record<string, any> } = {}) {
    this.config = config;
    this.emit = emit;
    this.registry = opts.registry ?? new Registry();
    this.expressionsToEvaluate = opts.expressionsToEvaluate ?? {};
    this.rec = new Recorder(emit, { maxTraceSteps: config.maxTraceSteps, recordLocals: config.recordLocals, maxValueChars: config.maxValueChars });
    this.rec.onException = (err, sid) => this.sighting(err, sid);
    this.rec.onPeriodic = () => this.periodic();
    this.rec.onError = (e, where) => this.hookError(e, where);
    this.rec.defRidOf = (rid) => this.defRidOf(rid);
    this.hooks = this.makeHooks();
  }

  /** the recording members of `hooks`, while a debug hook set stands in for them (record: false, recordFrom) */
  private saved: Record<string, unknown> | null = null;

  /** A debug run that records nothing (yet): `set` replaces the matching members of `__tk`. */
  useDebugHooks(set: Record<string, unknown>): void {
    this.saved = {};
    for (const k of Object.keys(set)) this.saved[k] = this.hooks[k];
    Object.assign(this.hooks, set);
  }

  /**
   * recordFrom: the recording starts at this pause (docs/PROTOCOL.md "A debug run that records
   * from a pause"). The paused statement `rid` of frame `scope` (a debug-hook id, or 0) becomes
   * step 0; the recording hooks go back in. Returns the paused frame's recorded scope.
   */
  startRecording(chain: { frames: ChainFrame[]; module?: { getter: LocalsGetter; rid: number } }, rid: number, scope: number): number {
    const entry = this.files.some((f) => f.functionNames.has(rid)) && chain.frames.length > 0 && chain.frames[chain.frames.length - 1]!.id === scope && chain.frames[chain.frames.length - 1]!.rid === rid;
    const baselines: { id: number; rid: number; getter: LocalsGetter }[] = [];
    if (chain.module) baselines.push({ id: 0, rid: chain.module.rid, getter: chain.module.getter });
    for (const f of chain.frames) if (f.getter && !(entry && f.id === scope)) baselines.push({ id: f.id, rid: f.getterRid!, getter: f.getter });
    const top = this.rec.startMidRun(chain.frames, rid, scope, entry, baselines);
    if (this.saved) Object.assign(this.hooks, this.saved, this.rec.midRunHooks());
    this.saved = null;
    this.lastTimeFlush = performance.now();
    return top;
  }

  /** the header rid of the function (or module body) statement `rid` belongs to: its innermost enclosing function */
  defRidOf(rid: number): number {
    const info = this.fileForRid(rid);
    if (!info) return 0;
    const line = info.ranges[rid - info.rangeBase]?.[0] ?? 0;
    let best: { span: number; rid: number } | null = null;
    let module = 0;
    for (const f of info.functions) {
      if (f.name === '<module>') {
        module = info.rangeBase + f.rid;
        continue;
      }
      const b = f.bodyRange;
      if (b[0] <= line && line <= b[2] && (!best || b[2] - b[0] < best.span)) best = { span: b[2] - b[0], rid: info.rangeBase + f.rid };
    }
    return best ? best.rid : module;
  }

  // the recorder's tables, read by logs, errors and coverage
  get hits(): Int32Array {
    return this.rec.hits;
  }
  get steps(): Int32Array {
    return this.rec.buffer;
  }
  get nSteps(): number {
    return this.rec.n;
  }
  get cap(): number {
    return this.rec.cap;
  }
  get curStep(): number {
    return this.rec.curStep;
  }
  get curScope(): number {
    return this.rec.cur;
  }
  get scopes(): Scope[] {
    return this.rec.scopes;
  }
  get scopeLast(): number[] {
    return this.rec.lastOf;
  }
  get quiet(): number {
    return this.rec.quiet;
  }
  set quiet(n: number) {
    this.rec.quiet = n;
  }

  /** the step code without a hook of its own belongs to: the running frame's, or the scheduling call's in a callback */
  attributedStep(): number {
    return this.rec.attribution().step;
  }

  // -- files -------------------------------------------------------------------------------
  nextRangeBase(): number {
    return this.rangeTotal;
  }

  addFile(info: InstrumentedFile): void {
    this.files.push(info);
    this.byPath.set(info.filename, info);
    this.rec.addFile(info);
    this.rangeTotal = Math.max(this.rangeTotal, info.rangeBase + info.rangeCount);
  }

  fileForRid(rid: number): InstrumentedFile | undefined {
    let found: InstrumentedFile | undefined;
    for (const f of this.files) if (f.rangeBase <= rid && (!found || f.rangeBase >= found.rangeBase)) found = f;
    return found;
  }

  fileIdFor(rid: number): number {
    return this.fileForRid(rid)?.fileId ?? 0;
  }

  ridAt(info: InstrumentedFile, line: number): number {
    const r = info.lineRids.get(line);
    if (r !== undefined) return r;
    let best: [number, number] | undefined;
    for (const [l, rid] of info.lineRids) if (l <= line && (!best || l > best[0])) best = [l, rid];
    return best ? best[1] : info.rangeBase;
  }

  stepFor(rid: number): number {
    const n = this.curStep;
    const s = this.steps;
    if (this.nSteps === 0) return 0;
    if (s[n * 4] === rid) return n;
    for (let i = n - 1, lo = Math.max(0, n - SCAN_BACK); i >= lo; i--) if (s[i * 4] === rid) return i;
    return n;
  }

  flagStep(idx: number, flag: number): void {
    this.rec.flag(idx, flag);
  }

  // -- hooks ---------------------------------------------------------------------------------
  makeHooks(): Record<string, any> {
    const t = this;
    return {
      ...t.rec.hooks(),
      now: () => performance.now(),
      // JSX (automatic runtime, lower.ts): a `key` prop goes to the runtime's third argument
      jsx(f: (t: unknown, p: unknown, k?: unknown) => unknown, type: unknown, props: Record<string, unknown>): unknown {
        if (props && Object.prototype.hasOwnProperty.call(props, 'key')) {
          const { key, ...rest } = props;
          return f(type, rest, key);
        }
        return f(type, props);
      },
      // snaps mode: a guarded statement's error is reported and the run goes on
      se(err: unknown, rid: number): void {
        if (isExit(err)) throw err;
        try {
          t.snapError(err, rid);
        } catch (e) {
          t.hookError(e, 'snap');
        }
      },
      g(fn: () => unknown, rid: number, pattern?: number): unknown {
        try {
          return t.destructurable(fn(), rid, pattern);
        } catch (err) {
          t.hooks.se(err, rid);
          return pattern ? EMPTY : undefined;
        }
      },
      async ga(fn: () => Promise<unknown>, rid: number, pattern?: number): Promise<unknown> {
        try {
          return t.destructurable(await fn(), rid, pattern);
        } catch (err) {
          t.hooks.se(err, rid);
          return pattern ? EMPTY : undefined;
        }
      },
      // a library module body (libraryCode): quiet from here to qx, and while its top-level awaits are pending, loud
      qf(rid: number): number {
        t.hits[rid]!++;
        t.quiet++;
        return NO_SCOPE;
      },
      qx(): void {
        if (t.quiet > 0) t.quiet--;
      },
      qs(v: unknown): unknown {
        if (t.quiet > 0) t.quiet--;
        return v;
      },
      qr(v: unknown): unknown {
        t.quiet++;
        return v;
      },
      h(tryRid: number, err: unknown, broad?: boolean, line?: number, scope?: number): void {
        if (t.quiet) return;
        try {
          t.handled(tryRid, err, broad !== false, line, scope);
        } catch (e) {
          t.hookError(e, 'handler');
        }
      },
      v(rid: number, ctx: string, value: unknown, kind: string, markerId: string | null, changeId: string | null, fn?: (v: unknown) => unknown): unknown {
        try {
          t.logValue(rid, ctx, value, kind, markerId, changeId, fn);
        } catch (e) {
          t.hookError(e, 'value');
        }
        return value;
      },
      t(rid: number, ctx: string, t0: number, value: unknown, kind: string, markerId: string | null, changeId: string | null): unknown {
        try {
          t.logTime(rid, ctx, t0, value, kind, markerId, changeId);
        } catch (e) {
          t.hookError(e, 'time');
        }
        return value;
      },
      log(rid: number, method: string, ...args: unknown[]): void {
        try {
          t.logConsole(rid, method, args);
        } catch (e) {
          t.hookError(e, 'console');
        }
      },
      lp(rid: number, kind: string, template: string, ctx: string | null, markerId: string | null, changeId: string | null, isExpr: boolean, evaluate: (code: string) => unknown): void {
        try {
          t.logPoint(rid, kind, template, ctx, markerId, changeId, isExpr, evaluate);
        } catch (e) {
          t.hookError(e, 'logpoint');
        }
      },
    };
  }

  valueChars(dflt: number): number {
    const m = this.config.maxValueChars;
    if (m === null || m === undefined) return dflt;
    return m === 0 ? 1_000_000 : m;
  }

  // -- logs ----------------------------------------------------------------------------------
  limitsFor(kind: string): Limits {
    return kind === KIND_AUTO_EXPAND || kind === KIND_TIME_AUTO_EXPAND ? this.config.autoExpand : this.config.inline;
  }

  bag(value: unknown, runtimeKey: string, hit: number, kind: string, context: string | null): { data: ValueNode; runtimeKey: string } {
    const limits = this.limitsFor(kind);
    const tree = this.expressionsToEvaluate[runtimeKey] ?? null;
    this.quiet++;
    try {
      let node = serialize(value, limits, { rootKey: runtimeKey, hit, registry: this.registry, expressionRoot: context, expandTree: tree });
      const budget = this.config.maxLogEntrySize;
      if (budget) {
        let depth = limits.depth;
        let elements = limits.elements;
        while (JSON.stringify(node).length > budget && depth > 0) {
          depth = depth > 1 ? depth - 1 : 0;
          elements = Math.max(8, elements >> 2);
          node = serialize(value, { depth, elements, stringLength: Math.min(limits.stringLength, budget >> 1) }, { rootKey: runtimeKey, hit, registry: this.registry, expressionRoot: context });
        }
      }
      return { data: node, runtimeKey };
    } finally {
      this.quiet--;
    }
  }

  logAllowed(rid: number): number | null {
    const hit = (this.logHits.get(rid) ?? 0) + 1;
    this.logHits.set(rid, hit);
    const limit = this.config.logLimit;
    if (limit && hit > limit) {
      if (hit === limit + 1) this.systemLog(rid, `log limit (${limit}) reached for this line; further values are not shown`);
      return null;
    }
    if (this.config.maxConsoleMessages && this.logCount >= this.config.maxConsoleMessages) {
      if (!this.consoleLimitHit) {
        this.consoleLimitHit = true;
        this.systemLog(rid, `maximum of ${this.config.maxConsoleMessages} messages reached; further values are not shown`, true);
      }
      return null;
    }
    return hit;
  }

  emitLog(rid: number, kind: string, text: string, extra: Record<string, any> = {}): void {
    const step = this.atStepOverride ?? this.attributedStep();
    const event: Record<string, any> = { type: 'log', logId: `l-${++this.logSerial}`, kind, fileId: this.fileIdFor(rid), rid, hit: extra.hit ?? 1, step, text, runtimeKey: extra.runtimeKey ?? String(rid) };
    for (const k of ['context', 'changeId', 'markerId', 'valueBag', 'time', 'truncated', 'length']) {
      if (extra[k] !== undefined && extra[k] !== null) event[k] = extra[k];
    }
    this.logCount++;
    this.flagStep(step, FLAG_LOG);
    this.emit(event);
  }

  systemLog(rid: number, text: string, force = false): void {
    if (!force && this.systemMessages.has(text)) return;
    this.systemMessages.add(text);
    this.emit({ type: 'log', logId: `l-${++this.logSerial}`, kind: 'system', fileId: this.fileIdFor(rid), rid, hit: 1, step: this.atStepOverride ?? this.attributedStep(), text, runtimeKey: String(rid) });
  }

  hookError(e: unknown, where: string): void {
    const msg = `tracelight hook failed in ${where}: ${errorType(e)}: ${(e as Error)?.message ?? e}`;
    if (this.systemMessages.has(msg)) return;
    this.systemMessages.add(msg);
    this.emit({ type: 'runner.error', message: msg });
  }

  valueText(value: unknown, kind: string): { text: string; truncated?: boolean; length?: number } {
    this.quiet++;
    try {
      return cutText(shortText(value, 1_000_000), this.valueChars(LOG_CHARS));
    } finally {
      this.quiet--;
    }
  }

  logValue(rid: number, ctx: string | null, value: unknown, kind: string, markerId: string | null, changeId: string | null, fn?: (v: unknown) => unknown, runtimeKey?: string): void {
    if (fn) {
      let out: unknown;
      try {
        out = fn(value);
      } catch (e) {
        this.errorValue(rid, ctx, e, markerId, changeId);
        return;
      }
      value = out;
    }
    if (isThenable(value)) {
      const step = this.attributedStep();
      (value as Promise<unknown>).then(
        (v) => this.atStep(step, () => this.logObject(rid, ctx, v, kind, markerId, changeId, runtimeKey)),
        (e) => this.atStep(step, () => this.errorValue(rid, ctx, e, markerId, changeId)),
      );
      return;
    }
    this.logObject(rid, ctx, value, kind, markerId, changeId, runtimeKey);
  }

  /** while a settled promise's value is logged: the step that produced the promise */
  atStepOverride: number | null = null;

  atStep(step: number, fn: () => void): void {
    const saved = this.atStepOverride;
    this.atStepOverride = step;
    try {
      fn();
    } finally {
      this.atStepOverride = saved;
    }
  }

  logObject(rid: number, ctx: string | null, value: unknown, kind: string, markerId: string | null, changeId: string | null, runtimeKey?: string): void {
    const hit = this.logAllowed(rid);
    if (hit === null) return;
    const key = runtimeKey ?? String(rid);
    const valueBag = this.bag(value, key, hit, kind, ctx);
    const cut = this.valueText(value, kind);
    const text = secrets.isSecretName(lastName(ctx)) && typeof value === 'string' ? '••••••••' : cut.text;
    this.emitLog(rid, kind === 'autoLog' ? 'autoLog' : kind, text, { hit, context: ctx, runtimeKey: key, valueBag, markerId, changeId, truncated: cut.truncated, length: cut.length });
  }

  errorValue(rid: number, ctx: string | null, e: unknown, markerId: string | null, changeId: string | null): void {
    const hit = this.logAllowed(rid);
    if (hit === null) return;
    const text = `${errorType(e)}: ${secrets.scrub(String((e as Error)?.message ?? e))}`;
    this.emitLog(rid, 'error', text, { hit, context: ctx, valueBag: this.bag(e, String(rid), hit, 'value', ctx), markerId, changeId });
  }

  logTime(rid: number, ctx: string | null, t0: number, value: unknown, kind: string, markerId: string | null, changeId: string | null): void {
    const done = (v: unknown) => {
      const ms = performance.now() - t0;
      const agg = this.times.get(rid) ?? { n: 0, total: 0, min: Infinity, max: 0 };
      agg.n++;
      agg.total += ms;
      agg.min = Math.min(agg.min, ms);
      agg.max = Math.max(agg.max, ms);
      this.times.set(rid, agg);
      this.timesDirty = true;
      const hit = this.logAllowed(rid);
      if (hit === null) return;
      const key = `t:${rid}`;
      const text = `${formatMs(ms)}`;
      const valueKind = kind === KIND_TIME_AUTO_EXPAND ? KIND_AUTO_EXPAND : 'value';
      this.emitLog(rid, KIND_TIME, text, { hit, context: ctx, runtimeKey: key, valueBag: this.bag(v, key, hit, valueKind, ctx), markerId, changeId, time: { ms, n: agg.n, total: agg.total, min: agg.min, max: agg.max } });
    };
    if (isThenable(value)) {
      const step = this.attributedStep();
      (value as Promise<unknown>).then((v) => this.atStep(step, () => done(v)), (e) => this.atStep(step, () => this.errorValue(rid, ctx, e, markerId, changeId)));
    } else done(value);
  }

  logConsole(rid: number, method: string, args: unknown[]): void {
    const hit = this.logAllowed(rid);
    if (hit === null) return;
    this.quiet++;
    let text: string;
    try {
      text = secrets.scrub(format(...args)).replace(/\r\n/g, '\n').replace(/\n/g, '\\n');
    } finally {
      this.quiet--;
    }
    const shown = args.length === 1 ? args[0] : args.length === 0 ? '' : args;
    const valueBag = this.bag(shown, String(rid), hit, 'value', null);
    const cut = cutText(text, this.valueChars(LOG_CHARS));
    const stderr = method === 'error' || method === 'warn' || method === 'trace';
    this.emitLog(rid, 'log', cut.text, { hit, context: stderr ? 'stderr' : undefined, valueBag, truncated: cut.truncated, length: cut.length });
  }

  logPoint(rid: number, kind: string, template: string, ctx: string | null, markerId: string | null, changeId: string | null, isExpr: boolean, evaluate: (code: string) => unknown): void {
    if (isExpr) {
      let value: unknown;
      try {
        value = evaluate(template);
      } catch (e) {
        this.errorValue(rid, ctx ?? template, e, markerId, changeId);
        return;
      }
      this.logValue(rid, ctx ?? template, value, kind, markerId, changeId);
      return;
    }
    // `{expr}` interpolations; `{{` and `}}` are literal braces
    const parts: string[] = [];
    let failed: unknown = null;
    const re = /\{\{|\}\}|\{([^{}]+)\}/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(template))) {
      parts.push(template.slice(last, m.index));
      last = m.index + m[0].length;
      if (m[0] === '{{') parts.push('{');
      else if (m[0] === '}}') parts.push('}');
      else {
        try {
          const v = evaluate(m[1]!);
          parts.push(typeof v === 'string' ? v : shortText(v));
        } catch (e) {
          failed = e;
          parts.push(`<${errorType(e)}>`);
        }
      }
    }
    parts.push(template.slice(last));
    if (failed) {
      this.errorValue(rid, ctx ?? template, failed, markerId, changeId);
      return;
    }
    const hit = this.logAllowed(rid);
    if (hit === null) return;
    const text = secrets.scrub(parts.join(''));
    this.emitLog(rid, 'logpoint', text, { hit, context: ctx, markerId, changeId, valueBag: this.bag(text, String(rid), hit, 'value', ctx) });
  }

  // -- exceptions ------------------------------------------------------------------------------
  /** the first time an exception object is seen leaving a frame: where it was raised */
  sighting(err: unknown, sid: number): void {
    const key = asKey(err);
    let step = this.scopeLast[sid] ?? this.curStep;
    if (key && this.seen.has(key)) {
      this.flagStep(this.raisedStep(err, sid, step, undefined, true), FLAG_UNWINDING);
      return;
    }
    step = this.raisedStep(err, sid, step);
    const rid = this.steps[step * 4] ?? 0;
    this.flagStep(step, FLAG_ERROR);
    if (key) this.seen.set(key, { rid, step, stack: null });
  }

  /**
   * The step an exception raised in frame `sid` belongs to: the frame's last step, unless the raising
   * statement is an earlier one of the same frame that ran again without a step. That is a loop
   * header failing after its body (`for (const [a] of xs)` on a `null` item, a throwing iterator, a
   * `while` test): its step comes at the top of the body, after the header's work, so Pyokka's
   * step on the `for` line before each `next()` is added here, and the error names it. A frame the
   * error only passes through (`unwinding`) is matched against every frame of the stack, so a
   * `for (const v of gen())` whose generator threw unwinds from its `for` line too.
   */
  private raisedStep(err: unknown, sid: number, last: number, stack?: StackFrame[], unwinding = false): number {
    if (sid < 0 || last < 0 || last >= this.nSteps || last >= this.cap) return last;
    const s = this.steps;
    if (s[last * 4 + 1] !== sid) return last;
    const user = (stack ?? this.cachedStack(err)).filter((f) => f.fileId !== 0 && f.rid !== undefined);
    const rids = new Set((unwinding ? user : user.slice(0, 1)).map((f) => f.rid!));
    if (rids.size === 0 || rids.has(s[last * 4]!)) return last;
    for (let i = last - 1, lo = Math.max(0, last - SCAN_BACK); i >= lo; i--) {
      const rid = s[i * 4]!;
      if (s[i * 4 + 1] !== sid || !rids.has(rid)) continue;
      this.rec.s(rid, sid);
      return this.curStep;
    }
    return last;
  }

  /** the statement at a stack frame's line and column: the narrowest instrumented span holding it (a loop's header and a one-line body are two) */
  private ridAtColumn(info: InstrumentedFile, line: number, col: number, fallback: number): number {
    let best = fallback;
    let width = Infinity;
    info.ranges.forEach(([l1, c1, l2, c2], i) => {
      if (i === 0 || line < l1 || line > l2 || (line === l1 && col < c1) || (line === l2 && col > c2)) return;
      const w = (l2 - l1) * 1e6 + (c2 - c1);
      if (w < width) {
        width = w;
        best = info.rangeBase + i;
      }
    });
    return best;
  }

  /** `stackOf` of the exception being unwound, parsed once for all the frames it leaves */
  private lastStack: { err: unknown; stack: StackFrame[] } | null = null;
  private cachedStack(err: unknown): StackFrame[] {
    if (this.lastStack?.err !== err) this.lastStack = { err, stack: this.stackOf(err) };
    return this.lastStack.stack;
  }

  handled(tryRid: number, err: unknown, broad: boolean, line?: number, sid?: number): void {
    const key = asKey(err);
    let origin = key ? this.seen.get(key) : undefined;
    // the frame whose catch this is (a catch after a rejected await runs before any step of the resumed frame)
    const here = sid !== undefined && sid >= 0 && sid < this.scopes.length ? sid : this.curScope;
    if (!origin) {
      // raised in this frame (or by code that is not instrumented): the statement that was running
      const step = this.raisedStep(err, here, this.scopeLast[here] ?? this.curStep);
      origin = { rid: this.steps[step * 4] ?? tryRid, step, stack: null };
      this.flagStep(step, FLAG_ERROR);
      if (key) this.seen.set(key, origin);
    }
    const type = errorType(err);
    const group = `${type}|${origin.rid}|${tryRid}`;
    const g = this.caught.get(group);
    if (g) {
      g.count++;
      g.lastStep = origin.step;
      return;
    }
    if (this.caught.size >= MAX_CAUGHT_GROUPS) return;
    const info = this.fileForRid(tryRid);
    const range = info?.ranges[tryRid - (info?.rangeBase ?? 0)];
    const scope = this.scopes[here];
    this.caught.set(group, {
      errorType: type,
      message: secrets.scrub(String((err as Error)?.message ?? err)),
      rid: origin.rid,
      fileId: this.fileIdFor(origin.rid),
      step: origin.step,
      lastStep: origin.step,
      count: 1,
      stack: this.stackOf(err),
      handledAt: info && range ? { fileId: info.fileId, line: line ?? range[0], rid: tryRid, function: scope?.name ?? '<module>', broad } : undefined,
    });
  }

  private colMaps = new WeakMap<InstrumentedFile, Map<number, number[]>>();
  colMapOf(info: InstrumentedFile): Map<number, number[]> {
    let m = this.colMaps.get(info);
    if (!m) this.colMaps.set(info, (m = new Map(info.colMap)));
    return m;
  }

  /** `err.stack` text with the columns of library files (no source map) mapped back */
  stackText(stack: string): string {
    return stack.replace(/(\(|at )((?:file:\/\/)?\/[^\s()]*?):(\d+):(\d+)(\)?)$/gm, (all, pre, p, l, c, post) => {
      let path = p;
      if (path.startsWith('file://')) {
        try {
          path = fileURLToPath(path);
        } catch {
          return all;
        }
      }
      const info = this.byPath.get(path);
      if (!info?.colMap) return all;
      return `${pre}${p}:${l}:${sourceColumn(this.colMapOf(info), Number(l), Number(c) - 1) + 1}${post}`;
    });
  }

  /** frames of `err.stack` (already source-mapped by Node), innermost first */
  stackOf(err: unknown): StackFrame[] {
    const stack = typeof (err as Error)?.stack === 'string' ? (err as Error).stack! : '';
    const out: StackFrame[] = [];
    for (const raw of stack.split('\n')) {
      const m = /^\s+at (?:(.*?) \()?(.*?):(\d+):(\d+)\)?$/.exec(raw);
      if (!m) continue;
      let path = m[2]!;
      if (path.startsWith('async ')) path = path.slice(6);
      if (path.startsWith('file://')) {
        try {
          path = fileURLToPath(path);
        } catch {
          /* keep */
        }
      }
      if (path.startsWith('node:') || path.includes('/tracelight/src/') || path.includes('/node/src/')) continue;
      const info = this.byPath.get(path);
      const line = Number(m[3]);
      const col = info?.colMap ? sourceColumn(this.colMapOf(info), line, Number(m[4]) - 1) : Number(m[4]) - 1;
      let name = (m[1] ?? '').replace(/^async /, '');
      if (!name || name === '<anonymous>' || name === 'Object.<anonymous>') {
        // (a CommonJS module body is `Object.<anonymous>` in V8's stacks)
        // top-level code: a line inside no function of the file
        const inFn = info?.functions.some((f) => f.name !== '<module>' && f.bodyRange[0] <= line && line <= f.bodyRange[2]);
        name = info && !inFn ? '<module>' : !name || name === 'Object.<anonymous>' ? '<anonymous>' : name;
      }
      const frame: StackFrame = { fileId: info?.fileId ?? 0, line, col, function: name, path };
      if (info) frame.rid = this.ridAtColumn(info, line, col, this.ridAt(info, line));
      out.push(frame);
      if (out.length >= 64) break;
    }
    return out;
  }

  /** the `error` event for the exception that ended the run (also marks the coverage error path) */
  /** a guarded `const {a} = v` with a nullish `v`: the TypeError is the statement's, reported here */
  destructurable(v: unknown, rid: number, pattern?: number): unknown {
    if (!pattern || v != null) return v;
    this.hooks.se(new TypeError(`Cannot destructure '${v}' as it is ${v === null ? 'null' : 'undefined'}.`), rid);
    return EMPTY;
  }

  snapError(err: unknown, rid: number): void {
    const event = this.reportUncaught(err);
    if (!event.rid) {
      this.errorStates.set(rid, COV_ERROR_SOURCE);
      event.rid = rid;
    }
  }

  reportUncaught(err: unknown, stepNow?: number): Record<string, any> {
    const stack = this.stackOf(err);
    const user = stack.filter((f) => f.fileId !== 0);
    const top = user[0];
    const rid = top?.rid ?? 0;
    let step = stepNow ?? (top ? this.stepFor(rid) : this.curStep);
    // (only in the frame running now: a found step of a frame that has returned is a guess already)
    if (stepNow === undefined && top && step !== this.curStep && step < this.nSteps && this.steps[step * 4 + 1] === this.steps[this.curStep * 4 + 1]) {
      step = this.raisedStep(err, this.steps[step * 4 + 1]!, this.curStep, stack);
    }
    if (top) {
      this.errorStates.set(rid, COV_ERROR_SOURCE);
      this.flagStep(step, FLAG_ERROR);
      for (const f of user.slice(1)) if (f.rid !== undefined && this.errorStates.get(f.rid) !== COV_ERROR_SOURCE) this.errorStates.set(f.rid, COV_ERROR_PATH);
    }
    const message = secrets.scrub(String((err as Error)?.message ?? err));
    const tb = secrets.scrub(typeof (err as Error)?.stack === 'string' ? this.stackText((err as Error).stack!) : `${errorType(err)}: ${message}`);
    const event = { type: 'error', fileId: top?.fileId ?? 0, rid, step, message, errorType: errorType(err), stack, handled: false, traceback: tb.slice(-4000) };
    this.emit(event);
    return event;
  }

  syntaxError(info: InstrumentedFile): void {
    this.emit({ type: 'error', fileId: info.fileId, rid: info.rangeBase, step: 0, message: (info.error ?? '').replace(/^\w+: /, ''), errorType: (info.error ?? 'SyntaxError').split(':')[0], stack: info.errorLine ? [{ fileId: info.fileId, line: info.errorLine, col: 0, function: '<module>', path: info.filename }] : [], handled: false });
  }

  // -- periodic flushes and the end of the run ---------------------------------------------------
  /** timings, about every 1024 steps (the recorder flushes the partial trace itself) */
  periodic(): void {
    const now = performance.now();
    if (this.timesDirty && now - this.lastTimeFlush > TIME_FLUSH_MS) this.emitTimes();
  }

  emitTimes(): void {
    this.lastTimeFlush = performance.now();
    this.timesDirty = false;
    for (const [rid, a] of this.times) this.emit({ type: 'time', rid, n: a.n, total: a.total, min: a.min, max: a.max });
  }

  /** a partial `trace` delta: the steps since the last one and the scopes created since then */
  flushTrace(): void {
    this.rec.flushPartial();
  }

  coverageStates(info: InstrumentedFile): { states: number[]; hits: number[] } {
    const n = info.rangeCount;
    const base = info.rangeBase;
    const hits = Array.from(this.hits.subarray(base, base + n));
    const states = new Array<number>(n).fill(COV_NOT_RUN);
    for (let local = 0; local < n; local++) {
      if (info.ignoreFile || info.ignored.has(local)) {
        states[local] = COV_IGNORED;
        continue;
      }
      if (!hits[local]) continue;
      let state = COV_COVERED;
      for (const c of info.exprChildren.get(local) ?? []) {
        if (!hits[c]) {
          state = COV_PARTIAL;
          break;
        }
      }
      states[local] = state;
    }
    for (const [rid, st] of this.errorStates) {
      const local = rid - base;
      if (local >= 0 && local < n && states[local] !== COV_IGNORED) states[local] = st;
    }
    return { states, hits };
  }

  caughtEvents(): Record<string, any>[] {
    return [...this.caught.values()].map((g) => ({ type: 'error', fileId: g.fileId, rid: g.rid, step: g.step, message: g.message, errorType: g.errorType, stack: g.stack, handled: true, ...(g.handledAt ? { handledAt: g.handledAt } : {}), count: g.count, lastStep: g.lastStep }));
  }

  /** The end of a debug run that recorded nothing: the uncaught exception alone, at the statement counter. */
  finishUnrecorded(uncaught: unknown, hasUncaught: boolean, stepNow: number): void {
    if (this.finished) return;
    this.finished = true;
    if (hasUncaught) this.reportUncaught(uncaught, stepNow);
  }

  finish(uncaught?: unknown, hasUncaught = false): void {
    if (this.finished) return;
    this.finished = true;
    if (hasUncaught) this.reportUncaught(uncaught);
    for (const e of this.caughtEvents()) this.emit(e);
    for (const info of this.files) {
      if (info.error && !info.code) continue;
      const { states, hits } = this.coverageStates(info);
      this.emit({ type: 'coverage', fileId: info.fileId, states, hits });
    }
    if (this.times.size) this.emitTimes();
    this.rec.finish();
  }
}

function isThenable(v: unknown): boolean {
  return v !== null && (typeof v === 'object' || typeof v === 'function') && typeof (v as any).then === 'function' && v instanceof Promise;
}

function asKey(err: unknown): object | null {
  return err !== null && (typeof err === 'object' || typeof err === 'function') ? (err as object) : null;
}

export function errorType(e: unknown): string {
  if (e instanceof Error) return e.name || e.constructor?.name || 'Error';
  if (e === null) return 'null';
  if (typeof e === 'object') return (e as any)?.constructor?.name ?? 'Object';
  return typeof e;
}

function lastName(ctx: string | null): string {
  if (!ctx) return '';
  return ctx.replace(/[\])'" ]+$/, '').split(/[.[]/).pop()?.replace(/['"]/g, '') ?? '';
}

function formatMs(ms: number): string {
  return ms < 1 ? `${ms.toFixed(3)}ms` : ms < 1000 ? `${ms.toFixed(2)}ms` : `${(ms / 1000).toFixed(2)}s`;
}
