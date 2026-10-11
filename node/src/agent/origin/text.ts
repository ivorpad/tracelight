/** `origin` as text, as Pyokka's `origin/text.py`: the error, the value, one line per link newest first, the root and where the chain ends. */
import { pyText } from '../checkpoint.ts';
import { cutLine } from '../recording.ts';
import { loc, type Args } from '../render.ts';
import type { RunSource } from '../source.ts';

type Msg = Record<string, any>;

export const VALUE_MAX = 60;
export const EXPR_MAX = 70;

function value(text: unknown): string {
  return cutLine(text, VALUE_MAX, true);
}

function where(source: RunSource, step: unknown, file: string | null | undefined, line: unknown, fn: unknown): string {
  return `#${pyText(step)} ${loc(source, file, line)} ${fn || '<module>'}`;
}

export function renderOrigin(result: Msg, source: RunSource, _args: Args): string[] {
  const at = where(source, result.step, result.file, result.line, result.function);
  const error = result.error;
  const out: string[] = [];
  if (error) out.push(`${pyText(error.type)} at ${at}: ${pyText(error.message)}${error.caught ? ' (caught)' : ''}`);
  else {
    const v = result.value || {};
    out.push(result.value && Object.keys(v).length ? `origin of ${v.expr || '?'} at ${at}` : `origin at ${at}`);
  }
  if (result.statement) out.push(`  ${cutLine(result.statement, 100, true)}`);
  const v = result.value;
  if (v && Object.keys(v).length) {
    let line = `the value: ${pyText(v.expr)} = ${value(v.text)}`;
    if (result.need) line += `, where the statement needs ${result.need}`;
    out.push(line);
  }
  const links: Msg[] = result.links || [];
  if (links.length) {
    out.push('where from, newest first:');
    const locs = links.map((l) => where(source, l.step, l.file, l.line, l.function));
    const width = Math.min(48, Math.max(...locs.map((s) => [...s].length)));
    let prevText: unknown = Symbol('none');
    links.forEach((l, i) => {
      const expr = cutLine(l.expr || '', EXPR_MAX, true);
      const text = l.text;
      let shown: string;
      if (l.how === 'literal') shown = l.certainty === 'text match' || !l.statement ? expr : cutLine(l.statement, EXPR_MAX, true);
      else if (l.how === 'assigned' && l.statement) {
        const stmt = cutLine(l.statement, EXPR_MAX, true);
        shown = text === null || text === undefined || text === prevText ? stmt : `${stmt}   → ${value(text)}`;
      } else shown = text === null || text === undefined || text === prevText ? expr : `${expr} = ${value(text)}`;
      prevText = text === undefined ? null : text;
      let how = String(l.how);
      if (l.certainty && l.certainty !== 'recorded') how += ', ' + String(l.certainty);
      if (l.note) how += ': ' + String(l.note);
      const mark = l.root ? '▶ ' : '  ';
      const pad = locs[i]! + ' '.repeat(Math.max(0, width - [...locs[i]!].length));
      out.push(`${mark}${pad}   ${shown}   (${how})${l.root ? '   ◀ root' : ''}`);
      for (const inp of l.inputs || []) out.push(`  ${' '.repeat(width)}     ← ${pyText(inp.name)} = ${value(inp.text)}`);
    });
  }
  const reads: Msg[] | undefined = result.reads;
  if (reads && reads.length) {
    out.push('the statement read:');
    for (const r of reads) out.push(`  ${pyText(r.name)} = ${r.text !== null && r.text !== undefined ? value(r.text) : '?'}${r.step !== null && r.step !== undefined ? `   #${pyText(r.step)}` : ''}`);
  }
  const root = result.root;
  if (root) {
    const idx = Number(root.index ?? -1);
    const link = idx >= 0 && idx < links.length ? links[idx]! : {};
    out.push(`root: ${where(source, root.step, link.file, link.line, link.function)}: ${pyText(root.reason)}`);
  }
  if (result.rootUnknown) out.push(`root: not known; ${String(result.rootUnknown).split(', so ')[0]}`);
  if (result.end) out.push(`chain ends: ${result.end}`);
  if (result.hint) out.push(String(result.hint));
  if (links.length && links.some((l) => l.certainty !== 'recorded')) out.push('inferred: picked by value among the statement\'s candidates; text match: by text only. The recording keeps values as text, not object identity.');
  return out;
}
