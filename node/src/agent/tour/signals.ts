/**
 * The tour's signals: each proposes steps worth a stop, with the reason it proposes them, as
 * Pyokka's `agent/tour/signals.py`.
 *
 * - `spine`: `why` backwards from the goal (the program's output, or `--goal`), then from the
 *   return of every project callee on the way; function headers and pass-through returns are dropped.
 * - `crossing`: a callback a library made into the project directly (its entry and its return; a
 *   callback made from inside another callback is left out), and every statement of the project
 *   that calls into a library.
 * - `io`: HTTP requests (the recording's `http.exchange` rows), file writes and child processes
 *   (found in the statement's source: the recording has no event for them).
 * - `exception`: every raise, handled or not, and a branch arm taken in at most 20% of 3 or more
 *   passes. Arms never taken and loops that ran zero times are not signals.
 * - `narrative`: statements of an orchestrating frame (own steps spanning max(40, 2% of the run))
 *   that keep a call's result, first pass per line.
 * - `chapter`: the step each chapter starts at.
 */
import { ProvenanceBuilder } from '../provenance.ts';
import { bindsCall, classifyCall, isDefinition, isForward, ownCalls } from './astinfo.ts';
import { isAnon } from './chapters.ts';
import type { TourRun } from './model.ts';
import { cut, flat } from './py.ts';
import { tokens } from './values.ts';

type Msg = Record<string, any>;

export const SPINE_BUDGET = 25; // `why` trees per tour
export const RARE_SHARE = 0.2;
export const RARE_MIN_HITS = 3;
export const RARE_FIRST = 3; // passes of a rare arm proposed
/** a decision moment's ending: JavaScript's `took true` / `took false` */
const DECISION = / took (true|false)$/;
const CONTROL_FLOW = new Set(['StopIteration', 'StopAsyncIteration', 'GeneratorExit', 'CancelledError', 'AbortError']);
export const EVIDENCE_TOP = 12;
export const PROSE_MIN = 300;

/** a candidate in the pool: `subs` holds `signal:sub` */
export interface Pooled {
  step: number;
  subs: Set<string>;
  reasons: Map<string, string>;
  valuesFrom: number[];
  setup?: boolean;
  score?: number;
  repeat?: number;
}

/** Candidates by step: `{step, subs: {signal:sub}, reasons}` */
export class Pool {
  readonly t: TourRun;
  readonly byStep = new Map<number, Pooled>();

  constructor(t: TourRun) {
    this.t = t;
  }

  /** `valuesFrom`: other steps whose values belong on this candidate (the call whose result lands here) */
  add(step: number, signal: string, sub: string, reason: string, valuesFrom: number[] = []): void {
    if (!(step >= 0 && step < this.t.n)) return;
    let c = this.byStep.get(step);
    if (!c) this.byStep.set(step, (c = { step, subs: new Set(), reasons: new Map(), valuesFrom: [] }));
    const key = `${signal}:${sub}`;
    c.subs.add(key);
    if (!c.reasons.has(key)) c.reasons.set(key, reason);
    for (const s of valuesFrom) if (!c.valuesFrom.includes(s) && s !== step) c.valuesFrom.push(s);
  }
}

function whyNodes(node: unknown, out: Msg[]): void {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  const n = node as Msg;
  if (n.step !== null && n.step !== undefined) out.push(n);
  for (const r of n.reads ?? []) whyNodes(r, out);
}

function short(text: unknown, limit = 60): string {
  return cut(flat(text !== null && text !== undefined ? String(text) : '?'), limit);
}

