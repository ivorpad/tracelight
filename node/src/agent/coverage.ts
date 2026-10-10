/**
 * `coverage`: which statements of each file ran, from the run's `coverage` events.
 *
 * One `coverage` event per file (docs/PROTOCOL.md, "Events"): `states[localRid]` (0 not run,
 * 1 covered, 2 partial, 3 error source, 4 error path, 5 ignored) and `hits[localRid]`. A file's
 * statements are `file.instrumented.statements`; this folds them to source lines, since a line is
 * what a reader acts on. A line with several statements takes the worst state among them and the
 * most hits. A file under `node_modules` is library code.
 */
import { NAME } from '../protocol.ts';
import { COV_COVERED, COV_ERROR_PATH, COV_ERROR_SOURCE, COV_IGNORED, COV_NOT_RUN, COV_PARTIAL } from './protocol.ts';
import { AgentError, SavedRun, type RunSource } from './source.ts';

type Msg = Record<string, any>;

export const STATE_NAME: Record<number, string> = { [COV_NOT_RUN]: 'not run', [COV_COVERED]: 'covered', [COV_PARTIAL]: 'partial', [COV_ERROR_SOURCE]: 'raised', [COV_ERROR_PATH]: 'error path', [COV_IGNORED]: 'ignored' };
/** which state a line shows when its statements disagree: the one a reader has to look at first */
const RANK: Record<number, number> = { [COV_NOT_RUN]: 5, [COV_ERROR_SOURCE]: 4, [COV_PARTIAL]: 3, [COV_ERROR_PATH]: 2, [COV_COVERED]: 1, [COV_IGNORED]: 0 };
export const FILES_CAP = 40;
export const LINES_CAP = 400;
const LIBRARY = /(?:^|[\\/])(?:node_modules|site-packages|dist-packages)(?:[\\/]|$)/;

/** Python's `round(x, 1)`: half to even */
export function round1(x: number): number {
  const scaled = x * 10;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  const n = diff > 0.5 ? floor + 1 : diff < 0.5 ? floor : floor % 2 === 0 ? floor : floor + 1;
  return n / 10;
}

/** a float as Python prints it: `100.0`, `87.5` */
export function pyFloat(x: number | null | undefined): string {
  if (x === null || x === undefined) return 'None';
  return Number.isInteger(x) ? `${x}.0` : String(x);
}

/** `[{line, state, hits}]` in line order for one file, ignored statements left out */
function linesOf(run: SavedRun, fileId: number): Msg[] {
  const f = run.files.get(fileId) ?? {};
  const cov = run.coverage.get(fileId) ?? {};
  const states: number[] = cov.states ?? [];
  const hits: number[] = cov.hits ?? [];
  const ranges: number[][] = f.ranges ?? [];
  const byLine = new Map<number, Msg>();
  for (const local of f.statements ?? []) {
    if (local >= states.length || local >= ranges.length) continue;
    const state = Number(states[local]);
    if (state === COV_IGNORED) continue;
    const line = Number(ranges[local]![0]);
    const n = local < hits.length ? Number(hits[local]) : 0;
    const cur = byLine.get(line);
    if (!cur) {
      byLine.set(line, { line, state, hits: n });
      continue;
    }
    if ((RANK[state] ?? 0) > (RANK[cur.state] ?? 0)) cur.state = state;
    cur.hits = Math.max(cur.hits, n);
  }
  return [...byLine.keys()].sort((a, b) => a - b).map((k) => byLine.get(k)!);
}

