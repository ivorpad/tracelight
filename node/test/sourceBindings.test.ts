import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceBindings } from '../src/sourceBindings.ts';

test('typed parameters have identifier spans, without type fields or string/comment matches', () => {
  const source = 'export function f(queue: { name: string; seconds: number }[], elapsed: number) {\n const job = queue.shift();\n // elapsed\n const s = "elapsed";\n return elapsed + job.seconds;\n}';
  const data = sourceBindings(source);
  assert.deepEqual(data.references.map(r => source.slice(r.start, r.end)), ['f', 'queue', 'elapsed', 'job', 'queue', 's', 'elapsed', 'job']);
  assert.deepEqual(data.references.at(-1)?.path, ['seconds']);
});

test('block shadows, arrow parameters, catch bindings and var hoisting have separate identities', () => {
  const source = 'let value = 0;\nfunction f(value: number) {\n { let value = false; use(value); }\n use(value);\n items.map((value: number) => value);\n try { throw 0; } catch(value) { use(value); }\n { var hoisted = 1; }\n return hoisted;\n}';
  const data = sourceBindings(source);
  const values = data.references.filter(r => r.name === 'value');
  assert.equal(new Set(values.map(r => r.scope)).size, 5);
  assert.equal(values[2]?.scope, values[3]?.scope);
  assert.equal(values[1]?.scope, values[4]?.scope);
  const hoisted = data.references.filter(r => r.name === 'hoisted');
  assert.equal(hoisted[0]?.scope, hoisted[1]?.scope);
  assert.equal(data.scopes[values[2]!.scope]?.pending?.[0]?.name, 'value');
  assert.equal(data.scopes[hoisted[0]!.scope]?.pending?.some(p => p.name === 'hoisted'), undefined);
});

test('property paths omit object keys and retain references inside templates and TS assertions', () => {
  const source = 'const café = { elapsed: 0 };\r\nfunction f(job: any) { return `${job.name}: ${(job as any).nested.seconds}`; }';
  const data = sourceBindings(source);
  assert.equal(data.references.some(r => r.name === 'elapsed'), false);
  assert.deepEqual(data.references.filter(r => r.name === 'job').map(r => r.path), [[], ['name'], ['nested', 'seconds']]);
  assert.equal(source.slice(data.references[0]!.start, data.references[0]!.end), 'café');
});
