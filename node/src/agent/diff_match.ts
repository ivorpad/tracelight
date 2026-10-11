/**
 * Statement matching and hit comparison for `diff` (`diff.ts`), as Pyokka's `agent/diff_match.py`:
 * pure functions over source text and facts.
 *
 * A file's statements come from the oxc AST instead of Python's `ast`: simple statements, compound
 * headers (`if`, loops, `try`, `switch`) and function or class headers (`function f(`, `class C`,
 * a method, `const f = (…) => {`). A statement is keyed by its enclosing function (`Class.method`,
 * `outer.inner`, `<module>`) and a normalized text: its AST with positions, raw literal spellings
 * and parentheses left out and the bodies of compound statements and functions cut, so
 * whitespace, comments, quote style and line shifts do not matter (Python's `ast.unparse`).
 */
import { statementBindings } from '../bindings.ts';
import { isJsxPath, isTypeScriptPath } from '../instrument.ts';
import { LineIndex } from '../lines.ts';
import { parseSync } from '../parse.ts';
import { REDACTED, redact } from './redact.ts';

type Node = any;
type Msg = Record<string, any>;

export const HITS_MAX = 5;
// the address in a default repr (`<function f at 0x101d10720>`, `<Graph object at 0x108a254f0>`):
// two runs put the same object somewhere else, so it is left out of the comparison (not the text shown)
const ADDRESS = /(?<= at )0x[0-9a-fA-F]+/g;

// -- difflib.SequenceMatcher (no junk, autojunk=False) ---------------------------------------------------------

export type Opcode = ['equal' | 'replace' | 'delete' | 'insert', number, number, number, number];

