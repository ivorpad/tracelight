import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildRequest } from '../src/cli.ts';
import { KeepLink, socketPath, spawnKeeper } from '../src/keep.ts';
import { Merger } from '../src/threads/merge.ts';
import { decodeSteps } from '../src/protocol.ts';
import { project, run, type Run } from './helpers.ts';

const PING = `import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { square } from './lib.mjs';

if (isMainThread) {
  const w = new Worker(new URL(import.meta.url), { workerData: { n: 3 } });
  w.on('message', (m) => {
    const got = m.y;
    console.log('main got', got);
  });
  const a = square(2);
  w.postMessage({ x: a });
} else {
  parentPort.once('message', (m) => {
    const y = square(m.x) + workerData.n;
    console.log('worker computed', y);
    parentPort.postMessage({ y, list: [1, { deep: { deeper: [1, 2, 3] } }] });
  });
}
`;
const LIB = 'export function square(v) {\n  const r = v * v;\n  return r;\n}\n';

/** the merged step at which line `line` of the file `fileId` ran in a scope of `thread` (0: main) */
function stepsAt(r: Run, line: number, thread: number): number[] {
  const scopes = new Map(r.scopes().map((s) => [s.scopeId, s]));
  const out: number[] = [];
  r.steps().forEach(([rid, scope], i) => {
    if (r.line(rid!) === line && (scopes.get(scope!)?.thread?.ident ?? 0) === thread) out.push(i);
  });
  return out;
}

test('worker threads: one trace, the worker under its own scope, a send before its receipt', async () => {
  const r = await run({ 'main.mjs': PING, 'lib.mjs': LIB }, 'main.mjs');
  assert.equal(r.finished.exitCode, 0);
  // a file both threads load is instrumented once
  const files = r.of('file.instrumented').map((f) => f.path.split('/').pop());
  assert.deepEqual(files.sort(), ['lib.mjs', 'main.mjs']);
  const worker = r.scopes().find((s) => s.name.startsWith('<worker'))!;
  assert.ok(worker, 'a scope for the worker');
  assert.equal(worker.parent, 0);
  assert.equal(worker.depth, 1);
  assert.equal(typeof worker.thread!.ident, 'number');
  assert.equal(worker.thread!.name, `Worker ${worker.thread!.ident}`);
  const trace = r.of('trace').pop()!;
  assert.deepEqual(trace.threads.map((t: any) => t.thread), [worker.thread!.ident]);
  // every worker scope says so; their steps are a level deeper than the main thread's
  const square = r.scopes().filter((s) => s.name === 'square');
  assert.equal(square.length, 2);
  assert.deepEqual(square.map((s) => s.thread?.ident ?? 0).sort(), [0, worker.thread!.ident]);
  assert.equal(square.find((s) => s.thread)!.returned, '16');
  // the main thread's postMessage, then the worker's handler, then its reply, then the main thread's handler
  const [send] = stepsAt(r, 11, 0);
  const [recv] = stepsAt(r, 14, worker.thread!.ident);
  const [reply] = stepsAt(r, 16, worker.thread!.ident);
  const [back] = stepsAt(r, 7, 0);
  assert.ok(send! < recv! && recv! < reply! && reply! < back!, `${send} < ${recv} < ${reply} < ${back}`);
  // logs carry merged steps: the step of the statement that logged
  const logs = r.logs();
  const wlog = logs.find((l) => l.text.startsWith('worker computed'))!;
  const mlog = logs.find((l) => l.text.startsWith('main got'))!;
  assert.equal(r.line(r.steps()[wlog.step]![0]!), 15);
  assert.equal(r.line(r.steps()[mlog.step]![0]!), 8);
  assert.match(wlog.valueBag.data.id, /^w\d+\|/);
  // coverage counts both threads: square's body ran twice
  const lib = r.of('file.instrumented').find((f) => f.path.endsWith('lib.mjs'))!;
  const cov = r.of('coverage').find((c) => c.fileId === lib.fileId)!;
  assert.ok(Math.max(...cov.hits) >= 2);
  // the program's workerData is its own
  assert.equal(r.finished.stepCount, r.steps().length);
});