/** walk `why` from each seed (the first is the goal); returns `{whyCalls}` */
export function spine(t: TourRun, pool: Pool, seeds: number[], budget = SPINE_BUDGET): Msg {
  const builder = new ProvenanceBuilder(t.run);
  const queue = [...seeds];
  const seen = new Set<number>();
  let calls = 0;
  while (queue.length && calls < budget) {
    const st = queue.shift()!;
    if (seen.has(st) || !(st >= 0 && st < t.n)) continue;
    seen.add(st);
    const tree = builder.build('', st, 5, 60);
    calls += 1;
    const nodes: Msg[] = [];
    whyNodes(tree.root, nodes);
    for (const node of nodes) {
      const s = Number(node.step);
      const text = t.text(s);
      if (!isDefinition(t.stmt(s), text)) pool.add(s, 'spine', 'why', node.name ? `${node.name || 'statement'} = ${short(node.text)}` : 'on the way to the goal');
      for (const call of node.calls ?? []) {
        let rs = call.returnStep;
        if (rs === null || rs === undefined || isAnon(String(call.name || ''))) continue;
        rs = Number(rs);
        if (!isForward(t.stmt(rs)) && !isDefinition(t.stmt(rs), t.text(rs))) pool.add(rs, 'spine', 'return', `${call.name ?? 'None'} returns the value the goal is built from`);
        queue.push(rs);
      }
    }
  }
  return { whyCalls: calls };
}

export function crossings(t: TourRun, pool: Pool): void {
  const tools = new Map<number, Msg>();
  for (const m of t.calls) if (m.kind === 'tool') tools.set(Number(m.scopeId), m);

  /** called back from inside a callback of the same function (recursion through a library helper) */
  const nested = (m: Msg): boolean => {
    const fn = m.callee.function;
    let s = Number(m.callerScopeId ?? -1);
    for (let k = 0; k < 64; k++) {
      if (s < 0) return false;
      if (tools.has(s) && tools.get(s)!.callee.function === fn) return true;
      s = t.parent(s);
    }
    return false;
  };

  for (const [sid, m] of tools) {
    const fn = String(m.callee.function);
    const sh = fn.split('.').pop()!;
    if (isAnon(fn) || (sh.startsWith('__') && sh.endsWith('__')) || nested(m)) continue;
    const entry = Number(m.entryStep);
    pool.add(entry, 'crossing', 'callback-in', `a library calls ${fn}`);
    const last = t.scopeLast(sid);
    if (last > entry) pool.add(last, 'crossing', 'callback-out', `${fn} returns to the library`);
  }
  for (let i = 0; i < t.n; i++) {
    const fid = t.fid[i]!;
    if (fid < 0 || !t.user(fid)) continue;
    const stmt = t.stmt(i);
    if (!stmt) continue;
    const info = t.info(fid);
    const nxt = i + 1 < t.n && t.entry[i + 1] ? t.function(i + 1) : null;
    for (const call of ownCalls(stmt)) {
      const [kind, label] = classifyCall(call, info, t.roots, t.defs, nxt);
      if (kind === 'lib') {
        pool.add(i, 'crossing', 'lib-call', `calls ${label}`);
        break;
      }
      if (kind === 'io-write' || kind === 'subprocess') {
        pool.add(i, 'io', kind === 'io-write' ? 'file-write' : 'subprocess', `${kind === 'io-write' ? 'writes with' : 'runs'} ${label}`);
        break;
      }
    }
  }
}

/** each HTTP request at the statement that made it, and its response where the reply lands */
export function io(t: TourRun, pool: Pool): void {
  for (const r of t.http) {
    const st = Number(r.step);
    const what = `${r.method ?? 'None'} ${r.name ?? 'None'} ${r.status ?? 'None'}${r.llm ? ' (model call)' : ''}`;
    pool.add(st, 'io', 'http', what);
    const sid = t.scope[st]!;
    if (t.parent(sid) >= 0) pool.add(t.landing(sid), 'io', 'response', `the response of ${what} lands`, [t.scopeLast(sid)]);
  }
}

