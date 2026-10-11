/** The root of a chain: where the value took the form that failed (`docs/design/origin.md`, "The root"). */
import { Entries, TypedList, parse, typeOf } from '../reprs.ts';
import { containerNoun, hasKey, keyRepr, typePhrase, type Need } from './need.ts';
import type { OriginBuilder } from './walk.ts';

type Msg = Record<string, any>;

export const MAKERS = ['assigned', 'return', 'element', 'literal'];

/** a value's form in the terms the need is about: `a string`, `undefined`, `an array of length 2`, `an object without 'port'` */
export function shape(text: string | null | undefined, need: Need | null): string {
  const t = typeOf(text);
  if (t === 'undefined' || t === 'null') return t;
  const value = parse(text);
  const items = value instanceof TypedList ? value.items : value;
  if (need !== null && need.kind === 'index' && (Array.isArray(items) || typeof items === 'string') && !String(text).includes('…(+')) return `${typePhrase(t)} of length ${items.length}`;
  if (need !== null && need.kind === 'key' && value instanceof Entries) return `${typePhrase(t)} ${hasKey(value, need.key) ? 'with' : 'without'} ${keyRepr(need.key)}`;
  return typePhrase(t);
}

/** Python's `difflib.SequenceMatcher(None, a, b).ratio()` (no junk: the strings are short) */
function ratio(a: string, b: string): number {
  const b2j = new Map<string, number[]>();
  [...b].forEach((c, j) => {
    if (!b2j.has(c)) b2j.set(c, []);
    b2j.get(c)!.push(j);
  });
  const A = [...a];
  const longest = (alo: number, ahi: number, blo: number, bhi: number): [number, number, number] => {
    let [besti, bestj, bestsize] = [alo, blo, 0];
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const next = new Map<number, number>();
      for (const j of b2j.get(A[i]!) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        next.set(j, k);
        if (k > bestsize) [besti, bestj, bestsize] = [i - k + 1, j - k + 1, k];
      }
      j2len = next;
    }
    return [besti, bestj, bestsize];
  };
  let matches = 0;
  const queue: [number, number, number, number][] = [[0, A.length, 0, [...b].length]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const [i, j, k] = longest(alo, ahi, blo, bhi);
    if (!k) continue;
    matches += k;
    if (alo < i && blo < j) queue.push([alo, i, blo, j]);
    if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
  }
  const total = A.length + [...b].length;
  return total ? (2 * matches) / total : 1;
}

/** `difflib.get_close_matches(word, possibilities, n=1)`: the best one at or above 0.6, null when none */
export function closeMatch(word: string, possibilities: string[]): string | null {
  let best: [number, string] | null = null;
  for (const x of possibilities) {
    const r = ratio(x, word);
    if (r >= 0.6 && (best === null || r > best[0] || (r === best[0] && x > best[1]))) best = [r, x];
  }
  return best ? best[1] : null;
}

/** the texts the link's statement produced on its other runs, for the same role */
export function siblings(b: OriginBuilder, link: Msg): string[] {
  if (link.how === 'return' && link.scopeReturned !== null && link.scopeReturned !== undefined) {
    const self = b.trace.scope(Number(link.scopeReturned));
    if (!self) return [];
    return (b.scopesByRid.get(Number(self.rid)) ?? []).filter((s) => s !== self && s.returned !== null && s.returned !== undefined).map((s) => String(s.returned));
  }
  if (link._sib) {
    const [name, rid, own] = link._sib;
    return b.history
      .rows(name)
      .filter((r) => Number(r.step) !== own && b.trace.rid(Number(r.step)) === rid && r.name === name && r.text !== null && r.text !== undefined && !r.unchanged)
      .map((r) => String(r.text));
  }
  return [];
}

export function markRoot(b: OriginBuilder, need: Need | null, failing = true): Msg | null {
  const links = b.links;
  if (!links.length) return null;
  const final = links[0]!.text;
  let k = 0;
  while (k + 1 < links.length && links[k + 1]!.text === final && final !== null && final !== undefined) k++;
  for (let i = k; i >= 0; i--) {
    // forward in time
    const link = links[i]!;
    const here = typeOf(link.text);
    const sib = siblings(b, link);
    if (!sib.length) continue;
    let good: string[];
    if (need !== null) {
      if (need.fits(link.text) !== false) continue;
      good = sib.filter((t) => need.fits(t));
      if (!good.length) continue;
    } else {
      good = sib.filter((t) => {
        const ty = typeOf(t);
        return ty && here && ty !== here;
      });
      if (!good.length) continue;
    }
    const kinds = [...new Set(good.map((t) => shape(t, need)))].sort();
    let who: string;
    let verb: string;
    let others: string;
    if (link.how === 'return') [who, verb, others] = [link.function || '<module>', 'returned', 'calls'];
    else if (link.how === 'argument') [who, verb, others] = ['this call', 'passed', 'calls'];
    else [who, verb, others] = ['this statement', 'made', 'runs'];
    const share = good.length === sib.length ? `its other ${sib.length} ${others}` : `${good.length} of its other ${sib.length} ${others}`;
    const reason = `${who} ${verb} ${shape(link.text, need)} here; ${share} ${verb} ${kinds.join(' or ')}`;
    link.root = true;
    return { index: i, step: link.step, reason, evidence: 'siblings' };
  }
  // without sibling evidence the root is the earliest link that already carries the value, but only a
  // link that made it: a chain cut at an argument or a read does not know where the value was made
  while (k >= 0 && !MAKERS.includes(links[k]!.how)) k--;
  if (k < 0) return null;
  const link = links[k]!;
  link.root = true;
  const value = parse(link.text);
  if (need !== null && need.kind === 'key' && value instanceof Entries) {
    const keys = [...value.entries.keys()].filter((x): x is string => typeof x === 'string' && !x.startsWith('\u0000'));
    const close = closeMatch(String(need.key), keys);
    let reason = `the ${containerNoun(value.type)} has no key ${keyRepr(need.key)} from here on`;
    if (close !== null) reason += `; it has ${keyRepr(close)}`;
    return { index: k, step: link.step, reason, evidence: 'first' };
  }
  const shown = [...String(link.text)].length <= 40 ? link.text : shape(link.text, need);
  const reason = `the value is ${shown} from here to ${failing ? 'the failure' : 'the step asked about'}`;
  return { index: k, step: link.step, reason, evidence: 'first' };
}
