import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSync } from 'oxc-parser';
import { instrument } from '../src/instrument.ts';

function ok(source: string, filename = 'x.mjs', opts = {}) {
  const r = instrument(source, filename, 1, 0, { sourceMap: false, ...opts });
  assert.equal(r.error, null, r.error ?? '');
  const p = parseSync('out.js', r.code!, { sourceType: 'unambiguous' } as any);
  assert.deepEqual(p.errors.map((e: any) => e.message), [], r.code!);
  return r;
}

test('instrumented output parses for the statement forms that need care', () => {
  const src = [
    "'use strict';",
    'if (a) b(); else if (c) d(); else e();',
    'for (;;) break;',
    'while (x) x--;',
    'do x++; while (x < 3);',
    'outer: for (const i of xs) { inner: for (const j of ys) { if (j) continue outer; break inner; } }',
    'lbl: { if (q) break lbl; }',
    'switch (k) { case 1: f(); break; default: g(); }',
    'try { t(); } catch { u(); } finally { v(); }',
    'try { t(); } catch ({ message }) { u(message); }',
    'function f(a = 1, ...r) { "use strict"; if (a) return; return a, r; }',
    'const g = async () => await h();',
    'const o = { m() { return 1 }, get p() { return 2 }, set p(v) {}, [k]: () => 3, async *gen() { yield 1; yield* xs; yield; } };',
    'class C extends B { #x = 1; static s = 2; static { init(); } constructor() { super(); this.y = 3 } m() { return this.#x } }',
    'export default function () { return 1 }',
    'export const e = a ?? b;',
    'label2: x = 1;',
    'const t = c ? d : e;',
    'console.log();',
    'console.error("x", 1);',
  ].join('\n');
  ok(src);
});

test('ranges are in source order, compound statements have header ranges', () => {
  const src = 'const a = 1;\nif (a > 0) {\n  console.log(a);\n}\nfunction f(x) {\n  return x * 2;\n}\n';
  const r = ok(src);
  const sorted = [...r.ranges].sort((x, y) => x[0] - y[0] || x[1] - y[1] || y[2] - x[2] || y[3] - x[3]);
  assert.deepEqual(r.ranges, sorted);
  assert.deepEqual(r.ranges[0], [1, 0, 8, 0]); // the whole file
  const ifRange = r.ranges.find((x) => x[0] === 2 && x[1] === 0)!;
  assert.deepEqual(ifRange, [2, 0, 2, 10]); // `if (a > 0)`
  assert.deepEqual(r.functions.map((f) => f.name), ['f']);
  assert.deepEqual(r.ranges[r.functions[0]!.rid], [5, 0, 5, 13]); // `function f(x)`
});

test('TypeScript keeps its columns: ranges index the .ts source', () => {
  const src = 'const xs: number[] = [1, 2];\nfunction add(a: number, b: number): number {\n  return a + b;\n}\nadd(1, 2); // ?\n';
  const r = ok(src, 'x.ts');
  const lines = src.split('\n');
  const text = (rg: number[]) => lines[rg[0]! - 1]!.slice(rg[1], rg[2] === rg[0] ? rg[3] : undefined);
  const call = r.ranges.find((x) => x[0] === 5)!;
  assert.equal(text(call), 'add(1, 2);');
  assert.equal(text(r.ranges[r.functions[0]!.rid]!), 'function add(a: number, b: number): number');
  assert.equal(r.magic.length, 1);
});

test('live comments: value, auto-expand, time, $ code; a human comment is not one', () => {
  const src = 'const a = 1; // ?\nconst b = [a]; // ?+\nf(); // ?.\nconst s = "x"; // ? $.toUpperCase()\nconst h = 2; // ? is this right\n';
  const r = ok(src);
  assert.deepEqual(r.magic.map((m) => m.kind), ['value', 'autoExpand', 'time', 'value']);
  assert.match(r.code!, /\(\$\)=>\(\$\.toUpperCase\(\)\)/);
});

test('coverage ignore hints drop statements from the statement list', () => {
  const src = 'a();\n/* istanbul ignore next */\nfunction f() {\n  b();\n}\nc();\n';
  const r = ok(src);
  assert.ok(r.ignored.size >= 2);
  for (const i of r.ignored) assert.ok(!r.statements.includes(i));
});

test('a syntax error is reported with its line, not thrown', () => {
  const r = instrument('const a = ;\n', 'x.mjs', 1, 0, {});
  assert.match(r.error!, /^SyntaxError/);
  assert.equal(r.errorLine, 1);
});

test('TypeScript that cannot be lowered either is an error, not a crash', () => {
  const r = instrument('namespace N { export const a = 1; }\nimport x = N.a;\n', 'x.ts', 1, 0, {});
  assert.match(r.error!, /TypeScript/);
});

test('dotted namespaces are lowered level by level', async () => {
  const r = instrument('namespace A.B { export const x = 1; }\nconsole.log(A.B.x);\n', 'x.ts', 1, 0, { sourceMap: false });
  assert.equal(r.error, null);
  const logs: unknown[] = [];
  (globalThis as any).__tk = new Proxy({}, { get: (_t, k) => (k === 'log' ? (_r: number, _m: string, ...a: unknown[]) => logs.push(...a) : () => 0) });
  new Function(r.code!)();
  assert.deepEqual(logs, [1]);
});

test('rangeBase offsets every emitted range id', () => {
  const r = instrument('a();\nb();\n', 'x.mjs', 2, 100, { sourceMap: false, moduleScope: true });
  assert.match(r.code!, /__tk\.f\(100\)/);
  assert.match(r.code!, /__tk\.s\(101,/);
  assert.equal(r.functions[0]!.name, '<module>');
});

test('empty bodies and directives without `;` instrument to valid code under every option set', () => {
  const cases = [
    'function a() {}', 'const b = () => {};', 'export default function () {}', 'export const f = async () => {};',
    'class C { m() {} static {} constructor() {} }', 'const o = { f() {}, get x() {}, set x(v) {} };', '(function () {})();',
    'if (1) {} else {}', 'try {} catch {} finally {}', 'for (const x of []) {}', 'do {} while (0);', 'switch (1) { case 1: {} }',
    '{}', 'label: {}', 'const g = function* () {};', 'async function h() {}', '[].map(() => {});',
    'function d() {"use strict"}', 'function e() { "use strict"\n  return 1;\n}', 'function k() { /* c */ }',
  ];
  for (const library of [false, true]) for (const moduleScope of [false, true]) for (const recordLocals of [false, true]) for (const c of cases) {
    const r = instrument(c + '\n', 'x.mjs', 1, 0, { sourceType: 'module', sourceMap: false, library, relocatable: library, moduleScope, recordLocals } as any);
    assert.ok(r.code !== null, `${c}: ${r.error}`);
    const p = parseSync('x.mjs', r.code!, { sourceType: 'module' } as any);
    assert.deepEqual(p.errors.map((e: any) => e.message), [], `${c} (library ${library}, moduleScope ${moduleScope}, locals ${recordLocals}):\n${r.code}`);
  }
});
