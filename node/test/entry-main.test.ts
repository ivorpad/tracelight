import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { project } from './helpers.ts';
import { buildRequest, runOnce } from '../src/cli.ts';
import { instrument } from '../src/instrument.ts';
import { readFileSync } from 'node:fs';

// The runner imports the program, so without the rewrite a guarded entry ran nothing and the
// debugger exited without pausing.
test('the entry reads import.meta.main as true, columns unchanged, assignments and other files untouched', () => {
  const source = 'if (import.meta.main) console.log(1);\nimport.meta.main = false;\n';
  const entry = instrument(source, '/p/main.mjs', 1, 0, { sourceType: 'module', entry: true }).code;
  assert.match(entry, /if \(true {12}\)/);
  assert.match(entry, /import\.meta\.main = false/);
  const imported = instrument(source, '/p/lib.mjs', 1, 0, { sourceType: 'module', moduleScope: true }).code;
  assert.match(imported, /if \(import\.meta\.main\)/);
});

test('a CommonJS entry reads require.main as its own module; an ES module entry keeps require.main', () => {
  const cjs = instrument('if (require.main === module) run();\n', '/p/main.cjs', 1, 0, { sourceType: 'commonjs', entry: true }).code;
  assert.match(cjs, /if \(module {7}=== module\)/);
  const esm = instrument('if (require.main === module) run();\n', '/p/main.mjs', 1, 0, { sourceType: 'module', entry: true }).code;
  assert.match(esm, /require\.main === module/);
});

for (const [name, files] of [
  ['an ES module entry', { 'main.ts': "import { lib } from './lib.ts';\nif (import.meta.main) {\n  console.log('ran', lib);\n}\n", 'lib.ts': 'export const lib = import.meta.main;\n' }],
  ['a CommonJS entry', { 'main.cjs': "const lib = require('./lib.cjs');\nif (require.main === module) {\n  console.log('ran', lib);\n}\n", 'lib.cjs': 'module.exports = require.main === module;\n' }],
] as const) {
  test(`${name} guarded by its main check runs its body, and an imported module still is not main`, async () => {
    const root = project(files as Record<string, string>);
    try {
      const file = join(root, Object.keys(files)[0]!);
      const { events, finished } = await runOnce(buildRequest(file, readFileSync(file, 'utf8'), { cwd: root }, `entry-${name}`));
      assert.equal(finished.exitCode, 0);
      assert.ok(events.some(e => e.type === 'log' && e.text === 'ran false'), JSON.stringify(events.filter(e => e.type === 'log')));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
