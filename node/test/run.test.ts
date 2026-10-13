import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from './helpers.ts';
import { FLAG_ERROR, FLAG_LOG, FLAG_SCOPE_ENTRY, FLAG_UNWINDING } from '../src/protocol.ts';

test('a TypeScript ESM run: values, console, trace, coverage, run.finished', async () => {
  const src = [
    'const xs: number[] = [1, 2, 3];',
    'function double(n: number): number {',
    '  return n * 2;',
    '}',
    'const ys = xs.map(double); // ?',
    'console.log("sum", ys.reduce((a, b) => a + b, 0));',
    'ys',
  ].join('\n');
  const r = await run({ 'main.ts': src }, 'main.ts');
  assert.equal(r.finished.exitCode, 0);
  assert.equal(r.finished.timedOut, false);
  const logs = r.logs();
  assert.deepEqual(logs.map((l) => [l.kind, r.line(l.rid), l.text]), [
    ['value', 5, '[ 2, 4, 6 ]'],
    ['log', 6, 'sum 12'],
    ['value', 7, '[ 2, 4, 6 ]'],
  ]);
  assert.equal(logs[0]!.valueBag.data.type, 'list');
  assert.equal(logs[0]!.valueBag.data.props.length, 3);
  // every log flags its step
  for (const l of logs) assert.ok(r.steps()[l.step]![3]! & FLAG_LOG);
  // three calls of double, each a scope at depth 1 under the module, entered with flag 4
  const doubles = r.scopes().filter((s) => s.name === 'double');
  assert.equal(doubles.length, 3);
  for (const s of doubles) {
    assert.equal(s.parent, 0);
    assert.equal(s.depth, 1);
    assert.ok(r.steps()[s.first]![3]! & FLAG_SCOPE_ENTRY);
    assert.equal(s.returned, String(2 * (doubles.indexOf(s) + 1)));
  }
  const cov = r.of('coverage')[0]!;
  assert.equal(cov.fileId, 1);
  assert.ok(cov.states.every((s: number) => s === 0 || s === 1));
  assert.equal(r.finished.stepCount, r.steps().length);
  // seq is monotonic and every event carries the run id
  const seqs = r.events.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
});

test('CommonJS project modules: own fileId, rangeBase after the main file, module scope at depth 1', async () => {
  const r = await run(
    {
      'main.js': 'const { add } = require("./lib.js");\nconst v = add(2, 3); // ?\n',
      'lib.js': 'function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n',
    },
    'main.js',
  );
  assert.equal(r.finished.exitCode, 0);
  const files = r.of('file.instrumented');
  assert.deepEqual(files.map((f) => [f.fileId, f.path.split('/').pop()]), [[1, 'main.js'], [2, 'lib.js']]);
  assert.equal(files[1]!.rangeBase, files[0]!.ranges.length);
  assert.equal(r.logs()[0]!.text, '5');
  const mod = r.scopes().find((s) => s.name === '<module>' && s.scopeId > 0)!;
  assert.equal(mod.depth, 1);
  const add = r.scopes().find((s) => s.name === 'add')!;
  assert.equal(add.parent, 0, 'add is called from the main module');
});

test('an uncaught error: event with a source-mapped stack, error coverage, exit 1', async () => {
  const src = 'function boom(x) {\n  if (x > 1) throw new RangeError("too big: " + x);\n  return x;\n}\nboom(1);\nboom(2);\n';
  const r = await run({ 'main.mjs': src }, 'main.mjs');
  assert.equal(r.finished.exitCode, 1);
  const err = r.of('error').find((e) => !e.handled)!;
  assert.equal(err.errorType, 'RangeError');
  assert.equal(err.message, 'too big: 2');
  assert.deepEqual(err.stack.slice(0, 2).map((f: any) => [f.function, f.line, f.fileId]), [['boom', 2, 1], ['<module>', 6, 1]]);
  assert.equal(r.line(err.rid), 2);
  assert.ok(r.steps()[err.step]![3]! & FLAG_ERROR);
  const cov = r.of('coverage')[0]!;
  assert.equal(cov.states[err.rid], 3);
  const callRid = err.stack[1].rid;
  assert.equal(cov.states[callRid], 4);
  const scope = r.scopes().filter((s) => s.name === 'boom')[1]!;
  assert.equal(scope.raised, 'RangeError');
});

