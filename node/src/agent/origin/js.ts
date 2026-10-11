/**
 * The JavaScript side of `origin`: what Pyokka's `origin` reads from Python's `ast`, from the oxc
 * AST instead (`parseProgram`, as bindings.ts parses for the recorder). A file is parsed once; its
 * statements and function headers are looked up by the `line:col` a step's range starts at, and a
 * node's source text is cut from the original file (TypeScript is lowered for the parse, lines kept).
 */
import { parseProgram } from '../../bindings.ts';
import { LineIndex } from '../../lines.ts';
import { MappedLineIndex } from '../../lower.ts';

export type Node = any;

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
/** wrappers that do not change the value: `(x)`, `a?.b`, `x!`, `x as T` */
const WRAPPERS = new Set(['ParenthesizedExpression', 'ChainExpression', 'TSNonNullExpression', 'TSAsExpression', 'TSSatisfiesExpression', 'TSTypeAssertion']);

export function isFunction(n: Node): boolean {
  return !!n && FUNCTIONS.has(n.type);
}

/** the expression without parentheses, `?.` chains and type assertions around it */
export function unwrap(n: Node): Node {
  while (n && WRAPPERS.has(n.type)) n = n.expression;
  return n;
}

export class JsFile {
  readonly source: string;
  /** `line:col` of a statement's start, or of a function's header (a method's: the method's own start) -> the node */
  readonly table = new Map<string, Node>();
  private readonly lines: LineIndex | null = null;
  private readonly src: LineIndex;

  constructor(source: string, path: string) {
    this.source = source;
    this.src = new LineIndex(source);
    let program: Node;
    try {
      const parsed = parseProgram(source, path || 'x.js');
      program = parsed.program;
      this.lines = parsed.lowered ? new MappedLineIndex(parsed.js, source, parsed.lowered) : new LineIndex(parsed.js);
    } catch {
      return;
    }
    const put = (at: number, n: Node) => {
      const [l, c] = this.lines!.pos(at);
      const key = `${l}:${c}`;
      if (!this.table.has(key)) this.table.set(key, n);
    };
    const visit = (n: Node, parent: Node | null): void => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) return n.forEach((x) => visit(x, parent));
      if (typeof n.type !== 'string') return;
      if (FUNCTIONS.has(n.type)) {
        const method = parent && (parent.type === 'MethodDefinition' || (parent.type === 'Property' && (parent.method || parent.kind === 'get' || parent.kind === 'set')));
        put(method ? parent.start : n.start, n);
      } else if (/(Statement|Declaration)$/.test(n.type) && !n.type.startsWith('TS')) put(n.start, n);
      for (const k in n) {
        if (k === 'type' || k === 'start' || k === 'end') continue;
        const v = n[k];
        if (v && typeof v === 'object') visit(v, n);
      }
    };
    visit(program.body, null);
  }

  at(line: number, col: number): Node | null {
    return this.table.get(`${line}:${col}`) ?? null;
  }

  /** 1-based first and last line of a node */
  span(n: Node): [number, number] {
    if (!this.lines) return [0, 0];
    return [this.lines.pos(n.start)[0], this.lines.pos(Math.max(n.start, n.end - 1))[0]];
  }

  /** the node's source text, whitespace collapsed */
  segment(n: Node): string {
    if (!this.lines || !n) return '';
    const [sl, sc] = this.lines.pos(n.start);
    const [el, ec] = this.lines.pos(Math.max(n.start, n.end - 1));
    const text = this.source.slice(this.src.offset(sl, sc), this.src.offset(el, ec) + (n.end > n.start ? 1 : 0));
    return text.split(/\s+/).filter(Boolean).join(' ');
  }
}

/** an Identifier that reads a variable here (not a property name, a key, a label, a parameter or a binding) */
export function isReference(parent: Node | null, key: string): boolean {
  if (!parent) return true;
  if (FUNCTIONS.has(parent.type) || parent.type === 'ClassDeclaration' || parent.type === 'ClassExpression') return key === 'body' || key === 'superClass';
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
    case 'MetaProperty':
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
    case 'ExportSpecifier':
    case 'ArrayPattern':
    case 'ObjectPattern':
    case 'RestElement':
    case 'CatchClause':
      return false;
    case 'AssignmentPattern':
      return key === 'right';
    case 'AssignmentExpression':
      return key === 'right' || (key === 'left' && parent.operator !== '=');
    case 'UpdateExpression':
      return true;
    default:
      return true;
  }
}

/**
 * The parts of a statement that run at its own step, as bindings.ts's header nodes (an `if`'s
 * test, not its blocks); a function header is its parameters' defaults. Python's `ast.walk` over a
 * statement walks its blocks too; a JavaScript block's statements are steps of their own.
 */
export function headerNodes(s: Node): Node[] {
  if (!s) return [];
  if (FUNCTIONS.has(s.type)) return s.type === 'ArrowFunctionExpression' && s.expression ? [...s.params, s.body] : [...s.params];
  switch (s.type) {
    case 'IfStatement':
    case 'WhileStatement':
    case 'DoWhileStatement':
      return [s.test];
    case 'ForStatement':
      return [s.init, s.test, s.update].filter(Boolean);
    case 'ForInStatement':
    case 'ForOfStatement':
      return [s.left, s.right];
    case 'LabeledStatement':
      return headerNodes(s.body);
    case 'WithStatement':
      return [s.object];
    case 'SwitchStatement':
      return [s.discriminant];
    case 'ReturnStatement':
    case 'ThrowStatement':
      return s.argument ? [s.argument] : [];
    case 'ExpressionStatement':
      return [s.expression];
    case 'VariableDeclaration':
      return [s];
    case 'ExportNamedDeclaration':
      return s.declaration?.type === 'VariableDeclaration' ? [s.declaration] : [];
    case 'ExportDefaultDeclaration':
      return s.declaration && !FUNCTIONS.has(s.declaration.type) && !/^Class/.test(s.declaration.type) ? [s.declaration] : [];
    default:
      return [];
  }
}

