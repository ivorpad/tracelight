/**
 * The instrumenter: JavaScript / TypeScript source in, instrumented JavaScript plus the range
 * tables of `file.instrumented` out.
 *
 * Parsing is oxc-parser (ESTree with UTF-16 offsets); the rewrite is a list of insertions applied
 * with magic-string, so every original character keeps its place and a hires source map points
 * stack traces back at the source. TypeScript is first reduced to JavaScript by Node's own
 * `module.stripTypeScriptTypes` in strip mode, which blanks types out with whitespace: offsets in
 * the stripped text are offsets in the `.ts` file, so ranges and the source map need no second map.
 *
 * Hooks live on one global object, `__tk` (installed by the run child):
 *
 *     __tk.s(rid, _tk_scope_)            statement step
 *     __tk.c(rid)                        coverage only (declarations, imports, expression parts)
 *     (__tk.c(rid), expr)                expression coverage: `a && b`, `a ? b : c`, `a ?? b`
 *     const _tk_scope_ = __tk.f(rid)     function entry (a step with flag 4 on the header range)
 *     return (_tk_rv_ = (value))         every return of an instrumented function
 *     catch (e) { __tk.ex(scope, e) }    an exception leaving the frame (rethrown unchanged)
 *     finally { __tk.x(scope, _tk_rv_) } exit; `_tk_rv_` is __tk.u while an exception leaves, __tk.e at the end
 *     __tk.aw(scope, await __tk.ap(scope, x))   an await: the caller is current while suspended, the frame again on resume
 *     __tk.v(rid, ctx, value, kind, markerId, changeId, fn?)   value log, returns value
 *     __tk.t(rid, ctx, t0, value, kind, markerId, changeId)    timed value log
 *     __tk.log(rid, method, ...args)     console.log / info / warn / error / debug attribution
 *     __tk.lp(rid, kind, template, ctx, markerId, changeId, isExpr, evaluate)   logpoint / exp marker
 *
 * Range ids are assigned in source order after the walk (spans sorted by start, longer first), so
 * the edits are recorded with span keys and rendered once the numbering is known.
 */
import { parseSync } from './parse.ts';
import { lowerTypeScript, MappedLineIndex, type Lowered } from './lower.ts';
import MagicString from 'magic-string';
import * as nodeModule from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LineIndex } from './lines.ts';
import { walkTable, type WalkTable } from './walk.ts';
import { bareName, planLocals } from './recorder/localsPlan.ts';
import { KIND_AUTO_EXPAND, KIND_TIME, KIND_TIME_AUTO_EXPAND, KIND_VALUE, type Range } from './protocol.ts';

type Node = any;
type Span = [number, number]; // [start, end) offsets

export interface Marker {
  id?: string;
  kind?: string;
  range?: number[];
  exp?: string | null;
  context?: string | null;
  changeId?: string | null;
  autoExpand?: boolean;
  logMessage?: string | null;
}

export interface InstrumentOptions {
  /** `module` (ESM), `commonjs`, or `unambiguous`: how the file will be evaluated */
  sourceType?: 'module' | 'commonjs' | 'unambiguous';
  /** the file is TypeScript (strip types first); inferred from the filename when undefined */
  typescript?: boolean;
  /** an imported project module: its body is a scope of its own at depth 1 */
  moduleScope?: boolean;
  autoLog?: boolean;
  /** pass each statement step a getter over its visible locals (recorder/localsPlan.ts) */
  recordLocals?: boolean;
  magic?: boolean;
  markers?: Marker[];
  ignoreCoverage?: string;
  ignoreCoverageForFile?: string;
  /**
   * a third-party file (`libraryCode`): its module body runs quiet (`__tk.qf` / `__tk.qx`, hits
   * only, so is everything it calls while importing), and console calls, live comments, markers
   * and auto-log are left alone
   */
  library?: boolean;
  /**
   * `mode: "snaps"`: `/*{{ ... }}*\/` fences anywhere hold code that runs in place; every top-level
   * statement and every snap statement is guarded (an error is reported, coverage 3/4, and the run
   * goes on), and snap statements' values are logged
   */
  snaps?: boolean;
  /**
   * with `library`: range ids are written as `_tk_b_+n` off one `var _tk_b_=` slot near the top, so
   * the cache can store the code once and `relocate` it to any `rangeBase`
   */
  relocatable?: boolean;
  /**
   * the entry module's scope probe (pure.ts `probeScope`): a hoisted function whose `eval` keeps
   * every module binding reachable after the program ends, registered as `__tk.probe` next to
   * `var _tk_scope_=0;` and declared after the last line, so no line moves
   */
  scopeProbe?: boolean;
  /** append an inline source map (default true) */
  sourceMap?: boolean;
}

export interface FunctionInfo {
  rid: number;
  name: string;
  bodyRange: Range;
}

export interface InstrumentedFile {
  filename: string;
  fileId: number;
  rangeBase: number;
  /** the JavaScript to evaluate; the plain (type-stripped) program when instrumentation failed */
  code: string | null;
  ranges: Range[];
  statements: number[];
  functions: FunctionInfo[];
  magic: { rid: number; kind: string }[];
  /** local rid of a statement -> local rids of its covered expression parts (partial coverage) */
  exprChildren: Map<number, number[]>;
  /** source line -> global rid of the statement on it */
  lineRids: Map<number, number>;
  ignored: Set<number>;
  ignoreFile: boolean;
  /** global rid of a function header -> its name */
  functionNames: Map<number, string>;
  moduleRid: number;
  error: string | null;
  errorLine: number | null;
  warnings: string[];
  rangeCount: number;
  /** offset of the `_tk_b_` value in `code` (relocatable library files) */
  relocSlot?: number;
  /** recordLocals: global rid of a statement -> the names its `s` getter returns, in order */
  localNames: Map<number, string[]>;
  /**
   * a file instrumented without a source map (a library file): per line, `[origCol, shift, ...]`
   * pairs, where from `origCol` on the instrumented column is the source's plus `shift` (colMap.ts)
   */
  colMap?: [number, number[]][];
  /** A runtime loader's extra prefix lines (Bun's precompiled marker). */
  runtimeLineOffset?: number;
  /** project files: decisions, loops, returns and functions for the host's walkthrough (walk.ts) */
  walk?: WalkTable;
}

const HOOK = '__tk';
const SCOPE = '_tk_scope_';
const PROBE = '__tk_probe';
const RV = '_tk_rv_';
const EXC = '_tk_e_';
const CONSOLE_METHODS = new Set(['log', 'info', 'warn', 'error', 'debug', 'trace']);
const MAGIC_RE = /^\s*\?\s*([.+\s]*)(.*)$/s;
const SUFFIX_KINDS: Record<string, string> = { '': KIND_VALUE, '+': KIND_AUTO_EXPAND, '.': KIND_TIME, '.+': KIND_TIME_AUTO_EXPAND, '+.': KIND_TIME_AUTO_EXPAND };
const TIME_KINDS = new Set([KIND_TIME, KIND_TIME_AUTO_EXPAND]);
const LOOPS = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement']);
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

interface ValuePlan {
  kind: string;
  context?: string | null;
  markerId?: string | null;
  changeId?: string | null;
  code?: string | null; // `// ? $.x` code, `$` is the value
  source: 'magic' | 'marker' | 'identifier' | 'autoLog' | 'snap';
  /** the range the log reports: the statement's, when the plan came from a statement */
  span?: Span;
}

interface LogpointPlan {
  kind: string;
  template: string;
  context: string | null;
  markerId: string | null;
  changeId: string | null;
  isExpr: boolean;
}

