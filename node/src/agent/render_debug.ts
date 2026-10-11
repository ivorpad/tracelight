/**
 * Text forms of the Debugger's replies, as Pyokka's `agent/render_debug.py` plus the debug
 * renderers of `render.py` (`render_stopped`, `render_break`, `render_watches`, `render_locals`).
 *
 * A `record: false` stop has no trace to move through, so `render.ts` hands it here through the
 * `debugRender` seam (installed at import): where it paused and why, the frame chain, the
 * enclosing function's source with the paused line marked, the frame's variables, and what the
 * program printed since the previous stop.
 */
import { pyText } from './checkpoint.ts';
import { cutLine } from './recording.ts';
import { debugRender, renderStop, type Args } from './render.ts';
import type { RunSource } from './source.ts';

type Msg = Record<string, any>;

export const OUTPUT_LINES = 20;
export const OUTPUT_LINES_SCOPE = 200;
export const STACK_FRAMES = 8;
export const RECORDING_STARTED = '; recording starts here, step 0';
export const NOT_RECORDING_YET = 'not recording yet: the recording starts at the --record-from pause; `record --live` starts it here';

const isObj = (v: unknown): v is Msg => !!v && typeof v === 'object' && !Array.isArray(v);

function loc(source: RunSource, file: unknown, line: unknown): string {
  const name = typeof source?.displayPath === 'function' ? source.displayPath(file as string) : pyText(file || '<unknown>');
  return line ? `${name}:${pyText(line)}` : String(name);
}

function oneLine(text: unknown, limit = 160): string {
  return cutLine(text, limit, true);
}

/** Python's `str.splitlines()` for the line breaks a program prints */
function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** the text after `paused at file:line`: `breakpoint if x > 1`, `step over`, `watch total: 3`, `uncaught ValueError: too big: 3`, `start`, `pause` */
export function stopReason(paused: Msg): string {
  const reason = String(paused.reason || 'pause');
  if (reason === 'breakpoint') {
    const bp = isObj(paused.breakpoint) ? paused.breakpoint : {};
    let text = 'breakpoint' + (bp.condition ? ` if ${pyText(bp.condition)}` : '');
    if (paused.conditionError) text += `, condition failed: ${pyText(paused.conditionError)}`;
    return text;
  }
  if (reason === 'step') return `step ${pyText(paused.kind || 'into')}`;
  if (reason === 'watch') {
    const w = isObj(paused.watch) ? paused.watch : {};
    return Object.keys(w).length ? `watch ${pyText(w.exp)}: ${pyText(w.text)}` : 'watch';
  }
  if (reason === 'exception') {
    const e = isObj(paused.exception) ? paused.exception : {};
    return Object.keys(e).length ? `${e.uncaught ? 'uncaught' : 'raised'} ${pyText(e.type)}: ${pyText(e.message)}` : 'exception';
  }
  return reason;
}

export function recordingSuffix(paused: unknown): string {
  return isObj(paused) && paused.recordingStarted ? RECORDING_STARTED : '';
}

/** `record --live`: the pause again, now step 0 of the recording; or that the run already records */
export function renderRecord(result: Msg, source: RunSource, args: Args): string[] {
  const head = result.already ? ['already recording: `step --live --back` and `why --live` read what was recorded so far'] : [];
  return [...head, ...renderStop(result, source, args)];
}

