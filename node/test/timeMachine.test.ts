import { test } from 'node:test';
import assert from 'node:assert/strict';
import { record, stepOut, stepOver, path } from './recorderHarness.ts';
import { FLAG_ERROR, FLAG_SCOPE_ENTRY, FLAG_UNWINDING } from '../src/protocol.ts';

test('sync calls: scopes, parents, depth, returned', async () => {
  const r = await record(`
function add(a, b) {
  return a + b;
}
function twice(x) {
  const y = add(x, x);
  return y;
}
const z = twice(3);
`);
  assert.deepEqual(path(r), ['9:<module>', '5:twice', '6:twice', '2:add', '3:add', '7:twice']);
  const twice = r.scopes.find((s) => s.name === 'twice')!;
  const add = r.scopes.find((s) => s.name === 'add')!;
  assert.equal(twice.parent, 0);
  assert.equal(twice.depth, 1);
  assert.equal(add.parent, twice.scopeId);
  assert.equal(add.depth, 2);
  assert.equal(add.returned, '6');
  assert.equal(twice.returned, '6');
  assert.equal(twice.first, 1);
  assert.equal(twice.last, 5);
  assert.equal(r.rows[1]!.flags & FLAG_SCOPE_ENTRY, FLAG_SCOPE_ENTRY);
  // step over the call at line 6 lands on line 7, step out of add lands back in twice
  assert.equal(r.rows[stepOver(r, 2)]!.line, 7);
  assert.equal(r.rows[stepOut(r, 4)]!.line, 7);
});

test('returned: null when the body runs off its end, raised when an exception leaves', async () => {
  const r = await record(`
function nothing() { const a = 1; }
function boom() { throw new TypeError('no'); }
function outer() { boom(); }
nothing();
try { outer(); } catch (e) {}
`);
  const by = (n: string) => r.scopes.find((s) => s.name === n)!;
  assert.equal(by('nothing').returned, null);
  assert.equal(by('boom').raised, 'TypeError');
  assert.equal(by('outer').raised, 'TypeError');
  const throwStep = r.rows.find((x) => x.name === 'boom' && x.line === 3 && !(x.flags & FLAG_SCOPE_ENTRY))!;
  assert.ok(throwStep.flags & FLAG_ERROR, 'the throw statement is flagged as raising');
  const callStep = r.rows.find((x) => x.name === 'outer' && !(x.flags & FLAG_SCOPE_ENTRY))!;
  assert.ok(callStep.flags & FLAG_UNWINDING, 'the call it unwinds through is flagged');
});

test('recursion: one scope per call, exact parents', async () => {
  const r = await record(`
function fact(n) {
  if (n <= 1) return 1;
  return n * fact(n - 1);
}
fact(4);
`);
  const facts = r.scopes.filter((s) => s.name === 'fact');
  assert.equal(facts.length, 4);
  for (let i = 1; i < facts.length; i++) assert.equal(facts[i]!.parent, facts[i - 1]!.scopeId);
  assert.deepEqual(facts.map((s) => s.depth), [1, 2, 3, 4]);
  assert.deepEqual(facts.map((s) => s.returned), ['24', '6', '2', '1']);
});

