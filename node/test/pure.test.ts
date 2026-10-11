import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from 'node:inspector';
import { evaluatePure, probeScope, rewriteFallback, RefusedError, EvalException, type Post } from '../src/pure.ts';

const session = new Session();
session.connect();
// the main-thread session answers synchronously; wrap it as the promise-shaped `post`
const post: Post = (method, params) =>
  new Promise((resolve, reject) => session.post(method, params ?? {}, (err, res) => (err ? reject(err) : resolve(res))));

// a module scope like the instrumenter's entry module: the probe keeps every binding reachable
const items = [1, 2, 3];
const word = 'Hello, World';
const config = { name: 'demo', nested: { n: 2 } };
let counter = 7;
(globalThis as any).__tk = { probe: function __tk_probe() { if (0) eval(''); } };

async function ev(expr: string): Promise<unknown> {
  const scope = await probeScope(post);
  const r = await evaluatePure(post, { scope }, expr);
  return r.value ?? r.description;
}

test('the probe lists the module bindings, not the runtime names', async () => {
  const names = (await probeScope(post)).map((b) => b.name);
  for (const n of ['items', 'word', 'config', 'counter']) assert.ok(names.includes(n), n);
  assert.ok(!names.some((n) => n.startsWith('__tk')));
});

test('reads, operators, lambdas and pure builtins run', async () => {
  assert.equal(await ev('items.length * 2'), 6);
  assert.equal(await ev('items.map(x => x + 1).join()'), '2,3,4');
  assert.equal(await ev('config.nested.n + counter'), 9);
  assert.equal(await ev('JSON.stringify(items)'), '[1,2,3]');
  assert.equal(await ev('Math.max(...items)'), 3);
});

test('string methods V8 refuses run through the second path', async () => {
  assert.equal(await ev('word.toUpperCase()'), 'HELLO, WORLD');
  assert.equal(await ev('word.split(", ").length'), 2);
  assert.equal(await ev('word.trim().toLowerCase().startsWith("hello")'), true);
  assert.equal(await ev('(3.14159).toFixed(2)'), '3.14');
});

test('mutations are refused and nothing changes', async () => {
  for (const expr of ['items.push(4)', 'counter = 1', 'counter++', 'delete config.name', 'items.splice(0)']) {
    await assert.rejects(ev(expr), RefusedError, expr);
  }
  assert.deepEqual(items, [1, 2, 3]);
  assert.equal(counter, 7);
});

test('a method of a non-string receiver is refused at run time', async () => {
  const writer = { log: [] as string[], trim() { this.log.push('x'); return 'trimmed'; } };
  (globalThis as any).__w = writer;
  const scope = [{ name: 'writer', value: (await post('Runtime.evaluate', { expression: 'globalThis.__w' })).result }];
  await assert.rejects(evaluatePure(post, { scope }, 'writer.trim()'), RefusedError);
  assert.deepEqual(writer.log, []);
  delete (globalThis as any).__w;
});

test('an exception is reported, not refused', async () => {
  await assert.rejects(ev('nope + 1'), (e: any) => e instanceof EvalException && e.errorType === 'ReferenceError');
  await assert.rejects(ev('let x = 1'), EvalException);
});

test('rewrite keeps the receiver one evaluation', () => {
  assert.equal(rewriteFallback('a.b.trim()'), '(__tk_pure_m(a.b, "trim", "a.b.trim")()\n)');
  assert.throws(() => rewriteFallback('obj.save()'), /cannot call `obj.save`/);
  assert.throws(() => rewriteFallback('fn(1)'), /cannot call `fn`/);
});
