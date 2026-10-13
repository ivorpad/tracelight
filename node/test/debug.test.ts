import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { Driver } from './driver.ts';
import type { Msg } from './helpers.ts';
import { decodeSteps } from '../src/protocol.ts';

const PROGRAM = [
  'function add(a, b) {', //            1
  '  const s = a + b;', //              2
  '  return s;', //                     3
  '}', //                               4
  'let total = 0;', //                  5
  'const items = [1, 2, 3];', //        6
  'for (const i of items) {', //        7
  '  total = add(total, i);', //        8
  '}', //                               9
  'console.log("total", total);', //   10
].join('\n');

test('stops on entry, steps into and over, reads locals and evaluates in the frame', async () => {
  const d = new Driver();
  try {
    d.start({ 'main.js': PROGRAM }, 'main.js');
    const first = await d.paused();
    assert.equal(first.reason, 'start');
    assert.equal(first.line, 5);
    assert.equal(first.thread.name, 'main');
    // to the call on line 8, then into add
    let r = await d.ask({ type: 'debug', action: 'breakpoints', set: [{ path: first.stack.length ? d.seen.find((m) => m.type === 'file.instrumented')!.path : '', line: 8 }] });
    assert.equal(r.type, 'debug.result');
    assert.equal(r.breakpoints[0].resolvedLine, 8);
    await d.ask({ type: 'debug', action: 'continue' });
    const atCall = await d.paused();
    assert.equal(atCall.reason, 'breakpoint');
    assert.equal(atCall.line, 8);
    r = await d.ask({ type: 'evaluate', expression: 'items.map(x => x * 10).join("+")' });
    assert.deepEqual([r.type, r.text], ['evaluated', "'10+20+30'"]);
    r = await d.ask({ type: 'evaluate', expression: 'items.push(4)' });
    assert.equal(r.type, 'error');
    assert.match(r.message, /cannot call `items.push` here/);
    await d.ask({ type: 'debug', action: 'step', kind: 'into' });
    const inAdd = await d.paused();
    assert.deepEqual([inAdd.reason, inAdd.kind, inAdd.line], ['step', 'into', 1]);
    assert.deepEqual(inAdd.stack.map((s: Msg) => s.name), ['add', '<module>']);
    await d.ask({ type: 'debug', action: 'step', kind: 'into' });
    const body = await d.paused();
    assert.equal(body.line, 2);
    r = await d.ask({ type: 'debug', action: 'locals' });
    const locals = Object.fromEntries(r.locals.map((l: Msg) => [l.name, l.text]));
    assert.equal(locals.a, '0');
    assert.equal(locals.b, '1');
    assert.ok(!Object.keys(locals).some((n) => n.startsWith('_tk')));
    // the CommonJS wrapper's names are the runtime's, not the program's
    for (const n of ['require', 'module', 'exports', '__filename', '__dirname']) assert.ok(!(n in locals), n);
    // each frame shows its own line: the caller its call site
    assert.deepEqual(body.stack.map((s: Msg) => s.line), [2, 8]);
    // out lands back on line 8's statement in the module, after the call
    await d.ask({ type: 'debug', action: 'step', kind: 'out' });
    const out = await d.paused();
    assert.equal(out.kind, 'out');
    assert.equal(out.stack.length, 1);
    await d.ask({ type: 'debug', action: 'breakpoints', set: [] });
    await d.ask({ type: 'debug', action: 'continue' });
    const fin = await d.next((m) => m.type === 'run.finished', 'run.finished');
    assert.equal(fin.exitCode, 0);
    assert.ok(d.seen.some((m) => m.type === 'log' && m.text === 'total 6'));
  } finally {
    d.close();
  }
});

test("`arguments` in locals is the paused function's own, never the CommonJS wrapper's", async () => {
  const d = new Driver();
  try {
    const src = [
      'function add(a, b) {', //                         1
      '  const sum = a + b;', //                         2
      '  return sum;', //                                3
      '}', //                                            4
      'function count() {', //                           5
      '  const n = arguments.length;', //                6
      '  return n;', //                                  7
      '}', //                                            8
      'console.log(add(2, 3), count(4, 5, 6));', //      9
    ].join('\n');
    d.start({ 'dbg.js': src }, 'dbg.js');
    await d.paused();
    let r = await d.ask({ type: 'debug', action: 'locals' });
    assert.ok(!r.locals.some((l: Msg) => l.name === 'arguments'), 'the module frame');
    const path = d.seen.find((m) => m.type === 'file.instrumented')!.path;
    await d.ask({ type: 'debug', action: 'breakpoints', set: [{ path, line: 3 }, { path, line: 7 }] });
    await d.ask({ type: 'debug', action: 'continue' });
    const inAdd = await d.paused();
    assert.deepEqual([inAdd.reason, inAdd.line], ['breakpoint', 3]);
    // add never reads `arguments`, so V8 keeps none for it, and the wrapper's stays hidden
    r = await d.ask({ type: 'debug', action: 'locals' });
    for (const n of ['a', 'b', 'sum']) assert.ok(r.locals.some((l: Msg) => l.name === n), n);
    assert.ok(!r.locals.some((l: Msg) => l.name === 'arguments'), 'add');
    r = await d.ask({ type: 'evaluate', expression: 'arguments' });
    assert.equal(r.text, "[Arguments] { '0': 2, '1': 3 }");
    await d.ask({ type: 'debug', action: 'continue' });
    const inCount = await d.paused();
    assert.deepEqual([inCount.reason, inCount.line], ['breakpoint', 7]);
    r = await d.ask({ type: 'debug', action: 'locals' });
    const locals = Object.fromEntries(r.locals.map((l: Msg) => [l.name, l.text]));
    assert.equal(locals.arguments, "[Arguments] { '0': 4, '1': 5, '2': 6 }");
    await d.ask({ type: 'debug', action: 'breakpoints', set: [] });
    await d.ask({ type: 'debug', action: 'continue' });
    const fin = await d.next((m) => m.type === 'run.finished', 'run.finished');
    assert.equal(fin.exitCode, 0);
  } finally {
    d.close();
  }
});

