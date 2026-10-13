/**
 * Where a breakpoint spec lands: a file and a line, or the
 * function a bare name means.
 *
 * A `path` and a `line` resolve to the statement on that line, a blank or comment line to the
 * next statement in the file, and a line past the last statement to the nearest earlier one.
 * `{function: NAME}` resolves to the rid of the function's header, the rid the entry hook
 * (`__tk.f`) steps on, so it pauses at every call before the first statement. A dotted NAME
 * (`Ranker.rank`) matches on its last segment. Without a path every non-library file is searched
 * in instrumentation order; a second definition does not move the breakpoint, it adds an `error`
 * naming where else the name lives.
 */
import path from 'node:path';
import fs from 'node:fs';
import type { Range } from '../protocol.ts';

export interface DebugFile {
  fileId: number;
  path: string;
  rangeBase: number;
  ranges: Range[];
  /** source line -> global rid of the statement on it */
  lineRids: Map<number, number>;
  /** global rid of a function header -> its name */
  functionNames: Map<number, string>;
  library?: boolean;
}

export interface ResolvableBreakpoint {
  path: string;
  line: number;
  function: string | null;
  error: string | null;
  rid: number | null;
  fileId: number | null;
  resolvedLine: number | null;
}

/** True when this call gave the breakpoint its rid. `file` is the file just instrumented, else all of them. */
export function resolveBreakpoint(files: DebugFile[], bp: ResolvableBreakpoint, file?: DebugFile): boolean {
  if (bp.function) return byFunction(files, bp, file);
  return bp.rid === null && byLine(files, bp, file);
}

export function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function candidates(files: DebugFile[], bp: ResolvableBreakpoint, file?: DebugFile): DebugFile[] {
  const pool = file ? [file] : files;
  if (!bp.path) return pool.filter((f) => !f.library);
  const want = real(bp.path);
  return pool.filter((f) => real(f.path) === want);
}

function byLine(files: DebugFile[], bp: ResolvableBreakpoint, file?: DebugFile): boolean {
  if (!bp.path) return false;
  for (const f of candidates(files, bp, file)) {
    const lines = [...f.lineRids.keys()];
    if (!lines.length) return false;
    let line: number;
    if (f.lineRids.has(bp.line)) line = bp.line;
    else {
      const later = lines.filter((l) => l > bp.line);
      const earlier = lines.filter((l) => l <= bp.line);
      line = later.length ? Math.min(...later) : earlier.length ? Math.max(...earlier) : Math.min(...lines);
    }
    bp.rid = f.lineRids.get(line)!;
    bp.fileId = f.fileId;
    bp.resolvedLine = line;
    return true;
  }
  return false;
}

function byFunction(files: DebugFile[], bp: ResolvableBreakpoint, file?: DebugFile): boolean {
  let hit = false;
  for (const f of candidates(files, bp, file)) {
    const rid = firstDef(f, bp.function!);
    if (rid === null) continue;
    if (bp.rid === null) {
      bp.rid = rid;
      bp.fileId = f.fileId;
      bp.resolvedLine = lineOf(f, rid);
      bp.path = bp.path || f.path;
      bp.line = bp.line || bp.resolvedLine;
      hit = true;
    } else if (rid !== bp.rid && !bp.error) {
      bp.error = `also defined in ${display(files, f)}:${lineOf(f, rid)}; give FILE:LINE to pick one`;
    }
  }
  return hit;
}

function firstDef(f: DebugFile, name: string): number | null {
  const want = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
  if (!want || want.startsWith('<')) return null;
  for (const rid of [...f.functionNames.keys()].sort((a, b) => a - b)) if (f.functionNames.get(rid) === want) return rid;
  return null;
}

function lineOf(f: DebugFile, rid: number): number {
  const r = f.ranges[rid - f.rangeBase];
  return r ? r[0] : 0;
}

function display(files: DebugFile[], f: DebugFile): string {
  if (!files.length) return f.path;
  const rel = path.relative(path.dirname(files[0]!.path), f.path);
  return rel.startsWith('..') || path.isAbsolute(rel) ? f.path : rel;
}
