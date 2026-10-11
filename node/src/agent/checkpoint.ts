/**
 * The parts one code-history checkpoint is made of, as Pyokka's `agent/checkpoint.py`: pure
 * functions plus one index.
 *
 * The history document (`codehistory.ts`, later) assembles the page; everything here shapes a
 * single card: its values, its call stack, the source window the left panel shows, the
 * provenance chain as an indented list, and `Facts`, which reads the walkthrough, the graph, the
 * exceptions report and the HTTP table once so twenty checkpoints cost four reads of the run.
 */
import { basename } from 'node:path';
import { LOG_CHARS, valueChars } from './protocol.ts';
import { cutLine, pyStrip } from './recording.ts';
import { AgentError, callSource, type RunSource } from './source.ts';

type Msg = Record<string, any>;

/** a card value from a run that does not say its limit (a live session): as long as a logged value */
export const VALUE_MAX = LOG_CHARS;
export const WINDOW_MAX = 40;

/** one line, bounded: a value in a card is read at a glance, not scrolled */
export function flat(text: unknown, limit = VALUE_MAX): string {
  return cutLine(text, limit, true);
}

/**
 * How much of one value a card shows: `setting` (`--value-chars`, 0 for all of it), else the
 * run's own limit (`--max-value-chars`), else 200, which shows a default run's values whole.
 */
export function cardValueChars(source: unknown, setting: number | null = null): number {
  if (setting !== null && setting !== undefined) return valueChars(setting, VALUE_MAX);
  const config = ((source as Msg | null)?.meta ?? {}).config ?? {};
  return valueChars(config.maxValueChars, VALUE_MAX);
}

export function slug(text: unknown): string {
  return String(text || '').replace(/[^A-Za-z0-9_.]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** `name = value` per line; a value logged at another step keeps its `#step` */
export function valuesText(values: unknown[], step: number | null = null, limit = VALUE_MAX): string {
  const out: string[] = [];
  for (const v of (values ?? []) as Msg[]) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const name = v.context;
    let line = name ? `${name} = ${flat(v.text, limit)}` : flat(v.text, limit);
    const at = v.step;
    if (isInt(at) && step !== null && at !== step) line += `   #${at}`;
    out.push(line);
  }
  return out.join('\n');
}

export function stackText(stack: unknown[]): string[] {
  const out: string[] = [];
  for (const f of (stack ?? []) as Msg[]) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) continue;
    if (f.elided) {
      // a run of library frames the slice folded: kept as one line, not dropped twice
      out.push(`… ${Math.trunc(Number(f.elided))} library frames`);
      continue;
    }
    const where = `${basename(String(f.file || '?'))}:${pyText(f.line)}`;
    const at = f.step;
    out.push(`${f.function || '<module>'} ${where}${isInt(at) ? `   #${at}` : ''}`);
  }
  return out;
}

/** `%s` of a JSON value the way Python prints it: None, True, False */
export function pyText(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  return String(v);
}

/**
 * The left panel's range and its green lines: the block widened by `pad`, clamped to the file.
 * A block wider than `spanMax` is centred on the focus instead; `--scope` passes 0 and takes
 * the block whole.
 */
export function sourceWindow(blockLines: unknown[], focus: number, pad: number, fileLen: number, spanMax = WINDOW_MAX): [number, number, number[]] {
  const nums = [...new Set(((blockLines ?? []) as Msg[]).filter((l) => l && typeof l === 'object' && isInt(l.line)).map((l) => Number(l.line)))].sort((a, b) => a - b);
  const lo = nums.length ? Math.min(...nums, focus) : focus;
  const hi = nums.length ? Math.max(...nums, focus) : focus;
  let start = Math.max(1, lo - pad);
  let end = Math.max(start, Math.min(fileLen || hi, hi + pad));
  if (spanMax && end - start + 1 > spanMax) {
    start = Math.max(1, focus - Math.floor(spanMax / 2));
    end = Math.min(fileLen || start + spanMax - 1, start + spanMax - 1);
    start = Math.max(1, Math.min(start, end));
  }
  return [start, end, nums.filter((n) => start <= n && n <= end)];
}

/** Python's `os.path.commonprefix` over strings */
export function commonPrefix(items: string[]): string {
  if (!items.length) return '';
  let lo = items.reduce((a, b) => (a < b ? a : b));
  const hi = items.reduce((a, b) => (a > b ? a : b));
  let i = 0;
  while (i < lo.length && i < hi.length && lo[i] === hi[i]) i++;
  lo = lo.slice(0, i);
  return lo;
}

/**
 * One line for a decision the run met more than once: `if row < 0 took false x2, true x1`. A
 * branch that went both ways has to say so, or the page argues from one pass.
 */
export function armText(texts: string[]): string {
  const counts = new Map<string, number>();
  for (const t of texts) counts.set(t, (counts.get(t) ?? 0) + 1);
  if (counts.size === 1) {
    const [text, n] = [...counts.entries()][0]!;
    return n === 1 ? text : `${text}, entered ${n} times`;
  }
  const head = commonPrefix([...counts.keys()]).replace(/\s+$/, '');
  // Counter.most_common: by count, ties in first-seen order
  const common = [...counts.entries()].map((e, i) => [e, i] as const).sort((a, b) => b[0][1] - a[0][1] || a[1] - b[1]).map((x) => x[0]);
  return `${head} ${common.map(([t, n]) => `${pyStrip(t.slice(head.length))} x${n}`).join(', ')}`;
}

