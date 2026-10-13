import { describe, it, expect, afterAll } from 'vitest';
import { runScratch, scratchFunction, scratchDependencies } from '../../web/scratchpadRuntime';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-scratch-'));
const file = path.join(dir, 'main.ts');
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
fs.writeFileSync(file, 'const ignored = (() => { throw Error("module initialized"); })();\nfunction twice(n: number) { return n * 2; }\nfunction target(x: number) { return twice(x); }');
describe('isolated scratchpad', () => {
  it('extracts the containing function', () => { expect(scratchFunction(fs.readFileSync(file, 'utf8'), 3)).toMatchObject({ name: 'target', parameters: ['x'] }); });
  it('starts from the enclosing function when paused on an array callback', () => {
    expect(scratchFunction('async function target(input) {\n const calls = input.filter(c => c.type === "toolCall");\n}', 2).name).toBe('target');
  });
  it('includes helpers without unrelated module initialization', async () => {
    const r = await runScratch({ file, code: 'const answer: number = twice(x);', inputs: { x: 4 }, mocks: {} });
    expect(r.error).toBeUndefined(); expect(r.values).toContainEqual({ name: 'answer', line: 1, value: 8 });
  });
  it('resolves local TypeScript imports', async () => {
    fs.writeFileSync(path.join(dir, 'helper.ts'), 'export const plus = (n: number) => n + 1;');
    const r = await runScratch({ file, code: 'import { plus } from "./helper";\nconst answer = plus(4);', inputs: {}, mocks: {} });
    expect(r.error).toBeUndefined(); expect(r.values.find(v => v.name === 'answer')?.value).toBe(5);
  });
  it('mocks imported callbacks and HTTP, without a network request', async () => {
    const r = await runScratch({ file, code: 'const callback = emit(); const body = await (await fetch("https://invalid.test")).json();', inputs: { emit: { __scratchUnavailable: 'function' } }, mocks: { emit: 'mock', 'http:https://invalid.test': { ok: true } } });
    expect(r.error).toBeUndefined(); expect(r.values.map(v => v.value)).toEqual(['mock', { ok: true }]);
  });
  it('rejects missing mocks and Node IO imports', async () => {
    expect((await runScratch({ file, code: 'await fetch("https://invalid.test");', inputs: {}, mocks: {} })).error).toContain('No HTTP mock');
    await expect(runScratch({ file, code: 'import fs from "node:fs"; fs.writeFileSync("/tmp/oops", "x");', inputs: {}, mocks: {} })).rejects.toThrow('cannot import node:fs');
  });
  it('starts with encoding, URL and clone APIs before imported dependencies initialize', async () => {
    fs.writeFileSync(path.join(dir, 'standard.ts'), `
      const encoder = new TextEncoder();
      const started = performance.now();
      const base = new URL('../api?q=one', 'https://example.test/a/b');
      export function transform() {
        if(performance.now() < started || !Number.isFinite(performance.timeOrigin)) throw Error('Invalid performance clock');
        base.searchParams.append('q', 'two');
        const input = { bytes: encoder.encode('hé😀'), nested: { count: 1 } };
        const copy = structuredClone(input);
        copy.nested.count = 2;
        return { text: new TextDecoder().decode(copy.bytes), href: base.href, original: input.nested.count };
      }`);
    const r = await runScratch({ file, code: 'import { transform } from "./standard"; const answer = transform();', inputs: {}, mocks: {} });
    expect(r.error).toBeUndefined();
    expect(r.values.find(v => v.name === 'answer')?.value).toEqual({ text: 'hé😀', href: 'https://example.test/api?q=one&q=two', original: 1 });
  });
  it('preserves clone cycles, shared references and typed buffers', async () => {
    const code = `const a = { n: 1 }; const source = { a, b: a, map: new Map([[a, new Set([a])]]), bytes: new Uint8Array([3, 4]) }; source.self = source;
      const copy = structuredClone(source);
      const answer = copy !== source && copy.self === copy && copy.a === copy.b && copy.map.get(copy.a).has(copy.a) && copy.bytes[1] === 4;`;
    const r = await runScratch({ file, code, inputs: {}, mocks: {} });
    expect(r.error).toBeUndefined(); expect(r.values.find(v => v.name === 'answer')?.value).toBe(true);
  });
  it('does not expose the host or permit dynamic code while standard APIs work', async () => {
    const r = await runScratch({ file, code: 'const answer = [typeof globalThis.process, typeof globalThis.require, typeof __nativeEncoding]; new TextEncoder().encode.constructor("return process")();', inputs: {}, mocks: {} });
    expect(r.values.find(v => v.name === 'answer')?.value).toEqual(['undefined', 'undefined', 'undefined']);
    expect(r.error).toMatch(/Code generation from strings disallowed/);
  });
  it('terminates synchronous loops', async () => {
    expect((await runScratch({ file, code: 'while(true) {}', inputs: {}, mocks: {} })).error).toMatch(/timed out|exceeded/);
  });
  it('uses explicit mocked helpers instead of source definitions', () => {
    expect(scratchDependencies(fs.readFileSync(file, 'utf8'), 'twice(2)', new Set(['twice']))).toBe('');
  });
  it('keeps captured values and logs when a later external call needs a mock', async () => {
    const r = await runScratch({ file, code: 'const answer = 2; console.log(1); await fetch("https://invalid.test");', inputs: {}, mocks: {} });
    expect(r.error).toContain('No HTTP mock');
    expect(r.values).toContainEqual({ name: 'answer', line: 1, value: 2 });
    expect(r.output).toEqual([[1]]);
  });
});

