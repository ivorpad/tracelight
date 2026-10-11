/** `run --save` redacts every saved event and keeps a redacted copy of the user's own files only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { project } from './helpers.ts';

const BIN = resolve(import.meta.dirname, '../bin/tracelight.mjs');

test('a saved run carries no secret: values, output, errors and the kept sources are redacted', () => {
  const dir = project({
    'node_modules/lib/index.js': 'exports.id = (x) => x;\n',
    'main.mjs': `import { createRequire } from 'node:module';
const { id } = createRequire(import.meta.url)('lib');
const token = 'sk-abcdefghijklmnopqrstuvwxyz012345';
const header = id('Bearer abcdefghijklmnop');
console.log(token, header);
throw new Error('api_key=supersecretvalue');
`,
  });
  const out = join(dir, 'run.json');
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', BIN, 'run', join(dir, 'main.mjs'), '--save', out, '--library-code'], { cwd: dir, encoding: 'utf8' });
  assert.match(r.stderr + r.stdout, /saved /, r.stderr);
  const text = readFileSync(out, 'utf8');
  for (const secret of ['sk-abcdefghijklmnopqrstuvwxyz012345', 'abcdefghijklmnop', 'supersecretvalue']) assert.ok(!text.includes(secret), `${secret} leaked into the saved run`);
  assert.ok(text.includes('«redacted»'));
  const doc = JSON.parse(text);
  const files = doc.meta.files as { path: string; source?: string; sha256: string | null }[];
  const main = files.find((f) => f.path.endsWith('main.mjs'))!;
  assert.match(main.source!, /const token = '«redacted»';/);
  assert.equal(main.sha256!.length, 64);
  const lib = files.find((f) => f.path.includes('node_modules'));
  if (lib) assert.equal(lib.source, undefined, 'a library keeps only its hash');
  // the bindings still come from the source that ran, so their columns hold
  const ev = doc.events.find((e: any) => e.type === 'file.instrumented' && e.path.endsWith('main.mjs'));
  assert.ok(Array.isArray(ev.bindings) && ev.bindings.length > 0);
});
