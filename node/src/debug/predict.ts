/**
 * Will anyone catch this exception? Asked at its first sighting, while every frame is still live,
 * so an `uncaught` pause can land on the frame that raised, as Pyokka's does, instead of where V8's
 * own prediction would put it: V8 counts the instrumenter's catch-and-rethrow wrapper in every
 * function as a handler, and Node's module loader catches what top-level code throws, so V8 only
 * calls an exception uncaught when no frame of the program is left.
 *
 * The walk goes from the raising frame outwards. A program frame whose position sits inside the
 * block of a `try` that has a `catch` (not the instrumenter's, whose parameter is `_tk_e_`) catches
 * it. A frame inside an `async` function or a generator makes the answer unknown: the exception
 * becomes a rejection, and who handles that is decided later. A library frame is unknown too (it
 * may catch). Reaching Node's own frames that run the program (module loading, timers, I/O
 * callbacks) without a handler means uncaught; a microtask runner below means a promise job, unknown.
 */
import { parseSync } from 'oxc-parser';
import { LineIndex } from '../lines.ts';

export interface Regions {
  index: LineIndex;
  /** [start, end) of each `try` block that has a handler of the program's own */
  tries: [number, number][];
  /** [start, end) of each async function or generator body */
  deferred: [number, number][];
}

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

export function regionsOf(source: string, filename = 'x.js'): Regions {
  const tries: [number, number][] = [];
  const deferred: [number, number][] = [];
  const res = parseSync(filename.replace(/\.(ts|mts|cts)$/i, '.js'), source, { sourceType: 'unambiguous' } as any);
  const visit = (n: any): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(visit);
    if (typeof n.type !== 'string') return;
    if (n.type === 'TryStatement' && n.handler && n.handler.param?.name !== '_tk_e_') tries.push([n.block.start, n.block.end]);
    if (FUNCTIONS.has(n.type) && (n.async || n.generator) && n.body) deferred.push([n.body.start, n.body.end]);
    for (const key of Object.keys(n)) if (key !== 'type' && n[key] && typeof n[key] === 'object') visit(n[key]);
  };
  visit(res.program);
  return { index: new LineIndex(source), tries, deferred };
}

/** What the frame at (0-based line, column) of this script does with an exception passing through. */
export function frameVerdict(r: Regions, line0: number, col: number): 'catches' | 'deferred' | 'passes' {
  const offset = r.index.offset(line0 + 1, col);
  // the innermost enclosing function decides `deferred`; a try inside it, `catches`
  let fnStart = -1;
  for (const [s, e] of r.deferred) if (s <= offset && offset < e && s > fnStart) fnStart = s;
  for (const [s, e] of r.tries) if (s <= offset && offset < e && s > fnStart) return 'catches';
  return fnStart >= 0 ? 'deferred' : 'passes';
}

/** Node frames that run program code directly: an exception that reaches them unhandled ends the run. */
const RUNS_PROGRAM = /^node:internal\/(modules\/|timers|process\/execution|main\/|streams\/|net|child_process|events|fs\/|http|_http|dgram|stream_base_commons|readline)/;
const MICROTASKS = /^node:internal\/process\/task_queues/;

export type Verdict = 'uncaught' | 'caught' | 'unknown';

export interface FrameView {
  /** the script's path or URL */
  url: string;
  line0: number;
  col: number;
  /** regions for a program file, null for anything else */
  regions: Regions | null;
  library: boolean;
}

export function predict(frames: FrameView[]): Verdict {
  for (const f of frames) {
    if (f.regions) {
      const v = frameVerdict(f.regions, f.line0, f.col);
      if (v === 'catches') return 'caught';
      if (v === 'deferred') return 'unknown';
      continue;
    }
    if (f.library) return 'unknown';
    if (MICROTASKS.test(f.url)) return 'unknown';
    if (RUNS_PROGRAM.test(f.url)) return 'uncaught';
    // the runtime's own frames and builtins in between neither catch nor end the walk
  }
  // the bottom of the stack: a callback V8 ran from a microtask, or an event loop entry Node does not show
  return frames.length && frames[frames.length - 1]!.regions ? 'unknown' : 'uncaught';
}
