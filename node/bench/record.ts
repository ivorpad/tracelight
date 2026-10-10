/**
 * Recording overhead: the same programs run plain, instrumented with no-op hooks, recorded (with
 * and without AsyncLocalStorage), and under the debug hooks of a `record: false` run and of a
 * `recordFrom` run before its pause (hits counted). Prints ns per step and the slowdown against plain.
 *
 *     node --experimental-strip-types bench/record.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { instrument } from '../src/instrument.ts';
import { Recorder } from '../src/recorder/recorder.ts';
import { debugHooks } from '../src/recorder/debugHooks.ts';
import { Debugger } from '../src/debug/debugger.ts';

const PROGRAMS: Record<string, string> = {
  fib: `
function fib(n) {
  if (n < 2) return n;
  return fib(n - 1) + fib(n - 2);
}
globalThis.__out = fib(22);
`,
  loop: `
let total = 0;
for (let i = 0; i < 300000; i++) {
  const sq = i * i;
  if (sq % 3 === 0) total += sq;
}
globalThis.__out = total;
`,
  async: `
async function worker(id) {
  let s = 0;
  for (let i = 0; i < 2000; i++) {
    if (i % 50 === 0) await null;
    s += id * i;
  }
  return s;
}
const rs = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(worker));
globalThis.__out = rs.length;
`,
};

const dir = mkdtempSync(join(tmpdir(), 'tk-bench-'));
let k = 0;

async function runModule(code: string): Promise<number> {
  const file = join(dir, `m${k++}.mjs`);
  writeFileSync(file, code);
  const t0 = performance.now();
  await import(pathToFileURL(file).href);
  return performance.now() - t0;
}

const noop = () => {};
const id = (_s: number, v: unknown) => v;
const NOOP_HOOKS = { h: noop, now: () => performance.now(), s: noop, c: noop, f: () => 1, x: noop, ex: noop, ap: id, aw: id, u: Symbol(), e: Symbol(), v: (_r: number, _c: unknown, v: unknown) => v, t: noop, log: noop, lp: noop };

function best(xs: number[]): number {
  return Math.min(...xs);
}

for (const [name, src] of Object.entries(PROGRAMS)) {
  const inst = instrument(src, `${name}.mjs`, 1, 0, { sourceType: 'module', sourceMap: false });
  const plain: number[] = [];
  const noops: number[] = [];
  const rec: number[] = [];
  const recNoAls: number[] = [];
  const dbgOff: number[] = [];
  const dbgFrom: number[] = [];
  let steps = 0;
  for (let rep = 0; rep < 5; rep++) {
    plain.push(await runModule(src));
    (globalThis as any).__tk = NOOP_HOOKS;
    noops.push(await runModule(inst.code!));
    for (const [als, out] of [[true, rec], [false, recNoAls]] as const) {
      const r = new Recorder(() => {}, { asyncContext: als });
      r.addFile(inst);
      (globalThis as any).__tk = { ...NOOP_HOOKS, ...r.hooks() };
      out.push(await runModule(inst.code!));
      r.finish();
      steps = r.n;
    }
    for (const [from, out] of [[false, dbgOff], [true, dbgFrom]] as const) {
      const r = new Recorder(() => {}, {});
      r.addFile(inst);
      const dbg = new Debugger({ record: false, emit: noop, files: () => [] }, { debug: true, stopOnEntry: false });
      (globalThis as any).__tk = { ...NOOP_HOOKS, ...r.hooks(), ...debugHooks(dbg, r, { recordFrom: from }).hooks };
      out.push(await runModule(inst.code!));
    }
  }
  const p = best(plain);
  const fmt = (ms: number) => `${ms.toFixed(1)} ms (${(ms / p).toFixed(1)}x, ${((ms * 1e6) / steps).toFixed(0)} ns/step)`;
  console.log(`${name}: ${steps} steps`);
  console.log(`  plain          ${p.toFixed(1)} ms`);
  console.log(`  no-op hooks    ${fmt(best(noops))}`);
  console.log(`  recorded       ${fmt(best(rec))}`);
  console.log(`  recorded noALS ${fmt(best(recNoAls))}`);
  console.log(`  record: false  ${fmt(best(dbgOff))}`);
  console.log(`  recordFrom pre ${fmt(best(dbgFrom))}`);
}
