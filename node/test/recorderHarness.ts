/** Test harness: instrument a source with the core instrumenter, run it under a Recorder, and read the trace back. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { instrument } from '../src/instrument.ts';
import { decodeSteps } from '../src/protocol.ts';
import { Recorder, type RecorderConfig, type Scope } from '../src/recorder/recorder.ts';

export interface Row {
  step: number;
  line: number;
  scope: number;
  name: string;
  depth: number;
  flags: number;
}

export interface Recorded {
  recorder: Recorder;
  events: Record<string, any>[];
  rows: Row[];
  scopes: Scope[];
  final: Record<string, any>;
  /** values the program handed to `globalThis.__seen` */
  seen: any[];
}

let dir: string | undefined;
let counter = 0;

/** Run `source` as an ES module; its top-level awaits finish before the trace is read. */
export async function record(source: string, config: RecorderConfig = {}, filename = 'prog.mjs'): Promise<Recorded> {
  const inst = instrument(source, filename, 1, 0, { sourceType: 'module', sourceMap: false, recordLocals: !!config.recordLocals });
  if (inst.error || inst.code == null) throw new Error(inst.error ?? 'no code');
  const events: Record<string, any>[] = [];
  const recorder = new Recorder((e) => events.push(e), config);
  recorder.addFile(inst);
  const g = globalThis as any;
  const seen: any[] = [];
  g.__seen = seen;
  g.__rec = recorder;
  g.__tk = {
    ...recorder.hooks(),
    v: (_rid: number, _ctx: unknown, value: unknown) => value,
    t: (_rid: number, _ctx: unknown, _t0: unknown, value: unknown) => value,
    log: (_rid: number, _method: string, ..._args: unknown[]) => {},
    lp: () => {},
    h: () => {},
    now: () => performance.now(),
  };
  dir ??= mkdtempSync(join(tmpdir(), 'tk-rec-'));
  const file = join(dir, `p${counter++}.mjs`);
  writeFileSync(file, inst.code);
  await import(pathToFileURL(file).href);
  recorder.finish();
  const final = events.findLast((e) => e.type === 'trace' && !e.partial)!;
  const quads = decodeSteps(final.steps);
  const scopes: Scope[] = final.scopes;
  const rows: Row[] = [];
  for (let i = 0; i < quads.length / 4; i++) {
    const rid = quads[i * 4]!;
    const scope = quads[i * 4 + 1]!;
    rows.push({ step: i, line: inst.ranges[rid]![0], scope, name: scopes[scope]!.name, depth: quads[i * 4 + 2]!, flags: quads[i * 4 + 3]! });
  }
  return { recorder, events, rows, scopes, final, seen };
}

/** The host's step over / out (src/timeMachine/traceModel.ts): next step in the scope's parent chain. */
export function lineage(scopes: Scope[], sid: number, strict: boolean): Set<number> {
  const out = new Set<number>();
  if (strict) sid = scopes[sid]?.parent ?? -1;
  while (sid >= 0 && !out.has(sid)) {
    out.add(sid);
    sid = scopes[sid]?.parent ?? -1;
  }
  return out;
}

export function stepOver(r: Recorded, i: number): number {
  const set = lineage(r.scopes, r.rows[i]!.scope, false);
  for (let j = i + 1; j < r.rows.length; j++) if (set.has(r.rows[j]!.scope)) return j;
  return -1;
}

export function stepOut(r: Recorded, i: number): number {
  const set = lineage(r.scopes, r.rows[i]!.scope, true);
  for (let j = i + 1; j < r.rows.length; j++) if (set.has(r.rows[j]!.scope)) return j;
  return -1;
}

/** "line:name" per step, compact for assertions */
export function path(r: Recorded): string[] {
  return r.rows.map((x) => `${x.line}:${x.name}`);
}
