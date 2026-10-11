/**
 * What the program held at a candidate, and how it is shaped so the candidates fit a prompt, as
 * Pyokka's `agent/tour/values.py`.
 *
 * Gathering, per step, from the recording only: the parameters a scope entered with (`in`), the
 * names the statement bound (`set`), values it logged (`value`), what it printed (`printed`), what
 * each call it made returned (`call`), what its function returned or raised there (`returned`,
 * `raised`), the arm a branch took (`took`), the HTTP request it made (`http`).
 *
 * Shaping, over the kept candidates in run order:
 *
 * - left out: `this` (and Python's `self`/`cls`), functions and classes as values (`[Function: f]`,
 *   `[class X]`), modules, and a value that only repeats the statement (`k = 60` on `const k = 60`);
 * - a value equal to an earlier one (40 characters or more) becomes `sameAs` that value's id;
 * - a value of 200 characters or more sharing most of its text with the previous value of the
 *   same name (a message list that grew by one turn) shows only the window that differs;
 * - a value over `VALUE_CUT` characters is cut there, and carries `evidence`: up to two sentences
 *   of the full text that share the most words and numbers with the goal, with offsets.
 */
import type { TourRun } from './model.ts';
import { cpIndex, cpLen, cpSlice, flat } from './py.ts';

type Msg = Record<string, any>;

export const VALUE_CUT = 300;
export const EVIDENCE_MAX = 240;
export const SAME_MIN = 40;
export const NEAR_MIN = 200;
export const NEAR_PAD = 40;
export const MAX_VALUES = 6;
const WORD = /[A-Za-z_]{3,}|\d+(?:\.\d+)?/g;
/** a value that is code, not data: Python's reprs and Node's (`util.inspect`) */
export const NOISE = /^<bound method |^<function [\w.<>]+ at 0x[0-9a-f]+>$|^<module '|^<class '|^<built-in (function|method) |^<method-wrapper |^\[(?:Async)?(?:Generator)?Function(?:: [^\]]*| \(anonymous\))?\]( \{.*\})?$|^\[class [^\]]*\]( \{.*\})?$|^\[Module: null prototype\]|^\[Object: null prototype\] \[Module\]/s;
const VALUE_KINDS = new Set(['value', 'autoLog', 'logpoint']);
export const RECORDING_CUT = /…\((cut|\+[\d,]+ chars)\)$/;
const SKIP_NAMES = new Set(['this', 'self', 'cls']);

/**
 * The log events the statement at step `i` wrote at that step: its own range id, or (JavaScript) a
 * range inside the statement's (`console.log(...)` and `// ?` log under the call's or the
 * expression's range, not the statement's).
 */
function logsOf(t: TourRun, i: number): Msg[] {
  const rid = t.trace.rid(i);
  const here = t.run.locate(rid);
  const out: Msg[] = [];
  for (const ev of t.builder.logsByStep.get(i) ?? []) {
    const erid = Number(ev.rid ?? -1);
    if (erid === rid) {
      out.push(ev);
      continue;
    }
    const loc = here ? t.run.locate(erid) : null;
    if (!loc || !here || loc.fileId !== here.fileId) continue;
    const [l0, c0, l1, c1] = here.range.map(Number) as [number, number, number, number];
    const [m0, d0, m1, d1] = loc.range.map(Number) as [number, number, number, number];
    if ((m0 > l0 || (m0 === l0 && d0 >= c0)) && (m1 < l1 || (m1 === l1 && d1 <= c1))) out.push(ev);
  }
  return out;
}