test('a caught exception is aggregated with where it was handled', async () => {
  const src = [
    'function parse(s) { return JSON.parse(s); }',
    'for (const s of ["1", "{", "["]) {',
    '  try {',
    '    parse(s);',
    '  } catch (e) {',
    '    console.log("bad");',
    '  }',
    '}',
  ].join('\n');
  const r = await run({ 'main.mjs': src }, 'main.mjs');
  const caught = r.of('error').filter((e) => e.handled);
  assert.equal(caught.length, 1);
  assert.equal(caught[0]!.errorType, 'SyntaxError');
  assert.equal(caught[0]!.count, 2);
  assert.equal(caught[0]!.handledAt.line, 5);
  assert.equal(caught[0]!.handledAt.broad, true);
  assert.equal(r.line(caught[0]!.rid), 1);
});

test('an error raised by a loop header after its body ran names a new step on the header', async () => {
  const src = [
    'function total(rows) {',
    '  let n = 0;',
    '  for (const [a, b] of rows) {',
    '    n += a + b;',
    '  }',
    '  return n;',
    '}',
    'try { total([[1, 2], null]); } catch {}',
    'function* g() {',
    '  yield 1;',
    '  throw new Error("boom");',
    '}',
    'function run() {',
    '  let k = 0;',
    '  for (const v of g()) {',
    '    k += v;',
    '  }',
    '}',
    'let m = 0;',
    'for (const [c] of [[1], null]) {',
    '  m += c;',
    '}',
  ].join('\n');
  const r = await run({ 'main.mjs': src.replace('let m = 0;', 'try { run(); } catch {}\nlet m = 0;') }, 'main.mjs');
  const steps = r.steps();
  const caught = r.of('error').filter((e) => e.handled);
  const typeError = caught.find((e) => e.errorType === 'TypeError')!;
  assert.equal(r.line(steps[typeError.step]![0]!), 3);
  assert.equal(r.line(steps[typeError.step - 1]![0]!), 4);
  // the generator's error passes through run's `for` line, after its body
  const unwound = steps.findIndex((s) => s[3]! & FLAG_UNWINDING);
  assert.equal(r.line(steps[unwound]![0]!), 15);
  const uncaught = r.of('error').find((e) => !e.handled)!;
  assert.equal(uncaught.step, steps.length - 1);
  assert.equal(r.line(steps[uncaught.step]![0]!), 21);
  assert.ok(steps[uncaught.step]![3]! & FLAG_ERROR);
});

test('async functions: an await hands the scope back, gathered tasks sit side by side', async () => {
  const src = [
    'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));',
    'async function task(n) {',
    '  await sleep(5 * n);',
    '  const v = n * 10;',
    '  return v;',
    '}',
    'const out = await Promise.all([task(1), task(2)]); // ?',
  ].join('\n');
  const r = await run({ 'main.mjs': src }, 'main.mjs');
  assert.equal(r.finished.exitCode, 0);
  const tasks = r.scopes().filter((s) => s.name === 'task');
  assert.deepEqual(tasks.map((t) => [t.parent, t.depth, t.returned]), [[0, 1, '10'], [0, 1, '20']]);
  // the steps after each await are recorded in the task's own scope
  const steps = r.steps();
  for (const t of tasks) assert.ok(steps.some(([rid, sc]) => sc === t.scopeId && r.line(rid!) === 4));
  assert.equal(r.logs()[0]!.text, '[ 10, 20 ]');
});

test('a promise logged by // ? shows its resolved value', async () => {
  const r = await run({ 'main.mjs': 'const p = Promise.resolve({ a: 1 }); // ?\n' }, 'main.mjs');
  assert.equal(r.logs()[0]!.text, '{ a: 1 }');
});

test('live comment variants: $ code, auto-expand, time', async () => {
  const src = 'const s = "hello"; // ? $.toUpperCase()\nconst o = { a: { b: { c: { d: 1 } } } }; // ?+\nconst t = [1,2].map(x => x); // ?.\n';
  const r = await run({ 'main.mjs': src }, 'main.mjs');
  const [a, b, c] = r.logs();
  assert.equal(a!.text, "'HELLO'");
  assert.equal(b!.kind, 'autoExpand');
  assert.equal(c!.kind, 'time');
  assert.equal(c!.runtimeKey, `t:${c!.rid}`);
  assert.ok(r.of('time').length >= 1);
});