/** a stop of a debug session: `paused at file:line (reason)` and everything the pause carries */
export function renderDebugStop(result: Msg, source: RunSource, args: Args): string[] {
  const fin = result.finished;
  if (isObj(fin)) {
    const head = `finished: exit ${pyText(fin.exitCode)}, ${pyText(fin.stepCount)} steps`;
    const stepped = result.stepped;
    return stepped === null || stepped === undefined ? [head] : [head, `${pyText(stepped)} step${stepped === 1 ? '' : 's'} were taken before it ended`];
  }
  if (result.resumed) return ['resumed'];
  if (result.requested) return ['pause requested: the program pauses at its next statement'];
  if (result.stopped) {
    const ended = result.finished || {};
    return [`stopped: exit ${pyText(ended.exitCode)}, ${pyText(ended.stepCount)} steps`];
  }
  const l = result.location || {};
  const paused = isObj(result.paused) ? result.paused : {};
  let head = `paused at ${loc(source, l.file || paused.file, l.line || paused.line)} (${stopReason(paused)}${recordingSuffix(paused)})`;
  if (result.modified) head += ' (values modified from the console)';
  const out = [head];
  if (result.recording === false) out.push(NOT_RECORDING_YET);
  const early = result.stoppedEarly;
  if (isObj(early)) out.push(`stopped early after ${pyText(early.after)} step${early.after === 1 ? '' : 's'}: ${pyText(early.reason)}`);
  out.push(...threadAndBelow(result, source, args));
  return out;
}

/** `ZeroDivisionError: division by zero` when the statement raised, else null */
export function execError(result: Msg): string | null {
  const exc = result.exception;
  if (!isObj(exc)) return null;
  return `${pyText(exc.type)}: ${oneLine(exc.message)}`;
}

/** `exec --live`: the value on one line, `ok` for a statement, where it still is on an error */
export function renderDebugExec(result: Msg, source: RunSource, _args: Args): string[] {
  if (execError(result) !== null) {
    const l = isObj(result.location) ? result.location : null;
    return l ? [`still paused at ${loc(source, l.file, l.line)}`] : ['still paused'];
  }
  const text = result.text;
  const out = [text ? oneLine(text, 2000) : 'ok'];
  if (result.modified) out.push('values modified from the console: they are no longer the program\'s own');
  return out;
}

function threadAndBelow(result: Msg, source: RunSource, args: Args): string[] {
  const out: string[] = [];
  const thread = result.thread;
  if (isObj(thread) && thread.name !== null && thread.name !== undefined && thread.name !== 'MainThread') out.push(`thread ${pyText(thread.name)}`);
  out.push(...stackLines(result, source));
  out.push(...blockLines(result, source));
  out.push(...localsLines(result));
  out.push(...outputLines(result.output, !!args?.scope));
  out.push(...errorLines(result, source));
  return out;
}

function frameText(entry: Msg, source: RunSource): string {
  if (entry.elided) {
    const count = Number(entry.elided);
    const where = (entry.in || []).map(String).join(', ');
    const kind = entry.where === 'library' ? 'library frame' : 'frame';
    return `… ${count} ${kind}${count === 1 ? '' : 's'}${where ? ` in ${where}` : ''} …`;
  }
  return `${pyText(entry.function)} ${loc(source, entry.file, entry.line)}`;
}

function stackLines(result: Msg, source: RunSource): string[] {
  const stack = (result.stack || []).filter(isObj);
  if (stack.length < 2) return [];
  let shown: Msg[] = stack;
  if (stack.length > STACK_FRAMES) shown = [...stack.slice(0, STACK_FRAMES - 2), { elided: stack.length - (STACK_FRAMES - 1) }, stack[stack.length - 1]];
  return ['stack: ' + shown.map((f) => frameText(f, source)).join(' ← ')];
}

function blockLines(result: Msg, source: RunSource): string[] {
  const b = isObj(result.block) ? result.block : null;
  if (!b) return [];
  const lines = (b.lines || []).filter(isObj);
  const total = b.totalLines;
  const cap = b.capped ? (total ? ` (${lines.length} of ${total} lines; --scope for all)` : ` (${lines.length} lines; --scope for all)`) : '';
  const out = [`block ${pyText(b.function)}  ${loc(source, b.file, null)}${cap}`];
  if (!lines.length) {
    out.push('   (no source available)');
    return out;
  }
  const width = Math.max(...lines.map((l: Msg) => String(l.line).length));
  let prev: number | null = null;
  for (const l of lines) {
    if (prev !== null && l.line - prev > 1) {
      const gap = l.line - prev - 1;
      out.push(`${' '.repeat(width)}  … ${gap} line${gap === 1 ? '' : 's'}`);
    }
    out.push(`${l.current ? '>' : ' '}${String(l.line).padStart(width)}  ${String(l.text || '').replace(/[\s\x1c-\x1f\x85]+$/, '')}`);
    prev = l.line;
  }
  return out;
}