/** A piece of inserted text; `{rid:KEY}` placeholders are resolved once the spans are numbered. */
/** a span's identity: start * 2^25 + end (files up to 32 MB) */
type Key = number;
type Part = string | { span: Key };
type Edit = { op: 'open' | 'close'; pos: number; parts: Part[] } | { op: 'overwrite'; start: number; end: number; parts: Part[] };

interface FnCtx {
  /** inside an instrumented function body (has `_tk_scope_` and `_tk_rv_`) */
  instrumented: boolean;
  async: boolean;
  generator: boolean;
}

export function isTypeScriptPath(filename: string): boolean {
  return /\.(ts|mts|cts|tsx)$/i.test(filename);
}

export function isJsxPath(filename: string): boolean {
  return /\.(jsx|tsx)$/i.test(filename);
}

function jsString(s: string): string {
  return JSON.stringify(s).replace(/[\u2028\u2029]/g, (c) => (c === '\u2028' ? '\\u2028' : '\\u2029'));
}

let warnedStrip = false;

/** Node's type stripper, without its ExperimentalWarning. Throws on syntax it cannot erase (enum, namespace). */
export function stripTypes(source: string): string {
  if (!warnedStrip) {
    warnedStrip = true;
    const emit = process.emitWarning;
    process.emitWarning = ((w: any, ...rest: any[]) => {
      const text = typeof w === 'string' ? w : w?.message;
      if (typeof text === 'string' && text.includes('stripTypeScriptTypes')) return;
      return (emit as any).call(process, w, ...rest);
    }) as typeof process.emitWarning;
  }
  if (process.versions.bun) {
    const result = spawnSync(process.env.TRACELIGHT_HOST_NODE || 'node', [fileURLToPath(new URL('./stripForBun.mjs', import.meta.url))], { input: source, encoding: 'utf8', timeout: 10000, maxBuffer: 32 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(`Bun source preparation failed: ${result.error?.message ?? result.stderr.trim()}`);
    return result.stdout;
  }
  return nodeModule.stripTypeScriptTypes(source, { mode: 'strip' });
}

class Instrumenter {
  lines: LineIndex;
  readonly spans = new Map<Key, Span>();
  readonly edits: Edit[] = [];
  readonly stmtKeys: Key[] = [];
  readonly stmtLines: [Key, number, number][] = [];
  readonly functions: [Key, string, Span][] = [];
  readonly magic: [Key, string][] = [];
  readonly exprChildren = new Map<Key, Key[]>();
  readonly ignoredKeys = new Set<Key>();
  readonly warnings: string[] = [];
  readonly snapRegions: Span[] = [];
  readonly topLevel = new Set<Node>();
  inlineConfig: Node | null = null;
  /** inside a snap statement: its nested statements are logged but not guarded one by one */
  withinSnapStmt = false;
  readonly exprPlans = new Map<Node, ValuePlan>();
  readonly stmtPlans = new Map<Node, ValuePlan>();
  readonly logpoints = new Map<Node, { before: LogpointPlan[]; after: LogpointPlan[] }>();
  readonly ignoredNodes = new Set<Node>();
  curStmt: Key | null = null;
  /** recordLocals: statement start -> visible local names */
  localsAt: Map<number, string[]> | null = null;
  readonly localKeys = new Map<Key, string[]>();
  fn: FnCtx = { instrumented: false, async: false, generator: false };
  /** every statement, for live comments, markers and ignore hints */
  readonly allStatements: Node[] = [];
  readonly allExpressions: Node[] = [];

  readonly js: string;
  /** the source as written: TypeScript keeps its types here, at the same offsets as `js` */
  readonly orig: string;
  readonly options: InstrumentOptions;

  constructor(js: string, options: InstrumentOptions, orig: string = js) {
    this.js = js;
    this.orig = orig;
    this.options = options;
    this.lines = new LineIndex(js);
  }

  // -- spans -------------------------------------------------------------------------------
  key(span: Span): Key {
    const k = span[0] * 33554432 + span[1];
    if (!this.spans.has(k)) this.spans.set(k, span);
    return k;
  }

  rid(span: Span): Part {
    return { span: this.key(span) };
  }

  open(pos: number, ...parts: Part[]): void {
    this.edits.push({ op: 'open', pos, parts });
  }

  close(pos: number, ...parts: Part[]): void {
    this.edits.push({ op: 'close', pos, parts });
  }

  text(node: Node): string {
    return this.orig.slice(node.start, node.end).replace(/\s+/g, ' ').trim();
  }

  /** end of the header of a compound statement: just before `child` starts, trailing blanks trimmed */
  headerEnd(start: number, childStart: number): number {
    let end = childStart;
    while (end > start && /\s/.test(this.orig[end - 1]!)) end--;
    return end;
  }

  stmtSpan(s: Node): Span {
    switch (s.type) {
      case 'IfStatement':
        return [s.start, this.headerEnd(s.start, s.consequent.start)];
      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement':
      case 'WhileStatement':
      case 'WithStatement':
        return [s.start, this.headerEnd(s.start, s.body.start)];
      case 'DoWhileStatement':
        return [s.start, this.headerEnd(s.start, s.body.start)];
      case 'SwitchStatement': {
        const brace = this.js.indexOf('{', s.discriminant.end);
        return [s.start, brace > 0 ? this.headerEnd(s.start, brace) : s.discriminant.end];
      }
      case 'TryStatement':
        return [s.start, this.headerEnd(s.start, s.block.start)];
      case 'LabeledStatement':
        return [s.start, s.label.end + 1];
      case 'FunctionDeclaration':
        return [s.start, this.headerEnd(s.start, s.body.start)];
      case 'ClassDeclaration':
        return [s.start, this.headerEnd(s.start, s.body.start)];
      case 'ExportNamedDeclaration':
      case 'ExportDefaultDeclaration':
        if (s.declaration && (s.declaration.type === 'FunctionDeclaration' || s.declaration.type === 'ClassDeclaration' || s.declaration.type === 'FunctionExpression' || s.declaration.type === 'ClassExpression') && s.declaration.body) {
          return [s.start, this.headerEnd(s.start, s.declaration.body.start)];
        }
        return [s.start, s.end];
      default:
        return [s.start, s.end];
    }
  }

  // -- statements -----------------------------------------------------------------------------
  hookText(span: Span, coverageOnly: boolean): Part[] {
    if (coverageOnly) return [`${HOOK}.c(`, this.rid(span), ');'];
    const names = this.localsAt?.get(span[0]);
    if (names?.length) {
      this.localKeys.set(this.key(span), names);
      return [`${HOOK}.s(`, this.rid(span), `,${SCOPE},()=>[${names.map(bareName).join(',')}]);`];
    }
    return [`${HOOK}.s(`, this.rid(span), `,${SCOPE});`];
  }

  isDirective(s: Node): boolean {
    return s.type === 'ExpressionStatement' && typeof s.directive === 'string';
  }

  coverageOnly(s: Node): boolean {
    const d = s.type === 'ExportNamedDeclaration' || s.type === 'ExportDefaultDeclaration' ? s.declaration : s;
    if (!d) return s.type === 'ExportNamedDeclaration'; // `export { a, b }` runs nothing
    if (s.type === 'ImportDeclaration' || s.type === 'ExportAllDeclaration') return true;
    if (d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') return true;
    if (s.type === 'ExportDefaultDeclaration' && (d.type === 'FunctionExpression' || d.type === 'ClassExpression') && d.id) return true;
    if (d.type === 'TSInterfaceDeclaration' || d.type === 'TSTypeAliasDeclaration') return true;
    return false;
  }

  statementList(stmts: Node[]): void {
    for (const s of stmts) this.statement(s);
  }

  statement(s: Node): void {
    if (!s || s.type === 'EmptyStatement' || this.isDirective(s) || s === this.inlineConfig) return;
    if (s.type === 'BlockStatement') {
      this.statementList(s.body);
      return;
    }
    if (s.type.startsWith('TS') && s.type !== 'TSExportAssignment') return; // blanked out by the stripper
    const span = this.stmtSpan(s);
    const key = this.key(span);
    this.stmtKeys.push(key);
    this.stmtLines.push([key, this.lines.line(span[0]), this.lines.line(Math.max(span[0], span[1] - 1))]);
    if (this.ignoredNodes.has(s)) this.markIgnored(s);
    const lps = this.logpoints.get(s);
    const guard = this.guarded(s) && s.type !== 'VariableDeclaration' && !(s.type.startsWith('Export') && s.declaration?.type === 'VariableDeclaration') ? this.openGuard(s, span) : null;
    this.open(s.start, ...this.hookText(span, this.coverageOnly(s)));
    const declGuard = this.guarded(s) && !guard ? this.openGuard(s, span) : null;
    if (lps) for (const lp of lps.before) this.open(s.start, ...this.logpointText(span, lp));
    const plan = this.planFor(s);
    const prev = this.curStmt;
    const prevSnap = this.withinSnapStmt;
    this.curStmt = key;
    if (this.options.snaps && this.inSnap(s)) this.withinSnapStmt = true;
    try {
      if (plan) this.applyPlan(s, span, plan);
      this.statementChildren(s, span);
    } finally {
      this.curStmt = prev;
      this.withinSnapStmt = prevSnap;
    }
    declGuard?.();
    if (lps && lps.after.length) {
      const after = /^(ReturnStatement|ThrowStatement|BreakStatement|ContinueStatement)$/.test(s.type);
      for (const lp of lps.after) {
        if (after) this.open(s.start, ...this.logpointText(span, lp));
        else this.close(s.end, ...this.logpointText(span, lp));
      }
    }
    guard?.();
  }

  markIgnored(s: Node): void {
    const walk = (n: Node): void => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) return n.forEach(walk);
      if (typeof n.type === 'string' && /Statement$|Declaration$/.test(n.type)) this.ignoredNodes.add(n);
      for (const k in n) if (k !== 'parent' && n[k] && typeof n[k] === 'object') walk(n[k]);
    };
    walk(s);
  }

  /** `if (x) y;` and friends: the body gets braces so the hook before it stays inside the branch */
  nestedStatement(s: Node, loopHeader?: Span): void {
    if (!s) return;
    if (s.type === 'BlockStatement') {
      if (loopHeader) this.open(s.start + 1, ...this.hookText(loopHeader, false));
      this.statementList(s.body);
      return;
    }
    this.open(s.start, '{');
    if (loopHeader) this.open(s.start, ...this.hookText(loopHeader, false));
    this.statement(s);
    this.close(s.end, '}');
  }

  statementChildren(s: Node, span: Span): void {
    switch (s.type) {
      case 'IfStatement':
        this.expr(s.test);
        this.nestedStatement(s.consequent);
        if (s.alternate) this.nestedStatement(s.alternate);
        return;
      case 'ForStatement':
        if (s.init) s.init.type === 'VariableDeclaration' ? this.children(s.init) : this.expr(s.init);
        this.expr(s.test);
        this.expr(s.update);
        this.nestedStatement(s.body, span);
        return;
      case 'ForInStatement':
      case 'ForOfStatement':
        this.children(s.left);
        this.expr(s.right);
        this.nestedStatement(s.body, span);
        return;
      case 'WhileStatement':
        this.expr(s.test);
        this.nestedStatement(s.body, span);
        return;
      case 'DoWhileStatement':
        this.nestedStatement(s.body, span);
        this.expr(s.test);
        return;
      case 'LabeledStatement':
        // `label: for (...)` must stay adjacent for `continue label`; any other body is a statement of its own
        if (LOOPS.has(s.body.type)) this.statementChildren(s.body, this.stmtSpan(s.body));
        else this.nestedStatement(s.body);
        return;
      case 'WithStatement':
        this.expr(s.object);
        this.nestedStatement(s.body);
        return;
      case 'SwitchStatement':
        this.expr(s.discriminant);
        for (const c of s.cases) {
          this.expr(c.test);
          this.statementList(c.consequent);
        }
        return;
      case 'TryStatement':
        this.statementList(s.block.body);
        if (s.handler) {
          // where a caught exception was handled: the try statement's range (`error.handledAt`)
          const param = s.handler.param;
          if (!param) this.open(s.handler.body.start, `(${EXC})`);
          else this.children(param);
          const name = !param ? EXC : param.type === 'Identifier' ? param.name : null;
          this.open(s.handler.body.start + 1, `${HOOK}.h(`, this.rid(span), `,${name ?? 'undefined'},true,${this.lines.line(s.handler.start)},${SCOPE});`);
          this.statementList(s.handler.body.body);
        }
        if (s.finalizer) this.statementList(s.finalizer.body);
        return;
      case 'ReturnStatement':
        if (this.fn.instrumented) {
          if (s.argument) {
            this.open(s.argument.start, `(${RV}=(`);
            this.expr(s.argument);
            this.close(s.argument.end, '))');
          } else {
            this.open(s.start + 'return'.length, ` (${RV}=undefined)`);
          }
        } else this.expr(s.argument);
        return;
      case 'FunctionDeclaration':
        this.func(s, s.id?.name ?? 'default', s.start);
        return;
      case 'ClassDeclaration':
        this.classNode(s);
        return;
      case 'ExportNamedDeclaration':
      case 'ExportDefaultDeclaration':
        if (!s.declaration) return;
        if (s.declaration.type === 'FunctionDeclaration' || s.declaration.type === 'FunctionExpression') this.func(s.declaration, s.declaration.id?.name ?? 'default', s.start);
        else if (s.declaration.type === 'ClassDeclaration' || s.declaration.type === 'ClassExpression') this.classNode(s.declaration);
        else if (s.declaration.type === 'VariableDeclaration') this.children(s.declaration);
        else this.expr(s.declaration);
        return;
      default:
        this.children(s);
    }
  }

  // -- generic walk over expressions ------------------------------------------------------------
  children(n: Node): void {
    if (!n || typeof n !== 'object') return;
    for (const k in n) {
      if (k === 'type' || k === 'start' || k === 'end' || k === 'range' || k === 'loc') continue;
      const v = n[k];
      if (Array.isArray(v)) for (const item of v) this.expr(item, n, k);
      else if (v && typeof v === 'object' && typeof v.type === 'string') this.expr(v, n, k);
    }
  }

  /** visit an expression-level node (anything that is not in a statement list) */
  expr(n: Node, parent?: Node, field?: string): void {
    if (!n || typeof n !== 'object' || typeof n.type !== 'string') return;
    const plan = this.exprPlans.get(n);
    if (plan) {
      this.exprPlans.delete(n);
      const span: Span = plan.span ?? [n.start, n.end];
      if (plan.source === 'magic') this.magic.push([this.key(span), plan.kind]);
      this.valueOpen(n, span, plan, this.text(n));
      this.exprInner(n, parent, field);
      this.valueClose(n, plan);
      return;
    }
    this.exprInner(n, parent, field);
  }

  exprInner(n: Node, parent?: Node, field?: string): void {
    switch (n.type) {
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        this.func(n, this.inferName(n, parent, field), n.start);
        return;
      case 'ClassExpression':
      case 'ClassDeclaration':
        this.classNode(n);
        return;
      case 'LogicalExpression':
        this.expr(n.left);
        this.covered(n.right);
        return;
      case 'ConditionalExpression':
        this.expr(n.test);
        this.covered(n.consequent);
        this.covered(n.alternate);
        return;
      case 'AwaitExpression':
        if (this.options.library && !this.fn.instrumented) {
          // a library's top-level await: the importer runs loud while the module is suspended
          this.open(n.start, `${HOOK}.qr(`);
          this.open(n.argument.start, `${HOOK}.qs(`);
          this.expr(n.argument);
          this.close(n.argument.end, ')');
          this.close(n.end, ')');
        } else if (this.fn.instrumented || !this.fn.async) {
          // top-level await (module scope) and awaits of instrumented functions
          this.open(n.start, `${HOOK}.aw(${SCOPE},`);
          this.open(n.argument.start, `${HOOK}.ap(${SCOPE},`);
          this.expr(n.argument);
          this.close(n.argument.end, ')');
          this.close(n.end, ')');
        } else this.expr(n.argument);
        return;
      case 'YieldExpression':
        if (this.fn.instrumented) {
          this.open(n.start, `${HOOK}.aw(${SCOPE},`);
          if (n.argument) {
            this.open(n.argument.start, `${HOOK}.ap(${SCOPE},`);
            this.expr(n.argument);
            this.close(n.argument.end, ')');
          } else this.close(n.end, ` ${HOOK}.ap(${SCOPE},undefined)`);
          this.close(n.end, ')');
        } else this.expr(n.argument);
        return;
      case 'CallExpression':
        this.call(n);
        return;
      case 'MethodDefinition':
      case 'Property':
        if (n.computed) this.expr(n.key);
        if ((n.type === 'MethodDefinition' || n.method || n.kind === 'get' || n.kind === 'set') && n.value && FUNCTIONS.has(n.value.type)) {
          this.func(n.value, this.keyName(n.key, n.kind), n.start);
        } else this.expr(n.value, n, 'value');
        return;
      case 'PropertyDefinition':
      case 'AccessorProperty':
        if (n.computed) this.expr(n.key);
        this.expr(n.value, n, 'value');
        return;
      case 'StaticBlock':
        this.statementList(n.body);
        return;
      default:
        this.children(n);
    }
  }

  covered(n: Node): void {
    if (!n) return;
    const span: Span = [n.start, n.end];
    const key = this.key(span);
    if (this.curStmt) {
      const list = this.exprChildren.get(this.curStmt) ?? [];
      list.push(key);
      this.exprChildren.set(this.curStmt, list);
    }
    this.open(n.start, `(${HOOK}.c(`, { span: key }, '),');
    this.expr(n);
    this.close(n.end, ')');
  }

  call(n: Node): void {
    const callee = n.callee;
    if (
      !n.optional &&
      !this.options.library &&
      callee?.type === 'MemberExpression' &&
      !callee.computed &&
      !callee.optional &&
      callee.object?.type === 'Identifier' &&
      callee.object.name === 'console' &&
      CONSOLE_METHODS.has(callee.property?.name)
    ) {
      const span: Span = [n.start, n.end];
      this.edits.push({ op: 'overwrite', start: callee.start, end: callee.end, parts: [`${HOOK}.log`] });
      const head: Part[] = [this.rid(span), `,${jsString(callee.property.name)}`];
      if (n.arguments.length) this.open(n.arguments[0].start, ...head, ',');
      else {
        let close = n.end - 1;
        while (close > callee.end && this.js[close] !== ')') close--;
        this.open(close, ...head);
      }
      for (const a of n.arguments) this.expr(a);
      return;
    }
    this.children(n);
  }

  keyName(key: Node, kind?: string): string {
    let name = key?.type === 'Identifier' ? key.name : key?.type === 'PrivateIdentifier' ? `#${key.name}` : key?.type === 'Literal' ? String(key.value) : '<computed>';
    if (kind === 'get' || kind === 'set') name = `${kind} ${name}`;
    return name;
  }

  inferName(n: Node, parent?: Node, field?: string): string {
    if (n.id?.name) return n.id.name;
    if (parent?.type === 'VariableDeclarator' && field === 'init' && parent.id?.type === 'Identifier') return parent.id.name;
    if (parent?.type === 'AssignmentExpression' && field === 'right') return this.text(parent.left);
    if ((parent?.type === 'Property' || parent?.type === 'PropertyDefinition') && field === 'value') return this.keyName(parent.key);
    return n.type === 'ArrowFunctionExpression' ? '<arrow>' : '<anonymous>';
  }

  classNode(n: Node): void {
    this.expr(n.superClass);
    for (const el of n.body?.body ?? []) this.expr(el);
  }

  // -- functions ----------------------------------------------------------------------------
  func(fn: Node, name: string, headerStart: number): void {
    const body = fn.body;
    const span: Span = [headerStart, this.headerEnd(headerStart, body.start)];
    const key = this.key(span);
    this.functions.push([key, name, [headerStart, fn.end]]);
    for (const p of fn.params ?? []) this.children(p); // default values; they run before the scope is entered
    const saved = this.fn;
    const savedStmt = this.curStmt;
    this.fn = { instrumented: true, async: !!fn.async, generator: !!fn.generator };
    this.curStmt = null;
    const enter = [`const ${SCOPE}=${HOOK}.f(`, { span: key } as Part, `);let ${RV}=${HOOK}.u;try{`];
    const leave = `;${RV}=${HOOK}.e}catch(${EXC}){${HOOK}.ex(${SCOPE},${EXC});throw ${EXC}}finally{${HOOK}.x(${SCOPE},${RV})}`;
    try {
      if (body.type === 'BlockStatement') {
        let at = body.start + 1;
        for (const s of body.body) {
          if (this.isDirective(s)) at = s.end;
          else break;
        }
        // a directive without its `;` (`{"use strict"}`) must not run into the scope's `const`
        if (at > body.start + 1 && this.js[at - 1] !== ';') enter.unshift(';');
        if (at >= body.end - 1) {
          this.open(at, ...enter, leave); // an empty body
        } else {
          this.open(at, ...enter);
          this.statementList(body.body);
          this.close(body.end - 1, leave);
        }
      } else {
        // an arrow's expression body becomes a block that returns it; with recordLocals its
        // parameters are read at the entry, since the body has no statement step
        const names = this.localsAt?.get(body.start);
        if (names?.length) {
          this.localKeys.set(key, names);
          enter.splice(2, 1, `,()=>[${names.map(bareName).join(',')}]);let ${RV}=${HOOK}.u;try{`);
        }
        this.open(body.start, '{', ...enter, `return (${RV}=(`);
        this.expr(body);
        this.close(body.end, `))`, leave, '}');
      }
    } finally {
      this.fn = saved;
      this.curStmt = savedStmt;
    }
  }

  // -- value plans ------------------------------------------------------------------------------
  planFor(s: Node): ValuePlan | undefined {
    if (this.options.library) return undefined;
    const plan = this.stmtPlans.get(s);
    if (plan) return plan;
    if (s.type === 'ExpressionStatement' && s.expression.type === 'Identifier' && s.expression.name !== 'undefined') {
      return { kind: KIND_VALUE, context: s.expression.name, source: 'identifier' };
    }
    if (this.inSnap(s)) return this.autoLoggable(s) ? { kind: KIND_VALUE, source: 'snap' } : undefined;
    if (this.options.autoLog && this.autoLoggable(s)) return { kind: 'autoLog', source: 'autoLog' };
    return undefined;
  }

  // -- snaps --------------------------------------------------------------------------------
  inSnap(s: Node): boolean {
    for (const [a, b] of this.snapRegions) if (s.start >= a && s.end <= b) return true;
    return false;
  }

  /** snaps mode: top-level statements and snap statements report their error and let the run go on */
  guarded(s: Node): boolean {
    return !!this.options.snaps && (this.topLevel.has(s) || (!this.withinSnapStmt && this.inSnap(s)));
  }

  /**
   * Open the guard of `s`; returns how to close it. A declaration stays a declaration (its bindings
   * are the module's): each initializer is evaluated by `__tk.g`, which reports an error and hands
   * back a value that destructures to undefined. Declarations that cannot throw are left alone.
   */
  openGuard(s: Node, span: Span): (() => void) | null {
    const d = s.type === 'ExportNamedDeclaration' || s.type === 'ExportDefaultDeclaration' ? s.declaration : s;
    if (s.type === 'ImportDeclaration' || s.type === 'ExportAllDeclaration' || (s.type === 'ExportNamedDeclaration' && !d)) return null;
    if (d?.type === 'FunctionDeclaration' || d?.type === 'ClassDeclaration' || s.type === 'ExportDefaultDeclaration') return null;
    if (d?.type === 'VariableDeclaration') {
      const inits = d.declarations.filter((x: Node) => x.init);
      for (const x of inits) {
        const isAsync = this.hasAwait(x.init);
        this.open(x.init.start, isAsync ? `(await ${HOOK}.ga(async()=>(` : `${HOOK}.g(()=>(`);
      }
      return () => {
        for (const x of inits) this.close(x.init.end, `),`, this.rid(span), isPatternText(x.id), this.hasAwait(x.init) ? '))' : ')');
      };
    }
    this.open(s.start, 'try{');
    return () => this.close(s.end, `}catch(${EXC}){${HOOK}.se(${EXC},`, this.rid(span), ')}');
  }

  hasAwait(n: Node): boolean {
    let found = false;
    const walk = (x: Node): void => {
      if (found || !x || typeof x !== 'object') return;
      if (Array.isArray(x)) return x.forEach(walk);
      if (x.type === 'AwaitExpression' || (x.type === 'ForOfStatement' && x.await)) {
        found = true;
        return;
      }
      if (FUNCTIONS.has(x.type)) return;
      for (const k in x) if (x[k] && typeof x[k] === 'object') walk(x[k]);
    };
    walk(n);
    return found;
  }

  autoLoggable(s: Node): boolean {
    if (s.type === 'VariableDeclaration') return s.declarations.some((d: Node) => d.init && !FUNCTIONS.has(d.init.type) && d.init.type !== 'ClassExpression');
    if (s.type === 'ReturnStatement') return !!s.argument && this.fn.instrumented;
    if (s.type === 'ExpressionStatement') {
      const e = s.expression;
      if (e.type === 'Literal' || e.type === 'TemplateLiteral') return false;
      if (e.type === 'CallExpression' && e.callee?.type === 'MemberExpression' && e.callee.object?.name === 'console') return false;
      return true;
    }
    return false;
  }

  valueOpen(n: Node, span: Span, plan: ValuePlan, context: string): void {
    const ctx = plan.context ?? context;
    if (TIME_KINDS.has(plan.kind)) this.open(n.start, `${HOOK}.t(`, this.rid(span), `,${jsString(ctx)},${HOOK}.now(),(`);
    else this.open(n.start, `${HOOK}.v(`, this.rid(span), `,${jsString(ctx)},(`);
  }

  valueClose(n: Node, plan: ValuePlan): void {
    const tail = `),${jsString(plan.kind)},${plan.markerId ? jsString(plan.markerId) : 'null'},${plan.changeId ? jsString(plan.changeId) : 'null'}`;
    const fn = plan.code && !TIME_KINDS.has(plan.kind) ? `,($)=>(${plan.code})` : '';
    this.close(n.end, tail, fn, ')');
  }

  /** a statement-level plan becomes an expression plan on the part of the statement that has the value */
  applyPlan(s: Node, span: Span, plan: ValuePlan): void {
    if (plan.source === 'magic') this.magic.push([this.key(span), plan.kind]);
    let valuePlan = plan;
    const target = (n: Node, ctx: string) => {
      if (!n) return;
      this.exprPlans.set(n, { ...valuePlan, context: valuePlan.context ?? ctx, source: valuePlan.source === 'magic' ? 'marker' : valuePlan.source, span });
    };
    if (TIME_KINDS.has(plan.kind) && !/^(VariableDeclaration|ExpressionStatement|ReturnStatement)$/.test(s.type)) {
      valuePlan = { ...plan, kind: plan.kind === KIND_TIME_AUTO_EXPAND ? KIND_AUTO_EXPAND : KIND_VALUE };
    }
    switch (s.type) {
      case 'ExpressionStatement':
        target(s.expression, this.text(s.expression));
        return;
      case 'VariableDeclaration': {
        const decls = s.declarations.filter((d: Node) => d.init);
        const d = decls[decls.length - 1];
        if (d) target(d.init, this.text(d.id));
        return;
      }
      case 'ExportNamedDeclaration':
        if (s.declaration?.type === 'VariableDeclaration') this.applyPlan(s.declaration, span, { ...plan, source: 'marker' });
        return;
      case 'ReturnStatement':
      case 'ThrowStatement':
        target(s.argument, s.argument ? this.text(s.argument) : 'return');
        return;
      case 'IfStatement':
      case 'WhileStatement':
      case 'DoWhileStatement':
        target(s.test, this.text(s.test));
        return;
      case 'SwitchStatement':
        target(s.discriminant, this.text(s.discriminant));
        return;
      case 'ForOfStatement':
      case 'ForInStatement': {
        // the loop variable, logged at the top of each iteration
        const decl = s.left.type === 'VariableDeclaration' ? s.left.declarations[0]?.id : s.left;
        if (decl?.type === 'Identifier' && s.body.type === 'BlockStatement') {
          const ctx = decl.name;
          this.open(s.body.start + 1, `${HOOK}.v(`, this.rid(span), `,${jsString(valuePlan.context ?? ctx)},${ctx},${jsString(valuePlan.kind)},${valuePlan.markerId ? jsString(valuePlan.markerId) : 'null'},${valuePlan.changeId ? jsString(valuePlan.changeId) : 'null'});`);
        }
        return;
      }
      default:
        this.warnings.push(`line ${this.lines.line(s.start)}: no value to show for this ${s.type}`);
    }
  }

  logpointText(span: Span, lp: LogpointPlan): Part[] {
    const m = (v: string | null) => (v ? jsString(v) : 'null');
    return [`${HOOK}.lp(`, this.rid(span), `,${jsString(lp.kind)},${jsString(lp.template)},${m(lp.context)},${m(lp.markerId)},${m(lp.changeId)},${lp.isExpr},(${EXC})=>eval(${EXC}));`];
  }

  // -- planning passes ----------------------------------------------------------------------------
  collect(program: Node): void {
    const walk = (n: Node, inFn: boolean): void => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) {
        for (const x of n) walk(x, inFn);
        return;
      }
      if (typeof n.type !== 'string') return;
      if (/Statement$|Declaration$/.test(n.type) && n.type !== 'BlockStatement' && n.type !== 'VariableDeclarator') this.allStatements.push(n);
      else if (n.type !== 'Program') this.allExpressions.push(n);
      for (const k in n) {
        const v = n[k];
        if (v && typeof v === 'object') walk(v, inFn);
      }
    };
    walk(program.body, false);
  }

  /** the innermost statement that ends on `line` (a live comment's target) */
  statementEndingOn(line: number): Node | undefined {
    let best: Node | undefined;
    for (const s of this.allStatements) {
      if (this.isDirective(s)) continue;
      if (this.lines.line(Math.max(s.start, s.end - 1)) !== line) continue;
      if (!best || s.start > best.start || (s.start === best.start && s.end < best.end)) best = s;
    }
    if (best) return best;
    // a compound statement whose header ends on the line: `if (x) { // ?`
    for (const s of this.allStatements) {
      if (!/^(IfStatement|WhileStatement|DoWhileStatement|SwitchStatement|ForOfStatement|ForInStatement)$/.test(s.type)) continue;
      const span = this.stmtSpan(s);
      if (this.lines.line(span[1]) === line && (!best || s.start > best.start)) best = s;
    }
    return best;
  }

  planMagic(comments: Node[]): void {
    for (const c of comments) {
      if (c.type !== 'Line') continue;
      const m = MAGIC_RE.exec(c.value);
      if (!m) continue;
      const suffix = m[1]!.replace(/\s+/g, '');
      const rest = m[2]!.trim();
      const kind = SUFFIX_KINDS[suffix];
      if (kind === undefined) continue;
      let code: string | null = null;
      if (rest) {
        if (!rest.includes('$') || !this.parsesAsExpression(rest)) continue; // `// ? is this right` is a human comment
        code = rest;
      }
      const line = this.lines.line(c.start);
      const s = this.statementEndingOn(line);
      if (!s) {
        this.warnings.push(`line ${line}: \`// ?\` has no expression to attach to`);
        continue;
      }
      this.stmtPlans.set(s, { kind, code, source: 'magic' });
    }
  }

  parsesAsExpression(code: string): boolean {
    try {
      const r = parseSync('x.js', `(${code});`, { sourceType: 'module' } as any);
      return r.errors.length === 0;
    } catch {
      return false;
    }
  }

  smallestCovering(range: number[]): Node | undefined {
    const start = this.lines.offset(range[0]!, range[1]!);
    const end = this.lines.offset(range[2]!, range[3]!);
    let best: Node | undefined;
    for (const n of [...this.allStatements, ...this.allExpressions]) {
      if (n.start <= start && n.end >= end && (!best || n.end - n.start < best.end - best.start)) best = n;
    }
    return best;
  }

  statementAtLine(line: number): Node | undefined {
    let best: Node | undefined;
    for (const s of this.allStatements) {
      if (this.isDirective(s) || this.lines.line(s.start) !== line) continue;
      if (!best || s.start < best.start) best = s;
    }
    return best;
  }

  planMarkers(): void {
    for (const m of this.options.markers ?? []) {
      try {
        const kind = m.kind ?? 'value';
        const rng = m.range;
        if (!rng || rng.length !== 4) continue;
        const base = { markerId: m.id ?? null, changeId: m.changeId ?? null, context: m.context ?? null };
        if (kind === 'value' || kind === 'time') {
          if (m.exp) {
            const st = this.statementAtLine(rng[0]!);
            if (st) this.addLogpoint(st, { kind: 'value', template: m.exp, context: m.context ?? m.exp, markerId: base.markerId, changeId: base.changeId, isExpr: true }, true);
            continue;
          }
          const node = this.smallestCovering(rng);
          if (!node) continue;
          const vkind = kind === 'time' ? (m.autoExpand ? KIND_TIME_AUTO_EXPAND : KIND_TIME) : m.autoExpand ? KIND_AUTO_EXPAND : KIND_VALUE;
          const plan: ValuePlan = { kind: vkind, ...base, source: 'marker' };
          if (/Statement$|Declaration$/.test(node.type)) this.stmtPlans.set(node, plan);
          else this.exprPlans.set(node, plan);
        } else if (kind === 'logpoint') {
          const st = this.statementAtLine(rng[0]!);
          if (!st) continue;
          if (m.logMessage) this.addLogpoint(st, { kind: 'logpoint', template: m.logMessage, context: m.context ?? null, markerId: base.markerId, changeId: base.changeId, isExpr: false }, false);
          else this.stmtPlans.set(st, { kind: 'logpoint', ...base, source: 'marker' });
        }
      } catch (e) {
        this.warnings.push(`marker ${JSON.stringify(m.id)} ignored: ${(e as Error).message}`);
      }
    }
  }

  addLogpoint(st: Node, lp: LogpointPlan, after: boolean): void {
    const slot = this.logpoints.get(st) ?? { before: [], after: [] };
    (after ? slot.after : slot.before).push(lp);
    this.logpoints.set(st, slot);
  }

  planIgnores(comments: Node[]): boolean {
    let ignoreFile = false;
    const lineRe = safeRegExp(this.options.ignoreCoverage ?? 'ignore coverage|istanbul ignore|c8 ignore');
    const fileRe = safeRegExp(this.options.ignoreCoverageForFile ?? 'ignore file coverage');
    for (const c of comments) {
      const body = c.value.trim();
      if (fileRe?.test(body)) {
        ignoreFile = true;
        continue;
      }
      if (!lineRe?.test(body)) continue;
      // the statement on the comment's line, else the first one after it (`/* istanbul ignore next */` above a function)
      let target: Node | undefined;
      for (const s of this.allStatements) {
        if (this.isDirective(s) || s.start < c.start) continue;
        if (!target || s.start < target.start) target = s;
      }
      const line = this.lines.line(c.start);
      const onLine = this.statementAtLine(line);
      target = onLine && onLine.start <= c.start ? onLine : target;
      if (target && this.lines.line(target.start) - this.lines.line(c.end) <= 1) this.markIgnored(target);
    }
    return ignoreFile;
  }
}

