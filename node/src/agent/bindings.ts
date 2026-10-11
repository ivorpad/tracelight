/**
 * The agent side of statement bindings: the variable
 * history's name rule, and the table keyed by global range id. The bindings themselves come from
 * the AST (`../bindings.ts` `statementBindings`), plus the parameters of the
 * functions that are not statements (methods, function expressions, arrows), as Pyokka's `def`
 * statement binds a method's parameters.
 */
import type { StatementBinding } from '../bindings.ts';
import { isJsxPath, isTypeScriptPath, toJavaScript } from '../instrument.ts';
import { LineIndex } from '../lines.ts';
import { MappedLineIndex, type Lowered } from '../lower.ts';
import { parseSync } from '../parse.ts';

/** the variable history's name rule: exact, or one path under the other (`acct` ~ `acct.deposit`, `this` ~ `this.balance`) */
export function matchesName(candidate: string | null | undefined, query: string): boolean {
  if (!candidate || !query) return false;
  if (candidate === query) return true;
  for (const sep of ['.', '[']) if (candidate.startsWith(query + sep) || query.startsWith(candidate + sep)) return true;
  return false;
}

/**
 * Bindings keyed by global range id, via the `(line, col)` the range table and the AST share.
 * Statement ranges win over function headers at the same position.
 */
export function indexBindings(entries: StatementBinding[], ranges: number[][], statements: number[], functionRids: number[], rangeBase = 0): Map<number, StatementBinding> {
  const byPos = new Map<string, number>();
  for (const local of [...functionRids, ...statements]) {
    if (local >= 0 && local < ranges.length) {
      const r = ranges[local]!;
      byPos.set(`${r[0]}:${r[1]}`, local);
    }
  }
  const out = new Map<number, StatementBinding>();
  for (const e of entries) {
    const local = byPos.get(`${e.line}:${e.col}`);
    if (local !== undefined) out.set(rangeBase + local, e);
  }
  return out;
}

type Node = any;

function paramNames(p: Node, out: string[]): void {
  if (!p) return;
  switch (p.type) {
    case 'Identifier':
      out.push(p.name);
      return;
    case 'ObjectPattern':
      for (const prop of p.properties) paramNames(prop.type === 'RestElement' ? prop.argument : prop.value, out);
      return;
    case 'ArrayPattern':
      for (const el of p.elements) paramNames(el, out);
      return;
    case 'RestElement':
      paramNames(p.argument, out);
      return;
    case 'AssignmentPattern':
      paramNames(p.left, out);
      return;
    case 'TSParameterProperty':
      paramNames(p.parameter, out);
  }
}

/**
 * The parameters a function expression, an arrow or a method binds, at its header's position:
 * the entries `statementBindings` has for a function declaration, for the functions that are not
 * statements. The call that enters the function binds them, at the header step (Pyokka's `def` line).
 */
export function functionBindings(source: string, path: string): StatementBinding[] {
  let js = source;
  let lowered: Lowered | null = null;
  try {
    if (isTypeScriptPath(path) || isJsxPath(path)) ({ js, lowered } = toJavaScript(source, path));
  } catch {
    return [];
  }
  const r = parseSync('x.js', js, { sourceType: 'unambiguous', lang: 'js' } as any);
  if (r.errors.length) return [];
  const lines = lowered ? new MappedLineIndex(js, source, lowered) : new LineIndex(js);
  const out: StatementBinding[] = [];
  const add = (fn: Node, start: number) => {
    const assigns: string[] = [];
    for (const p of fn.params ?? []) paramNames(p, assigns);
    if (!assigns.length) return;
    const [line, col] = lines.pos(start);
    out.push({ line, col, assigns: [...new Set(assigns)], reads: [] });
  };
  const walk = (n: Node): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n.type !== 'string') return;
    if ((n.type === 'MethodDefinition' || (n.type === 'Property' && (n.method || n.kind === 'get' || n.kind === 'set'))) && n.value && /Function/.test(n.value.type)) {
      add(n.value, n.start);
      walk(n.key);
      walk(n.value.params);
      walk(n.value.body);
      return;
    }
    if (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') add(n, n.start);
    for (const k in n) if (k !== 'type' && n[k] && typeof n[k] === 'object') walk(n[k]);
  };
  walk(r.program.body);
  return out;
}
