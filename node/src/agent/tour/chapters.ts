/**
 * Chapters: consecutive step ranges that cover the run, each opened by a function call.
 *
 * 1. Top level. Start at the module and descend while one call holds 80% of the frame's steps and
 *    the frame's other calls together hold under max(3%, 25 steps) (`<module>` to `main`). Each
 *    call that frame makes (8 steps or more; one source line calling one function in a row is one
 *    chapter, a loop) is a chapter, and the statements between calls glue onto the next one.
 * 2. Phases. Inside a chapter holding over 25% of the run, an orchestrator is a function called
 *    once there whose own steps span over 25% of the chapter. Each statement of an orchestrator
 *    that keeps the result of a call to a project function opens a phase at the first call to
 *    each distinct callee.
 * 3. Concurrency. Instances of one function whose lifetimes overlap without one descending from
 *    the other run concurrently; no phase starts inside their span.
 * 4. Small phases. A phase under 2% of the run merges into the previous one unless it makes an
 *    HTTP request; then a chapter under 2.5% folds into the next (the last into the previous).
 */
import { bindsCall, classifyCall, ownCalls } from './astinfo.ts';
import type { TourRun } from './model.ts';

type Msg = Record<string, any>;

export const MIN_CALL_STEPS = 8;
export const GLUE_STEPS = 12;
export const BIG_SHARE = 0.25;
export const MIN_SHARE = 0.02;
export const FOLD_SHARE = 0.025;
/** names of functions that are not a phase of the program: JavaScript's anonymous ones and Python's */
export const ANON = new Set(['<arrow>', '<anonymous>', '<lambda>', '<genexpr>', '<listcomp>', '<dictcomp>', '<setcomp>', '<module>']);

export function isAnon(fn: string): boolean {
  return ANON.has(fn.split('.').pop()!);
}

/** the calls whose previous step (the statement that led to them) ran in `scope`, with `xEnd` */
export function callsInFrame(t: TourRun, scope: number, lo: number, hi: number): Msg[] {
  const out: Msg[] = [];
  for (const m of t.calls) {
    const e = Number(m.entryStep);
    if (!(lo <= e && e <= hi) || e === 0 || t.scope[e - 1] !== scope || isAnon(String(m.callee.function))) continue;
    out.push({ ...m, xEnd: Math.min(hi, t.extent(m)) });
  }
  return out.sort((a, b) => Number(a.entryStep) - Number(b.entryStep));
}

function size(m: Msg): number {
  return Number(m.xEnd) - Number(m.entryStep) + 1;
}

/** `[scope, its calls, lo, hi]` of the frame that orchestrates `lo..hi` */
export function spine(t: TourRun, lo: number, hi: number): [number, Msg[], number, number] {
  let scope = lo === 0 ? t.rootScope : t.scope[lo]!;
  let calls = callsInFrame(t, scope, lo, hi);
  for (let k = 0; k < 8; k++) {
    const span = hi - lo + 1;
    const big = calls.filter((m) => size(m) >= 0.8 * span);
    if (big.length !== 1) break;
    const rest = calls.filter((m) => m !== big[0]).reduce((s, m) => s + size(m), 0);
    if (rest >= Math.max(0.03 * span, 25)) break;
    lo = Number(big[0]!.entryStep);
    hi = Number(big[0]!.xEnd);
    scope = t.scope[lo]!;
    calls = callsInFrame(t, scope, lo, hi);
  }
  return [scope, calls, lo, hi];
}

/** `[{start, end, title, entry}]`: the calls the orchestrating frame makes, statements glued on */
export function topLevel(t: TourRun): Msg[] {
  const lo = 0;
  const hi = t.n - 1;
  const [, calls] = spine(t, lo, hi);
  // calls in a row from one source line to one function are one group (a loop), sized together
  const groups: Msg[] = [];
  for (const m of calls) {
    const e = Number(m.entryStep);
    const site = t.line[e - 1];
    const fn = m.callee.function;
    const g = groups[groups.length - 1];
    if (g && g.site === site && g.fn === fn) {
      g.end = Math.max(g.end, Number(m.xEnd));
      g.n += 1;
      g.size += size(m);
      continue;
    }
    groups.push({ start: e - 1, end: Number(m.xEnd), site, fn, n: 1, entry: e, size: size(m) });
  }
  const bounds: Msg[] = [];
  for (const g of groups) {
    if (g.size < MIN_CALL_STEPS) continue;
    if (bounds.length && g.entry <= bounds[bounds.length - 1]!.end) continue; // nested under the previous chapter
    bounds.push(g);
  }
  const out: Msg[] = [];
  let cur = lo;
  for (const b of bounds) {
    if (b.start > cur) out.push({ start: cur, end: b.start - 1, title: null, entry: null });
    const title = b.fn + (b.n > 1 ? ` x${b.n}` : '');
    out.push({ start: Math.max(cur, b.start), end: b.end, title, entry: b.entry });
    cur = b.end + 1;
  }
  if (cur <= hi) out.push({ start: cur, end: hi, title: null, entry: null });
  const merged: Msg[] = [];
  for (let c of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.title === null && prev.end - prev.start < GLUE_STEPS) c = { ...c, start: merged.pop()!.start };
    merged.push(c);
  }
  const last = merged[merged.length - 1];
  if (merged.length > 1 && last!.title === null && last!.end - last!.start < GLUE_STEPS) {
    merged.pop();
    merged[merged.length - 1]!.end = last!.end;
  }
  return merged;
}

