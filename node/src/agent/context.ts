/**
 * The context slice and the `story` blocks over a `SavedRun`, as Pyokka's `agent/context.py`.
 *
 * Pure functions; `blockLines` mirrors `buildBlock` in `src/session/contextSlice.ts`: the lines a
 * block ran, its function header, and a single blank or comment line between two of them. An agent
 * reads the lines that ran in a context window, not a rendering. Shapes are the ones in
 * docs/PROTOCOL.md ("Context slice").
 */
import { COV_NOT_RUN, FLAG_ERROR, FLAG_LOG, FLAG_SCOPE_ENTRY, FLAG_UNWINDING } from './protocol.ts';
import { pyStrip } from './recording.ts';
import type { SavedRun } from './source.ts';

type Msg = Record<string, any>;

export const BLOCK_LINES = 60;
export const VALUE_CAP = 20;
export const STORY_LINE_CAP = 150;
export const STEPS_DEFAULT = 40;
export const FIND_CAP = 50;
/** calls listed for one statement in `context` */
export const CALLS_CAP = 20;

/** a comment line in JavaScript: `//`, or a line of a `/* … *\/` block */
export function isCommentLine(line: string): boolean {
  const t = pyStrip(line);
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*');
}

function blankOrComment(line: string): boolean {
  return pyStrip(line) === '' || isCommentLine(line);
}

