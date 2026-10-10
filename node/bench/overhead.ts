/**
 * Instrumentation overhead: each program runs plain (`node FILE`) and under tracelight
 * (`run` through a runner, steps recorded), best of N, wall time of the program itself
 * (`performance.now()` around its body, printed on stdout), so process start is left out.
 *
 *   node bench/overhead.ts [--runs N]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRequest, runOnce } from '../src/cli.ts';

const PROGRAMS: Record<string, string> = {
  'loop (1M iterations, arithmetic)': 'let s = 0;\nfor (let i = 0; i < 1_000_000; i++) {\n  s += i % 7;\n}\n',
  'calls (300k small function calls)': 'function add(a, b) {\n  return a + b;\n}\nlet s = 0;\nfor (let i = 0; i < 300_000; i++) s = add(s, i);\n',
  'objects (100k allocations, property reads)': 'const out = [];\nfor (let i = 0; i < 100_000; i++) {\n  const o = { id: i, name: "n" + i };\n  if (o.id % 2) out.push(o.name);\n}\n',
  'recursion (fib 24)': 'function fib(n) {\n  if (n < 2) return n;\n  return fib(n - 1) + fib(n - 2);\n}\nfib(24);\n',
  'async (20k awaits)': 'async function tick(i) {\n  return i;\n}\nasync function main() {\n  let s = 0;\n  for (let i = 0; i < 20_000; i++) s += await tick(i);\n}\nawait main();\n',
  // the loop of the first row inside a worker thread: the time printed first is the worker's own body
  'worker (the 1M loop in a worker_thread)': 'import { Worker, isMainThread } from "node:worker_threads";\nif (isMainThread) {\n  await new Promise((r) => new Worker(new URL(import.meta.url)).on("exit", r));\n} else {\n  let s = 0;\n  for (let i = 0; i < 1_000_000; i++) {\n    s += i % 7;\n  }\n}\n',
};

const runs = Number(process.argv[process.argv.indexOf('--runs') + 1]) || 3;
const dir = mkdtempSync(join(tmpdir(), 'tracelight-bench-'));
const wrap = (body: string) => `const __t0 = performance.now();\n${body}\nprocess.stdout.write("T " + (performance.now() - __t0).toFixed(1) + "\\n");\n`;
const timeOf = (text: string) => Number(/T ([\d.]+)/.exec(text)?.[1] ?? NaN);

console.log(`best of ${runs}; ms of program time\n`);
console.log('program'.padEnd(46) + 'plain'.padStart(9) + 'tracelight'.padStart(11) + 'overhead'.padStart(10) + 'steps'.padStart(10));
for (const [name, body] of Object.entries(PROGRAMS)) {
  const file = join(dir, name.replace(/\W+/g, '_') + '.mjs');
  const src = wrap(body);
  writeFileSync(file, src);
  let plain = Infinity;
  let traced = Infinity;
  let steps = 0;
  for (let i = 0; i < runs; i++) {
    plain = Math.min(plain, timeOf(execFileSync(process.execPath, [file], { encoding: 'utf8' })));
    const req = buildRequest(file, src, { timeoutMs: 120000 }, `b${i}`);
    const { events, finished } = await runOnce(req);
    traced = Math.min(traced, timeOf(events.filter((e) => e.type === 'output').map((e) => e.text).join('')));
    steps = finished.stepCount;
  }
  console.log(name.padEnd(46) + plain.toFixed(1).padStart(9) + traced.toFixed(1).padStart(11) + `${(traced / plain).toFixed(1)}x`.padStart(10) + String(steps).padStart(10));
}