test('worker threads: a busy worker that is terminated still sends what it ran', async () => {
  const src = `const { Worker, isMainThread, parentPort } = require('node:worker_threads');
if (isMainThread) {
  const w = new Worker(__filename);
  w.on('message', () => w.terminate());
} else {
  let i = 0;
  for (;;) {
    if (++i === 5000) parentPort.postMessage('go');
  }
}
`;
  const r = await run({ 'main.cjs': src }, 'main.cjs');
  assert.equal(r.finished.exitCode, 0);
  const worker = r.scopes().find((s) => s.name.startsWith('<worker'))!;
  assert.ok(worker, 'the worker scope');
  const loop = stepsAt(r, 8, worker.thread!.ident);
  assert.ok(loop.length >= 5000, `the loop body ran in the worker (${loop.length})`);
  // the main thread's handler runs after the worker's post
  const term = stepsAt(r, 4, 0).pop()!;
  assert.ok(term > loop[4999]!, `${term} > ${loop[4999]}`);
});

test('worker threads: an uncaught error in a worker is reported once, at the worker statement', async () => {
  const src = `import { Worker, isMainThread } from 'node:worker_threads';
if (isMainThread) {
  new Worker(new URL(import.meta.url));
} else {
  const x = 1;
  throw new Error('boom ' + x);
}
`;
  const r = await run({ 'main.mjs': src }, 'main.mjs');
  const errors = r.of('error').filter((e) => !e.handled);
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.equal(errors[0]!.message, 'boom 1');
  const worker = r.scopes().find((s) => s.name.startsWith('<worker'))!;
  assert.equal(r.scopes().find((s) => s.scopeId === r.steps()[errors[0]!.step]![1])?.thread?.ident, worker.thread!.ident);
  assert.equal(r.line(r.steps()[errors[0]!.step]![0]!), 6);
});

test('worker threads: a TypeScript worker file, Atomics wait/notify order the threads', async () => {
  const main = `import { Worker } from 'node:worker_threads';
const shared = new Int32Array(new SharedArrayBuffer(8));
const w = new Worker(new URL('./work.ts', import.meta.url), { workerData: shared });
Atomics.wait(shared, 0, 0);
const seen: number = shared[1];
console.log('seen', seen);
`;
  const work = `import { workerData } from 'node:worker_threads';
const shared = workerData as Int32Array;
const value: number = 41 + 1;
shared[1] = value;
Atomics.store(shared, 0, 1);
Atomics.notify(shared, 0);
`;
  const r = await run({ 'main.ts': main, 'work.ts': work }, 'main.ts');
  assert.equal(r.finished.exitCode, 0);
  assert.equal(r.logs().find((l) => l.text.startsWith('seen'))?.text, 'seen 42');
  const worker = r.scopes().find((s) => s.name.startsWith('<worker'))!;
  const notify = stepsAt(r, 6, worker.thread!.ident)[0]!;
  const after = stepsAt(r, 5, 0)[0]!;
  assert.ok(notify < after, `the worker's notify (${notify}) before the main thread's read (${after})`);
  assert.ok(r.of('file.instrumented').some((f) => f.path.endsWith('work.ts')));
});

test('worker threads: a value a worker logged expands while it lives and after it exits', async () => {
  const src = `import { Worker, isMainThread, parentPort } from 'node:worker_threads';
if (isMainThread) {
  const w = new Worker(new URL(import.meta.url));
  w.on('message', () => {});
} else {
  const o = { a: { b: { c: [1, 2, 3] } } };
  o // ?
  parentPort.postMessage(1);
}
`;
  const dir = project({ 'main.mjs': src });
  const sock = socketPath();
  await spawnKeeper(sock, 60);
  const link = await KeepLink.open(sock);
  const req = buildRequest(join(dir, 'main.mjs'), src, {}, 'w1');
  const { events } = await link.run(req);
  const log = events.find((e) => e.type === 'log' && e.valueBag)!;
  assert.match(log.valueBag.data.id, /^w\d+\|/);
  const reply = await link.request({ type: 'expand', runId: 'w1', valueId: log.valueBag.data.id, queryPath: log.valueBag.data.queryPath });
  assert.equal(reply.type, 'value', JSON.stringify(reply));
  assert.equal(reply.node.props[0].name, 'a');
  const a = reply.node.props[0];
  const deeper = await link.request({ type: 'expand', runId: 'w1', valueId: a.id, queryPath: a.queryPath });
  assert.equal(deeper.type, 'value', JSON.stringify(deeper));
  assert.equal(deeper.node.props[0].name, 'b');
  link.sock.write(JSON.stringify({ type: 'shutdown' }) + '\n');
  link.close();
});