test('process.stdout.write is output with its step; process.exit ends the run with its code', async () => {
  const src = 'process.stdout.write("hi\\n");\nprocess.exit(3);\nconsole.log("never");\n';
  const r = await run({ 'main.mjs': src }, 'main.mjs');
  const out = r.of('output');
  assert.equal(out[0]!.text, 'hi\n');
  assert.equal(typeof out[0]!.step, 'number');
  assert.equal(r.finished.exitCode, 3);
  assert.equal(r.logs().length, 0);
  assert.ok(r.of('trace').length);
});

test('a run that never ends times out with the trace so far', async () => {
  const r = await run({ 'main.mjs': 'let i = 0;\nwhile (true) { i++; }\n' }, 'main.mjs', {}, { timeoutMs: 1500 });
  assert.equal(r.finished.timedOut, true);
  assert.equal(r.finished.exitCode, null);
  assert.ok(r.of('trace').some((t) => t.partial), 'partial trace deltas arrived');
});

test('secrets: an env secret is scrubbed, a secret-named string is masked', async () => {
  const src = 'const key = process.env.MY_API_KEY; // ?\nconst cfg = { password: "hunter22", user: "bob" }; // ?\nconsole.log("using", key);\n';
  const r = await run({ 'main.mjs': src }, 'main.mjs', { env: { MY_API_KEY: 'sk-supersecretvalue' } });
  const texts = r.logs().map((l) => l.text).join(' ');
  assert.ok(!texts.includes('sk-supersecretvalue'), texts);
  const pw = r.logs()[1]!.valueBag.data.props.find((p: any) => p.name === 'password');
  assert.equal(pw.secret, true);
});

test('secrets: a value the program puts in its env later is still scrubbed', async () => {
  const src = 'await new Promise((r) => setTimeout(r, 150));\nprocess.env.LATE_TOKEN = "late-secret-value";\nawait new Promise((r) => setTimeout(r, 150));\nconsole.log("t", process.env.LATE_TOKEN);\n';
  const r = await run({ 'main.mjs': src }, 'main.mjs');
  assert.ok(!r.logs().some((l) => l.text.includes('late-secret-value')), r.logs().map((l) => l.text).join(' '));
});

test('calls stay fast: returning values does not rescan the environment per call', async () => {
  // 40k calls returning 8+ character values took over 3 s when scrub listed process.env per return
  const src = 'function add(a, b) {\n  return a + b;\n}\nlet s = 1e9;\nconst t0 = performance.now();\nfor (let i = 0; i < 40000; i++) s = add(s, i);\nconsole.log(performance.now() - t0);\n';
  const r = await run({ 'main.mjs': src }, 'main.mjs');
  const ms = Number(r.logs()[0]!.text);
  assert.ok(ms < 1000, `${ms} ms`);
});

test('unsaved buffer content runs instead of the file on disk', async () => {
  const r = await run({ 'main.mjs': 'const a = 1; // ?\n' }, 'main.mjs', {}, {}, 'const a = 2; // ?\n');
  assert.equal(r.logs()[0]!.text, '2');
});

test('a syntax error in the main file is an error event and exit 1', async () => {
  const r = await run({ 'main.mjs': 'const a = ;\n' }, 'main.mjs');
  const err = r.of('error')[0]!;
  assert.equal(err.errorType, 'SyntaxError');
  assert.equal(r.finished.exitCode, 1);
});

test('logLimit stops logging a line and says so once', async () => {
  const r = await run({ 'main.mjs': 'for (let i = 0; i < 10; i++) console.log(i);\n' }, 'main.mjs', {}, { logLimit: 3 });
  const logs = r.logs();
  assert.equal(logs.filter((l) => l.kind === 'log').length, 3);
  assert.equal(logs.filter((l) => l.kind === 'system').length, 1);
});

