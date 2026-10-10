/**
 * Time Machine navigation over recorded step quads, a port of the extension's
 * `src/timeMachine/traceModel.ts`.
 *
 * Steps are `[rid, scopeId, depth, flags]` quads (`decodeSteps`), scopes the `trace` event's
 * table. A resolver maps a global range id to `[fileId, range]` or null. Every move returns a
 * step index or -1 when the move is impossible, exactly like the TypeScript model.
 */
import { FLAG_ERROR, FLAG_LOG } from '../protocol.ts';

export const ECHO_LIMIT = 100;

/** [fileId, [startLine, startCol, endLine, endCol]] */
export type Location = [number, number[]];
export type Resolver = (rid: number) => Location | null;
type Msg = Record<string, any>;

export interface CallFrame {
  scopeId: number;
  step: number;
  function: string;
  fileId: number;
  line: number;
  col: number;
  rid: number;
}

export const MOVES = ['into', 'over', 'out', 'back', 'backOver', 'backOut'] as const;

export class Trace {
  readonly steps: ArrayLike<number>;
  readonly scopes: Msg[];
  readonly truncated: boolean;
  readonly count: number;
  readonly scopeById = new Map<number, Msg>();
  private readonly resolve: Resolver;
  private readonly locationCache = new Map<number, Location | null>();
  private blockCache: [number, number, number][] | null = null;

  constructor(steps: ArrayLike<number>, scopes: Msg[], resolve: Resolver, truncated = false) {
    this.steps = steps;
    this.scopes = scopes;
    this.truncated = truncated;
    this.count = Math.floor(steps.length / 4);
    for (const s of scopes) this.scopeById.set(Number(s.scopeId), s);
    this.resolve = resolve;
  }

  static fromQuads(quads: number[][], scopes: Msg[], resolve: Resolver): Trace {
    const flat: number[] = [];
    for (const q of quads) flat.push(q[0]!, q[1]!, q[2]!, q.length > 3 ? q[3]! : 0);
    return new Trace(Int32Array.from(flat), scopes, resolve);
  }

  // -- accessors --------------------------------------------------------------------
  rid(i: number): number {
    return this.valid(i) ? this.steps[i * 4]! : -1;
  }

  scopeId(i: number): number {
    return this.valid(i) ? this.steps[i * 4 + 1]! : -1;
  }

  depth(i: number): number {
    return this.valid(i) ? this.steps[i * 4 + 2]! : 0;
  }

  flags(i: number): number {
    return this.valid(i) ? this.steps[i * 4 + 3]! : 0;
  }

  scope(scopeId: number): Msg | undefined {
    return this.scopeById.get(scopeId);
  }

  valid(i: number): boolean {
    return Number.isInteger(i) && i >= 0 && i < this.count;
  }

  clamp(i: number): number {
    if (this.count === 0) return -1;
    return Math.max(0, Math.min(this.count - 1, i));
  }

  location(i: number): Location | null {
    if (!this.valid(i)) return null;
    const rid = this.rid(i);
    if (!this.locationCache.has(rid)) this.locationCache.set(rid, this.resolve(rid));
    return this.locationCache.get(rid)!;
  }

  // -- the six moves ------------------------------------------------------------------
  stepInto(i: number): number {
    return i + 1 < this.count ? i + 1 : -1;
  }

  stepBackInto(i: number): number {
    return i - 1 >= 0 && this.count > 0 ? i - 1 : -1;
  }

  // Over and out follow the scope's parent chain, not step depth: the next step in the current
  // scope or an ancestor (over), or in an ancestor only (out). A scope entered from another
  // task or a sibling call at the same depth is never a landing spot, so stepping over an
  // `await Promise.all(...)` skips every step of the awaited tasks.
  private lineage(i: number, strict: boolean): Set<number> {
    const out = new Set<number>();
    let sid = this.scopeId(i);
    if (strict) {
      const s = this.scopeById.get(sid);
      sid = s ? Number(s.parent) : -1;
    }
    while (sid >= 0 && !out.has(sid)) {
      out.add(sid);
      const s = this.scopeById.get(sid);
      sid = s ? Number(s.parent) : -1;
    }
    return out;
  }