function safeRegExp(src: string): RegExp | null {
  if (!src) return null;
  try {
    return new RegExp(src);
  } catch {
    return null;
  }
}

const FENCE_RE = /^(\s*)\{\{([\s\S]*)\}\}(\s*)$/;

/** `/*{{ code }}*\/` -> `    code     `, same length; the code spans go to `regions` */
function blankFences(text: string, comments: Node[], regions: Span[]): string {
  let out = text;
  for (const c of comments) {
    if (c.type !== 'Block') continue;
    const m = FENCE_RE.exec(c.value);
    if (!m) continue;
    const open = c.start + 2 + m[1]!.length + 2; // after `/*`, the blanks and `{{`
    const close = c.end - 2 - m[3]!.length - 2; // where `}}` starts
    if (text.slice(c.start, c.start + 2) !== '/*') continue;
    out = out.slice(0, c.start) + ' '.repeat(open - c.start) + out.slice(open, close) + ' '.repeat(c.end - close) + out.slice(c.end);
    regions.push([open, close]);
  }
  return out;
}

function isPatternText(id: Node): string {
  return id?.type === 'ObjectPattern' || id?.type === 'ArrayPattern' ? ',1' : '';
}

/** a literal AST value (strings, numbers, booleans, null, arrays, objects), or throws */
function literal(n: Node): unknown {
  switch (n?.type) {
    case 'ParenthesizedExpression':
      return literal(n.expression);
    case 'Literal':
      if (n.regex || typeof n.value === 'bigint') throw new Error('not a literal');
      return n.value;
    case 'UnaryExpression':
      if (n.operator === '-' && n.argument.type === 'Literal' && typeof n.argument.value === 'number') return -n.argument.value;
      throw new Error('not a literal');
    case 'TemplateLiteral':
      if (n.expressions.length) throw new Error('not a literal');
      return n.quasis[0].value.cooked;
    case 'ArrayExpression':
      return n.elements.map((e: Node) => literal(e));
    case 'ObjectExpression': {
      const out: Record<string, unknown> = {};
      for (const p of n.properties) {
        if (p.type !== 'Property' || p.computed || p.kind !== 'init' || p.method) throw new Error('not a literal');
        const k = p.key.type === 'Identifier' ? p.key.name : String(literal(p.key));
        out[k] = literal(p.value);
      }
      return out;
    }
    default:
      throw new Error('not a literal');
  }
}

