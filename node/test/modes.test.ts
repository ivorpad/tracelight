import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { run } from './helpers.ts';
import { isRuntimeUrl, pruneProfile } from '../src/profile.ts';

test('mode profile: the plain program under the V8 profiler, a .cpuprofile in run.finished', async () => {
  const src = 'function spin(n: number): number {\n  let x = 0;\n  for (let i = 0; i < n; i++) x += i % 7;\n  return x;\n}\nconsole.log(spin(3_000_000));\n';
  const r = await run({ 'main.ts': src }, 'main.ts', { mode: 'profile' }, {}, src);
  assert.equal(r.finished.exitCode, 0);
  assert.equal(r.finished.stepCount, 0);
  assert.equal(r.of('file.instrumented').length, 1);
  let want = 0;
  for (let i = 0; i < 3_000_000; i++) want += i % 7;
  assert.equal(r.of('output').map((o) => o.text).join(''), `${want}\n`);
  const prof = JSON.parse(readFileSync(r.finished.profile.path, 'utf8'));
  assert.ok(prof.nodes.some((n: any) => n.callFrame.functionName === 'spin'));
  assert.ok(prof.samples.length > 0);
  // the runtime's own frames (and Node's frames it called) are not in the user's profile
  assert.deepEqual(prof.nodes.filter((n: any) => isRuntimeUrl(n.callFrame.url)).map((n: any) => n.callFrame.url), []);
  const ids = new Set(prof.nodes.map((n: any) => n.id));
  assert.ok(prof.samples.every((s: number) => ids.has(s)));
  assert.equal(prof.samples.length, prof.timeDeltas.length);
});

test('pruneProfile: callees move up to the kept caller, the runtime\'s samples and time go', () => {
  const f = (functionName: string, url: string) => ({ functionName, url });
  const prof = {
    nodes: [
      { id: 1, callFrame: f('(root)', ''), children: [2, 6] },
      { id: 2, callFrame: f('main', 'file:///p/main.js'), children: [3] },
      { id: 3, callFrame: f('hook', 'file:///rt/src/x.ts'), children: [4, 5] },
      { id: 4, callFrame: f('writeSync', 'node:fs'), children: [] },
      { id: 5, callFrame: f('cb', 'file:///p/main.js'), children: [] },
      { id: 6, callFrame: f('(idle)', ''), children: [] },
    ],
    startTime: 0, endTime: 60,
    samples: [2, 3, 4, 5, 6, 2], timeDeltas: [10, 10, 10, 10, 10, 10],
  };
  pruneProfile(prof, (u) => u.startsWith('file:///rt/'));
  assert.deepEqual(prof.nodes.map((n) => [n.id, n.children]), [[1, [2, 6]], [2, [5]], [5, []], [6, []]]);
  // main's sample lasts until the hook's, the hook's 20 are gone: cb starts 10 after main
  assert.deepEqual(prof.samples, [2, 5, 6, 2]);
  assert.deepEqual(prof.timeDeltas, [10, 10, 10, 10]);
  assert.equal(prof.endTime, 40);
});

test('mode snaps: fences run in place, errors are reported and the run goes on', async () => {
  const src = [
    'const xs = [1, 2, 3];',
    'const bad = JSON.parse("{");', // a top-level error: reported, `bad` is undefined, the run goes on
    'function total(a: number[]) {',
    '  return a.reduce((s, x) => s + x, 0);',
    '}',
    '/*{{',
    'total(xs)',
    'const { n } = nope.x;',
    'xs.map((x) => x * 2)',
    '}}*/',
    'console.log("after", bad);',
  ].join('\n');
  const r = await run({ 'main.ts': src }, 'main.ts', { mode: 'snaps' }, {}, src);
  assert.equal(r.finished.exitCode, 0);
  const logs = r.logs().map((l) => [r.line(l.rid), l.kind, l.text]);
  assert.deepEqual(logs, [
    [7, 'value', '6'],
    [9, 'value', '[ 2, 4, 6 ]'],
    [11, 'log', 'after undefined'],
  ]);
  const errors = r.of('error');
  assert.deepEqual(errors.map((e) => [r.line(e.rid), e.errorType]), [[2, 'SyntaxError'], [8, 'ReferenceError']]);
  const cov = r.of('coverage')[0]!;
  const states = new Map<number, number>();
  r.file(1).ranges.forEach((rg: number[], i: number) => states.set(rg[0]!, Math.max(states.get(rg[0]!) ?? 0, cov.states[i])));
  assert.equal(states.get(2), 3);
  assert.equal(states.get(8), 3);
});

test('mode snaps: process.exit still stops the program inside a guard', async () => {
  const src = 'console.log("a");\nprocess.exit(4);\nconsole.log("b");\n';
  const r = await run({ 'main.js': src }, 'main.js', { mode: 'snaps' });
  assert.equal(r.finished.exitCode, 4);
  assert.deepEqual(r.logs().map((l) => l.text), ['a']);
});

test('mode snaps: destructuring nullish is reported, not fatal', async () => {
  const src = 'const [p] = undefined;\nconst { q } = null;\nconsole.log(p, q);\n';
  const r = await run({ 'main.js': src }, 'main.js', { mode: 'snaps' });
  assert.equal(r.finished.exitCode, 0);
  assert.deepEqual(r.of('error').map((e) => [r.line(e.rid), e.errorType]), [[1, 'TypeError'], [2, 'TypeError']]);
  assert.deepEqual(r.logs().map((l) => l.text), ['undefined undefined']);
});
