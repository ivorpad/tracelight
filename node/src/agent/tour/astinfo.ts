/**
 * What a statement is, for the tour's signals: its own calls, what each call reaches, whether it
 * binds one, from the oxc AST.
 *
 * Pure functions over a file's source, cached per file by `TourRun`. A call is classified by its
 * dotted name: a file write or a child process (`io-write`, `subprocess`), the project's own code
 * (`user`), Node's built-in modules (`stdlib`), a global or a method of a built-in type
 * (`builtin`), else a library (`lib`). JavaScript's equivalents of Python's: `this` for `self`,
 * `fs.writeFileSync` and stream writes for `open(..., "w")`, `child_process` for `subprocess`, a
 * function or a class (declared, or a function expression bound to a name) for a `def`.
 */
import { isBuiltin } from 'node:module';
import { basename, extname, sep } from 'node:path';
import { isJsxPath, isTypeScriptPath, toJavaScript } from '../../instrument.ts';
import { LineIndex } from '../../lines.ts';
import { MappedLineIndex, type Lowered } from '../../lower.ts';
import { parseSync } from '../../parse.ts';

type Node = any;

/** the globals a call can start with that are the runtime's own (`console.log`, `Math.max`, `JSON.stringify`, `new Error`) */
export const BUILTIN_NAMES = new Set<string>([...Object.getOwnPropertyNames(globalThis), 'console', 'process', 'require', 'module', 'exports', 'Buffer', 'globalThis', 'structuredClone', 'queueMicrotask', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'fetch']);
/** methods of built-in types (Array, String, Map, Set, Object, Promise, Number): a call to one is never a library boundary */
export const BUILTIN_METHODS = new Set<string>([
  'push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'concat', 'join', 'map', 'filter', 'reduce', 'reduceRight', 'forEach',
  'find', 'findIndex', 'findLast', 'findLastIndex', 'some', 'every', 'includes', 'indexOf', 'lastIndexOf', 'sort', 'toSorted',
  'reverse', 'toReversed', 'flat', 'flatMap', 'fill', 'at', 'keys', 'values', 'entries', 'get', 'set', 'has', 'delete', 'add',
  'clear', 'split', 'trim', 'trimStart', 'trimEnd', 'toLowerCase', 'toUpperCase', 'startsWith', 'endsWith', 'replace',
  'replaceAll', 'padStart', 'padEnd', 'repeat', 'charAt', 'charCodeAt', 'codePointAt', 'substring', 'substr', 'match', 'matchAll',
  'search', 'localeCompare', 'normalize', 'toString', 'toFixed', 'toPrecision', 'toLocaleString', 'valueOf', 'then', 'catch',
  'finally', 'test', 'exec', 'bind', 'call', 'apply', 'hasOwnProperty', 'toISOString', 'getTime', 'toJSON',
]);
/** a call that writes a file (or a stream) when its object is anything but `this` */
export const WRITE_METHODS = new Set<string>([
  'write', 'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream', 'writeSync', 'writev', 'writevSync',
  'writeJson', 'writeJsonSync', 'outputFile', 'outputFileSync', 'outputJson', 'outputJsonSync', 'copyFile', 'copyFileSync',
  'writelines', 'writerow', 'writerows', 'write_text', 'write_bytes', 'to_csv', 'to_json', 'savefig', 'dump', 'save',
]);
/** the file-system modules whose named imports write (`import { writeFileSync } from 'node:fs'`) */
const FS_MODULES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises', 'fs-extra', 'graceful-fs']);
export const SUBPROCESS = new Set(['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']);
const CHILD_PROCESS = new Set(['child_process', 'node:child_process']);
const FUNCTION_NODES = new Set(['FunctionExpression', 'ArrowFunctionExpression', 'FunctionDeclaration']);
/** a statement whose text is its header line only (Python's compound statements) */
const COMPOUND = new Set(['IfStatement', 'WhileStatement', 'DoWhileStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'TryStatement', 'SwitchStatement', 'LabeledStatement', 'FunctionDeclaration', 'ClassDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'MethodDefinition', 'Property', 'ClassExpression']);
const DEFINITIONS = new Set(['FunctionDeclaration', 'ClassDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'MethodDefinition', 'Property', 'ClassExpression']);
const NOT_STATEMENTS = new Set(['BlockStatement', 'EmptyStatement', 'StaticBlock']);

/** a statement: the AST node, its first and last source line (1-based) */
export interface Stmt {
  node: Node;
  line: number;
  col: number;
  end: number;
}

/** an import's binding: the module, and the name it imports (`default`, `*`, or the exported name) */
export interface Imported {
  module: string;
  name: string;
}

function unparen(n: Node): Node {
  while (n && (n.type === 'ParenthesizedExpression' || n.type === 'ChainExpression' || n.type === 'TSAsExpression' || n.type === 'TSNonNullExpression')) n = n.expression;
  return n;
}

function requireOf(n: Node): string | null {
  n = unparen(n);
  if (n?.type === 'AwaitExpression') n = unparen(n.argument);
  if ((n?.type === 'CallExpression' && n.callee?.type === 'Identifier' && n.callee.name === 'require') || n?.type === 'ImportExpression') {
    const arg = n.type === 'ImportExpression' ? n.source : n.arguments?.[0];
    if (arg?.type === 'Literal' && typeof arg.value === 'string') return arg.value;
  }
  return null;
}

/** One file's parse: statements by position and by first line, imports, the names it defines. */
export class FileInfo {
  readonly lines: string[];
  readonly source: string;
  readonly statements = new Map<number, Stmt>();
  readonly byPos = new Map<string, Stmt>();
  readonly imports = new Map<string, Imported>();
  readonly defs = new Set<string>();
  ok = false;

  constructor(lines: string[], path = 'x.js') {
    this.lines = lines;
    this.source = lines.join('\n');
    let js = this.source;
    let lowered: Lowered | null = null;
    try {
      if (isTypeScriptPath(path) || isJsxPath(path)) ({ js, lowered } = toJavaScript(this.source, path));
    } catch {
      return;
    }
    let r: Node;
    try {
      r = parseSync('x.js', js, { sourceType: 'unambiguous', lang: 'js', preserveParens: false } as any);
    } catch {
      return;
    }
    if (!r || r.errors?.length) return;
    this.ok = true;
    const idx = lowered ? new MappedLineIndex(js, this.source, lowered) : new LineIndex(js);
    const add = (n: Node, at: Node, byLine: boolean) => {
      const [line, col] = idx.pos(at.start);
      const end = idx.pos(Math.max(n.start, n.end - 1))[0];
      const s: Stmt = { node: n, line, col, end };
      const key = `${line}:${col}`;
      if (!this.byPos.has(key)) this.byPos.set(key, s);
      if (byLine && !this.statements.has(line)) this.statements.set(line, s);
    };
    const keyName = (k: Node): string | null => (k?.type === 'Identifier' ? k.name : k?.type === 'PrivateIdentifier' ? `#${k.name}` : k?.type === 'Literal' ? String(k.value) : null);
    const walk = (n: Node, parent: Node | null): void => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) {
        for (const x of n) walk(x, parent);
        return;
      }
      if (typeof n.type !== 'string') return;
      const t: string = n.type;
      if ((t === 'ExportNamedDeclaration' || t === 'ExportDefaultDeclaration') && n.declaration && /Declaration$/.test(n.declaration.type)) {
        add(n.declaration, n, true); // `export function f` is the function's statement, at the `export`
      } else if (t === 'MethodDefinition' || (t === 'Property' && (n.method || n.kind === 'get' || n.kind === 'set') && n.value && FUNCTION_NODES.has(n.value.type))) {
        add(n, n, true);
        const name = keyName(n.key);
        if (name) this.defs.add(name);
      } else if (t === 'FunctionExpression' || t === 'ArrowFunctionExpression') {
        if (!(parent && (parent.type === 'MethodDefinition' || parent.type === 'Property') && parent.value === n)) add(n, n, false);
      } else if ((/Statement$/.test(t) || /Declaration$/.test(t)) && !NOT_STATEMENTS.has(t) && !(t === 'VariableDeclaration' && parent && /^For/.test(parent.type))) {
        add(n, n, true);
      }
      if (t === 'ImportDeclaration' && typeof n.source?.value === 'string') {
        for (const sp of n.specifiers ?? []) {
          const name = sp.type === 'ImportDefaultSpecifier' ? 'default' : sp.type === 'ImportNamespaceSpecifier' ? '*' : (keyName(sp.imported) ?? sp.local.name);
          this.imports.set(sp.local.name, { module: n.source.value, name });
        }
      } else if (t === 'VariableDeclarator') {
        const mod = requireOf(n.init);
        if (mod !== null && n.id?.type === 'Identifier') this.imports.set(n.id.name, { module: mod, name: '*' });
        else if (mod !== null && n.id?.type === 'ObjectPattern') {
          for (const p of n.id.properties ?? []) if (p.type === 'Property' && p.value?.type === 'Identifier') this.imports.set(p.value.name, { module: mod, name: keyName(p.key) ?? p.value.name });
        }
        const init = unparen(n.init);
        if (n.id?.type === 'Identifier' && init && (FUNCTION_NODES.has(init.type) || init.type === 'ClassExpression')) this.defs.add(n.id.name);
      } else if ((t === 'FunctionDeclaration' || t === 'ClassDeclaration' || t === 'ClassExpression' || t === 'FunctionExpression') && n.id?.name) {
        this.defs.add(n.id.name);
      }
      for (const k in n) if (k !== 'type' && n[k] && typeof n[k] === 'object') walk(n[k], n);
    };
    walk(r.program.body, null);
  }

  /** the statement at `line:col` (a step's range), else the first statement starting on `line` */
  at(line: number, col: number | null = null): Stmt | undefined {
    return (col !== null ? this.byPos.get(`${line}:${col}`) : undefined) ?? this.statements.get(line);
  }

  lineText(line: number): string {
    return line > 0 && line <= this.lines.length ? this.lines[line - 1]!.trim() : '';
  }

  /** the whole statement starting at `line`; a compound statement's (or a function's) header line only */
  statementText(line: number, col: number | null = null): string {
    const s = this.at(line, col);
    if (s === undefined || COMPOUND.has(s.node.type)) return this.lineText(line);
    return this.lines
      .slice(line - 1, s.end)
      .map((l) => l.trimEnd())
      .join('\n')
      .trim();
  }
}

