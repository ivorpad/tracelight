import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { project } from './helpers.ts';
import { SavedRun } from '../src/agent/source.ts';
const testEnv = { ...process.env };
delete testEnv.NODE_TEST_CONTEXT;
const cli = resolve(import.meta.dirname, '../bin/tracelight.mjs');

test('normal launch follows forked processes, preserves stdout and IPC, and records typed sources', () => {
  const dir = project({
    'main.mjs': "import { fork } from 'node:child_process';\nconsole.log('parent ready');\nconst child = fork('./child.ts', ['hello']);\nchild.on('message', m => console.log('got', m));\n",
    'child.ts': "const answer: number = 42;\nprocess.send?.(answer);\nconsole.log(process.argv[2], answer);\n",
  });
  try {
    const out = join(dir, 'runs');
    const r = spawnSync(process.execPath, [cli, 'launch', '--out', out, '--cwd', dir, '--', process.execPath, 'main.mjs'], { encoding: 'utf8', timeout: 20000, env: testEnv });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /parent ready/); assert.match(r.stdout, /got 42/); assert.match(r.stdout, /hello 42/);
    const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
    assert.equal(index.recordings.length, 2);
    const child = index.recordings.find((r: any) => r.file.endsWith('child.ts'));
    assert.ok(child.steps > 0);
    const history = new SavedRun(join(out, child.recording)).var('answer', {});
    assert.equal(history.changes.at(-1).text, '42');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a selected Node test keeps normal filtering and failure exit status', () => {
  const dir = project({ 'sample.test.ts': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('selected', () => { const actual = 2; assert.equal(actual, 3); });\ntest('unselected', () => { throw Error('should not run'); });\n" });
  try {
    const out = join(dir, 'runs');
    const r = spawnSync(process.execPath, [cli, 'launch', '--out', out, '--cwd', dir, '--', process.execPath, '--test', '--test-name-pattern', '^selected$', 'sample.test.ts'], { encoding: 'utf8', timeout: 20000, env: testEnv });
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.doesNotMatch(r.stdout, /should not run/);
    const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
    assert.equal(index.exitCode, 1); assert.ok(index.recordings.length > 0);
    const run = new SavedRun(join(out, index.recordings[0].recording));
    assert.equal(run.var('actual', {}).changes.at(-1).text, '2');
    assert.ok(run.errors.some(e => /2 !== 3/.test(e.message)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
