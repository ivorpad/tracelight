import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { project } from './helpers.ts';
import { recordRun, buildRequest, runOnce } from '../src/cli.ts';
import { dispatchVerb } from '../src/agent/commands.ts';
import { SavedRun } from '../src/agent/source.ts';
import '../src/agent/verbs.ts';

let dir: string, beforeFile: string, afterFile: string;
async function cli(...args: string[]) {
  let out = '', err = '';
  const code = await dispatchVerb(args[0]!, [...args.slice(1), '--json'], { out: s => { out += s; }, err: s => { err += s; } });
  assert.equal(err, '');
  return { code, result: JSON.parse(out) };
}
before(async () => {
  dir = project({ 'main.ts': 'const state = { total: 1 };\nconst alias = state;\nalias.total = 2;\nconst total = state.total;\nconsole.log(total);\n' });
  beforeFile = join(dir, 'before.json'); afterFile = join(dir, 'after.json');
  await recordRun({ file: join(dir, 'main.ts'), save: beforeFile, json: true, autoLog: false, timeoutMs: 10000, argv: [] });
  writeFileSync(join(dir, 'main.ts'), readFileSync(join(dir, 'main.ts'), 'utf8').replace('alias.total = 2', 'alias.total = 3'));
  await recordRun({ file: join(dir, 'main.ts'), save: afterFile, json: true, autoLog: false, timeoutMs: 10000, argv: [] });
});
after(() => rmSync(dir, { recursive: true, force: true }));

test('investigation attributes mutations through aliases to the writing statement', async () => {
  const { code, result } = await cli('investigate', beforeFile, '--value', 'state');
  assert.equal(code, 0);
  assert.equal(result.history.changes.at(-1).line, 3);
  assert.match(result.history.changes.at(-1).text, /total: 2/);
  assert.ok(result.coverage);
  assert.ok(result.origin);
});
test('learning hides results until reveal and retains the prediction', async () => {
  const lesson = (await cli('learn', beforeFile)).result;
  assert.ok(lesson.checkpoints.length);
  assert.equal(lesson.observed, undefined);
  const step = String(lesson.checkpoints.at(-1).step);
  const hidden = (await cli('learn', beforeFile, '--at', step, '--prediction', '2')).result;
  assert.equal(hidden.observed, undefined);
  const shown = (await cli('learn', beforeFile, '--at', step, '--prediction', '2', '--reveal')).result;
  assert.equal(shown.prediction, '2');
  assert.ok(shown.observed);
});
test('pin saves a baseline and refuses to overwrite it', async () => {
  const pinned = join(dir, 'pin.json');
  assert.equal((await cli('pin', beforeFile, '--out', pinned)).code, 0);
  assert.deepEqual(JSON.parse(readFileSync(pinned, 'utf8')), JSON.parse(readFileSync(beforeFile, 'utf8')));
  assert.notEqual((await cli('pin', afterFile, '--out', pinned)).code, 0);
});
test('verify only passes explicit matching expectations on complete successful runs', async () => {
  assert.equal((await cli('verify', beforeFile, '--after', afterFile)).result.verified, false);
  const good = await cli('verify', beforeFile, '--after', afterFile, '--expect', 'total=3');
  assert.equal(good.code, 0); assert.equal(good.result.verified, true);
  const bad = await cli('verify', beforeFile, '--after', afterFile, '--expect', 'total=2');
  assert.equal(bad.code, 1); assert.equal(bad.result.verified, false);
  const cut = JSON.parse(readFileSync(afterFile, 'utf8'));
  Object.assign(cut.events.findLast((e: any) => e.type === 'trace' && !e.partial), { truncated: true, cap: 10, stepsRun: 50 });
  writeFileSync(join(dir, 'cut.json'), JSON.stringify(cut));
  const limited = await cli('verify', beforeFile, '--after', join(dir, 'cut.json'), '--expect', 'total=3');
  assert.equal(limited.code, 1); assert.equal(limited.result.verified, false);
});
test('verify reruns saved inputs and exports an executable regression test', async () => {
  const spec = join(dir, 'regression.test.mjs');
  const result = await cli('verify', beforeFile, '--rerun', '--expect', 'total=3', '--test-out', spec);
  assert.equal(result.code, 0); assert.equal(result.result.verified, true);
  const ran = spawnSync(process.execPath, ['--test', spec], { encoding: 'utf8', timeout: 20000 });
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
});
test('symlinked project entries and unsaved dependency overrides record normally', async () => {
  const root = project({ 'src/main.mjs': "import { value } from './lib.mjs';\nconsole.log(value);", 'src/lib.mjs': 'export const value = 1;' });
  const alias = root + '-link';
  symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const file = join(alias, 'src/main.mjs');
    const req = buildRequest(file, readFileSync(file, 'utf8'), { recordLocals: true, cwd: alias }, 'symlink-test');
    req.projectFiles = [{ path: join(alias, 'src/lib.mjs'), content: 'export const value = 42;' }];
    const { events, finished } = await runOnce(req);
    assert.equal(finished.exitCode, 0);
    assert.ok(finished.stepCount > 0);
    assert.ok(events.some(e => e.type === 'log' && e.text === '42'));
    const run = await recordRun({ file, json: true, autoLog: false, timeoutMs: 10000, argv: [], recordLocals: true });
    assert.equal(new SavedRun('symlink.json', run).workspaceRoot, join(root, 'src'));
  } finally { rmSync(alias, { force: true }); rmSync(root, { recursive: true, force: true }); }
});

test('diff can ignore an explicit unstable value while keeping the report auditable', async () => {
  const file = join(dir, 'unstable.mjs');
  writeFileSync(file, 'const stamp = process.argv[2];\nconst stable = 1;\nconsole.log(stable);\n');
  const a = join(dir, 'unstable-a.json'), b = join(dir, 'unstable-b.json');
  for (const [save, value] of [[a, 'first'], [b, 'second']]) await recordRun({ file, save, json: true, autoLog: false, timeoutMs: 10000, argv: [value!] });
  assert.ok((await cli('diff', a, b)).result.total > 0);
  const ignored = (await cli('diff', a, b, '--ignore', 'stamp')).result;
  assert.equal(ignored.total, 0);
  assert.ok(ignored.notes.some((n: string) => n.includes('Ignored value/log names: stamp')));
});