/** sort by a key tuple, as Python's `sorted(key=...)`: stable, element-wise */
export function sortBy<T>(items: T[], key: (x: T) => (number | string)[]): T[] {
  const keyed = items.map((x) => [key(x), x] as const);
  keyed.sort((a, b) => {
    for (let i = 0; i < Math.min(a[0].length, b[0].length); i++) {
      const x = a[0][i]!;
      const y = b[0][i]!;
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return a[0].length - b[0].length;
  });
  return keyed.map((k) => k[1]);
}

// -- blocks -----------------------------------------------------------------------------------------------

/** `[{line, text, step}]` for one block: the lines that ran (first step each), the header, one-line context */
export function blockLines(run: SavedRun, scopeId: number, first: number, last: number, fileId: number): Msg[] {
  const trace = run.trace;
  const src = run.sourceLines(fileId);
  const firstStepOfLine = new Map<number, number>();
  const setDefault = (l: number, k: number) => {
    if (!firstStepOfLine.has(l)) firstStepOfLine.set(l, k);
  };
  for (let k = first; k <= last; k++) {
    const loc = trace.location(k);
    if (loc === null || loc[0] !== fileId) continue;
    const rng = loc[1];
    for (let l = rng[0]!; l <= Math.min(rng[2]!, rng[0]! + 1); l++) setDefault(l, k);
    setDefault(rng[0]!, k);
  }
  if (!firstStepOfLine.size || !src.length) return [];
  const scope = trace.scope(scopeId);
  const scopeLoc = scope ? run.locate(Number(scope.rid)) : null;
  const wanted = new Set(firstStepOfLine.keys());
  if (scopeLoc && scopeLoc.fileId === fileId && scope && Number(scope.parent) >= 0) {
    const header = Number(scopeLoc.range[0]);
    wanted.add(header);
    let l = header - 1;
    while (l >= 1 && isCommentLine(l - 1 < src.length ? src[l - 1]! : '') && header - l <= 3) {
      wanted.add(l);
      l--;
    }
  }
  const ordered = [...wanted].filter((l) => l >= 1 && l <= src.length).sort((a, b) => a - b);
  const out: Msg[] = [];
  let prev: number | null = null;
  for (const cur of ordered) {
    if (prev !== null && cur - prev - 1 === 1 && blankOrComment(prev < src.length ? src[prev]! : '')) out.push({ line: prev + 1, text: src[prev], step: null });
    out.push({ line: cur, text: src[cur - 1], step: firstStepOfLine.get(cur) ?? null });
    prev = cur;
  }
  return out;
}

function stepLocation(run: SavedRun, step: number): Msg {
  const loc = run.locate(run.trace.rid(step));
  const scope = run.trace.scope(run.trace.scopeId(step));
  const fn = scope ? scope.name : '<module>';
  if (loc === null) return { file: null, line: 0, col: 0, function: fn, fileId: -1 };
  return { file: loc.path, line: Number(loc.range[0]), col: Number(loc.range[1]), function: fn, fileId: loc.fileId };
}

export function logValue(run: SavedRun, ev: Msg): Msg {
  const loc = run.locate(Number(ev.rid ?? -1));
  return {
    line: loc ? Number(loc.range[0]) : 0,
    file: loc ? loc.path : null,
    context: ev.context ?? null,
    text: ev.text ?? null,
    step: ev.step ?? null,
    hit: ev.hit ?? null,
    kind: ev.kind ?? null,
    runtimeKey: ev.runtimeKey ?? null,
  };
}

function localValues(run: SavedRun, step: number): Msg[] {
  const out: Msg[] = [];
  const loc = run.trace.location(step);
  for (const entry of run.localsByStep.get(step) ?? []) {
    for (const ch of entry.changes ?? []) out.push({ line: loc ? Number(loc[1][0]) : 0, file: loc ? run.filePath(loc[0]) : null, context: ch.name ?? null, text: ch.text ?? null, step, hit: null, kind: 'local', runtimeKey: null });
  }
  return out;
}

/** log entries and recorded locals of the block's steps, by step */
export function blockValues(run: SavedRun, first: number, last: number, fileId: number): Msg[] {
  const out: Msg[] = [];
  for (const ev of run.logs) {
    const st = ev.step;
    if (st !== null && st !== undefined && first <= Number(st) && Number(st) <= last && Number(ev.fileId ?? -1) === fileId) out.push(logValue(run, ev));
  }
  for (let step = first; step <= last; step++) if (run.localsByStep.has(step)) out.push(...localValues(run, step));
  return sortBy(out, (v) => [v.step ?? -1, v.line]);
}

function window<T>(items: T[], currentIndex: number, cap: number): [T[], boolean] {
  if (items.length <= cap) return [items, false];
  const start = Math.max(0, Math.min(currentIndex - Math.floor(cap / 2), items.length - cap));
  return [items.slice(start, start + cap), true];
}

/** statement lines inside the block's function (or module) that never ran, when coverage knows */
export function blockNotRun(run: SavedRun, scopeId: number, fileId: number, cap = BLOCK_LINES): number[] {
  const f = run.files.get(fileId);
  const cov = run.coverage.get(fileId);
  if (!f || !cov) return [];
  const states: number[] = cov.states ?? [];
  const ranges: number[][] = f.ranges ?? [];
  const scope = run.trace.scope(scopeId);
  let body: number[] | null = null;
  if (scope && Number(scope.parent) >= 0) {
    const loc = run.locate(Number(scope.rid));
    if (loc && loc.fileId === fileId) {
      const local = loc.localRid;
      body = (f.functions ?? []).find((fn: Msg) => Number(fn.rid ?? -1) === local)?.bodyRange || loc.range;
    }
  }
  const lines = new Set<number>();
  for (const local of f.statements ?? []) {
    if (local >= states.length || local >= ranges.length || states[local] !== COV_NOT_RUN) continue;
    const r = ranges[local]!;
    if (body !== null && !(body[0]! <= r[0]! && r[0]! <= body[2]!)) continue;
    lines.add(Number(r[0]));
  }
  return [...lines].sort((a, b) => a - b).slice(0, cap);
}

export function blockErrors(run: SavedRun, first: number, last: number, fileId: number, lines: Set<number>): Msg[] {
  const seen = new Map<string, Msg>();
  // the uncaught exception can be emitted twice (handled at a finally, then uncaught at the end): one entry, unhandled
  for (const ev of sortBy(run.errors, (e) => [e.handled ? 1 : 0])) {
    const step = ev.step ?? null;
    let hitLine: number | null = null;
    if (Number(ev.fileId ?? -1) === fileId) {
      const loc = run.locate(Number(ev.rid ?? -1));
      if (loc && lines.has(Number(loc.range[0]))) hitLine = Number(loc.range[0]);
    }
    if (hitLine === null) {
      for (const frame of ev.stack ?? []) {
        if (Number(frame.fileId ?? -1) === fileId && lines.has(Number(frame.line ?? 0))) {
          hitLine = Number(frame.line);
          break;
        }
      }
    }
    if (hitLine === null && !(step !== null && first <= Number(step) && Number(step) <= last)) continue;
    const key = JSON.stringify([ev.errorType ?? null, ev.message ?? null, hitLine, step]);
    if (seen.has(key)) continue;
    seen.set(key, { line: hitLine, type: ev.errorType ?? null, message: ev.message ?? null, step, handled: !!ev.handled });
  }
  return sortBy([...seen.values()], (e) => [e.step ?? -1]);
}

export function contextSlice(run: SavedRun, step: number, scope = false): Msg {
  const trace = run.trace;
  const [scopeId, first, last] = trace.blockAt(step)!;
  const loc = trace.location(step);
  const fileId = loc ? loc[0] : -1;
  const location = stepLocation(run, step);
  const lines = blockLines(run, scopeId, first, last, fileId);
  const curLine = location.line;
  for (const entry of lines) if (entry.line === curLine) entry.current = true;
  const ci = lines.findIndex((e) => e.current);
  const curIndex = ci >= 0 ? ci : 0;
  const [shown, capped] = scope ? [lines, false] : window(lines, curIndex, BLOCK_LINES);
  const values = blockValues(run, first, last, fileId);
  const vi = values.findIndex((v) => v.step !== null && v.step >= step);
  const vIndex = vi >= 0 ? vi : values.length - 1;
  const [valuesShown, valuesCapped] = scope ? [values, false] : window(values, Math.max(vIndex, 0), VALUE_CAP);
  const scopeInfo = trace.scope(scopeId);
  const stack = trace.callStack(step).map((f) => ({ file: run.filePath(f.fileId), line: f.line, function: f.function, step: f.step }));
  const blockLineSet = new Set(lines.map((e) => e.line as number));
  const blockOut: Msg = {
    file: run.filePath(fileId),
    function: scopeInfo ? scopeInfo.name : '<module>',
    scopeId,
    firstStep: first,
    lastStep: last,
    lines: shown,
    totalLines: lines.length,
    capped,
  };
  if (scopeInfo && last === Number(scopeInfo.last ?? -1)) Object.assign(blockOut, exitOf(scopeInfo)); // the function left in this block
  return {
    step,
    count: trace.count,
    location,
    stale: run.staleFiles().length > 0,
    staleFiles: run.staleFiles(),
    stack,
    block: blockOut,
    calls: stepCalls(run, step, scopeId),
    values: valuesShown,
    valuesTotal: values.length,
    valuesCapped,
    coverage: { notRun: blockNotRun(run, scopeId, fileId) },
    moves: trace.moves(step),
    errors: blockErrors(run, first, last, fileId, blockLineSet),
    flags: flagNames(trace.flags(step)),
  };
}

export function flagNames(bits: number): string[] {
  const out: string[] = [];
  if (bits & FLAG_SCOPE_ENTRY) out.push('entry');
  if (bits & FLAG_LOG) out.push('log');
  if (bits & FLAG_ERROR) out.push('error');
  if (bits & FLAG_UNWINDING) out.push('unwinding');
  return out;
}

// -- values on a line ----------------------------------------------------------------------------------------

export function valuesOnLine(run: SavedRun, fileId: number, line: number): Msg[] {
  const out: Msg[] = [];
  for (const ev of run.logs) {
    if (Number(ev.fileId ?? -1) !== fileId) continue;
    const loc = run.locate(Number(ev.rid ?? -1));
    if (loc && Number(loc.range[0]) === line) out.push(logValue(run, ev));
  }
  for (const step of run.trace.stepsOnLine(fileId, line)) out.push(...localValues(run, step));
  return sortBy(out, (v) => [v.step ?? -1, v.hit || 0]);
}

/** `returned` (the value as text) or `raised` (the exception type) a scope recorded at its exit; empty for older runs */
export function exitOf(scope: Msg): Msg {
  if ('returned' in scope) {
    const out: Msg = { returned: scope.returned };
    for (const key of ['returnedTruncated', 'returnedLength']) if (key in scope) out[key] = scope[key]; // the recording cut the text (`…(+N chars)`)
    return out;
  }
  if ('raised' in scope) return { raised: scope.raised };
  return {};
}

/** the calls the statement at `step` made, in order, each with what it returned or raised */
export function stepCalls(run: SavedRun, step: number, scopeId: number): Msg[] {
  const trace = run.trace;
  const over = trace.stepOver(step);
  const end = over >= 0 ? over : trace.count;
  const out: Msg[] = [];
  for (const s of trace.scopes) {
    if (Number(s.parent ?? -1) === scopeId && step < Number(s.first) && Number(s.first) < end && String(s.name) !== '<module>') {
      out.push({ function: String(s.name), scopeId: Number(s.scopeId), step: Number(s.first), ...exitOf(s) });
      if (out.length >= CALLS_CAP) break;
    }
  }
  return out;
}

// -- story ------------------------------------------------------------------------------------------------------

export function story(run: SavedRun, opts: { fileId?: number | null; scope?: string | null; line?: [number, number] | null; lineCap?: number } = {}): Msg {
  const { fileId = null, scope = null, line = null, lineCap = STORY_LINE_CAP } = opts;
  const trace = run.trace;
  const blocksOut: Msg[] = [];
  let total = 0;
  let matched = 0;
  let shownLines = 0;
  let truncated = false;
  const filtered = fileId !== null || scope !== null || line !== null;
  trace.blocks().forEach(([scopeId, first, last], index) => {
    total++;
    const loc = trace.location(first);
    const fid = loc ? loc[0] : -1;
    const name = run.scopeName(scopeId);
    if (fileId !== null && fid !== fileId) return;
    if (scope !== null && name !== scope) return;
    const lines = blockLines(run, scopeId, first, last, fid);
    if (line !== null && !(fid === line[0] && lines.some((e) => e.line === line[1]))) return;
    matched++;
    if (truncated) return;
    if (shownLines + lines.length > lineCap && blocksOut.length) {
      truncated = true;
      return;
    }
    shownLines += lines.length;
    blocksOut.push({ index, scopeId, function: name, file: run.filePath(fid), fileId: fid, firstStep: first, lastStep: last, lines, noSource: !lines.length });
  });
  return { blocks: blocksOut, total, matched, filtered, shown: blocksOut.length, count: trace.count, truncated, stale: run.staleFiles().length > 0, staleFiles: run.staleFiles() };
}

// -- steps -------------------------------------------------------------------------------------------------------

function stepRow(run: SavedRun, i: number): Msg {
  const loc = run.trace.location(i);
  return {
    step: i,
    file: loc ? run.filePath(loc[0]) : null,
    line: loc ? Number(loc[1][0]) : 0,
    function: run.scopeName(run.trace.scopeId(i)),
    depth: run.trace.depth(i),
    scopeId: run.trace.scopeId(i),
    flags: flagNames(run.trace.flags(i)),
  };
}

export function listSteps(run: SavedRun, opts: { start?: number; count?: number; line?: [number, number] | null } = {}): Msg {
  const trace = run.trace;
  const count = Math.max(1, opts.count ?? STEPS_DEFAULT);
  const line = opts.line ?? null;
  if (line !== null) {
    const on = trace.stepsOnLine(line[0], line[1]);
    const rows = on.slice(0, count).map((i) => stepRow(run, i));
    return { steps: rows, count: trace.count, total: on.length, next: on.length > count ? on[count] : null, line: { file: run.filePath(line[0]), line: line[1] } };
  }
  const start = Math.max(0, opts.start ?? 0);
  const end = Math.min(trace.count, start + count);
  const rows: Msg[] = [];
  for (let i = start; i < end; i++) rows.push(stepRow(run, i));
  return { steps: rows, count: trace.count, from: start, next: end < trace.count ? end : null };
}

// -- find --------------------------------------------------------------------------------------------------------

export function find(run: SavedRun, text: string, limit = FIND_CAP): Msg {
  const needle = text.toLowerCase();
  const hits: Msg[] = [];
  let total = 0;
  const add = (hit: Msg) => {
    total++;
    if (hits.length < limit) hits.push(hit);
  };
  for (const ev of run.logs) {
    const blob = `${ev.context || ''} ${ev.text || ''}`;
    if (blob.toLowerCase().includes(needle)) {
      const v = logValue(run, ev);
      add({ kind: 'value', file: v.file, line: v.line, step: v.step, context: v.context, text: v.text });
    }
  }
  for (const entry of run.localsEntries) {
    const step = Number(entry.step ?? -1);
    const loc = run.trace.location(step);
    for (const ch of entry.changes ?? []) {
      if (`${ch.name || ''} ${ch.text || ''}`.toLowerCase().includes(needle)) add({ kind: 'local', file: loc ? run.filePath(loc[0]) : null, line: loc ? Number(loc[1][0]) : 0, step, context: ch.name ?? null, text: ch.text ?? null });
    }
  }
  for (const ev of run.errors) {
    if (`${ev.errorType || ''} ${ev.message || ''}`.toLowerCase().includes(needle)) {
      const loc = run.locate(Number(ev.rid ?? -1));
      add({ kind: 'error', file: loc ? loc.path : null, line: loc ? Number(loc.range[0]) : 0, step: ev.step ?? null, context: ev.errorType ?? null, text: ev.message ?? null });
    }
  }
  for (const ev of run.output) {
    if (String(ev.text || '').toLowerCase().includes(needle)) add({ kind: 'output', file: null, line: 0, step: ev.step ?? null, context: ev.stream ?? null, text: String(ev.text || '').replace(/\n+$/, '') });
  }
  // executed statement lines (any file that ran), in the order they first ran
  const firstStepByLine = new Map<string, [number, number, number]>();
  for (let i = 0; i < run.trace.count; i++) {
    const loc = run.trace.location(i);
    if (loc !== null) {
      const key = `${loc[0]}:${loc[1][0]}`;
      if (!firstStepByLine.has(key)) firstStepByLine.set(key, [loc[0], Number(loc[1][0]), i]);
    }
  }
  for (const [fid, ln, step] of sortBy([...firstStepByLine.values()], (v) => [v[2]])) {
    const src = run.sourceLines(fid);
    if (ln >= 1 && ln <= src.length && src[ln - 1]!.toLowerCase().includes(needle)) add({ kind: 'line', file: run.filePath(fid), line: ln, step, context: run.scopeName(run.trace.scopeId(step)), text: pyStrip(src[ln - 1]!) });
  }
  return { text, hits, total, truncated: total > hits.length };
}