test('a conditional breakpoint, exec writes a local, and a function breakpoint', async () => {
  const d = new Driver();
  try {
    const path = d.start({ 'main.js': PROGRAM }, 'main.js', { stopOnEntry: false }, { breakpoints: [{ path: '', function: 'add' }] });
    void path;
    const atAdd = await d.paused();
    assert.equal(atAdd.reason, 'breakpoint');
    assert.equal(atAdd.breakpoint.function, 'add');
    assert.equal(atAdd.line, 1);
    let r = await d.ask({ type: 'debug', action: 'breakpoints', set: [{ path, line: 2, condition: 'b === 3' }] });
    assert.equal(r.breakpoints[0].condition, 'b === 3');
    await d.ask({ type: 'debug', action: 'continue' });
    const cond = await d.paused();
    assert.equal(cond.line, 2);
    r = await d.ask({ type: 'evaluate', expression: 'b' });
    assert.equal(r.text, '3');
    r = await d.ask({ type: 'exec', source: 'b = 100; a + b' });
    assert.equal(r.type, 'executed');
    assert.equal(r.modified, true);
    assert.equal(r.text, '103');
    r = await d.ask({ type: 'exec', source: 'b = 1000' });
    assert.equal(r.text, '');
    r = await d.ask({ type: 'exec', source: 'nope()' });
    assert.equal(r.exception.type, 'ReferenceError');
    await d.ask({ type: 'debug', action: 'breakpoints', set: [] });
    await d.ask({ type: 'debug', action: 'continue' });
    await d.next((m) => m.type === 'run.finished', 'run.finished');
    assert.ok(d.seen.some((m) => m.type === 'log' && m.text === 'total 1003'));
  } finally {
    d.close();
  }
});

test('break on a raised exception, with the frame live; then the uncaught pause', async () => {
  const src = [
    'function parse(text) {',
    '  const data = JSON.parse(text);',
    '  return data;',
    '}',
    'try { parse("{bad"); } catch (e) { console.log("caught"); }',
    'parse("[1, 2");',
  ].join('\n');
  const d = new Driver();
  try {
    d.start({ 'main.js': src }, 'main.js', { stopOnEntry: false, breakOnException: 'raised' });
    const raised = await d.paused();
    assert.equal(raised.reason, 'exception');
    assert.equal(raised.exception.type, 'SyntaxError');
    assert.equal(raised.exception.uncaught, false);
    assert.equal(raised.line, 2);
    let r = await d.ask({ type: 'evaluate', expression: 'text' });
    assert.equal(r.text, "'{bad'");
    await d.ask({ type: 'debug', action: 'continue' });
    const second = await d.paused();
    assert.equal(second.exception.uncaught, false);
    r = await d.ask({ type: 'evaluate', expression: 'text' });
    assert.equal(r.text, "'[1, 2'");
    await d.ask({ type: 'debug', action: 'continue' });
    const top = await d.paused();
    assert.equal(top.exception.uncaught, true);
    await d.ask({ type: 'debug', action: 'continue' });
    const fin = await d.next((m) => m.type === 'run.finished', 'run.finished');
    assert.equal(fin.exitCode, 1);
  } finally {
    d.close();
  }
});

test('a break-when watch pauses when its value changes', async () => {
  const d = new Driver();
  try {
    d.start({ 'main.js': PROGRAM }, 'main.js');
    await d.paused();
    const r = await d.ask({ type: 'debug', action: 'watches', set: [{ id: 'w1', exp: 'total', breakWhen: 'change' }] });
    assert.deepEqual(r.watches, [{ id: 'w1', exp: 'total', breakWhen: 'change' }]);
    await d.ask({ type: 'debug', action: 'continue' });
    const w = await d.paused();
    assert.equal(w.reason, 'watch');
    assert.equal(w.watch.text, '1');
    await d.ask({ type: 'debug', action: 'watches', set: [] });
    await d.ask({ type: 'debug', action: 'continue' });
    await d.next((m) => m.type === 'run.finished', 'run.finished');
  } finally {
    d.close();
  }
});

test('invalid breakpoint conditions stay disabled and evaluation failures explain their stop', async () => {
  const d = new Driver();
  try {
    const path = d.start({ 'main.js': 'let total = 0;\ntotal += 1;\ntotal += 2;\nconsole.log(total);\n' }, 'main.js');
    await d.paused();
    const set = await d.ask({ type: 'debug', action: 'breakpoints', set: [
      { path, line: 2, condition: 'total +' },
      { path, line: 3, condition: 'unknownName > 0' },
    ] });
    assert.match(set.breakpoints[0].error, /SyntaxError/);
    await d.ask({ type: 'debug', action: 'continue' });
    const stop = await d.paused();
    assert.equal(stop.line, 3, 'an invalid condition does not become an unconditional stop');
    assert.match(stop.conditionError, /ReferenceError.*unknownName/);
    assert.equal((await d.ask({ type: 'evaluate', expression: 'total' })).text, '1');
    await d.ask({ type: 'debug', action: 'breakpoints', set: [] });
    await d.ask({ type: 'debug', action: 'continue' });
    assert.equal((await d.next(m => m.type === 'run.finished')).exitCode, 0);
  } finally { d.close(); }
});