/** `why`'s tree as an indented list: `depth` keeps the shape, `via` says how we got here */
export function flattenChain(node: unknown, depth = 0, via = 'root', limit = VALUE_MAX): Msg[] {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return [];
  const n = node as Msg;
  const out: Msg[] = [{
    depth,
    via,
    name: String(n.name || ''),
    text: n.text !== null && n.text !== undefined ? flat(n.text, limit) : '?',
    // a leaf of a recording that began at a pause: the value was made before step 0
    statement: n.beforeRecording ? 'made before #0, where the recording started' : flat(n.statement, 100),
    location: n.file ? `${basename(String(n.file || ''))}:${pyText(n.line)}` : '',
    step: isInt(n.step) ? n.step : null,
  }];
  for (const read of n.reads ?? []) out.push(...flattenChain(read, depth + 1, 'reads', limit));
  for (const call of n.calls ?? []) {
    if (!call || typeof call !== 'object' || Array.isArray(call)) continue;
    const inputs = ((call.inputs ?? []) as Msg[]).filter((i) => i && typeof i === 'object' && !Array.isArray(i)).map((i) => `${pyText(i.name)} = ${flat(i.text, Math.min(60, limit))}`).join(', ');
    out.push({
      depth: depth + 1,
      via: 'calls',
      name: String(call.name || ''),
      text: inputs,
      statement: '',
      location: call.file ? `${basename(String(call.file || ''))}:${pyText(call.line)}` : '',
      step: isInt(call.entryStep) ? call.entryStep : null,
    });
  }
  return out;
}

/**
 * What the other reports know about a step, indexed once: calls, hits, arms, raises, requests.
 * Each report is read with `callSource` (`walkthrough`, `graph`, `exceptions`, `http`); a source
 * that refuses one (or a report not ported yet) leaves its part empty. `Facts.load` awaits them.
 */
export class Facts {
  readonly valueLimit: number;
  readonly calls = new Map<number, Msg>();
  arms = new Map<string, string>();
  readonly hits = new Map<string, number>();
  readonly glosses = new Map<number, string>();
  readonly raises = new Map<number, string>();
  readonly requests = new Map<number, string>();

  constructor(valueLimit = VALUE_MAX) {
    this.valueLimit = valueLimit;
  }

  static async load(source: RunSource, valueLimit = VALUE_MAX): Promise<Facts> {
    const f = new Facts(valueLimit);
    for (const load of [f.walkthrough, f.graph, f.exceptions, f.http]) {
      try {
        await load.call(f, source);
      } catch (e) {
        if (!(e instanceof AgentError || e instanceof TypeError || e instanceof RangeError)) throw e;
      }
    }
    return f;
  }

  /** the index key of a line: the file's basename and the line */
  static key(file: unknown, line: unknown): string {
    return `${basename(String(file || ''))}:${Math.trunc(Number(line || 0))}`;
  }

  async walkthrough(source: RunSource): Promise<void> {
    const arms = new Map<string, string[]>();
    for (const m of ((await callSource(source, 'walkthrough', {})).moments ?? []) as Msg[]) {
      const step = m.step;
      if (m.gloss) this.glosses.set(Number(step), String(m.gloss));
      if (m.kind === 'call') {
        const callee = m.callee && typeof m.callee === 'object' ? m.callee : {};
        const values = ((m.values ?? []) as Msg[]).filter((v) => v && typeof v === 'object');
        const fmt = (v: Msg) => `${pyText(v.name)} = ${flat(v.text, this.valueLimit)}`;
        const outV = values.find((v) => v.role === 'out');
        this.calls.set(Number(step), { name: String(callee.function || '?'), in: values.filter((v) => v.role === 'in').map(fmt), out: outV ? fmt(outV) : '' });
      } else if (m.kind === 'decision') {
        const loc = m.location && typeof m.location === 'object' ? m.location : {};
        const key = Facts.key(loc.file, loc.line);
        if (!arms.has(key)) arms.set(key, []);
        arms.get(key)!.push(String(m.text || ''));
      }
    }
    this.arms = new Map([...arms].map(([k, texts]) => [k, armText(texts)]));
  }

  async graph(source: RunSource): Promise<void> {
    for (const n of ((await callSource(source, 'graph', {})).nodes ?? []) as Msg[]) {
      if ((n.kind === 'statement' || n.kind === 'decision') && isInt(n.hits)) this.hits.set(Facts.key(n.file, n.line), n.hits);
    }
  }

  async exceptions(source: RunSource): Promise<void> {
    for (const row of ((await callSource(source, 'exceptions')).rows ?? []) as Msg[]) {
      const raised = row.raisedAt && typeof row.raisedAt === 'object' ? row.raisedAt : {};
      const handled = row.handledAt && typeof row.handledAt === 'object' ? row.handledAt : null;
      let text = `${pyText(row.errorType)}: ${flat(row.message, 100)}`;
      text += `   raised ${basename(String(raised.file || '?'))}:${pyText(raised.line)}`;
      text += handled ? `   caught ${basename(String(handled.file || '?'))}:${pyText(handled.line)}${handled.broad ? ' (broad handler)' : ''}` : '   uncaught';
      this.raises.set(Math.trunc(Number(row.step || -1)), text);
    }
  }

  async http(source: RunSource): Promise<void> {
    for (const r of ((await callSource(source, 'http')).requests ?? []) as Msg[]) {
      if (!isInt(r.step)) continue;
      this.requests.set(r.step, `${pyText(r.method)} ${flat(r.url, 80)}  ${pyText(r.status)}  ${pyText(r.ms)} ms  ${pyText(r.source)}`);
    }
  }
}