test('resolveGetters: off shows accessors unread; on invokes own and class getters, quietly', async () => {
  const src = [
    'class Box { constructor(w, h) { this.w = w; this.h = h; } get area() { return this.w * this.h; } get bad() { throw new Error("no"); } }',
    'const o = { get twice() { return 2 * 2; } };',
    'const b = new Box(2, 3); // ?',
    'o // ?',
  ].join('\n');
  const off = await run({ 'main.js': src }, 'main.js');
  const offBox = off.logs()[0]!.valueBag.data;
  assert.deepEqual(offBox.props.map((p: any) => p.name), ['w', 'h']);
  assert.equal(off.logs()[1]!.valueBag.data.props[0].type, 'accessor');
  const on = await run({ 'main.js': src }, 'main.js', {}, { resolveGetters: true });
  const box = on.logs()[0]!.valueBag.data;
  assert.deepEqual(box.props.map((p: any) => [p.name, p.type, p.value]), [['w', 'number', '2'], ['h', 'number', '3'], ['area', 'number', '6'], ['bad', 'accessor', '[Threw no]']]);
  assert.deepEqual(on.logs()[1]!.valueBag.data.props.map((p: any) => [p.name, p.value]), [['twice', '4']]);
  // the getters ran quiet: no scopes for area/twice
  assert.ok(!on.scopes().some((s) => s.name === 'get area' || s.name === 'get twice'));
});

test('inline config: a leading ({ ... }) sets this run options and env, and is not a step', async () => {
  const src = '({ autoLog: true, env: { GREETING: "hey" } })\nconst a = process.env.GREETING;\nconst b = a.length;\n';
  const r = await run({ 'main.js': src }, 'main.js');
  assert.deepEqual(r.logs().map((l) => [r.line(l.rid), l.kind, l.text]), [[2, 'autoLog', "'hey'"], [3, 'autoLog', '3']]);
  assert.ok(!r.steps().some(([rid]) => r.line(rid!) === 1 && rid !== 0));
});

test('TypeScript enum, namespace and parameter properties: lowered, ranges and stacks in source terms', async () => {
  const src = [
    'enum Color { Red, Green = 5, Blue }',
    'export namespace Geo {',
    '  export const unit: string = "m";',
    '  export function area(w: number, h: number): number { return w * h; }',
    '}',
    'class Base { constructor(protected id: number) {} }',
    'class P extends Base {',
    '  constructor(public x: number, private readonly y = 2) { super(x); }',
    '  sum(): number { return this.x + this.y + this.id; }',
    '}',
    'const c: Color = Color.Blue; // ?',
    'const name = Color[5]; // ?',
    'const s = new P(1).sum(); // ?',
    'const a = Geo.area(2, 3) + Geo.unit; // ?',
    'const boom = () => { throw new Error("x"); };',
    'boom();',
  ].join('\n');
  const r = await run({ 'main.ts': src }, 'main.ts');
  assert.deepEqual(r.logs().map((l) => [r.line(l.rid), l.text]), [[11, '6'], [12, "'Green'"], [13, '4'], [14, "'6m'"]]);
  const f = r.file(1);
  // the range of line 13's statement starts at column 0 and ends where the source line ends
  const rid = r.logs()[2]!.rid - f.rangeBase;
  assert.deepEqual(f.ranges[rid], [13, 0, 13, src.split('\n')[12]!.indexOf(' //')]);
  const sum = f.functions.find((fn: any) => fn.name === 'sum');
  assert.deepEqual(sum.bodyRange.slice(0, 2), [9, 2]);
  const err = r.of('error')[0]!;
  assert.equal(r.line(err.rid), 15);
  assert.equal(err.stack[0].line, 15);
});

const fakeReact = {
  'node_modules/react/package.json': '{"name":"react","type":"module","exports":{"./jsx-runtime":"./rt.js"}}',
  'node_modules/react/rt.js': 'export const Fragment = "Fragment";\nexport function jsx(type, props, key) { return { type, props, key: key ?? null }; }\nexport const jsxs = jsx;\n',
};