test('a conditional breakpoint refuses writes without changing its local', async () => {
  const d = new Driver();
  try {
    const path = d.start({ 'main.js': 'let total = 0;\ntotal += 1;\nconsole.log(total);\n' }, 'main.js');
    await d.paused();
    await d.ask({ type: 'debug', action: 'breakpoints', set: [{ path, line: 2, condition: 'total++' }] });
    await d.ask({ type: 'debug', action: 'continue' });
    const stop = await d.paused();
    assert.equal(stop.line, 2);
    assert.match(stop.conditionError, /side effect|side-effect/i);
    assert.equal((await d.ask({ type: 'evaluate', expression: 'total' })).text, '0');
    await d.ask({ type: 'debug', action: 'breakpoints', set: [] });
    await d.ask({ type: 'debug', action: 'continue' });
    await d.next(m => m.type === 'run.finished');
    assert.ok(d.seen.some(m => m.type === 'log' && m.text === '1'));
  } finally { d.close(); }
});

test('truth watches stop on each false-to-true transition and reject unknown modes', async () => {
  const d = new Driver();
  try {
    d.start({ 'main.js': 'let total = 0;\ntotal = 1;\ntotal = 2;\ntotal = 0;\ntotal = 1;\nconsole.log(total);\n' }, 'main.js');
    await d.paused();
    const set = await d.ask({ type: 'debug', action: 'watches', set: [
      { id: 'bad', exp: 'total', breakWhen: 'sometimes' },
      { id: 'truth', exp: 'total > 0', breakWhen: 'true' },
    ] });
    assert.match(set.watches[0].error, /unknown watch mode/);
    await d.ask({ type: 'debug', action: 'continue' });
    const first = await d.paused();
    assert.equal(first.line, 3);
    assert.equal(first.watch.id, 'truth');
    assert.equal(first.watch.text, 'true');
    await d.ask({ type: 'debug', action: 'continue' });
    const second = await d.paused();
    assert.equal(second.line, 6, 'remaining true does not cause repeated stops');
    await d.ask({ type: 'debug', action: 'watches', set: [] });
    await d.ask({ type: 'debug', action: 'continue' });
    await d.next(m => m.type === 'run.finished');
  } finally { d.close(); }
});

test('watch evaluation errors stop once with a reason and never run a refused write', async () => {
  const d = new Driver();
  try {
    d.start({ 'main.js': 'let total = 0;\ntotal += 1;\ntotal += 2;\nconsole.log(total);\n' }, 'main.js');
    await d.paused();
    await d.ask({ type: 'debug', action: 'watches', set: [{ id: 'write', exp: 'total++', breakWhen: 'change' }] });
    await d.ask({ type: 'debug', action: 'continue' });
    const stop = await d.paused();
    assert.equal(stop.reason, 'watch');
    assert.equal(stop.watch.id, 'write');
    assert.match(stop.watch.error, /side effect|side-effect/i);
    assert.equal((await d.ask({ type: 'evaluate', expression: 'total' })).text, '0');
    await d.ask({ type: 'debug', action: 'continue' });
    const fin = await d.next(m => m.type === 'run.finished');
    assert.equal(fin.exitCode, 0, 'the same failed watch does not stop repeatedly');
    assert.ok(d.seen.some(m => m.type === 'log' && m.text === '3'));
  } finally { d.close(); }
});

test('conditional logpoints interpolate pure expressions without stopping the program', async () => {
  const d = new Driver();
  try {
    const src = 'let total = 0;\nfor (const n of [1, 2, 3]) {\n  total += n;\n}\nconsole.log("sum", total);\n';
    const path = d.start({ 'main.js': src }, 'main.js');
    await d.paused();
    const set = await d.ask({ type: 'debug', action: 'breakpoints', set: [
      { path, line: 3, condition: 'n > 1', logMessage: '{{total}}={total}, square={n * n}, nested={({ a: n }).a}' },
      { path, line: 5, logMessage: 'invalid {total +}' },
    ] });
    assert.match(set.breakpoints[1].error, /SyntaxError.*logMessage/);
    await d.ask({ type: 'debug', action: 'continue' });
    assert.equal((await d.next(m => m.type === 'run.finished')).exitCode, 0);
    const logs = d.seen.filter(m => m.type === 'output' && m.logpoint);
    assert.deepEqual(logs.map(m => m.text), ['{total}=1, square=4, nested=2\n', '{total}=3, square=9, nested=3\n']);
    assert.ok(logs.every(m => typeof m.step === 'number'));
    assert.equal(d.seen.filter(m => m.type === 'debug.paused').length, 1, 'logpoints never add a successful pause');
    assert.ok(d.seen.some(m => m.type === 'log' && m.text === 'sum 6'));
  } finally { d.close(); }
});

test('a refused logpoint interpolation stops with an error instead of changing state', async () => {
  const d = new Driver();
  try {
    const path = d.start({ 'main.js': 'let total = 0;\ntotal += 1;\nconsole.log(total);\n' }, 'main.js');
    await d.paused();
    await d.ask({ type: 'debug', action: 'breakpoints', set: [{ path, line: 2, logMessage: 'before {total++}' }] });
    await d.ask({ type: 'debug', action: 'continue' });
    const stop = await d.paused();
    assert.equal(stop.reason, 'breakpoint');
    assert.match(stop.conditionError, /logpoint:.*side effect|logpoint:.*side-effect/i);
    assert.equal((await d.ask({ type: 'evaluate', expression: 'total' })).text, '0');
    assert.ok(!d.seen.some(m => m.logpoint));
    await d.ask({ type: 'debug', action: 'breakpoints', set: [] });
    await d.ask({ type: 'debug', action: 'continue' });
    await d.next(m => m.type === 'run.finished');
    assert.ok(d.seen.some(m => m.type === 'log' && m.text === '1'));
  } finally { d.close(); }
});

