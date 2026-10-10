/** `walkthrough` and `coverage` over saved JavaScript runs: JS decisions and loops, constructors, the cap, coverage folded to lines. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { project } from './helpers.ts';
import { dispatchVerb, type Io } from '../src/agent/commands.ts';
import '../src/agent/verbs.ts';
import { libraryPackage, packageOf, formatDuration } from '../src/agent/walkthrough.ts';

const BIN = resolve(import.meta.dirname, '../bin/tracelight.mjs');

const LIB = `export class Box {
  constructor(items) {
    this.items = items;
  }
  first() {
    if (this.items.length === 0) {
      throw new RangeError('empty box');
    }
    return this.items[0];
  }
}
`;
const MAIN = `import { Box } from './lib.mjs';
const prices = [3, 4, 5];
const box = new Box(prices);
console.log(box.first());
let n = 0;
while (n < 2) {
  n++;
}
if (n > 1) {
  console.log('many');
} else if (n === 1) {
  console.log('one');
}
switch (n) {
  case 1:
    break;
  default:
    console.log('other');
}
for (const p of prices) {
  if (p > 3) console.log(p);
}
function fact(k) {
  return k <= 1 ? 1 : k * fact(k - 1);
}
console.log(fact(3));
try {
  new Box([]).first();
} catch (e) {
  console.log('caught');
}
`;

let dir = '';
let saved = '';

async function verb(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const io: Io = { out: (t) => (out += t), err: (t) => (err += t) };
  const code = await dispatchVerb(argv[0]!, argv.slice(1), io);
  return { code, out, err };
}

before(() => {
  dir = project({ 'main.mjs': MAIN, 'lib.mjs': LIB });
  saved = join(dir, 'run.json');
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', BIN, 'run', join(dir, 'main.mjs'), '--save', saved], { cwd: dir, encoding: 'utf8' });
  assert.match(r.stderr, /^saved /m, r.stderr);
});

test('walkthrough: JS decisions and loops read as written, a constructor is a call, not a callback', async () => {
  const { code, out } = await verb('walkthrough', saved);
  assert.equal(code, 0);
  const lines = out.split('\n');
  assert.match(lines[0]!, /^\d+ moments over \d+ steps$/);
  for (const want of [
    /#\d+  call to Box\.constructor from <module>/,
    /      in items = \[ 3, 4, 5 \]/,
    /#\d+  call to Box\.first from <module>/,
    /      out return = 3/,
    /#\d+  while \(n < 2\) ran 2 times/,
    /#\d+  if \(n > 1\) took true/,
    /#\d+  switch \(n\) took default/,
    /#\d+  for \(const p of prices\) ran 3 times/,
    /#\d+  call 1 of 2 to fact from fact/,
    /      out raised = RangeError: empty box/,
    /#\d+  raised RangeError: empty box, handled at main\.mjs:\d+/,
    /#\d+  run ends with exit code 0 after [\d.]+ m?s/,
  ])
    assert.ok(lines.some((l) => want.test(l)), `${want} in\n${out}`);
  assert.ok(!out.includes('callback into'), out);
  assert.ok(!out.includes('in this ='), 'this is not a parameter');
  // `if (p > 3) console.log(p);`: the statement sharing the header's line is not a second decision
  assert.equal(lines.filter((l) => /if \(p > 3\) took/.test(l)).length, 3, out);
  assert.deepEqual(lines.filter((l) => /if \(p > 3\) took/.test(l)).map((l) => l.split(' took ')[1]), ['false', 'true', 'true']);
});

test('walkthrough: windows, scope and file filters, --json shape', async () => {
  const scoped = await verb('walkthrough', saved, '--scope', 'Box.first');
  assert.ok(scoped.out.split('\n').slice(1).filter(Boolean).every((l) => !/module main\.mjs starts/.test(l)));
  assert.match(scoped.out, /if \(this\.items\.length === 0\) took (true|false)/);
  const byFile = JSON.parse((await verb('walkthrough', saved, '--file', 'lib.mjs', '--json')).out);
  assert.ok(byFile.moments.length > 0);
  assert.ok(byFile.moments.every((m: any) => m.location.file.endsWith('lib.mjs')));
  assert.deepEqual(Object.keys(byFile), ['count', 'total', 'shown', 'capped', 'truncated', 'file', 'exitCode', 'stale', 'staleFiles', 'moments']);
  const m = byFile.moments[0];
  assert.deepEqual(Object.keys(m).slice(0, 5), ['kind', 'step', 'location', 'text', 'values']);
  assert.ok('id' in m && 'durationMs' in m && 'gloss' in m && !('key' in m));
  const win = JSON.parse((await verb('walkthrough', saved, '--from', '0', '--to', '3', '--json')).out);
  assert.ok(win.moments.every((x: any) => x.step <= 3));
  const missing = await verb('walkthrough', saved, '--file', 'nope.mjs');
  assert.equal(missing.code, 2);
  assert.match(missing.err, /^error: no file nope\.mjs in the run\n/);
});

test('coverage: lines that ran, never ran and the file line by line', async () => {
  const { code, out } = await verb('coverage', saved, '--file', 'main.mjs');
  assert.equal(code, 0, out);
  assert.match(out, /^\d+ of \d+ statement lines ran \([\d.]+%\) in 2 project files\n/);
  assert.match(out, /main\.mjs  \d+ of \d+ ran \([\d.]+%\)  not run: /);
  assert.match(out, /main\.mjs, line by line \(hits; not run, partial and raised marked\):/);
  assert.match(out, /\s+12 +--  {3}console\.log\('one'\);   not run/);
  const json = JSON.parse((await verb('coverage', saved, '--json')).out);
  assert.deepEqual(Object.keys(json.total), ['files', 'lines', 'ran', 'percent', 'libraryFiles']);
  assert.equal(json.files[0].file, 'main.mjs');
});

test('library packages: node_modules names, scoped ones, a lone module by its stem', () => {
  assert.equal(packageOf('/p/node_modules/openai/index.js'), 'openai');
  assert.equal(packageOf('/p/node_modules/@scope/pkg/dist/a.js'), '@scope/pkg');
  assert.equal(packageOf('/p/node_modules/a/node_modules/b/x.js'), 'b');
  assert.equal(packageOf('/p/src/a.ts'), null);
  assert.equal(libraryPackage('/opt/lib/helper.mjs'), 'helper');
  assert.equal(libraryPackage('/opt/lib/thing/index.js'), 'thing');
  assert.equal(formatDuration(69.5), '70 ms');
  assert.equal(formatDuration(3650), '3.7 s');
  assert.equal(formatDuration(null), '?');
});

test('walkthrough: an if on its loop header\'s line takes false when its body does not run', async () => {
  const d = project({ 'total.mjs': 'let total = 0;\nfor (const r of [3, -2, 4]) if (r >= 0) total += r;\nconsole.log(total);\n' });
  const run = join(d, 'run.json');
  spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', BIN, 'run', join(d, 'total.mjs'), '--save', run], { cwd: d, encoding: 'utf8' });
  const { out } = await verb('walkthrough', run);
  assert.deepEqual(out.split('\n').filter((l) => /if \(r >= 0\) took/.test(l)).map((l) => l.split(' took ')[1]), ['true', 'false', 'true'], out);
});
