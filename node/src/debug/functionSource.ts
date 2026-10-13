import { parseSync } from 'oxc-parser';

/** Resolve an inspector location to an unambiguous function in the original source.
 * Instrumentation preserves lines but changes columns, so never guess between
 * multiple functions beginning on the same line.
 */
export function functionSourceAt(path: string, source: string, line: number): string | undefined {
  const parsed = parseSync(path, source, { sourceType: 'unambiguous' });
  if (parsed.errors.length) return undefined;
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  const from = starts[line - 1];
  if (from === undefined) return undefined;
  const until = starts[line] ?? source.length + 1;
  const matches: Array<{ start: number; end: number }> = [];
  function visit(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const child of value) visit(child); return; }
    const node = value as Record<string, any>;
    if (['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(node.type)
      && node.start >= from && node.start < until) matches.push({ start: node.start, end: node.end });
    for (const [key, child] of Object.entries(node)) if (key !== 'parent') visit(child);
  }
  visit(parsed.program);
  return matches.length === 1 ? source.slice(matches[0]!.start, matches[0]!.end) : undefined;
}
