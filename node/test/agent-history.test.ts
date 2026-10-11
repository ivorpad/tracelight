/**
 * `history`: the data behind a code-history page, over a saved JavaScript run (the JS cases of
 * Pyokka's tests/test_agent_history.py). The first test is the one the page rests on: every value
 * on a card is what `context RUN N --json` prints for that step, rebuilt here by hand.
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { project } from './helpers.ts';
import { NAME } from '../src/protocol.ts';
import { dispatchVerb, type Io } from '../src/agent/commands.ts';
import { armText, flattenChain, sourceWindow } from '../src/agent/checkpoint.ts';
import { REDACTED } from '../src/agent/redact.ts';
import '../src/agent/verbs.ts';

const BIN = resolve(import.meta.dirname, '../bin/tracelight.mjs');

const PROGRAM = `function scale(value, factor = 3) {
  const scaled = value * factor;
  return scaled;
}

function totalOf(rows) {
  let total = 0;
  for (const row of rows) {
    if (row < 0) {
      continue;
    }
    total += scale(row);
  }
  return total;
}

const apiKey = "sk-abcdefghijklmnopqrstuvwxyz012345";
const rows = [1, -2, 4];
const answer = totalOf(rows);
console.log("answer", answer);
`;

let dir = '';
let saved = '';

function save(main: string, out: string, ...extra: string[]): void {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', BIN, 'run', join(dir, main), '--save', join(dir, out), ...extra], { stdio: 'pipe', cwd: dir, encoding: 'utf8' });
  assert.match(r.stderr + r.stdout, /saved /, r.stderr);
}

before(() => {
  dir = project({ 'main.mjs': PROGRAM, 'long.mjs': 'const prompt = "x".repeat(500);\nconsole.log(prompt.length);\n' });
  saved = join(dir, 'run.json');
  save('main.mjs', 'run.json');
});

async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const io: Io = { out: (t) => void (out += t), err: (t) => void (err += t) };
  const code = await dispatchVerb(argv[0]!, argv.slice(1), io);
  return { code, out, err };
}

async function json(...argv: string[]): Promise<Record<string, any>> {
  const r = await cli(...argv, '--json');
  assert.equal(r.code, 0, r.err || r.out);
  return JSON.parse(r.out);
}

let n = 0;
async function history(run: string, ...args: string[]): Promise<Record<string, any>> {
  const target = join(dir, `history-${n++}.json`);
  const r = await cli('history', run, ...args, '--out', target);
  assert.equal(r.code, 0, r.err || r.out);
  return JSON.parse(readFileSync(target, 'utf8'));
}

/** the card's `values`, rebuilt from `context --json` without the generator's help */
function expectedValues(slice: Record<string, any>, step: number): string {
  return slice.values
    .map((v: any) => {
      let text = String(v.text).split('\n').join(' ').trim();
      if (text.length > 200) text = text.slice(0, 199) + '…';
      let line = v.context ? `${v.context} = ${text}` : text;
      if (Number.isInteger(v.step) && v.step !== step) line += `   #${v.step}`;
      return line;
    })
    .join('\n');
}

test('every value matches context', async () => {
  const data = await history(saved, '--at', '4', '--at', '8', '--at', '17', '--at', '22');
  assert.deepEqual(data.steps.map((c: any) => c.step), [4, 8, 17, 22]);
  for (const card of data.steps) {
    const slice = await json('context', saved, String(card.step));
    assert.equal(card.values, expectedValues(slice, card.step), card.id);
    assert.equal(card.focus, slice.location.line);
    assert.equal(card.stack.length, slice.stack.length);
    assert.ok(card.stack[0].startsWith(slice.stack[0].function));
    assert.equal(card.verify, `${NAME} context ${saved} ${card.step} --json`);
  }
});

test('--at FILE:LINE resolves to the first step on the line', async () => {
  const card = (await history(saved, '--at', 'main.mjs:9')).steps[0];
  assert.equal(card.focus, 9);
  assert.equal(card.step, (await json('context', saved, '--line', 'main.mjs:9')).step);
});

