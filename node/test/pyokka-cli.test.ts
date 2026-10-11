/** Pyokka's agent verbs read a Tracelight saved run: `pyokka story` and `pyokka step` over a JavaScript run. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { project } from './helpers.ts';

const PY = resolve(import.meta.dirname, '../../python');
const havePython = spawnSync('python3', ['-c', 'import sys; assert sys.version_info >= (3, 12)']).status === 0;
const BIN = resolve(import.meta.dirname, '../bin/tracelight.mjs');

test('pyokka story and step read a run saved by tracelight run --save', { skip: !havePython && 'python3 >= 3.12 not found' }, () => {
  const dir = project({ 'main.mjs': 'function sq(n) {\n  return n * n;\n}\nconst a = sq(3);\nconsole.log(a);\n' });
  const out = join(dir, 'run.json');
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', BIN, 'run', join(dir, 'main.mjs'), '--save', out], { stdio: 'pipe' });
  const env = { ...process.env, PYTHONPATH: PY };
  const story = execFileSync('python3', ['-m', 'pyokka_runtime', 'story', out, '--file', join(dir, 'main.mjs')], { env, encoding: 'utf8' });
  assert.match(story, /## sq {2}main\.mjs:1/);
  assert.match(story, /const a = sq\(3\);/);
  const step = execFileSync('python3', ['-m', 'pyokka_runtime', 'step', out, '1', '--into'], { env, encoding: 'utf8' });
  assert.match(step, /sq/);
});
