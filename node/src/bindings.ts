/**
 * Per-statement name bindings from the AST: what a statement assigns, reads and calls.
 * The variable history (`var`, the Variable pane) needs which names a statement binds
 * and reads; the provenance tree (`why`) adds the source text of the calls it makes. All come from
 * the source alone: the runner's `bindings` request, no run involved.
 *
 * A statement is identified by the (line, col) where its range starts, which is where the
 * instrumenter starts it (src/instrument.ts `stmtSpan`; the header for compound statements). A
 * function's entry step is on its header range, so every function header gets an entry listing
 * its parameters as assignments (a `function` declaration shares its statement's start). Methods
 * and constructors also bind `this`, the JS counterpart of Python's `self`.
 *
 * Only the statement's own header counts: nested block bodies are statements of their own, and a
 * block-bodied function inside an expression runs its own statements. An expression-bodied arrow
 * (`xs.map((x) => x * k)`) has no statements, so its reads and calls belong to the statement that
 * holds it, its parameters left out.
 */
import { parseSync } from 'oxc-parser';
import { isJsxPath, isTypeScriptPath, toJavaScript } from './instrument.ts';
import { LineIndex } from './lines.ts';
import { MappedLineIndex, type Lowered } from './lower.ts';

type Node = any;

export const READS_CAP = 12;
export const CALLS_CAP = 8;
export const CALL_TEXT_MAX = 80;

export interface StatementBinding {
  line: number;
  col: number;
  assigns: string[];
  reads: string[];
  loop?: number;
  calls?: string[];
}

const LOOPS = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement']);
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const MODULE_NAMES = new Set(['require', 'module', 'exports', '__dirname', '__filename', 'undefined', 'NaN', 'Infinity', 'arguments']);

/** Names a program never records as variables: the globals of a fresh runtime. */
function isBuiltin(name: string): boolean {
  return MODULE_NAMES.has(name) || name in globalThis;
}

export class BindingsSyntaxError extends Error {
  line: number | null;
  constructor(message: string, line: number | null) {
    super(message);
    this.name = 'SyntaxError';
    this.line = line;
  }
}

/** Parse JS (or TS, types stripped: offsets are unchanged) as the instrumenter does. */
export function parseProgram(source: string, filename = 'x.js'): { program: Node; js: string; lowered: Lowered | null } {
  let js = source;
  let lowered: Lowered | null = null;
  const ts = isTypeScriptPath(filename);
  const tryParse = (text: string) => parseSync(filename.replace(/\.(ts|mts|cts|tsx|jsx)$/i, '.js'), text, { sourceType: 'unambiguous', lang: 'js', preserveParens: true } as any);
  // TypeScript and JSX as the instrumenter sees them: types stripped, enums and JSX lowered (lines kept)
  if (ts || isJsxPath(filename)) ({ js, lowered } = toJavaScript(source, filename));
  let parsed = tryParse(js);
  if (parsed.errors?.length && !ts) {
    // the host may not say the language: a `.ts` source still parses once stripped
    try {
      const stripped = toJavaScript(source, 'x.ts');
      const again = tryParse(stripped.js);
      if (!again.errors?.length) {
        js = stripped.js;
        lowered = stripped.lowered;
        parsed = again;
      }
    } catch {
      // not TypeScript either: report the JS error
    }
  }
  if (parsed.errors?.length) {
    const first = parsed.errors[0];
    const at = first.labels?.[0]?.start;
    throw new BindingsSyntaxError(first.message, typeof at === 'number' ? new LineIndex(js).line(at) : null);
  }
  return { program: parsed.program, js, lowered };
}

/** `[{line, col, assigns, reads, loop?, calls?}]` for every statement or function header that binds, reads or calls, in source order. */
export function statementBindings(source: string, filename?: string): StatementBinding[] {
  const { program, js, lowered } = parseProgram(source, filename);
  return bindingsOf(program, js, lowered ? new MappedLineIndex(js, source, lowered) : new LineIndex(js));
}

