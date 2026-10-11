/**
 * recordLocals for JS: which local names each statement's step can read, from the AST.
 *
 * Pyokka snapshots `frame.f_locals` at every step. JS has no frame to read, so the instrumenter
 * hands `s` a getter closure over the names visible at the statement, `() => [a, b, i]`, and the
 * recorder diffs what it returns against the scope's last snapshot (recorder.ts `snapshot`).
 * This module picks those names:
 *
 * - inside a function: its parameters, its `var`s (hoisted), and the `let`/`const`/`class` and
 *   catch bindings of every enclosing block of that function, declared before the statement
 *   starts (a later one would be in its temporal dead zone); `this` in methods and constructors,
 *   as Pyokka records `self`;
 * - at module level: top-level `var`/`let`/`const` (imports and classes are left out, as Pyokka
 *   leaves out modules and classes);
 * - never a function declaration (a function value is not recorded), `arguments`, or a loop's own
 *   `let` at the loop statement (its hook before the loop runs outside the loop's scope).
 *
 * Steps are keyed by statement start offset (the instrumenter's statement span start).
 */
type Node = any;

export const MAX_LOCAL_NAMES = 64;
/**
 * Marks a hoisted `var` in a plan's names (`%total`): it reads `undefined` before its declaration
 * runs, so the recorder does not take a first `undefined` of it for an assignment. A parameter or
 * a `let`/`const` that reads `undefined` was given it, and that first value is recorded.
 */
export const HOISTED = '%';
export const bareName = (n: string): string => (n.charCodeAt(0) === 37 ? n.slice(1) : n);

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const LOOPS = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement']);

interface Frame {
  /** names fixed for the whole function: params, `this`, hoisted vars */
  fixed: string[];
  /** block bindings in scope, innermost last: [name, declared-at offset] */
  blocks: [string, number][][];
  module: boolean;
}

function patternNames(p: Node, out: string[]): void {
  if (!p) return;
  switch (p.type) {
    case 'Identifier':
      out.push(p.name);
      return;
    case 'ObjectPattern':
      for (const q of p.properties) patternNames(q.type === 'RestElement' ? q.argument : q.value, out);
      return;
    case 'ArrayPattern':
      for (const e of p.elements) patternNames(e, out);
      return;
    case 'RestElement':
      patternNames(p.argument, out);
      return;
    case 'AssignmentPattern':
      patternNames(p.left, out);
      return;
    case 'TSParameterProperty':
      patternNames(p.parameter, out);
      return;
  }
}

/** `var` names declared anywhere in a function body (not in nested functions). */
function hoistedVars(body: Node, out: string[]): void {
  const walk = (n: Node): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n.type !== 'string') return;
    if (FUNCTIONS.has(n.type) || n.type === 'ClassDeclaration' || n.type === 'ClassExpression') return;
    if (n.type === 'VariableDeclaration' && n.kind === 'var') {
      const names: string[] = [];
      for (const d of n.declarations) patternNames(d.id, names);
      for (const name of names) out.push(HOISTED + name);
    }
    for (const k in n) {
      if (k === 'type' || k === 'start' || k === 'end') continue;
      const v = n[k];
      if (v && typeof v === 'object') walk(v);
    }
  };
  walk(body);
}

/** Block-level declarations of a statement list: `let`/`const`/`class` with where they are declared. */
function blockBindings(stmts: Node[], module: boolean): [string, number][] {
  const out: [string, number][] = [];
  for (const raw of stmts) {
    const s = raw?.type === 'ExportNamedDeclaration' ? raw.declaration : raw;
    if (!s) continue;
    if (s.type === 'VariableDeclaration' && s.kind !== 'var') {
      for (const d of s.declarations) {
        const names: string[] = [];
        patternNames(d.id, names);
        // visible from the next statement on (its own step runs before it is initialized)
        for (const n of names) out.push([n, raw.end]);
      }
    } else if (s.type === 'ClassDeclaration' && s.id && !module) out.push([s.id.name, raw.end]);
  }
  return out;
}