/** Python's `difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes()`; elements compare by `key` */
export function opcodes<T>(a: T[], b: T[], key: (x: T) => string = (x) => (typeof x === 'string' ? x : JSON.stringify(x))): Opcode[] {
  const ka = a.map(key);
  const kb = b.map(key);
  const b2j = new Map<string, number[]>();
  kb.forEach((k, j) => {
    let list = b2j.get(k);
    if (!list) b2j.set(k, (list = []));
    list.push(j);
  });
  const longest = (alo: number, ahi: number, blo: number, bhi: number): [number, number, number] => {
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const next = new Map<number, number>();
      for (const j of b2j.get(ka[i]!) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        next.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = next;
    }
    while (besti > alo && bestj > blo && ka[besti - 1] === kb[bestj - 1]) {
      besti--;
      bestj--;
      bestsize++;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && ka[besti + bestsize] === kb[bestj + bestsize]) bestsize++;
    return [besti, bestj, bestsize];
  };
  const queue: [number, number, number, number][] = [[0, ka.length, 0, kb.length]];
  const blocks: [number, number, number][] = [];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const [i, j, k] = longest(alo, ahi, blo, bhi);
    if (k) {
      blocks.push([i, j, k]);
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
  const merged: [number, number, number][] = [];
  let [i1, j1, k1] = [0, 0, 0];
  for (const [i2, j2, k2] of blocks) {
    if (i1 + k1 === i2 && j1 + k1 === j2) k1 += k2;
    else {
      if (k1) merged.push([i1, j1, k1]);
      [i1, j1, k1] = [i2, j2, k2];
    }
  }
  if (k1) merged.push([i1, j1, k1]);
  merged.push([ka.length, kb.length, 0]);
  const out: Opcode[] = [];
  let i = 0;
  let j = 0;
  for (const [ai, bj, size] of merged) {
    const tag = i < ai && j < bj ? 'replace' : i < ai ? 'delete' : j < bj ? 'insert' : '';
    if (tag) out.push([tag, i, ai, j, bj]);
    i = ai + size;
    j = bj + size;
    if (size) out.push(['equal', ai, i, bj, j]);
  }
  return out;
}

// -- statements of a file ---------------------------------------------------------------------------------------

export interface Stmt {
  line: number;
  end: number;
  function: string;
  text: string;
  norm: string;
  kind: 'def' | 'header' | 'stmt';
  /** every line of the statement (a compound one: its header line) */
  source: string;
}

/** The text a diff parses: redacted the way a saved run's copy is, with the mark made an identifier so it still parses. */
export function safeSource(text: string): string {
  return redact(text).split(REDACTED).join('_redacted_');
}

const LOOPS = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement']);
const TYPE_ONLY = new Set(['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSDeclareFunction']);
const NORM_SKIP = new Set(['start', 'end', 'raw', 'range', 'loc', 'decorators']);

function langOf(path: string): string {
  if (/\.tsx$/i.test(path)) return 'tsx';
  if (isTypeScriptPath(path)) return 'ts';
  return 'jsx';
}

function parse(source: string, path: string): Node | null {
  const opts = (lang: string) => ({ sourceType: 'unambiguous', lang, preserveParens: false }) as any;
  let r = parseSync('x.' + langOf(path), source, opts(langOf(path)));
  if (r.errors?.length && !isTypeScriptPath(path) && !isJsxPath(path)) {
    const again = parseSync('x.ts', source, opts('ts')); // the host may not say the language
    if (!again.errors?.length) r = again;
  }
  return r.errors?.length ? null : r.program;
}

const isFunction = (n: Node) => n && (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression' || n.type === 'FunctionDeclaration');
/** a function with statements of its own (an expression-bodied arrow has none: it belongs to the statement holding it) */
const hasBody = (n: Node) => isFunction(n) && n.body?.type === 'BlockStatement';
const isClass = (n: Node) => n && (n.type === 'ClassExpression' || n.type === 'ClassDeclaration');

/** Every statement of the file in line order: simple statements, compound headers, function and class headers. */
export function parseStatements(source: string, path = 'x.js'): Stmt[] {
  let program: Node;
  try {
    program = parse(source, path);
  } catch {
    return [];
  }
  if (!program) return [];
  const index = new LineIndex(source);
  const lines = source.split('\n');
  const lineOf = (offset: number) => index.line(offset);
  const endOf = (n: Node) => index.line(Math.max(n.start, n.end - 1));
  const raw = (line: number) => (line > 0 && line <= lines.length ? lines[line - 1]!.trim() : '');
  const out: Stmt[] = [];

  const keyName = (k: Node, kind?: string): string => {
    let name = k?.type === 'Identifier' ? k.name : k?.type === 'PrivateIdentifier' ? `#${k.name}` : k?.type === 'Literal' ? String(k.value) : '<computed>';
    if (kind === 'get' || kind === 'set') name = `${kind} ${name}`;
    return name;
  };
  /** the name a function gets from where it is (decisions.ts's rule) */
  const inferName = (n: Node, parent: Node | null, key: string): string => {
    if (n.id?.name) return n.id.name;
    if (parent?.type === 'VariableDeclarator' && key === 'init' && parent.id?.type === 'Identifier') return parent.id.name;
    if (parent?.type === 'AssignmentExpression' && key === 'right') return source.slice(parent.left.start, parent.left.end).split(/\s+/).join('');
    if ((parent?.type === 'Property' || parent?.type === 'PropertyDefinition') && key === 'value') return keyName(parent.key, parent.kind);
    if (isClass(n)) return '<class>';
    return n.type === 'ArrowFunctionExpression' ? '<arrow>' : '<anonymous>';
  };

  /** the functions and classes with a body of their own inside `n`, not inside them: `[node, name]` */
  const innerScopes = (n: Node, parent: Node | null, key: string, found: [Node, string][]): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      for (const x of n) innerScopes(x, parent, key, found);
      return;
    }
    if (typeof n.type !== 'string') return;
    if (hasBody(n) || isClass(n)) {
      found.push([n, inferName(n, parent, key)]);
      return;
    }
    for (const k in n) if (k !== 'type' && n[k] && typeof n[k] === 'object') innerScopes(n[k], n, k, found);
  };

  const norm = (n: Node, cut: Set<Node>): string => {
    try {
      return JSON.stringify(n, (k, v) => {
        if (NORM_SKIP.has(k)) return undefined;
        if (v !== null && typeof v === 'object' && cut.has(v)) return null;
        if (typeof v === 'bigint') return `${v}n`;
        return v;
      });
    } catch {
      return '';
    }
  };

  const push = (node: Node, qual: string[], kind: Stmt['kind'], cut: Set<Node>, line = lineOf(node.start)): void => {
    const end = endOf(node);
    const head = raw(line);
    const simple = kind === 'stmt';
    out.push({
      line,
      end: simple ? end : line,
      function: qual.join('.') || '<module>',
      text: !simple || end === line ? head : head + ' …',
      norm: norm(node, cut) || head.split(/\s+/).filter(Boolean).join(' '),
      kind,
      source: simple ? lines.slice(line - 1, end).join('\n') : head,
    });
  };

  const visitClass = (cls: Node, qual: string[]): void => {
    for (const m of cls.body?.body ?? []) {
      if (!m || m.type?.startsWith('TS') || m.declare || m.value?.type === 'TSEmptyBodyFunctionExpression') continue;
      if (m.type === 'StaticBlock') {
        m.body.forEach((s: Node) => visit(s, qual));
        continue;
      }
      if ((m.type === 'MethodDefinition' || m.type === 'PropertyDefinition' || m.type === 'AccessorProperty') && (hasBody(m.value) || isClass(m.value))) {
        push(m, qual, 'def', new Set([m.value.body]));
        const name = m.type === 'MethodDefinition' ? keyName(m.key, m.kind === 'constructor' || m.kind === 'method' ? undefined : m.kind) : keyName(m.key);
        scope(m.value, [...qual, name]);
        continue;
      }
      statement(m, qual, m);
    }
  };

  /** the statements of a function's body, or a class's members */
  const scope = (fn: Node, qual: string[]): void => {
    if (isClass(fn)) visitClass(fn, qual);
    else if (fn.body?.type === 'BlockStatement') fn.body.body.forEach((s: Node) => visit(s, qual));
  };

  /** a statement that is not a function or class header: compound (its bodies cut) or simple */
  const statement = (node: Node, qual: string[], whole: Node): void => {
    const bodies: Node[] = [];
    let header: Node[] = [node];
    switch (node.type) {
      case 'IfStatement':
        bodies.push(node.consequent, node.alternate);
        header = [node.test];
        break;
      case 'ForStatement':
        bodies.push(node.body);
        header = [node.init, node.test, node.update];
        break;
      case 'ForInStatement':
      case 'ForOfStatement':
        bodies.push(node.body);
        header = [node.left, node.right];
        break;
      case 'WhileStatement':
      case 'DoWhileStatement':
        bodies.push(node.body);
        header = [node.test];
        break;
      case 'WithStatement':
        bodies.push(node.body);
        header = [node.object];
        break;
      case 'TryStatement':
        bodies.push(node.block, node.handler?.body, node.finalizer);
        header = [];
        break;
      case 'SwitchStatement':
        bodies.push(...(node.cases ?? []));
        header = [node.discriminant];
        break;
    }
    const compoundBodies = bodies.filter(Boolean);
    const scopes: [Node, string][] = [];
    for (const h of header) innerScopes(h, null, '', scopes);
    const cut = new Set<Node>([...compoundBodies]);
    for (const [fn] of scopes) cut.add(isClass(fn) ? fn.body : fn.body);
    const compound = node.type === 'IfStatement' || LOOPS.has(node.type) || node.type === 'TryStatement' || node.type === 'SwitchStatement' || node.type === 'WithStatement';
    // `const f = () => {`, `exports.f = function () {`: a function header, as Python's `def` line
    const d = whole.type === 'ExportNamedDeclaration' || whole.type === 'ExportDefaultDeclaration' ? whole.declaration ?? whole : whole;
    const defines =
      !compound &&
      scopes.length > 0 &&
      ((d.type === 'VariableDeclaration' && d.declarations.every((v: Node) => !v.init || hasBody(v.init) || isClass(v.init))) ||
        (d.type === 'ExpressionStatement' && d.expression.type === 'AssignmentExpression' && (hasBody(d.expression.right) || isClass(d.expression.right))) ||
        hasBody(d) ||
        isClass(d) ||
        ((d.type === 'PropertyDefinition' || d.type === 'AccessorProperty') && (hasBody(d.value) || isClass(d.value))));
    push(whole, qual, compound || scopes.length ? (defines ? 'def' : 'header') : 'stmt', cut);
    for (const [fn, name] of scopes) scope(fn, [...qual, name]);
    if (node.type === 'SwitchStatement') for (const c of node.cases ?? []) c.consequent.forEach((s: Node) => visit(s, qual));
    else for (const b of compoundBodies) visit(b, qual);
  };

  const visit = (node: Node, qual: string[]): void => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'BlockStatement' || node.type === 'StaticBlock') return node.body.forEach((s: Node) => visit(s, qual));
    if (node.type === 'EmptyStatement' || node.type === 'LabeledStatement') return node.type === 'LabeledStatement' ? visit(node.body, qual) : undefined;
    if (TYPE_ONLY.has(node.type) || node.declare || node.importKind === 'type' || node.exportKind === 'type') return;
    let d = node;
    if ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration') && node.declaration) {
      d = node.declaration;
      if (TYPE_ONLY.has(d.type) || d.declare) return;
    }
    if (d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration' || ((d.type === 'FunctionExpression' || d.type === 'ClassExpression') && d !== node)) {
      if (d.type.startsWith('Function') && !d.body) return; // an overload signature
      push(node, qual, 'def', new Set([d.body]));
      scope(d, [...qual, d.id?.name ?? 'default']);
      return;
    }
    statement(d, qual, node);
  };

  for (const s of program.body) visit(s, []);
  return out.map((s, i) => [s, i] as const).sort((x, y) => x[0].line - y[0].line || x[1] - y[1]).map(([s]) => s);
}