export function exceptions(t: TourRun, pool: Pool): void {
  const byLine = new Map<string, [number, string][]>();
  for (const m of t.moments) {
    if (m.kind === 'error') {
      const text = String(m.text);
      const etype = text.startsWith('raised ') ? (text.split(' ')[1] ?? '').replace(/:+$/, '') : '';
      if (!CONTROL_FLOW.has(etype)) pool.add(Number(m.step), 'exception', text.includes(', handled') || text.includes('(handled)') ? 'handled' : 'raised', text);
    } else if (m.kind === 'decision') {
      const hit = DECISION.exec(String(m.text));
      if (hit) {
        const key = JSON.stringify([m.location.fileId ?? null, m.location.line ?? null]);
        let list = byLine.get(key);
        if (!list) byLine.set(key, (list = []));
        list.push([Number(m.step), hit[1]!]);
      }
    }
  }
  for (const hits of byLine.values()) {
    if (hits.length < RARE_MIN_HITS) continue;
    const arms = new Map<string, number[]>();
    for (const [st, arm] of hits) {
      let list = arms.get(arm);
      if (!list) arms.set(arm, (list = []));
      list.push(st);
    }
    if (arms.size !== 2) continue;
    for (const [arm, steps] of arms) {
      if (steps.length / hits.length <= RARE_SHARE) {
        for (const st of steps.slice(0, RARE_FIRST)) pool.add(st, 'exception', 'rare-arm', `took ${arm} in ${steps.length} of ${hits.length} passes`);
      }
    }
  }
}

export function narrative(t: TourRun, pool: Pool): void {
  const spanMin = Math.max(40, 0.02 * t.n);
  for (const steps of t.byScope.values()) {
    if (steps[steps.length - 1]! - steps[0]! < spanMin) continue;
    const seen = new Set<number>();
    for (const st of steps) {
      const line = t.line[st]!;
      if (seen.has(line) || !t.user(t.fid[st]!)) continue;
      if (bindsCall(t.stmt(st))) {
        seen.add(line);
        pool.add(st, 'narrative', 'binds', `${t.function(st)} keeps a call's result`);
      }
    }
  }
}

/**
 * The values that share the most words and numbers with the goal (a number counts 3), first step
 * of each distinct text, the best `top` of them: where the answer's facts were before they were
 * the answer. A value that holds the goal's own text is the answer, not evidence.
 */
export function evidence(t: TourRun, pool: Pool, goalText: string, top = EVIDENCE_TOP): void {
  const goal = tokens(goalText);
  if (!goal.size) return;
  const f = flat(goalText);
  const half = Math.floor(f.length / 2);
  const probe = f.length >= 40 ? f.slice(Math.max(0, half - 12), half + 12) : null;
  const best = new Map<string, [number, number, string, string[]]>();
  for (const [step, rows] of t.changes) {
    if (!t.user(t.fid[step]!)) continue;
    for (const [, name, text] of rows) {
      if (text.length < 40 || best.has(text) || (probe && flat(text).includes(probe))) continue;
      const found = [...tokens(text)].filter((w) => goal.has(w));
      const score = found.reduce((s, w) => s + (/\d/.test(w[0]!) ? 3 : 1), 0);
      if (score >= 4 && found.length >= 2) best.set(text, [score, step, name, found.sort()]);
    }
  }
  const ranked = [...best.values()].sort((a, b) => b[0] - a[0] || a[1] - b[1]).slice(0, top);
  for (const [, step, name, found] of ranked) pool.add(step, 'evidence', 'goal-words', `${name} shares ${found.slice(0, 6).join(', ')} with the goal`);
}

/** a call that receives a long text (a prompt, instructions, a page), the first time that text goes into a call */
export function proseIn(t: TourRun, pool: Pool): void {
  const seen = new Set<string>();
  for (const [step, rows] of t.changes) {
    for (const [role, name, text] of rows) {
      if (role !== 'in' || text.length < PROSE_MIN || seen.has(text) || !`'"\``.includes(text[0] ?? '')) continue;
      seen.add(text);
      let letters = 0;
      for (const ch of text) if (ch === ' ' || /\p{L}/u.test(ch)) letters++;
      const len = [...text].length;
      if (letters >= 0.7 * len && t.user(t.fid[step]!)) pool.add(step, 'narrative', 'text-in', `${t.function(step)} receives ${name}, ${len} characters of text`);
    }
  }
}
