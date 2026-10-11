/**
 * Record a JS program and write the two events the Time Machine needs (`file.instrumented`, the
 * final `trace`) as a saved-run-shaped JSON, for bench/stepping.ts.
 *
 *     node --experimental-strip-types bench/saveRun.ts prog.mjs out.run.json
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { instrument } from '../src/instrument.ts';
import { Recorder } from '../src/recorder/recorder.ts';

const [src, out] = process.argv.slice(2);
const inst = instrument(readFileSync(src!, 'utf8'), basename(src!), 1, 0, { sourceType: 'module', sourceMap: false });
const events: Record<string, unknown>[] = [{ type: 'file.instrumented', fileId: 1, path: src, rangeBase: 0, ranges: inst.ranges, statements: inst.statements, functions: inst.functions }];
const rec = new Recorder((e) => events.push(e), { maxTraceSteps: 2_000_000 });
rec.addFile(inst);
const noop = () => {};
(globalThis as any).__tk = { h: noop, now: () => performance.now(), v: (_r: number, _c: unknown, v: unknown) => v, t: noop, log: noop, lp: noop, ...rec.hooks() };
const file = join(mkdtempSync(join(tmpdir(), 'tk-save-')), 'p.mjs');
writeFileSync(file, inst.code!);
const t0 = performance.now();
await import(pathToFileURL(file).href);
const ms = performance.now() - t0;
rec.finish();
events.push({ type: 'run.finished', exitCode: 0, durationMs: ms, stepCount: rec.n });
writeFileSync(out!, JSON.stringify({ meta: { file: src, stepCount: rec.n, durationMs: ms }, events: events.filter((e) => e.type !== 'trace' || !e.partial) }));
console.log(`${src}: ${rec.n} steps in ${ms.toFixed(1)} ms`);