test('JSX and TSX: the automatic runtime, keys, text, .js specifiers that are .ts files, ranges in source terms', async () => {
  const app = [
    'import { Size, label } from "./util.js";',
    'type P = { name: string; size: Size };',
    'function Badge({ name, size }: P) {',
    '  return <b title={label(size)}>Hi {name}!</b>;',
    '}',
    'const list = <ul>{["a", "b"].map((n) => <li key={n}><Badge name={n} size={Size.M} /></li>)}</ul>;',
    'const first = list.props.children[0]; // ?',
    'const frag = <>  one\n    two  </>; // ?',
  ].join('\n');
  const r = await run({ ...fakeReact, 'package.json': '{"type":"module"}', 'util.ts': 'export enum Size { S = 1, M, L }\nexport const label = (s: Size): string => Size[s];\n', 'app.tsx': app }, 'app.tsx');
  assert.equal(r.finished.exitCode, 0, JSON.stringify(r.of('error')));
  const [first, frag] = r.logs();
  assert.match(first!.text, /type: 'li'/);
  assert.match(first!.text, /key: 'a'/);
  assert.equal(frag!.text, "{ type: 'Fragment', props: { children: '  one two  ' }, key: null }"); // Babel's rule: only whitespace that touches a newline goes
  assert.deepEqual(r.of('file.instrumented').map((f) => f.path.split('/').pop()), ['app.tsx', 'util.ts']);
  const f = r.file(1);
  assert.deepEqual(f.ranges[first!.rid - f.rangeBase], [7, 0, 7, app.split('\n')[6]!.indexOf(' //')]);
  assert.equal(first!.valueBag.data.props.find((p: any) => p.name === 'props').props[0].props.find((p: any) => p.name === 'type').value, '[Function: Badge]');
});

test('JSX: classic pragma and a plain .jsx file', async () => {
  const src = '/** @jsx h */\nconst h = (t, p, ...c) => ({ t, p, c });\nconst v = <div id="x">{1 + 1} &amp; more</div>; // ?\n';
  const r = await run({ 'a.jsx': src }, 'a.jsx');
  assert.equal(r.finished.exitCode, 0, JSON.stringify(r.of('error')));
  assert.equal(r.logs()[0]!.text, "{ t: 'div', p: { id: 'x' }, c: [ 2, ' & more' ] }");
});

test('run flags: --max-steps below 1 is refused, --node picks the program Node, a capped run warns', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const BIN = new URL('../bin/' + (await import('../src/protocol.ts')).NAME + '.mjs', import.meta.url).pathname;
  const dir = mkdtempSync(join(tmpdir(), 'flags-'));
  const f = join(dir, 'm.mjs');
  writeFileSync(f, 'let s = 0;\nfor (let i = 0; i < 100; i++) s += i;\nconsole.log(process.execPath === process.argv[0], s);\n');
  const bad = spawnSync(process.execPath, [BIN, 'run', f, '--max-steps', '0'], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /--max-steps must be at least 1/);
  const capped = spawnSync(process.execPath, [BIN, 'run', f, '--max-steps', '20', '--node', process.execPath], { encoding: 'utf8' });
  assert.equal(capped.status, 0, capped.stderr);
  assert.match(capped.stdout, /true 4950/);
  assert.match(capped.stderr, /WARNING: recording truncated at step 20/);
  const nope = spawnSync(process.execPath, [BIN, 'run', f, '--node', join(dir, 'no-such-node')], { encoding: 'utf8' });
  assert.notEqual(nope.status, 0);
  assert.match(nope.stderr, /cannot run .*no-such-node/);
});


test('reports rejected promises consumed by allSettled and catch, without duplicating uncaught errors', async () => {
  const r = await run({ 'main.mjs': `async function fail(message) { await Promise.resolve(); throw new RangeError(message); }
await Promise.allSettled([fail('settled')]);
await fail('caught').catch(() => {});
await fail('uncaught');` }, 'main.mjs');
  const errors = r.of('error');
  assert.deepEqual(errors.map(e => [e.message, e.handled]).sort(), [['caught', true], ['settled', true], ['uncaught', false]]);
  for (const error of errors) assert.ok(error.step >= 0);
});


test('TypeScript class interface and static async create retain valid syntax and source lines', async () => {
  const source = `interface ModelRuntimeInterface { value: number }
export class ModelRuntime implements ModelRuntimeInterface {
  value = 42;
  static async create(options = {}): Promise<ModelRuntime> {
    return new ModelRuntime();
  }
}
const instance = await ModelRuntime.create();
console.log(instance.value);`;
  const r = await run({ 'main.ts': source }, 'main.ts');
  assert.equal(r.finished.exitCode, 0);
  const output = r.logs().find(l => l.kind === 'log');
  assert.equal(output?.text, '42');
  assert.equal(r.line(output!.rid), 9);
  const factory = r.scopes().find(s => s.name === 'create');
  assert.ok(factory);
  assert.equal(r.line(r.steps()[factory.first]![0]!), 4);
});