/** every name a statement of the file assigns, first seen first */
export function assignedNames(source: string, path = 'x.js'): string[] {
  let entries;
  try {
    entries = statementBindings(source, path);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  for (const e of entries) for (const name of e.assigns ?? []) seen.add(String(name));
  return [...seen];
}

// -- pairing statements -----------------------------------------------------------------------------------------

export type StmtPair = [Stmt | null, Stmt | null, 'same' | 'edited' | 'added' | 'removed'];

/** `[a, b, status]` for every statement of the two versions; and how many statements an edit left alone */
export function pairStatements(sa: Stmt[], sb: Stmt[]): [StmtPair[], number] {
  const key = (s: Stmt) => JSON.stringify([s.function, s.norm]);
  const out: StmtPair[] = [];
  let same = 0;
  for (const [op, i1, i2, j1, j2] of opcodes(sa, sb, key)) {
    if (op === 'equal') {
      for (let k = 0; k < i2 - i1; k++) out.push([sa[i1 + k]!, sb[j1 + k]!, 'same']);
      same += i2 - i1;
      continue;
    }
    const left = range(i1, i2);
    const right = range(j1, j2);
    while (left.length && right.length && sa[left[0]!]!.function === sb[right[0]!]!.function) out.push([sa[left.shift()!]!, sb[right.shift()!]!, 'edited']);
    for (const i of left) out.push([sa[i]!, null, 'removed']);
    for (const j of right) out.push([null, sb[j]!, 'added']);
  }
  return [out, same];
}

function range(a: number, b: number): number[] {
  return Array.from({ length: Math.max(0, b - a) }, (_, k) => a + k);
}

// -- comparing hits ------------------------------------------------------------------------------------------------

/** `text` with memory addresses in object reprs blanked, for comparing; other values unchanged */
export function comparableText(text: unknown): unknown {
  return typeof text === 'string' ? text.replace(ADDRESS, '0x') : text;
}

const hit = (f: Msg | null): Msg | null => (f ? { text: f.text, step: f.step } : null);

/** the callee's last step when the walkthrough knew it, else the call's own step */
function returnStep(fact: Msg): number {
  const step = fact.returnStep;
  return step !== null && step !== undefined ? Number(step) : Number(fact.step);
}

/** a channel's hits on both sides, paired: the nth against the nth, or aligned when a hit came or went */
export function compareHits(channel: (string | null)[], fa: Msg[], fb: Msg[]): Msg[] {
  const kind = channel[0];
  const name = channel.length > 1 ? channel[1] : null;
  const out: Msg[] = [];
  const ta = fa.map((f) => comparableText(f.text));
  const tb = fb.map((f) => comparableText(f.text));
  const textKey = (x: unknown) => JSON.stringify(x ?? null);
  const ops: Opcode[] =
    ta.length === tb.length ? ta.map((x, i) => [textKey(x) === textKey(tb[i]) ? 'equal' : 'replace', i, i + 1, i, i + 1] as Opcode) : opcodes(ta, tb, textKey);
  for (const [op, i1, i2, j1, j2] of ops) {
    if (op === 'equal') {
      if (kind === 'call') {
        // a return the walkthrough saw on both sides
        for (let k = 0; k < Math.min(i2 - i1, j2 - j1); k++) {
          const x = fa[i1 + k]!;
          const y = fb[j1 + k]!;
          const ra = x.returned;
          const rb = y.returned;
          if (ra !== null && ra !== undefined && rb !== null && rb !== undefined && comparableText(ra) !== comparableText(rb)) {
            out.push({ kind: 'return', name, call: x.text, a: { text: ra, step: returnStep(x) }, b: { text: rb, step: returnStep(y) } });
          }
        }
      }
      continue;
    }
    const n = Math.max(i2 - i1, j2 - j1);
    for (let k = 0; k < n; k++) {
      const x = i1 + k < i2 ? fa[i1 + k]! : null;
      const y = j1 + k < j2 ? fb[j1 + k]! : null;
      out.push({ kind, name, a: hit(x), b: hit(y) });
    }
  }
  return out;
}

/** at most `HITS_MAX` facts per kind and name, then one `{kind, name, more}` saying how many were left out */
export function capFacts(facts: Msg[]): Msg[] {
  const by = new Map<string, number>();
  const hidden = new Map<string, [unknown, unknown, number]>();
  const out: Msg[] = [];
  for (const f of facts) {
    const key = JSON.stringify([f.kind, f.name ?? null]);
    by.set(key, (by.get(key) ?? 0) + 1);
    if (by.get(key)! > HITS_MAX) {
      const h = hidden.get(key) ?? [f.kind, f.name ?? null, 0];
      h[2]++;
      hidden.set(key, h);
      continue;
    }
    out.push(f);
  }
  for (const [kind, name, n] of hidden.values()) out.push({ kind, name, more: n });
  return out;
}