/** the inline config statement of a program: a parenthesised object literal first, Quokka's `({ ... })` */
function inlineConfigOf(program: Node): { node: Node; value: Record<string, unknown> } | null {
  const first = program.body.find((s: Node) => !(s.type === 'ExpressionStatement' && typeof s.directive === 'string'));
  if (first?.type !== 'ExpressionStatement' || first.expression.type !== 'ParenthesizedExpression' || first.expression.expression.type !== 'ObjectExpression') return null;
  try {
    return { node: first, value: literal(first.expression) as Record<string, unknown> };
  } catch {
    return null;
  }
}

/** Quokka-style inline config of a source file, `({ autoLog: true, env: { A: '1' } })` as its first statement */
export function inlineConfig(source: string, filename: string): Record<string, unknown> | null {
  try {
    const js = isTypeScriptPath(filename) || isJsxPath(filename) ? toJavaScript(source, filename).js : source;
    const r = parseSync(filename.replace(/\.(ts|mts|cts|tsx|jsx)$/i, '.js'), js, { sourceType: 'unambiguous', lang: 'js', preserveParens: true });
    return r.errors?.length ? null : (inlineConfigOf(r.program)?.value ?? null);
  } catch {
    return null;
  }
}

function render(parts: Part[], rids: Map<Key, number>, prefix = ''): string {
  let out = '';
  for (const p of parts) out += typeof p === 'string' ? p : prefix + String(rids.get(p.span));
  return out;
}