function localsLines(result: Msg): string[] {
  const variables = result.locals;
  if (!Array.isArray(variables)) return [];
  const rows = variables.filter(isObj);
  if (!rows.length) return ['locals: (none)'];
  return ['locals:', ...rows.map((v) => `  ${pyText(v.name)} = ${oneLine(v.text)}`)];
}

function outputLines(output: unknown, scope = false): string[] {
  if (!isObj(output)) return [];
  const lines = splitLines(String(output.text || ''));
  const earlier = Number(output.earlier || 0);
  const delta = output.since === 'stop';
  const behind = earlier ? `; ${earlier} earlier` : '';
  if (!lines.length) {
    if (!delta) return [];
    return [`output: nothing new since the last stop${earlier ? ` (${earlier} line${earlier === 1 ? '' : 's'} earlier; --scope for the window)` : ''}`];
  }
  const shown = lines.slice(-(scope ? OUTPUT_LINES_SCOPE : OUTPUT_LINES));
  const head = delta
    ? `output (${lines.length} new line${lines.length === 1 ? '' : 's'}${shown.length < lines.length ? `, the last ${shown.length} shown` : ''}`
    : `output (last ${shown.length} line${shown.length === 1 ? '' : 's'}${shown.length < lines.length ? ` of ${lines.length}` : ''}`;
  return [`${head}${behind}):`, ...shown.map((line) => '  ' + line)];
}

function errorLines(result: Msg, source: RunSource): string[] {
  const errors = (result.errors || []).filter(isObj);
  if (!errors.length) return [];
  return ['errors:', ...errors.map((e: Msg) => `  ${loc(source, e.file, e.line)} ${pyText(e.type)}: ${oneLine(e.message)}`)];
}

/** `state --live` on a debug socket: both kinds listed, debug first, then this session */
export function renderDebugState(result: Msg, source: RunSource, args: Args): string[] {
  const out = listing(result);
  const launch = isObj(result.launch) ? result.launch : {};
  const dbg = isObj(result.debug) ? result.debug : {};
  const paused = isObj(dbg.paused) ? dbg.paused : null;
  const where = paused ? `paused at ${loc(source, paused.file, paused.line)} (${stopReason(paused)})` : 'running (`pause --live` stops it at its next statement)';
  out.push('');
  out.push(`${result.displayName || source.displayPath(result.file)}  ${where}`);
  out.push(`  launch: ${launchLine(launch)}`);
  out.push(`  record: ${launch.record ? 'on' : 'off'}`);
  if (launch.libraryCode) out.push('  library code: on');
  out.push(`  exceptions: ${dbg.exceptions || 'uncaught'}`);
  if (result.modified) out.push('  values were modified from the console');
  out.push(...outputLines(result.output, !!args?.scope).map((line) => '  ' + line));
  return out;
}

/** `/abs/node /abs/app.ts --port 8000   (cwd /abs)`: the interpreter only when the launch names one */
function launchLine(launch: Msg): string {
  const interp = launch.node;
  const target = String(launch.program || '');
  const head = interp ? `${interp} ${target}` : target;
  const command = [head, ...(launch.args || []).map(String)].join(' ');
  return launch.cwd ? `${command}   (cwd ${launch.cwd})` : command;
}

