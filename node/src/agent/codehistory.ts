/**
 * `history`: the data behind a code-history page, generated from a run.
 *
 * The page (`skills/tracelight/templates/code-history.html.hbs`) is numbered source on the left and
 * chronological checkpoints on the right. Everything on it that is a fact comes from here, and
 * every checkpoint carries in `verify` the command that prints those same values again: the
 * selectors below are the same `RunSource` methods `context`, `var` and `why` call, so a value
 * and the command beside it cannot drift apart.
 *
 * Prose (`heading`, `summary`, `title`, `text`, `note`) is left empty for the agent to fill,
 * through `--prose` or by editing. `mergeProse` refuses a prose file that tries to set a
 * generated field: a page whose numbers were typed is the thing this verb exists to prevent.
 *
 * `lang` is the page's human language (`en`, `es`); the renderer picks the syntax
 * highlighting from each file's extension, not from `lang`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { NAME } from '../protocol.ts';
import { Facts, cardValueChars, flat, flattenChain, slug, sourceWindow, stackText, valuesText } from './checkpoint.ts';
import { parseLine, type Args } from './commands.ts';
import { redact } from './redact.ts';
import { stopReason } from './render_debug.ts';
import { fileHash, readText, sha256Text } from './save.ts';
import { AgentError, callSource, type RunSource } from './source.ts';

type Msg = Record<string, any>;

export const WINDOW_MAX = 40;
export const KINDS = ['recorded step', 'live pause', 'static source', 'gloss'];
export const OUTPUT_LINES = 12;
export const SHA_PREFIX = 14;
export const PROSE_TOP = ['title', 'eyebrow', 'heading', 'subtitle', 'summary', 'historyLabel', 'scope', 'footer', 'reportHref', 'reportLabel'];
export const PROSE_STEP = ['title', 'text', 'note', 'tag'];
/** prose that is a list: links relative to the page, or http(s) URLs */
export const PROSE_LISTS = ['evidence'];

/** one selector as written on the command line: `['at', '8']`, `['var', 'total']`, `['why', [22, 'answer']]`, `['pause', null]` */
export type Selector = [string, any];

const isObj = (v: unknown): v is Msg => !!v && typeof v === 'object' && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isDigits = (s: unknown): boolean => /^\d+$/.test(String(s).replace(/^-+/, ''));