/** the call nodes (calls and `new`) a statement makes itself: a compound statement's header only, never a nested function */
export function ownCalls(stmt: Stmt | null | undefined): Node[] {
  if (!stmt) return [];
  const n = stmt.node;
  let roots: Node[];
  switch (n.type) {
    case 'IfStatement':
    case 'WhileStatement':
    case 'DoWhileStatement':
      roots = [n.test];
      break;
    case 'ForOfStatement':
    case 'ForInStatement':
      roots = [n.right];
      break;
    case 'ForStatement':
      roots = [n.init, n.test];
      break;
    case 'SwitchStatement':
    case 'TryStatement':
    case 'LabeledStatement':
      roots = [];
      break;
    default:
      roots = DEFINITIONS.has(n.type) ? [] : [n];
  }
  const out: Node[] = [];
  const stack = roots.filter(Boolean);
  while (stack.length) {
    const x = stack.pop();
    if (!x || typeof x !== 'object') continue;
    if (Array.isArray(x)) {
      stack.push(...x);
      continue;
    }
    if (typeof x.type !== 'string' || FUNCTION_NODES.has(x.type) || x.type === 'ClassExpression' || x.type === 'ClassDeclaration') continue;
    if (x.type === 'CallExpression' || x.type === 'NewExpression') out.push(x);
    for (const k in x) if (k !== 'type' && x[k] && typeof x[k] === 'object') stack.push(x[k]);
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end); // `f(x).g()`: the inner call is made first
  return out;
}