/** the project function a statement calls and keeps the result of, else null */
function calledProjectFn(t: TourRun, step: number): string | null {
  const stmt = t.stmt(step);
  if (!stmt || !bindsCall(stmt)) return null;
  const info = t.info(t.fid[step]!);
  const nxt = step + 1 < t.n && t.entry[step + 1] ? t.function(step + 1) : null;
  for (const call of ownCalls(stmt)) {
    const [kind, label] = classifyCall(call, info, t.roots, t.defs, nxt);
    if (kind === 'user' && !label.startsWith('this._api')) return label.split('.').pop()!;
  }
  return null;
}

/** spans where two or more instances of one function ran at once (neither descends from the other) */
export function concurrentSpans(t: TourRun, a: number, b: number): [number, number, string][] {
  const byFn = new Map<string, [string, number[]]>();
  for (const [sid, steps] of t.byScope) {
    if (a <= steps[0]! && steps[0]! <= b && t.parent(sid) >= 0) {
      const name = String(t.scopes.get(sid)!.name);
      const key = JSON.stringify([t.fid[steps[0]!], name]);
      let e = byFn.get(key);
      if (!e) byFn.set(key, (e = [name, []]));
      e[1].push(sid);
    }
  }
  const out: [number, number, string][] = [];
  for (const [name, sids] of byFn.values()) {
    if (sids.length < 2) continue;
    const spans = sids
      .map((s) => {
        const st = t.byScope.get(s)!;
        return [st[0]!, st[st.length - 1]!, s] as [number, number, number];
      })
      .sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
    let cur: [number, number, number[]] | null = null;
    for (const [s0, s1, sid] of spans) {
      if (cur !== null && s0 <= cur[1] && !cur[2].some((o) => t.descends(sid, o))) {
        cur[1] = Math.max(cur[1], s1);
        cur[2].push(sid);
        continue;
      }
      if (cur !== null && cur[2].length >= 2) out.push([cur[0], cur[1], name]);
      cur = [s0, s1, [sid]];
    }
    if (cur !== null && cur[2].length >= 2) out.push([cur[0], cur[1], name]);
  }
  return out;
}

function talksOut(t: TourRun, a: number, b: number): boolean {
  return t.http.some((r) => a <= Number(r.step) && Number(r.step) <= b);
}

export function phases(t: TourRun, c: Msg): Msg[] {
  const a = c.start;
  const b = c.end;
  const span = b - a + 1;
  const firstOf = new Map<string, number[]>();
  for (const [sid, steps] of t.byScope) {
    if (a <= steps[0]! && steps[0]! <= b && t.parent(sid) >= 0) {
      const key = JSON.stringify([t.fid[steps[0]!], t.scopeFunction(sid)]);
      let list = firstOf.get(key);
      if (!list) firstOf.set(key, (list = []));
      list.push(sid);
    }
  }
  const chain = new Set<number>();
  for (const sids of firstOf.values()) {
    if (sids.length !== 1) continue;
    const st = t.byScope.get(sids[0]!)!;
    if (st[st.length - 1]! - st[0]! > BIG_SHARE * span) chain.add(sids[0]!);
  }
  let starts: [number, string][] = [[a, c.title || t.function(a)]];
  const seen = new Set<string>();
  const chainSteps = [...chain].flatMap((sid) => t.byScope.get(sid)!).sort((x, y) => x - y);
  for (const st of chainSteps) {
    const fn = calledProjectFn(t, st);
    if (fn && !seen.has(fn)) {
      seen.add(fn);
      starts.push([st, fn]);
    }
  }
  starts.sort((x, y) => x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
  const busy = concurrentSpans(t, a, b);
  starts = [starts[0]!, ...starts.slice(1).filter(([st]) => !busy.some(([s0, s1]) => s0 < st && st <= s1))];
  const segs: Msg[] = [];
  starts.forEach(([st, fn], k) => {
    const end = k + 1 < starts.length ? starts[k + 1]![0] - 1 : b;
    if (end < st) return;
    if (segs.length && end - st + 1 < MIN_SHARE * t.n && !talksOut(t, st, end)) {
      segs[segs.length - 1]!.end = end;
      segs[segs.length - 1]!.opens.push(fn);
    } else segs.push({ start: st, end, title: fn, opens: [fn], kind: 'phase' });
  });
  if (segs.length > 1 && segs[0]!.end - segs[0]!.start + 1 < MIN_SHARE * t.n) {
    const first = segs.shift()!;
    segs[0] = { ...segs[0], start: first.start, title: first.title, opens: [...first.opens, ...segs[0]!.opens] };
  }
  return segs;
}

/** `[{start, end, title, opens, kind}]` covering steps 0..n-1 without gaps */
export function chapters(t: TourRun): Msg[] {
  if (t.n === 0) return [];
  const out: Msg[] = [];
  for (const c of topLevel(t)) {
    const title = c.title || t.function(c.start);
    if (c.end - c.start + 1 > BIG_SHARE * t.n && c.entry !== null) {
      const parts = phases(t, { ...c, title });
      if (parts.length > 1) {
        for (const p of parts) p.parent = title;
        out.push(...parts);
        continue;
      }
    }
    out.push({ start: c.start, end: c.end, title, opens: [title], kind: c.entry !== null ? 'call' : 'statements' });
  }
  const folded: Msg[] = [];
  for (let c of out) {
    const prev = folded[folded.length - 1];
    if (prev && prev.end - prev.start + 1 < FOLD_SHARE * t.n) {
      folded.pop();
      c = { ...c, start: prev.start, title: prev.title, opens: [...prev.opens, ...c.opens] };
    }
    folded.push(c);
  }
  const final: Msg[] = [];
  for (let c of folded) {
    if (final.length && c.end - c.start + 1 < FOLD_SHARE * t.n) {
      const prev = final.pop()!;
      c = { ...prev, end: c.end, opens: [...prev.opens, ...c.opens] };
    }
    final.push(c);
  }
  return final;
}