export function planLocals(program: Node): Map<number, string[]> {
  const plan = new Map<number, string[]>();

  const namesAt = (frame: Frame, at: number, exclude?: Set<string>): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    const push = (n: string): void => {
      const bare = bareName(n);
      if (seen.has(bare) || exclude?.has(bare) || bare === 'arguments') return;
      seen.add(bare);
      out.push(n);
    };
    frame.fixed.forEach(push);
    for (const block of frame.blocks) for (const [n, from] of block) if (from <= at) push(n);
    return out.slice(0, MAX_LOCAL_NAMES);
  };

  const record = (frame: Frame, s: Node, exclude?: Set<string>): void => {
    const names = namesAt(frame, s.start, exclude);
    if (names.length) plan.set(s.start, names);
  };

  const statementList = (frame: Frame, stmts: Node[], extra: [string, number][] = []): void => {
    frame.blocks.push([...extra, ...blockBindings(stmts, frame.module && frame.blocks.length === 0)]);
    try {
      for (const s of stmts) statement(frame, s);
    } finally {
      frame.blocks.pop();
    }
  };

  const nested = (frame: Frame, s: Node, extra: [string, number][] = []): void => {
    if (!s) return;
    if (s.type === 'BlockStatement') statementList(frame, s.body, extra);
    else statementList(frame, [s], extra);
  };

  const loopOwn = (s: Node): string[] => {
    const own: string[] = [];
    const decl = s.type === 'ForStatement' ? s.init : s.type === 'ForInStatement' || s.type === 'ForOfStatement' ? s.left : null;
    if (decl?.type === 'VariableDeclaration' && decl.kind !== 'var') for (const d of decl.declarations) patternNames(d.id, own);
    return own;
  };

  const statement = (frame: Frame, s: Node): void => {
    if (!s || typeof s !== 'object') return;
    if (s.type === 'BlockStatement') return statementList(frame, s.body);
    if (s.type === 'EmptyStatement' || s.type.startsWith('TS')) return;
    const loop = LOOPS.has(s.type) ? s : s.type === 'LabeledStatement' && LOOPS.has(s.body.type) ? s.body : null;
    if (loop) {
      const own = loopOwn(loop);
      record(frame, s, new Set(own));
      expressions(frame, loop);
      nested(frame, loop.body, own.map((n) => [n, -1] as [string, number]));
      return;
    }
    record(frame, s);
    switch (s.type) {
      case 'IfStatement':
        expressions(frame, s.test);
        nested(frame, s.consequent);
        nested(frame, s.alternate);
        return;
      case 'LabeledStatement':
      case 'WithStatement':
        nested(frame, s.body);
        return;
      case 'SwitchStatement':
        expressions(frame, s.discriminant);
        // one block for all cases: a `let` in one case is in scope (and in its dead zone) in the next
        statementList(frame, s.cases.flatMap((c: Node) => c.consequent));
        return;
      case 'TryStatement': {
        nested(frame, s.block);
        if (s.handler) {
          const names: string[] = [];
          patternNames(s.handler.param, names);
          nested(frame, s.handler.body, names.map((n) => [n, -1] as [string, number]));
        }
        nested(frame, s.finalizer);
        return;
      }
      case 'FunctionDeclaration':
        func(s, false);
        return;
      case 'ExportNamedDeclaration':
      case 'ExportDefaultDeclaration':
        if (s.declaration) {
          if (FUNCTIONS.has(s.declaration.type)) func(s.declaration, false);
          else expressions(frame, s.declaration);
        }
        return;
      default:
        expressions(frame, s);
    }
  };

  /** functions and class bodies inside an expression */
  const expressions = (frame: Frame, n: Node, parent?: Node): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach((x) => expressions(frame, x, parent));
    if (typeof n.type !== 'string') return;
    if (FUNCTIONS.has(n.type)) {
      const method = !!parent && (parent.type === 'MethodDefinition' || (parent.type === 'Property' && (parent.method || parent.kind === 'get' || parent.kind === 'set')));
      return func(n, method);
    }
    if (n.type === 'StaticBlock') return statementList({ fixed: ['this'], blocks: [], module: false }, n.body);
    for (const k in n) {
      if (k === 'type' || k === 'start' || k === 'end') continue;
      const v = n[k];
      if (v && typeof v === 'object') expressions(frame, v, n);
    }
  };

  const func = (fn: Node, method: boolean): void => {
    const fixed: string[] = [];
    if (method) fixed.push('this');
    for (const p of fn.params ?? []) patternNames(p, fixed);
    if (fn.body?.type === 'BlockStatement') hoistedVars(fn.body, fixed);
    const frame: Frame = { fixed, blocks: [], module: false };
    for (const p of fn.params ?? []) expressions(frame, p);
    if (fn.body?.type === 'BlockStatement') statementList(frame, fn.body.body);
    else {
      // an arrow's expression body has no statement: its parameters are read at the entry (`f`)
      record(frame, fn.body);
      expressions(frame, fn.body);
    }
  };

  const top: string[] = [];
  hoistedVars(program, top);
  statementList({ fixed: top, blocks: [], module: true }, program.body);
  return plan;
}
