import type { LocalVar } from './debugHost';
import type { ValueNode } from '../src/shared/protocol';

export function runtimeCapped(node?: ValueNode, text = ''): boolean {
  return !!(node?.capped || node?.cappedProps || node?.cappedElements || /…\(\+\d+ chars\)|\.\.\. \d+ more (?:items|characters)/.test(text));
}

export interface PausedValues {
  line: number;
  start: number;
  end: number;
  locals: LocalVar[];
  excluded?: [number, number][];
  content?: string;
  anchor?: number;
  ghostNames?: string[];
  snapshot?: string;
}

export interface ValueOccurrence {
  line: number;
  start: number;
  end: number;
  local: LocalVar;
}

/** Inline space belongs to the source. Containers get a count or a small preview, never a dump. */
export function pausedSummary(local: LocalVar): string {
  const node = local.valueBag?.data;
  const text = local.text.replace(/\s*\n\s*/g, ' ');
  if (/^(?:array|list|tuple)$/i.test(node?.type ?? '') || text.startsWith('[')) {
    const preview = text.length > 48 ? text.slice(0, 47) + '…' : text;
    return preview + (node?.length !== undefined ? ` (${node.length} elementos)` : '');
  }
  if (text.startsWith('{') || /^(?:object|dict|map|set)$/i.test(node?.type ?? '')) {
    return text.length <= 40 ? text : text.slice(0, 39) + '…';
  }
  return text.length > 24 ? text.slice(0, 23) + '…' : text;
}

/** Match only source identifiers, using the editor's tokens to exclude strings and comments.
 * These are bindings supplied by the paused frame, never expressions to evaluate.
 */
export function pausedOccurrences(
  lines: string[], tokens: { offset: number; type: string }[][], pause: PausedValues,
): ValueOccurrence[] {
  const locals = new Map(pause.locals.map((v) => [v.name, v]));
  const out: ValueOccurrence[] = [];
  for (let line = Math.max(1, pause.start); line <= Math.min(lines.length, pause.end); line++) {
    if (pause.excluded?.some(([start, end]) => start <= line && line <= end)) continue;
    const source = lines[line - 1]!;
    const row = tokens[line - 1] ?? [];
    for (const match of source.matchAll(/[\p{ID_Start}_$][\p{ID_Continue}$]*/gu)) {
      const start = match.index;
      const local = locals.get(match[0]);
      if (!local) continue;
      const token = [...row].reverse().find((t) => t.offset <= start);
      if (!token || /string|comment|regexp/.test(token.type)) continue;
      // `obj.elapsed` is a property, not the frame's `elapsed` binding.
      if (/\.\s*$/.test(source.slice(0, start))) continue;
      // Object keys and labels are not bindings either (typed declarations are).
      if (/^\s*:/.test(source.slice(start + match[0].length)) && !/\b(?:const|let|var)\s+$/.test(source.slice(0, start)) && !/\bfunction\b/.test(source.slice(0, start))) continue;
      out.push({ line, start, end: start + match[0].length, local });
    }
  }
  return out;
}

/** One short annotation per binding, at its nearest occurrence up to the active statement. */
export function pausedInline(occurrences: ValueOccurrence[], line: number, anchor?: number): Map<number, string> {
  const latest = new Map<string, ValueOccurrence>();
  for (const o of occurrences) if (o.line <= line) latest.set(o.local.name, o);
  const rows = new Map<number, string[]>();
  for (const o of latest.values()) {
    const short = pausedSummary(o.local);
    const row = anchor ?? o.line;
    const values = rows.get(row) ?? [];
    values.push(`${o.local.name} = ${short}`);
    rows.set(row, values);
  }
  return new Map([...rows].map(([row, values]) => [row, values.slice(0, 3).join(' · ')]));
}

export function pausedHover(local: LocalVar): string {
  // A runtime value can contain Markdown. Keep all of it inside an inert code block.
  const runs = local.text.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
  return `Paused frame · ${local.name}\n\n${fence}text\n${local.text}\n${fence}` +
    (runtimeCapped(local.valueBag?.data, local.text) ? '\n\nRuntime preview is truncated. Expand this variable in the Debugger for available detail.' : '');
}
