/**
 * What a hover, a watch or a completion may run: expressions that cannot
 * change the program.
 *
 * The rule is V8's own side-effect analysis: `Runtime.evaluate` / `Debugger.evaluateOnCallFrame`
 * / `Runtime.callFunctionOn` with `throwOnSideEffect: true`. It is more permissive than pure.py
 * (`items.map(x => x + 1)` runs, a lambda is no side effect) and needs nothing maintained here:
 * `items.push(4)` is refused by V8 with "Possible side-effect in debug-evaluate".
 *
 * V8 also refuses some calls pure.py allows, because its allowlist marks them unsafe: the string
 * methods that go through ICU or RegExp (`s.toUpperCase()`, `s.split(",")`, `s.trim()`). An
 * expression V8 refuses gets a second chance under pure.py's own rule: names, member access,
 * literals, operators, and calls of a non-mutating method of a string or number primitive (or of
 * an allowlisted `Math` / `Number` / `String` / `Object` / `Array` / `JSON` static), the receiver
 * checked where the expression runs, through `__tk_pure_m`. Everything else stays refused, with
 * one line saying what is allowed. Like pure.py this second path is not a sandbox: a member
 * access may run a getter and string conversion may run `toString`.
 *
 * Every function takes a `post(method, params)` for the inspector session it works through, so
 * the same code serves the debugger's worker thread (`node:inspector/promises`, a paused frame)
 * and the finished run's main thread (`node:inspector`, synchronous, the scope probe).
 */
import { parseSync } from 'oxc-parser';
import MagicString from 'magic-string';

export type Post = (method: string, params?: Record<string, unknown>) => Promise<any>;

/** A CDP RemoteObject (the subset used here) */
export interface Remote {
  type: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
}

export const RULE =
  'a hover or a watch runs only code without side effects (V8 refuses assignments, mutating calls and user functions that write; ' +
  'non-mutating methods of strings and numbers are allowed)';

export const MAX_TEXT = 60;

/** the helper the second path routes method calls through; installed on demand in the program's realm */
export const METHOD_FN = '__tk_pure_m';

export const STRING_METHODS = new Set(
  `at charAt charCodeAt codePointAt concat endsWith includes indexOf isWellFormed lastIndexOf localeCompare match matchAll
   normalize padEnd padStart repeat replace replaceAll search slice split startsWith substring substr toLocaleLowerCase
   toLocaleUpperCase toLowerCase toString toUpperCase toWellFormed trim trimEnd trimStart valueOf`.split(/\s+/),
);
export const NUMBER_METHODS = new Set(['toExponential', 'toFixed', 'toLocaleString', 'toPrecision', 'toString', 'valueOf']);
/** `Object.method` statics that read */
export const STATICS: Record<string, Set<string>> = {
  Math: new Set(Object.getOwnPropertyNames(Math).filter((n) => typeof (Math as any)[n] === 'function' && n !== 'random')),
  Number: new Set(['isFinite', 'isInteger', 'isNaN', 'isSafeInteger', 'parseFloat', 'parseInt']),
  String: new Set(['fromCharCode', 'fromCodePoint', 'raw']),
  Object: new Set(['keys', 'values', 'entries', 'getOwnPropertyNames', 'getPrototypeOf', 'is', 'isFrozen', 'isSealed', 'isExtensible', 'hasOwn']),
  Array: new Set(['isArray', 'of']),
  JSON: new Set(['stringify']),
};
/** bare functions the second path may call */
export const PURE_GLOBALS = new Set(['String', 'Number', 'Boolean', 'BigInt', 'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI']);

export class RefusedError extends Error {
  readonly refused = true;
}

/** An exception the expression itself raised: `ReferenceError: x is not defined`. */
export class EvalException extends Error {
  readonly errorType: string;
  readonly remote?: Remote;
  constructor(errorType: string, message: string, remote?: Remote) {
    super(message);
    this.errorType = errorType;
    this.remote = remote;
  }
}

function clip(text: string): string {
  const t = text.split(/\s+/).join(' ').trim();
  return t.length <= MAX_TEXT ? t : t.slice(0, MAX_TEXT) + '...';
}

export function refusal(expression: string, what = 'evaluate'): RefusedError {
  return new RefusedError(`cannot ${what} \`${clip(expression)}\` here: ${RULE}`);
}

const SIDE_EFFECT = /Possible side-effect in debug-evaluate/;

/** The node types the second path accepts, besides the ones handled by name below. */
const PLAIN = new Set([
  'Identifier', 'Literal', 'StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral', 'BigIntLiteral', 'RegExpLiteral',
  'TemplateLiteral', 'TemplateElement', 'BinaryExpression', 'LogicalExpression', 'ConditionalExpression', 'ArrayExpression',
  'ObjectExpression', 'Property', 'SpreadElement', 'SequenceExpression', 'ParenthesizedExpression', 'MemberExpression',
  'ChainExpression', 'PrivateIdentifier', 'ThisExpression', 'ExpressionStatement', 'Program',
]);

