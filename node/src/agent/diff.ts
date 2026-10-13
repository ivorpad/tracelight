/**
 * `diff A B`: what an edit changed between two runs, statement by statement.
 *
 * Each side is a `RunSource` (a saved run, or the open VS Code session with `--live`) and is read
 * only through the verbs both kinds serve: `state`, `walkthrough` (uncapped, by step window) and
 * `var` for every name a statement of the user's files assigns. So the facts are the ones those
 * verbs print: values a statement assigned, the arm a branch took, how often a loop ran, the calls a
 * statement made with their arguments, prints, logged values, raises.
 *
 * Matching. Each user file is parsed into statements (`diff_match.ts`, from the oxc AST: simple
 * statements and compound headers, with the enclosing function). The two versions of a file are
 * aligned with difflib's algorithm over `(function, normalized text)`, so whitespace, comments and
 * line shifts do not matter. Equal statements pair up; in a block that changed, statements pair by
 * position when they are in the same function (`edited`), the rest are `added` or `removed`. Facts
 * then pair by hit: with as many hits on both sides the nth value of `total` on a statement in A
 * goes against the nth in B; with a different count they are aligned so a hit inserted early does
 * not shift every later one.
 *
 * A saved run reads its files from the redacted copy `run --save` keeps in `meta.files[].source`,
 * so the run from before the edit still has the text that ran. An older run without that copy
 * falls back to the file on disk and says so. Both sides parse the redacted text, so a secret in the
 * source never decides a match and never prints.
 */
import { basename, dirname } from 'node:path';
import { NAME } from '../protocol.ts';
import { pyText } from './checkpoint.ts';
import { assignedNames, capFacts, compareHits, opcodes, pairStatements, parseStatements, safeSource, type Stmt } from './diff_match.ts';
import { oneLine } from './render.ts';
import { readText } from './save.ts';
import { AgentError, SavedRun, callSource, displayPath, type RunSource } from './source.ts';
import { isUserFile } from './walkthrough.ts';

type Msg = Record<string, any>;
type Channel = (string | null)[];

export const VAR_LIMIT = 100_000;
const TOOK = / took (.+)$/;
const RAN = / ran (\d+) times?$/;

// -- one side -------------------------------------------------------------------------------------------------

/** One run of the pair: its source, its user files' text and statements, its facts. */
export class Side {
  readonly tag: string;
  readonly label: string;
  readonly source: RunSource;
  readonly notes: string[] = [];
  count = 0;
  exitCode: unknown = null;
  main = '';
  root = '';
  recordedLocals = true;
  readonly texts = new Map<string, string>();
  readonly stmts = new Map<string, Stmt[]>();
  private readonly starts = new Map<string, Map<number, Stmt>>();

  private constructor(tag: string, label: string, source: RunSource) {
    this.tag = tag;
    this.label = label;
    this.source = source;
  }

  static async open(tag: string, label: string, source: RunSource): Promise<Side> {
    const side = new Side(tag, label, source);
    const state = (await source.state()) as Msg;
    side.count = Number((state.nav ?? {}).count || 0);
    side.exitCode = state.exitCode ?? null;
    side.main = String(state.file || source.file || '');
    side.root = String(source.workspaceRoot || dirname(side.main));
    if (source instanceof SavedRun) {
      // a VS Code session records locals only with tracelight.timeMachine.recordLocals on, `run --save` unless --no-locals
      const config = source.meta.config ?? {};
      side.recordedLocals = config && typeof config === 'object' && 'recordLocals' in config ? !!config.recordLocals : source.localsEntries.length > 0;
      side.savedTexts(source);
    } else if (side.main) side.textOf(side.main);
    return side;
  }

  private savedTexts(run: SavedRun): void {
    const stale = new Set(run.staleFiles());
    const kept = new Map<string, string>();
    for (const f of run.meta.files ?? []) if (f && typeof f.source === 'string') kept.set(String(f.path), f.source);
    for (const [fid, f] of run.files) {
      const path = String(f.path);
      if (!isUserFile(path, this.root, this.main)) continue;
      if (!kept.has(path) && stale.has(path)) this.notes.push(`${this.tag}: ${this.display(path)} changed since this run and the run keeps no copy of it, so its statements are read from the file as it is now; record it again for a clean diff`);
      const text = safeSource(kept.has(path) ? kept.get(path)! : run.sourceLines(fid).join('\n'));
      (run as any).sources.set(fid, text.split('\n')); // the text that ran, for every verb this diff calls
      this.texts.set(path, text);
      this.stmts.set(path, parseStatements(text, path));
    }
  }

