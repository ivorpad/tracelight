import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { run } from './helpers.ts';
import { Driver } from './driver.ts';
import { childNode } from '../src/runner.ts';

const bun = process.env.TRACELIGHT_TEST_BUN || 'bun';
const available = spawnSync(bun, ['--version'], { encoding: 'utf8' }).status === 0;
const SOURCE = `interface ModelRuntimeInterface { value: number }
export class ModelRuntime implements ModelRuntimeInterface {
  value = 0;
  static async create(options = {}): Promise<ModelRuntime> {
    const input = await Bun.file(new URL('./value.json', import.meta.url)).json();
    const value = input.answer;
    return Object.assign(new ModelRuntime(), {value});
  }
}
const instance = await ModelRuntime.create();
console.log(instance.value, process.versions.bun ? 'bun' : 'node');`;
const files = { 'main.ts': SOURCE, 'value.json': '{"answer":42}' };

test('runtime selection identifies Bun itself, rather than its Node compatibility version', { skip: !available }, () => {
  assert.equal(childNode({ node: bun }).kind, 'bun');
  assert.equal(childNode({ node: process.execPath }).kind, 'node');
});

test('native Bun records Bun.file JSON and a static async factory without rewriting the program', { skip: !available }, async () => {
  const r = await run(files, 'main.ts', { node: bun });
  assert.equal(r.finished.exitCode, 0);
  assert.equal(r.logs().find(l => l.kind === 'log')?.text, '42 bun');
  assert.ok(r.steps().length > 0);
  assert.ok(r.scopes().some(s => s.name === 'create'));
});

test('native Bun accepts top-level factory await without an export declaration', { skip: !available }, async () => {
  const r = await run({ ...files, 'main.ts': SOURCE.replace('export class', 'class') }, 'main.ts', { node: bun });
  assert.equal(r.finished.exitCode, 0);
  assert.equal(r.logs().find(l => l.kind === 'log')?.text, '42 bun');
});

test('native Bun live debugging also works without a recording', { skip: !available, timeout: 20000 }, async () => {
  const d = new Driver();
  try {
    const path = d.start(files, 'main.ts', { stopOnEntry: false, record: false }, { node: bun, breakpoints: [{ path: '', function: 'create' }] });
    assert.equal((await d.paused()).line, 4);
    await d.ask({ type: 'debug', action: 'breakpoints', set: [{ path, line: 7 }] });
    await d.ask({ type: 'debug', action: 'continue' });
    assert.equal((await d.paused()).line, 7);
    const locals = await d.ask({ type: 'debug', action: 'locals' });
    assert.ok(locals.locals.some((l: any) => l.name === 'value' && l.text === '42'));
    await d.ask({ type: 'debug', action: 'breakpoints', set: [] });
    await d.ask({ type: 'debug', action: 'continue' });
    assert.equal((await d.next(m => m.type === 'run.finished')).exitCode, 0);
    assert.equal(d.seen.some(m => m.type === 'trace'), false);
  } finally { d.close(); }
});

test('native Bun steps into, over and out with source lines preserved', { skip: !available, timeout: 20000 }, async () => {
  const d = new Driver();
  try {
    const path = d.start({ 'main.ts': `function add(a: number, b: number): number {
  const total = a + b;
  return total;
}
const result = add(20, 22);
console.log(result, process.versions.bun);` }, 'main.ts', { stopOnEntry: true }, { node: bun });
    assert.equal((await d.paused()).line, 5);
    await d.ask({ type: 'debug', action: 'breakpoints', set: [] });
    await d.ask({ type: 'debug', action: 'step', kind: 'into' });
    assert.equal((await d.paused()).line, 1);
    await d.ask({ type: 'debug', action: 'step', kind: 'over' });
    assert.equal((await d.paused()).line, 2);
    const locals = await d.ask({ type: 'debug', action: 'locals' });
    assert.ok(locals.locals.some((l: any) => l.name === 'a' && l.text === '20'));
    await d.ask({ type: 'debug', action: 'step', kind: 'out' });
    const out = await d.paused();
    assert.equal(out.kind, 'out');
    assert.equal(d.seen.find(m => m.type === 'file.instrumented' && m.fileId === out.fileId)?.path, path);
    assert.equal(out.stack.length, 1);
    await d.ask({ type: 'debug', action: 'continue' });
    assert.equal((await d.next(m => m.type === 'run.finished')).exitCode, 0);
  } finally { d.close(); }
});