/**
 * Every node under `roots`, breadth first as Python's `ast.walk`, with its parent and the key it
 * sits under; a block-bodied function's body is not entered (its statements are steps of their
 * own), an expression-bodied arrow's is (it runs at the arrow's one step).
 */
export function walk(roots: Node[]): [Node, Node | null, string][] {
  const out: [Node, Node | null, string][] = [];
  const queue: [Node, Node | null, string][] = roots.filter(Boolean).map((r) => [r, null, '']);
  while (queue.length) {
    const item = queue.shift()!;
    const n = item[0];
    out.push(item);
    for (const k in n) {
      if (k === 'type' || k === 'start' || k === 'end') continue;
      if (FUNCTIONS.has(n.type) && k === 'body' && !(n.type === 'ArrowFunctionExpression' && n.expression)) continue;
      if ((n.type === 'ClassDeclaration' || n.type === 'ClassExpression') && k === 'body') continue;
      const v = n[k];
      if (Array.isArray(v)) {
        for (const x of v) if (x && typeof x === 'object' && typeof x.type === 'string') queue.push([x, n, k]);
      } else if (v && typeof v === 'object' && typeof v.type === 'string') queue.push([v, n, k]);
    }
  }
  return out;
}

/** the variable names an expression reads, in `ast.walk` order, each once (`this` included) */
export function namesIn(node: Node): string[] {
  const out: string[] = [];
  for (const [n, parent, key] of walk([node])) {
    let name: string | null = null;
    if (n.type === 'Identifier' && isReference(parent, key)) name = n.name;
    else if (n.type === 'ThisExpression') name = 'this';
    if (name !== null && !out.includes(name)) out.push(name);
  }
  return out;
}

/** the variable the access chain starts from: `items` for `items[0].price`, `this` for `this.x` */
export function baseName(n: Node): string | null {
  n = unwrap(n);
  while (n && (n.type === 'MemberExpression' || WRAPPERS.has(n.type))) n = n.type === 'MemberExpression' ? n.object : n.expression;
  if (n?.type === 'Identifier') return n.name;
  if (n?.type === 'ThisExpression') return 'this';
  return null;
}

const LITERAL_CTORS = new Set(['Map', 'Set', 'Array', 'Object', 'WeakMap', 'WeakSet']);

/** a value written out in the source: `1`, `'a'`, `` `a${b}` ``, `[1, 2]`, `{ a: 1 }`, `new Map()`, `undefined` */
export function isLiteral(n: Node): boolean {
  n = unwrap(n);
  if (!n) return false;
  switch (n.type) {
    case 'Literal':
    case 'TemplateLiteral':
      return true;
    case 'Identifier':
      return n.name === 'undefined' || n.name === 'NaN' || n.name === 'Infinity';
    case 'UnaryExpression':
      return (n.operator === '-' || n.operator === '+' || n.operator === '!') && isLiteral(n.argument);
    case 'ArrayExpression':
      return n.elements.every((e: Node) => e === null || isLiteral(e));
    case 'ObjectExpression':
      return n.properties.every((p: Node) => p.type === 'Property' && !p.computed && p.kind === 'init' && !p.method && !p.shorthand && isLiteral(p.value));
    case 'NewExpression':
      return n.callee.type === 'Identifier' && LITERAL_CTORS.has(n.callee.name) && n.arguments.every((a: Node) => isLiteral(a));
    default:
      return false;
  }
}

/** a constant key in the source: a string or number literal, `-1`, a template without `${}` */
export function constantKey(n: Node): { value: unknown } | null {
  n = unwrap(n);
  if (!n) return null;
  if (n.type === 'Literal' && (typeof n.value === 'string' || typeof n.value === 'number' || typeof n.value === 'boolean' || n.value === null)) return { value: n.value };
  if (n.type === 'TemplateLiteral' && !n.expressions.length) return { value: n.quasis[0]?.value?.cooked ?? '' };
  if (n.type === 'UnaryExpression' && n.operator === '-' && n.argument.type === 'Literal' && typeof n.argument.value === 'number') return { value: -n.argument.value };
  return null;
}

/** the property name of `a.b` (and of `a.#b`), null for `a[k]` */
export function propertyName(m: Node): string | null {
  if (m.computed) return null;
  if (m.property.type === 'Identifier') return m.property.name;
  if (m.property.type === 'PrivateIdentifier') return '#' + m.property.name;
  return null;
}

/** the names a parameter or a binding pattern binds, in order */
export function patternNames(p: Node): string[] {
  if (!p) return [];
  switch (p.type) {
    case 'Identifier':
      return [p.name];
    case 'AssignmentPattern':
      return patternNames(p.left);
    case 'RestElement':
      return patternNames(p.argument);
    case 'ArrayPattern':
      return p.elements.flatMap((e: Node) => patternNames(e));
    case 'ObjectPattern':
      return p.properties.flatMap((q: Node) => patternNames(q.type === 'RestElement' ? q.argument : q.value));
    case 'TSParameterProperty':
      return patternNames(p.parameter);
    default:
      return [];
  }
}

/** Array methods whose callback gets the elements: the parameter that holds the element (reduce: the second) */
export const ELEMENT_CALLBACKS: Record<string, number> = {
  map: 0, forEach: 0, filter: 0, find: 0, findIndex: 0, findLast: 0, findLastIndex: 0, some: 0, every: 0, flatMap: 0, reduce: 1, reduceRight: 1,
};
