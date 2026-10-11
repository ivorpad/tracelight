/**
 * One trace from several threads' (threads/hub.ts), merged as the threads run. Each thread records
 * its own steps, cut into segments at its synchronisation points, each segment stamped with a
 * ticket from one counter the threads share (Recorder.tick). A message is sent under a ticket
 * smaller than the one its receiver takes when the message runs it, so putting the segments in
 * ticket order keeps every send before its receipt: the merged order is causally valid, though not
 * wall-clock exact between two synchronisation points. Nothing here costs anything per statement.
 *
 * The merge is incremental, so a trace delta (and a debugger pause) can go out while threads run,
 * and what went out never moves. A thread's last segment is open: it may still grow, and the
 * thread's later segments take larger tickets. With `C` the smallest open ticket over the threads,
 * every closed segment under `C` is final and goes out in ticket order, and so do the steps known
 * so far of the one thread whose open segment holds `C`: nothing can come before them any more.
 */
import type { Scope } from '../recorder/recorder.ts';

/** a thread's steps as the merge sees them */
export class Lane {
  /** step quads [rid, scopeId, depth, flags], local numbering, `n` of them known */
  steps: Int32Array = new Int32Array(0);
  n = 0;
  /** segment starts, flat [step, ticket, ...], steps ascending */
  segs: number[] = [];
  /** local steps already placed in the merged trace */
  consumed = 0;
  /** index in `segs` of the segment holding `consumed` (-2: before the first) */
  cursor = -2;
  /** mapping runs, flat [local start, merged start, length]; merged -1: past the cap */
  runs: number[] = [];
  /** local scope id -> merged id (empty: the same ids) */
  scopeMap: number[] = [];
  /** a thread that has exited: its last segment is closed */
  exited = false;
  /** the open ticket of a thread that has sent no segment yet: larger than this (the ticket of the statement that started it) */
  floor = 0;
  /** steps from `clampFrom` on take at least `clampTicket` (`restamp`) */
  private clampFrom = Infinity;
  private clampTicket = 0;

  readonly index: number;
  readonly depthShift: number;

  constructor(index: number, depthShift: number) {
    this.index = index;
    this.depthShift = depthShift;
  }

  /** steps `from..` of this thread (under the cap), `n` known after them */
  addSteps(from: number, chunk: Int32Array, n: number): void {
    const need = n << 2;
    if (need > this.steps.length) {
      const grown = new Int32Array(Math.max(need, this.steps.length * 2, 4096));
      grown.set(this.steps.subarray(0, this.n << 2));
      this.steps = grown;
    }
    this.steps.set(chunk, from << 2);
    this.n = Math.max(this.n, n);
  }

  /**
   * Segment starts as the thread sent them (its last known one first, again: a tick at the same
   * step replaces the ticket of an empty segment).
   */
  addSegs(entries: ArrayLike<number>): void {
    const segs = this.segs;
    for (let i = 0; i + 1 < entries.length; i += 2) {
      const at = entries[i]!;
      let ticket = entries[i + 1]!;
      if (at >= this.clampFrom && ticket < this.clampTicket) ticket = this.clampTicket;
      const k = segs.length;
      if (k && segs[k - 2] === at) segs[k - 1] = Math.max(segs[k - 1]!, ticket);
      else if (!k || at > segs[k - 2]!) segs.push(at, ticket);
    }
  }

  /**
   * A thread that did not answer: whatever it ran since what it sent goes after `ticket` (it is
   * blocked, or held by the debugger, so nothing of it is lost from the order that matters).
   */
  restamp(ticket: number): void {
    this.clampFrom = this.n;
    this.clampTicket = ticket;
    this.addSegs([this.n, ticket]);
  }

  /** the ticket of the segment that may still grow (Infinity once the thread exited) */
  open(): number {
    if (this.exited) return Infinity;
    const k = this.segs.length;
    return k ? this.segs[k - 1]! : this.floor + 0.5;
  }

  /** a local step's merged index: -1 while not merged, the last merged step past the cap */
  map(step: number, last: number): number {
    if (step < 0) return step;
    if (step >= this.consumed) return -1;
    const runs = this.runs;
    let lo = 0;
    let hi = runs.length / 3 - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (runs[mid * 3]! <= step) lo = mid;
      else hi = mid - 1;
    }
    const r = lo * 3;
    if (hi < 0 || runs[r]! > step || step >= runs[r]! + runs[r + 2]! || runs[r + 1]! < 0) return Math.max(0, last);
    return runs[r + 1]! + (step - runs[r]!);
  }

  scope(id: number): number {
    return id < 0 || this.scopeMap.length === 0 ? id : (this.scopeMap[id] ?? id);
  }
}