  display(path: string | null | undefined): string {
    return displayPath(path, this.root);
  }

  user(path: string | null | undefined): boolean {
    return !!path && isUserFile(path, this.root, this.main);
  }

  textOf(path: string): string | null {
    if (!this.texts.has(path)) {
      try {
        this.texts.set(path, safeSource(readText(path)));
      } catch {
        return null;
      }
      this.stmts.set(path, parseStatements(this.texts.get(path)!, path));
    }
    return this.texts.get(path)!;
  }

  statementAt(path: string, line: number): Stmt | null {
    if (this.textOf(path) === null) return null;
    let starts = this.starts.get(path);
    if (!starts) {
      starts = new Map((this.stmts.get(path) ?? []).map((s) => [s.line, s]));
      this.starts.set(path, starts);
    }
    if (starts.has(line)) return starts.get(line)!;
    const inside = (this.stmts.get(path) ?? []).filter((s) => s.line <= line && line <= s.end);
    return inside.length ? inside[inside.length - 1]! : null;
  }

  /** `{path, line, channel, text, step, ...}` per fact, in step order */
  async collect(): Promise<Msg[]> {
    const facts: Msg[] = [];
    const end = Math.max(0, this.count - 1);
    const w = this.count ? ((await callSource(this.source, 'walkthrough', { start: 0, end })) as Msg) : { moments: [] };
    for (const m of w.moments ?? []) {
      const loc = m.location ?? {};
      const path = loc.file;
      if (!this.user(path)) continue;
      this.textOf(String(path));
      const callee = m.callee ?? {};
      if (callee.file && this.user(callee.file)) this.textOf(String(callee.file));
      const fact = momentFact(m);
      if (fact !== null) {
        Object.assign(fact, { path: String(path), line: Number(loc.line || 0), step: Number(m.step || 0) });
        facts.push(fact);
      }
    }
    const names = new Set<string>();
    for (const [path, text] of this.texts) for (const n of assignedNames(text, path)) names.add(n);
    const seen = new Set<string>();
    for (const name of names) {
      let res: Msg;
      try {
        res = (await this.source.var(name, { limit: VAR_LIMIT })) as Msg;
      } catch (e) {
        if (e instanceof AgentError) continue;
        throw e;
      }
      if (res.recordedLocals === false) this.recordedLocals = false;
      for (const ch of res.changes ?? []) {
        if (ch.name !== name || !this.user(ch.file)) continue;
        const step = Number(ch.step || 0);
        const key = `${step}\0${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        facts.push({ path: String(ch.file), line: Number(ch.line || 0), step, channel: ['value', name], text: ch.text ?? null, source: ch.source ?? null });
      }
    }
    return facts.map((f, i) => [f, i] as const).sort((x, y) => x[0].step - y[0].step || x[1] - y[1]).map(([f]) => f);
  }
}

function values(m: Msg, role: string): Msg[] {
  return (m.values ?? []).filter((v: Msg) => v.role === role);
}

/** the fact a walkthrough moment is: a call with its arguments, the arm a branch took, a loop's count, a print, a logged value, a raise */
export function momentFact(m: Msg): Msg | null {
  const kind = m.kind;
  const text = String(m.text || '');
  if (kind === 'call' || kind === 'tool') {
    const callee = String((m.callee ?? {}).function || '?');
    const args = values(m, 'in').map((v) => `${pyText(v.name)}=${pyText(v.text)}`).join(', ');
    const outs = values(m, 'out');
    const raisedV = outs.find((v) => v.name === 'raised');
    const returnedV = outs.find((v) => v.name !== 'raised');
    const raised = raisedV ? pyText(raisedV.text) : null;
    const returned = returnedV ? pyText(returnedV.text) : null;
    const tail = raised ? ` raised ${raised}` : '';
    const end = m.endStep; // where the value was returned: a changed return is dated there, after what changed inside the callee
    return { channel: ['call', callee], text: `${callee}(${args})${tail}`, bare: `${callee}(…)${tail}`, returned, returnStep: end !== null && end !== undefined ? Number(end) : null };
  }
  if (kind === 'decision') {
    const took = TOOK.exec(text);
    if (took) return { channel: ['branch'], text: took[1] };
    const ran = RAN.exec(text);
    if (ran) return { channel: ['loop'], text: `${ran[1]} time${ran[1] === '1' ? '' : 's'}` };
    return { channel: ['decision'], text };
  }
  if (kind === 'print') return { channel: ['print'], text: text.startsWith('prints ') ? text.slice('prints '.length) : text };
  if (kind === 'value') {
    const v = (m.values ?? [{}])[0] ?? {};
    return { channel: ['log', String(v.name || 'value')], text: String(v.text || text) };
  }
  if (kind === 'error') return { channel: ['error'], text: text.startsWith('raised ') ? text.slice('raised '.length) : text };
  return null;
}

// -- pairing statements -----------------------------------------------------------------------------------------

/** `[path in a, path in b]`: the main files always pair, the rest by workspace-relative path, then by basename */
function pairFiles(a: Side, b: Side): [string | null, string | null][] {
  const pairs: [string | null, string | null][] = [];
  const left = [...a.texts.keys()].filter((p) => p !== a.main);
  const right = [...b.texts.keys()].filter((p) => p !== b.main);
  if (a.texts.has(a.main) || b.texts.has(b.main)) pairs.push([a.texts.has(a.main) ? a.main : null, b.texts.has(b.main) ? b.main : null]);
  for (const p of [...left]) {
    let q = right.find((q) => b.display(q) === a.display(p)) ?? null;
    if (q === null) {
      const same = right.filter((q) => basename(q) === basename(p));
      q = same.length === 1 ? same[0]! : null;
    }
    if (q !== null) {
      pairs.push([p, q]);
      left.splice(left.indexOf(p), 1);
      right.splice(right.indexOf(q), 1);
    }
  }
  for (const p of left) pairs.push([p, null]);
  for (const q of right) pairs.push([null, q]);
  return pairs;
}

// -- the diff ---------------------------------------------------------------------------------------------------

/**
 * The facts both sides can have. Values a statement assigned and a call's arguments come from
 * recorded locals; when one side has none, only logged values and the call itself are compared.
 */
export function comparable(facts: Msg[], withLocals: boolean): Msg[] {
  const out: Msg[] = [];
  for (let f of facts) {
    const kind = f.channel[0];
    if (kind === 'value') {
      if (!withLocals && f.source !== 'value') continue;
      f = { ...f, text: f.text === null || f.text === undefined ? '(value not recorded)' : pyText(f.text) };
    } else if (kind === 'call' && !withLocals) f = { ...f, text: f.bare, returned: null };
    out.push(f);
  }
  return out;
}

function localsNote(side: Side): string {
  const where = side.label === '--live' ? "the session's tracelight.timeMachine.recordLocals (Record Variable Changes) is off" : 'it was saved with --no-locals';
  return `${side.tag} recorded no locals (${where}), so assigned values and call arguments are left out; record both with locals to compare them`;
}

/** Python's tuple order for channels: element by element, a shorter prefix first */
function channelOrder(x: Channel, y: Channel): number {
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const a = String(x[i]);
    const b = String(y[i]);
    if (a !== b) return a < b ? -1 : 1;
  }
  return x.length - y.length;
}

export async function diffSides(a: Side, b: Side, opts: { limit?: number; ignore?: string[] } = {}): Promise<Msg> {
  const limit = opts.limit ?? 40;
  const rawA = await a.collect();
  const rawB = await b.collect();
  const withLocals = a.recordedLocals && b.recordedLocals;
  const ignored = new Set(opts.ignore ?? []);
  const keep = (fact: Msg): boolean => !(['value', 'log'].includes(fact.channel[0]) && ignored.has(fact.channel[1]));
  const factsA = comparable(rawA, withLocals).filter(keep);
  const factsB = comparable(rawB, withLocals).filter(keep);
  for (const side of [a, b]) if (!side.recordedLocals) side.notes.push(localsNote(side));
  const entries: Msg[] = [];
  const indexA = new Map<string, number>();
  const indexB = new Map<string, number>();
  const counts: Record<string, number> = { same: 0, edited: 0, added: 0, removed: 0 };
  for (const [pa, pb] of pairFiles(a, b)) {
    const [pairs] = pairStatements(pa ? (a.stmts.get(pa) ?? []) : [], pb ? (b.stmts.get(pb) ?? []) : []);
    for (const [sa, sb, status] of pairs) {
      counts[status]!++;
      const i = entries.length;
      const s = (sb ?? sa)!;
      entries.push({
        file: pb ? b.display(pb) : a.display(pa),
        fileA: pa ? a.display(pa) : null,
        fileB: pb ? b.display(pb) : null,
        lineA: sa ? sa.line : null,
        lineB: sb ? sb.line : null,
        function: s.function,
        textA: sa ? sa.text : null,
        textB: sb ? sb.text : null,
        status,
        ...(status === 'edited' && sa && sb ? { sourceA: sa.source, sourceB: sb.source } : {}),
        def: s.kind === 'def',
      });
      if (sa && pa) indexA.set(`${pa}\0${sa.line}`, i);
      if (sb && pb) indexB.set(`${pb}\0${sb.line}`, i);
    }
  }

  const group = (side: Side, facts: Msg[], index: Map<string, number>): Map<number, Map<string, [Channel, Msg[]]>> => {
    const out = new Map<number, Map<string, [Channel, Msg[]]>>();
    for (const f of facts) {
      const s = side.statementAt(f.path, f.line);
      if (s === null) continue;
      const i = index.get(`${f.path}\0${s.line}`);
      if (i === undefined || (entries[i]!.def && f.channel[0] === 'value')) continue; // parameters bound at a function header are the call's arguments, shown on the call
      if (!out.has(i)) out.set(i, new Map());
      const byChannel = out.get(i)!;
      const key = JSON.stringify(f.channel);
      if (!byChannel.has(key)) byChannel.set(key, [f.channel, []]);
      byChannel.get(key)![1].push(f);
    }
    return out;
  };

  const ga = group(a, factsA, indexA);
  const gb = group(b, factsB, indexB);
  const changed: Msg[] = [];
  for (const i of [...new Set([...ga.keys(), ...gb.keys()])].sort((x, y) => x - y)) {
    const ca = ga.get(i) ?? new Map();
    const cb = gb.get(i) ?? new Map();
    const channels = new Map<string, Channel>();
    for (const [k, [ch]] of [...ca, ...cb]) channels.set(k, ch);
    const facts: Msg[] = [];
    for (const [k, ch] of [...channels].sort((x, y) => channelOrder(x[1], y[1]))) facts.push(...compareHits(ch, ca.get(k)?.[1] ?? [], cb.get(k)?.[1] ?? []));
    if (!facts.length) continue;
    const e: Msg = { ...entries[i]! };
    delete e.def;
    const at = (f: Msg) => Number((f.b || f.a || {}).step ?? 0);
    e.facts = capFacts(facts.map((f, n) => [f, n] as const).sort((x, y) => at(x[0]) - at(y[0]) || x[1] - y[1]).map(([f]) => f));
    const stepsB = facts.filter((f) => f.b).map((f) => f.b.step);
    const stepsA = facts.filter((f) => f.a).map((f) => f.a.step);
    e.stepA = stepsA.length ? Math.min(...stepsA) : null;
    e.stepB = stepsB.length ? Math.min(...stepsB) : null;
    changed.push(e);
  }
  const sortKey = (e: Msg): [number, number] => [e.stepB !== null ? e.stepB : e.stepA, e.stepA !== null ? e.stepA : -1];
  changed.sort((x, y) => {
    const [x0, x1] = sortKey(x);
    const [y0, y1] = sortKey(y);
    return x0 - y0 || x1 - y1;
  });
  let first: Msg | null = null;
  if (changed.length) {
    const e = changed[0]!;
    first = { file: e.file, lineA: e.lineA, lineB: e.lineB, stepA: e.stepA, stepB: e.stepB };
  }
  return {
    a: { run: a.label, file: a.main, count: a.count, exitCode: a.exitCode },
    b: { run: b.label, file: b.main, count: b.count, exitCode: b.exitCode },
    matching: { same: counts.same, edited: counts.edited, added: counts.added, removed: counts.removed },
    notes: [...a.notes, ...b.notes, ...(ignored.size ? ['Ignored value/log names: ' + [...ignored].join(', ') + '. Calls, printed output and decisions are still compared.'] : [])],
    firstDifference: first,
    total: changed.length,
    shown: Math.min(changed.length, limit),
    statements: changed.slice(0, limit),
    staleFiles: [],
  };
}

// -- opening the pair ------------------------------------------------------------------------------------------

/** Both sides, opened by the verb's `open` */
export class DiffPair {
  readonly a: Side;
  readonly b: Side;
  readonly workspaceRoot: string;

  constructor(a: Side, b: Side) {
    this.a = a;
    this.b = b;
    this.workspaceRoot = b.root;
  }

  displayPath(path: string | null | undefined): string {
    return displayPath(path, this.workspaceRoot);
  }

  staleFiles(): string[] {
    return [];
  }

  async close(): Promise<void> {
    for (const side of [this.a, this.b]) {
      try {
        await side.source.close();
      } catch {
        // already gone
      }
    }
  }
}

export const USAGE_HINT = `\`${NAME} diff before.json after.json\`, or \`${NAME} diff before.json --live\` for the open session as the after`;

/** `[a, b]` as Sides; `openLive(file)` opens the live session (the after) for `--live` */
export async function openPair(args: Msg, openLive: (file: string | null) => Promise<RunSource>): Promise<DiffPair> {
  const runs: string[] = (args.runs ?? []).filter(Boolean).map(String);
  if (args.live || args.session) {
    if (runs.length !== 1) throw new AgentError('diff --live takes one saved run, the before; the live session is the after', USAGE_HINT);
    const a = await Side.open('a', runs[0]!, new SavedRun(runs[0]!));
    const live = await openLive(a.main || null);
    try {
      return new DiffPair(a, await Side.open('b', '--live', live));
    } catch (e) {
      await live.close();
      throw e;
    }
  }
  if (runs.length !== 2) throw new AgentError(`diff needs two runs, got ${runs.length}`, USAGE_HINT);
  return new DiffPair(await Side.open('a', runs[0]!, new SavedRun(runs[0]!)), await Side.open('b', runs[1]!, new SavedRun(runs[1]!)));
}

/** `source` is the pair `openPair` made, or (in the shell) the live session as the after */
export async function diffCommand(args: Msg, source: unknown): Promise<Msg> {
  const limit = Math.max(1, Number(args.limit ?? 40) || 40);
  if (source instanceof DiffPair) return diffSides(source.a, source.b, { limit, ignore: args.ignore ?? [] });
  const runs: string[] = (args.runs ?? []).filter(Boolean).map(String);
  if (runs.length !== 1) throw new AgentError('in the shell, diff takes one saved run, the before; the live session is the after', 'e.g. `diff before.json`');
  return diffSides(await Side.open('a', runs[0]!, new SavedRun(runs[0]!)), await Side.open('b', '--live', source as RunSource), { limit, ignore: args.ignore ?? [] });
}

// -- text -----------------------------------------------------------------------------------------------------

function where(e: Msg): string {
  if (e.status === 'removed') return `${e.fileA}:${e.lineA} in a`;
  if (e.status === 'added') return `${e.fileB}:${e.lineB}`;
  const name = e.fileA === e.fileB ? e.fileB : `${e.fileB} (a: ${e.fileA})`;
  const line = e.lineA === e.lineB ? String(e.lineB) : `${e.lineA}→${e.lineB}`;
  return `${name}:${line}`;
}

function steps(f: Msg): string {
  return [f.a ? `a#${f.a.step}` : '', f.b ? `b#${f.b.step}` : ''].filter(Boolean).join('  ');
}

const LABEL: Record<string, string> = { call: 'call ', print: 'printed ', error: 'raised ', branch: 'took ', loop: 'ran ', decision: '' };

function factLine(f: Msg): string {
  const kind = f.kind;
  const name = f.name ?? null;
  if ('more' in f) return `  … ${f.more} more differing ${name ? `hits of ${name}` : 'hits'}`;
  const a = f.a;
  const b = f.b;
  if (kind === 'return') return `  ${oneLine(f.call, 80)} returned ${oneLine(a.text, 60)} → ${oneLine(b.text, 60)}   ${steps(f)}`;
  const label = kind === 'value' || kind === 'log' ? `${pyText(name)} = ` : (LABEL[kind] ?? '');
  if (a && b) return `  ${label}${oneLine(a.text, 80)} → ${oneLine(b.text, 80)}   ${steps(f)}`;
  const only = a || b;
  return `  ${label}${oneLine(only.text, 120)}   only in ${a ? 'a' : 'b'}   ${steps(f)}`;
}

const EDIT_WIDTH = 120; // characters of one changed line shown
const EDIT_LEAD = 30; // of them, how many come before the first character that differs

/** `line` from `start` on, `EDIT_WIDTH` characters, with `…` where it was cut */
function window(line: string, start: number): string {
  const chars = [...line];
  const head = start > 0 ? '…' : '';
  const rest = chars.slice(start);
  return head + (rest.length > EDIT_WIDTH ? rest.slice(0, EDIT_WIDTH).join('') + '…' : rest.join(''));
}

/** two versions of a line, each cut to a window that starts a little before the first character that differs */
function changedPair(a: string, b: string): [string, string] {
  const ca = [...a];
  const cb = [...b];
  if (ca.length <= EDIT_WIDTH && cb.length <= EDIT_WIDTH) return [a, b];
  let p = 0;
  while (p < Math.min(ca.length, cb.length) && ca[p] === cb[p]) p++;
  const start = Math.max(0, p - EDIT_LEAD);
  return [window(a, start), window(b, start)];
}

/**
 * The lines of an edited statement that changed, as `  - old` / `  + new`.
 *
 * A statement spans lines; the ones both versions share are left out, and when the change is
 * below the first line, that line comes first as context (`    scores = rrf( …`). A long line
 * is shown from shortly before its first differing character.
 */
export function editedLines(textA: string | null | undefined, textB: string | null | undefined): string[] {
  const split = (t: string | null | undefined) => (t || '').split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean);
  const la = split(textA);
  const lb = split(textB);
  const ops = opcodes(la, lb).filter((op) => op[0] !== 'equal');
  const context: string[] = [];
  if (ops.length && la.length && Math.min(ops[0]![1], ops[0]![3]) > 0) context.push(`    ${window(la[0]!, 0)}${la.length > 1 ? ' …' : ''}`);
  const minus: string[] = [];
  const plus: string[] = [];
  for (const [, i1, i2, j1, j2] of ops) {
    const old = la.slice(i1, i2);
    const neu = lb.slice(j1, j2);
    for (let k = 0; k < Math.max(old.length, neu.length); k++) {
      if (k < old.length && k < neu.length) {
        const [x, y] = changedPair(old[k]!, neu[k]!);
        minus.push('  - ' + x);
        plus.push('  + ' + y);
      } else if (k < old.length) minus.push('  - ' + window(old[k]!, 0));
      else plus.push('  + ' + window(neu[k]!, 0));
    }
  }
  return [...context, ...minus, ...plus];
}

export function renderDiff(result: Msg): string[] {
  const a = result.a;
  const b = result.b;
  const m = result.matching;
  const out = [
    `a  ${a.run}  ${basename(String(a.file || ''))}  ${a.count} steps  exit ${pyText(a.exitCode)}`,
    `b  ${b.run}  ${basename(String(b.file || ''))}  ${b.count} steps  exit ${pyText(b.exitCode)}`,
    `statements: ${m.same} same, ${m.edited} edited, ${m.added} added, ${m.removed} removed (matched by file, function and text)`,
  ];
  for (const n of result.notes ?? []) out.push(`note: ${n}`);
  if (a.exitCode !== b.exitCode) out.push(`exit code ${pyText(a.exitCode)} → ${pyText(b.exitCode)}`);
  if (!result.statements.length) {
    out.push('no difference in values, branches, loops, calls, prints or raises');
    return out;
  }
  let head = `${result.total} statements did something different`;
  const first = result.firstDifference;
  if (first) {
    const at = first.lineB !== null && first.lineB !== undefined ? first.lineB : first.lineA;
    const st = [first.stepA !== null && first.stepA !== undefined ? `a#${first.stepA}` : '', first.stepB !== null && first.stepB !== undefined ? `b#${first.stepB}` : ''].filter(Boolean).join('  ');
    head += `; the first at ${first.file}:${pyText(at)} (${st})`;
  }
  if (result.shown < result.total) head += ` (showing ${result.shown}; --limit K for more)`;
  out.push(head);
  for (const e of result.statements) {
    const status = e.status === 'same' ? '' : '  ' + e.status;
    if (e.status === 'edited') {
      out.push(`${where(e)}  ${e.function}${status}`);
      out.push(...editedLines('sourceA' in e ? e.sourceA : e.textA, 'sourceB' in e ? e.sourceB : e.textB));
    } else out.push(`${where(e)}  ${e.function}  ${oneLine(e.textB || e.textA, 100)}${status}`);
    for (const f of e.facts) out.push(factLine(f));
  }
  return out;
}
