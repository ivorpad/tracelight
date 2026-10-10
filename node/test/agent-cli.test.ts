/** The agent verbs over runs saved by `tracelight run --save`, run in-process through the registry. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { project } from './helpers.ts';
import { NAME } from '../src/protocol.ts';
import { dispatchVerb, getVerb, registerVerb, verbNames, type Io } from '../src/agent/commands.ts';
import '../src/agent/verbs.ts';

const BIN = resolve(import.meta.dirname, '../bin/tracelight.mjs');

const LIB = `export class Account {
  owner: string;
  balance = 0;
  constructor(owner: string) {
    this.owner = owner;
  }
  deposit(amount: number): number {
    if (amount <= 0) {
      throw new Error(\`bad amount: \${amount}\`);
    }
    this.balance += amount;
    return this.balance;
  }
}
`;
const MAIN = `import { Account } from './lib.ts';

const acct = new Account('ann');
const amounts = [10, 20, 30];
for (const a of amounts) {
  acct.deposit(a);
}
let label = acct.balance > 50 ? 'rich' : 'poor';
console.log('label', label);
try {
  acct.deposit(-1);
} catch (e) {
  console.log('caught', (e as Error).message);
}
const token = 'sk-abcdefghijklmnopqrstuvwxyz012345';
console.log(token);
throw new TypeError('the end');
`;

let dir = '';
let saved = '';
let kept = '';

function save(main: string, out: string, ...extra: string[]): void {
  // the run's own exit code is the program's (main.ts throws at the end)
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', BIN, 'run', join(dir, main), '--save', join(dir, out), ...extra], { stdio: 'pipe', cwd: dir, encoding: 'utf8' });
  assert.match(r.stderr, /^saved /m, r.stderr);
}

before(() => {
  dir = project({ 'main.ts': MAIN, 'lib.ts': LIB, 'stale.mjs': 'const x = 1;\nconsole.log(x);\n', 'k.mjs': 'const big = { a: { b: { c: { d: 1 } } } };\nconsole.log(big);\n' });
  saved = join(dir, 'main.json');
  kept = join(dir, 'k.json');
  save('main.ts', 'main.json');
  save('stale.mjs', 'stale.json');
  save('k.mjs', 'k.json', '--keep');
});

after(async () => {
  if (kept) await cli('release', kept);
});

interface Out {
  code: number;
  out: string;
  err: string;
}

async function cli(...argv: string[]): Promise<Out> {
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

test('every verb registers itself', () => {
  assert.deepEqual(verbNames().slice(0, 12), ['story', 'steps', 'step', 'context', 'values', 'find', 'var', 'eval', 'expand', 'release', 'state', 'watch']);
  for (const v of ['walkthrough', 'why', 'exceptions', 'http', 'coverage', 'graph']) assert.ok(verbNames().includes(v), v);
  assert.throws(() => registerVerb({ name: 'story', help: 'again' }), /story/);
});

test('state summarises the run', async () => {
  const r = await cli('state', saved);
  assert.equal(r.code, 0);
  assert.match(r.out, /main\.ts: \d+ steps, exit 1/);
});

test('story lists blocks with their steps, and filters by scope with a limit', async () => {
  const all = await cli('story', saved);
  assert.match(all.out, /^\d+ steps, \d+ blocks\n/);
  assert.match(all.out, /## constructor {2}lib\.ts:4/);
  assert.match(all.out, /let label = acct\.balance > 50 \? 'rich' : 'poor';\s+#\d+/);
  const one = await cli('story', saved, '--scope', 'deposit', '--limit', '1');
  assert.match(one.out, /4 matching \(showing 1\)/);
  assert.match(one.out, /## deposit {2}lib\.ts:7/);
  assert.match(one.out, /… 3 more blocks; narrow with --file F, --scope NAME or --line F:L, or raise --limit/);
  const shape = await json('story', saved, '--file', 'lib.ts');
  assert.ok(shape.blocks.every((b: any) => b.file.endsWith('lib.ts')));
});

test('steps pages through the trace', async () => {
  const r = await cli('steps', saved, '--count', '3');
  assert.match(r.out, /^steps 0\.\. of \d+\n#0 +lib\.ts:1 {2}<module>/);
  assert.match(r.out, /next: --from 3\n$/);
  const page = await json('steps', saved, '--from', '2', '--count', '2');
  assert.deepEqual([page.from, page.next, page.steps.length], [2, 4, 2]);
});

test('step moves into, over, out and back, and --to', async () => {
  const into = await json('step', saved, '1', '--into');
  assert.equal(into.location.function, 'constructor');
  assert.equal(into.from, 1);
  const out = await json('step', saved, String(into.step), '--out');
  assert.equal(out.location.function, '<module>');
  const back = await json('step', saved, String(into.step), '--back');
  assert.equal(back.step, into.step - 1);
  const to = await cli('step', saved, '0', '--to', '10');
  assert.match(to.out, /^from step 0\nstep 10\/\d+ {2}/);
  assert.match(to.out, /moves: into .* · back-out /);
});

test('step argument errors read as argparse writes them', async () => {
  const both = await cli('step', saved, '3', '--into', '--over');
  assert.equal(both.code, 2);
  assert.match(both.err, new RegExp(`^usage: ${NAME} step \\[-h\\]`));
  assert.match(both.err, new RegExp(`${NAME} step: error: argument --over: not allowed with argument --into\\n$`));
  const none = await cli('step', saved, '3');
  assert.match(none.err, /error: one of the arguments --into --over --out --back --back-over --back-out --to is required/);
  const bad = await cli('steps', saved, '--count', 'x');
  assert.match(bad.err, /error: argument --count: invalid int value: 'x'/);
  const unknown = await cli('story', saved, '--bogus');
  assert.match(unknown.err, new RegExp(`^usage: ${NAME} \\[-h\\]\\n.*\\{serve,run,.*story,steps.*\\} \\.\\.\\.\\n${NAME}: error: unrecognized arguments: --bogus\\n$`, 's'));
  const help = await cli('step', '--help');
  assert.equal(help.code, 0);
  assert.match(help.out, /positional arguments:\n {2}RUN /);
});

test('a step past the run is an error with a hint, as text and as JSON', async () => {
  const text = await cli('step', saved, '9999', '--into');
  assert.equal(text.code, 2);
  assert.match(text.err, /^error: step 9999 is past the recorded \d+ steps \(0\.\.\d+\)\nuse `steps` or `find` to pick one\n$/);
  const shape = await cli('step', saved, '9999', '--into', '--json');
  assert.equal(shape.code, 2);
  assert.deepEqual(Object.keys(JSON.parse(shape.out)), ['ok', 'error', 'hint']);
  const none = await cli('var', saved);
  assert.match(none.err, new RegExp(`save one with \`${NAME} run FILE --save run.json\``));
});

test('context at the uncaught error shows the block, the error and the moves', async () => {
  const count = (await json('state', saved)).count ?? (await json('steps', saved, '--count', '1')).count;
  const r = await cli('context', saved, String(count - 1));
  assert.match(r.out, /\[error\]/);
  assert.match(r.out, />\d+ {2}throw new TypeError\('the end'\);/);
  assert.match(r.out, /errors:\n {2}#\d+ main\.ts:17 TypeError: the end/);
  assert.match(r.out, /moves: into — · over — · out — · back \d+/);
});

test('values and find redact secrets', async () => {
  const values = await cli('values', saved, '--line', 'main.ts:16');
  // a saved run records locals, so the change of `token` is listed beside the logged value
  assert.match(values.out, /2 values on main\.ts:16\n {2}#\d+ {2}token = '«redacted»'\n {2}#\d+ hit 1 {2}«redacted»/);
  assert.doesNotMatch(values.out, /sk-abc/);
  const found = await cli('find', saved, 'sk-');
  assert.match(found.out, /hits for 'sk-'/);
  assert.match(found.out, /const token = '«redacted»';/);
  assert.doesNotMatch(found.out, /sk-abc/);
});

test('values on an assignment with nothing logged names the variable for var', async () => {
  const r = await cli('values', saved, '--line', 'main.ts:8');
  assert.match(r.out, /^0 values on main\.ts:8\nno value was logged there; `var label` lists every change of it/);
});

test('var lists the JavaScript assignments of a name, parameters included', async () => {
  const label = await cli('var', saved, 'label');
  assert.match(label.out, /^1 change of label\n {2}#\d+ main\.ts:8 {2}<module> {2}label = 'rich' /);
  const amount = await json('var', saved, 'amount');
  assert.ok(amount.changes.length >= 4, JSON.stringify(amount));
  assert.ok(amount.changes.every((c: any) => c.file.endsWith('lib.ts')));
});

test('a file changed since the run is reported stale', async () => {
  appendFileSync(join(dir, 'stale.mjs'), '// edited\n');
  const r = await cli('story', join(dir, 'stale.json'));
  assert.match(r.out, /^stale: .*stale\.mjs changed since the run\n/);
  const shape = await json('story', join(dir, 'stale.json'));
  assert.equal(shape.stale, true);
});

test('a kept run expands values and evaluates; release shuts it down', async () => {
  const run = JSON.parse(readFileSync(kept, 'utf8'));
  const log = run.events.find((e: any) => e.type === 'log');
  const expanded = await cli('expand', kept, log.valueBag.data.id);
  assert.equal(expanded.code, 0, expanded.err);
  assert.match(expanded.out, /^dict \{ a: \{ b: \{ c: \[Object\] \} \} \}\n {2}a: /);
  const ev = await cli('eval', kept, 'big.a');
  assert.equal(ev.code, 0, ev.err);
  assert.equal(ev.out, 'big.a = { b: { c: { d: 1 } } }\n');
  const plain = await cli('expand', saved, '1');
  assert.match(plain.err, /this run was saved without --keep, so its values are gone/);
  const released = await cli('release', kept);
  assert.match(released.out, /^released the kept runner \(pid \d+\)\n$/);
  // the keeper removes its socket as it exits, a moment after the shutdown request
  let again = '';
  for (let i = 0; i < 40 && !/already gone/.test(again); i++) {
    await new Promise((r) => setTimeout(r, 50));
    again = (await cli('release', kept)).out;
  }
  assert.match(again, /was already gone/);
  kept = '';
});

test('watch refuses a saved run', async () => {
  const r = await cli('watch', saved);
  assert.equal(r.code, 2);
  assert.match(r.err, /watch follows the user's stepping in VS Code, so it needs --live/);
});

test('a verb added through the registry is dispatched like the rest', async () => {
  registerVerb({
    name: 'test-count',
    help: 'count the steps',
    configure: (p) => p.addArgument('--times', { type: 'int', default: 1 }),
    run: (source, args) => ({ n: (source.steps({ start: 0, count: 1 }) as any).count * args.times }),
    render: (result) => [`n=${result.n}`],
  });
  assert.ok(getVerb('test-count'));
  const r = await cli('test-count', saved, '--times', '2');
  assert.match(r.out, /^n=\d+\n$/);
});