/** the merged trace so far */
export class Merger {
  readonly lanes: Lane[] = [];
  out: Int32Array = new Int32Array(4096);
  /** merged steps so far (at most the cap) */
  len = 0;
  truncated = false;

  readonly cap: number;

  constructor(cap: number) {
    this.cap = cap;
  }

  lane(depthShift: number): Lane {
    const l = new Lane(this.lanes.length, depthShift);
    this.lanes.push(l);
    return l;
  }

  get last(): number {
    return this.len - 1;
  }

  /** Merge what can no longer move; `all`: every thread is done (the run ends). Returns the merged steps added. */
  advance(all = false): number {
    const lanes = this.lanes;
    let c = Infinity;
    let minLane = -1;
    let ties = 0;
    if (!all) {
      for (const l of lanes) {
        const o = l.open();
        if (o < c) {
          c = o;
          minLane = l.index;
          ties = 1;
        } else if (o === c) ties++;
      }
    }
    const pieces: { ticket: number; lane: Lane; from: number; to: number }[] = [];
    for (const l of lanes) {
      const s = l.segs;
      const n = l.n;
      if (l.consumed >= n) continue;
      // the segment holding `consumed`: steps before the first start are the thread's opening ticket 0
      let i = l.cursor;
      while (i + 3 < s.length && s[i + 2]! <= l.consumed) i += 2;
      l.cursor = i;
      for (;;) {
        const start = i < 0 ? 0 : s[i]!;
        // before its first segment: the main thread's opening steps (ticket 0)
        const ticket = i < 0 ? l.floor + 0.5 : s[i + 1]!;
        const nextAt = i + 2 < s.length ? s[i + 2]! : -1;
        const end = nextAt < 0 ? n : Math.min(nextAt, n);
        const from = Math.max(start, l.consumed);
        const isOpen = nextAt < 0;
        if (all || (isOpen ? l.exited || (ticket === c && l.index === minLane && ties === 1) || ticket < c : ticket < c)) {
          if (end > from) pieces.push({ ticket, lane: l, from, to: end });
        } else break;
        if (isOpen || nextAt >= n) break;
        i += 2;
      }
    }
    pieces.sort((a, b) => a.ticket - b.ticket || a.lane.index - b.lane.index);
    const before = this.len;
    for (const p of pieces) this.place(p.lane, p.from, p.to);
    return this.len - before;
  }

  private place(l: Lane, from: number, to: number): void {
    const room = Math.max(0, Math.min(to - from, this.cap - this.len));
    if (room < to - from) this.truncated = true;
    if (room > 0) {
      const need = (this.len + room) << 2;
      if (need > this.out.length) {
        const grown = new Int32Array(Math.max(need, this.out.length * 2));
        grown.set(this.out.subarray(0, this.len << 2));
        this.out = grown;
      }
      const src = l.steps;
      const out = this.out;
      const shift = l.depthShift;
      const remap = l.scopeMap.length > 0;
      for (let i = from, k = this.len; i < from + room; i++, k++) {
        const p = i << 2;
        const q = k << 2;
        out[q] = src[p]!;
        out[q + 1] = remap ? l.scope(src[p + 1]!) : src[p + 1]!;
        out[q + 2] = src[p + 2]! + shift;
        out[q + 3] = src[p + 3]!;
      }
      pushRun(l.runs, from, this.len, room);
      this.len += room;
    }
    if (room < to - from) pushRun(l.runs, from + room, -1, to - from - room);
    l.consumed = to;
  }

  steps(): Int32Array {
    return this.out.subarray(0, this.len << 2);
  }
}

function pushRun(runs: number[], local: number, merged: number, len: number): void {
  const k = runs.length;
  if (k && runs[k - 3]! + runs[k - 1]! === local && runs[k - 2]! >= 0 && merged >= 0 && runs[k - 2]! + runs[k - 1]! === merged) runs[k - 1]! += len;
  else runs.push(local, merged, len);
}

/** a worker's scope in the merged ids, its steps mapped (`first` -1: not merged yet) */
export function remapScope(sc: Scope, lane: Lane, last: number, worker: { thread: { name: string; ident: number }; rid: number; name: string }): Scope {
  const out: Scope = { ...sc, scopeId: lane.scope(sc.scopeId), parent: sc.parent < 0 ? sc.parent : lane.scope(sc.parent), depth: sc.depth + lane.depthShift, first: lane.map(sc.first, last), last: lane.map(sc.last, last) };
  if (sc.asyncParent !== undefined) out.asyncParent = lane.scope(sc.asyncParent);
  out.thread = worker.thread;
  if (sc.scopeId === 0) Object.assign(out, { rid: worker.rid, name: worker.name, parent: 0 });
  if (out.last < out.first) out.last = out.first;
  return out;
}