test('multiple logpoints coexist with a stopping breakpoint in both main-thread modes', async () => {
  for (const record of [true, false]) {
    const d = new Driver();
    try {
      const path = d.start({ 'main.js': 'let total = 0;\ntotal += 1;\nconsole.log(total);\n' }, 'main.js', { record });
      await d.paused();
      await d.ask({ type: 'debug', action: 'breakpoints', set: [
        { path, line: 2, logMessage: 'first {total}' },
        { path, line: 2, condition: 'total === 0' },
        { path, line: 2, logMessage: 'second {total + 1}' },
      ] });
      await d.ask({ type: 'debug', action: 'continue' });
      const stop = await d.paused();
      assert.equal(stop.reason, 'breakpoint');
      assert.equal(stop.line, 2);
      assert.equal(stop.breakpoint.condition, 'total === 0');
      assert.deepEqual(d.seen.filter(m => m.logpoint).map(m => m.text), ['first 0\n', 'second 1\n']);
      await d.ask({ type: 'debug', action: 'continue' });
      assert.equal((await d.next(m => m.type === 'run.finished')).exitCode, 0);
      assert.equal(d.seen.filter(m => m.logpoint).length, 2, 'resume does not emit the same logpoints again');
    } finally { d.close(); }
  }
});

test('names-only and selected locals never inspect an unrequested object', async () => {
  const d = new Driver();
  try {
    const src = 'let reads = 0;\nconst hidden = new Proxy({ value: 42 }, { ownKeys(target) { reads++; return Reflect.ownKeys(target); } });\nconst selected = 7;\nconsole.log(selected);\n';
    const path = d.start({ 'main.js': src }, 'main.js', { record: false });
    await d.paused();
    await d.ask({ type: 'debug', action: 'breakpoints', set: [{ path, line: 4 }] });
    await d.ask({ type: 'debug', action: 'continue' });
    await d.paused();
    const names = await d.ask({ type: 'debug', action: 'locals', namesOnly: true });
    assert.ok(names.locals.some((value: Msg) => value.name === 'hidden' && value.type === 'proxy'));
    assert.ok(names.locals.every((value: Msg) => value.text === '' && !value.valueBag));
    const chosen = await d.ask({ type: 'debug', action: 'locals', names: ['selected'] });
    assert.deepEqual(chosen.locals.map((value: Msg) => [value.name, value.text]), [['selected', '7']]);
    assert.equal((await d.ask({ type: 'evaluate', expression: 'reads' })).text, '0');
    assert.deepEqual((await d.ask({ type: 'debug', action: 'locals', names: [] })).locals, []);
    const invalid = await d.ask({ type: 'debug', action: 'locals', names: [1] });
    assert.match(invalid.message, /names must be an array of strings/);
    await d.ask({ type: 'debug', action: 'breakpoints', set: [] });
    await d.ask({ type: 'debug', action: 'continue' });
    assert.equal((await d.next(m => m.type === 'run.finished')).exitCode, 0);
  } finally { d.close(); }
});

test('worker line logpoints use their own frame and resume after a false condition', async () => {
  const d = new Driver();
  try {
    const src = `import { Worker, isMainThread, parentPort } from 'node:worker_threads';
function compute(n) {
  return n * 2;
}
if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  worker.on('message', value => console.log('answer', value));
} else {
  const a = compute(1);
  const b = compute(2);
  parentPort.postMessage(a + b);
}
`;
    const path = d.start({ 'main.mjs': src }, 'main.mjs');
    await d.paused();
    await d.ask({ type: 'debug', action: 'breakpoints', set: [{ path, line: 3, condition: 'n === 2', logMessage: 'result {n * 2}' }] });
    await d.ask({ type: 'debug', action: 'continue' });
    assert.equal((await d.next(m => m.type === 'run.finished')).exitCode, 0);
    const logs = d.seen.filter(m => m.type === 'output' && m.logpoint);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].text, 'result 4\n');
    assert.ok(logs[0].thread.ident > 0);
    assert.equal(d.seen.filter(m => m.type === 'debug.paused').length, 1);
    assert.ok(d.seen.some(m => m.type === 'log' && m.text === 'answer 6'));
  } finally { d.close(); }
});

test('worker logpoints coexist with stopping line and function breakpoints', async () => {
  for (const functionBreakpoint of [false, true]) {
    const d = new Driver();
    try {
      const src = `import { Worker, isMainThread, parentPort } from 'node:worker_threads';
function compute(n) {
  return n * 2;
}
if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  worker.on('message', value => console.log('answer', value));
} else {
  const a = compute(1);
  const b = compute(2);
  parentPort.postMessage(a + b);
}
`;
      const path = d.start({ 'main.mjs': src }, 'main.mjs');
      await d.paused();
      const location = functionBreakpoint ? { path, function: 'compute' } : { path, line: 3 };
      const set = await d.ask({ type: 'debug', action: 'breakpoints', set: [
        { ...location, logMessage: 'first {n}' },
        { ...location, condition: 'n === 2' },
        { ...location, logMessage: 'second {n * 2}' },
        { path, line: 11, logMessage: 'invalid {n +}' },
      ] });
      assert.match(set.breakpoints[3].error, /SyntaxError/);
      await d.ask({ type: 'debug', action: 'continue' });
      const stop = await d.paused();
      assert.equal(stop.reason, 'breakpoint');
      assert.ok(stop.thread.ident > 0);
      assert.equal(stop.breakpoint.condition, 'n === 2');
      assert.equal((await d.ask({ type: 'evaluate', expression: 'n' })).text, '2');
      assert.deepEqual(d.seen.filter(m => m.logpoint).map(m => m.text), ['first 1\n', 'second 2\n', 'first 2\n', 'second 4\n']);
      await d.ask({ type: 'debug', action: 'continue' });
      assert.equal((await d.next(m => m.type === 'run.finished')).exitCode, 0);
      assert.equal(d.seen.filter(m => m.type === 'debug.paused').length, 2);
      assert.equal(d.seen.filter(m => m.logpoint).length, 4);
    } finally { d.close(); }
  }
});