test('interleaved async: every step belongs to its own call, whatever ran in between', async () => {
  const r = await record(`
const tick = () => new Promise((res) => setTimeout(res, 1));
async function worker(id, n) {
  let total = 0;
  for (let i = 0; i < n; i++) {
    await tick();
    total += id;
  }
  return total;
}
const results = await Promise.all([worker(1, 3), worker(2, 3), worker(3, 3)]);
const after = results.length;
`);
  const workers = r.scopes.filter((s) => s.name === 'worker');
  assert.equal(workers.length, 3);
  // called synchronously by the module: the module is their parent, siblings never nest
  for (const w of workers) {
    assert.equal(w.parent, 0);
    assert.equal(w.depth, 1);
  }
  assert.deepEqual(workers.map((w) => w.returned), ['3', '6', '9']);
  // each worker's own steps: entry, `let total`, loop header x4, await x3, total+= x3, return
  for (const w of workers) {
    const own = r.rows.filter((x) => x.scope === w.scopeId).map((x) => x.line);
    assert.deepEqual(own, [3, 4, 5, 5, 6, 7, 5, 6, 7, 5, 6, 7, 9]);
  }
  // they interleave: worker 1's steps are not one contiguous block
  const w1 = r.rows.filter((x) => x.scope === workers[0]!.scopeId).map((x) => x.step);
  assert.ok(w1[w1.length - 1]! - w1[0]! > w1.length, 'steps interleave with the other workers');
  // the tick arrows called from each worker sit under that worker
  const ticks = r.scopes.filter((s) => s.name === 'tick');
  assert.equal(ticks.length, 9);
  for (const t of ticks) assert.ok(workers.some((w) => w.scopeId === t.parent));
  // step over `await Promise.all(...)` lands on the next module statement
  const allStep = r.rows.find((x) => x.line === 11 && x.scope === 0)!.step;
  assert.equal(r.rows[stepOver(r, allStep)]!.line, 12);
  // step over inside worker 2 after an await stays in worker 2, skipping the others
  const w2 = workers[1]!.scopeId;
  const awaitStep = r.rows.find((x) => x.scope === w2 && x.line === 6)!.step;
  const next = stepOver(r, awaitStep);
  assert.equal(r.rows[next]!.scope, w2);
  assert.equal(r.rows[next]!.line, 7);
});

test('nested awaits: a callee called after a resume has the resumed frame as parent', async () => {
  const r = await record(`
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
async function leaf(tag) { await sleep(1); return tag; }
async function mid(tag) {
  await sleep(2);
  const a = await leaf(tag + 'a');
  const b = await leaf(tag + 'b');
  return a + b;
}
await Promise.all([mid('x'), mid('y')]);
`);
  const mids = r.scopes.filter((s) => s.name === 'mid');
  const leaves = r.scopes.filter((s) => s.name === 'leaf');
  assert.equal(leaves.length, 4);
  for (const l of leaves) {
    const m = mids.find((m) => m.scopeId === l.parent);
    assert.ok(m, 'leaf parent is a mid');
    assert.equal(l.depth, 2);
    assert.equal(l.returned, `'${m!.returned!.slice(1, 3) === 'xa' ? 'x' : 'y'}${l.returned!.slice(2, 3)}'`);
  }
  assert.deepEqual(mids.map((m) => m.returned), ["'xaxb'", "'yayb'"]);
});

test('event-loop callbacks: module parent, the scheduling scope as asyncParent', async () => {
  const r = await record(`
function schedule() {
  return new Promise((done) => {
    setTimeout(function onTimer() {
      const a = 1;
      done(a);
    }, 1);
  });
}
await schedule();
`);
  const sched = r.scopes.find((s) => s.name === 'schedule')!;
  const timer = r.scopes.find((s) => s.name === 'onTimer')!;
  assert.equal(timer.parent, 0);
  assert.equal(timer.depth, 1);
  // the executor arrow called setTimeout
  const executor = r.scopes.find((s) => s.name === '<arrow>')!;
  assert.equal(executor.parent, sched.scopeId);
  assert.equal(timer.asyncParent, executor.scopeId);
  assert.equal(sched.returned, 'Promise { <pending> }');
});

