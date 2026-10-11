/**
 * `tour RUN --prose tour.prose.json`: check a model's (or an agent's) prose against the tour, then
 * merge, as Pyokka's `agent/tour/prose.py`.
 *
 * The prose (docs/TOUR.md, "tour.prose.json") picks candidate stops and writes titles and text;
 * everything else on the merged tour comes from the recording. `checkProse` lists every problem at
 * once so one retry can fix them all:
 *
 * - ids: a chapter or stop id the tour does not have, a pick listed twice, a picked stop with no
 *   text, a stop written but not picked, a field the contract does not have;
 * - quotes: a field the stop does not have, a range outside the recorded value (or past where the
 *   recording cut it);
 * - numbers: every number in a title or text has to occur in the recorded values of that stop
 *   (whole, not the tour's 300-character cut), its statement or its quote, compared with thousands
 *   separators removed and trailing decimal zeros dropped (`1,024` = `1024`, `0.50` = `0.5`). A
 *   chapter's may also come from its step range and request counts, the intro's from the run's;
 * - names: a name in backticks has to occur in the tour (a statement, function, file, value name
 *   or value);
 * - strings: text in 'single quotes' has to occur in that stop's recorded values.
 *
 * Counts outside the prompt's ranges and chapters left untitled are warnings, not rejections.
 */
import { pyRepr } from '../argparse.ts';
import { AgentError } from '../source.ts';
import { cpLen, cpSlice, flat, pyStr } from './py.ts';
import { RECORDING_CUT } from './values.ts';

type Msg = Record<string, any>;

export const TOP = ['intro', 'chapters', 'pick', 'stops'];
export const STOP_FIELDS = ['title', 'text', 'quote'];
export const CHAPTER_FIELDS = ['title', 'text'];
export const QUOTE_FIELDS = ['field', 'value', 'from', 'to']; // `value` is the prototype's name for `field`
export const SMALL_PICK: [number, number] = [6, 10]; // a tour of under SMALL_TOUR candidates: picks in all
export const SMALL_TOUR = 60;
export const CHAPTER_PICK: [number, number] = [3, 6];
export const TEXT_SENTENCES = 3;