function parseExpression(expression: string): any {
  const wrapped = `(${expression}\n)`;
  const res = parseSync('tracelight-evaluate.js', wrapped, { sourceType: 'script' });
  if (res.errors.length) throw new EvalException('SyntaxError', `SyntaxError: ${res.errors[0]!.message}`);
  const body = res.program.body;
  if (body.length !== 1 || body[0].type !== 'ExpressionStatement') throw new EvalException('SyntaxError', 'SyntaxError: not one expression');
  return { node: body[0].expression, wrapped };
}

/**
 * The second path's check and rewrite: the source to evaluate (method calls routed through
 * `__tk_pure_m`), or a `RefusedError` naming the first thing that may not run.
 */
export function rewriteFallback(expression: string): string {
  const { node: root, wrapped } = parseExpression(expression);
  const ms = new MagicString(wrapped);
  const refuse = (n: any, what = 'evaluate'): never => {
    throw refusal(wrapped.slice(n.start, n.end), what);
  };
  const visit = (n: any): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(visit);
    if (typeof n.type !== 'string') return;
    if (n.type === 'UnaryExpression') {
      if (n.operator === 'delete') refuse(n);
      return visit(n.argument);
    }
    if (n.type === 'CallExpression') {
      const callee = n.callee;
      n.arguments.forEach(visit);
      if (callee.type === 'Identifier') {
        if (!PURE_GLOBALS.has(callee.name)) refuse(callee, 'call');
        return;
      }
      if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
        const name = callee.property.name;
        const obj = callee.object;
        if (obj.type === 'Identifier' && STATICS[obj.name]?.has(name)) return;
        if (!STRING_METHODS.has(name) && !NUMBER_METHODS.has(name)) refuse(callee, 'call');
        visit(obj);
        // recv.m(args) -> __tk_pure_m(recv, "m", "text")(args): the receiver is evaluated once and its type checked at run time
        const text = JSON.stringify(clip(wrapped.slice(callee.start, callee.end)));
        ms.prependLeft(obj.start, `${METHOD_FN}(`);
        ms.overwrite(obj.end, callee.end, `, ${JSON.stringify(name)}, ${text})`);
        return;
      }
      refuse(callee, 'call');
    }
    if (!PLAIN.has(n.type)) refuse(n);
    for (const key of Object.keys(n)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'range' || key === 'loc') continue;
      const v = n[key];
      if (v && typeof v === 'object') visit(v);
    }
  };
  visit(root);
  return ms.toString();
}

const FUNCTION_NODES = new Set(['ArrowFunctionExpression', 'FunctionExpression']);

function refuseWrites(expression: string, root: any): void {
  const visit = (n: any): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(visit);
    if (FUNCTION_NODES.has(n.type)) return; // its own locals are its business; V8 checks what it touches outside
    if (n.type === 'AssignmentExpression' || n.type === 'UpdateExpression' || (n.type === 'UnaryExpression' && n.operator === 'delete')) {
      throw refusal(`(${expression}\n)`.slice(n.start, n.end));
    }
    for (const key of Object.keys(n)) if (key !== 'type' && n[key] && typeof n[key] === 'object') visit(n[key]);
  };
  visit(root);
}

/** The helper's source, defined once per realm (`globalThis.__tk_pure_m`). */
export const METHOD_HELPER_SOURCE = `(() => {
  if (globalThis.${METHOD_FN}) return;
  const S = new Set(${JSON.stringify([...STRING_METHODS])});
  const N = new Set(${JSON.stringify([...NUMBER_METHODS])});
  const RULE = ${JSON.stringify(RULE)};
  Object.defineProperty(globalThis, ${JSON.stringify(METHOD_FN)}, { value: function (recv, name, text) {
    const t = typeof recv;
    if ((t === 'string' && S.has(name)) || ((t === 'number' || t === 'bigint') && N.has(name))) {
      const f = Object(recv)[name];
      return (...args) => f.apply(recv, args);
    }
    throw new Error('cannot call \`' + text + '\` here: ' + RULE);
  }, configurable: true });
})()`;

/** Where an expression runs: a paused frame, or a list of bound names (the finished run's scope). */
export type Target = { callFrameId: string } | { scope: ScopeBinding[]; objectId?: string };

export interface ScopeBinding {
  name: string;
  value: Remote;
}

function argOf(r: Remote): Record<string, unknown> {
  if (r.objectId) return { objectId: r.objectId };
  if (r.unserializableValue) return { unserializableValue: r.unserializableValue };
  return { value: r.value };
}

