import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { project, run } from './helpers.ts';

const BIN = resolve(import.meta.dirname, '../bin/tracelight.mjs');
const bun = process.env.TRACELIGHT_TEST_BUN || 'bun';
const hasBun = spawnSync(bun, ['--version']).status === 0;

// Under Node, an error Bun would not have raised says how to run under Bun; other errors say nothing.
test('a Bun global under Node names --node bun', async () => {
  const r = await run({ 'main.ts': 'console.log(Bun.version);\n' }, 'main.ts');
  assert.match(r.of('error')[0]?.hint ?? '', /calls Bun APIs.*--node bun.*--runtime bun/);
});

test('a load failure inside a Bun project names --node bun; an ordinary bug there does not', async () => {
  const app = { 'package.json': '{"type":"module"}', 'bun.lock': '{}' };
  // Bun imports JSON without `with { type: 'json' }`; Node refuses before the first step
  const json = { 'main.ts': "import data from './data.json';\nconsole.log(data.answer);\n", 'data.json': '{"answer":42}' };
  const load = await run({ ...app, ...json }, 'main.ts');
  assert.match(load.of('error')[0]?.hint ?? '', /is a Bun project \(bun\.lock\).*--node bun/);
  const bug = await run({ ...app, 'main.ts': 'const o: any = null;\nconsole.log(o.x);\n' }, 'main.ts');
  assert.equal(bug.of('error')[0]?.errorType, 'TypeError');
  assert.equal(bug.of('error')[0]?.hint, undefined);
  const plain = await run({ 'package.json': '{"type":"module"}', ...json }, 'main.ts');
  assert.equal(plain.finished.exitCode, 1);
  assert.equal(plain.of('error')[0]?.hint, undefined);
});

test('under Bun there is no runtime hint', { skip: !hasBun }, async () => {
  const r = await run({ 'package.json': '{"type":"module"}', 'bun.lock': '{}', 'main.ts': 'console.log(Bun.version.length > 0);\n' }, 'main.ts', { node: bun });
  assert.equal(r.finished.exitCode, 0);
  assert.deepEqual(r.of('error'), []);
});

test('run prints the hint under the error', () => {
  const dir = project({ 'main.ts': 'console.log(Bun.version);\n' });
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', BIN, 'run', join(dir, 'main.ts')], { cwd: dir, encoding: 'utf8' });
  assert.match(r.stdout, /^error: ReferenceError: Bun is not defined .*\n {2}hint: .*--node bun/m);
});
