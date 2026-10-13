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
  identifiers?: import('../src/shared/protocol').SourceBindings;
  column?: number;
  entry?: boolean;
}

export interface ValueOccurrence {
  line: number;
  start: number;
  end: number;
  local: LocalVar;
  path?: string[];
  unavailable?: boolean;
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
  if (pause.identifiers) {
    if (!pause.identifiers.scopes.length) return [];
    const source = pause.content ?? lines.join('\n');
    const offsets = [0, ...[...source.matchAll(/\n/g)].map(m => m.index + 1), source.length + 1];
    const at = offsets[pause.line - 1]! + (pause.column ?? 0);
    const { scopes, references } = pause.identifiers;
    let current = 0;
    const lineEnd = offsets[pause.line]! - 1;
    for (let i = 1; i < scopes.length; i++) if (scopes[i]!.start <= at && at < scopes[i]!.end) current = i;
    // An exported function's runtime entry can start before the parser's `function` node.
    if (pause.entry) {
      const child = scopes.findIndex(s => s.function && s.parent === current && at <= s.start && s.start < lineEnd);
      if (child >= 0) current = child;
    }
    const resolve = (name: string): number => {
      let scope = current;
      while (scope >= 0 && !scopes[scope]!.names.includes(name)) scope = scopes[scope]!.parent;
      return scope;
    };
    for (const r of references) {
      const local = locals.get(r.name);
      if (r.scope < 0 || r.scope !== resolve(r.name)) continue;
      const line = offsets.findIndex((offset) => offset > r.start);
      if (line < pause.start || line > pause.end || pause.excluded?.some(([a, b]) => a <= line && line <= b)) continue;
      const unavailable = !local || scopes[r.scope]!.pending?.some(p => p.name === r.name && at < p.until);
      out.push({ line, start: r.start - offsets[line - 1]!, end: r.end - offsets[line - 1]!, local: unavailable ? { name: r.name, text: 'Not available in this pause' } : local!, path: r.path, unavailable: !!unavailable });
    }
    return out;
  }
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

/** The runtime may omit a TDZ binding and expose an outer binding with the same name. */
export function pausedFrameLocals(pause: PausedValues): LocalVar[] {
  if (pause.identifiers && !pause.identifiers.scopes.length) return [];
  if (!pause.identifiers || pause.content === undefined) return pause.locals;
  const occurrences = pausedOccurrences(pause.content.split(/\r?\n/), [], pause);
  const blocked = new Set(occurrences.filter(o => o.unavailable).map(o => o.local.name));
  return pause.locals.map(v => blocked.has(v.name) ? { name: v.name, text: 'Not available in this pause' } : v);
}

/** Read only the serialized own-property tree. Missing nodes and accessors stay unavailable. */
export function pausedProperty(local: LocalVar, path: string[]): LocalVar | undefined {
  let node = local.valueBag?.data;
  for (const name of path) node = node?.props?.find(p => p.name === name);
  if (!node || node.value === undefined || /getter|accessor/i.test(node.type)) return undefined;
  return { name: [local.name, ...path].join('.'), text: node.value, valueBag: { runtimeKey: local.valueBag!.runtimeKey, data: node } };
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

/** Keep each shadow beside its declaration instead of following subsequent reads. */
export function pausedShadows(lines: string[], occurrences: ValueOccurrence[], pause: PausedValues): Map<number, string> {
  const bindings = new Map<string, ValueOccurrence>();
  for (const o of occurrences) {
    if (o.unavailable || o.line > pause.line || bindings.has(o.local.name)) continue;
    if (pause.ghostNames && !pause.ghostNames.includes(o.local.name)) continue;
    const before = lines[o.line - 1]!.slice(0, o.start);
    if (!/\b(?:const|let|var)\s+$/.test(before)) continue;
    bindings.set(o.local.name, o);
  }
  const rows = new Map<number, string>();
  for (const o of bindings.values()) rows.set(o.line, `${o.local.name} = ${pausedSummary(o.local)}`);
  return rows;
}

/** Format the captured preview as data, preserving quoted text without parsing or executing it. */
export function prettyPausedText(text: string): string {
  if (!/^[\[{]/.test(text.trim())) return text;
  const source = text.trim();
  let out = '', depth = 0, quote = '', escaped = false;
  const newline = () => { out = out.trimEnd() + '\n' + '  '.repeat(depth); };
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (quote) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; continue; }
    if (c === '[' || c === '{') {
      // Markers such as [Circular] and [Getter] are atomic preview text.
      const marker = c === '[' ? /^\[(?:Circular[^\]]*|Getter[^\]]*|Setter[^\]]*|Object[^\]]*)\]/.exec(source.slice(i)) : null;
      if (marker) { out += marker[0]; i += marker[0].length - 1; continue; }
      out += c;
      const close = c === '[' ? ']' : '}';
      if (source.slice(i + 1).trimStart().startsWith(close)) {
        i += source.slice(i + 1).indexOf(close) + 1;
        out += close;
      } else { depth++; newline(); }
    } else if (c === ']' || c === '}') {
      if (!depth) return text;
      depth--; newline(); out += c;
    } else if (c === ',') { out += c; newline(); }
    else if (/\s/.test(c)) { if (out && !/\s$/.test(out)) out += ' '; }
    else out += c;
  }
  return quote ? text : out.trimEnd();
}

export function pausedHover(local: LocalVar): string {
  // A runtime value can contain Markdown. Keep all of it inside an inert code block.
  const runs = local.text.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
  return `Paused frame · ${local.name}\n\n${fence}javascript\n${prettyPausedText(local.text)}\n${fence}` +
    (runtimeCapped(local.valueBag?.data, local.text) ? '\n\nRuntime preview is truncated. Expand this variable in the Debugger for available detail.' : '');
}