import { scratchInput } from '../../web/scratchpadValues';
describe('captured scratch inputs', () => {
  it('copies complete arrays even when the debugger offers expansion', () => {
    expect(scratchInput({ id: 'a', queryPath: [], type: 'list', length: 1, expandable: true, props: [{ id: 'b', name: '0', queryPath: [], type: 'str', value: 'toolCall' }] })).toEqual(['toolCall']);
  });
  it('does not replace missing elements with invented data', () => {
    expect(scratchInput({ id: 'a', queryPath: [], type: 'list', length: 2, props: [] })).toHaveProperty('__scratchUnavailable');
  });
  it('marks shortened strings as unavailable', () => {
    expect(scratchInput({ id: 's', queryPath: [], type: 'str', value: 'cut…', capped: true })).toHaveProperty('__scratchUnavailable');
  });
});

describe('full copied functions', () => {
  it('runs the extracted function with initialized imports, copied inputs and mocked external calls', async () => {
    const target = path.join(dir, 'complete.ts');
    fs.writeFileSync(path.join(dir, 'complete-helper.ts'), `
      const encoder = new TextEncoder();
      export class Payload {
        constructor(public text: string) {}
        encode() { return encoder.encode(this.text); }
      }
    `);
    const source = `import { Payload } from './complete-helper';
async function target(input: { text: string }, emit: (v: string) => unknown) {
  const copy = structuredClone(input);
  const url = new URL('/answer', 'https://example.test');
  const text = new TextDecoder().decode(new Payload(copy.text).encode());
  const reply = await (await globalThis.fetch(url)).json();
  emit(text);
  return { text, reply };
}`;
    fs.writeFileSync(target, source);
    const fn = scratchFunction(source, 5);
    const inputs = { input: { text: 'hé😀' }, emit: { __scratchUnavailable: 'function' }, result: 'old paused result' };
    const result = await runScratch({ file: target, code: `${fn.code}\nconst result = await target(input, emit);`, inputs,
      mocks: { emit: null, 'http:https://example.test/answer': { total: 42 } } });
    expect(result.error).toBeUndefined();
    expect(result.values.find(v => v.name === 'result')?.value).toEqual({ text: 'hé😀', reply: { total: 42 } });
    expect(inputs.input.text).toBe('hé😀');
  });
  it('extracts a named arrow and preserves rest arguments', async () => {
    const source = 'const sum = (...values: number[]) => { return values.reduce((a, b) => a + b, 0); };';
    const fn = scratchFunction(source, 1);
    expect(fn.name).toBe('sum'); expect(fn.parameters).toEqual(['...values']);
    const r = await runScratch({ file, code: `${fn.code}\nconst result = await ${fn.name}(${fn.parameters.join(', ')});`, inputs: { values: [1, 2, 3] }, mocks: {} });
    expect(r.error).toBeUndefined(); expect(r.values.at(-1)?.value).toBe(6);
  });
  it('does not duplicate imports that the edited copy already owns', async () => {
    const target = path.join(dir, 'imports.ts');
    fs.writeFileSync(target, "import { plus } from './helper';\nfunction target() { return plus(1); }");
    fs.writeFileSync(path.join(dir, 'helper.ts'), 'export function plus(n: number) { return n + 1; }');
    const r = await runScratch({ file: target, code: "import { plus } from './helper';\nconst answer = plus(4);", inputs: {}, mocks: {} });
    expect(r.error).toBeUndefined(); expect(r.values.at(-1)?.value).toBe(5);
  });
});