test('an awaited promise that rejects: the frame resumes without aw and its calls still nest under it', async () => {
  const r = await record(`
const fail = () => Promise.reject(new Error('x'));
function inner() { return 1; }
async function run() {
  try {
    await fail();
  } catch (e) {
    inner();
  }
  inner();
  return 'ok';
}
setTimeout(() => 0, 0);
await run();
await new Promise((res) => setTimeout(res, 5));
function later() { return 2; }
later();
`);
  const run = r.scopes.find((s) => s.name === 'run')!;
  const inners = r.scopes.filter((s) => s.name === 'inner');
  assert.equal(inners.length, 2);
  for (const i of inners) assert.equal(i.parent, run.scopeId);
  assert.equal(run.returned, "'ok'");
  const later = r.scopes.find((s) => s.name === 'later')!;
  assert.equal(later.parent, 0, 'nothing stale is left on the frame chain');
});

test('generators: the first next() caller is the parent; yields suspend and resume', async () => {
  const r = await record(`
function* count(n) {
  for (let i = 0; i < n; i++) yield i;
}
function consume() {
  let s = 0;
  for (const v of count(3)) s += v;
  return s;
}
consume();
function after() { return 0; }
after();
`);
  const consume = r.scopes.find((s) => s.name === 'consume')!;
  const count = r.scopes.find((s) => s.name === 'count')!;
  assert.equal(count.parent, consume.scopeId);
  assert.equal(consume.returned, '3');
  assert.equal(r.scopes.find((s) => s.name === 'after')!.parent, 0);
});

test('for await: the implicit await resumes the frame without aw', async () => {
  const r = await record(`
async function* src() { yield 1; await null; yield 2; }
function f(v) { return v; }
async function main() {
  let t = 0;
  for await (const v of src()) t += f(v);
  return t;
}
await main();
`);
  const main = r.scopes.find((s) => s.name === 'main')!;
  for (const fs of r.scopes.filter((s) => s.name === 'f')) assert.equal(fs.parent, main.scopeId);
  assert.equal(r.scopes.find((s) => s.name === 'src')!.parent, main.scopeId);
  assert.equal(main.returned, '3');
});

test('attribution: code without hooks is attributed to the scope that scheduled it', async () => {
  const r = await record(`
const plain = new Function('rec', 'seen', 'return () => seen.push(rec.attribution())');
async function a() {
  await new Promise((res) => setTimeout(res, 3));
  const x = 1;
  setTimeout(plain(globalThis.__rec, globalThis.__seen), 0);
  await new Promise((res) => setTimeout(res, 10));
}
async function b() {
  setTimeout(plain(globalThis.__rec, globalThis.__seen), 1);
  await new Promise((res) => setTimeout(res, 10));
}
await Promise.all([a(), b()]);
`);
  const a = r.scopes.find((s) => s.name === 'a')!;
  const b = r.scopes.find((s) => s.name === 'b')!;
  const scopes = r.seen.map((x) => x.scope).sort();
  assert.deepEqual(scopes, [a.scopeId, b.scopeId].sort());
  for (const s of r.seen) assert.equal(r.rows[s.step]!.scope, s.scope);
});

test('step cap: truncated, cap report, scopes stop', async () => {
  const r = await record(`
let s = 0;
for (let i = 0; i < 100; i++) s += i;
`, { maxTraceSteps: 50 });
  assert.equal(r.rows.length, 50);
  assert.equal(r.final.truncated, true);
  assert.equal(r.final.cap, 50);
  assert.equal(r.final.stepsRun, 202);
  assert.deepEqual(r.final.spentBy, [{ path: 'prog.mjs', steps: 202 }]);
});

test('partial deltas reassemble into the final trace', async () => {
  const r = await record(`
const cell = new Int32Array(new SharedArrayBuffer(4));
const t0 = Date.now();
let n = 0;
while (Date.now() - t0 < 1300) {
  n++;
  if (n % 64 === 0) Atomics.wait(cell, 0, 0, 2);
}
`);
  const partials = r.events.filter((e) => e.type === 'trace' && e.partial);
  assert.ok(partials.length >= 1);
  assert.equal(partials[0]!.offset, 0);
  // the deltas are a prefix of the final steps, and every scope arrives once
  const final = Buffer.from(r.final.steps, 'base64');
  let at = 0;
  for (const p of partials) {
    const chunk = Buffer.from(p.steps, 'base64');
    assert.equal(p.offset * 16, at);
    assert.ok(chunk.equals(final.subarray(at, at + chunk.length)));
    at += chunk.length;
  }
});