const W = '[\\p{L}\\p{N}_]';
// A number as prose writes it: not part of a name (`s3`, `v2`, the 4 of `gpt-4o`), thousands
// separators allowed. In the recorded values any digit run counts.
const NUM_TEXT = new RegExp(`(?<![\\p{L}\\p{N}_.])(?<![A-Za-z]-)(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?(?!\\d)`, 'gu');
const NUM_PLAIN = /\d+(?:\.\d+)?/g;
const NUM_GROUPED = /\d{1,3}(?:,\d{3})+(?:\.\d+)?/g;
const TICK = /`([^`\n]+)`/g;
const NAME = new RegExp(`^[A-Za-z_]${W.slice(0, -1)}.]*(?:\\(.*\\))?$`, 'su');
const SQUOTE = /(?:(?<=[\s(\[])|^)['‘]([^'‘’\n]{2,}?)['’](?=[\s.,;:)\]!?]|$)/g;
const SENTENCE_END = /[.!?](?:\s|$)/g;

function isObject(x: unknown): x is Msg {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

/** Python's `%r` of a JSON value */
function pyReprAny(v: unknown): string {
  if (typeof v === 'string') return pyRepr(v);
  if (v === null || v === undefined || typeof v === 'boolean') return pyStr(v);
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return '[' + v.map(pyReprAny).join(', ') + ']';
  return '{' + Object.entries(v as Msg).map(([k, x]) => `${pyRepr(k)}: ${pyReprAny(x)}`).join(', ') + '}';
}

/** The prose broke the contract: every problem, one per line, for a retry. */
export class ProseRejected extends AgentError {
  readonly violations: string[];

  constructor(violations: string[]) {
    const n = violations.length;
    super(`the prose has ${n} problem${n === 1 ? '' : 's'}:\n${violations.map((v) => '- ' + v).join('\n')}`, 'fix each one and run the same command again; a model retry gets this list appended (skills/tracelight/references/tour-prompt.md, "Retry")');
    this.violations = violations;
  }

  override toJson(): Msg {
    const out = super.toJson();
    out.error = this.message.split('\n', 1)[0]!.replace(/:+$/, '');
    out.violations = this.violations;
    return out;
  }
}

/** under `SMALL_TOUR` candidates (or a walkthrough-sized run): 6 to 10 picks in all, else 3 to 6 per chapter */
export function isSmallTour(tour: Msg): boolean {
  return !!tour.small || (tour.candidates || []).length < SMALL_TOUR || (tour.chapters || []).length === 1;
}

export function normNumber(s: string): string {
  s = s.replaceAll(',', '');
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s || '0';
}

export function textNumbers(text: string): string[] {
  return [...text.matchAll(NUM_TEXT)].map((m) => m[0]);
}

export function hayNumbers(...texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) {
    for (const m of t.matchAll(NUM_PLAIN)) out.add(normNumber(m[0]));
    for (const m of t.matchAll(NUM_GROUPED)) out.add(normNumber(m[0]));
  }
  return out;
}

function unescape(s: string): string {
  return s.replaceAll("\\'", "'").replaceAll('\\"', '"').replaceAll('\\n', '\n').replaceAll('\\t', '\t');
}

/** the part of a value the recording holds, and whether the recording cut it (`…(+N chars)`) */
export function recordedPart(text: string): [string, boolean] {
  const m = RECORDING_CUT.exec(text);
  return m ? [text.slice(0, m.index), true] : [text, false];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
}

/** The tour, keyed for the checks: candidates and chapters by id, every value's whole text. */
class Index {
  readonly tour: Msg;
  readonly cands = new Map<string, Msg>();
  readonly chapters = new Map<string, Msg>();
  readonly full: Record<string, string>;
  readonly everything: string;
  private readonly nameCache = new Map<string, boolean>();

  constructor(tour: Msg, full: Record<string, string>) {
    this.tour = tour;
    for (const c of tour.candidates || []) this.cands.set(c.id, c);
    for (const c of tour.chapters || []) this.chapters.set(c.id, c);
    this.full = full;
    const words: string[] = [];
    for (const c of this.cands.values()) {
      words.push(c.statement ?? '', c.function ?? '', c.file ?? '');
      for (const v of c.values || []) {
        words.push(v.name ?? '');
        words.push(this.valueText(v));
      }
    }
    for (const ch of this.chapters.values()) words.push(ch.title ?? '', ...(ch.opens || []));
    words.push(pyStr((tour.goal || {}).text || ''));
    this.everything = words.join('\n');
  }

  /** the whole recorded text of a tour value: from the run when known, else what the tour shows */
  valueText(v: Msg): string {
    if (Object.prototype.hasOwnProperty.call(this.full, v.id)) return this.full[v.id]!;
    if (v.sameAs) {
      for (const c of this.cands.values()) for (const w of c.values || []) if (w.id === v.sameAs) return this.valueText(w);
    }
    return String(v.text || '');
  }

  stopValues(cid: string): string[] {
    return (this.cands.get(cid)!.values || []).map((v: Msg) => this.valueText(v));
  }

  hasName(name: string): boolean {
    let hit = this.nameCache.get(name);
    if (hit === undefined) {
      const word = (w: string) => new RegExp(`(?<!${W})${escapeRe(w)}(?!${W})`, 'u').test(this.everything);
      const parts = name.split('.').filter(Boolean);
      hit = word(name) || (parts.length > 1 && parts.every(word));
      this.nameCache.set(name, hit);
    }
    return hit;
  }
}

function resolveField(c: Msg, field: unknown): Msg | null {
  const vals: Msg[] = c.values || [];
  if (typeof field !== 'string' || !field) return null;
  for (const v of vals) if (v.id === field || v.id.split('.').pop() === field) return v;
  const named = vals.filter((v) => v.name === field);
  return named.length === 1 ? named[0]! : null;
}

function nonEmpty(x: unknown): boolean {
  return typeof x === 'string' && !!x.trim();
}

/** `[violations, warnings, parts]`: `parts` holds what a merge needs (picks in run order, quotes cut) */
export function checkProse(tour: Msg, prose: unknown, full: Record<string, string>): [string[], string[], Msg] {
  const v: string[] = [];
  const w: string[] = [];
  if (!isObject(prose)) return [['the prose must be a JSON object: {"intro", "chapters", "pick", "stops"}'], w, {}];
  const ix = new Index(tour, full);
  for (const key of Object.keys(prose)) if (!TOP.includes(key)) v.push(`unknown field "${key}"; the prose has ${TOP.join(', ')}`);
  let intro: unknown = 'intro' in prose ? prose.intro : '';
  if (typeof intro !== 'string') {
    v.push('intro: must be a string');
    intro = '';
  }
  let pickRaw: unknown = prose.pick;
  if (!Array.isArray(pickRaw) || !pickRaw.every((p) => typeof p === 'string')) {
    v.push('pick: must be a list of candidate ids');
    pickRaw = [];
  }
  const pick: string[] = [];
  for (const p of pickRaw as string[]) {
    if (!ix.cands.has(p)) v.push(`pick: unknown stop id ${p}`);
    else if (pick.includes(p)) v.push(`pick: ${p} listed twice`);
    else pick.push(p);
  }
  pick.sort((a, b) => ix.cands.get(a)!.step - ix.cands.get(b)!.step);
  let stops: unknown = prose.stops;
  if (!isObject(stops)) {
    v.push('stops: must be an object keyed by candidate id');
    stops = {};
  }
  let chapters: unknown = 'chapters' in prose ? prose.chapters : {};
  if (!isObject(chapters)) {
    v.push('chapters: must be an object keyed by chapter id');
    chapters = {};
  }
  const st = stops as Msg;
  for (const sid of Object.keys(st)) {
    if (!ix.cands.has(sid)) v.push(`stops: unknown stop id ${sid}`);
    else if (!pick.includes(sid)) v.push(`stops: ${sid} has text but is not in pick`);
  }

  const quotes: Record<string, Msg> = {};
  const texts: Record<string, Msg> = {};
  for (const sid of pick) {
    const e = st[sid];
    if (!isObject(e)) {
      v.push(`stops: ${sid} is picked but has no title and text`);
      continue;
    }
    for (const key of Object.keys(e)) if (!STOP_FIELDS.includes(key)) v.push(`${sid}: unknown field "${key}"; a stop has ${STOP_FIELDS.join(', ')}`);
    for (const key of ['title', 'text']) if (!nonEmpty(e[key])) v.push(`${sid}.${key}: missing or empty`);
    const c = ix.cands.get(sid)!;
    let qtext = '';
    const q = e.quote;
    if (q !== null && q !== undefined) {
      const quote = checkQuote(sid, c, q, ix, v);
      if (quote) {
        quotes[sid] = quote;
        qtext = quote.text;
      }
    }
    const vals = ix.stopValues(sid);
    const nums = hayNumbers(...vals, c.statement ?? '', qtext);
    const strings = [...vals, qtext];
    for (const key of ['title', 'text']) if (typeof e[key] === 'string') checkText(`${sid}.${key}`, e[key], nums, strings, ix, v);
    texts[sid] = { title: 'title' in e ? e.title : '', text: 'text' in e ? e.text : '' };
    if (typeof e.text === 'string' && [...e.text.trim().matchAll(SENTENCE_END)].length > TEXT_SENTENCES) w.push(`${sid}.text: more than ${TEXT_SENTENCES} sentences`);
  }

  const pickedIn = new Map<string, string[]>();
  for (const sid of pick) {
    const ch = ix.cands.get(sid)!.chapter;
    let list = pickedIn.get(ch);
    if (!list) pickedIn.set(ch, (list = []));
    list.push(sid);
  }

  const scopeHay = (sids: string[], extra: unknown[]): [Set<string>, string[]] => {
    const strings = [...sids.flatMap((s) => ix.stopValues(s)), ...sids.filter((s) => s in quotes).map((s) => quotes[s]!.text)];
    const nums = hayNumbers(...strings, ...sids.map((s) => ix.cands.get(s)!.statement ?? ''), ...extra.map((x) => pyStr(x)));
    return [nums, strings];
  };

  const chapterTexts: Record<string, Msg> = {};
  for (const [cid, e] of Object.entries(chapters as Msg)) {
    if (!ix.chapters.has(cid)) {
      v.push(`chapters: unknown chapter id ${cid}`);
      continue;
    }
    if (!isObject(e)) {
      v.push(`chapters: ${cid} must be {title, text}`);
      continue;
    }
    for (const key of Object.keys(e)) if (!CHAPTER_FIELDS.includes(key)) v.push(`${cid}: unknown field "${key}"; a chapter has title and text`);
    if (!nonEmpty(e.title)) v.push(`${cid}.title: missing or empty`);
    const ch = ix.chapters.get(cid)!;
    const [nums, strings] = scopeHay(pickedIn.get(cid) ?? [], [...(ch.steps ?? []), ch.http ?? 0, ch.llm ?? 0]);
    for (const key of ['title', 'text']) if (typeof e[key] === 'string') checkText(`${cid}.${key}`, e[key], nums, strings, ix, v);
    chapterTexts[cid] = { title: 'title' in e ? e.title : '', text: typeof e.text === 'string' ? e.text : '' };
  }
  const run = tour.run || {};
  const [nums, strings] = scopeHay(pick, [run.steps ?? '', run.http ?? '', run.llm ?? '', run.exitCode ?? '', ix.chapters.size]);
  checkText('intro', intro as string, nums, strings, ix, v);

  // warnings: what the prompt asks for, which a merge survives without
  if (!(intro as string).trim()) w.push('intro: empty');
  for (const cid of pickedIn.keys()) if (!(cid in chapterTexts)) w.push(`${cid} holds a picked stop but has no title; the page uses the function that opens it`);
  if (isSmallTour(tour)) {
    const [lo, hi] = SMALL_PICK;
    if (!(lo <= pick.length && pick.length <= hi)) w.push(`pick: ${pick.length} stops; the prompt asks for ${lo} to ${hi}`);
  } else {
    const [lo, hi] = CHAPTER_PICK;
    for (const [cid, ch] of ix.chapters) {
      const n = (pickedIn.get(cid) ?? []).length;
      if ((ch.candidates ?? 0) >= lo && !(lo <= n && n <= hi)) w.push(`${cid}: ${n} stops; the prompt asks for ${lo} to ${hi} per chapter`);
    }
  }
  return [v, w, { pick, texts, quotes, chapters: chapterTexts, intro }];
}

function checkQuote(sid: string, c: Msg, q: unknown, ix: Index, v: string[]): Msg | null {
  if (!isObject(q)) {
    v.push(`${sid}.quote: must be {field, from, to}`);
    return null;
  }
  for (const key of Object.keys(q)) if (!QUOTE_FIELDS.includes(key)) v.push(`${sid}.quote: unknown field "${key}"; a quote has field, from, to`);
  const field = 'field' in q ? q.field : q.value;
  const val = resolveField(c, field);
  if (val === null) {
    const have = (c.values || []).map((x: Msg) => `${x.id.split('.').pop()} (${pyStr(x.name)})`).join(', ') || 'none';
    v.push(`${sid}.quote: field ${pyReprAny(field)} is not a value of this stop; it has ${have}`);
    return null;
  }
  const a = q.from;
  const b = q.to;
  const whole = ix.valueText(val);
  const [kept, isCut] = recordedPart(whole);
  if (!(Number.isInteger(a) && Number.isInteger(b) && a >= 0 && a < b)) {
    v.push(`${sid}.quote: from and to must be whole numbers with from < to, got ${pyReprAny(a)} and ${pyReprAny(b)}`);
    return null;
  }
  const len = cpLen(kept);
  if (b > len) {
    if (isCut) v.push(`${sid}.quote: range ${a}-${b} runs past character ${len}, where the recording cut ${val.id} (rerun with --max-value-chars 0 to keep it whole)`);
    else v.push(`${sid}.quote: range ${a}-${b} is outside ${val.id}, which is ${len} characters long`);
    return null;
  }
  const out: Msg = { field: val.id, name: val.name ?? '', from: a, to: b, text: cpSlice(kept, a, b), length: len };
  if (isCut) out.recordingCut = true;
  return out;
}

function checkText(where: string, text: string, nums: Set<string>, strings: string[], ix: Index, v: string[]): void {
  let rest = text;
  for (const m of text.matchAll(TICK)) {
    const span = m[1]!;
    const s = span.trim();
    if (NAME.test(s)) {
      const name = s.split('(', 1)[0]!;
      if (name && !ix.hasName(name)) v.push(`${where}: \`${span}\` does not occur in the tour's statements, functions or values`);
      rest = rest.replaceAll(`\`${span}\``, ' ');
    }
  }
  let hay: string | null = null;
  let flatHay = '';
  for (const m of rest.matchAll(SQUOTE)) {
    const q = m[1]!;
    if (hay === null) {
      hay = strings.join('\n');
      flatHay = flat(unescape(hay));
    }
    if (!hay.includes(q) && !flatHay.includes(flat(unescape(q))) && !flatHay.includes(flat(q))) {
      v.push(`${where}: '${cpSlice(q, 0, 60) + (cpLen(q) > 60 ? '…' : '')}' is not in ${scopeWords(where, false)}`);
    }
  }
  rest = rest.replace(SQUOTE, ' ');
  for (const n of textNumbers(rest)) if (!nums.has(normNumber(n))) v.push(`${where}: number ${n} is not in ${scopeWords(where)}`);
}

