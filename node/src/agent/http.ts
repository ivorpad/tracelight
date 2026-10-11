/**
 * The HTTP table of a run and its text form (docs/PROTOCOL.md, "HTTP record and replay", HTTP
 * table), as Pyokka's `agent/http.py`: the `http.exchange` rows and `run.finished.http`, in `n`
 * (request) order.
 */
import { basename, extname } from 'node:path';
import type { RunSource } from './source.ts';
import { formatDuration } from './walkthrough.ts';

type Msg = Record<string, any>;

export const CAP = 500;
export const NAME_MAX = 60;
export const LINE_MAX = 100;

const pyStr = (v: unknown): string => (v === null || v === undefined ? 'None' : v === true ? 'True' : v === false ? 'False' : String(v));
const isNumber = (v: unknown): v is number => typeof v === 'number';

function cutText(text: unknown, limit: number): string {
  const chars = [...String(text ?? '')];
  return chars.length <= limit ? chars.join('') : chars.slice(0, limit - 1).join('') + '…';
}

/** Python's `urlsplit`: `[netloc, path]` */
function splitUrl(url: string): [string, string] {
  const m = /^(?:[A-Za-z][A-Za-z0-9+.-]*:)?(?:\/\/([^/?#]*))?([^?#]*)/.exec(url)!;
  return [m[1] ?? '', m[2] ?? ''];
}

/** the URL's last non-empty path segment, else its host; cut at 60 characters */
export function requestName(url: string): string {
  const [netloc, path] = splitUrl(url);
  const segments = path.split('/').filter(Boolean);
  const host = netloc.replace(/^.*@/, '').replace(/:\d*$/, '').replace(/^\[(.*)\]$/, '$1').toLowerCase();
  return cutText(segments.length ? segments[segments.length - 1] : host || netloc || url, NAME_MAX);
}

/** the table: the rows of `events` (at most `CAP`), their totals, `run.finished.http` as `finished` */
export function httpTable(events: Msg[], finished: Msg | null | undefined, opts: { running?: boolean; locate: (rid: number) => Msg | null; runId?: unknown }): Msg {
  const rows = events.filter((e) => e && typeof e === 'object' && e.type === 'http.exchange').sort((a, b) => Number(a.n || 0) - Number(b.n || 0));
  const missRows = rows.filter((r) => r.source === 'miss');
  const fin = finished && typeof finished === 'object' && !Array.isArray(finished) ? finished : null;
  const misses = fin && Number.isInteger(fin.misses) ? Number(fin.misses) : new Set(missRows.map((r) => JSON.stringify([r.method ?? null, r.url ?? null]))).size;
  let runId = opts.runId ?? null;
  if (runId === null) runId = rows.find((r) => r.runId !== null && r.runId !== undefined)?.runId ?? null;
  return {
    runId,
    running: !!opts.running,
    count: rows.length,
    truncated: rows.length > CAP,
    totals: {
      requests: rows.length,
      bytes: rows.filter((r) => isNumber(r.bytes)).reduce((s, r) => s + Math.trunc(r.bytes), 0),
      ms: rows.filter((r) => isNumber(r.ms)).reduce((s, r) => s + Math.trunc(r.ms), 0),
      misses,
      missAttempts: missRows.length,
    },
    finished: fin,
    requests: rows.slice(0, CAP).map((r) => request(r, opts.locate)),
  };
}

function request(row: Msg, locate: (rid: number) => Msg | null): Msg {
  const rid = row.rid;
  const location = Number.isInteger(rid) && rid >= 0 ? locate(rid) : null;
  return {
    n: row.n ?? null,
    client: row.client ?? null,
    method: row.method ?? null,
    url: row.url ?? null,
    name: requestName(String(row.url || '')),
    status: row.status ?? null,
    reason: row.reason ?? null,
    bytes: row.bytes ?? null,
    ms: row.ms ?? null,
    recordedMs: row.recordedMs ?? null,
    source: row.source ?? null,
    step: row.step ?? null,
    location: location && typeof location === 'object' ? location : null,
  };
}

// -- text -----------------------------------------------------------------------------------------------------

/** `18 B` / `6.8 kB` / `68 kB`: one decimal under 10 of a unit, none above */
export function formatBytes(n: unknown): string {
  if (!isNumber(n)) return '—';
  const v0 = Math.trunc(n);
  if (v0 < 1000) return `${v0} B`;
  for (const [unit, div] of [['kB', 1e3], ['MB', 1e6], ['GB', 1e9]] as const) {
    const v = v0 / div;
    if (v < 1000 || unit === 'GB') return v < 10 ? `${(Math.floor(v * 10 + 0.5) / 10).toFixed(1)} ${unit}` : `${Math.floor(v + 0.5)} ${unit}`;
  }
  return `${v0} B`;
}

/** `3f2a….jsonl (2026-09-11 10:12Z)`: the recording's name cut to its first hex digits, and its header's date */
export function recordingLabel(finished: Msg): string {
  let name = basename(String(finished.file || '')) || '?';
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  if ([...stem].length > 8) name = [...stem].slice(0, 4).join('') + '…' + ext;
  const when = finished.recordedAt;
  if (typeof when === 'string' && when.length >= 16) name += ` (${when.slice(0, 10)} ${when.slice(11, 16)}Z)`;
  return name;
}

function modeText(result: Msg): string {
  const finished = result.finished;
  if (!finished || typeof finished !== 'object') return result.running ? ' · running' : '';
  const mode = finished.mode;
  if (mode === 'record') return finished.recorded ? ` · recorded to ${recordingLabel(finished)}` : ' · HTTP record, nothing written';
  if (mode === 'replay') {
    let text = ` · replayed from ${recordingLabel(finished)}`;
    const misses = Number(finished.misses || 0);
    if (misses) {
      const attempts = Number(result.totals?.missAttempts || 0);
      text += `, ${misses} missing (${attempts} attempt${attempts === 1 ? '' : 's'})`;
    }
    return text;
  }
  return ' · HTTP off';
}

function where(row: Msg, source: RunSource | null): string {
  const loc = row.location;
  if (!loc || typeof loc !== 'object' || !loc.file) return '—';
  const name = source && typeof source.displayPath === 'function' ? source.displayPath(loc.file) : basename(String(loc.file));
  return `${name}:${pyStr(loc.line)}`;
}

/** the contract's text form: a header with the totals and the recording, then one line per row, each cut at 100 */
export function renderHttp(result: Msg, source: RunSource | null = null): string[] {
  const totals = result.totals ?? {};
  const n = Number(totals.requests || 0);
  const out = [`${n} request${n === 1 ? '' : 's'} · ${formatBytes(totals.bytes || 0)} · ${formatDuration(totals.ms || 0)}${modeText(result)}`];
  const rows = result.requests ?? [];
  if (!rows.length) {
    out.push('no request was observed: the program made none, or the run had httpObserve off');
    return out;
  }
  for (const r of rows) {
    const miss = r.source === 'miss';
    const status = miss ? 'MISS' : r.status !== null && r.status !== undefined ? String(r.status) : '—';
    const size = r.bytes === null || r.bytes === undefined ? '—' : formatBytes(r.bytes);
    const line = `#${pyStr(r.n)}  ${pyStr(r.method)}  ${status}  ${pyStr(r.name)}  ${where(r, source)}  ${size}  ${formatDuration(r.ms)}  ${pyStr(r.source)}  ${pyStr(r.url)}`;
    out.push(cutText(line, LINE_MAX));
  }
  if (result.truncated) out.push(`… ${Number(result.count || 0) - rows.length} more requests not listed (the table keeps the first ${rows.length})`);
  return out;
}
