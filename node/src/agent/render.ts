/**
 * Bounded text rendering of the contract shapes for the agent verbs.
 *
 * One `renderX(result, source, args) -> string[]` per verb; `render` (called by `commands.ts`)
 * prints the stale lines first and redacts every line on the way out. `file:line` and step
 * numbers, values inline, moves listed: never a range id, never base64. A verb added later
 * renders in its own module and hands its renderer to `registerVerb`; the helpers below
 * (`oneLine`, `loc`, `blockLinesText`, `MOVE_LABEL`) are what the renderers share.
 */
import { pyText } from './checkpoint.ts';
import { cutLine } from './recording.ts';
import { redact } from './redact.ts';
import type { RunSource } from './source.ts';
import { pyRepr } from './argparse.ts';

type Msg = Record<string, any>;
export type Args = Record<string, any>;

export const MOVE_LABEL: Record<string, string> = { into: 'into', over: 'over', out: 'out', back: 'back', backOver: 'back-over', backOut: 'back-out' };
export const TEXT_MAX = 160;
export const OUTPUT_LINES = 20;
export const OUTPUT_LINES_SCOPE = 200;
export const VAR_READS_SHOWN = 4;

/** the debugger's renderers (`render_debug.py`), filled in by the module that ports them; until then a debug reply renders as a slice */
export const debugRender: {
  stop: ((result: Msg, source: RunSource, args: Args) => string[]) | null;
  state: ((result: Msg, source: RunSource, args: Args) => string[]) | null;
  stopReason: ((paused: Msg) => string) | null;
} = { stop: null, state: null, stopReason: null };

/** one line, cut at `limit` characters with the cut said */
export function oneLine(text: unknown, limit = TEXT_MAX): string {
  return cutLine(text, limit, true);
}

/** `file:line` as the run shows it (workspace-relative, a library from its package on) */
export function loc(source: RunSource, file: string | null | undefined, line: unknown): string {
  const name = typeof source?.displayPath === 'function' ? source.displayPath(file) : (file || '<unknown>');
  return line ? `${name}:${pyText(line)}` : name;
}

/** what `staleReason` means to a reader, and why they should not skip the line */
const STALE_TEXT: Record<string, string> = {
  unsaved: 'stale: %s has unsaved edits; the source below is the editor\'s, not the code that is running',
  disk: 'stale: %s changed on disk since the run started; the source below is not the code that ran',
};

export function staleLines(result: Msg, source: RunSource): string[] {
  let files = result?.staleFiles;
  if ((files === undefined || files === null) && typeof source?.staleFiles === 'function') files = source.staleFiles();
  const template = STALE_TEXT[String(result?.staleReason || '')] ?? 'stale: %s changed since the run';
  return ((files ?? []) as string[]).map((p) => template.replace('%s', String(p)));
}

/** every line redacted, newline-terminated */
export function joinLines(lines: string[]): string {
  return lines.map((l) => redact(l)).join('\n') + '\n';
}

/** Python's `str.rjust` / `str.rstrip()` */
const rjust = (s: string, n: number) => s.padStart(n);
const rstrip = (s: string) => s.replace(/[\s\x1c-\x1f\x85]+$/, '');

export function blockLinesText(blockLines: Msg[], srcWidth: number): string[] {
  const out: string[] = [];
  let prev: number | null = null;
  for (const e of blockLines) {
    if (prev !== null && e.line - prev > 1) out.push(`${' '.repeat(srcWidth)}  …`);
    const mark = e.current ? '>' : ' ';
    const step = e.step !== null && e.step !== undefined ? `#${e.step}` : '';
    out.push(`${mark}${rjust(String(e.line), srcWidth)}  ${rstrip(String(e.text))}${step ? '   ' + step : ''}`);
    prev = e.line;
  }
  return out;
}

const widthOf = (lines: Msg[]) => Math.max(...lines.map((e) => String(e.line).length));

export function renderStory(result: Msg, source: RunSource, _args: Args): string[] {
  let head = `${result.count} steps, ${result.total} blocks`;
  if (result.filtered) head += `, ${result.matched} matching`;
  if (result.shown < result.matched) head += ` (showing ${result.shown})`;
  const out = [head];
  if (!result.blocks.length) {
    out.push('nothing ran that matches; try `story` without a filter or `steps`');
    return out;
  }
  for (const b of result.blocks) {
    out.push('');
    const firstLine = b.lines.length ? b.lines[0].line : 0;
    out.push(`## ${b.function}  ${loc(source, b.file, firstLine)}  steps ${b.firstStep}–${b.lastStep}`);
    if (b.noSource) {
      out.push('   (no source available)');
      continue;
    }
    out.push(...blockLinesText(b.lines, widthOf(b.lines)));
  }
  if (result.truncated) {
    out.push('');
    out.push(`… ${result.matched - result.shown} more blocks; narrow with --file F, --scope NAME or --line F:L, or raise --limit`);
  }
  return out;
}