/** `[offset, inserted length]` pairs (any order) as per-line `[origCol, cumulative shift]` runs */
function columnShifts(flat: number[], lines: LineIndex): [number, number[]][] {
  const n = flat.length >> 1;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => flat[a * 2]! - flat[b * 2]!);
  const out: [number, number[]][] = [];
  let curLine = -1;
  let runs: number[] = [];
  let cum = 0;
  for (const i of order) {
    const len = flat[i * 2 + 1]!;
    if (!len) continue;
    const [line, col] = lines.pos(flat[i * 2]!);
    if (line !== curLine) {
      if (runs.length) out.push([curLine, runs]);
      curLine = line;
      runs = [];
      cum = 0;
    }
    cum += len;
    if (runs.length && runs[runs.length - 2] === col) runs[runs.length - 1] = cum;
    else runs.push(col, cum);
  }
  if (runs.length) out.push([curLine, runs]);
  return out;
}

/** an instrumented 0-based column of `line` back to the source's (an inserted column maps to where the insertion sits) */
export function sourceColumn(colMap: Map<number, number[]> | undefined, line: number, col: number): number {
  const runs = colMap?.get(line);
  if (!runs) return col;
  let before = 0;
  for (let i = 0; i < runs.length; i += 2) {
    const at = runs[i]!;
    const cum = runs[i + 1]!;
    if (col < at + before) return col - before; // source text before this insertion
    if (col < at + cum) return at; // inside the inserted text: where it sits
    before = cum;
  }
  return col - before;
}