test('native Bun live debugger pauses at factory breakpoints and reads actual JSON locals', { skip: !available, timeout: 20000 }, async () => {
  const d = new Driver();
  try {
    const path = d.start(files, 'main.ts', { stopOnEntry: false }, { node: bun, breakpoints: [{ path: '', function: 'create' }] });
    const first = await d.paused();
    assert.equal(first.reason, 'breakpoint');
    assert.equal(first.line, 4);
    await d.ask({ type: 'debug', action: 'breakpoints', set: [{ path, line: 7 }] });
    await d.ask({ type: 'debug', action: 'continue' });
    const atReturn = await d.paused();
    assert.equal(atReturn.line, 7);
    const reply = await d.ask({ type: 'debug', action: 'locals' });
    assert.equal(reply.type, 'debug.result');
    assert.ok(reply.locals.some((l: any) => l.name === 'value' && l.text === '42'));
    const pure = await d.ask({ type: 'evaluate', expression: 'value + 1' });
    assert.equal(pure.type, 'error');
    assert.match(pure.message, /cannot guarantee side-effect-free evaluation/);
    const evaluated = await d.ask({ type: 'exec', source: 'value + 1' });
    assert.equal(evaluated.text, '43');
    await d.ask({ type: 'debug', action: 'breakpoints', set: [] });
    await d.ask({ type: 'debug', action: 'continue' });
    const end = await d.next(m => m.type === 'run.finished', 'run.finished');
    assert.equal(end.exitCode, 0);
  } finally { d.close(); }
});

test('native Bun instruments imported TypeScript modules', { skip: !available }, async () => {
  const r = await run({
    'main.ts': `import { answer } from './factory.ts';\nconsole.log(answer() + 2);`,
    'factory.ts': `export function answer(): number { return 40; }`,
  }, 'main.ts', { node: bun });
  assert.equal(r.finished.exitCode, 0, JSON.stringify(r.of('exception')) + JSON.stringify(r.of('runner.error')));
  assert.equal(r.logs().find(l => l.kind === 'log')?.text, '42');
  assert.equal(r.of('file.instrumented').length, 2);
});

const mixedFiles = {
  'main.ts': `import { answer } from './native/model.ts';
import common from './native/answer.cjs';
import { check } from './selected/check.ts';
console.log(check(answer + common));`,
  'native/model.ts': `const input = await Bun.file(new URL('./value.json', import.meta.url)).json();
export const answer: number = input.answer;`,
  'native/value.json': '{"answer":40}',
  'native/answer.cjs': 'module.exports = 2;',
  'selected/check.ts': `export function check(value: number) {
  return value;
}`,
};

test('native Bun leaves excluded async TypeScript and CommonJS imports to its loader', { skip: !available }, async () => {
  const r = await run(mixedFiles, 'main.ts', {node:bun}, {only:['selected']});
  assert.equal(r.finished.exitCode, 0, JSON.stringify(r.of('error')));
  assert.equal(r.logs().find(l => l.kind === 'log')?.text, '42');
  assert.equal(r.of('file.instrumented').length, 2);
  assert.ok(r.of('file.instrumented').every(f => !f.path.includes('/native/')));
});

test('native Bun reaches a selected live breakpoint after excluded async imports', { skip: !available, timeout:20000 }, async () => {
  const d = new Driver();
  try {
    d.start(mixedFiles, 'main.ts', {stopOnEntry:false, only:['selected']}, {node:bun, breakpoints:[{path:'',function:'check'}]});
    const pause = await d.paused();
    assert.equal(pause.reason, 'breakpoint');
    assert.equal(pause.line, 1);
    const locals = await d.ask({type:'debug',action:'locals'});
    assert.ok(locals.locals.some((l: any) => l.name === 'value' && l.text === '42'));
    await d.ask({type:'debug',action:'breakpoints',set:[]});
    await d.ask({type:'debug',action:'continue'});
    assert.equal((await d.next(m => m.type === 'run.finished')).exitCode, 0);
  } finally { d.close(); }
});

test('native Bun pauses on a raised exception with the source frame', { skip: !available, timeout: 20000 }, async () => {
  const d = new Driver();
  try {
    d.start({ 'main.ts': `function fail() {\n  throw new Error('fixture failure');\n}\ntry { fail(); } catch {}\nconsole.log('caught');` }, 'main.ts', { stopOnEntry: false, breakOnException: 'raised' }, { node: bun });
    const pause = await d.paused();
    assert.equal(pause.reason, 'exception');
    assert.equal(pause.line, 2, JSON.stringify(pause));
    assert.equal(pause.exception.message, 'fixture failure');
    await d.ask({ type: 'debug', action: 'continue' });
    assert.equal((await d.next(m => m.type === 'run.finished')).exitCode, 0);
  } finally { d.close(); }
});

test('native Bun refuses CommonJS instrumentation with an explicit loader limitation', { skip: !available }, async () => {
  const r = await run({ 'main.cjs': `console.log('must not execute'); module.exports = 42;` }, 'main.cjs', { node: bun });
  assert.equal(r.finished.exitCode, 1);
  assert.ok(r.of('error').some(e => /CommonJS recording requires Node/.test(e.message)));
  assert.equal(r.logs().length, 0);
});

test('native Bun reports the original line of a recorded failure', { skip: !available }, async () => {
  const r = await run({ 'main.ts': `export {};\nconst value = 42;\nthrow new Error('fixture failure');` }, 'main.ts', { node: bun });
  assert.equal(r.finished.exitCode, 1);
  assert.equal(r.of('error')[0]?.stack[0]?.line, 3);
});