/** `[{role, name, text}]` at step `i`, in the order above, without the left-out kinds */
export function gather(t: TourRun, i: number): Msg[] {
  const out: Msg[] = [];
  for (const [role, name, text] of t.changes.get(i) ?? []) out.push({ role, name, text });
  for (const ev of logsOf(t, i)) {
    if (ev.kind === 'log') out.push({ role: 'printed', name: 'output', text: String(ev.text || '') });
    else if (VALUE_KINDS.has(ev.kind)) out.push({ role: 'value', name: String(ev.context || 'value'), text: String(ev.text || '') });
  }
  const called = new Set<string>();
  for (const call of t.callsMade(i)) {
    const fnName = t.scopeFunction(Number(call.scopeId));
    if (called.has(fnName)) continue; // a callback called once per item: its first result stands for the rest
    called.add(fnName);
    let text = call.returned;
    if (text === null || text === undefined) {
      const m = t.callByEntry.get(Number(call.first));
      text = (m?.values ?? []).find((v: Msg) => v.role === 'out' && v.name === 'return')?.text ?? null;
    }
    const fn = `${fnName.split('.').pop()}()`;
    if (text !== null && text !== undefined) out.push({ role: 'call', name: fn, text: String(text) });
    else if (call.raised) out.push({ role: 'call', name: fn, text: `raised ${call.raised}` });
  }
  const sid = t.scope[i]!;
  const s = t.scopes.get(sid);
  if (s !== undefined && t.scopeLast(sid) === i && Number(s.parent ?? -1) >= 0) {
    if (s.returned !== null && s.returned !== undefined) out.push({ role: 'returned', name: `${t.scopeFunction(sid).split('.').pop()} returned`, text: String(s.returned) });
    else if (s.raised) out.push({ role: 'raised', name: `${t.scopeFunction(sid).split('.').pop()} raised`, text: String(s.raised) });
  }
  for (const r of t.http) {
    if (Number(r.step) === i) out.push({ role: 'http', name: `request ${r.n ?? 'None'}`, text: `${r.method ?? 'None'} ${r.url ?? 'None'} -> ${r.status ?? 'None'}, ${r.bytes ?? 'None'} bytes, ${r.ms ?? 'None'} ms, ${r.source ?? 'None'}` });
  }
  for (const ev of t.run.errors) {
    if (ev.step !== null && ev.step !== undefined && Number(ev.step) === i) {
      out.push({ role: 'raised', name: String(ev.errorType || 'error'), text: `${ev.errorType ?? 'None'}: ${ev.message ?? 'None'}${!ev.handled ? '' : ' (handled)'}` });
      break;
    }
  }
  for (const m of t.decisionsAt(i)) out.push({ role: 'took', name: 'branch', text: m.text });
  const statement = flat(t.text(i));
  const kept: Msg[] = [];
  const seen = new Set<string>();
  for (const v of out) {
    const name: string = v.name;
    const text: string = v.text;
    if (SKIP_NAMES.has(name) || NOISE.test(text)) continue;
    if (text.trim() === statement || flat(`${name} = ${text}`) === statement) continue;
    const quoted = text.length >= 2 && text[0] === text[text.length - 1] && `'"\``.includes(text[0]!);
    const inner = flat(quoted ? text.slice(1, -1) : text);
    if (cpLen(inner) >= 3 && (v.role === 'printed' || inner !== text) && statement.includes(inner)) continue; // a literal the statement spells out (`console.log('RESULTS')`, `mode = 'fast'`)
    if (seen.has(text) && cpLen(text) >= SAME_MIN) continue; // `x = f()` binds what f returned: one copy
    seen.add(text);
    kept.push(v);
  }
  return kept.slice(0, MAX_VALUES);
}

const STOP = new Set('the and for with that this from are was were has have had not but its into per via use uses used than then there their they them what which when where who will would can could should may also more most such only other some any all one two out our your his her she him you'.split(' '));

/** words of three letters or more and numbers, lowercased, without common English words */
export function tokens(text: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const m of (text || '').matchAll(WORD)) {
    const w = m[0].toLowerCase();
    if (!STOP.has(w)) out.add(w);
  }
  return out;
}

function goalScore(found: string[]): number {
  return found.reduce((s, w) => s + (/\d/.test(w[0]!) ? 3 : 1), 0);
}

/**
 * Up to `n` sentences of `text` starting at or after `startAt` that share the most goal words (a
 * number counts 3; a sentence needs a score of 4 from two words or more), in text order. Offsets
 * are in code points.
 */
