import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Driver } from './driver.ts';
import { decodeSteps } from '../src/protocol.ts';
import { CAPABILITIES } from '../src/protocol.ts';
import type { Msg } from './helpers.ts';

const PROGRAM = [
  'function add(a, b) {', //            1
  '  const s = a + b;', //              2
  '  return s;', //                     3
  '}', //                               4
  'function twice(x) {', //             5
  '  return x * 2;', //                 6
  '}', //                               7
  'let total = 0;', //                  8
  'const items = [1, 2, 3];', //        9
  'for (const i of items) {', //       10
  '  total = add(total, twice(i));', // 11
  '}', //                              12
  'console.log("total", total);', //   13
].join('\n');

const RECORDING = ['trace', 'coverage', 'log', 'locals', 'time', 'watch', 'http.exchange'];

function stepsOf(trace: Msg): number[][] {
  const q = decodeSteps(trace.steps);
  const out: number[][] = [];
  for (let i = 0; i < q.length; i += 4) out.push([q[i]!, q[i + 1]!, q[i + 2]!, q[i + 3]!]);
  return out;
}

test('capabilities advertise record and recordFrom', () => {
  assert.ok(CAPABILITIES.includes('record'));
  assert.ok(CAPABILITIES.includes('recordFrom'));
});

test('record: false change watches pause with live values without recording', async () => {
  const d = new Driver();
  try {
    d.start({ 'main.js': 'let total = 0;\ntotal += 1;\ntotal += 2;\nconsole.log(total);\n' }, 'main.js', { record: false });
    await d.paused();
    await d.ask({ type: 'debug', action: 'step', kind: 'over' });
    const initialized = await d.paused();
    assert.equal(initialized.line, 2);
    await d.ask({ type: 'debug', action: 'watches', set: [{ id: 'total', exp: 'total', breakWhen: 'change' }] });
    await d.ask({ type: 'debug', action: 'continue' });
    const changed = await d.paused();
    assert.equal(changed.reason, 'watch');
    assert.equal(changed.line, 3);
    assert.equal(changed.watch.text, '1');
    await d.ask({ type: 'debug', action: 'watches', set: [] });
    await d.ask({ type: 'debug', action: 'continue' });
    assert.equal((await d.next(m => m.type === 'run.finished')).exitCode, 0);
    assert.ok(!d.seen.some(m => RECORDING.includes(m.type)));
  } finally { d.close(); }
});

test('record: false is the Debugger: frame-chain pauses, the statement counter, output, nothing recorded', async () => {
  const d = new Driver();
  try {
    const path = d.start({ 'main.js': PROGRAM }, 'main.js', { record: false, stopOnEntry: false, recordLocals: true, autoLog: true }, { breakpoints: [{ path: '', function: 'add' }] });
    const atAdd = await d.paused();
    assert.equal(atAdd.reason, 'breakpoint');
    assert.equal(atAdd.line, 1);
    // the frame chain, innermost first, with per-call ids
    assert.deepEqual(atAdd.stack.map((f: Msg) => [f.frameId, f.name, f.line]), [[0, 'add', 1], [1, '<module>', 11]]);
    assert.equal(atAdd.depth, 1);
    assert.ok(atAdd.scopeId > 0);
    assert.equal(typeof atAdd.step, 'number');
    let r = await d.ask({ type: 'evaluate', expression: 'a + b' });
    assert.equal(r.text, '2');
    // over to the body, over again, then out: back in the module, after the call
    r = await d.ask({ type: 'debug', action: 'breakpoints', set: [] });
    await d.ask({ type: 'debug', action: 'step', kind: 'over' });
    const body = await d.paused();
    assert.deepEqual([body.kind, body.line, body.scopeId], ['over', 2, atAdd.scopeId]);
    assert.ok(body.step > atAdd.step);
    await d.ask({ type: 'debug', action: 'step', kind: 'out' });
    const out = await d.paused();
    assert.equal(out.kind, 'out');
    assert.equal(out.stack.length, 1);
    assert.equal(out.stack[0].name, '<module>');
    // a record action in a run that records nothing is refused
    r = await d.ask({ type: 'debug', action: 'record' });
    assert.equal(r.type, 'error');
    assert.match(r.message, /recordFrom/);
    await d.ask({ type: 'debug', action: 'continue' });
    const fin = await d.next((m) => m.type === 'run.finished', 'run.finished');
    assert.equal(fin.exitCode, 0);
    assert.ok(fin.stepCount > 10, JSON.stringify(fin));
    const outputs = d.seen.filter((m) => m.type === 'output');
    assert.ok(outputs.some((o) => o.text === 'total 12\n'), JSON.stringify(outputs));
    assert.ok(outputs.every((o) => typeof o.step === 'number' && o.step <= fin.stepCount));
    for (const type of RECORDING) assert.ok(!d.seen.some((m) => m.type === type), `no ${type}`);
    assert.ok(d.seen.some((m) => m.type === 'file.instrumented' && m.path === path));
  } finally {
    d.close();
  }
});