function listing(result: Msg): string[] {
  const rows: [string, string, string, boolean][] = [[String(result.kind || 'debug'), String(result.displayName || ''), thisState(result), true]];
  for (const other of result.others || []) {
    if (!isObj(other)) continue;
    rows.push([String(other.kind || 'run'), String(other.displayName || ''), otherState(other), false]);
  }
  const ordered = [...rows].sort((a, b) => (a[0] === 'debug' ? 0 : 1) - (b[0] === 'debug' ? 0 : 1));
  return ordered.map(([kind, name, state, mine]) => `${kind.padEnd(6)} ${name.padEnd(14)} ${state}${mine ? '   [this]' : ''}`);
}

function thisState(result: Msg): string {
  if (result.paused) {
    const dbg = isObj(result.debug) ? result.debug : {};
    const paused = isObj(dbg.paused) ? dbg.paused : {};
    const file = paused.file ? String(paused.file).split('/').pop() || '?' : '?';
    return `running, paused at ${file}:${pyText(paused.line)} (${stopReason(paused)})`;
  }
  return result.running ? 'running' : 'ended';
}

function otherState(other: Msg): string {
  if (other.paused) return 'running, paused';
  if (other.running) return 'running';
  return other.steps ? `finished, ${other.steps} steps` : 'no finished run yet';
}

/** `stop`: what the run that just ended did, or why there was nothing to stop */
export function renderStopped(result: Msg, _source: RunSource, _args: Args): string[] {
  if (!result.stopped) return [`nothing to stop: ${result.hint || 'no debug run is in flight'}`];
  const fin = result.finished || {};
  return [`stopped: exit ${pyText(fin.exitCode)}, ${pyText(fin.stepCount)} steps`];
}

/** the breakpoints after the change, then where an exception pauses the run */
export function renderBreak(result: Msg, source: RunSource, _args: Args): string[] {
  const bps = (result.breakpoints || []).filter(isObj);
  const tail = result.exceptions ? [`exceptions: ${result.exceptions}`] : [];
  if (!bps.length) return ['no breakpoints; `break --live FILE:LINE [--when EXPR]` adds one', ...tail];
  const out = [`${bps.length} breakpoint${bps.length === 1 ? '' : 's'}`];
  for (const bp of bps) {
    const where = bp.file ? loc(source, bp.file, bp.line) : null;
    let line = bp.function ? `  ${bp.function}${where ? '  ' + where : ''}` : `  ${loc(source, bp.file, bp.line)}`;
    if (bp.condition) line += `  if ${oneLine(bp.condition, 80)}`;
    if (bp.error) line += `  (${oneLine(bp.error, 80)})`;
    else if (bp.resolvedLine !== null && bp.resolvedLine !== undefined) line += `  -> resolved line ${bp.resolvedLine}`;
    else line += '  (not resolved yet)';
    out.push(line);
  }
  return [...out, ...tail];
}

export function renderWatches(result: Msg, _source: RunSource, _args: Args): string[] {
  const watches = (result.watches || []).filter(isObj);
  if (!watches.length) return ['no watches; `watches --live --add EXPR` shows one at every stop, `--break-when change|true` pauses on it'];
  const out = [`${watches.length} watch${watches.length === 1 ? '' : 'es'}`];
  for (const w of watches) {
    let what: string;
    if (w.breakWhen) {
      what = w.breakWhen === 'true' ? 'break when true' : 'break when it changes';
      if (w.error) what += `  (${oneLine(w.error, 80)})`;
    } else if (w.error) what = `(${oneLine(w.error, 80)})`;
    else if ('text' in w) what = `= ${oneLine(pyText(w.text), 100)}`;
    else what = '(no value at this step)';
    out.push(`  ${pyText(w.id)}  ${oneLine(w.exp, 80)}  ${what}`);
  }
  return out;
}

export function renderLocals(result: Msg, _source: RunSource, _args: Args): string[] {
  const variables = (result.locals || []).filter(isObj);
  return variables.length ? variables.map((v: Msg) => `${pyText(v.name)} = ${oneLine(v.text)}`) : ['(no variables in this frame)'];
}

debugRender.stop = renderDebugStop;
debugRender.state = renderDebugState;
debugRender.stopReason = stopReason;
