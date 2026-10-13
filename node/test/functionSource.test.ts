import { test } from 'node:test';
import assert from 'node:assert/strict';
import { functionSourceAt } from '../src/debug/functionSource.ts';

test('selects the callback at its runtime line, without its enclosing function', () => {
  const source = 'async function run() {\n  await loop((event) => this.processEvents(event));\n}\n';
  assert.equal(functionSourceAt('agent.js', source, 2), '(event) => this.processEvents(event)');
});

test('does not guess between functions on the same line', () => {
  assert.equal(functionSourceAt('agent.js', 'const a = () => 1, b = () => 2;', 1), undefined);
});

test('retains multiline bodies and rejects non-function locations', () => {
  const source = 'const emit = (event) => {\n  return process(event);\n};';
  assert.equal(functionSourceAt('agent.js', source, 1), '(event) => {\n  return process(event);\n}');
  assert.equal(functionSourceAt('agent.js', source, 2), undefined);
});
