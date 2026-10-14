import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { project, run } from './helpers.ts';

const BIN = resolve(import.meta.dirname, '../bin/tracelight.mjs');

// A file the run does not record that fails to compile stops the program before its first step;
// the error still names that file and line, which V8 keeps out of `err.stack` for module syntax errors.
const bun = process.env.TRACELIGHT_TEST_BUN || 'bun';
const hasBun = spawnSync(bun, ['--version']).status === 0;
for (const node of [process.execPath, bun]) for (const ext of ['ts', 'js']) {
  test(`a syntax error in an unrecorded .${ext} import names its file and line (${node})`, { skip: node === bun && !hasBun }, async () => {
    const lib = project({ [`bad.${ext}`]: `export const ok = 1;\nexport const x = ;\n` });
    const r = await run({ 'entry.ts': `import { x } from '${lib}/bad.${ext}';\nconsole.log(x);\n` }, 'entry.ts', { node });
    const [error] = r.of('error');
    assert.equal(error?.errorType, node === bun ? 'BuildMessage' : 'SyntaxError');
    assert.equal(error.stack[0]?.path, join(lib, `bad.${ext}`));
    assert.equal(error.stack[0]?.line, 2);
    assert.equal(r.finished.exitCode, 1);
  });
}

test('run prints the location of a load-time error instead of ?:?', () => {
  const lib = project({ 'bad.ts': 'export const x = ;\n' });
  const app = project({ 'entry.ts': `import { x } from '${lib}/bad.ts';\nconsole.log(x);\n` });
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', BIN, 'run', join(app, 'entry.ts')], { cwd: app, encoding: 'utf8' });
  assert.match(r.stdout, new RegExp(`error: SyntaxError: .*\\(${lib.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/bad\\.ts:1\\)`));
  assert.doesNotMatch(r.stdout, /\?:\?/);
});
