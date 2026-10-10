/**
 * `narrate`: backend resolution, the prompt, strict parsing, writing glosses into the saved run.
 * No live model: the backends are tiny shell
 * scripts on a PATH of their own.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { project } from './helpers.ts';
import { NAME } from '../src/protocol.ts';
import { dispatchVerb, type Io } from '../src/agent/commands.ts';
import { GLOSS_MAX, NarrationError, PROMPT_FILE, buildPrompt, extractJsonObject, parseGlosses, promptTemplate, resolveBackend, runBackend, shlexSplit } from '../src/agent/narrate.ts';
import { REDACTED } from '../src/agent/redact.ts';
import '../src/agent/verbs.ts';

const BIN = resolve(import.meta.dirname, '../bin/tracelight.mjs');

const PROGRAM = `function add(a, b) {
  const total = a + b;
  return total;
}

const key = "sk-abcdefghijklmnopqrstuvwxyz012345";
const n = add(1, 2);
console.log(n);
`;

let dir = '';
let runPath = '';
let binDir = '';
const PATH = process.env.PATH;

function fakeCli(name: string, script: string): string {
  const path = join(binDir, name);
  writeFileSync(path, '#!/bin/sh\n' + script + '\n');
  chmodSync(path, 0o755);
  return path;
}

before(() => {
  dir = project({ 'main.mjs': PROGRAM });
  runPath = join(dir, 'run.json');
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', BIN, 'run', join(dir, 'main.mjs'), '--save', runPath], { stdio: 'pipe', cwd: dir, encoding: 'utf8' });
  assert.match(r.stderr + r.stdout, /saved /, r.stderr);
  binDir = join(dir, 'bin');
  mkdirSync(binDir);
  process.env.PATH = `${binDir}:/usr/bin:/bin`; // the fakes use cat and printf
});

after(() => {
  process.env.PATH = PATH;
});

async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const io: Io = { out: (t) => void (out += t), err: (t) => void (err += t) };
  const code = await dispatchVerb(argv[0]!, argv.slice(1), io);
  return { code, out, err };
}

test('resolveBackend prefers the setting, then claude, then codex', () => {
  assert.deepEqual(resolveBackend('my-model --fast')!.argv, ['my-model', '--fast']);
  assert.equal(resolveBackend('my-model')!.name, 'custom');
  assert.deepEqual(shlexSplit(`model -p "a b" 'c d' e\\ f`), ['model', '-p', 'a b', 'c d', 'e f']);
  assert.equal(resolveBackend(null), null);
  fakeCli('codex', 'exit 0');
  let b = resolveBackend(null)!;
  assert.equal(b.name, 'codex');
  assert.deepEqual(b.argv.slice(0, 3), ['codex', 'exec', '--skip-git-repo-check']);
  assert.ok(b.argv.includes('-o') && b.argv[b.argv.length - 1] === '-' && b.outputFile);
  fakeCli('claude', 'exit 0');
  b = resolveBackend(null)!;
  assert.equal(b.name, 'claude');
  assert.deepEqual(b.argv, ['claude', '-p', '--output-format', 'json', '--tools', '', '--no-session-persistence']);
  unlinkSync(join(binDir, 'claude'));
  unlinkSync(join(binDir, 'codex'));
});

test('runBackend reads each CLI the way it answers', () => {
  fakeCli('claude', `cat > /dev/null; printf '{"type":"result","is_error":false,"result":"{\\\\"m0\\\\": \\\\"starts\\\\"}"}'`);
  assert.equal(runBackend(resolveBackend(null)!, 'prompt'), '{"m0": "starts"}');
  fakeCli('claude', `cat > /dev/null; printf '{"type":"result","is_error":true,"result":"Not logged in"}'`);
  assert.throws(() => runBackend(resolveBackend(null)!, 'prompt'), (e: Error) => e instanceof NarrationError && /claude reported an error: Not logged in/.test(e.message));
  unlinkSync(join(binDir, 'claude'));
  fakeCli('codex', `while [ "$1" != "-o" ]; do shift; done; cat > /dev/null; echo "log noise"; printf '{"m0": "from codex"}' > "$2"`);
  const b = resolveBackend(null)!;
  assert.equal(b.name, 'codex');
  assert.equal(runBackend(b, 'prompt'), '{"m0": "from codex"}');
  unlinkSync(join(binDir, 'codex'));
  const mine = fakeCli('mine', 'read -r first; echo "{\\"m0\\": \\"$first\\"}"');
  assert.equal(runBackend({ name: 'custom', argv: [mine] }, 'hello\nworld'), '{"m0": "hello"}\n');
  const broken = fakeCli('broken', 'echo "boom sk-abcdefghijklmnopqrstuvwxyz012345" >&2; exit 3');
  assert.throws(
    () => runBackend({ name: 'custom', argv: [broken] }, 'p'),
    (e: Error) => /exited with 3/.test(e.message) && e.message.includes(REDACTED) && !e.message.includes('sk-abc'),
  );
  assert.throws(() => runBackend({ name: 'custom', argv: ['no-such-command-xyz'] }, 'p'), /not on the PATH/);
});

test('parseGlosses is strict and tolerant of fences', () => {
  const ids = ['m0', 'm1', 'm2'];
  assert.deepEqual(parseGlosses('Sure!\n```json\n{"m0": "a", "m1": "b  c", "zz": "dropped"}\n```', ids), { m0: 'a', m1: 'b c' });
  const long = 'x'.repeat(200);
  assert.deepEqual(parseGlosses(JSON.stringify({ m2: long }), ids), { m2: long.slice(0, GLOSS_MAX - 1) + '…' });
  assert.throws(() => parseGlosses('I cannot do that', ids), /not answer with a JSON object/);
  assert.throws(() => parseGlosses('{"m0": ["a"]}', ids), /is not a string/);
  assert.throws(() => parseGlosses('{"other": "a"}', ids), /glossed none/);
  assert.deepEqual(extractJsonObject('text {"a": "}"} more {"b": 1}'), { a: '}' });
  assert.equal(extractJsonObject('[1, 2]'), null);
});

test('buildPrompt redacts values and lists the sources as JavaScript', () => {
  const template = 'HEAD\n{{walkthrough}}\nMID\n{{sources}}\nTAIL';
  const walk = { moments: [{ id: 'm0', step: 1, kind: 'value', text: "key = 'sk-abcdefghijklmnopqrstuvwxyz012345'", values: [{ role: 'value', name: 'key', text: "'sk-abcdefghijklmnopqrstuvwxyz012345'" }], location: { file: '/w/a.mjs', line: 3, function: '<module>', fileId: 1 }, callee: { secret: 'x' } }] };
  const text = buildPrompt(template, walk, [{ file: 'a.mjs', function: 'add', line: 1, text: 'function add(a, b) {\n  return a + b;\n}' }]);
  assert.ok(text.startsWith('HEAD\n{') && text.endsWith('\nTAIL'));
  assert.ok(text.includes('### a.mjs: add (line 1)') && text.includes('```javascript\nfunction add(a, b) {'));
  assert.ok(!text.includes('sk-abc') && text.includes(REDACTED) && text.includes('"file": "a.mjs"') && !text.includes('callee') && !text.includes('/w/a.mjs'));
  // `$&` in a value is text, not a replacement pattern
  assert.ok(buildPrompt('{{walkthrough}}', { moments: [{ id: 'm0', text: 'x $& y', location: {} }] }, []).includes('x $& y'));
  assert.ok(buildPrompt('{{sources}}', { moments: [] }, [{ file: 'b.ts', function: 'f', line: 2, text: 'x' }]).includes('```typescript\n'));
});

test('narrate --dry-run prints the prompt', async () => {
  const r = await cli('narrate', runPath, '--dry-run');
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.startsWith('You are annotating a recorded execution of a JavaScript'));
  assert.ok(!r.out.includes('{{walkthrough}}') && r.out.includes('## Walkthrough'));
  assert.ok(r.out.includes('### main.mjs: add (line 1)') && r.out.includes('function add(a, b) {'));
  assert.ok(!r.out.includes('sk-abc') && r.out.includes(REDACTED));
  const doc = JSON.parse((await cli('narrate', runPath, '--dry-run', '--json')).out);
  assert.equal(typeof doc.prompt, 'string');
  assert.ok(doc.moments > 0);
});

test('narrate writes glosses into the run and walkthrough shows them', async () => {
  const walk = JSON.parse((await cli('walkthrough', runPath, '--json')).out);
  const ids: string[] = walk.moments.map((m: any) => m.id);
  const answer = JSON.stringify({ ...Object.fromEntries(ids.map((i) => [i, `gloss for ${i}`])), m0: 'the program begins' });
  const promptCopy = join(dir, 'prompt.txt');
  const answerFile = join(dir, 'answer.json');
  writeFileSync(answerFile, 'Here it is:\n```json\n' + answer + '\n```\n');
  const model = fakeCli('model', `cat > "${promptCopy}"; cat "${answerFile}"`);
  const r = await cli('narrate', runPath, '--command', model);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `${ids.length} of ${ids.length} moments glossed by custom, written to ${runPath}\n\`${NAME} walkthrough run.json\` shows them\n`);
  const prompt = readFileSync(promptCopy, 'utf8');
  assert.ok(!prompt.includes('sk-abc') && prompt.includes(REDACTED) && prompt.includes('function add(a, b) {') && prompt.includes('"id": "m0"'));
  const meta = JSON.parse(readFileSync(runPath, 'utf8')).meta;
  assert.equal(meta.walkthroughGloss.m0, 'the program begins');
  assert.equal(Object.keys(meta.walkthroughGloss).length, ids.length);
  assert.ok(!existsSync(runPath + '.tmp'));
  const lines = (await cli('walkthrough', runPath)).out.split('\n');
  assert.equal(lines[1], '#0  module main.mjs starts');
  assert.equal(lines[2], '      the program begins');
  const doc = JSON.parse((await cli('walkthrough', runPath, '--json')).out);
  assert.equal(doc.moments[0].gloss, 'the program begins');
  assert.ok(doc.moments.every((m: any) => m.gloss));
  // a failed narration keeps the glosses untouched and reports once
  const nope = fakeCli('nope', 'cat > /dev/null; echo "nope"');
  const failed = await cli('narrate', runPath, '--command', nope);
  assert.equal(failed.code, 2);
  assert.match(failed.err, /^error: narration failed: the model did not answer with a JSON object/);
  assert.equal(JSON.parse(readFileSync(runPath, 'utf8')).meta.walkthroughGloss.m0, 'the program begins');
});

test('narrate errors say what to do', async () => {
  let r = await cli('narrate', runPath);
  assert.equal(r.code, 2);
  assert.ok(r.err.includes('no narration backend') && r.err.includes('--command'));
  r = await cli('narrate', runPath, '--command', 'definitely-missing-cli');
  assert.equal(r.code, 2);
  assert.ok(r.err.includes('narration failed: definitely-missing-cli is not on the PATH'));
});

test('the prompt file ships beside the module', () => {
  assert.ok(existsSync(PROMPT_FILE));
  assert.ok(promptTemplate().includes('{{walkthrough}}') && promptTemplate().includes('{{sources}}'));
});