test('worker function conditions skip false calls and report refused writes', async () => {
  const src = `import { Worker, isMainThread, parentPort } from 'node:worker_threads';
function compute(n) {
  return n * 2;
}
if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  worker.on('message', value => console.log('answer', value));
} else {
  const a = compute(1);
  const b = compute(2);
  parentPort.postMessage(a + b);
}
`;
  for (const condition of ['n === 2', 'n++']) {
    const d = new Driver();
    try {
      d.start({ 'main.mjs': src }, 'main.mjs', { stopOnEntry: false }, { breakpoints: [{ function: 'compute', condition }] });
      const stop = await d.paused();
      assert.equal(stop.reason, 'breakpoint');
      assert.ok(stop.thread.ident > 0);
      const n = await d.ask({ type: 'evaluate', expression: 'n' });
      if (condition === 'n === 2') {
        assert.equal(n.text, '2');
        assert.equal(stop.conditionError, undefined);
      } else {
        assert.equal(n.text, '1');
        assert.match(stop.conditionError, /side effect|side-effect/i);
      }
      await d.ask({ type: 'debug', action: 'breakpoints', set: [] });
      await d.ask({ type: 'debug', action: 'continue' });
      assert.equal((await d.next(m => m.type === 'run.finished')).exitCode, 0);
      assert.ok(d.seen.some(m => m.type === 'log' && m.text === 'answer 6'));
    } finally { d.close(); }
  }
});

test('after the run: evaluate and complete against the finished namespace, exec refused', async () => {
  const d = new Driver();
  try {
    d.start({ 'main.js': PROGRAM }, 'main.js', { debug: false });
    await d.next((m) => m.type === 'run.finished', 'run.finished');
    let r = await d.ask({ type: 'evaluate', expression: 'total * 2' });
    assert.deepEqual([r.type, r.text], ['evaluated', '12']);
    r = await d.ask({ type: 'evaluate', expression: 'items.pop()' });
    assert.equal(r.type, 'error');
    r = await d.ask({ type: 'complete', expression: 'ite' });
    assert.equal(r.type, 'completed');
    assert.equal(r.prefix, 'ite');
    assert.deepEqual(r.items.map((i: Msg) => i.label), ['items']);
    r = await d.ask({ type: 'complete', expression: 'items.fi' });
    assert.ok(r.items.some((i: Msg) => i.label === 'filter' && i.kind === 'method'), JSON.stringify(r));
    r = await d.ask({ type: 'exec', source: 'total = 0' });
    assert.match(r.message, /the run has ended/);
    // shadow: what an edited statement would show, nothing written
    r = await d.ask({ type: 'shadow', source: 'console.log("sum", total, items.length)' });
    assert.deepEqual([r.type, r.kind, r.context, r.text], ['evaluated', 'log', 'console.log', 'sum 6 3']);
    r = await d.ask({ type: 'shadow', source: 'const doubled = total * 2' });
    assert.deepEqual([r.kind, r.context, r.text], ['value', 'doubled', '12']);
    r = await d.ask({ type: 'shadow', source: 'total = total + 1' });
    assert.deepEqual([r.kind, r.context, r.text], ['value', 'total', '7']);
    r = await d.ask({ type: 'evaluate', expression: 'total' });
    assert.equal(r.text, '6', 'shadow wrote nothing');
    r = await d.ask({ type: 'shadow', source: 'items.push(4)' });
    assert.equal(r.type, 'error');
    r = await d.ask({ type: 'shadow', source: 'if (total) {}' });
    assert.match(r.message, /not a value-producing statement/);
  } finally {
    d.close();
  }
});

test('watch expressions at a step: evaluated in the stepping frame across the prefetch window', async () => {
  const d = new Driver();
  try {
    d.start({ 'main.js': PROGRAM }, 'main.js', { debug: false }, {
      watch: [{ id: 'w1', exp: 'total' }, { id: 'w2', exp: 'items.length * 10' }, { id: 'w3', exp: 'total +' }],
      traceContext: { step: 3, prefetch: 4 },
    });
    await d.next((m) => m.type === 'run.finished', 'run.finished');
    const watches = d.seen.filter((m) => m.type === 'watch');
    const bad = watches.filter((w) => w.watchId === 'w3');
    assert.equal(bad.length, 1);
    assert.match(bad[0]!.error, /^SyntaxError/);
    const w1 = watches.filter((w) => w.watchId === 'w1');
    assert.deepEqual(w1.map((w) => w.step), [3, 4, 5, 6]);
    assert.ok(w1.every((w) => w.valueBag.data.type === 'number'));
    const w2 = watches.filter((w) => w.watchId === 'w2');
    assert.ok(w2.every((w) => w.valueBag.data.value === '30'));
  } finally {
    d.close();
  }
});