test('worker threads: the merge keeps each thread in order and sends before receipts', () => {
  const q = (...rids: number[]) => Int32Array.from(rids.flatMap((r) => [r, 0, 0, 0]));
  const ridsOf = (m: Merger) => {
    const out = [];
    for (let i = 0; i < m.len * 4; i += 4) out.push(m.out[i]);
    return out;
  };
  // main: steps 0-1 at ticket 0, 2-3 after its send (ticket 2); the worker starts at 1, receives at 3
  const m = new Merger(100);
  const main = m.lane(0);
  main.floor = -0.5;
  const worker = m.lane(1);
  worker.floor = 0;
  main.addSteps(0, q(10, 11, 12), 3);
  main.addSegs([2, 2]);
  // the worker has sent nothing: only the main thread's steps before its send can go
  m.advance();
  assert.deepEqual(ridsOf(m), [10, 11]);
  worker.addSteps(0, q(20, 21), 2);
  worker.addSegs([0, 1, 1, 3]);
  // the worker's step 0 (ticket 1) comes before main's open segment (ticket 2); its open one (3) waits
  m.advance();
  assert.deepEqual(ridsOf(m), [10, 11, 20, 12]);
  main.addSteps(3, q(13), 4);
  m.advance();
  assert.deepEqual(ridsOf(m), [10, 11, 20, 12, 13]);
  worker.addSteps(2, q(22), 3);
  worker.exited = true;
  main.exited = true;
  m.advance();
  assert.deepEqual(ridsOf(m), [10, 11, 20, 12, 13, 21, 22]);
  assert.deepEqual([0, 1, 2].map((s) => worker.map(s, m.last)), [2, 5, 6]);
  assert.equal(m.out[2 * 4 + 2], 1); // a worker's steps are a level deeper
  // a thread that does not answer: what it runs next goes after a fresh ticket
  const r = new Merger(100);
  const a = r.lane(0);
  a.floor = -0.5;
  const b = r.lane(1);
  b.addSteps(0, q(1), 1);
  b.addSegs([0, 5]);
  a.addSteps(0, q(7, 8), 2);
  a.addSegs([1, 6]);
  b.restamp(9);
  b.addSteps(1, q(2), 2);
  b.addSegs([0, 5]); // a late answer with its old ticket: clamped
  b.exited = true;
  a.exited = true;
  r.advance();
  assert.deepEqual(ridsOf(r), [7, 1, 8, 2]);
  const cut = new Merger(2);
  const c = cut.lane(0);
  c.addSteps(0, q(1, 2, 3), 3);
  c.exited = true;
  cut.advance();
  assert.equal(cut.truncated, true);
  assert.deepEqual([0, 1, 2].map((s) => c.map(s, cut.last)), [0, 1, 1]);
});

test('worker threads: a watch window counts the main thread statements and comes back merged', async () => {
  const src = `import { Worker, isMainThread } from 'node:worker_threads';
let total = 0;
if (isMainThread) {
  const w = new Worker(new URL(import.meta.url));
  w.on('exit', () => {
    total = 10;
    total = 20;
  });
} else {
  const a = 1;
  const b = 2;
}
`;
  const first = await run({ 'main.mjs': src }, 'main.mjs');
  const scopes = new Map(first.scopes().map((s) => [s.scopeId, s]));
  const steps = first.steps();
  const target = stepsAt(first, 7, 0)[0]!; // total = 20
  const mainStep = steps.slice(0, target).filter(([, sc]) => scopes.get(sc!)?.thread === undefined).length;
  const r = await run({ 'main.mjs': src }, 'main.mjs', { watch: [{ id: 'w1', exp: 'total' }], traceContext: { step: target, prefetch: 1, mainStep } });
  const w = r.of('watch');
  assert.equal(w.length, 1, JSON.stringify(w));
  assert.equal(w[0]!.step, stepsAt(r, 7, 0)[0]);
  assert.equal(w[0]!.valueBag.data.value, '10');
});