test('--var expands in step order and matches var --json', async () => {
  const result = await json('var', saved, 'total');
  const data = await history(saved, '--var', 'total');
  assert.deepEqual(data.steps.map((c: any) => c.step), [4, 8, 17]);
  assert.deepEqual(result.changes.map((c: any) => c.step), [4, 8, 17]);
  assert.deepEqual(data.steps.map((c: any) => c.id), ['var-total-1', 'var-total-2', 'var-total-3']);
  assert.deepEqual(data.steps.map((c: any) => c.tag), ['CHANGE 1 OF 3', 'CHANGE 2 OF 3', 'CHANGE 3 OF 3']);
  data.steps.forEach((card: any, i: number) => {
    const change = result.changes[i];
    assert.equal(card.values, `total = ${change.text}`);
    assert.deepEqual(card.reads.map((r: string) => r.split(' = ')[0]), (change.reads ?? []).map((r: any) => r.name));
    assert.equal(card.verify, `${NAME} var ${saved} total --json`);
  });
  assert.equal(data.steps[2].values, 'total = 15');
  assert.ok(data.steps[2].reads[0].includes('total = 3'));
});

test('--why flattens the provenance tree', async () => {
  const result = await json('why', saved, '22', 'answer');
  const card = (await history(saved, '--why', '22', 'answer')).steps[0];
  assert.equal(card.id, 'why-22-answer');
  assert.equal(card.step, result.root.step);
  assert.deepEqual(card.chain, flattenChain(result.root));
  assert.deepEqual([card.chain[0].depth, card.chain[0].via, card.chain[0].name], [0, 'root', 'answer']);
  assert.ok(card.chain.slice(1).length && card.chain.slice(1).every((c: any) => c.depth >= 1));
  assert.ok(card.chain.some((c: any) => c.via === 'reads' && c.name === 'rows'));
  assert.ok(card.chain.some((c: any) => c.via === 'calls' && c.name === 'totalOf'));
  assert.equal(card.verify, `${NAME} why ${saved} 22 answer --json`);
});

test('--why wants a step number, the way argparse refuses it', async () => {
  const r = await cli('history', saved, '--why', 'x', 'y', '--out', join(dir, 'h.json'));
  assert.equal(r.code, 2);
  assert.match(r.err, /^usage: .*history/);
  assert.match(r.err, /error: argument --why: wants STEP NAME, e.g. `--why 124 fused_ranking`\n$/);
  const short = await cli('history', saved, '--why', '3');
  assert.match(short.err, /error: argument --why: expected 2 arguments\n$/);
  const help = await cli('history', '-h');
  assert.match(help.out, /\[--at STEP\|FILE:LINE\] \[--var NAME\] \[--why STEP NAME\]/);
  assert.match(help.out, /\n {2}--why STEP NAME {6}a checkpoint for the provenance chain/);
});

test('the source keeps its original line numbers, and only the lines the page shows', async () => {
  const data = await history(saved, '--at', '8');
  const lines = PROGRAM.split('\n');
  const card = data.steps[0];
  const rows = data.files['main.mjs'];
  assert.equal(rows[card.focus - 1], '    total += scale(row);');
  for (let i = card.start; i <= card.end; i++) assert.equal(rows[i - 1], lines[i - 1], String(i));
  assert.ok(1 <= card.start && card.start <= card.focus && card.focus <= card.end && card.end <= lines.length);
  assert.ok(card.bright.length && card.bright.every((b: number) => card.start <= b && b <= card.end));
  assert.equal(rows[0], '');
  assert.equal(rows.length, card.end);
});

test('sourceWindow and armText', () => {
  const block = [1, 5, 40, 90, 120].map((line) => ({ line }));
  const [start, end, bright] = sourceWindow(block, 90, 2, 200, 40);
  assert.ok(end - start + 1 === 40 && start <= 90 && 90 <= end);
  assert.deepEqual(bright, [90]);
  assert.deepEqual(sourceWindow(block, 90, 2, 200, 0), [1, 122, [1, 5, 40, 90, 120]]);
  assert.deepEqual(sourceWindow([], 7, 3, 50), [4, 10, []]);
  assert.equal(armText(['if x took true']), 'if x took true');
  assert.equal(armText(['for r ran 4 times', 'for r ran 4 times']), 'for r ran 4 times, entered 2 times');
  assert.equal(armText(['if x took false', 'if x took true', 'if x took false']), 'if x took false x2, true x1');
});