test('an uncaught exception from an async function pauses on the frame that raised it, after it returned', async () => {
  const src = [
    'async function load(name) {', //            1
    '  const key = name.toUpperCase();', //      2
    '  await null;', //                          3
    '  throw new Error("missing " + key);', //   4
    '}', //                                      5
    'async function main() {', //                6
    '  const who = "ada";', //                   7
    '  await load(who);', //                     8
    '}', //                                      9
    'main();', //                               10
  ].join('\n');
  const d = new Driver();
  try {
    d.start({ 'main.mjs': src }, 'main.mjs', { stopOnEntry: false, breakOnException: 'uncaught' });
    const top = await d.paused();
    assert.equal(top.reason, 'exception');
    assert.deepEqual(top.exception, { type: 'Error', message: 'missing ADA', uncaught: true });
    assert.equal(top.line, 4);
    let r = await d.ask({ type: 'evaluate', expression: 'key + "!"' });
    assert.equal(r.text, "'ADA!'");
    r = await d.ask({ type: 'debug', action: 'locals' });
    assert.deepEqual(r.locals.map((l: Msg) => l.name).sort(), ['key', 'name']);
    r = await d.ask({ type: 'exec', source: 'key = 1' });
    assert.match(r.message, /has returned/);
    await d.ask({ type: 'debug', action: 'continue' });
    const err = await d.next((m) => m.type === 'error' && m.id === undefined, 'error');
    assert.match(err.message, /missing ADA/);
    const fin = await d.next((m) => m.type === 'run.finished', 'run.finished');
    assert.equal(fin.exitCode, 1);
    assert.equal(d.seen.filter((m) => m.type === 'debug.paused').length, 1);
  } finally {
    d.close();
  }
});

test('raised mode on an async throw: the sighting, then the uncaught pause from the snapshot', async () => {
  const src = 'async function f(x) {\n  await null;\n  throw new TypeError("bad " + x);\n}\nf(3);\n';
  const d = new Driver();
  try {
    d.start({ 'main.mjs': src }, 'main.mjs', { stopOnEntry: false, breakOnException: 'raised' });
    const first = await d.paused();
    assert.deepEqual([first.line, first.exception.uncaught], [3, false]);
    await d.ask({ type: 'debug', action: 'continue' });
    const top = await d.paused();
    assert.deepEqual([top.line, top.exception.uncaught, top.exception.type], [3, true, 'TypeError']);
    const r = await d.ask({ type: 'evaluate', expression: 'x * 2' });
    assert.equal(r.text, '6');
    await d.ask({ type: 'debug', action: 'continue' });
    assert.equal((await d.next((m) => m.type === 'run.finished', 'run.finished')).exitCode, 1);
  } finally {
    d.close();
  }
});

test('a breakpoint in a worker thread pauses that thread: its frames, evaluate, locals, step, continue', async () => {
  const main = [
    "const { Worker } = require('node:worker_threads');", // 1
    "const w = new Worker(require('node:path').join(__dirname, 'job.js'), { workerData: 7, name: 'squarer' });", // 2
    "w.on('message', (m) => console.log('got', m));", // 3
  ].join('\n');
  const job = [
    "const { parentPort, workerData } = require('node:worker_threads');", // 1
    'function square(n) {', // 2
    '  const r = n * n;', // 3
    '  return r;', // 4
    '}', // 5
    'parentPort.postMessage(square(workerData));', // 6
  ].join('\n');
  const d = new Driver();
  try {
    const path = d.start({ 'main.js': main, 'job.js': job }, 'main.js');
    assert.equal((await d.paused()).reason, 'start');
    const jobPath = join(dirname(path), 'job.js');
    await d.ask({ type: 'debug', action: 'breakpoints', set: [{ path: jobPath, line: 3 }] });
    await d.ask({ type: 'debug', action: 'continue' });
    const p = await d.paused();
    assert.equal(p.reason, 'breakpoint');
    assert.equal(p.thread.name, 'squarer');
    assert.ok(p.thread.ident > 0);
    assert.equal(p.line, 3);
    // the worker's files are recorded too: the pause names its file and its step in the merged trace
    assert.equal(d.seen.find((m) => m.type === 'file.instrumented' && m.fileId === p.fileId)?.path, jobPath);
    const sent = d.seen.filter((m) => m.type === 'trace' && m.partial).reduce((n, m) => Math.max(n, m.offset + decodeSteps(m.steps).length / 4), 0);
    assert.ok(p.step >= 0 && p.step < sent, `the pause's step ${p.step} went out in a delta (${sent})`);
    assert.deepEqual(p.stack.map((s: Msg) => [s.name, s.line]), [['square', 3], ['<module>', 6]]);
    let r = await d.ask({ type: 'evaluate', expression: 'n * 10' });
    assert.equal(r.text, '70');
    r = await d.ask({ type: 'debug', action: 'locals' });
    assert.deepEqual(r.locals.map((l: Msg) => l.name), ['n']); // r is not bound yet
    r = await d.ask({ type: 'evaluate', expression: 'workerData', frameId: 1 });
    assert.equal(r.text, '7');
    await d.ask({ type: 'debug', action: 'step', kind: 'over' });
    const s = await d.paused();
    assert.deepEqual([s.reason, s.kind, s.line, s.thread.name], ['step', 'over', 4, 'squarer']);
    r = await d.ask({ type: 'debug', action: 'locals' });
    assert.equal(r.locals.find((l: Msg) => l.name === 'r').text, '49');
    await d.ask({ type: 'debug', action: 'continue' });
    const fin = await d.next((m) => m.type === 'run.finished', 'run.finished');
    assert.equal(fin.exitCode, 0);
    assert.ok(d.seen.some((m) => m.type === 'log' && m.text === 'got 49'));
  } finally {
    d.close();
  }
});

