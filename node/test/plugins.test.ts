import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from './helpers.ts';

const plugin = [
  'let started = 0;',
  'export function before(config) { started++; }',
  'export function beforeEach(config, api) {',
  '  globalThis.seen = { file: api.current.filePath.endsWith("main.js"), flag: config.custom, started };',
  '  api.runnerError("hello from the plugin");',
  '}',
  'export function after(config, api) {',
  '  return { plugin: { calls: globalThis.calls, current: !!api.current }, exitCode: 99 };',
  '}',
].join('\n');

test('plugins: beforeEach before the program, after merged into run.finished, the runtime fields win', async () => {
  const main = 'globalThis.calls = 3;\nconsole.log(JSON.stringify(globalThis.seen));\n';
  const r = await run({ 'main.js': main, 'plug.mjs': plugin }, 'main.js', {}, { plugins: ['./plug.mjs'], custom: 'x' });
  assert.equal(r.finished.exitCode, 0);
  assert.deepEqual(r.finished.plugin, { calls: 3, current: true });
  assert.deepEqual(JSON.parse(r.logs()[0]!.text), { file: true, flag: 'x', started: 0 });
  assert.ok(r.of('runner.error').some((e) => e.message === 'hello from the plugin'));
  // the plugin's own code is not instrumented
  assert.deepEqual(r.of('file.instrumented').map((f) => f.path.split('/').pop()), ['main.js']);
});

test('plugins: a hook that throws is a runner.error and the run goes on; a missing plugin too', async () => {
  const bad = 'export function beforeEach() { throw new TypeError("nope"); }\nexport function after() { throw new Error("late"); }\n';
  const r = await run({ 'main.js': 'console.log("ran")\n', 'bad.mjs': bad }, 'main.js', {}, { plugins: ['./bad.mjs', './missing.mjs'] });
  assert.equal(r.finished.exitCode, 0);
  assert.equal(r.logs()[0]!.text, 'ran');
  const msgs = r.of('runner.error').map((e) => e.message);
  assert.ok(msgs.includes('plugin ./bad.mjs failed in beforeEach: TypeError: nope'), msgs.join('\n'));
  assert.ok(msgs.includes('plugin ./bad.mjs failed in after: Error: late'), msgs.join('\n'));
  assert.ok(msgs.some((m) => m.startsWith('plugin ./missing.mjs failed')), msgs.join('\n'));
});

test('plugins: after runs on an uncaught error and on process.exit', async () => {
  const p = 'export function after() { return { afterRan: true }; }\n';
  const r1 = await run({ 'main.js': 'throw new Error("boom")\n', 'p.mjs': p }, 'main.js', {}, { plugins: ['./p.mjs'] });
  assert.equal(r1.finished.exitCode, 1);
  assert.equal(r1.finished.afterRan, true);
  const r2 = await run({ 'main.js': 'process.exit(3)\n', 'p.mjs': p }, 'main.js', {}, { plugins: ['./p.mjs'] });
  assert.equal(r2.finished.exitCode, 3);
  assert.equal(r2.finished.afterRan, true);
});

test('plugins: before runs in the runner process, ahead of the child', async () => {
  const p = 'import { appendFileSync } from "node:fs";\nexport function before(config) { appendFileSync(config.mark, String(process.pid) + "\\n"); }\n';
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const mark = join(mkdtempSync(join(tmpdir(), 'tracelight-mark-')), 'mark');
  const r = await run({ 'main.js': '1\n', 'p.mjs': p }, 'main.js', {}, { plugins: ['./p.mjs'], mark });
  assert.equal(r.finished.exitCode, 0);
  assert.deepEqual(readFileSync(mark, 'utf8').trim().split('\n'), [String(process.pid)]);
});