/** `a.b.c` of a callee as its parts: `this`, `<call>` for a call's result, `<expr>` for anything else (a subscript) */
export function dotted(func: Node): string[] {
  const parts: string[] = [];
  let f = unparen(func);
  while (f && f.type === 'MemberExpression' && !f.computed) {
    parts.push(f.property?.type === 'PrivateIdentifier' ? `#${f.property.name}` : String(f.property?.name));
    f = unparen(f.object);
  }
  if (f?.type === 'Identifier') parts.push(f.name);
  else if (f?.type === 'ThisExpression') parts.push('this');
  else if (f?.type === 'Super') parts.push('super');
  else if (f?.type === 'CallExpression' || f?.type === 'NewExpression') parts.push('<call>');
  else parts.push('<expr>');
  return parts.reverse();
}

function hasCall(n: Node): boolean {
  const stack = [n];
  while (stack.length) {
    const x = stack.pop();
    if (!x || typeof x !== 'object') continue;
    if (Array.isArray(x)) {
      stack.push(...x);
      continue;
    }
    if (x.type === 'CallExpression' || x.type === 'NewExpression') return true;
    for (const k in x) if (k !== 'type' && x[k] && typeof x[k] === 'object') stack.push(x[k]);
  }
  return false;
}

/** `const x = f(...)`, `x += f(...)`, `await f(...)`: a statement that keeps (or awaits) a call's result */
export function bindsCall(stmt: Stmt | null | undefined): boolean {
  const n = stmt?.node;
  if (!n) return false;
  if (n.type === 'VariableDeclaration') return (n.declarations ?? []).some((d: Node) => d.init && hasCall(d.init));
  if (n.type === 'ExpressionStatement') {
    const e = unparen(n.expression);
    if (e?.type === 'AssignmentExpression') return hasCall(e.right);
    if (e?.type === 'AwaitExpression') return hasCall(e);
  }
  return false;
}