function flagsText(row: Msg): string {
  return row.flags?.length ? ` [${row.flags.join(',')}]` : '';
}

export function renderSteps(result: Msg, source: RunSource, _args: Args): string[] {
  const out: string[] = [];
  if ('line' in result) out.push(`${result.total} steps on ${loc(source, result.line.file, result.line.line)} (of ${result.count})`);
  else out.push(`steps ${result.from ?? 0}.. of ${result.count}`);
  for (const r of result.steps) out.push(`#${String(r.step).padEnd(6)} ${loc(source, r.file, r.line)}  ${r.function}  depth ${r.depth}${flagsText(r)}`);
  if (result.next !== null && result.next !== undefined) out.push(`next: --from ${result.next}`);
  return out;
}

/** `paused at file:line (reason)`: the frontier of a debug run; the slice's location fills a missing file */
export function pausedLine(paused: Msg, source: RunSource, location: Msg | null = null): string {
  const file = paused.file || (location ?? {}).file;
  const line = paused.line !== null && paused.line !== undefined ? paused.line : (location ?? {}).line;
  const reason = debugRender.stopReason ? debugRender.stopReason(paused) : String(paused.reason || 'pause');
  return `paused at ${loc(source, file, line)} (${reason}${paused.recordingStarted ? '; recording starts here, step 0' : ''})`;
}

function localsLines(variables: Msg[], indent = '  '): string[] {
  return variables.filter((v) => v && typeof v === 'object').map((v) => `${indent}${pyText(v.name)} = ${oneLine(v.text)}`);
}