test('worker threads: a worker still running when the run ends answers expand itself', async () => {
  const src = `import { Worker, isMainThread } from 'node:worker_threads';
if (isMainThread) {
  const w = new Worker(new URL(import.meta.url));
  w.unref();
  setTimeout(() => {}, 500);
} else {
  const o = { a: { b: { c: [1, 2, 3] } } };
  o // ?
  setInterval(() => {}, 1000);
}
`;
  const dir = project({ 'main.mjs': src });
  const sock = socketPath();
  await spawnKeeper(sock, 60);
  const link = await KeepLink.open(sock);
  const req = buildRequest(join(dir, 'main.mjs'), src, {}, 'w2');
  const { events } = await link.run(req);
  const log = events.find((e) => e.type === 'log' && e.valueBag)!;
  assert.ok(log, 'the worker log arrived with the run');
  const reply = await link.request({ type: 'expand', runId: 'w2', valueId: log.valueBag.data.id, queryPath: log.valueBag.data.queryPath });
  assert.equal(reply.type, 'value', JSON.stringify(reply));
  const b = (await link.request({ type: 'expand', runId: 'w2', valueId: reply.node.props[0].id, queryPath: reply.node.props[0].queryPath })).node.props[0];
  const c = await link.request({ type: 'expand', runId: 'w2', valueId: b.id, queryPath: b.queryPath });
  assert.equal(c.type, 'value', JSON.stringify(c));
  assert.equal(c.node.props[0].name, 'c');
  assert.match(c.node.id, /^w\d+\|/);
  link.sock.write(JSON.stringify({ type: 'shutdown' }) + '\n');
  link.close();
});

test('worker threads: eval code and a nested worker are recorded too', async () => {
  const src = `const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const code = \`
const { parentPort, workerData } = require('node:worker_threads');
function twice(v) {
  return v * 2;
}
parentPort.postMessage(twice(workerData));
\`;
if (isMainThread) {
  const w = new Worker(__filename, { workerData: 'outer' });
  w.on('message', (m) => {
    const final = m + 1;
    console.log('final', final);
  });
} else {
  const inner = new Worker(code, { eval: true, workerData: 20 });
  inner.on('message', (m) => {
    parentPort.postMessage(m);
  });
}
`;
  const r = await run({ 'main.cjs': src }, 'main.cjs');
  assert.equal(r.finished.exitCode, 0);
  assert.equal(r.logs().find((l) => l.text.startsWith('final'))?.text, 'final 41');
  const trace = r.of('trace').pop()!;
  assert.equal(trace.threads.length, 2);
  const twice = r.scopes().find((s) => s.name === 'twice')!;
  assert.ok(twice, 'the eval code ran recorded');
  assert.equal(twice.returned, '40');
  const evalFile = r.of('file.instrumented').find((f) => /worker-eval-\d+\.js$/.test(f.path));
  assert.ok(evalFile, 'the eval code is a file of the run');
  // the nested worker's steps come between the outer worker's creating it and the main thread's handler
  const outer = trace.threads[0].scopeId;
  const nested = trace.threads[1].scopeId;
  const steps = r.steps();
  const firstOf = (sid: number) => steps.findIndex(([, s]) => s === sid);
  assert.ok(firstOf(outer) < firstOf(nested));
  assert.ok(firstOf(nested) < stepsAt(r, 13, 0)[0]!);
});

test('worker threads: trace deltas while workers run are a prefix of the final trace', async () => {
  const src = `const { Worker, isMainThread, parentPort } = require('node:worker_threads');
function spin(ms) {
  const end = Date.now() + ms;
  let k = 0;
  while (Date.now() < end) k++;
  return k;
}
if (isMainThread) {
  const w = new Worker(__filename);
  let rounds = 0;
  w.on('message', (m) => {
    rounds++;
    if (rounds < 6) w.postMessage(spin(150));
    else w.terminate();
  });
  w.postMessage(spin(150));
} else {
  parentPort.on('message', (m) => {
    parentPort.postMessage(spin(150));
  });
}
`;
  const r = await run({ 'main.cjs': src }, 'main.cjs');
  const traces = r.of('trace');
  const final = traces.pop()!;
  const deltas = traces.filter((t) => t.partial);
  assert.ok(deltas.length >= 2, `deltas while the worker ran (${deltas.length})`);
  const all = decodeSteps(final.steps);
  let at = 0;
  const seen = new Map<number, any>();
  for (const d of deltas) {
    assert.equal(d.offset, at, 'deltas are contiguous');
    const q = decodeSteps(d.steps);
    assert.deepEqual([...q], [...all.subarray(at * 4, at * 4 + q.length)], `delta at ${at} matches the final trace`);
    at += q.length / 4;
    for (const s of d.scopes) seen.set(s.scopeId, s);
  }
  const byId = new Map(final.scopes.map((s: any) => [s.scopeId, s]));
  assert.ok([...seen.values()].some((s) => s.thread), 'worker scopes went out in deltas');
  for (const [id, s] of seen) {
    const f = byId.get(id) as any;
    assert.ok(f, `scope ${id} is in the final trace`);
    assert.deepEqual([s.name, s.parent, s.depth, s.first, s.thread?.ident], [f.name, f.parent, f.depth, f.first, f.thread?.ident]);
  }
});