/** The table over an already parsed program (the instrumenter's, for the walk table's `names`). */
export function bindingsOf(program: Node, js: string, lines: { pos(offset: number): [number, number]; line(offset: number): number }): StatementBinding[] {
  const byStart = new Map<number, StatementBinding>();
  const add = (start: number, e: Omit<StatementBinding, 'line' | 'col'>): void => {
    if (!e.assigns.length && !e.reads.length && !e.calls?.length) return;
    const prev = byStart.get(start);
    if (prev) {
      // a function declaration: its statement and its header share the start
      prev.assigns = dedupe([...prev.assigns, ...e.assigns]);
      return;
    }
    const [line, col] = lines.pos(start);
    byStart.set(start, { line, col, ...e });
  };

  const visitStatement = (s: Node): void => {
    if (!s || typeof s !== 'object') return;
    if (s.type === 'BlockStatement') return s.body.forEach(visitStatement);
    if (s.type === 'EmptyStatement' || (s.type === 'ExpressionStatement' && typeof s.directive === 'string')) return;
    if (s.type.startsWith('TS')) return;
    const header = headerNodes(s);
    const assigns = statementAssigns(s, header);
    const reads = readNames(s, header);
    const calls = callTexts(header, js);
    const entry: Omit<StatementBinding, 'line' | 'col'> = { assigns, reads };
    if (LOOPS.has(s.type) || (s.type === 'LabeledStatement' && LOOPS.has(s.body.type))) entry.loop = lines.line(Math.max(s.start, s.end - 1));
    if (calls.length) entry.calls = calls;
    add(s.start, entry);
    const d = s.type === 'ExportNamedDeclaration' || s.type === 'ExportDefaultDeclaration' ? s.declaration : s;
    if (d && (d.type === 'FunctionDeclaration' || ((d.type === 'FunctionExpression' || d.type === 'ArrowFunctionExpression') && d !== s && s.type === 'ExportDefaultDeclaration' && d.type !== 'ArrowFunctionExpression'))) visitFunction(d, s.start, false);
    else if (d && (d.type === 'ClassDeclaration' || d.type === 'ClassExpression')) visitFunctionsIn(d);
    else if (d && d !== s && s.type === 'ExportDefaultDeclaration') visitFunctionsIn(d);
    for (const child of nestedStatements(s)) visitStatement(child);
    for (const h of header) visitFunctionsIn(h);
  };

  const visitFunction = (fn: Node, headerStart: number, method: boolean): void => {
    const assigns: string[] = [];
    for (const p of fn.params ?? []) assigns.push(...patternNames(p.type === 'TSParameterProperty' ? p.parameter : p));
    if (method) assigns.unshift('this');
    add(headerStart, { assigns: dedupe(assigns), reads: [] });
    for (const p of fn.params ?? []) visitFunctionsIn(p);
    if (fn.body?.type === 'BlockStatement') fn.body.body.forEach(visitStatement);
    else visitFunctionsIn(fn.body);
  };

  /** functions (and class bodies) inside an expression: their headers and statements */
  const visitFunctionsIn = (n: Node, parent?: Node): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach((x) => visitFunctionsIn(x, parent));
    if (typeof n.type !== 'string') return;
    if (FUNCTIONS.has(n.type)) {
      const isMethod = !!parent && (parent.type === 'MethodDefinition' || (parent.type === 'Property' && (parent.method || parent.kind === 'get' || parent.kind === 'set')));
      return visitFunction(n, isMethod ? parent.start : n.start, isMethod || false);
    }
    if (n.type === 'ClassDeclaration' || n.type === 'ClassExpression') {
      visitFunctionsIn(n.superClass);
      for (const el of n.body?.body ?? []) {
        if (el.type === 'MethodDefinition' && el.value) {
          if (el.computed) visitFunctionsIn(el.key);
          visitFunction(el.value, el.start, true);
        } else if (el.type === 'StaticBlock') el.body.forEach(visitStatement);
        else visitFunctionsIn(el);
      }
      return;
    }
    for (const k in n) {
      if (k === 'type' || k === 'start' || k === 'end') continue;
      const v = n[k];
      if (v && typeof v === 'object') visitFunctionsIn(v, n);
    }
  };

  program.body.forEach(visitStatement);
  return [...byStart.values()].sort((a, b) => a.line - b.line || a.col - b.col);
}

