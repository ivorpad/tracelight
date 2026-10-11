/**
 * `diff`: two runs of a file before and after an edit, compared statement by statement.
 *
 * The edit below changes a value (`qty * unit` gets `+ 50`), which flips a branch (`total > LIMIT`
 * takes true for the first order), adds a function and a call to it, and that call throws a new
 * error. The added function shifts every later line by 6, so the module's statements pair by text,
 * not by line number. The file is recorded, rewritten and recorded again in place, the way an edit
 * happens, so the first run has to be read from the copy it keeps.
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { project } from './helpers.ts';
import { dispatchVerb, type Io } from '../src/agent/commands.ts';
import { editedLines } from '../src/agent/diff.ts';
import { compareHits, opcodes, pairStatements, parseStatements } from '../src/agent/diff_match.ts';
import { REDACTED } from '../src/agent/redact.ts';
import '../src/agent/verbs.ts';

const BIN = resolve(import.meta.dirname, '../bin/tracelight.mjs');

const BEFORE = `const LIMIT = 100;

function price(qty, unit) {
  let total = qty * unit;
  if (total > LIMIT) {
    total = total * 0.9;
  }
  return total;
}

function check(order) {
  return order.qty > 0;
}

const orders = [{ qty: 3, unit: 20 }, { qty: 1, unit: 50 }];
const totals = [];
for (const o of orders) {
  if (check(o)) {
    totals.push(price(o.qty, o.unit));
  }
}
console.log(totals[0] + totals[1]);
`;

const AFTER = `const LIMIT = 100;

function price(qty, unit) {
  let total = qty * unit + 50;
  if (total > LIMIT) {
    total = total * 0.9;
  }
  return total;
}

function check(order) {
  return order.qty > 0;
}

function audit(totals) {
  if (totals.length > 1) {
    throw new RangeError(\`audit failed: \${totals.length} orders\`);
  }
}

const orders = [{ qty: 3, unit: 20 }, { qty: 1, unit: 50 }];
const totals = [];
for (const o of orders) {
  if (check(o)) {
    totals.push(price(o.qty, o.unit));
  }
}
console.log(totals[0] + totals[1]);
audit(totals);
`;

let dir = '';
let beforeRun = '';
let afterRun = '';

function record(prog: string, text: string, out: string, ...extra: string[]): string {
  writeFileSync(prog, text);
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', BIN, 'run', prog, '--save', out, ...extra], { stdio: 'pipe', cwd: dir, encoding: 'utf8' });
  assert.match(r.stderr, /^saved /m, r.stderr);
  return out;
}

before(() => {
  dir = project({ 'proj/.keep': '' });
  const prog = join(dir, 'proj', 'shop.mjs');
  beforeRun = record(prog, BEFORE, join(dir, 'before.json'));
  afterRun = record(prog, AFTER, join(dir, 'after.json'));
});

async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const io: Io = { out: (t) => void (out += t), err: (t) => void (err += t) };
  const code = await dispatchVerb(argv[0]!, argv.slice(1), io);
  return { code, out, err };
}

async function diffJson(...args: string[]): Promise<Record<string, any>> {
  const r = await cli('diff', ...args, '--json');
  assert.equal(r.code, 0, r.err || r.out);
  return JSON.parse(r.out);
}

function byText(doc: Record<string, any>, text: string): Record<string, any> {
  const e = doc.statements.find((e: any) => (e.textB || e.textA).startsWith(text));
  assert.ok(e, `no statement ${text}`);
  return e;
}

test('a run keeps the source that ran', () => {
  const files = JSON.parse(readFileSync(beforeRun, 'utf8')).meta.files;
  assert.ok(files[0].source.includes('let total = qty * unit;\n')); // the file on disk now says `+ 50`
});

test('diff reports the value, the branch, the call and the exception', async () => {
  const doc = await diffJson(beforeRun, afterRun);
  assert.deepEqual(doc.matching, { same: 13, edited: 1, added: 4, removed: 0 });
  assert.deepEqual([doc.a.exitCode, doc.b.exitCode], [0, 1]);

  const edited = byText(doc, 'let total = qty * unit + 50');
  assert.deepEqual([edited.status, edited.textA, edited.lineA, edited.lineB], ['edited', 'let total = qty * unit;', 4, 4]);
  assert.deepEqual(
    edited.facts.map((f: any) => [f.name, f.a.text, f.b.text]),
    [
      ['total', '60', '110'],
      ['total', '50', '100'],
    ],
  );
  assert.deepEqual(doc.firstDifference, { file: 'shop.mjs', lineA: 4, lineB: 4, stepA: edited.facts[0].a.step, stepB: edited.facts[0].b.step });

  const branch = byText(doc, 'if (total > LIMIT)');
  assert.equal(branch.status, 'same');
  assert.deepEqual(
    branch.facts.map((f: any) => [f.kind, f.a.text, f.b.text]),
    [['branch', 'false', 'true']],
  );

  const discount = byText(doc, 'total = total * 0.9');
  assert.deepEqual(
    discount.facts.map((f: any) => [f.name, f.a, f.b.text]),
    [['total', null, '99']],
  );

  const printed = byText(doc, 'console.log(totals[0] + totals[1])');
  assert.deepEqual([printed.lineA, printed.lineB], [22, 28]); // moved by the added function, paired by its text
  assert.ok(printed.facts.some((f: any) => f.kind === 'print' && f.a?.text === '110' && f.b?.text === '199'));

  const call = byText(doc, 'audit(totals)');
  assert.equal(call.status, 'added');
  assert.equal(call.facts.length, 1);
  const [fact] = call.facts;
  assert.equal(fact.kind, 'call');
  assert.equal(fact.a, null);
  assert.match(fact.b.text, /^audit\(totals=\[ ?99, 100 ?\]\) raised RangeError: audit failed: 2 orders$/);

  const raised = byText(doc, 'throw new RangeError');
  assert.equal(raised.status, 'added');
  assert.equal(raised.function, 'audit');
  assert.equal(raised.facts[0].kind, 'error');
  assert.ok(raised.facts[0].b.text.startsWith('RangeError: audit failed: 2 orders'));

  // every step a fact names is a step of that side's run
  for (const e of doc.statements) {
    for (const f of e.facts) {
      assert.ok(f.a === null || (f.a.step >= 0 && f.a.step < doc.a.count));
      assert.ok(f.b === null || (f.b.step >= 0 && f.b.step < doc.b.count));
    }
  }
});

test('the diff text is one fact per line with both steps', async () => {
  const r = await cli('diff', beforeRun, afterRun);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split('\n');
  assert.ok(lines[0]!.startsWith(`a  ${beforeRun}  shop.mjs  `) && lines[0]!.endsWith('exit 0'), lines[0]!);
  assert.ok(lines[1]!.startsWith(`b  ${afterRun}  shop.mjs  `) && lines[1]!.endsWith('exit 1'), lines[1]!);
  assert.equal(lines[2], 'statements: 13 same, 1 edited, 4 added, 0 removed (matched by file, function and text)');
  assert.ok(lines.includes('exit code 0 → 1'));
  assert.ok(lines.includes('shop.mjs:4  price  edited'));
  assert.ok(lines.includes('  - let total = qty * unit;') && lines.includes('  + let total = qty * unit + 50;'));
  assert.ok(lines.some((l) => l.startsWith('  total = 60 → 110   a#') && l.includes(' b#')));
  assert.ok(lines.some((l) => l.startsWith('shop.mjs:5  price  if (total > LIMIT) {')));
  assert.ok(lines.some((l) => l.startsWith('  took false → true   a#')));
  assert.ok(lines.some((l) => l.startsWith('shop.mjs:22→28  <module>  console.log(totals[0] + totals[1]);')));
  assert.ok(lines.some((l) => l.startsWith('shop.mjs:29  <module>  audit(totals);  added')));
  assert.ok(lines.some((l) => /^ {2}call audit\(totals=\[ ?99, 100 ?\]\) raised RangeError: audit failed: 2 orders {3}only in b {3}b#/.test(l)));
  assert.ok(lines.some((l) => l.startsWith('shop.mjs:17  audit  throw new RangeError(') && l.endsWith('added')));
});

test('step numbers are the ones step takes', async () => {
  const doc = await diffJson(beforeRun, afterRun);
  const fact = byText(doc, 'let total = qty * unit + 50').facts[0];
  for (const [run, side] of [
    [beforeRun, 'a'],
    [afterRun, 'b'],
  ] as const) {
    const r = await cli('context', run, String(fact[side].step), '--json');
    const ctx = JSON.parse(r.out);
    assert.equal(ctx.location.line, 4);
  }
});

test('identical runs have no difference', async () => {
  const prog = join(dir, 'same.mjs');
  const a = record(prog, BEFORE, join(dir, 'same-a.json'));
  const b = record(prog, BEFORE, join(dir, 'same-b.json'));
  const r = await cli('diff', a, b);
  assert.equal(r.code, 0);
  assert.equal(r.out.trimEnd().split('\n').at(-1), 'no difference in values, branches, loops, calls, prints or raises');
});

test('a run without its source says so', async () => {
  const old = join(dir, 'old.json');
  const doc = JSON.parse(readFileSync(beforeRun, 'utf8'));
  for (const f of doc.meta.files) delete f.source; // what an older run looks like
  writeFileSync(old, JSON.stringify(doc));
  const r = await cli('diff', old, afterRun);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes('note: a: shop.mjs changed since this run and the run keeps no copy of it'), r.out);
});

test('diff needs two runs; --live takes one', async () => {
  let r = await cli('diff', beforeRun, '--json');
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.out).error, 'diff needs two runs, got 1');
  r = await cli('diff', beforeRun, afterRun, '--live', '--json');
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.out).error, 'diff --live takes one saved run, the before; the live session is the after');
});

test('a run saved without locals compares what both sides have', async () => {
  const prog = join(dir, 'proj', 'shop.mjs');
  const noLocals = record(prog, AFTER, join(dir, 'after-nolocals.json'), '--no-locals');
  const doc = await diffJson(beforeRun, noLocals);
  assert.deepEqual(doc.notes, ['b recorded no locals (it was saved with --no-locals), so assigned values and call arguments are left out; record both with locals to compare them']);
  const facts = doc.statements.flatMap((e: any) => e.facts);
  assert.ok(facts.every((f: any) => f.kind !== 'value'));
  const branch = byText(doc, 'if (total > LIMIT)');
  assert.deepEqual(
    branch.facts.map((f: any) => [f.a.text, f.b.text]),
    [['false', 'true']],
  );
  assert.equal(byText(doc, 'audit(totals)').facts[0].b.text, 'audit(…) raised RangeError: audit failed: 2 orders');
});

test('pairing survives a line shift and pairs an edit by position', () => {
  const a = parseStatements('const x = 1;\nconst y = x + 1;\nconsole.log(y);\n');
  const b = parseStatements('// new comment\n\nconst x = 1;\nconst y = x + 2;\nconst z = 3;\nconsole.log( y );\n');
  const pairs = pairStatements(a, b)[0].map(([sa, sb, status]) => [sa ? sa.line : null, sb ? sb.line : null, status]);
  assert.deepEqual(pairs, [
    [1, 3, 'same'],
    [2, 4, 'edited'],
    [null, 5, 'added'],
    [3, 6, 'same'],
  ]);
});

test('statements carry their function, and headers drop their bodies', () => {
  const src = `class Account {
  deposit(amount) {
    if (amount <= 0) {
      throw new Error('bad');
    }
    this.balance += amount;
  }
}
const run = (xs) => {
  for (const x of xs) {
    xs.forEach((y) => {
      console.log(y);
    });
  }
};
export default function main() {
  return run([1]);
}
`;
  const stmts = parseStatements(src, 'acct.mjs').map((s) => [s.line, s.function, s.kind]);
  assert.deepEqual(stmts, [
    [1, '<module>', 'def'],
    [2, 'Account', 'def'],
    [3, 'Account.deposit', 'header'],
    [4, 'Account.deposit', 'stmt'],
    [6, 'Account.deposit', 'stmt'],
    [9, '<module>', 'def'],
    [10, 'run', 'header'],
    [11, 'run', 'header'],
    [12, 'run.<arrow>', 'stmt'],
    [16, '<module>', 'def'],
    [17, 'main', 'stmt'],
  ]);
  // an edit inside a body leaves the header the same; quotes and parentheses do not count
  const edited = parseStatements(src.replace("'bad'", '"worse"').replace('amount <= 0', '(amount <= 0)'), 'acct.mjs');
  const [pairs] = pairStatements(parseStatements(src, 'acct.mjs'), edited);
  assert.deepEqual(
    pairs.filter(([, , s]) => s !== 'same').map(([a, b, s]) => [a?.line, b?.line, s]),
    [[4, 4, 'edited']],
  );
  // TypeScript parses, its types are not statements
  const ts = parseStatements('interface P { x: number }\nconst p: P = { x: 1 };\nenum E { A }\n', 'p.ts');
  assert.deepEqual(
    ts.map((s) => s.line),
    [2, 3],
  );
});

test('a memory address in a repr is not a difference', () => {
  const a = [{ text: '<function dataclass at 0x101d10720>', step: 0 }];
  const b = [{ text: '<function dataclass at 0x101908720>', step: 0 }];
  assert.deepEqual(compareHits(['value', 'dataclass'], a, b), []);
  const callsA = [{ text: 'ask(graph=<Graph object at 0x108a254f0>)', step: 3, returned: '<Answer object at 0x1>', returnStep: 9 }];
  const callsB = [{ text: 'ask(graph=<Graph object at 0x10fe00000>)', step: 3, returned: '<Answer object at 0x2>', returnStep: 9 }];
  assert.deepEqual(compareHits(['call', 'ask'], callsA, callsB), []);
  // a change next to the address still shows, with both values as recorded
  const c = [{ text: '<Graph object at 0x10fe00000> 2 nodes', step: 0 }];
  const d = [{ text: '<Graph object at 0x108a254f0> 3 nodes', step: 0 }];
  assert.deepEqual(compareHits(['value', 'g'], c, d), [{ kind: 'value', name: 'g', a: { text: c[0]!.text, step: 0 }, b: { text: d[0]!.text, step: 0 } }]);
  // a hex number that is the data is compared as it is
  assert.equal(compareHits(['value', 'h'], [{ text: '0x1f', step: 0 }], [{ text: '0x2f', step: 0 }]).length, 1);
});

test('an edited statement prints the lines that changed', () => {
  const a = 'const scores = rrf(\n        rankings,\n        60,\n    );';
  const b = 'const scores = rrf(\n        rankings,\n        1,\n    );';
  assert.deepEqual(editedLines(a, b), ['    const scores = rrf( …', '  - 60,', '  + 1,']);
  // a change on the first line needs no context line
  assert.deepEqual(editedLines('total = qty * unit', 'total = qty * unit + 50'), ['  - total = qty * unit', '  + total = qty * unit + 50']);
  // one long line: a window around the first character that differs
  const head = 'result = compute(' + Array.from({ length: 30 }, (_, i) => `arg${i}=${i}`).join(', ');
  const lines = editedLines(head + ', limit=5)', head + ', limit=7)');
  assert.equal(lines.length, 2);
  assert.ok(lines[0]!.startsWith('  - …') && lines[1]!.startsWith('  + …'));
  assert.ok(lines[0]!.includes('limit=5)') && lines[1]!.includes('limit=7)') && lines.every((l) => l.length <= 130));
});

test('opcodes are difflib\'s', () => {
  // difflib.SequenceMatcher(None, 'abxcd', 'abcd', autojunk=False).get_opcodes()
  assert.deepEqual(opcodes([...'abxcd'], [...'abcd']), [
    ['equal', 0, 2, 0, 2],
    ['delete', 2, 3, 2, 2],
    ['equal', 3, 5, 2, 4],
  ]);
  // difflib.SequenceMatcher(None, 'qabxcd', 'abycdf', autojunk=False).get_opcodes()
  assert.deepEqual(opcodes([...'qabxcd'], [...'abycdf']), [
    ['delete', 0, 1, 0, 0],
    ['equal', 1, 3, 0, 2],
    ['replace', 3, 4, 2, 3],
    ['equal', 4, 6, 3, 5],
    ['insert', 6, 6, 5, 6],
  ]);
});

test('the diff text shows the changed line of a multi-line statement', async () => {
  const prog = join(dir, 'rrf.mjs');
  const src = (k: number) => `function rrf(rankings, k) {\n  return rankings.map(([d, r]) => [d, 1 / (k + r)]);\n}\n\nconst scores = rrf(\n  [['A', 1]],\n  ${k},\n);\nconsole.log(scores);\n`;
  const a = record(prog, src(60), join(dir, 'rrf-a.json'));
  const b = record(prog, src(1), join(dir, 'rrf-b.json'));
  const r = await cli('diff', a, b);
  const lines = r.out.split('\n');
  const i = lines.indexOf('rrf.mjs:5  <module>  edited');
  assert.ok(i >= 0, r.out);
  assert.deepEqual(lines.slice(i + 1, i + 4), ['    const scores = rrf( …', '  - 60,', '  + 1,']);
  const e = byText(await diffJson(a, b), 'const scores = rrf(');
  assert.deepEqual([e.textA, e.sourceB], ['const scores = rrf( …', "const scores = rrf(\n  [['A', 1]],\n  1,\n);"]);
});

test('secrets in the kept source are redacted', async () => {
  const prog = join(dir, 'keys.mjs');
  const out = record(prog, 'const secret = "sk-abcdefghijklmnopqrstuvwxyz012345";\nconst n = secret.length;\n', join(dir, 'k.json'));
  const raw = readFileSync(out, 'utf8');
  assert.ok(!raw.includes('sk-abcdefghijklmnopqrstuvwxyz012345'));
  assert.ok(raw.includes(`const secret = \\"${REDACTED}\\"`));
  const r = await cli('diff', out, out);
  assert.equal(r.code, 0);
  assert.ok(r.out.includes('statements: 2 same'), r.out);
});