const DEF_TEXT = /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function\b|class\b)/;

/** a function or a class (its header step), by the AST or by the text */
export function isDefinition(stmt: Stmt | null | undefined, text: string): boolean {
  return (!!stmt && DEFINITIONS.has(stmt.node.type)) || DEF_TEXT.test(text.trimStart());
}

/**
 * `return f(...)`, `return await f(...)`, `await f(...)`, `return name`: a statement that hands a
 * callee's value on as it came; the callee's own return is the stop.
 */
export function isForward(stmt: Stmt | null | undefined): boolean {
  const n = stmt?.node;
  if (!n) return false;
  let v: Node;
  if (n.type === 'ReturnStatement' && n.argument) v = unparen(n.argument);
  else if (n.type === 'ExpressionStatement' && unparen(n.expression)?.type === 'AwaitExpression') v = unparen(n.expression);
  else return false;
  if (v.type === 'AwaitExpression') v = unparen(v.argument);
  if (v?.type === 'Identifier' && n.type === 'ReturnStatement') return true;
  if (v?.type !== 'CallExpression') return false;
  const callee = unparen(v.callee);
  return callee?.type === 'Identifier' || callee?.type === 'MemberExpression';
}

/** names a project import can start with: each recorded file's stem and its directory's name */
export function moduleRoots(paths: Iterable<string>): Set<string> {
  const roots = new Set<string>();
  for (const p of paths) {
    const parts = p.split(sep);
    const last = parts[parts.length - 1]!;
    roots.add(basename(last, extname(last)));
    if (parts.length > 1) roots.add(parts[parts.length - 2]!);
  }
  return roots;
}

function moduleKind(mod: string, roots: Set<string>): string {
  if (mod.startsWith('.') || mod.startsWith('/') || mod.startsWith('file:')) return 'user';
  const top = mod.startsWith('@') ? mod.split('/').slice(0, 2).join('/') : mod.split('/')[0]!;
  if (roots.has(top)) return 'user';
  return isBuiltin(mod) ? 'stdlib' : 'lib';
}

function stringArg(n: Node): string | null {
  return n?.type === 'Literal' && typeof n.value === 'string' ? n.value : n?.type === 'TemplateLiteral' && !n.expressions?.length ? String(n.quasis?.[0]?.value?.cooked ?? '') : null;
}

/** `[kind, label]` for one call; `nextEntry` is the function the next step entered, when it entered one */
export function classifyCall(call: Node, info: FileInfo, roots: Set<string>, defs: Set<string>, nextEntry: string | null): [string, string] {
  const parts = dotted(call.callee);
  const root = parts[0]!;
  const last = parts[parts.length - 1]!;
  const label = parts.join('.');
  const imp = info.imports.get(root);
  // what the call names in its module: `writeFileSync` of `import { writeFileSync }`, `spawn` of `cp.spawn`
  const named = imp ? (parts.length === 1 ? imp.name : last) : null;
  if (imp && FS_MODULES.has(imp.module) && named !== null) {
    if (named === 'open' || named === 'openSync') {
      const mode = stringArg(call.arguments?.[1]);
      if (mode !== null && /[wax]/.test(mode)) return ['io-write', label];
    } else if (WRITE_METHODS.has(named)) return ['io-write', label];
  }
  if (imp && CHILD_PROCESS.has(imp.module) && named !== null && SUBPROCESS.has(named)) return ['subprocess', label];
  if (parts.length > 1 && WRITE_METHODS.has(last) && root !== 'this') return ['io-write', label];
  if (imp) return [moduleKind(imp.module, roots), label];
  if (root === 'this' || root === 'super' || (defs.has(root) && parts.length === 1)) return ['user', label];
  if (BUILTIN_NAMES.has(root)) return ['builtin', label];
  if (parts.length > 1 && BUILTIN_METHODS.has(last)) return ['builtin', label];
  if (defs.has(last)) return ['user', label];
  if (nextEntry !== null && nextEntry.split('.').pop() === last) return ['user', label]; // an opaque call on a local object that entered a recorded frame
  return ['lib', label];
}