function scopeWords(where: string, numbers = true): string {
  if (where.startsWith('intro')) return numbers ? "the picked stops' values or the run's counts" : "the picked stops' values";
  if (/^c\d+\./.test(where)) return numbers ? 'the values of the stops picked in this chapter or its step range and counts' : 'the values of the stops picked in this chapter';
  return numbers ? "this stop's values, statement or quote" : "this stop's values";
}

/** the tour with `intro`, `pick`, `prose` counts, and `prose` on chapters and picked candidates */
export function mergeProse(tour: Msg, parts: Msg, warnings: string[]): Msg {
  const out: Msg = { ...tour };
  out.intro = parts.intro;
  out.pick = [...parts.pick];
  const order = new Map<string, number>(parts.pick.map((sid: string, k: number) => [sid, k + 1]));
  out.candidates = (tour.candidates || []).map((c: Msg) => {
    if (!order.has(c.id)) return c;
    const p: Msg = { ...parts.texts[c.id], order: order.get(c.id) };
    if (c.id in parts.quotes) p.quote = parts.quotes[c.id];
    return { ...c, prose: p };
  });
  out.chapters = (tour.chapters || []).map((ch: Msg) => (ch.id in parts.chapters ? { ...ch, prose: parts.chapters[ch.id] } : { ...ch }));
  out.prose = { stops: parts.pick.length, chapters: Object.keys(parts.chapters).length, warnings };
  return out;
}

/** check, then merge; throws `ProseRejected` with every violation */
export function applyProse(tour: Msg, prose: unknown, full: Record<string, string>): Msg {
  const [violations, warnings, parts] = checkProse(tour, prose, full);
  if (violations.length) throw new ProseRejected(violations);
  return mergeProse(tour, parts, warnings);
}
