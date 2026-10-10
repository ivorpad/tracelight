/**
 * The hook set of a debug run that records nothing (`config.record: false`, the Debugger), and of
 * a `recordFrom` run until its recording starts (docs/PROTOCOL.md "A debug run without a
 * recording", "A debug run that records from a pause").
 *
 * The instrumented code is the same as a recording run's; only the `__tk` members differ. Per
 * statement `s` increments one counter and reads the debugger's `armed`; only while a reason is
 * armed does it look further (the breakpoint index, or a reason other than a breakpoint), and only
 * then does it call into the debugger. No step buffer, no scope table, no clock read.
 *
 * Step Over and Step Out need to know which frame is which, so `f` hands out a per-call id from a
 * counter and keeps a shadow stack of the instrumented frames now on the JS stack (`ap` / `aw`
 * take a suspended frame off and put it back, as the recorder does). When the frame a step waits
 * on returns (`x`), the step goes on in the frame that called it: the one under it on the shadow
 * stack, the module when module code made the call, else (a callback the event loop ran) the next
 * statement wherever it runs.
 *
 * A `recordFrom` run uses the same set with three additions: its ids start at FOREIGN, so the
 * recording can tell them from its own; statement hits are counted from the start (coverage over
 * the whole run); and under recordLocals each frame's latest locals getter is kept, so the switch
 * can take a silent baseline of every frame on the stack (`chain()`).
 */
import type { Debugger } from '../debug/debugger.ts';
import { FOREIGN, type LocalsGetter, type Recorder } from './recorder.ts';

export { FOREIGN };

export interface DebugHooksOptions {
  /** a `recordFrom` run: ids from FOREIGN, hits counted, suspended frames' rids kept */
  recordFrom?: boolean;
  /** recordFrom with recordLocals: keep each frame's latest locals getter */
  locals?: boolean;
}

/** One instrumented frame on the stack at the switch, outermost first. */
export interface ChainFrame {
  /** the per-call id the frame's `_tk_scope_` holds */
  id: number;
  /** the rid `f` was called with: the function's (or module body's) header */
  rid: number;
  /** recordLocals: the getter of the frame's latest statement, and that statement's rid */
  getter?: LocalsGetter;
  getterRid?: number;
}

export interface DebugHooks {
  /** the `__tk` members this set replaces */
  hooks: Record<string, unknown>;
  /** statements (and function entries) executed so far: `run.finished.stepCount` */
  count(): number;
  /** the instrumented frames on the JS stack now, outermost first, and the module's getter */
  chain(): { frames: ChainFrame[]; module?: { getter: LocalsGetter; rid: number } };
}