test('fuzz: random async interleavings never attribute a step to the wrong call', async () => {
  for (let seed = 1; seed <= 6; seed++) {
    const r = await record(`
let seed = ${seed};
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 4);
const pause = () => new Promise((res) => (rnd() === 0 ? queueMicrotask(res) : setTimeout(res, rnd())));
function leaf(x) {
  return x + 1;
}
async function maybeFail(x) {
  await pause();
  if (rnd() === 0) throw new Error('boom ' + x);
  return leaf(x);
}
function* gen(n) {
  for (let i = 0; i < n; i++) yield leaf(i);
}
async function task(id) {
  let acc = 0;
  for (const v of gen(3)) {
    try {
      acc += await maybeFail(v + id);
    } catch (e) {
      acc -= 1;
    }
    if (rnd() === 1) await pause();
    acc += leaf(acc);
  }
  return acc;
}
await Promise.all([task(1), task(2), task(3), task(4)]);
`);
    // the function each scope runs, by its entry rid: every step of the scope is inside that function
    const fnRanges = new Map<number, [number, number]>();
    for (const s of r.scopes) {
      if (s.scopeId === 0) continue;
      const entry = r.rows[s.first]!;
      assert.equal(entry.scope, s.scopeId, 'a scope begins with its own entry step');
      fnRanges.set(s.scopeId, [entry.line, entry.line + 30]);
    }
    const body: Record<string, [number, number]> = { leaf: [5, 7], maybeFail: [8, 12], gen: [13, 15], task: [16, 28], '<arrow>': [2, 4] };
    for (const row of r.rows) {
      if (row.scope === 0) continue;
      const range = body[row.name];
      if (!range) continue;
      assert.ok(row.line >= range[0] && row.line <= range[1], `seed ${seed}: step ${row.step} line ${row.line} is not in ${row.name}`);
    }
    // parents: a helper called from a task sits under that task, and every task under the module
    for (const s of r.scopes) {
      if (s.name === 'task') assert.equal(s.parent, 0);
      if (s.name === 'maybeFail' || s.name === 'gen') assert.equal(r.scopes[s.parent]!.name, 'task', `seed ${seed}: ${s.name} parent`);
      if (s.name === 'leaf') assert.ok(['task', 'maybeFail', 'gen'].includes(r.scopes[s.parent]!.name), `seed ${seed}: leaf parent ${r.scopes[s.parent]!.name}`);
      assert.equal(s.depth, s.parent >= 0 ? r.scopes[s.parent]!.depth + 1 : 0);
    }
    // step over stays within the task's lineage
    for (const row of r.rows.filter((x) => x.name === 'task')) {
      const j = stepOver(r, row.step);
      if (j >= 0) assert.ok(r.rows[j]!.scope === row.scope || r.rows[j]!.scope === 0, `seed ${seed}: over from ${row.step} left the task`);
    }
  }
});

test('recording stays cheap per step (3.7 µs/step on fib(22), bench/record.ts)', async () => {
  const src = `
function fib(n) {
  if (n < 2) return n;
  return fib(n - 1) + fib(n - 2);
}
const t0 = performance.now();
fib(20);
globalThis.__seen.push(performance.now() - t0);
`;
  let best = Infinity;
  let steps = 0;
  for (let i = 0; i < 3; i++) {
    const r = await record(src);
    best = Math.min(best, r.seen[0]);
    steps = r.rows.length;
  }
  const nsPerStep = (best * 1e6) / steps;
  assert.ok(steps > 60_000);
  assert.ok(nsPerStep < 1500, `${nsPerStep.toFixed(0)} ns per recorded step`);
});