// -- statement structure --------------------------------------------------------------------------

/** The parts of a statement that run at its own step (not its nested blocks). */
function headerNodes(s: Node): Node[] {
  switch (s.type) {
    case 'IfStatement':
      return [s.test];
    case 'ForStatement':
      return [s.init, s.test, s.update].filter(Boolean);
    case 'ForInStatement':
    case 'ForOfStatement':
      return [s.left, s.right];
    case 'WhileStatement':
    case 'DoWhileStatement':
      return [s.test];
    case 'LabeledStatement':
      return LOOPS.has(s.body.type) ? headerNodes(s.body) : [];
    case 'WithStatement':
      return [s.object];
    case 'SwitchStatement':
      return [s.discriminant];
    case 'TryStatement':
    case 'BlockStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
    case 'DebuggerStatement':
      return [];
    case 'ReturnStatement':
    case 'ThrowStatement':
      return s.argument ? [s.argument] : [];
    case 'ExpressionStatement':
      return [s.expression];
    case 'VariableDeclaration':
      return [s];
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
    case 'ImportDeclaration':
    case 'ExportAllDeclaration':
      return [];
    case 'ExportNamedDeclaration':
      return s.declaration?.type === 'VariableDeclaration' ? [s.declaration] : [];
    case 'ExportDefaultDeclaration':
      return s.declaration && !FUNCTIONS.has(s.declaration.type) && s.declaration.type !== 'ClassDeclaration' && s.declaration.type !== 'ClassExpression' ? [s.declaration] : [];
    default:
      return [];
  }
}

function nestedStatements(s: Node): Node[] {
  switch (s.type) {
    case 'IfStatement':
      return [s.consequent, s.alternate].filter(Boolean);
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement':
    case 'WhileStatement':
    case 'DoWhileStatement':
    case 'WithStatement':
      return [s.body];
    case 'LabeledStatement':
      return LOOPS.has(s.body.type) ? nestedStatements(s.body) : [s.body];
    case 'SwitchStatement':
      return s.cases.flatMap((c: Node) => c.consequent);
    case 'TryStatement':
      return [s.block, s.handler?.body, s.finalizer].filter(Boolean);
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
    case 'ExportNamedDeclaration':
    case 'ExportDefaultDeclaration':
      return []; // functions and classes are visited as functions
    default:
      return [];
  }
}

// -- assignments -----------------------------------------------------------------------------------

/** `acct`, `this.balance`; a computed member binds its container (`acct[0] = 1` assigns `acct`). */
export function targetPath(n: Node): string | null {
  if (!n) return null;
  switch (n.type) {
    case 'Identifier':
      return n.name;
    case 'ThisExpression':
      return 'this';
    case 'ParenthesizedExpression':
    case 'TSNonNullExpression':
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
      return targetPath(n.expression);
    case 'MemberExpression': {
      const base = targetPath(n.object);
      if (n.computed) return base;
      return base ? `${base}.${n.property.name}` : null;
    }
    default:
      return null;
  }
}

/** The names a binding pattern binds: `{a, b: [c, ...d]}` gives a, c, d. */
export function patternNames(p: Node): string[] {
  if (!p) return [];
  switch (p.type) {
    case 'Identifier':
      return [p.name];
    case 'ObjectPattern':
      return p.properties.flatMap((q: Node) => (q.type === 'RestElement' ? patternNames(q.argument) : patternNames(q.value)));
    case 'ArrayPattern':
      return p.elements.flatMap((e: Node) => (e ? patternNames(e) : []));
    case 'RestElement':
      return patternNames(p.argument);
    case 'AssignmentPattern':
      return patternNames(p.left);
    case 'TSParameterProperty':
      return patternNames(p.parameter);
    default: {
      const t = targetPath(p); // `[obj.x, arr[0]] = ...`
      return t ? [t] : [];
    }
  }
}