export function debugHooks(dbg: Debugger, rec: Recorder, options: DebugHooksOptions = {}): DebugHooks {
  const from = !!options.recordFrom;
  const stash = from && !!options.locals;
  let n = 0;
  let nextId = from ? FOREIGN : 1;
  /** the scope of the code running now, as far as a caller goes: 0 module code, -1 the event loop */
  let last = 0;
  // the shadow stack: per-call id, header rid, the caller's id (-1: the event loop)
  const ids: number[] = [];
  const rids: number[] = [];
  const pars: number[] = [];
  let sp = 0;
  // recordLocals in a recordFrom run: each slot's latest getter and its statement's rid
  const getters: (LocalsGetter | undefined)[] = [];
  const getterRids: number[] = [];
  let modGetter: LocalsGetter | undefined;
  let modRid = -1;
  // recordFrom: the header rid of each suspended frame, for when it resumes onto the stack
  const suspended = from ? new Map<number, number>() : null;

  // microtasks run only once the JS stack has unwound: nothing of ours is under the next callback
  let sweepQueued = false;
  const sweep = (): void => {
    sweepQueued = false;
    sp = 0;
    last = -1;
  };

  const callerNow = (): number => (sp > 0 ? ids[sp - 1]! : last === 0 ? 0 : -1);

  const push = (id: number, rid: number): void => {
    if (sp === 0 && !sweepQueued) {
      sweepQueued = true;
      queueMicrotask(sweep);
    }
    pars[sp] = callerNow();
    ids[sp] = id;
    rids[sp] = rid;
    if (stash) getters[sp] = undefined;
    sp++;
  };

  /** `sid` leaves the stack; the slot it held, or -1 */
  const pop = (sid: number): number => {
    let i = sp - 1;
    while (i >= 0 && ids[i] !== sid) i--;
    if (i < 0) return -1;
    sp = i;
    last = pars[i]!;
    return i;
  };

  const trap = (k: number, rid: number, scope: number): void => {
    if (dbg.other || dbg.byRid.has(rid)) dbg.onStep(k, rid, scope);
  };

  let s: (rid: number, scope: number, locals?: LocalsGetter) => void;
  if (!from) {
    s = (rid, scope) => {
      const k = n++;
      last = scope;
      if (dbg.armed && scope >= 0) trap(k, rid, scope);
    };
  } else if (!stash) {
    s = (rid, scope) => {
      rec.hits[rid]!++;
      const k = n++;
      last = scope;
      if (dbg.armed && scope >= 0) trap(k, rid, scope);
    };
  } else {
    s = (rid, scope, locals) => {
      rec.hits[rid]!++;
      const k = n++;
      last = scope;
      if (scope === 0) {
        modGetter = locals;
        modRid = rid;
      } else if (sp > 0 && ids[sp - 1] === scope) {
        getters[sp - 1] = locals;
        getterRids[sp - 1] = rid;
      }
      if (dbg.armed && scope >= 0) trap(k, rid, scope);
    };
  }

  const f = (rid: number): number => {
    if (from) rec.hits[rid]!++;
    const id = nextId++;
    push(id, rid);
    const k = n++;
    last = id;
    if (dbg.armed) trap(k, rid, id);
    return id;
  };

  const x = (sid: number): void => {
    if (sid < 0) return;
    const i = sid === ids[sp - 1] ? sp - 1 : -2;
    let parent: number;
    if (i >= 0) {
      sp = i;
      last = parent = pars[i]!;
    } else {
      parent = pop(sid) >= 0 ? last : -1;
    }
    if (suspended !== null) suspended.delete(sid);
    if (sid === dbg.pendingSid) dbg.onLeave(sid, parent);
  };

  const ap = <T>(sid: number, value: T): T => {
    if (sid > 0) {
      const i = pop(sid);
      if (i >= 0 && suspended !== null) suspended.set(sid, rids[i]!);
    } else if (sid === 0) last = -1;
    return value;
  };

  const aw = <T>(sid: number, value: T): T => {
    if (sid > 0) {
      let rid = -1;
      if (suspended !== null) {
        rid = suspended.get(sid) ?? -1;
        suspended.delete(sid);
      }
      push(sid, rid);
      last = sid;
    } else if (sid === 0) last = 0;
    return value;
  };

  const c = from
    ? (rid: number): void => {
        rec.hits[rid]!++;
      }
    : (): void => {};

  const hooks: Record<string, unknown> = {
    s,
    c,
    f,
    x,
    ap,
    aw,
    ex: () => {}, // exceptions are V8's (the debugger's pause on exceptions); nothing is kept per exception
    h: () => {}, // no caught-exception groups: they are aggregated over a recording
    // a console call is the program's own: it reaches stdout, which the run turns into `output`
    log: (_rid: number, method: string, ...args: unknown[]) => {
      const fn = (console as unknown as Record<string, (...a: unknown[]) => void>)[method] ?? console.log;
      fn.apply(console, args);
    },
    v: (_rid: number, _ctx: string, value: unknown) => value,
    t: (_rid: number, _ctx: string, _t0: number, value: unknown) => value,
    lp: () => {},
  };

  return {
    hooks,
    count: () => n,
    chain: () => {
      const frames: ChainFrame[] = [];
      for (let i = 0; i < sp; i++) {
        const frame: ChainFrame = { id: ids[i]!, rid: rids[i]! };
        if (stash && getters[i] !== undefined) {
          frame.getter = getters[i];
          frame.getterRid = getterRids[i];
        }
        frames.push(frame);
      }
      return { frames, module: modGetter !== undefined ? { getter: modGetter, rid: modRid } : undefined };
    },
  };
}