test('the call, the hits and the arm come from the run', async () => {
  const [callCard, branchCard] = (await history(saved, '--at', '8', '--at', 'main.mjs:9')).steps;
  assert.deepEqual(callCard.call, { name: 'scale', in: ['value = 1', 'factor = 3'], out: 'return = 3' });
  assert.equal(callCard.hits, 2);
  assert.equal(branchCard.arm, 'if (row < 0) took false x2, true x1');
  assert.equal(branchCard.hits, 3);
  assert.equal(branchCard.call, null);
});

test('meta says which run and which source', async () => {
  const meta = (await history(saved, '--at', '8')).meta;
  const run = JSON.parse(readFileSync(saved, 'utf8'));
  assert.deepEqual([meta.mode, meta.run, meta.file], ['saved run', saved, 'main.mjs']);
  assert.ok(run.meta.files[0].sha256.startsWith(meta.sourceSha256) && meta.sourceSha256.length === 14);
  assert.equal(meta.runSha256.length, 14);
  assert.equal(meta.stepCount, 23);
  assert.equal(meta.exitCode, 0);
  assert.equal(meta.python, run.meta.python);
  assert.deepEqual(meta.truncated, []);
});

test('the page data has the shape and key order of Pyokka\'s', async () => {
  const data = await history(saved, '--at', '8');
  assert.deepEqual(Object.keys(data), ['lang', 'labels', 'title', 'eyebrow', 'heading', 'subtitle', 'summary', 'historyLabel', 'scope', 'footer', 'reportHref', 'reportLabel', 'meta', 'files', 'steps']);
  assert.deepEqual(Object.keys(data.steps[0]), ['id', 'kind', 'tag', 'step', 'title', 'text', 'note', 'file', 'start', 'end', 'focus', 'bright', 'values', 'reads', 'stack', 'output', 'call', 'hits', 'arm', 'reason', 'chain', 'exception', 'http', 'gloss', 'modified', 'verify', 'evidence']);
  assert.equal(data.lang, 'en');
  assert.equal((await history(saved, '--at', '8', '--lang', 'es')).lang, 'es');
  assert.deepEqual([data.heading, data.summary, data.labels], ['', '', {}]);
  assert.deepEqual([data.steps[0].title, data.steps[0].text, data.steps[0].note], ['', '', '']);
});

test('prose fills prose, evidence takes links, and nothing generated', async () => {
  const prose = join(dir, 'prose.json');
  writeFileSync(prose, JSON.stringify({ heading: 'scale runs twice', steps: { 'step-8': { title: 'First pass', note: 'n', evidence: ['notes/run.txt', 'https://example.com/issue/1'] } } }));
  const data = await history(saved, '--at', '8', '--prose', prose);
  const card = data.steps[0];
  assert.deepEqual([data.heading, card.title, card.note], ['scale runs twice', 'First pass', 'n']);
  assert.deepEqual(card.evidence, ['notes/run.txt', 'https://example.com/issue/1']);
  assert.ok(card.values && card.verify);
  const r = await cli('history', saved, '--at', '8', '--prose', prose, '--out', join(dir, 'p.json'));
  assert.match(r.out, /: 1 checkpoints over main\.mjs, 1 with prose\n/);
  const bad = join(dir, 'bad.json');
  for (const [doc, message] of [
    [{ steps: { 'step-8': { values: 'total = 999' } } }, 'prose may not set "values" on step-8'],
    [{ steps: { 'step-8': { step: 3 } } }, 'prose may not set "step" on step-8'],
    [{ meta: {} }, 'prose may not set "meta"'],
    [{ steps: { 'step-99': { title: 'x' } } }, 'no checkpoint step-99 in this page'],
    [{ steps: { 'step-8': { evidence: 'notes/run.txt' } } }, 'prose "evidence" on step-8 must be a list of links'],
    [{ steps: { 'step-8': { evidence: ['javascript:alert(1)'] } } }, 'prose "evidence" on step-8 must be a list of links'],
  ] as const) {
    writeFileSync(bad, JSON.stringify(doc));
    const res = await cli('history', saved, '--at', '8', '--out', join(dir, 'h.json'), '--prose', bad, '--json');
    assert.equal(res.code, 2);
    assert.ok(JSON.parse(res.out).error.includes(message), res.out);
  }
});

