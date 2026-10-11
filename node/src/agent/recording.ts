/**
 * What a recording left out, said where an agent reads it.
 *
 * Two losses are reported. A trace cut at the step cap (`maxTraceSteps`, `run --max-steps`): the
 * final `trace` event carries `truncated`, `cap`, `stepsRun` and `spentBy`; every verb over that
 * run prints a `note:` line first and `--json` gets a `recording` field. And a value text cut at
 * `maxValueChars`: the text ends in `…(+N chars)`, and `--json` gets `truncated` and `length`
 * next to any such `text`.
 */
import { resolve } from 'node:path';
import { packageOf } from '../select.ts';

type Msg = Record<string, any>;

/** the mark a cut value text carries, and the one the CLI's own line cuts leave */
export const CUT_RE = /…\((?:\+([\d,]+) chars|cut)\)$/;

/** `1,234`: Python's `format(n, ",")` */
export function commas(n: number): string {
  const s = String(Math.trunc(Math.abs(n)));
  return (n < 0 ? '-' : '') + s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** `{truncated, cap, kept, stepsRun, spentBy: [{path, steps}], exclude}` for a capped trace, else null */
export function capInfo(traceEv: Msg | null | undefined, meta: Msg, display: (p: string) => string, kept: number): Msg | null {
  if (!traceEv || !traceEv.truncated) return null;
  const stepsRun = traceEv.stepsRun || meta.stepCount;
  const cap = traceEv.cap || (meta.config ?? {}).maxTraceSteps || kept;
  const main = resolve(String(meta.file ?? ''));
  const spent = (Array.isArray(traceEv.spentBy) ? traceEv.spentBy : []).filter((e: unknown) => e && typeof e === 'object' && !Array.isArray(e)) as Msg[];
  const other = spent.find((e) => resolve(String(e.path)) !== main);
  return {
    truncated: true,
    cap: Math.trunc(Number(cap)),
    kept: Math.trunc(kept),
    stepsRun: stepsRun ? Math.trunc(Number(stepsRun)) : null,
    spentBy: spent.slice(0, 3).map((e) => ({ path: display(String(e.path)), steps: Math.trunc(Number(e.steps || 0)) })),
    exclude: other ? excludeFor(String(other.path), display) : null,
  };
}

/** the `--exclude` that leaves a file out: its package for a library file, its relative path for a project file */
export function excludeFor(path: string, display: (p: string) => string): string {
  const pkg = packageOf(path);
  if (pkg) return pkg.name;
  return String(display(path)).split('\\').join('/');
}

function n(value: unknown): string {
  return typeof value === 'number' && Number.isInteger(value) ? commas(value) : '?';
}

export function spentText(info: Msg): string {
  return ((info.spentBy ?? []) as Msg[]).map((e) => `${e.path} ${n(e.steps)}`).join(' · ');
}

/** the one line every verb over a capped run prints first */
export function noteLine(info: Msg): string {
  const total = info.stepsRun;
  let head = `note: truncated recording: steps 0-${n(Math.max(0, info.kept - 1))} of ${total ? n(total) : 'an unknown number'} kept (step cap ${n(info.cap)})`;
  if (info.spentBy?.length) head += `; most steps in ${spentText(info)}`;
  head += info.exclude ? `; rerun with --exclude ${info.exclude}` : '; rerun with a higher --max-steps';
  return head;
}

/** what `run` prints when the cap cut the recording */
export function warningLines(info: Msg): string[] {
  const total = info.stepsRun;
  const out = [`WARNING: recording truncated at step ${n(info.cap)}: the program ran ${total ? n(total) : 'more'} steps and only the first ${n(info.kept)} are recorded; nothing after step ${n(Math.max(0, info.kept - 1))} can be read`];
  if (info.spentBy?.length) out.push(`  most steps: ${spentText(info)}`);
  const hint = info.exclude ? `  rerun with --exclude ${info.exclude} (that code then runs unrecorded at full speed)` : '  the steps are in the program file itself';
  out.push(`${hint}, or raise --max-steps (now ${n(info.cap)})`);
  return out;
}

/** every object under `value` whose `text` carries the cut mark gets `truncated: true` and, when known, `length` */
export function annotateCut<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const v of value) if (v && typeof v === 'object') annotateCut(v);
  } else if (value && typeof value === 'object') {
    const o = value as Msg;
    const text = o.text;
    if (typeof text === 'string' && !('truncated' in o)) {
      const m = CUT_RE.exec(text);
      if (m) {
        o.truncated = true;
        if (m[1]) o.length = [...text].length - [...m[0]].length + parseInt(m[1].replace(/,/g, ''), 10);
      }
    }
    for (const v of Object.values(o)) if (v && typeof v === 'object') annotateCut(v);
  }
  return value;
}

/** one line of at most `limit` characters; a cut says how much it left out, adding what the recording cut already */
export function cutLine(text: unknown, limit: number, strip = false): string {
  let s = String(text ?? '').split('\n').join(' ');
  if (strip) s = pyStrip(s);
  const chars = [...s];
  if (chars.length <= limit) return s;
  const m = CUT_RE.exec(s);
  const core = m ? [...s.slice(0, m.index)] : chars;
  const earlier = m && m[1] ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
  const keep = Math.max(Math.floor(limit / 2), limit - 16, 1);
  if (core.length <= keep) return s;
  if (m && !m[1]) return `${core.slice(0, keep).join('')}…(cut)`;
  return `${core.slice(0, keep).join('')}…(+${commas(core.length - keep + earlier)} chars)`;
}

/** Python's `str.strip()`: whitespace both ends (including the separators JavaScript's trim keeps) */
export function pyStrip(s: string): string {
  return s.replace(/^[\s\x1c-\x1f\x85]+|[\s\x1c-\x1f\x85]+$/g, '');
}