const BASE = '_tk_b_';
const SLOT_WIDTH = 10;
const slot = (base: number) => String(base).padStart(SLOT_WIDTH, ' ');

/** a relocatable library file's instrumentation moved to `rangeBase` (and `fileId`) */
export function relocate(info: InstrumentedFile, fileId: number, rangeBase: number): InstrumentedFile {
  const at = info.relocSlot ?? -1;
  if (info.code === null || at < 0) return { ...info, fileId };
  const shift = rangeBase - info.rangeBase;
  const code = info.code.slice(0, at) + slot(rangeBase) + info.code.slice(at + SLOT_WIDTH);
  const lineRids = new Map<number, number>();
  for (const [l, r] of info.lineRids) lineRids.set(l, r + shift);
  const functionNames = new Map<number, string>();
  for (const [r, n] of info.functionNames) functionNames.set(r + shift, n);
  const localNames = new Map<number, string[]>();
  for (const [r, n] of info.localNames ?? []) localNames.set(r + shift, n);
  return { ...info, fileId, rangeBase, code, lineRids, functionNames, localNames };
}

function emptyResult(filename: string, fileId: number, rangeBase: number, error: string, errorLine: number | null, code: string | null): InstrumentedFile {
  return {
    filename, fileId, rangeBase, code, ranges: [], statements: [], functions: [], magic: [], exprChildren: new Map(), lineRids: new Map(),
    ignored: new Set(), ignoreFile: false, functionNames: new Map(), moduleRid: 0, error, errorLine, warnings: [], rangeCount: 0, localNames: new Map(),
  };
}