test('card values follow the run\'s value limit, and --value-chars', async () => {
  save('long.mjs', 'long.json', '--max-value-chars', '0');
  const whole = (await history(join(dir, 'long.json'), '--var', 'prompt')).steps[0];
  assert.equal(whole.values, `prompt = '${'x'.repeat(500)}'`);
  const cut = (await history(join(dir, 'long.json'), '--var', 'prompt', '--value-chars', '60')).steps[0];
  assert.ok(cut.values.startsWith("prompt = 'xxx") && cut.values.endsWith('chars)') && cut.values.length < 90, cut.values);
});

test('limits are reported, order follows the command line, ids stay unique', async () => {
  const limited = await history(saved, '--var', 'total', '--limit', '2');
  assert.equal(limited.steps.length, 2);
  assert.deepEqual(limited.meta.truncated, ['--var total: 2 of 3 changes']);
  const r = await cli('history', saved, '--var', 'total', '--limit', '2', '--out', join(dir, 'l.json'));
  assert.match(r.out, /^left out: --var total: 2 of 3 changes \(--limit raises it\)\n/);
  const ordered = await history(saved, '--why', '22', 'answer', '--at', '4', '--var', 'total');
  assert.deepEqual(ordered.steps.map((c: any) => c.id), ['why-22-answer', 'step-4', 'var-total-1', 'var-total-2', 'var-total-3']);
  assert.deepEqual((await history(saved, '--at', '8', '--at', '8')).steps.map((c: any) => c.id), ['step-8', 'step-8-2']);
  const all = await history(saved, '--at', '8', '--var', 'total', '--why', '22', 'answer');
  assert.ok(all.steps.every((c: any) => c.kind === 'recorded step' && c.verify.startsWith(`${NAME} `) && c.output === '' && c.modified === false));
});

test('secrets never reach the page', async () => {
  const target = join(dir, 'secret.json');
  const r = await cli('history', saved, '--at', '0', '--out', target);
  assert.equal(r.code, 0);
  const raw = readFileSync(target, 'utf8');
  assert.ok(!raw.includes('sk-abcdefghijklmnopqrstuvwxyz012345'));
  assert.ok(JSON.parse(raw).files['main.mjs'][16].includes(REDACTED));
  assert.match(r.out, /^warning: main\.mjs:17 held a secret and was redacted in the page's source\n/);
  assert.match(r.out, new RegExp(`wrote ${target}: 1 checkpoints over main\\.mjs\\nfill the prose, then render: node skills/tracelight/scripts/render-code-history\\.cjs ${target} ${target.replace(/\.json$/, '')}\\.html\\n$`));
});

test('errors: no checkpoints, no pause, a page that is not one', async () => {
  const none = await cli('history', saved, '--out', join(dir, 'h.json'), '--json');
  assert.equal(none.code, 2);
  assert.match(JSON.parse(none.out).error, /no checkpoints/);
  const pause = await cli('history', saved, '--pause', '--out', join(dir, 'h.json'), '--json');
  assert.equal(pause.code, 2);
  const notPage = join(dir, 'notapage.json');
  writeFileSync(notPage, '{"hello": 1}');
  const r = await cli('history', saved, '--at', '8', '--out', notPage, '--append', '--json');
  assert.equal(r.code, 2);
  assert.match(JSON.parse(r.out).error, /is not a code-history page/);
});

test('--append adds to an existing page and keeps ids unique', async () => {
  const target = join(dir, 'page.json');
  assert.equal((await cli('history', saved, '--at', '4', '--out', target)).code, 0);
  const r = await cli('history', saved, '--at', '8', '--at', '4', '--out', target, '--append');
  assert.equal(r.code, 0);
  assert.match(r.out, /added 2 to /);
  const data = JSON.parse(readFileSync(target, 'utf8'));
  assert.deepEqual(data.steps.map((c: any) => c.id), ['step-4', 'step-8', 'step-4-2']);
  assert.equal(data.steps[0].values, data.steps[2].values);
  assert.ok(data.files['main.mjs'][11] && data.files['main.mjs'][6]);
});

test('a stale run is refused (last: it edits the program)', async () => {
  appendFileSync(join(dir, 'main.mjs'), '\n// edited\n');
  const r = await cli('history', saved, '--at', '8', '--out', join(dir, 'h.json'), '--json');
  const doc = JSON.parse(r.out);
  assert.equal(r.code, 2);
  assert.ok(doc.error.includes('stale: main.mjs changed since the run'));
  assert.ok(doc.hint.includes('record again'));
});
