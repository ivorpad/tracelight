/**
 * The exceptions report: every exception a run raised, where, where it was caught, how often
 * (docs/PROTOCOL.md, "Exceptions report").
 *
 * One row per (kind, error type, raise site, handler) over the run's `error` events, the uncaught
 * one first, the broad handlers flagged. The runtime already aggregates repeats per site; the
 * builder folds again so older saved runs give the same rows.
 */
import type { RunSource, SavedRun } from './source.ts';
import { cut } from './walkthrough.ts';

type Msg = Record<string, any>;

export const MESSAGE_MAX = 200;
export const LINE_MAX = 100;
const KIND_ORDER: Record<string, number> = { uncaught: 0, caught: 1 };

const kindOf = (ev: Msg): string => (ev.handled ? 'caught' : 'uncaught');

/** the event's `handledAt`: only a caught exception has one, and none when native code swallowed it */
function handler(ev: Msg): Msg | null {
  const at = ev.handledAt;
  return ev.handled && at && typeof at === 'object' && !Array.isArray(at) ? at : null;
}

const stepOf = (ev: Msg): number => (ev.step !== null && ev.step !== undefined ? Number(ev.step) : 0);
const pyStr = (v: unknown): string => (v === null || v === undefined ? 'None' : String(v));

/** the statement that raised (its first line) and the frame's function */
function raisedAt(run: SavedRun, ev: Msg): Msg {
  const fid = Number(ev.fileId ?? -1);
  const rid = Number(ev.rid ?? -1);
  const loc = run.locate(rid);
  const stack = (ev.stack ?? []).filter((f: unknown) => f && typeof f === 'object' && !Array.isArray(f));
  const frame = stack.find((f: Msg) => f.rid === rid) ?? (stack.length ? stack[0] : null);
  const fn = frame ? frame.function : null;
  return { file: run.filePath(fid), line: loc ? Number(loc.range[0]) : 0, function: fn !== null && fn !== undefined ? String(fn) : '<module>', fileId: fid, rid };
}

function handledAt(run: SavedRun, at: Msg | null): Msg | null {
  if (at === null) return null;
  const fid = Number(at.fileId ?? -1);
  return { file: run.filePath(fid), line: Number(at.line || 0), function: String(at.function || '<module>'), fileId: fid, rid: Number(at.rid ?? -1), broad: !!at.broad };
}

export function exceptions(run: SavedRun): Msg {
  const groups = new Map<string, Msg>(); // (kind, errorType, origin rid, handler rid or null) -> the row being folded
  for (const ev of run.errors) {
    const kind = kindOf(ev);
    const at = handler(ev);
    const key = JSON.stringify([kind, pyStr(ev.errorType), Number(ev.rid ?? -1), at !== null && at.rid !== null && at.rid !== undefined ? Number(at.rid) : null]);
    const step = stepOf(ev);
    const count = ev.count !== null && ev.count !== undefined ? Number(ev.count) : 1;
    const last = ev.lastStep !== null && ev.lastStep !== undefined ? Number(ev.lastStep) : step;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { kind, first: ev, count, step, lastStep: last });
      continue;
    }
    g.count += count;
    g.lastStep = Math.max(g.lastStep, last);
    if (step < g.step) {
      // the first raise describes the row: its message, stack and handler
      g.step = step;
      g.first = ev;
    }
  }
  const sorted = [...groups.values()].sort((a, b) => KIND_ORDER[a.kind]! - KIND_ORDER[b.kind]! || a.step - b.step || (pyStr(a.first.errorType) < pyStr(b.first.errorType) ? -1 : pyStr(a.first.errorType) > pyStr(b.first.errorType) ? 1 : 0));
  const rows = sorted.map((g, n) => {
    const ev = g.first;
    return {
      id: `x${n}`,
      kind: g.kind,
      errorType: pyStr(ev.errorType),
      message: cut(ev.message, MESSAGE_MAX),
      count: g.count,
      step: g.step,
      lastStep: g.lastStep,
      raisedAt: raisedAt(run, ev),
      handledAt: handledAt(run, handler(ev)),
    };
  });
  return {
    count: run.trace.count,
    file: run.meta.file ?? null,
    exitCode: run.meta.exitCode ?? null,
    stale: run.staleFiles().length > 0,
    staleFiles: run.staleFiles(),
    total: rows.length,
    raises: rows.reduce((s, r) => s + Number(r.count), 0),
    uncaught: rows.filter((r) => r.kind === 'uncaught').length,
    caught: rows.filter((r) => r.kind === 'caught').length,
    broad: rows.filter((r) => r.handledAt !== null && r.handledAt.broad).length,
    rows,
  };
}

// -- text form -----------------------------------------------------------------------------------------------------

function fit(text: string, limit = LINE_MAX): string {
  const s = text.replace(/\s*\n\s*/g, ' ');
  const chars = [...s];
  return chars.length <= limit ? s : chars.slice(0, limit - 1).join('') + '…';
}

/** `8 exceptions over 412 steps: 1 uncaught, 7 caught (10 raises), 2 by a broad handler` */
export function summary(result: Msg): string {
  const total = Number(result.total || 0);
  const steps = Number(result.count || 0);
  if (!total) return `no exceptions over ${steps} steps`;
  const caught = Number(result.caught || 0);
  const caughtRaises = (result.rows ?? []).filter((r: Msg) => r.kind === 'caught').reduce((s: number, r: Msg) => s + Number(r.count || 0), 0);
  let text = `${total} exception${total === 1 ? '' : 's'} over ${steps} steps: ${Number(result.uncaught || 0)} uncaught, ${caught} caught`;
  if (caughtRaises !== caught) text += ` (${caughtRaises} raises)`;
  if (result.broad) text += `, ${Number(result.broad)} by a broad handler`;
  return text;
}

/** the summary, then two lines per row: `#step  kind [×count] errorType: message` and where it was raised and caught */
export function renderExceptions(result: Msg, source: RunSource): string[] {
  const at = (site: Msg) => `${source.displayPath(site.file)}:${pyStr(site.line)} ${pyStr(site.function)}`;
  const out = [summary(result)];
  for (const r of result.rows ?? []) {
    const times = Number(r.count || 0) > 1 ? ` ×${Number(r.count)}` : '';
    const message = r.message;
    out.push(fit(`#${Number(r.step)}  ${r.kind}${times} ${r.errorType}${message ? `: ${message}` : ''}`));
    let where = `      raised ${at(r.raisedAt)}`;
    if (r.kind === 'caught') {
      const h = r.handledAt;
      where += h ? ` · caught ${at(h)}${h.broad ? ' broad handler' : ''}` : ' · caught outside stepped code';
    }
    if (r.lastStep !== r.step) where += ` · last #${Number(r.lastStep)}`;
    out.push(fit(where));
  }
  return out;
}