/** Python's `str()` of a JSON value */
function pyStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** The renderer's rule (`validLink` in render-code-history.cjs): no spaces or control characters, no scheme but http(s). */
export function validLink(value: unknown): boolean {
  return typeof value === 'string' && !!value && !/[\x00-\x20\x7f]/.test(value) && (!/^[a-z][a-z0-9+.-]*:/i.test(value) || /^https?:\/\//i.test(value));
}

/**
 * The `Checkpoint` argparse action: `--at`, `--var`, `--why` and `--pause` append to one
 * ordered list. A page is a narrative and its order is the one that was written; separate lists
 * would lose it.
 */
export function checkpointAction(ns: Msg, values: any, optionString: string | null, fail: (message: string) => never): void {
  const kind = (optionString || '--at').replace(/^-+/, '');
  if (kind === 'why') {
    const [step, name] = values as string[];
    if (!isDigits(step)) fail('wants STEP NAME, e.g. `--why 124 fused_ranking`');
    values = [parseInt(String(step), 10), String(name)];
  }
  const items: Selector[] = [...(ns.checkpoints ?? [])];
  items.push([kind, kind === 'pause' ? null : values]);
  ns.checkpoints = items;
}

/** Turns selectors into checkpoints, collecting the source each one needs as it goes. */
export class Builder {
  readonly source: RunSource;
  readonly runLabel: string;
  readonly pad: number;
  readonly limit: number;
  readonly scope: boolean;
  readonly chars: number;
  facts: Facts;
  readonly needed = new Map<string, Set<number>>();
  readonly paths = new Map<string, string>();
  readonly ids = new Set<string>();
  readonly truncated: string[] = [];
  readonly warnings: string[] = [];
  readonly blockText = new Map<string, Map<number, string>>();
  private readonly lines = new Map<string, string[]>();

  constructor(source: RunSource, opts: { runLabel: string; pad: number; limit: number; scope: boolean; valueChars?: number | null }) {
    this.source = source;
    this.runLabel = opts.runLabel;
    this.pad = opts.pad;
    this.limit = opts.limit;
    this.scope = opts.scope;
    this.chars = cardValueChars(source, opts.valueChars ?? null);
    this.facts = new Facts(this.chars);
  }

  async load(): Promise<this> {
    this.facts = await Facts.load(this.source, this.chars);
    return this;
  }

  // -- source ---------------------------------------------------------------------------------
  linesOf(path: string): string[] {
    let lines = this.lines.get(path);
    if (!lines) {
      try {
        lines = readText(path).split('\n');
      } catch {
        lines = [];
      }
      this.lines.set(path, lines);
    }
    return lines;
  }

  keyOf(path: string | null | undefined): string {
    const key = this.source.displayPath(path);
    this.paths.set(key, String(path || ''));
    return key;
  }

  want(key: string, start: number, end: number): void {
    if (!this.needed.has(key)) this.needed.set(key, new Set());
    const set = this.needed.get(key)!;
    for (let n = start; n <= end; n++) set.add(n);
  }

  /**
   * The source the page needs, and only that: original numbering, empty where nothing asked.
   * Disk first, then the `block.lines` the slice already carried (a live session's file can be
   * in a remote workspace the CLI cannot open).
   */
  emitFiles(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [key, wanted] of this.needed) {
      const lines = this.linesOf(this.paths.get(key) ?? '');
      const fallback = this.blockText.get(key) ?? new Map<number, string>();
      if (!lines.length && !fallback.size) this.warnings.push(`cannot read ${key}; its source panel will be empty`);
      const nums = [...wanted].sort((a, b) => a - b);
      const rows: string[] = Array(nums[nums.length - 1]!).fill('');
      for (const n of nums) {
        const text = n - 1 < lines.length ? lines[n - 1]! : (fallback.get(n) ?? '');
        // `context` redacts source on the way to a terminal; an HTML file travels further than a
        // terminal, so it is redacted here too, and the agent is told which line changed
        const safe = redact(text);
        if (safe !== text) this.warnings.push(`${key}:${n} held a secret and was redacted in the page's source`);
        rows[n - 1] = safe;
      }
      out[key] = rows;
    }
    return out;
  }

  // -- checkpoints ----------------------------------------------------------------------------
  unique(cid: string): string {
    if (!this.ids.has(cid)) {
      this.ids.add(cid);
      return cid;
    }
    let n = 2;
    while (this.ids.has(`${cid}-${n}`)) n++;
    this.ids.add(`${cid}-${n}`);
    return `${cid}-${n}`;
  }

  blank(cid: string, kind: string, tag: string): Msg {
    return {
      id: cid, kind, tag, step: null,
      title: '', text: '', note: '',
      file: '', start: 1, end: 1, focus: 1, bright: [],
      values: '', reads: [], stack: [], output: '',
      call: null, hits: null, arm: null, reason: '', chain: [],
      exception: null, http: null, gloss: null, modified: false,
      verify: '', evidence: [],
    };
  }

  /** Put a checkpoint on its source: file, range, focus, the green lines, the stack. */
  anchor(card: Msg, slice: Msg): Msg {
    const loc = isObj(slice.location) ? slice.location : {};
    const block = isObj(slice.block) ? slice.block : {};
    const path = loc.file || block.file;
    const key = this.keyOf(path);
    const focus = Math.trunc(Number(loc.line || 1));
    for (const entry of block.lines ?? []) {
      if (isObj(entry) && isInt(entry.line)) {
        if (!this.blockText.has(key)) this.blockText.set(key, new Map());
        const m = this.blockText.get(key)!;
        if (!m.has(entry.line)) m.set(entry.line, String(entry.text || ''));
      }
    }
    const [start, end, bright] = sourceWindow(block.lines ?? [], focus, this.pad, this.linesOf(String(path)).length, this.scope ? 0 : WINDOW_MAX);
    this.want(key, start, end);
    Object.assign(card, { file: key, start, end, focus, bright, stack: stackText(slice.stack ?? []) });
    const step = card.step;
    if (isInt(step)) {
      card.gloss = this.facts.glosses.get(step) ?? null;
      card.exception = this.facts.raises.get(step) ?? null;
      card.http = this.facts.requests.get(step) ?? null;
      const call = this.facts.calls.get(step);
      card.call = call && (call.in.length || call.out) ? call : null;
    }
    const fkey = Facts.key(path, focus);
    card.hits = this.facts.hits.get(fkey) ?? null;
    card.arm = this.facts.arms.get(fkey) ?? null;
    return card;
  }

  async at(spec: string): Promise<Msg[]> {
    let slice: Msg;
    if (isDigits(spec)) slice = await this.source.context({ step: parseInt(String(spec), 10), scope: this.scope });
    else {
      const [file, line] = parseLine(String(spec), '--at');
      slice = await this.source.context({ file, line, scope: this.scope });
    }
    const step = slice.step;
    const card = this.blank(this.unique(`step-${pyStr(step)}`), 'recorded step', 'RECORDED STEP');
    card.step = isInt(step) ? step : null;
    card.values = valuesText(slice.values ?? [], card.step, this.chars);
    card.verify = `${NAME} context ${this.runLabel} ${pyStr(step)} --json`;
    return [this.anchor(card, slice)];
  }

  async var(name: string): Promise<Msg[]> {
    const result: Msg = await this.source.var(name, {});
    let changes = ((result.changes ?? []) as unknown[]).filter(isObj);
    const total = Math.trunc(Number(result.total || changes.length));
    if (changes.length > this.limit) {
      this.truncated.push(`--var ${name}: ${this.limit} of ${total} changes`);
      changes = changes.slice(0, this.limit);
    }
    const cards: Msg[] = [];
    for (const [i, change] of changes.entries()) {
      const step = Math.trunc(Number(change.step));
      const slice: Msg = await this.source.context({ step, scope: this.scope });
      const card = this.blank(this.unique(`var-${slug(name)}-${i + 1}`), 'recorded step', `CHANGE ${i + 1} OF ${total}`);
      card.step = step;
      card.values = `${change.name || name} = ${flat(change.text, this.chars)}`;
      card.reads = ((change.reads ?? []) as unknown[]).filter(isObj).map((r) => `${pyStr(r.name)} = ${flat(r.text, this.chars)}${isInt(r.step) ? `   #${r.step}` : ''}`);
      card.verify = `${NAME} var ${this.runLabel} ${name} --json`;
      cards.push(this.anchor(card, slice));
    }
    return cards;
  }

  async why(step: number, name: string): Promise<Msg[]> {
    const result: Msg = await callSource(this.source, 'why', Math.trunc(step), name);
    const root = isObj(result.root) ? result.root : {};
    const at = isInt(root.step) ? root.step : Math.trunc(step);
    const slice: Msg = await this.source.context({ step: at, scope: this.scope });
    const card = this.blank(this.unique(`why-${step}-${slug(name)}`), 'recorded step', `WHY ${name.toUpperCase()}`);
    card.step = at;
    card.values = `${root.name || name} = ${flat(root.text, this.chars)}`;
    card.chain = flattenChain(root, 0, 'root', this.chars);
    card.verify = `${NAME} why ${this.runLabel} ${step} ${name} --json`;
    return [this.anchor(card, slice)];
  }

  async pause(): Promise<Msg[]> {
    const slice: Msg = await this.source.context({ scope: this.scope });
    const paused = isObj(slice.paused) ? slice.paused : null;
    if (!paused) throw new AgentError('no debug pause to capture', `pause one first: \`${NAME} break --live FILE:LINE\` then \`${NAME} continue --live\``);
    const modified = !!slice.modified;
    const tag = modified ? 'LIVE PAUSE (VALUES MODIFIED FROM THE CONSOLE)' : 'LIVE PAUSE';
    let card = this.blank(this.unique(`pause-${[...this.ids].filter((i) => i.startsWith('pause-')).length || 1}`), 'live pause', tag);
    card.step = isInt(slice.step) ? slice.step : null;
    card.values = ((slice.locals ?? []) as unknown[]).filter(isObj).map((v) => `${pyStr(v.name)} = ${flat(v.text, this.chars)}`).join('\n');
    card.modified = modified;
    const output = isObj(slice.output) ? slice.output : {};
    const tail = splitLines(String(output.text || '')).slice(-OUTPUT_LINES);
    card.output = tail.join('\n');
    card.verify = `${NAME} context ${this.runLabel} --json`;
    card = this.anchor(card, slice);
    card.reason = stopReason(paused);
    card.chain = []; // a record:false session recorded nothing behind the pause
    return [card];
  }
}

/** Python's `str.splitlines()` for the common line ends */
function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export interface BuildOptions {
  runLabel: string;
  pad?: number;
  limit?: number;
  lang?: string;
  scope?: boolean;
  valueChars?: number | null;
}

/** The whole document. `selectors` is `[kind, value]` in the order they were written. */
export async function build(source: RunSource, selectors: Selector[], opts: BuildOptions): Promise<Msg> {
  const { runLabel, pad = 2, limit = 20, lang = 'en', scope = false, valueChars = null } = opts;
  const state: Msg = await source.state();
  const stale = ((state.staleFiles ?? []) as unknown[]).map((p) => basename(String(p)));
  if (state.stale) {
    throw new AgentError(
      `stale: ${(stale.length ? stale : ['the source']).join(', ')} changed since the run`,
      `the page would show source that does not match its values; record again with \`${NAME} run FILE --save run.json\``,
    );
  }
  const builder = await new Builder(source, { runLabel, pad, limit, scope, valueChars }).load();
  const steps: Msg[] = [];
  for (const [kind, value] of selectors) {
    if (kind === 'at') steps.push(...(await builder.at(value)));
    else if (kind === 'var') steps.push(...(await builder.var(value)));
    else if (kind === 'why') steps.push(...(await builder.why(value[0], value[1])));
    else if (kind === 'pause') steps.push(...(await builder.pause()));
  }
  if (!steps.length) throw new AgentError('no checkpoints', 'pick some: `--at STEP`, `--at FILE:LINE`, `--var NAME`, `--why STEP NAME`, or `--live --pause`');
  for (const card of steps) {
    card.values = redact(card.values);
    card.reads = card.reads.map((r: string) => redact(r));
    card.output = redact(card.output);
  }
  return {
    lang,
    labels: {},
    ...Object.fromEntries(PROSE_TOP.map((f) => [f, ''])),
    meta: metaOf(source, state, runLabel, builder.truncated),
    files: builder.emitFiles(),
    steps,
    _warnings: builder.warnings,
  };
}

/** Run identity: what a reader needs to say this page and that run are the same thing. */
export function metaOf(source: RunSource, state: Msg, runLabel: string, truncated: string[]): Msg {
  const live = runLabel.startsWith('--live');
  const meta: Msg = (isObj(source.meta) ? source.meta : null) ?? {};
  const descriptor: Msg = (isObj(source.descriptor) ? source.descriptor : null) ?? {};
  const path = String(state.file || meta.file || '');
  const files: Msg[] = meta.files ?? [];
  const match = files.find((f) => resolve(String(f?.path || '')) === resolve(path));
  const sourceSha = (match ? String(match.sha256 || '') : '') || fileHash(path) || '';
  const runPath = typeof source.path === 'string' ? source.path : null;
  const out: Msg = {
    mode: live ? 'live session' : 'saved run',
    run: runLabel,
    file: basename(path),
    sourceSha256: sourceSha.slice(0, SHA_PREFIX),
    runSha256: runPath && existsSync(runPath) ? sha256Text(readText(runPath)).slice(0, SHA_PREFIX) : '',
    python: String(meta.python || ''),
    runtimeVersion: String(meta.runtimeVersion || descriptor.runtimeVersion || ''),
    exitCode: state.exitCode ?? null,
    stepCount: Math.trunc(Number((state.nav ?? {}).count || 0)),
    recordedAt: String(meta.started || descriptor.started || ''),
    truncated: [...truncated],
  };
  const debug = isObj(state.debug) ? state.debug : null;
  const paused = debug && isObj(debug.paused) ? debug.paused : null;
  if (paused) out.paused = `${basename(String(paused.file || '?'))}:${pyStr(paused.line)}`;
  return out;
}

/** The command: build, merge the prose, write the file, report what a reader can check. */
export async function writeHistory(source: RunSource, args: Args, runLabel: string): Promise<Msg> {
  let data = await build(source, args.checkpoints ?? [], {
    runLabel,
    pad: Math.max(0, Math.trunc(args.pad ?? 2)),
    limit: Math.max(1, Math.trunc(args.limit ?? 20)),
    lang: String(args.lang ?? 'en'),
    scope: !!args.scope,
    valueChars: args.value_chars ?? null,
  });
  let prosed = 0;
  if (args.prose) {
    let prose: unknown;
    try {
      prose = JSON.parse(readFileSync(String(args.prose), 'utf8'));
    } catch (e) {
      throw new AgentError(`cannot read the prose file ${args.prose}: ${(e as Error).message}`, 'a JSON object: {"heading": "...", "steps": {"step-55": {"title": "..."}}}');
    }
    mergeProse(data, prose);
    prosed = data.steps.filter((card: Msg) => card.title || card.text || card.note).length;
  }
  const warnings = data._warnings ?? [];
  delete data._warnings;
  const path = resolve(String(args.out));
  mkdirSync(dirname(path), { recursive: true });
  const added = data.steps.length;
  if (args.append && existsSync(path)) data = appendTo(path, data);
  writeFileSync(path, JSON.stringify(data, null, 1) + '\n', 'utf8');
  return {
    path,
    added,
    checkpoints: data.steps.length,
    files: Object.keys(data.files).sort(),
    prosed,
    truncated: data.meta.truncated,
    warnings,
  };
}

/**
 * Add this run's checkpoints to a page that already exists, keeping every id unique. A program
 * passes one pause at a time, so following it through several means running the verb at each.
 */
export function appendTo(path: string, data: Msg): Msg {
  let old: unknown;
  try {
    old = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new AgentError(`cannot append to ${path}: ${(e as Error).message}`, 'drop --append to start the page again');
  }
  if (!isObj(old) || !Array.isArray(old.steps)) throw new AgentError(`${path} is not a code-history page`, 'drop --append to start the page again');
  const taken = new Set(old.steps.map((card: Msg) => pyStr(card?.id)));
  for (const card of data.steps) {
    let cid = String(card.id);
    let n = 2;
    while (taken.has(cid)) {
      cid = `${card.id}-${n}`;
      n++;
    }
    taken.add(cid);
    card.id = cid;
  }
  for (const [key, lines] of Object.entries(data.files as Record<string, string[]>)) {
    const kept: string[] = [...((old.files ?? {})[key] ?? [])];
    while (kept.length < lines.length) kept.push('');
    lines.forEach((text, i) => {
      if (text) kept[i] = text;
    });
    if (!isObj(old.files)) old.files = {};
    old.files[key] = kept;
  }
  old.steps = [...old.steps, ...data.steps];
  const oldMeta: Msg = isObj(old.meta) ? old.meta : {};
  old.meta = { ...oldMeta, truncated: [...(oldMeta.truncated ?? []), ...data.meta.truncated] };
  return old;
}

/** Prose fills prose. A file that names a generated field is an error, not a silent overwrite. */
export function mergeProse(data: Msg, prose: unknown): void {
  if (!isObj(prose)) throw new AgentError('the prose file must be a JSON object', 'e.g. {"heading": "...", "steps": {"step-55": {"title": "..."}}}');
  const byId = new Map<string, Msg>(data.steps.map((card: Msg) => [card.id, card]));
  for (const [key, value] of Object.entries(prose)) {
    if (key === 'steps') continue;
    if (!PROSE_TOP.includes(key)) throw new AgentError(`prose may not set "${key}"`, `prose fields: ${PROSE_TOP.join(', ')}, and steps`);
    data[key] = pyStr(value);
  }
  for (const [cid, fields] of Object.entries(isObj(prose.steps) ? prose.steps : {})) {
    const card = byId.get(cid);
    if (!card) throw new AgentError(`no checkpoint ${cid} in this page`, `its checkpoints: ${[...byId.keys()].slice(0, 12).join(', ')}`);
    for (const [field, value] of Object.entries(isObj(fields) ? fields : {})) {
      if (PROSE_LISTS.includes(field)) {
        if (!Array.isArray(value) || !value.every(validLink)) throw new AgentError(`prose "${field}" on ${cid} must be a list of links`, 'e.g. "evidence": ["notes/run.txt", "https://example.com/issue/1"]');
        card[field] = [...value];
        continue;
      }
      if (!PROSE_STEP.includes(field)) throw new AgentError(`prose may not set "${field}" on ${cid}: it comes from the run`, `prose fields on a checkpoint: ${[...PROSE_STEP, ...PROSE_LISTS].join(', ')}`);
      card[field] = pyStr(value);
    }
  }
}