test('a function breakpoint in a worker thread pauses at its entry, on the worker step of the merged trace', async () => {
  const main = [
    "const { Worker } = require('node:worker_threads');", // 1
    "const w = new Worker(require('node:path').join(__dirname, 'job.js'), { workerData: 5 });", // 2
    "w.on('message', (m) => console.log('got', m));", // 3
  ].join('\n');
  const job = [
    "const { parentPort, workerData } = require('node:worker_threads');", // 1
    'function cube(n) {', // 2
    '  const sq = n * n;', // 3
    '  return sq * n;', // 4
    '}', // 5
    'const first = 1;', // 6
    'parentPort.postMessage(cube(workerData) + first);', // 7
  ].join('\n');
  const d = new Driver();
  try {
    d.start({ 'main.js': main, 'job.js': job }, 'main.js');
    assert.equal((await d.paused()).reason, 'start');
    await d.ask({ type: 'debug', action: 'breakpoints', set: [{ function: 'cube' }] });
    await d.ask({ type: 'debug', action: 'continue' });
    const p = await d.paused();
    assert.deepEqual([p.reason, p.line], ['breakpoint', 2]);
    assert.ok(p.thread.ident > 0);
    assert.match(p.thread.name, /^(Worker \d+|WorkerThread)$/);
    assert.equal(p.breakpoint.function, 'cube');
    let r = await d.ask({ type: 'evaluate', expression: 'n + 1' });
    assert.equal(r.text, '6');
    await d.ask({ type: 'debug', action: 'step', kind: 'over' });
    const s1 = await d.paused();
    assert.deepEqual([s1.reason, s1.line], ['step', 3]);
    assert.ok(s1.step > p.step);
    await d.ask({ type: 'debug', action: 'step', kind: 'over' });
    const s2 = await d.paused();
    assert.deepEqual([s2.reason, s2.line], ['step', 4]);
    r = await d.ask({ type: 'debug', action: 'locals' });
    assert.equal(r.locals.find((l: Msg) => l.name === 'sq').text, '25');
    await d.ask({ type: 'debug', action: 'continue' });
    const fin = await d.next((m) => m.type === 'run.finished', 'run.finished');
    assert.equal(fin.exitCode, 0);
    assert.ok(d.seen.some((m) => m.type === 'log' && m.text === 'got 126'));
    // every pause's step is that worker statement in the final trace
    const trace = d.seen.filter((m) => m.type === 'trace' && !m.partial).pop()!;
    const steps = decodeSteps(trace.steps);
    const scopes = new Map(trace.scopes.map((sc: Msg) => [sc.scopeId, sc]));
    for (const q of [p, s1, s2]) {
      const sc = scopes.get(steps[q.step * 4 + 1]!) as Msg;
      assert.deepEqual([sc.name, sc.thread?.ident], ['cube', p.thread.ident], `step ${q.step}`);
    }
    assert.equal(steps[p.step * 4 + 3]! & 4, 4, 'the entry step');
  } finally {
    d.close();
  }
});

test('stepping in a recorded worker goes statement by statement: into a call, out of it', async () => {
  const main = [
    "const { Worker } = require('node:worker_threads');", // 1
    "new Worker(require('node:path').join(__dirname, 'job.js'));", // 2
  ].join('\n');
  const job = [
    'function add(a, b) {', // 1
    '  const s = a + b;', // 2
    '  return s;', // 3
    '}', // 4
    'let x = 1;', // 5
    'x = add(x, 2) + add(x, 3);', // 6
    'console.log(x);', // 7
  ].join('\n');
  const d = new Driver();
  try {
    const path = d.start({ 'main.js': main, 'job.js': job }, 'main.js');
    assert.equal((await d.paused()).reason, 'start');
    await d.ask({ type: 'debug', action: 'breakpoints', set: [{ path: join(dirname(path), 'job.js'), line: 6 }] });
    await d.ask({ type: 'debug', action: 'continue' });
    const p = await d.paused();
    assert.deepEqual([p.reason, p.line], ['breakpoint', 6]);
    const lines: [string, number][] = [];
    for (const kind of ['into', 'over', 'out']) {
      await d.ask({ type: 'debug', action: 'step', kind });
      const s = await d.paused();
      lines.push([kind, s.line]);
    }
    // into add (its entry, then a statement), out to the next statement of its caller (the
    // second call records nothing in the module's scope)
    assert.deepEqual(lines, [['into', 1], ['over', 2], ['out', 7]]);
    await d.ask({ type: 'debug', action: 'continue' });
    const fin = await d.next((m) => m.type === 'run.finished', 'run.finished');
    assert.equal(fin.exitCode, 0);
    // the debugger's evaluations at the stops did not cost the recording its call chain
    const trace = d.seen.filter((m) => m.type === 'trace' && !m.partial).pop()!;
    const worker = trace.scopes.find((sc: Msg) => sc.name.startsWith('<worker'));
    const adds = trace.scopes.filter((sc: Msg) => sc.name === 'add');
    assert.deepEqual(adds.map((sc: Msg) => [sc.parent, sc.asyncParent]), [[worker.scopeId, undefined], [worker.scopeId, undefined]]);
  } finally {
    d.close();
  }
});