test('record: false: a step over the end of a nested call goes on in its caller, not into the next call', async () => {
  const d = new Driver();
  try {
    d.start({ 'main.js': PROGRAM }, 'main.js', { record: false, stopOnEntry: false }, { breakpoints: [{ path: '', function: 'twice' }] });
    const atTwice = await d.paused();
    assert.equal(atTwice.line, 5);
    await d.ask({ type: 'debug', action: 'breakpoints', set: [] });
    await d.ask({ type: 'debug', action: 'step', kind: 'over' });
    const ret = await d.paused();
    assert.equal(ret.line, 6);
    // twice returns into the module's statement, whose next call is add: over does not enter add
    await d.ask({ type: 'debug', action: 'step', kind: 'over' });
    const next = await d.paused();
    assert.equal(next.stack[0].name, '<module>');
    assert.equal(next.stack.length, 1);
    await d.ask({ type: 'debug', action: 'continue' });
    await d.next((m) => m.type === 'run.finished', 'run.finished');
  } finally {
    d.close();
  }
});

test('record: false: an uncaught exception is one error event at the statement counter', async () => {
  const d = new Driver();
  try {
    d.start({ 'main.js': 'let n = 0;\ntry { JSON.parse("{"); } catch { n++; }\nnull.x;\n' }, 'main.js', { record: false, stopOnEntry: false, breakOnException: 'off' });
    const fin = await d.next((m) => m.type === 'run.finished', 'run.finished');
    assert.equal(fin.exitCode, 1);
    const errors = d.seen.filter((m) => m.type === 'error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.handled, false);
    assert.equal(errors[0]!.errorType, 'TypeError');
    assert.ok(errors[0]!.traceback);
    assert.ok(errors[0]!.step >= 2);
  } finally {
    d.close();
  }
});

test('recordFrom a function: debugger speed up to its pause, then a midRun recording from step 0 with whole-run coverage', async () => {
  const d = new Driver();
  try {
    d.start({ 'main.js': PROGRAM }, 'main.js', { stopOnEntry: false, recordFrom: { function: 'add' }, recordLocals: true }, { breakpoints: [{ path: '', function: 'add' }] });
    const first = await d.paused();
    assert.equal(first.reason, 'breakpoint');
    assert.equal(first.recordingStarted, true);
    assert.equal(first.step, 0);
    // the scope-chain stack: add, under the module
    assert.deepEqual(first.stack.map((s: Msg) => s.name), ['add', '<module>']);
    assert.equal(first.stack[0].scopeId, first.scopeId);
    // nothing was recorded before the switch
    assert.ok(!d.seen.some((m) => m.type === 'log' || m.type === 'locals'));
    await d.ask({ type: 'debug', action: 'breakpoints', set: [] });
    await d.ask({ type: 'debug', action: 'continue' });
    const fin = await d.next((m) => m.type === 'run.finished', 'run.finished');
    assert.equal(fin.exitCode, 0);
    const trace = d.seen.filter((m) => m.type === 'trace' && !m.partial).pop()!;
    assert.equal(trace.midRun, true);
    const steps = stepsOf(trace);
    const scopes: Msg[] = trace.scopes;
    // step 0 is add's entry (flag 4) in its own scope, whose parent is the module
    assert.equal(steps[0]![1], first.scopeId);
    assert.equal(steps[0]![3] & 4, 4);
    const addScope = scopes.find((s) => s.scopeId === first.scopeId)!;
    assert.deepEqual([addScope.name, addScope.parent, addScope.first], ['add', 0, 0]);
    assert.equal(addScope.returned, '2');
    // the later calls are recorded as usual: two more adds and twice for i = 2, 3
    assert.equal(scopes.filter((s) => s.name === 'add').length, 3);
    assert.equal(scopes.filter((s) => s.name === 'twice').length, 2);
    // the console call after the switch is a log
    assert.ok(d.seen.some((m) => m.type === 'log' && m.text === 'total 12'));
    // coverage counts the statements before the switch too: `let total = 0` ran once, twice's body three times
    const file = d.seen.find((m) => m.type === 'file.instrumented')!;
    const cov = d.seen.find((m) => m.type === 'coverage')!;
    const ridOfLine = (line: number) => file.statements.find((rid: number) => file.ranges[rid - file.rangeBase][0] === line);
    assert.equal(cov.hits[ridOfLine(8) - file.rangeBase], 1);
    assert.equal(cov.hits[ridOfLine(6) - file.rangeBase], 3);
    // locals: `total` and `items` held their values before the switch, so they are no change; `total` changes later
    const locals = d.seen.filter((m) => m.type === 'locals').flatMap((m) => m.entries);
    const moduleChanges = locals.filter((e: Msg) => e.scopeId === 0).flatMap((e: Msg) => e.changes.map((c: Msg) => `${c.name}=${c.text}`));
    assert.ok(!moduleChanges.includes('items=[1, 2, 3]'), JSON.stringify(moduleChanges));
    assert.ok(!moduleChanges.includes('total=0'), JSON.stringify(moduleChanges));
    assert.ok(moduleChanges.includes('total=2'), JSON.stringify(moduleChanges));
  } finally {
    d.close();
  }
});

test('recordFrom: the record action starts the recording at the pause being served, and says so again after', async () => {
  const d = new Driver();
  try {
    // recordFrom names a statement that never runs: the recording starts only by hand
    const path = d.start({ 'main.js': PROGRAM }, 'main.js', { recordFrom: { path: '/nowhere.js', line: 1 } });
    const p = await d.paused();
    assert.equal(p.reason, 'start');
    assert.notEqual(p.recordingStarted, true);
    assert.equal(p.stack[0].frameId, 0); // the frame-chain shape: no recording yet
    let r = await d.ask({ type: 'debug', action: 'breakpoints', set: [{ path, line: 11 }] });
    await d.ask({ type: 'debug', action: 'continue' });
    const hit1 = await d.paused();
    assert.equal(hit1.line, 11);
    assert.notEqual(hit1.recordingStarted, true);
    await d.ask({ type: 'debug', action: 'continue' });
    const hit2 = await d.paused();
    assert.equal(hit2.line, 11);
    r = await d.ask({ type: 'debug', action: 'record' });
    assert.deepEqual([r.ok, r.recording, r.step, r.already], [true, true, 0, undefined]);
    const again = await d.paused(); // the same pause, announced again as step 0
    assert.deepEqual([again.recordingStarted, again.step, again.line, again.reason], [true, 0, 11, 'breakpoint']);
    assert.equal(again.stack[0].name, '<module>');
    assert.equal(again.stack[0].scopeId, 0);
    r = await d.ask({ type: 'debug', action: 'record' });
    assert.deepEqual([r.recording, r.already, r.step], [true, true, 0]);
    // a step into after the switch is a recorded step into twice
    await d.ask({ type: 'debug', action: 'breakpoints', set: [] });
    await d.ask({ type: 'debug', action: 'step', kind: 'into' });
    const into = await d.paused();
    assert.equal(into.stack[0].name, 'twice');
    assert.ok(into.step > 0);
    await d.ask({ type: 'debug', action: 'continue' });
    await d.next((m) => m.type === 'run.finished', 'run.finished');
    const trace = d.seen.filter((m) => m.type === 'trace' && !m.partial).pop()!;
    assert.equal(trace.midRun, true);
    const steps = stepsOf(trace);
    assert.equal(steps[0]![1], 0);
    assert.equal(trace.scopes.filter((s: Msg) => s.name === 'twice').length, 2);
  } finally {
    d.close();
  }
});

test('recordFrom: an async frame suspended at the switch gets its scope when it resumes', async () => {
  const src = [
    'async function work(n) {', //                   1
    '  const a = n + 1;', //                           2
    '  await new Promise((r) => setTimeout(r, 5));', // 3
    '  const b = a * 2;', //                           4
    '  return b;', //                                  5
    '}', //                                            6
    'function later() { return 1; }', //              7
    'const p = work(1);', //                           8
    'let x = later();', //                             9
    'p.then((v) => console.log("done", v, x));', //  10
  ].join('\n');
  const d = new Driver();
  try {
    d.start({ 'main.js': src }, 'main.js', { stopOnEntry: false, recordFrom: { function: 'later' } }, { breakpoints: [{ path: '', function: 'later' }] });
    const first = await d.paused();
    assert.equal(first.recordingStarted, true);
    assert.deepEqual(first.stack.map((s: Msg) => s.name), ['later', '<module>']);
    await d.ask({ type: 'debug', action: 'breakpoints', set: [] });
    await d.ask({ type: 'debug', action: 'continue' });
    await d.next((m) => m.type === 'run.finished', 'run.finished');
    const trace = d.seen.filter((m) => m.type === 'trace' && !m.partial).pop()!;
    const work = trace.scopes.find((s: Msg) => s.name === 'work');
    assert.ok(work, JSON.stringify(trace.scopes));
    assert.equal(work.returned, '4');
    assert.ok(work.first > 0);
    assert.ok(d.seen.some((m) => m.type === 'log' && m.text === 'done 4 1'), JSON.stringify(d.seen.filter((m) => m.type === 'log' || m.type === 'runner.error')));
  } finally {
    d.close();
  }
});