/**
 * TypeScript to JavaScript at the same offsets: strip mode, or, when the source has `enum`,
 * `namespace` or parameter properties, those lowered first (lower.ts) and the rest stripped;
 * `lowered` then maps columns back to the source.
 */
export function toJavaScript(source: string, filename = 'x.ts', sourceType?: 'module' | 'commonjs' | 'unambiguous'): { js: string; orig: string; lowered: Lowered | null } {
  const ts = isTypeScriptPath(filename);
  if (isJsxPath(filename)) {
    // JSX (and a .tsx file's enums and friends) lowered in one pass, then the types stripped
    const low = lowerTypeScript(source, filename, { jsx: true, ts, sourceType });
    if (!low) return { js: ts ? stripTypes(source) : source, orig: source, lowered: null };
    return { js: ts ? stripTypes(low.code) : low.code, orig: low.code, lowered: low };
  }
  try {
    return { js: stripTypes(source), orig: source, lowered: null };
  } catch (e) {
    if ((e as { code?: string }).code !== 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') throw e;
    const low = lowerTypeScript(source, filename);
    if (!low) throw e;
    return { js: stripTypes(low.code), orig: low.code, lowered: low };
  }
}

export function instrument(source: string, filename: string, fileId = 1, rangeBase = 0, options: InstrumentOptions = {}): InstrumentedFile {
  const ts = options.typescript ?? (isTypeScriptPath(filename) || isJsxPath(filename));
  let js = source;
  let base = source; // the text `js`'s offsets refer to (the lowered TypeScript when there was some)
  let lowered: Lowered | null = null;
  if (ts) {
    try {
      ({ js, orig: base, lowered } = toJavaScript(source, filename, options.sourceType));
    } catch (e) {
      const err = e as Error & { code?: string };
      return emptyResult(filename, fileId, rangeBase, `TypeScriptError: ${err.message.split('\n')[0]}`, lineOf(err.message), null);
    }
  }
  const sourceType = options.sourceType === 'commonjs' ? 'commonjs' : options.sourceType === 'module' ? 'module' : 'unambiguous';
  let parsed: any;
  try {
    parsed = parseSync(filename.replace(/\.(ts|mts|cts|tsx|jsx)$/i, '.js'), js, { sourceType, lang: 'js', preserveParens: true } as any);
  } catch (e) {
    return emptyResult(filename, fileId, rangeBase, `SyntaxError: ${(e as Error).message}`, null, js);
  }
  if (parsed.errors?.length) {
    const first = parsed.errors[0];
    const at = first.labels?.[0]?.start;
    const line = typeof at === 'number' ? new LineIndex(js).line(at) : null;
    return emptyResult(filename, fileId, rangeBase, `SyntaxError: ${first.message}`, line, null);
  }
  let program = parsed.program;
  let orig = base;
  const snapRegions: Span[] = [];
  if (options.snaps) {
    // blank the fence marks: the snap code is then ordinary code at its own offsets
    const fenced = blankFences(js, parsed.comments ?? [], snapRegions);
    if (snapRegions.length) {
      const again = parseSync(filename.replace(/\.(ts|mts|cts|tsx|jsx)$/i, '.js'), fenced, { sourceType, lang: 'js', preserveParens: true } as any);
      if (again.errors?.length) {
        const first = again.errors[0];
        const at = first.labels?.[0]?.start;
        const line = typeof at === 'number' ? new LineIndex(fenced).line(at) : null;
        return emptyResult(filename, fileId, rangeBase, `SyntaxError: ${first.message} (in a snap)`, line, null);
      }
      js = fenced;
      orig = blankFences(base, parsed.comments ?? [], []);
      parsed = again;
      program = again.program;
    }
  }
  const ins = new Instrumenter(js, options, orig);
  if (lowered) ins.lines = new MappedLineIndex(js, source, lowered);
  const inline = options.moduleScope || options.library ? null : inlineConfigOf(program);
  if (inline) ins.inlineConfig = inline.node; // read before the run, not run as a statement
  ins.snapRegions.push(...snapRegions);
  for (const st of program.body) ins.topLevel.add(st);
  ins.collect(program);
  if (options.magic !== false && !options.library) ins.planMagic(parsed.comments ?? []);
  if (!options.library) ins.planMarkers();
  if (options.recordLocals) ins.localsAt = planLocals(program);
  const ignoreFile = ins.planIgnores(parsed.comments ?? []);

  // the whole file is range `moduleRid`: the scope entry of an imported module, scope 0's range for the main file
  const modSpan: Span = [0, js.length];
  const modKey = ins.key(modSpan);
  const firstStmt = program.body.find((s: Node) => !ins.isDirective(s));
  if (firstStmt) {
    // a CommonJS body is a function body: try/finally ends the quiet stretch when a require throws
    const reloc = options.relocatable ? `var ${BASE}=${slot(rangeBase)};` : '';
    if (options.library) ins.open(firstStmt.start, `${reloc}var ${SCOPE}=${HOOK}.qf(`, { span: modKey }, sourceType === 'commonjs' ? ');try{' : ');');
    else if (options.moduleScope) ins.open(firstStmt.start, `var ${SCOPE}=${HOOK}.f(`, { span: modKey }, ');');
    else ins.open(firstStmt.start, `var ${SCOPE}=0;`, options.scopeProbe ? `${HOOK}.probe=${PROBE};` : '');
  }
  ins.statementList(program.body);
  if (firstStmt && options.library) ins.close(program.end, sourceType === 'commonjs' ? `\n}finally{${HOOK}.qx(${SCOPE})}` : `\n;${HOOK}.qx(${SCOPE});`);
  else if (firstStmt && options.moduleScope) ins.close(program.end, `\n;${HOOK}.x(${SCOPE});`);
  else if (firstStmt && options.scopeProbe) ins.close(program.end, `\nfunction ${PROBE}(){if(0)eval("")}`);
  if (options.moduleScope || options.library) ins.functions.push([modKey, '<module>', modSpan]);

  // number the ranges in source order, then render the edits
  const order = [...ins.spans.entries()].sort((a, b) => a[1][0] - b[1][0] || b[1][1] - a[1][1]);
  const local = new Map<Key, number>();
  order.forEach(([k], i) => local.set(k, i));
  const global = new Map<Key, number>();
  const relocatable = !!(options.relocatable && options.library && firstStmt);
  for (const [k, i] of local) global.set(k, relocatable ? i : rangeBase + i);
  const prefix = relocatable ? `${BASE}+` : '';
  const ms = new MagicString(js);
  // without a source map, the column shifts the insertions make, so stack columns map back
  const shifts: number[] | null = options.sourceMap === false ? [] : null;
  for (const e of ins.edits) {
    const text = render(e.parts, global, prefix);
    if (e.op === 'open') ms.appendRight(e.pos, text);
    else if (e.op === 'close') ms.appendLeft(e.pos, text);
    else if (e.op === 'overwrite') ms.overwrite(e.start, e.end, text, { contentOnly: true });
    if (shifts) shifts.push(e.op === 'overwrite' ? e.end : e.pos, e.op === 'overwrite' ? text.length - (e.end - e.start) : text.length);
  }
  const colMap = shifts && !lowered ? columnShifts(shifts, ins.lines) : undefined;
  let code = ms.toString();
  const relocSlot = relocatable ? code.indexOf(`var ${BASE}=`) + `var ${BASE}=`.length : undefined;
  if (options.sourceMap !== false) {
    const map = ms.generateMap({ hires: true, source: filename, includeContent: false });
    code += `\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${Buffer.from(map.toString()).toString('base64')}`;
  }
  const ranges = order.map(([, s]) => ins.lines.range(s[0], s[1]));
  const ignored = new Set<number>();
  for (const s of ins.ignoredNodes) {
    const sp = ins.stmtSpan(s);
    const k = sp[0] * 33554432 + sp[1];
    if (local.has(k)) ignored.add(local.get(k)!);
  }
  const statements = [...new Set(ins.stmtKeys.map((k) => local.get(k)!))].filter((r) => !ignored.has(r)).sort((a, b) => a - b);
  const functions = ins.functions.map(([k, name, body]) => ({ rid: local.get(k)!, name, bodyRange: ins.lines.range(body[0], body[1]) })).sort((a, b) => a.rid - b.rid);
  const functionNames = new Map<number, string>();
  for (const f of functions) functionNames.set(rangeBase + f.rid, f.name);
  const lineRids = new Map<number, number>();
  const byStart = [...ins.stmtLines].sort((a, b) => ins.spans.get(a[0])![0] - ins.spans.get(b[0])![0]);
  for (const [k, start, end] of byStart) for (let l = start; l <= end; l++) lineRids.set(l, rangeBase + local.get(k)!);
  const exprChildren = new Map<number, number[]>();
  for (const [s, cs] of ins.exprChildren) exprChildren.set(local.get(s)!, cs.map((c) => local.get(c)!));
  return {
    filename,
    fileId,
    rangeBase,
    code,
    ranges,
    statements,
    functions,
    magic: ins.magic.map(([k, kind]) => ({ rid: local.get(k)!, kind })),
    exprChildren,
    lineRids,
    ignored,
    ignoreFile,
    functionNames,
    moduleRid: local.get(modKey)!,
    error: null,
    errorLine: null,
    warnings: ins.warnings,
    rangeCount: ranges.length,
    relocSlot,
    localNames: new Map([...ins.localKeys].map(([k, names]) => [global.get(k)!, names])),
    ...(colMap ? { colMap } : {}),
    ...(options.library ? {} : { walk: walkTable(program, js, ins.lines, functions) }),
  };
}

function lineOf(message: string): number | null {
  const m = /:(\d+):\d+/.exec(message) ?? /line (\d+)/i.exec(message);
  return m ? Number(m[1]) : null;
}
