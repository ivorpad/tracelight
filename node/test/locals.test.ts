import { test } from 'node:test';
import assert from 'node:assert/strict';
import { record } from './recorderHarness.ts';
import { planLocals } from '../src/recorder/localsPlan.ts';
import { instrument } from '../src/instrument.ts';
import { parseProgram } from '../src/bindings.ts';

const getters = instrument('let a = 1;\na;', 'p.mjs', 1, 0, { sourceType: 'module', recordLocals: true }).code?.includes('()=>[') ?? false;

function plan(src: string): Record<number, string[]> {
  const { program } = parseProgram(src, 'p.mjs');
  const lines = src.split('\n');
  const out: Record<number, string[]> = {};
  for (const [start, names] of planLocals(program)) {
    let line = 1;
    for (let acc = 0; line <= lines.length; line++) {
      acc += lines[line - 1]!.length + 1;
      if (acc > start) break;
    }
    out[line] = names;
  }
  return out;
}

test('plan: params, hoisted vars, block bindings past their declaration, catch params', () => {
  const p = plan(`function f(a, { b }, ...rest) {
  const c = a;
  if (c) {
    let d = 1;
    var e = d;
  }
  try {
    g();
  } catch (err) {
    h(err);
  }
  return c;
}`);
  // `%e`: a hoisted var, marked so its undefined before `var e = d` runs is not a first value
  assert.deepEqual(p[2], ['a', 'b', 'rest', '%e']);
  assert.deepEqual(p[3], ['a', 'b', 'rest', '%e', 'c']);
  assert.deepEqual(p[4], ['a', 'b', 'rest', '%e', 'c']);
  assert.deepEqual(p[5], ['a', 'b', 'rest', '%e', 'c', 'd']);
  assert.deepEqual(p[8], ['a', 'b', 'rest', '%e', 'c']);
  assert.deepEqual(p[10], ['a', 'b', 'rest', '%e', 'c', 'err']);
  assert.deepEqual(p[12], ['a', 'b', 'rest', '%e', 'c']);
});

test('plan: a loop statement leaves out its own let; methods see this; module level skips imports and classes', () => {
  const p = plan(`import x from 'x';
let total = 0;
class K {}
for (let i = 0; i < 3; i++)
  total += i;`);
  assert.deepEqual(p[2], undefined);
  assert.deepEqual(p[3], ['total']);
  assert.deepEqual(p[4], ['total']);
  assert.deepEqual(p[5], ['total', 'i']);
  // the method body statement
  const { program } = parseProgram(`class K { m(v) { return this; } }`, 'p.mjs');
  assert.deepEqual([...planLocals(program).values()].at(-1), ['this', 'v']);
});

test('recorded locals: changes only, per scope, with bounded text', { skip: !getters && 'the instrumenter has no recordLocals getters yet' }, async () => {
  const r = await record(`
function grow(n) {
  const xs = [];
  for (let i = 0; i < n; i++) {
    xs.push(i);
  }
  const label = 'x'.repeat(200);
  return xs;
}
let password = 'p'.repeat(11); // any string under a secret-looking name is masked
const out = grow(2);
`, { recordLocals: true });
  const entries = r.events.filter((e) => e.type === 'locals').flatMap((e) => e.entries);
  const grow = r.scopes.find((s) => s.name === 'grow')!;
  const inGrow = entries.filter((e: any) => e.scopeId === grow.scopeId).map((e: any) => e.changes.map((c: any) => `${c.name}=${c.text}`).join(' '));
  assert.deepEqual(inGrow, ['n=2', 'xs=[]', 'i=0', 'xs=[ 0 ]', 'i=1', 'xs=[ 0, 1 ]', `label='${'x'.repeat(118)}…(+83 chars)`]);
  const mod = entries.filter((e: any) => e.scopeId === 0).flatMap((e: any) => e.changes);
  const pw = mod.find((c: any) => c.name === 'password');
  assert.equal(pw.text, "'••••••••'");
  assert.equal(pw.truncated, undefined);
});

test('recorded locals: a long value is cut and marked', { skip: !getters && 'the instrumenter has no recordLocals getters yet' }, async () => {
  const r = await record(`
const long = 'y'.repeat(500);
const done = 1;
`, { recordLocals: true, maxValueChars: 50 });
  const c = r.events.filter((e) => e.type === 'locals').flatMap((e) => e.entries).flatMap((e: any) => e.changes).find((c: any) => c.name === 'long');
  assert.equal(c.truncated, true);
  assert.equal(c.length, 502);
  assert.ok(c.text.endsWith('…(+453 chars)'), c.text);
  assert.equal(c.text.length, 49 + '…(+453 chars)'.length);
});

test('first values: undefined given by let or a missing argument is recorded, a hoisted var before its declaration is not; an expression-bodied arrow records its parameters', { skip: !getters && 'no getters' }, async () => {
  const r = await record('let a;\nlet b = undefined;\nconst sq = (n) => n * n;\nfunction f(x, y) {\n  total = x;\n  var total;\n  return y;\n}\nf(1);\nsq(3);\n', { recordLocals: true });
  const changes = r.events.filter((e) => e.type === 'locals').flatMap((e) => e.entries).flatMap((e: any) => e.changes.map((c: any) => `${c.name}=${c.text}`));
  assert.ok(changes.includes('a=undefined'), changes.join(' '));
  assert.ok(changes.includes('b=undefined'), changes.join(' '));
  assert.ok(changes.includes('y=undefined'), changes.join(' '));
  assert.ok(changes.includes('n=3'), changes.join(' '));
  assert.ok(!changes.includes('total=undefined'), changes.join(' '));
  assert.ok(changes.includes('total=1'), changes.join(' '));
});