function statementAssigns(s: Node, header: Node[]): string[] {
  const out: string[] = [];
  const decl = s.type === 'ExportNamedDeclaration' ? s.declaration : s;
  if (decl?.type === 'VariableDeclaration') {
    // `let a;` gives a its first value, undefined; `var a;` gives nothing (a hoisted var already has one)
    for (const d of decl.declarations) if (d.init || decl.kind !== 'var') out.push(...patternNames(d.id));
  } else if (s.type === 'ForInStatement' || s.type === 'ForOfStatement' || (s.type === 'LabeledStatement' && (s.body.type === 'ForInStatement' || s.body.type === 'ForOfStatement'))) {
    const left = (s.type === 'LabeledStatement' ? s.body : s).left;
    out.push(...(left.type === 'VariableDeclaration' ? left.declarations.flatMap((d: Node) => patternNames(d.id)) : patternNames(left)));
  } else if (s.type === 'ImportDeclaration') {
    for (const sp of s.specifiers ?? []) out.push(sp.local.name);
  }
  // assignments and updates anywhere in the header, outside nested functions
  walkHeader(header, (n) => {
    if (n.type === 'AssignmentExpression') out.push(...patternNames(n.left));
    else if (n.type === 'UpdateExpression') {
      const t = targetPath(n.argument);
      if (t) out.push(t);
    } else if (n.type === 'VariableDeclarator' && n.init && decl?.type !== 'VariableDeclaration') out.push(...patternNames(n.id)); // `for (let i = 0; ...)`
  });
  return dedupe(out);
}

// -- reads -------------------------------------------------------------------------------------------

/**
 * Visit header nodes in source order, entering expression-bodied arrows (their parameters are
 * reported to `fnParams`) and skipping block-bodied functions and classes.
 */
function walkHeader(nodes: Node[], visit: (n: Node, parent: Node | null, key: string) => boolean | void, fnParams?: (names: string[]) => void): void {
  const walk = (n: Node, parent: Node | null, key: string): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach((x) => walk(x, parent, key));
    if (typeof n.type !== 'string') return;
    if (FUNCTIONS.has(n.type)) {
      if (n.type === 'ArrowFunctionExpression' && n.expression) {
        fnParams?.(n.params.flatMap(patternNames));
        walk(n.body, n, 'body');
      }
      return;
    }
    if (n.type === 'ClassExpression' || n.type === 'ClassDeclaration') return;
    if (visit(n, parent, key) === false) return;
    for (const k in n) {
      if (k === 'type' || k === 'start' || k === 'end') continue;
      const v = n[k];
      if (v && typeof v === 'object') walk(v, n, k);
    }
  };
  for (const h of nodes) walk(h, null, '');
}

/** An Identifier that is a variable reference here, not a property name, key, label or binding. */
function isReference(n: Node, parent: Node | null, key: string): boolean {
  if (!parent) return true;
  switch (parent.type) {
    case 'MemberExpression':
      return key === 'object' || parent.computed;
    case 'Property':
      return key === 'value' || (key === 'key' && parent.computed);
    case 'PropertyDefinition':
    case 'MethodDefinition':
      return key !== 'key' || parent.computed;
    case 'VariableDeclarator':
      return key === 'init';
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      return false;
    case 'MetaProperty':
      return false;
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
    case 'ExportSpecifier':
      return false;
    case 'AssignmentPattern':
      return key === 'right';
    case 'ArrayPattern':
    case 'ObjectPattern':
    case 'RestElement':
      return false;
    case 'AssignmentExpression':
      return key === 'right' || (key === 'left' && parent.operator !== '=');
    default:
      return true;
  }
}