  private nextIn(i: number, scopes: Set<number>, direction: number): number {
    if (!this.valid(i) || !scopes.size) return -1;
    for (let j = i + direction; j >= 0 && j < this.count; j += direction) if (scopes.has(this.steps[j * 4 + 1]!)) return j;
    return -1;
  }

  stepOver(i: number): number {
    return this.nextIn(i, this.lineage(i, false), 1);
  }

  stepBackOver(i: number): number {
    return this.nextIn(i, this.lineage(i, false), -1);
  }

  stepOut(i: number): number {
    return this.nextIn(i, this.lineage(i, true), 1);
  }

  stepBackOut(i: number): number {
    return this.nextIn(i, this.lineage(i, true), -1);
  }

  move(i: number, kind: string): number {
    switch (kind) {
      case 'into':
        return this.stepInto(i);
      case 'over':
        return this.stepOver(i);
      case 'out':
        return this.stepOut(i);
      case 'back':
      case 'backInto':
        return this.stepBackInto(i);
      case 'backOver':
        return this.stepBackOver(i);
      case 'backOut':
        return this.stepBackOut(i);
      default:
        throw new Error(`unknown move '${kind}'`);
    }
  }

  /** the contract's `moves` object: step numbers, null when impossible */
  moves(i: number): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    for (const kind of MOVES) {
      const j = this.move(i, kind);
      out[kind] = j >= 0 ? j : null;
    }
    return out;
  }

  canStep(i: number): Record<string, boolean> {
    return {
      into: this.stepInto(i) >= 0,
      back: this.stepBackInto(i) >= 0,
      over: this.stepOver(i) >= 0,
      backOver: this.stepBackOver(i) >= 0,
      out: this.stepOut(i) >= 0,
      backOut: this.stepBackOut(i) >= 0,
    };
  }

  // -- lines ---------------------------------------------------------------------------------
  startsOnLine(j: number, fileId: number, line: number): boolean {
    const loc = this.location(j);
    return loc !== null && loc[0] === fileId && loc[1][0] === line;
  }

  containsLine(j: number, fileId: number, line: number): boolean {
    const loc = this.location(j);
    return loc !== null && loc[0] === fileId && loc[1][0]! <= line && line <= loc[1][2]!;
  }

  runToLine(i: number, fileId: number, line: number): number {
    for (let j = i + 1; j < this.count; j++) if (this.startsOnLine(j, fileId, line)) return j;
    for (let j = i + 1; j < this.count; j++) if (this.containsLine(j, fileId, line)) return j;
    return -1;
  }

  runBackToLine(i: number, fileId: number, line: number): number {
    for (let j = i - 1; j >= 0; j--) if (this.startsOnLine(j, fileId, line)) return j;
    for (let j = i - 1; j >= 0; j--) if (this.containsLine(j, fileId, line)) return j;
    return -1;
  }

  /** first step on `line`, else the first step on a following line of that file, else step 0 */
  startStep(fileId: number, line: number): number {
    if (this.count === 0) return -1;
    for (let j = 0; j < this.count; j++) if (this.startsOnLine(j, fileId, line)) return j;
    for (let j = 0; j < this.count; j++) if (this.containsLine(j, fileId, line)) return j;
    let best = -1;
    let bestLine = Infinity;
    for (let j = 0; j < this.count; j++) {
      const loc = this.location(j);
      if (loc !== null && loc[0] === fileId && line < loc[1][0]! && loc[1][0]! < bestLine) {
        bestLine = loc[1][0]!;
        best = j;
      }
    }
    return best >= 0 ? best : 0;
  }

  /** every step whose statement starts on `line` (ascending) */
  stepsOnLine(fileId: number, line: number): number[] {
    const out: number[] = [];
    for (let j = 0; j < this.count; j++) if (this.startsOnLine(j, fileId, line)) out.push(j);
    return out;
  }

  // -- echoes, flags, stack ----------------------------------------------------------------------
  echoSteps(i: number, limit = ECHO_LIMIT): number[] {
    if (!this.valid(i)) return [];
    const rid = this.rid(i);
    const before: number[] = [];
    for (let j = i - 1; j >= 0 && before.length < limit; j--) if (this.rid(j) === rid) before.push(j);
    const after: number[] = [];
    for (let j = i + 1; j < this.count && after.length < limit; j++) if (this.rid(j) === rid) after.push(j);
    return before.reverse().concat(after);
  }

  isLogStep(i: number): boolean {
    return (this.flags(i) & FLAG_LOG) !== 0;
  }

  isErrorStep(i: number): boolean {
    return (this.flags(i) & FLAG_ERROR) !== 0;
  }

  /** innermost frame first; outer frames point at the call sites */
  callStack(i: number): CallFrame[] {
    if (!this.valid(i)) return [];
    const frames: CallFrame[] = [];
    const push = (scopeId: number, step: number, name: string): void => {
      const loc = this.location(step);
      frames.push({ scopeId, step, function: name, fileId: loc ? loc[0] : -1, line: loc ? loc[1][0]! : 0, col: loc ? loc[1][1]! : 0, rid: this.rid(step) });
    };
    let scope = this.scopeById.get(this.scopeId(i));
    push(this.scopeId(i), i, scope ? scope.name : '<module>');
    const seen = new Set<number>();
    while (scope !== undefined && scope.parent >= 0 && scope.parent !== scope.scopeId && !seen.has(scope.scopeId)) {
      seen.add(scope.scopeId);
      const parent = this.scopeById.get(scope.parent);
      if (parent === undefined) break;
      let callSite = -1;
      for (let j = Math.min(Number(scope.first), this.count) - 1; j >= 0; j--) {
        if (this.scopeId(j) === parent.scopeId) {
          callSite = j;
          break;
        }
      }
      if (callSite < 0) break;
      push(parent.scopeId, callSite, parent.name);
      scope = parent;
    }
    return frames;
  }

  // -- blocks (Code Story grouping) --------------------------------------------------------------------
  /**
   * One block per pass through a scope: `[scopeId, firstStep, lastStep]`.
   *
   * A block runs while the scope holds and no line comes back around. A line reached again
   * after leaving it is the code running again, so a loop body becomes one block per
   * iteration and each block reads as a straight run down the source. Several steps can
   * share a line (a call and its arguments), so only a line returned to after leaving it
   * starts a block. Steps in another file belong to that file's own block: they neither end
   * the current one nor count as a line coming back.
   */
  blocks(): [number, number, number][] {
    if (this.blockCache) return this.blockCache;
    const out: [number, number, number][] = [];
    let i = 0;
    while (i < this.count) {
      const sid = this.scopeId(i);
      const loc = this.location(i);
      const fileId = loc ? loc[0] : -1;
      let prevLine: number | null = loc ? loc[1][0]! : null;
      const seen = new Set<number>(prevLine !== null ? [prevLine] : []);
      let j = i;
      while (j + 1 < this.count && this.scopeId(j + 1) === sid) {
        const nxt = this.location(j + 1);
        const line = nxt && nxt[0] === fileId ? nxt[1][0]! : null;
        if (line !== null && line !== prevLine) {
          if (seen.has(line)) break;
          seen.add(line);
        }
        if (line !== null) prevLine = line;
        j++;
      }
      out.push([sid, i, j]);
      i = j + 1;
    }
    this.blockCache = out;
    return out;
  }

  /** the block (see `blocks`) containing step `i` */
  blockAt(i: number): [number, number, number] | null {
    if (!this.valid(i)) return null;
    for (const block of this.blocks()) if (block[1] <= i && i <= block[2]) return block;
    return null;
  }

  stepInfo(i: number): Msg | null {
    if (!this.valid(i)) return null;
    const loc = this.location(i);
    return {
      index: i,
      rid: this.rid(i),
      fileId: loc ? loc[0] : -1,
      line: loc ? loc[1][0] : 0,
      col: loc ? loc[1][1] : 0,
      scopeId: this.scopeId(i),
      depth: this.depth(i),
      flags: this.flags(i),
    };
  }
}