async function evalIn(post: Post, target: Target, source: string, sideEffectFree: boolean, objectGroup: string): Promise<any> {
  if ('callFrameId' in target) {
    return post('Debugger.evaluateOnCallFrame', {
      callFrameId: target.callFrameId, expression: source, throwOnSideEffect: sideEffectFree, silent: true, objectGroup,
    });
  }
  const names = target.scope.map((b) => b.name);
  const decl = `function (${names.join(', ')}) { return (${source}\n); }`;
  let objectId = target.objectId;
  if (!objectId) {
    const g = await post('Runtime.evaluate', { expression: 'globalThis', objectGroup });
    objectId = g.result.objectId;
  }
  return post('Runtime.callFunctionOn', {
    objectId, functionDeclaration: decl, arguments: target.scope.map((b) => argOf(b.value)), throwOnSideEffect: sideEffectFree, silent: true, objectGroup,
  });
}

function exceptionOf(res: any): EvalException {
  const ex: Remote | undefined = res.exceptionDetails?.exception ?? res.result;
  const description = String(ex?.description ?? res.exceptionDetails?.text ?? 'error').split('\n')[0]!;
  const errorType = ex?.className ?? (description.match(/^(\w+):/)?.[1] ?? 'Error');
  return new EvalException(errorType, description, ex);
}

/**
 * Evaluate a pure expression at `target`; the RemoteObject of its value. Throws `RefusedError`
 * when neither V8 nor the second path allows it, `EvalException` when it raised.
 */
export async function evaluatePure(post: Post, target: Target, expression: string, objectGroup = 'tracelight'): Promise<Remote> {
  const expr = expression.trim();
  if (!expr) throw new EvalException('SyntaxError', 'SyntaxError: empty expression');
  // a statement list or a declaration is no expression; an assignment to a name the expression
  // does not declare is refused here too, since against the probe's bound names V8 would let it
  // write a copy and answer as if the program had changed
  refuseWrites(expr, parseExpression(expr).node);
  const first = await evalIn(post, target, expr, true, objectGroup);
  if (!first.exceptionDetails) return first.result;
  const err = exceptionOf(first);
  if (!SIDE_EFFECT.test(err.message)) throw err;
  const source = rewriteFallback(expr); // throws the refusal
  await post('Runtime.evaluate', { expression: METHOD_HELPER_SOURCE, silent: true });
  const second = await evalIn(post, target, source, false, objectGroup);
  if (!second.exceptionDetails) return second.result;
  const err2 = exceptionOf(second);
  if (/^Error: cannot call `/.test(err2.message)) throw new RefusedError(err2.message.replace(/^Error: /, ''));
  throw err2;
}

/**
 * The finished run's namespace, from the scope probe the instrumenter registers on the entry
 * module (`__tk.keep(function __tk_probe() { if (0) eval('') })`, hoisted to the module's top, so
 * the module scope is reachable even after an uncaught exception, and the `eval` keeps every
 * module-level binding context-allocated). Inner scopes first; a name bound twice keeps the inner
 * binding; a binding still in its temporal dead zone has no value and is left out.
 */
export async function probeScope(post: Post, probeExpression = 'globalThis.__tk?.probe', objectGroup = 'tracelight'): Promise<ScopeBinding[]> {
  const probe = await post('Runtime.evaluate', { expression: probeExpression, objectGroup, silent: true });
  const objectId = probe.result?.objectId;
  if (!objectId || probe.result.type !== 'function') throw new Error('no run data');
  const props = await post('Runtime.getProperties', { objectId, ownProperties: true, objectGroup });
  const scopes = (props.internalProperties ?? []).find((p: any) => p.name === '[[Scopes]]');
  if (!scopes?.value?.objectId) return [];
  const list = await post('Runtime.getProperties', { objectId: scopes.value.objectId, ownProperties: true, objectGroup });
  const seen = new Set<string>();
  const out: ScopeBinding[] = [];
  for (const entry of list.result ?? []) {
    const scope = entry.value;
    if (!scope?.objectId || /^Global/.test(scope.description ?? '')) continue;
    const vars = await post('Runtime.getProperties', { objectId: scope.objectId, ownProperties: true, objectGroup });
    for (const v of vars.result ?? []) {
      if (!v.value || seen.has(v.name) || isRuntimeName(v.name) || !/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(v.name)) continue;
      seen.add(v.name);
      out.push({ name: v.name, value: v.value });
    }
  }
  return out;
}

/** The runtime's own names (`_tk_scope_`, `__tk`, `__tk_probe`): never listed, never shown. */
export function isRuntimeName(name: string): boolean {
  return name.startsWith('_tk_') || name.startsWith('__tk');
}
