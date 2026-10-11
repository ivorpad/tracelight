/**
 * Which candidates stay: novelty for repeated lines, a score per candidate, and the token budget,
 * as Pyokka's `agent/tour/rank.py`.
 *
 * Novelty: a source line that ran again is a new candidate only when the call it made (or, for a
 * return, the call it returns from) had arguments not seen on that line before, at most
 * `NEW_ARGS_MAX` argument sets per line; an HTTP request is always new.
 *
 * Score: the weight of the strongest signal, +0.5 per further signal, -0.25 for each earlier pass
 * of the same line (at most -1.5). Setup (a settings object, a validation or cross-check, option
 * plumbing, a cache key) weighs `SETUP_FACTOR` of that, so it is the first to go when the budget cuts.
 *
 * Budget: the tour's JSON is estimated at a token per 4 characters. While it is over, the lowest
 * scored candidate goes, except that each chapter keeps its best `KEEP_PER_CHAPTER`.
 */
import type { TourRun } from './model.ts';
import { pyRound } from './py.ts';
import type { Pooled } from './signals.ts';

type Msg = Record<string, any>;

export const WEIGHT: Record<string, number> = {
  'io:http': 4, 'chapter:start': 4, 'io:response': 4, 'chapter:result': 3,
  'exception:raised': 3, 'exception:handled': 3,
  'crossing:callback-in': 3, 'crossing:callback-out': 3,
  'narrative:binds': 3, 'io:file-write': 3, 'io:subprocess': 3,
  'exception:rare-arm': 2, 'evidence:goal-words': 3, 'narrative:text-in': 2,
  'spine:return': 1.5, 'spine:why': 1, 'spine:goal': 5,
  'crossing:lib-call': 1,
};
export const SCRIPT_SPINE = 3; // the script's own statements on the spine
export const NEW_ARGS_MAX = 4;
export const REPEAT_STEP = 0.25;
export const REPEAT_STEPS = 6;
export const SETUP_FACTOR = 0.4;
export const KEEP_PER_CHAPTER = 3;
export const CHARS_PER_TOKEN = 4;