/** `[[first, last], ...]` runs of consecutive statement lines; `lines` is sorted */
function spans(lines: number[]): number[][] {
  const out: number[][] = [];
  for (const n of lines) {
    const last = out[out.length - 1];
    if (last && n === last[1]! + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out;
}

function fileSummary(run: SavedRun, fileId: number, lines: Msg[]): Msg {
  const path = run.filePath(fileId);
  const notRun = lines.filter((l) => l.state === COV_NOT_RUN).map((l) => l.line);
  return {
    file: run.displayPath(path),
    path,
    fileId,
    lines: lines.length,
    ran: lines.length - notRun.length,
    percent: lines.length ? round1((100.0 * (lines.length - notRun.length)) / lines.length) : null,
    notRun,
    notRunSpans: spans(notRun),
    partial: lines.filter((l) => l.state === COV_PARTIAL).map((l) => l.line),
    raised: lines.filter((l) => l.state === COV_ERROR_SOURCE).map((l) => l.line),
    library: LIBRARY.test(String(path)),
  };
}

const cmp = (a: unknown, b: unknown): number => (a! < b! ? -1 : a! > b! ? 1 : 0);

/** `{files: [summary], total, detail?}`: a summary per file, project files first; `detail` is `file`'s lines with source */
export async function coverageReport(source: RunSource, opts: { file?: string | null } = {}): Promise<Msg> {
  let run: SavedRun;
  if (source instanceof SavedRun) run = source;
  else if (typeof source.recording === 'function') {
    const doc = await source.recording();
    run = new SavedRun(String(doc?.meta?.file || 'live-session.json'), doc);
  } else throw new AgentError('coverage needs a saved run or a live session', `\`${NAME} coverage run.json\`, or \`${NAME} coverage --live\``);
  if (!run.coverage.size) throw new AgentError('the run has no coverage', `it did not finish recording; run it again with \`${NAME} run FILE --save run.json\``);
  const main = run.mainFileId();
  const summaries: Msg[] = [];
  const perFile = new Map<number, Msg[]>();
  for (const f of run.sortedFiles) {
    const fid = Number(f.fileId);
    if (!run.coverage.has(fid)) continue;
    perFile.set(fid, linesOf(run, fid));
    summaries.push(fileSummary(run, fid, perFile.get(fid)!));
  }
  summaries.sort((a, b) => cmp(a.fileId !== main, b.fileId !== main) || cmp(a.library, b.library) || cmp(a.file, b.file));
  const project = summaries.filter((s) => !s.library);
  const totalLines = project.reduce((n, s) => n + s.lines, 0);
  const totalRan = project.reduce((n, s) => n + s.ran, 0);
  const out: Msg = {
    files: summaries,
    total: { files: project.length, lines: totalLines, ran: totalRan, percent: totalLines ? round1((100.0 * totalRan) / totalLines) : null, libraryFiles: summaries.length - project.length },
  };
  if (opts.file) {
    const picked = run.resolveFile(opts.file);
    const fid = Number(picked.fileId);
    const src = run.sourceLines(fid);
    const detail = (perFile.get(fid) ?? []).map((l) => ({ line: l.line, state: STATE_NAME[l.state] ?? String(l.state), hits: l.hits, text: l.line > 0 && l.line <= src.length ? src[l.line - 1] : '' }));
    out.detail = { file: run.displayPath(run.filePath(fid)), lines: detail };
  }
  return out;
}

function spanText(list: number[][], cap = 12): string {
  const parts = list.slice(0, cap).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`));
  if (list.length > cap) parts.push(`… ${list.length - cap} more`);
  return parts.join(', ');
}

export function renderCoverage(result: Msg): string[] {
  const total = result.total ?? {};
  const lines: string[] = [];
  if (total.lines) {
    const lib = total.libraryFiles || 0;
    lines.push(`${total.ran} of ${total.lines} statement lines ran (${pyFloat(total.percent)}%) in ${total.files} project file${total.files === 1 ? '' : 's'}${lib ? `, ${lib} library files below` : ''}`);
  }
  const files = result.files ?? [];
  for (const s of files.slice(0, FILES_CAP)) {
    const bits = [`${s.file}  ${s.ran} of ${s.lines} ran`];
    if (s.percent !== null && s.percent !== undefined) bits[0] += ` (${pyFloat(s.percent)}%)`;
    if (s.notRunSpans.length) bits.push('not run: ' + spanText(s.notRunSpans));
    if (s.partial.length) bits.push('partial: ' + s.partial.slice(0, 12).join(', '));
    if (s.raised.length) bits.push('raised: ' + s.raised.slice(0, 12).join(', '));
    lines.push(bits.join('  '));
  }
  if (files.length > FILES_CAP) lines.push(`… ${files.length - FILES_CAP} more files; \`--file F\` reads one`);
  const detail = result.detail;
  if (detail) {
    lines.push('');
    lines.push(`${detail.file}, line by line (hits; not run, partial and raised marked):`);
    const rows = detail.lines;
    for (const row of rows.slice(0, LINES_CAP)) {
      const mark = row.state === 'covered' ? '' : '   ' + row.state;
      const hits = row.state === 'not run' ? '--' : `×${row.hits}`;
      let text = String(row.text).replace(/\s+$/, '');
      if ([...text].length > 100) text = [...text].slice(0, 99).join('') + '…';
      lines.push(`${String(row.line).padStart(5)} ${hits.padStart(6)}  ${text}${mark}`);
    }
    if (rows.length > LINES_CAP) lines.push(`… ${rows.length - LINES_CAP} more lines`);
  }
  return lines;
}