/** what the program printed so far at a pause: the last 20 lines (200 with `--scope`), indented */
function outputLines(output: unknown, scope = false): string[] {
  if (!output || typeof output !== 'object') return [];
  const lines = String((output as Msg).text || '').split(/\r\n|\r|\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (!lines.length) return [];
  const shown = lines.slice(-(scope ? OUTPUT_LINES_SCOPE : OUTPUT_LINES));
  return [`output (last ${shown.length} line${shown.length === 1 ? '' : 's'}):`, ...shown.map((l) => '  ' + l)];
}

/** a `record: false` reply: a stop slice with no trace behind it, or a debug `state` */
export function isDebugReply(result: Msg): boolean {
  if (result.kind === 'debug') return true;
  return 'block' in result && !('moves' in result) && !('count' in result);
}

/** a stop: the slice (a saved run's `step`), or a debug stop once the debugger's renderers are ported */
export function renderStop(result: Msg, source: RunSource, args: Args): string[] {
  const fin = result.finished;
  if (fin && typeof fin === 'object') {
    if (result.stepped !== null && result.stepped !== undefined && debugRender.stop) return debugRender.stop(result, source, args);
    return [`finished: exit ${pyText(fin.exitCode)}, ${pyText(fin.stepCount)} steps`];
  }
  if ((result.resumed || result.requested || isDebugReply(result)) && debugRender.stop) return debugRender.stop(result, source, args);
  return renderContext(result, source, args);
}

/** a recorded return value; null is a body that ran off its end */
function returnedText(value: unknown): string {
  return value === null || value === undefined ? 'undefined (end of body)' : oneLine(value);
}

/** `helper #6 → 2`: a call the statement made, its entry step and what it returned or threw */
function callText(call: Msg): string {
  const head = `${call.function} #${call.step}`;
  if ('returned' in call) return `${head} → ${returnedText(call.returned)}`;
  if ('raised' in call) return `${head} raised ${call.raised}`;
  return head;
}

export function renderContext(result: Msg, source: RunSource, args: Args): string[] {
  if (isDebugReply(result) && debugRender.stop) return debugRender.stop(result, source, args);
  const location = result.location;
  const out: string[] = [];
  const paused = result.paused;
  const isPaused = paused && typeof paused === 'object';
  if (isPaused) out.push(pausedLine(paused, source, location));
  if ('from' in result && result.from !== result.step) out.push(`from step ${result.from}`);
  const flags = result.flags?.length ? ` [${result.flags.join(',')}]` : '';
  out.push(`step ${result.step}/${result.count ?? '?'}  ${loc(source, location.file, location.line)}  ${location.function}${flags}`);
  if (result.recordingStart) out.push('recording started here: what ran before step 0 was not recorded');
  const stack = result.stack ?? [];
  if (stack.length > 1) out.push('stack: ' + stack.map((f: Msg) => `${f.function} ${loc(source, f.file, f.line)} #${f.step}`).join(' ← '));
  const b = result.block;
  const cap = b.capped ? (b.totalLines !== null && b.totalLines !== undefined ? ` (${b.lines.length} of ${b.totalLines} lines; --scope for all)` : ` (first ${b.lines.length} lines; --scope for all)`) : '';
  const span = b.firstStep !== null && b.firstStep !== undefined ? (b.lastStep !== null && b.lastStep !== undefined ? `steps ${b.firstStep}–${b.lastStep}` : `from step ${b.firstStep}`) : '';
  const left = 'returned' in b ? `  returned ${returnedText(b.returned)}` : 'raised' in b ? `  raised ${b.raised}` : '';
  out.push(`block ${b.function}  ${loc(source, b.file, null)}  ${span}${cap}${left}`);
  if (b.lines.length) out.push(...blockLinesText(b.lines, widthOf(b.lines)));
  else out.push('   (no source available)');
  const calls = result.calls ?? [];
  if (calls.length) out.push('calls: ' + calls.map(callText).join(' · '));
  const values = result.values ?? [];
  if (values.length) {
    const vcap = result.valuesCapped ? (result.valuesTotal !== null && result.valuesTotal !== undefined ? ` (${values.length} of ${result.valuesTotal}; --scope for all)` : ` (${values.length} shown; --scope for all)`) : '';
    out.push(`values${vcap}:`);
    for (const v of values) {
      const ctx = v.context ? `${v.context} = ` : '';
      out.push(`  #${v.step !== null && v.step !== undefined ? v.step : -1} ${loc(source, v.file, v.line)}  ${ctx}${oneLine(v.text)}`);
    }
  }
  const variables = result.locals;
  if (isPaused && Array.isArray(variables)) {
    out.push(variables.length ? 'locals:' : 'locals: (none)');
    out.push(...localsLines(variables));
  }
  if (isPaused) out.push(...outputLines(result.output, !!args?.scope));
  const notRun = (result.coverage ?? {}).notRun ?? [];
  if (notRun.length) out.push('not run: ' + notRun.join(', '));
  const errors = result.errors ?? [];
  if (errors.length) {
    out.push('errors:');
    for (const e of errors) {
      const where = e.line ? `${loc(source, b.file, e.line)} ` : '';
      out.push(`  #${pyText(e.step)} ${where}${pyText(e.type)}: ${oneLine(e.message)}${e.handled ? ' (handled)' : ''}`);
    }
  }
  out.push('moves: ' + Object.entries(result.moves as Msg).map(([k, v]) => `${MOVE_LABEL[k] ?? k} ${v !== null && v !== undefined ? v : '—'}`).join(' · '));
  return out;
}

export function renderValues(result: Msg, source: RunSource, _args: Args): string[] {
  const values = result.values;
  const out = [`${values.length} values on ${loc(source, result.file, result.line)}`];
  for (const v of values) {
    const ctx = v.context ? `${v.context} = ` : '';
    const hit = v.hit ? ` hit ${v.hit}` : '';
    out.push(`  #${v.step !== null && v.step !== undefined ? v.step : -1}${hit}  ${ctx}${oneLine(v.text)}`);
  }
  if (!values.length) {
    // An assignment logs nothing, so the obvious line to ask about is the one that answers with
    // nothing. Name `var` when the line assigns something: that is what the asker wanted.
    const names = assignedOn(source, result.file, result.line);
    const first = names.length ? `\`var ${names[0]}\` lists every change of it` : '`context --line` shows what ran';
    out.push(`no value was logged there; ${first}, \`eval\` (with --keep) reads the final state`);
  }
  return out;
}

/** the names a statement on this line assigns, from the binding table; empty when unknown */
function assignedOn(source: RunSource, file: unknown, line: unknown): string[] {
  try {
    const f = source.resolveFile(String(file));
    const table = source.bindings(Number(f.fileId)) as Map<number, Msg>;
    const out: string[] = [];
    for (const binding of table.values()) if (Number(binding.line ?? -1) === Number(line)) out.push(...(binding.assigns ?? []).map(String));
    return out;
  } catch {
    return []; // a live session has no binding table, and that is fine
  }
}

export function renderFind(result: Msg, source: RunSource, _args: Args): string[] {
  const out = [`${result.total} hits for ${pyRepr(String(result.text))}${result.truncated ? ` (showing ${result.hits.length})` : ''}`];
  for (const h of result.hits) {
    const step = h.step !== null && h.step !== undefined ? `#${h.step} ` : '';
    const where = h.file ? loc(source, h.file, h.line) : h.kind;
    const ctx = h.context && (h.kind === 'value' || h.kind === 'local') ? `${h.context} = ` : h.context && h.kind === 'error' ? `${h.context}: ` : '';
    out.push(`  ${step}${where}  ${ctx}${oneLine(h.text)}`);
  }
  if (!result.hits.length) out.push('nothing matched; `story` lists the lines that ran');
  return out;
}

export function renderVar(result: Msg, source: RunSource, _args: Args): string[] {
  const changes = result.changes ?? [];
  const total = result.total ?? changes.length;
  let head = `${total} change${total === 1 ? '' : 's'} of ${pyText(result.name)}`;
  if (result.truncated) head += ` (showing ${changes.length}; --limit for more, --file F or --scope NAME to narrow)`;
  const out = [head];
  const recorded = result.recordedLocals ?? true;
  if (!changes.length) {
    const hint = recorded ? 'no assignment of it ran' : 'no assignment of it ran and the run recorded no locals';
    out.push(`nothing recorded for ${pyText(result.name)}: ${hint}; \`find\` searches values and source lines for the text`);
    return out;
  }
  for (const row of changes) {
    const where = `${loc(source, row.file, row.line)}  ${row.function || '<module>'}`;
    const what = row.text !== null && row.text !== undefined ? `${pyText(row.name)} = ${oneLine(row.text)}${row.unchanged ? '  (same object)' : ''}` : `${pyText(row.name)}  assigned here (value not recorded)`;
    let line = `  #${row.step ?? -1} ${where}  ${what}`;
    const reads = (row.reads ?? []).filter((r: unknown) => r && typeof r === 'object');
    if (reads.length) {
      const parts = reads.slice(0, VAR_READS_SHOWN).map((r: Msg) => `${pyText(r.name)} = ${r.text !== null && r.text !== undefined ? oneLine(r.text, 60) : '?'}`);
      if (reads.length > VAR_READS_SHOWN) parts.push(`… +${reads.length - VAR_READS_SHOWN}`);
      line += '   ← ' + parts.join(', ');
    }
    out.push(line);
  }
  if (!recorded) out.push('(values come from logged statements only: this run recorded no locals)');
  return out;
}

export function renderEval(result: Msg, _source: RunSource, _args: Args): string[] {
  return [`${result.expression} = ${oneLine(result.text, 2000)}`];
}

function nodeLines(node: Msg, indent = '  '): string[] {
  return (node.props ?? []).map((p: Msg) => `${indent}${pyText(p.name)}: ${oneLine(p.value)}`);
}

export function renderExpand(result: Msg, _source: RunSource, _args: Args): string[] {
  const node = result.node ?? {};
  return [`${pyText(node.type)} ${oneLine(node.value, 400)}`, ...nodeLines(node).slice(0, 100)];
}

export function renderRelease(result: Msg, _source: RunSource, _args: Args): string[] {
  return [result.released ? `released the kept runner (pid ${pyText(result.pid)})` : `the kept runner (pid ${pyText(result.pid)}) was already gone`];
}

export function renderState(result: Msg, source: RunSource, args: Args): string[] {
  if (result.kind === 'debug' && debugRender.state) return debugRender.state(result, source, args);
  const nav = result.nav ?? {};
  const live = result.live;
  if (live) {
    let head = `${result.displayName || source.displayPath(result.file)}: ${nav.count || 0} steps, live in VS Code (pid ${pyText(live.pid)})`;
    if (result.running) head += ', running';
    else if (!result.finished) head += ', no finished run yet';
    if (result.stale) head += ', stale';
    const l = result.location ?? {};
    const where = nav.active ? `Time Machine at step ${pyText(nav.step)}/${pyText(nav.count)}  ${loc(source, l.file, l.line)}  ${l.function || ''}` : 'Time Machine inactive: `step --live --into` starts it at the first step, `step --live --to N` jumps';
    const out = [head, where];
    const dbg = result.debug;
    if (dbg && typeof dbg === 'object' && dbg.active) {
      const paused = dbg.paused;
      out.push(paused && typeof paused === 'object' ? 'debug: ' + pausedLine(paused, source, l) : 'debug: running (`pause --live` stops it at its next statement)');
    }
    return out;
  }
  const keep = result.keep;
  return [
    `${pyText(result.file)}: ${result.nav.count} steps, exit ${pyText(result.exitCode)}${result.stale ? ', stale' : ''}`,
    keep ? `kept runner: pid ${pyText(keep.pid)}` : 'no kept runner (eval needs `run --keep`)',
  ];
}
