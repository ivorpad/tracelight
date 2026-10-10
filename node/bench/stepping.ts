/**
 * Time Machine stepping latency over saved runs, with the host's own TraceModel
 * (src/timeMachine/traceModel.ts): the same code serves Python and JS recordings, so this compares
 * the recordings, not two navigators. Bundled by bench/stepping.sh (the host imports have no extensions).
 *
 * For random positions it times a seek (location + call stack + which moves are possible, what the
 * panel computes on every move) and each move. Prints p50 / p99 / max in microseconds.
 */
import { readFileSync } from 'node:fs';
import { TraceModel } from '../../src/timeMachine/traceModel';

function load(path: string): TraceModel {
  const run = JSON.parse(readFileSync(path, 'utf8'));
  const ranges = new Map<number, { fileId: number; range: [number, number, number, number] }>();
  let trace: any;
  for (const e of run.events) {
    if (e.type === 'file.instrumented') e.ranges.forEach((r: any, i: number) => ranges.set(e.rangeBase + i, { fileId: e.fileId, range: r }));
    if (e.type === 'trace' && !e.partial) trace = e;
  }
  const buf = Buffer.from(trace.steps, 'base64');
  const steps = new Int32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  return new TraceModel(steps, trace.scopes, trace.truncated, (rid) => ranges.get(rid));
}

function stats(xs: number[]): string {
  xs.sort((a, b) => a - b);
  const q = (p: number) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
  return `p50 ${(q(0.5) * 1000).toFixed(1)}µs  p99 ${(q(0.99) * 1000).toFixed(1)}µs  max ${(xs[xs.length - 1]! * 1000).toFixed(1)}µs`;
}

const SAMPLES = 2000;
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

for (const path of process.argv.slice(2)) {
  const t0 = performance.now();
  const m = load(path);
  const loadMs = performance.now() - t0;
  const ops: Record<string, (i: number) => unknown> = {
    seek: (i) => (m.location(i), m.callStack(i), m.canStep(i)),
    into: (i) => m.stepInto(i),
    back: (i) => m.stepBackInto(i),
    over: (i) => m.stepOver(i),
    backOver: (i) => m.stepBackOver(i),
    out: (i) => m.stepOut(i),
    backOut: (i) => m.stepBackOut(i),
  };
  console.log(`${path.split('/').pop()}: ${m.count} steps, ${m.scopes.length} scopes, loaded in ${loadMs.toFixed(0)} ms`);
  for (const [name, op] of Object.entries(ops)) {
    const times: number[] = [];
    for (let k = 0; k < SAMPLES; k++) {
      const i = Math.floor(rand() * m.count);
      const a = performance.now();
      op(i);
      times.push(performance.now() - a);
    }
    console.log(`  ${name.padEnd(9)} ${stats(times)}`);
  }
}
