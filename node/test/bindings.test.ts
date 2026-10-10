import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statementBindings } from '../src/bindings.ts';

test('assigns, reads, loop and calls per statement, keyed by the statement start', () => {
  const src = [
    'const total = prices.reduce((a, b) => a + b, 0);',
    'function f(x, { y }, ...rest) { return x }',
    'for (const item of items) { seen.add(item); }',
    'obj.a.b = compute(n);',
    'list[i] = 1;',
    'count++;',
  ].join('\n');
  const rows = statementBindings(src, 'x.js');
  const at = (line: number) => rows.find((r) => r.line === line && r.col === 0)!;
  assert.deepEqual(at(1).assigns, ['total']);
  assert.deepEqual(at(1).reads, ['prices']);
  assert.deepEqual(at(1).calls, ['prices.reduce((a, b) => a + b, 0)']);
  assert.deepEqual(at(2).assigns, ['x', 'y', 'rest']);
  assert.equal(at(3).loop, 3);
  assert.deepEqual(at(3).assigns, ['item']);
  assert.deepEqual(at(3).reads, ['items']);
  assert.deepEqual(at(4).assigns, ['obj.a.b']);
  assert.deepEqual(at(4).reads, ['obj', 'compute', 'n']);
  assert.deepEqual(at(5).assigns, ['list']);
  assert.deepEqual(at(6).assigns, ['count']);
});

test('a TypeScript buffer without a path is read with its types stripped', () => {
  const rows = statementBindings('const n: number = m + 1;\n');
  assert.deepEqual(rows[0]!.assigns, ['n']);
  assert.deepEqual(rows[0]!.reads, ['m']);
});