export function evidence(text: string, goal: Set<string>, n = 2, startAt = 0): Msg[] {
  if (!goal.size) return [];
  const spans: [number, number][] = [];
  let start = 0;
  for (const m of text.matchAll(/(?<=[.!?])\s+|\\n|\n/g)) {
    spans.push([start, m.index!]);
    start = m.index! + m[0].length;
  }
  spans.push([start, text.length]);
  const scored: [number, number, number][] = [];
  for (const [a16, b16] of spans) {
    const a = cpIndex(text, a16);
    const b = cpIndex(text, b16);
    if (b - a < 20 || a < startAt) continue;
    const found = [...tokens(text.slice(a16, b16))].filter((w) => goal.has(w));
    const score = goalScore(found);
    if (score >= 4 && found.length >= 2) scored.push([score, a, Math.min(b, a + EVIDENCE_MAX)]);
  }
  scored.sort((x, y) => y[0] - x[0] || x[1] - y[1]);
  return scored
    .slice(0, n)
    .sort((x, y) => x[1] - y[1])
    .map(([, a, b]) => ({ from: a, to: b, text: cpSlice(text, a, b) }));
}

function commonPrefix(a: string[] | string, b: string[] | string): number {
  const n = Math.min(a.length, b.length);
  let k = 0;
  while (k < n && a[k] === b[k]) k++;
  return k;
}

function commonSuffix(a: string[] | string, b: string[] | string): number {
  const n = Math.min(a.length, b.length);
  let k = 0;
  while (k < n && a[a.length - 1 - k] === b[b.length - 1 - k]) k++;
  return k;
}

/** a string as Python indexes it: itself when it has no surrogate pair, else its code points */
function seq(s: string): string | string[] {
  return /[\uD800-\uDFFF]/.test(s) ? Array.from(s) : s;
}

/** number each candidate's values `v1..` and apply the repeat, near-repeat and cut rules in place */
export function shape(candidates: Msg[], goal: Set<string>): void {
  const firstOf = new Map<string, string>();
  const lastByName = new Map<string, [string, string]>();
  for (const c of [...candidates].sort((a, b) => a.step - b.step)) {
    const shaped: Msg[] = [];
    let values: Msg[];
    if ('_values' in c) {
      values = c._values;
      delete c._values;
    } else values = c.values || [];
    values.forEach((v: Msg, k: number) => {
      const vid = `${c.id}.v${k + 1}`;
      const text: string = v.text;
      const len = cpLen(text);
      const out: Msg = { id: vid, role: v.role, name: v.name, length: len };
      const whole = !RECORDING_CUT.test(text); // two values cut by the recording may differ past the cut
      if (whole && len >= SAME_MIN && firstOf.has(text)) {
        out.sameAs = firstOf.get(text);
        shaped.push(out);
        return;
      }
      if (whole && len >= SAME_MIN) firstOf.set(text, vid);
      const prev = lastByName.get(v.name);
      lastByName.set(v.name, [vid, text]);
      if (prev !== undefined && len >= NEAR_MIN && cpLen(prev[1]) >= NEAR_MIN) {
        const ps = seq(prev[1]);
        const ts = seq(text);
        const p = commonPrefix(ps, ts);
        const q = commonSuffix(ps.slice(p), ts.slice(p));
        if (p + q >= 0.5 * len) {
          const a = Math.max(0, p - NEAR_PAD);
          const b = Math.min(len, len - q + NEAR_PAD);
          Object.assign(out, { like: prev[0], from: a, to: b, text: cpSlice(text, a, b) });
          if (b - a > VALUE_CUT) {
            out.text = cpSlice(text, a, a + VALUE_CUT);
            out.to = a + VALUE_CUT;
            out.cut = true;
          }
          shaped.push(out);
          return;
        }
      }
      if (len > VALUE_CUT) {
        out.text = cpSlice(text, 0, VALUE_CUT);
        out.cut = true;
        const ev = evidence(text, goal, 2, VALUE_CUT - 50);
        if (ev.length) out.evidence = ev;
      } else out.text = text;
      shaped.push(out);
    });
    c.values = shaped;
  }
}