// Python's names (`__init__`, `_kwargs`) and JavaScript's (`constructor`, `opts`, `process.env`, `instanceof`)
const SETUP_FN = /^_*(__init__|__post_init__|constructor|init|setup|set_up|setUp|configure|config|settings|options|defaults?|validate\w*|check\w*|ensure\w*|verify\w*|sanitize\w*|normalize\w*|\w*_kwargs|\w*_config|\w*_options|\w*_settings|\w*Config|\w*Options|\w*Settings|\w*Opts|\w*cache_key\w*|\w*CacheKey\w*|make_key|makeKey)$/;
const SETUP_TEXT = /SimpleNamespace\(|\b\w*(Config|Settings|Options)\(|\w_kwargs\b|cache_key|cacheKey|os\.environ|process\.env\b|getenv\(|^assert\b|isinstance\(|\binstanceof\b|\.setdefault\(|\?\?=/;

/** a step whose function or statement prepares rather than does: the rules above */
export function isSetup(t: TourRun, i: number): boolean {
  const fn = t.function(i).split('.').pop()!;
  return SETUP_FN.test(fn) || SETUP_TEXT.test(t.text(i));
}

/** entry step -> the arguments the call entered with, as recorded texts (a JSON key) */
export function callArgs(t: TourRun): Map<number, string> {
  const out = new Map<number, string>();
  for (const m of t.calls) out.set(Number(m.entryStep), JSON.stringify((m.values ?? []).filter((v: Msg) => v.role === 'in').map((v: Msg) => v.text)));
  return out;
}

/** the pooled candidates a repeated line still earns, in step order, each with `repeat` set to its pass */
export function novel(t: TourRun, pooled: Map<number, Pooled>): Pooled[] {
  const args = callArgs(t);
  const seen = new Map<string, (string | null)[]>();
  const passes = new Map<string, number>();
  const out: Pooled[] = [];
  for (const st of [...pooled.keys()].sort((a, b) => a - b)) {
    const c = pooled.get(st)!;
    const key = `${t.fid[st]}:${t.line[st]}`;
    let a: string | null = args.get(st) ?? null;
    if (a === null && t.scopeLast(t.scope[st]!) === st) a = args.get(t.byScope.get(t.scope[st]!)![0]!) ?? null; // a return: the call it returns from
    if (a === null && st + 1 < t.n && t.entry[st + 1] && t.parent(t.scope[st + 1]!) === t.scope[st]) a = args.get(st + 1) ?? null; // the call this statement makes
    for (const v of c.valuesFrom) {
      if (a === null && t.scopeLast(t.scope[v]!) === v) a = args.get(t.byScope.get(t.scope[v]!)![0]!) ?? null; // a response or a result landing: the call it came from
    }
    let prev = seen.get(key);
    if (!prev) seen.set(key, (prev = []));
    const http = c.subs.has('io:http') || c.subs.has('io:response');
    if (prev.length && !http && (a === null || prev.includes(a) || prev.length >= NEW_ARGS_MAX)) continue;
    prev.push(a);
    const p = t.parent(t.scope[st]!);
    const path = JSON.stringify([key, p >= 0 ? t.scopeFunction(p) : '', p >= 0 && t.parent(p) >= 0 ? t.scopeFunction(t.parent(p)) : '']);
    c.repeat = passes.get(path) ?? 0; // the same line reached by another caller counts as a first pass
    passes.set(path, c.repeat + 1);
    out.push(c);
  }
  return out;
}

export function score(t: TourRun, c: Pooled): number {
  const ws: number[] = [];
  for (const sub of c.subs) {
    let w = WEIGHT[sub] ?? 1;
    if (sub.startsWith('spine:') && t.fid[c.step] === t.mainFid) w = Math.max(w, SCRIPT_SPINE);
    ws.push(w);
  }
  const signals = new Set([...c.subs].map((s) => s.split(':')[0]));
  let s = Math.max(...ws) + 0.5 * (signals.size - 1) - REPEAT_STEP * Math.min(Number(c.repeat || 0), REPEAT_STEPS);
  if (c.setup) s *= SETUP_FACTOR;
  return pyRound(s, 2);
}

/**
 * Keep the best scored candidates of each chapter within an equal share of the budget. Shares are
 * filled smallest chapter first, so what a small chapter leaves unused goes to the others; inside
 * a share the candidates go by score, and each chapter keeps its best `KEEP_PER_CHAPTER` whatever
 * they weigh.
 */
export function fit(candidates: Msg[], sizeOf: (c: Msg) => number, budgetTokens: number, fixedChars: number): Msg[] {
  const budgetChars = budgetTokens * CHARS_PER_TOKEN - fixedChars;
  const sizes = new Map<Msg, number>(candidates.map((c) => [c, sizeOf(c)]));
  if ([...sizes.values()].reduce((s, x) => s + x, 0) <= budgetChars) return candidates;
  const byChapter = new Map<string, Msg[]>();
  for (const c of candidates) {
    let g = byChapter.get(c.chapter);
    if (!g) byChapter.set(c.chapter, (g = []));
    g.push(c);
  }
  const total = (g: Msg[]) => g.reduce((s, c) => s + sizes.get(c)!, 0);
  const groups = [...byChapter.values()].sort((a, b) => total(a) - total(b));
  let remaining = budgetChars;
  const kept = new Set<Msg>();
  groups.forEach((group, k) => {
    const share = Math.max(0, remaining) / (groups.length - k);
    let used = 0;
    [...group]
      .sort((a, b) => b.score - a.score || a.step - b.step)
      .forEach((c, n) => {
        if (n >= KEEP_PER_CHAPTER && used + sizes.get(c)! > share) return;
        kept.add(c);
        used += sizes.get(c)!;
      });
    remaining -= used;
  });
  return candidates.filter((c) => kept.has(c));
}
