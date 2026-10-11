/**
 * `evaluate` and `complete` against a finished run that had no debugger, on the run child's main
 * thread: a `node:inspector` session connected to its own thread answers synchronously, the
 * program is done, and the finished run's namespace is the scope probe of the entry module
 * (`pure.ts` `probeScope`). With a debugger the worker serves the same requests (`debug/agent.ts`).
 */
import { Session } from 'node:inspector';
import { format } from 'node:util';
import { parseSync } from 'oxc-parser';
import { secrets } from './secrets.ts';
import { evaluatePure, probeScope, type Post } from './pure.ts';
import { completionsFor, type Completed } from './debug/complete.ts';
import type { Described } from './debug/describe.ts';

let session: Session | null = null;

function post(): Post {
  if (!session) {
    session = new Session();
    session.connect();
  }
  const s = session;
  return (method, params) => new Promise((resolve, reject) => s.post(method as any, (params ?? {}) as any, (err: Error | null, res: any) => (err ? reject(err) : resolve(res))));
}

const GROUP = 'tracelight-finished';

async function release(p: Post): Promise<void> {
  await p('Runtime.releaseObjectGroup', { objectGroup: GROUP }).catch(() => {});
}

/** A pure expression's value in the finished run's namespace. */
async function valueFinished(expression: string): Promise<unknown> {
  const p = post();
  try {
    const scope = await probeScope(p, undefined, GROUP);
    const remote = await evaluatePure(p, { scope }, expression, GROUP);
    // the value itself, on this same thread: the session hands it back through a global slot
    const g = await p('Runtime.evaluate', { expression: 'globalThis', objectGroup: GROUP });
    const arg = remote.objectId ? { objectId: remote.objectId } : remote.unserializableValue ? { unserializableValue: remote.unserializableValue } : { value: remote.value };
    await p('Runtime.callFunctionOn', { objectId: g.result.objectId, functionDeclaration: 'function (v) { globalThis.__tk_value = v; }', arguments: [arg], silent: true });
    const value = (globalThis as any).__tk_value;
    delete (globalThis as any).__tk_value;
    return value;
  } finally {
    await release(p);
  }
}

/** A pure expression in the finished run's namespace, described by `describe` (the tracer's serializer). */
export async function evaluateFinished(expression: string, describe: (value: unknown, name: string) => Described): Promise<Described> {
  return describe(await valueFinished(expression), expression);
}

export interface Shadowed extends Described {
  kind: 'log' | 'value';
  context: string;
}

const CONSOLE = new Set(['log', 'info', 'debug', 'warn', 'error', 'trace']);

/**
 * What one edited statement would show, from the finished run's state:
 * `console.log(a, b)` (rendered as the run renders a console call, kind `log`), a bare
 * expression, or `x = expr` / `const x = expr` (kind `value`, `context` the target). Every
 * expression goes through the pure rule, so nothing in the namespace changes.
 */
export async function shadowFinished(source: string, describe: (value: unknown, name: string) => Described): Promise<Shadowed> {
  const text = source.trim();
  const parsed = parseSync('tracelight-shadow.ts', text, { sourceType: 'module', lang: 'ts' } as any);
  if (parsed.errors.length) throw new SyntaxError(parsed.errors[0]!.message);
  const body = parsed.program.body as any[];
  if (body.length !== 1) throw new Error('one statement at a time');
  const st = body[0];
  const src = (n: any) => text.slice(n.start, n.end);
  if (st.type === 'ExpressionStatement') {
    const e = st.expression;
    const callee = e.type === 'CallExpression' ? e.callee : null;
    if (callee?.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && callee.object.name === 'console' && CONSOLE.has(callee.property.name)) {
      if (e.arguments.some((a: any) => a.type === 'SpreadElement')) throw new Error('not a value-producing statement');
      const args = (await valueFinished(`[${e.arguments.map(src).join(', ')}]`)) as unknown[];
      const shown = args.length === 1 ? args[0] : args.length === 0 ? '' : args;
      const context = `console.${callee.property.name}`;
      return { kind: 'log', context, ...describe(shown, context), text: secrets.scrub(format(...args)).replace(/\r\n/g, '\n').replace(/\n/g, '\\n') };
    }
    if (e.type === 'AssignmentExpression' && e.operator === '=') return value(src(e.right), src(e.left));
    return value(src(e), src(e));
  }
  if (st.type === 'VariableDeclaration' && st.declarations.length === 1 && st.declarations[0].init) {
    const d = st.declarations[0];
    return value(src(d.init), src(d.id));
  }
  throw new Error('not a value-producing statement');

  async function value(expression: string, context: string): Promise<Shadowed> {
    return { kind: 'value', context, ...describe(await valueFinished(expression), context) };
  }
}

export async function completeFinished(expression: string, limit = 100): Promise<Completed> {
  const p = post();
  try {
    const bound = await probeScope(p, undefined, GROUP);
    const g = await p('Runtime.evaluate', { expression: 'globalThis', objectGroup: GROUP });
    return await completionsFor(p, { scope: bound }, expression, [{ names: bound.map((b) => ({ name: b.name, remote: b.value })) }], g.result.objectId, limit, GROUP);
  } finally {
    await release(p);
  }
}