test('a main-thread pause while a worker runs comes after the worker steps it received from', async () => {
  const main = [
    "const { Worker } = require('node:worker_threads');", // 1
    "const w = new Worker(require('node:path').join(__dirname, 'job.js'));", // 2
    "w.on('message', (m) => {", // 3
    '  const got = m;', // 4
    "  console.log('got', got);", // 5
    '  w.terminate();', // 6
    '});', // 7
  ].join('\n');
  const job = [
    "const { parentPort } = require('node:worker_threads');", // 1
    'let total = 0;', // 2
    'for (let i = 0; i < 50; i++) total += i;', // 3
    'parentPort.postMessage(total);', // 4
    'setInterval(() => { total++; }, 5);', // 5
  ].join('\n');
  const d = new Driver();
  try {
    const path = d.start({ 'main.js': main, 'job.js': job }, 'main.js');
    assert.equal((await d.paused()).reason, 'start');
    await d.ask({ type: 'debug', action: 'breakpoints', set: [{ path, line: 4 }] });
    await d.ask({ type: 'debug', action: 'continue' });
    const p = await d.paused();
    assert.deepEqual([p.reason, p.line, p.thread.name], ['breakpoint', 4, 'main']);
    // the deltas before the pause hold the worker's loop, before the pause's step
    const deltas = d.seen.filter((m) => m.type === 'trace' && m.partial);
    const scopes = new Map<number, Msg>();
    for (const t of deltas) for (const sc of t.scopes) scopes.set(sc.scopeId, sc);
    const workerSteps: number[] = [];
    for (const t of deltas) {
      const q = decodeSteps(t.steps);
      // the worker's module scope (its loop and postMessage); its interval callbacks may follow the pause
      for (let i = 0; i < q.length; i += 4) {
        const sc = scopes.get(q[i + 1]!);
        if (sc?.thread && sc.parent === 0 && sc.name !== '<arrow>') workerSteps.push(t.offset + i / 4);
      }
    }
    assert.ok(workerSteps.length >= 50, `worker steps in the deltas (${workerSteps.length})`);
    assert.ok(workerSteps.every((s) => s < p.step), 'the worker\'s module steps come before the pause');
    const sent = deltas.reduce((n, m) => Math.max(n, m.offset + decodeSteps(m.steps).length / 4), 0);
    assert.ok(p.step < sent, 'the pause step went out');
    await d.ask({ type: 'debug', action: 'continue' });
    const fin = await d.next((m) => m.type === 'run.finished', 'run.finished');
    assert.equal(fin.exitCode, 0);
    assert.ok(d.seen.some((m) => m.type === 'log' && m.text === 'got 1225'));
  } finally {
    d.close();
  }
});

test('an exception nobody catches in a worker thread pauses in the frame that raised it', async () => {
  const main = [
    "const { Worker } = require('node:worker_threads');",
    "const w = new Worker(require('node:path').join(__dirname, 'job.js'), { workerData: 3 });",
    "w.on('error', (e) => console.log('worker failed:', e.message));",
  ].join('\n');
  const job = [
    "const { workerData } = require('node:worker_threads');", // 1
    'function check(n) {', // 2
    '  const limit = 2;', // 3
    '  if (n > limit) throw new RangeError("too big: " + n);', // 4
    '}', // 5
    'check(workerData);', // 6
  ].join('\n');
  const d = new Driver();
  try {
    d.start({ 'main.js': main, 'job.js': job }, 'main.js', { stopOnEntry: false, breakOnException: 'uncaught' });
    const p = await d.paused();
    assert.equal(p.reason, 'exception');
    assert.deepEqual(p.exception, { type: 'RangeError', message: 'too big: 3', uncaught: true });
    assert.ok(p.thread.ident > 0);
    assert.match(p.thread.name, /^(Worker \d+|WorkerThread)$/);
    assert.deepEqual(p.stack.map((s: Msg) => [s.name, s.line]), [['check', 4], ['<module>', 6]]);
    const r = await d.ask({ type: 'evaluate', expression: 'n - limit' });
    assert.equal(r.text, '1');
    await d.ask({ type: 'debug', action: 'continue' });
    const fin = await d.next((m) => m.type === 'run.finished', 'run.finished');
    assert.equal(fin.exitCode, 0);
    assert.ok(d.seen.some((m) => m.type === 'log' && m.text === 'worker failed: too big: 3'));
    assert.equal(d.seen.filter((m) => m.type === 'debug.paused').length, 1);
  } finally {
    d.close();
  }
});

test('a main-thread breakpoint reached while a worker thread is held pauses the main thread once the worker goes on', async () => {
  const main = [
    "const { Worker } = require('node:worker_threads');", // 1
    "const w = new Worker(require('node:path').join(__dirname, 'job.js'));", // 2
    "w.on('message', (m) => m === 'started' ? setTimeout(tick, 300) : console.log('worker said', m));", // 3
    'function tick() {', // 4
    '  const z = 1;', // 5
    "  console.log('main tick', z);", // 6
    '}', // 7
  ].join('\n');
  const job = [
    "const { parentPort } = require('node:worker_threads');", // 1
    "parentPort.postMessage('started');", // 2
    'const v = 42;', // 3
    'parentPort.postMessage(v);', // 4
  ].join('\n');
  const d = new Driver();
  try {
    const path = d.start({ 'main.js': main, 'job.js': job }, 'main.js');
    assert.equal((await d.paused()).reason, 'start');
    await d.ask({ type: 'debug', action: 'breakpoints', set: [{ path: join(dirname(path), 'job.js'), line: 4 }, { path, line: 5 }] });
    await d.ask({ type: 'debug', action: 'continue' });
    const inWorker = await d.paused();
    assert.notEqual(inWorker.thread.name, 'main');
    // the main thread's timer comes due while the worker is held; it must not deadlock the relay
    await new Promise((r) => setTimeout(r, 900));
    const r = await d.ask({ type: 'evaluate', expression: 'v + 1' });
    assert.equal(r.text, '43');
    await d.ask({ type: 'debug', action: 'continue' });
    const inMain = await d.paused();
    assert.equal(inMain.thread.name, 'main');
    await d.ask({ type: 'debug', action: 'breakpoints', set: [] });
    await d.ask({ type: 'debug', action: 'continue' });
    const fin = await d.next((m) => m.type === 'run.finished', 'run.finished');
    assert.equal(fin.exitCode, 0);
    assert.ok(d.seen.some((m) => m.type === 'log' && m.text === 'main tick 1'));
    assert.ok(d.seen.some((m) => m.type === 'log' && m.text === 'worker said 42'));
  } finally {
    d.close();
  }
});