function readNames(s: Node, header: Node[]): string[] {
  const local = new Set<string>();
  const names: [number, string][] = [];
  walkHeader(
    header,
    (n, parent, key) => {
      // binding patterns bind; their defaults and computed keys are rare enough to leave out
      if (parent && ((parent.type === 'VariableDeclarator' && key === 'id') || (parent.type === 'AssignmentExpression' && key === 'left' && parent.operator === '=' && n.type !== 'Identifier' && n.type !== 'MemberExpression'))) return false;
      if (n.type === 'Identifier' && isReference(n, parent, key)) names.push([n.start, n.name]);
      else if (n.type === 'ThisExpression') names.push([n.start, 'this']);
    },
    (params) => params.forEach((p) => local.add(p)),
  );
  // a pattern on the left of `=` binds; its member targets still read their object
  walkHeader(header, (n) => {
    if (n.type === 'AssignmentExpression' && n.operator === '=') {
      const objs: Node[] = [];
      collectPatternMembers(n.left, objs);
      for (const o of objs) {
        const base = rootName(o);
        if (base) names.push([o.start, base]);
      }
    }
  });
  if (s.type === 'ForInStatement' || s.type === 'ForOfStatement') {
    // the loop variable is bound, not read, by the header
    const left = s.left.type === 'VariableDeclaration' ? s.left.declarations.flatMap((d: Node) => patternNames(d.id)) : [];
    for (const l of left) local.add(l);
  }
  names.sort((a, b) => a[0] - b[0]);
  return dedupe(names.map(([, n]) => n).filter((n) => !local.has(n) && (n === 'this' || !isBuiltin(n)))).slice(0, READS_CAP);
}

function collectPatternMembers(p: Node, out: Node[]): void {
  if (!p) return;
  if (p.type === 'MemberExpression') out.push(p);
  else if (p.type === 'ObjectPattern') p.properties.forEach((q: Node) => collectPatternMembers(q.type === 'RestElement' ? q.argument : q.value, out));
  else if (p.type === 'ArrayPattern') p.elements.forEach((e: Node) => collectPatternMembers(e, out));
  else if (p.type === 'AssignmentPattern') collectPatternMembers(p.left, out);
  else if (p.type === 'RestElement') collectPatternMembers(p.argument, out);
}

function rootName(n: Node): string | null {
  while (n && (n.type === 'MemberExpression' || n.type === 'ParenthesizedExpression')) n = n.type === 'MemberExpression' ? n.object : n.expression;
  if (n?.type === 'Identifier') return n.name;
  if (n?.type === 'ThisExpression') return 'this';
  return null;
}

// -- calls -------------------------------------------------------------------------------------------

/** The source text of each call in the header, breadth first over the AST (as `ast.walk`), whitespace collapsed, deduplicated, capped. */
function callTexts(header: Node[], js: string): string[] {
  const out: string[] = [];
  let queue: Node[] = header.filter(Boolean);
  for (let i = 0; i < queue.length && out.length < CALLS_CAP; i++) {
    const n = queue[i];
    if (!n || typeof n !== 'object' || typeof n.type !== 'string') continue;
    if (FUNCTIONS.has(n.type)) {
      if (n.type === 'ArrowFunctionExpression' && n.expression) queue.push(n.body);
      continue;
    }
    if (n.type === 'ClassExpression' || n.type === 'ClassDeclaration') continue;
    if (n.type === 'CallExpression' || n.type === 'NewExpression') {
      const text = js.slice(n.start, n.end).split(/\s+/).filter(Boolean).join(' ');
      if (text && !out.includes(text)) out.push(text);
    }
    for (const k in n) {
      if (k === 'type' || k === 'start' || k === 'end') continue;
      const v = n[k];
      if (Array.isArray(v)) for (const x of v) queue.push(x);
      else if (v && typeof v === 'object') queue.push(v);
    }
  }
  queue = [];
  return out.map((t) => (t.length <= CALL_TEXT_MAX ? t : `${t.slice(0, CALL_TEXT_MAX - 1)}…`));
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

/** The variable history's name rule: exact, or one path under the other (`acct` ~ `acct.deposit`, `this` ~ `this.balance`). */
export function matchesName(candidate: string | null | undefined, query: string): boolean {
  if (!candidate || !query) return false;
  if (candidate === query) return true;
  for (const sep of ['.', '[']) if (candidate.startsWith(query + sep) || query.startsWith(candidate + sep)) return true;
  return false;
}

/** The `bindings` request's table (alias kept for callers of the first version). */
export const bindings = statementBindings;
