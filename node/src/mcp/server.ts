/**
 * `tracelight mcp`: the agent tools as an MCP server on stdin/stdout.
 *
 * Stdlib JSON-RPC 2.0, one message per line (the MCP stdio transport), no SDK.
 *
 * - `tracelight_run` records a JavaScript / TypeScript file in this process (`tracelight run FILE --save`).
 * - The other tools turn a call into the words of the one-shot agent command and run that verb in
 *   this process (`dispatchVerb`). The tool answers exactly what the command prints: its text, its
 *   `error:` and hint (as `isError`), or the `--json` shape with `json: true`.
 *
 * stdout is the wire: replies go out on fd 1 and `console.log` is pointed at stderr, so a stray
 * print lands in the client's log instead of corrupting the stream.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { NAME, RUNTIME_VERSION } from '../protocol.ts';
import { dispatchVerb, getVerb, verbNames, type Io } from '../agent/commands.ts';
import '../agent/verbs.ts';
import { DEBUG_ACTIONS, DEBUG_COMMAND, MAP_ACTIONS, MOVES, VALUE_ACTIONS, toolDefinitions } from './tools.ts';
import { boundedEvidence } from './evidence.ts';
import { callWorkflow, workflowDefinitions } from './workflowTools.ts';
import { AgentError } from '../agent/source.ts';
import { callPage, callScratchpad, PageError } from './page.ts';

type Args = Record<string, any>;
type Msg = Record<string, any>;

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export const INSTRUCTIONS = `Tracelight records a JavaScript or TypeScript program and answers questions from the recording, so you read what the program did instead of guessing from the source. Every value comes from the run.

1. tracelight_run {file} records it and prints the run.json path (default .tracelight/runs/<name>.json next to the file).
2. tracelight_map {action: "walkthrough", run} is the map: calls with arguments and results, branches, loops, logs, exceptions, each with a step number.
3. tracelight_step {run, step, move: "into"} is the Time Machine: code, values, stack and moves at a step; move back and forward freely.
4. tracelight_value {action: "why", run, step, name} explains where a value came from; "var" lists every change of a name; "origin" follows a bad value from an exception back to its root.
5. tracelight_coverage {run} lists the lines that never ran.
For a saved run, tracelight_investigate {run, value} bundles history, context, origin, exceptions and coverage in one bounded response. Follow its step numbers with tracelight_step or tracelight_value for more detail.
To check an edit, record its before and after separately, then tracelight_verify {before, after, expect: ["total=3"]}. It reads those recordings without executing anything. verified means only that the supplied final-value expectations passed on this input in a complete successful recording, not that every behavior is correct. ignore affects the comparison, never the checks.
These two saved-run tools return structuredContent and matching JSON text. response.omissions lists shortened detail; notes describe missing recording evidence. A failed expectation returns verified: false, not a tool error.
tracelight_session {} lists sessions without selecting one; {run} reads saved state; {session} reads the chosen live session without starting it. livePause and recordedSelection are independent; neither confirms the visible editor.
tracelight_seek {run, value: "total", equals: "NaN"} finds a recorded destination, or use {run, file, line}; occurrence selects first or last. It does not move live execution.
tracelight_save_investigation {path, run, question, checkpoints: [{name, step}]} writes a new private checkpoint artifact. Keep it and its recording. tracelight_open_investigation {path} verifies the recording hash and reopens recorded evidence without running code.
For a program running now in VS Code (setting tracelight.agentAccess), pass live: true instead of run; tracelight_debug {action: "start", file, at: ["func"]} starts the debugger and returns the first stop, then "continue", "locals", tracelight_step with a move.
For expression breakpoints use tracelight_debug {action: "watches", add: ["total > 100"], break_when: "true"}, or break with add: ["file.ts:12"] and when. break with log_message uses pure {expression} substitutions without pausing. locals with names_only lists names/types; names requests only selected binding values.
tracelight_debug {action: "status", wait_seconds: 60} waits for the person to hit a breakpoint or step in VS Code, then prints the state; pause, stop and status are answered even while a continue waits.
To teach in a browser: tracelight_page {action: "open", file} returns a URL for the person to open in one tab; then breakpoint, debug {op: "start"}, say for narration bubbles, wait_pause for their next step, and tracelight_scratchpad {op: "experiment", code, inputs, mocks, mock_labels} for copied-function experiments. close stops a page this server started.
tracelight_history {run, out, var: ["total"]} writes code-history data; tracelight_learn, tracelight_pin and tracelight_narrate are the learn, pin and narrate commands.
The text results are the form to read; json: true gives the raw shape.`;

const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx']);

/** what a Python file or run gets: Tracelight records JavaScript and TypeScript only */
export const NOT_JAVASCRIPT_HINT = 'Tracelight runs JavaScript and TypeScript; Pyokka records Python (`pyokka run FILE`, or its MCP server `pyokka mcp`)';

/** A call the tool cannot turn into a command: an `isError` result, like a command's error. */
export class ToolError extends Error {
  hint: string | undefined;
  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}

// -- arguments to command words ---------------------------------------------------------------

function empty(v: unknown): boolean {
  return v === undefined || v === null || v === '';
}

function int(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isInteger(n)) throw new TypeError(`expected an integer, got ${JSON.stringify(v)}`);
  return n;
}

function sourceWords(a: Args, positional = true): [string[], string[]] {
  if (a.run && (a.live || a.session)) throw new ToolError('choose a saved run or a live session, not both');
  const opts: string[] = [];
  const pos: string[] = [];
  if (a.json) opts.push('--json');
  if (a.live || a.session) {
    opts.push('--live');
    if (a.session) opts.push(`--session=${a.session}`);
  } else if (a.run && positional) pos.push(String(a.run));
  else if (positional) throw new ToolError('give `run` (a run.json from tracelight_run) or `live: true`', 'record one with tracelight_run {file}; live reads the open VS Code session (setting tracelight.agentAccess)');
  return [opts, pos];
}

function opt(words: string[], a: Args, key: string, flag: string): void {
  const v = a[key];
  if (empty(v)) return;
  if (typeof v === 'boolean') {
    if (v) words.push(flag);
    return;
  }
  words.push(`${flag}=${v}`);
}

function need(a: Args, key: string, action: string, example: string): any {
  const v = a[key];
  if (empty(v)) throw new ToolError(`${action} needs \`${key}\``, `e.g. ${example}`);
  return v;
}

function oneOf(value: string, list: readonly string[], what = 'action'): void {
  if (!list.includes(value)) throw new ToolError(`unknown ${what} ${JSON.stringify(value)}`, 'one of ' + list.join(', '));
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

export function wordsMap(a: Args): string[] {
  const action = need(a, 'action', 'tracelight_map', '{"action": "walkthrough", "run": "run.json"}');
  oneOf(action, MAP_ACTIONS);
  if (action === 'diff') {
    const before = need(a, 'before', 'diff', '{"action": "diff", "before": "before.json", "after": "after.json"}');
    const words = ['diff'];
    if (a.json) words.push('--json');
    if (a.live || a.session) {
      words.push('--live');
      opt(words, a, 'session', '--session');
    }
    opt(words, a, 'limit', '--limit');
    words.push('--', String(before));
    if (!(a.live || a.session)) words.push(String(need(a, 'after', 'diff', '{"action": "diff", "before": "before.json", "after": "after.json"} or live: true')));
    return words;
  }
  const [opts, pos] = sourceWords(a);
  const words = [action, ...opts];
  if (action === 'walkthrough' || action === 'story') {
    opt(words, a, 'file', '--file');
    opt(words, a, 'scope', '--scope');
  }
  if (action === 'walkthrough') {
    opt(words, a, 'from', '--from');
    opt(words, a, 'to', '--to');
    opt(words, a, 'all', '--all');
  }
  if (action === 'story') {
    opt(words, a, 'line', '--line');
    opt(words, a, 'limit', '--limit');
  }
  if (action === 'steps') {
    opt(words, a, 'from', '--from');
    opt(words, a, 'count', '--count');
    opt(words, a, 'line', '--line');
  }
  if (action === 'graph') {
    opt(words, a, 'scope', '--scope');
    opt(words, a, 'all', '--all');
    for (const pkg of strings(a.expand)) words.push(`--expand=${pkg}`);
    opt(words, a, 'no_statements', '--no-statements');
    opt(words, a, 'dot', '--dot');
  }
  if (action === 'tour') {
    opt(words, a, 'goal', '--goal');
    opt(words, a, 'budget', '--budget');
    opt(words, a, 'prose', '--prose');
    opt(words, a, 'out', '--out');
  }
  if (action === 'find') {
    opt(words, a, 'limit', '--limit');
    return [...words, '--', ...pos, String(need(a, 'text', 'find', '{"action": "find", "run": "run.json", "text": "TypeError"}'))];
  }
  return pos.length ? [...words, '--', ...pos] : words;
}

export function wordsStep(a: Args): string[] {
  const [opts, pos] = sourceWords(a);
  const live = opts.includes('--live');
  const step = a.step;
  const move = a.move;
  let words: string[];
  if (!empty(move)) oneOf(move, MOVES, 'move');
  if (!empty(move) || !empty(a.to)) {
    words = ['step', ...opts, !empty(move) ? `--${move}` : `--to=${int(a.to)}`];
    opt(words, a, 'count', '--count');
    opt(words, a, 'whole_block', '--scope');
    if (empty(step) && !live) throw new ToolError('a move needs `step`, the step to move from', 'e.g. {"run": "run.json", "step": 12, "move": "into"}; with live the current step is implied');
  } else {
    words = ['context', ...opts];
    opt(words, a, 'line', '--line');
    opt(words, a, 'whole_block', '--scope');
    if (empty(step) && !a.line && !live) throw new ToolError('give `step` or `line`', 'e.g. {"run": "run.json", "step": 12} or {"run": "run.json", "line": "app.ts:57"}');
  }
  return [...words, '--', ...pos, ...(empty(step) ? [] : [String(int(step))])];
}

export function wordsValue(a: Args): string[] {
  const action = need(a, 'action', 'tracelight_value', '{"action": "var", "run": "run.json", "name": "total"}');
  oneOf(action, VALUE_ACTIONS);
  const [opts, pos] = sourceWords(a);
  const words = [action, ...opts];
  if (action === 'var') {
    opt(words, a, 'file', '--file');
    opt(words, a, 'scope', '--scope');
    opt(words, a, 'limit', '--limit');
    return [...words, '--', ...pos, String(need(a, 'name', 'var', '{"action": "var", "run": "run.json", "name": "total"}'))];
  }
  if (action === 'why' || action === 'origin') {
    opt(words, a, 'depth', '--depth');
    if (empty(a.step) && !opts.includes('--live')) throw new ToolError(`${action} needs \`step\``, 'tracelight_value var lists the steps where a name changed; tracelight_map exceptions lists the steps that raised');
    return [...words, '--', ...pos, ...(empty(a.step) ? [] : [String(int(a.step))]), ...(a.name ? [String(a.name)] : [])];
  }
  if (action === 'values') {
    need(a, 'line', 'values', '{"action": "values", "run": "run.json", "line": "app.ts:57"}');
    opt(words, a, 'line', '--line');
    return [...words, '--', ...pos];
  }
  if (action === 'eval') {
    opt(words, a, 'frame', '--frame');
    return [...words, '--', ...pos, String(need(a, 'expression', 'eval', '{"action": "eval", "run": "run.json", "expression": "scores.length"}'))];
  }
  if (action === 'expand') {
    for (const seg of strings(a.path)) words.push(`--path=${seg}`);
    return [...words, '--', ...pos, String(need(a, 'value_id', 'expand', '{"action": "expand", "run": "run.json", "value_id": "v12"}'))];
  }
  return [...words, '--', ...pos]; // release
}

export function wordsCoverage(a: Args): string[] {
  const [opts, pos] = sourceWords(a);
  const words = ['coverage', ...opts];
  opt(words, a, 'file', '--file');
  return [...words, '--', ...pos];
}

/** These workflows deliberately accept saved evidence only: no live evaluation, rerun or export. */
function evidenceArgs(a: Args, allowed: string[]): void {
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw new ToolError('arguments must be an object');
  const unknown = Object.keys(a).filter(k => !allowed.includes(k));
  if (unknown.length) throw new ToolError(`unsupported argument(s): ${unknown.join(', ')}`, 'these tools only read saved recordings; they do not rerun, export or control a live session');
  if (a.limit !== undefined && (typeof a.limit !== 'number' || !Number.isInteger(a.limit) || a.limit < 1 || a.limit > 100)) {
    throw new ToolError('limit must be an integer from 1 to 100');
  }
}

function evidenceString(a: Args, key: string, required = true, maxLength = 4096): string | undefined {
  const value = a[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new ToolError(`${key} must be a nonempty string of at most ${maxLength} characters`);
  return value;
}

export function wordsInvestigate(a: Args): string[] {
  evidenceArgs(a, ['run', 'value', 'at', 'limit']);
  const run = evidenceString(a, 'run')!;
  const value = evidenceString(a, 'value', false, 256);
  if (a.at !== undefined && (typeof a.at !== 'number' || !Number.isInteger(a.at) || a.at < 0)) throw new ToolError('at must be a nonnegative integer');
  return ['investigate', '--json', ...(value === undefined ? [] : [`--value=${value}`]),
    ...(a.at === undefined ? [] : [`--at=${a.at}`]), '--', resolve(run)];
}

export function wordsVerify(a: Args): string[] {
  evidenceArgs(a, ['before', 'after', 'expect', 'ignore', 'limit']);
  const before = evidenceString(a, 'before')!;
  const after = evidenceString(a, 'after')!;
  if (!Array.isArray(a.expect) || !a.expect.length || a.expect.length > 50 ||
    a.expect.some((v: unknown) => typeof v !== 'string' || v.indexOf('=') < 1 || !v.slice(0, v.indexOf('=')).trim()) ||
    Buffer.byteLength(JSON.stringify(a.expect), 'utf8') > 8192) {
    throw new ToolError('expect needs 1 to 50 NAME=TEXT strings, at most 8192 bytes in total', 'use the exact recorded text, e.g. ["total=3"]; comparisons alone do not verify a fix');
  }
  if (a.ignore !== undefined && (!Array.isArray(a.ignore) || a.ignore.length > 50 || a.ignore.some((v: unknown) => typeof v !== 'string' || !v.trim() || v.length > 256))) {
    throw new ToolError('ignore must be an array of at most 50 nonempty names, each at most 256 characters');
  }
  if (!isTracelightRun(after)) throw refusal(['verify', '--', after]);
  return ['verify', '--json', `--after=${resolve(after)}`, ...a.expect.map((v: string) => `--expect=${v}`),
    ...(a.ignore ?? []).map((v: string) => `--ignore=${v}`), '--', resolve(before)];
}

export function wordsDebug(a: Args): string[] {
  const action = need(a, 'action', 'tracelight_debug', '{"action": "start", "file": "app.ts", "at": ["main"]}');
  oneOf(action, DEBUG_ACTIONS);
  const words = [DEBUG_COMMAND[action] ?? action, '--live'];
  opt(words, a, 'json', '--json');
  opt(words, a, 'session', '--session');
  if (action === 'start') {
    for (const flag of ['cwd', 'node', 'record_from', 'configuration', 'test']) opt(words, a, flag, '--' + flag.replace('_', '-'));
    for (const flag of ['record', 'library_code', 'stop_on_entry', 'no_focus']) opt(words, a, flag, '--' + flag.replace('_', '-'));
    for (const [k, v] of Object.entries(a.env ?? {})) words.push(`--env=${k}=${v}`);
    for (const at of strings(a.at)) words.push(`--at=${at}`);
    if (a.file) words.push('--', String(a.file));
    if (Array.isArray(a.args) && a.args.length) words.push('--args', ...strings(a.args)); // `--args` takes the rest of the line
    return words;
  }
  if (action === 'restart') opt(words, a, 'stop_on_entry', '--stop-on-entry');
  if (action === 'continue') {
    opt(words, a, 'until', '--until');
    opt(words, a, 'to', '--to');
    opt(words, a, 'no_wait', '--no-wait');
  }
  if (action === 'pause') opt(words, a, 'no_wait', '--no-wait');
  if (action === 'break') {
    if (a.clear !== undefined && typeof a.clear !== 'boolean') throw new ToolError('clear must be a boolean');
    if (a.log_message !== undefined && (typeof a.log_message !== 'string' || !a.log_message.trim() || a.log_message.length > 4096)) throw new ToolError('log_message must be a nonempty string of at most 4096 characters');
    opt(words, a, 'when', '--when');
    opt(words, a, 'log_message', '--log-message');
    opt(words, a, 'clear', '--clear');
    opt(words, a, 'on_exception', '--on-exception');
    for (const at of strings(a.at)) words.push(`--at=${at}`);
    for (const r of strings(a.remove)) words.push(`--remove=${r}`);
    return [...words, '--', ...strings(a.add)];
  }
  if (action === 'watches') {
    opt(words, a, 'break_when', '--break-when');
    for (const e of strings(a.add)) words.push(`--add=${e}`);
    for (const r of strings(a.remove)) words.push(`--remove=${r}`);
  }
  if (action === 'locals') {
    opt(words, a, 'frame', '--frame');
    if (a.names_only !== undefined && typeof a.names_only !== 'boolean') throw new ToolError('names_only must be a boolean');
    if (a.names !== undefined && (!Array.isArray(a.names) || !a.names.length || a.names.length > 100 || a.names.some((v: unknown) => typeof v !== 'string' || !v.trim()))) throw new ToolError('names must contain 1 to 100 nonempty binding names');
    opt(words, a, 'names_only', '--names-only');
    if (a.scope !== undefined) oneOf(String(a.scope), ['local', 'global', 'all'], 'scope');
    opt(words, a, 'scope', '--scope');
    for (const name of strings(a.names)) words.push(`--name=${name}`);
  }
  if (action === 'exec') {
    opt(words, a, 'frame', '--frame');
    return [...words, '--', String(need(a, 'source', 'exec', '{"action": "exec", "source": "count = 3"}'))];
  }
  return words;
}

export function wordsHistory(a: Args): string[] {
  const [opts, pos] = sourceWords(a);
  const words = ['history', ...opts, `--out=${need(a, 'out', 'tracelight_history', '{"run": "run.json", "out": "/tmp/s/history.json", "var": ["total"]}')}`];
  for (const at of strings(a.at)) words.push(`--at=${at}`);
  for (const v of strings(a.var)) words.push(`--var=${v}`);
  if (a.why !== undefined) {
    if (!Array.isArray(a.why) || a.why.some((w: any) => !w || typeof w !== 'object' || !Number.isInteger(w.step) || typeof w.name !== 'string' || !w.name)) throw new ToolError('why must be a list of {step, name} objects', 'e.g. [{"step": 40, "name": "total"}]');
    for (const w of a.why) words.push('--why', String(w.step), String(w.name));
  }
  for (const flag of ['prose', 'pad', 'limit', 'lang', 'value_chars']) opt(words, a, flag, '--' + flag.replace('_', '-'));
  for (const flag of ['pause', 'scope', 'append']) opt(words, a, flag, '--' + flag);
  if (!strings(a.at).length && !strings(a.var).length && !(a.why ?? []).length && !a.pause) throw new ToolError('a history needs at least one checkpoint: `at`, `var`, `why` or `pause`', 'e.g. {"run": "run.json", "out": "history.json", "var": ["total"]}');
  return [...words, '--', ...pos];
}

export function wordsLearn(a: Args): string[] {
  const [opts, pos] = sourceWords(a);
  const words = ['learn', ...opts];
  opt(words, a, 'at', '--at');
  opt(words, a, 'prediction', '--prediction');
  opt(words, a, 'reveal', '--reveal');
  return [...words, '--', ...pos];
}

export function wordsPin(a: Args): string[] {
  const [opts, pos] = sourceWords(a);
  return ['pin', ...opts, `--out=${need(a, 'out', 'tracelight_pin', '{"run": "run.json", "out": "/tmp/s/baseline.json"}')}`, '--', ...pos];
}

export function wordsNarrate(a: Args): string[] {
  const [opts, pos] = sourceWords(a);
  const words = ['narrate', ...opts];
  opt(words, a, 'command', '--command');
  opt(words, a, 'dry_run', '--dry-run');
  return [...words, '--', ...pos];
}

// -- running a call ---------------------------------------------------------------------------

/** Whether a saved run was written by this runtime (`meta.language`, the first key of the file). */
export function isTracelightRun(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const head = Buffer.alloc(4096);
    const n = readSync(fd, head, 0, head.length, 0);
    return /"language"\s*:\s*"javascript"/.test(head.subarray(0, n).toString('utf8'));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Whether this runtime answers `words`: its agent CLI has the verb, and the source is the live
 * session (the verb itself says when there is none) or a saved run this runtime wrote.
 */
export function nativeFor(words: string[]): boolean {
  if (!getVerb(words[0]!)) return false;
  if (words.includes('--live')) return true;
  const sep = words.indexOf('--');
  const run = sep >= 0 ? words[sep + 1] : undefined;
  return run !== undefined && isTracelightRun(run);
}

/** Why `words` cannot be answered here (`nativeFor` said no), as a ToolError. */
function refusal(words: string[]): ToolError {
  if (!getVerb(words[0]!)) return new ToolError(`${NAME} has no \`${words[0]}\` command`, `${NAME} -h lists the commands`);
  const sep = words.indexOf('--');
  const run = sep >= 0 ? words[sep + 1] : undefined;
  if (run === undefined) return new ToolError('give `run` (a run.json from tracelight_run) or `live: true`');
  if (!existsSync(run)) return new ToolError(`no run ${run}`, 'record one with tracelight_run {file}');
  return new ToolError(`${run} is not a recording of a JavaScript or TypeScript run`, NOT_JAVASCRIPT_HINT);
}

/** Run one agent command in this process, as `tracelight VERB ...` would print it: `[text, isError]`. */
export async function runNative(words: string[]): Promise<[string, boolean]> {
  let out = '';
  let err = '';
  const io: Io = { out: (t) => void (out += t), err: (t) => void (err += t) };
  const code = await dispatchVerb(words[0]!, words.slice(1), io);
  if (code !== 0) return [(out + err).trim() || `error: the command failed (exit ${code})`, true];
  return [(out + (err ? '\n' + err : '')).trimEnd() + '\n', false];
}

/** Each agent command's one-line help, from this runtime's verbs. */
export function commandHelps(): Record<string, string> {
  return Object.fromEntries(verbNames().map((n) => [n, getVerb(n)!.help]));
}

export function defaultSave(file: string): string {
  const path = resolve(file);
  const stem = basename(path, extname(path)) || 'run';
  return join(dirname(path), '.tracelight', 'runs', stem + '.json');
}

export async function callRun(a: Args): Promise<[string, boolean]> {
  const file = String(need(a, 'file', 'tracelight_run', '{"file": "app.ts"}'));
  const path = resolve(file);
  if (!existsSync(path) || !statSync(path).isFile()) throw new ToolError(`no file ${path}`, `give the path of a JavaScript or TypeScript file, relative to ${process.cwd()} or absolute`);
  const save = resolve(String(a.save || defaultSave(file)));
  if (!empty(a.max_steps) && int(a.max_steps) < 1) throw new ToolError(`max_steps must be 1 or more, got ${a.max_steps}`);
  const http = String(a.http || 'off');
  oneOf(http, ['off', 'record', 'replay'], 'http mode');
  if (extname(path) === '.py') throw new ToolError(`cannot run ${basename(path)}: it is Python`, NOT_JAVASCRIPT_HINT);
  if (!JS_EXTENSIONS.has(extname(path))) throw new ToolError(`cannot run ${basename(path)}`, 'tracelight_run takes .js, .mjs, .cjs, .jsx, .ts, .mts, .cts or .tsx');
  const mode = String(a.mode || 'normal');
  oneOf(mode, ['normal', 'profile', 'snaps'], 'mode');
  if (!empty(a.max_value_chars) && int(a.max_value_chars) < 0) throw new ToolError(`max_value_chars must be 0 or more, got ${a.max_value_chars}`);
  const cwd = empty(a.cwd) ? undefined : resolve(String(a.cwd));
  if (cwd && !(existsSync(cwd) && statSync(cwd).isDirectory())) throw new ToolError(`no directory ${cwd}`);
  const { recordRun } = await import('../cli.ts');
  const { capInfo, warningLines } = await import('../agent/recording.ts');
  const { meta, events, finished } = await recordRun({
    file: path, save, json: false, autoLog: !!a.auto_log, argv: strings(a.args),
    timeoutMs: empty(a.timeout_ms) ? 30000 : int(a.timeout_ms),
    maxSteps: empty(a.max_steps) ? undefined : int(a.max_steps),
    recordLocals: !a.no_locals, http,
    libraryCode: !!a.library_code, exclude: strings(a.exclude), only: strings(a.only), plugins: strings(a.plugins),
    mode, maxValueChars: empty(a.max_value_chars) ? undefined : int(a.max_value_chars), keep: !!a.keep,
    ...(cwd ? { cwd } : {}), ...(empty(a.node) ? {} : { node: String(a.node) }), ...(empty(a.test) ? {} : { test: String(a.test) }),
  });
  const lines = [`${String(meta.executable).includes('bun') ? 'bun' : 'node'} ${meta.node} (${meta.executable}), ${NAME} ${RUNTIME_VERSION}`];
  const errors = events.filter((e) => e.type === 'error' && !e.handled);
  for (const e of events.filter((e) => e.type === 'runner.error')) lines.push(`runner: ${e.message}`);
  for (const e of errors) lines.push(`error: ${e.errorType}: ${e.message}${e.hint ? `\n  hint: ${e.hint}` : ''}`);
  const traceEv = [...events].reverse().find((e) => e.type === 'trace' && !e.partial);
  const cap = capInfo(traceEv, meta, (p: string) => p, Math.min(finished.stepCount ?? 0, traceEv?.cap ?? Infinity));
  if (cap) lines.push(...warningLines(cap));
  const h = finished.http;
  const profile = typeof finished.profile?.path === 'string' ? finished.profile.path : null;
  lines.push(`${profile ? 'profiled, no steps recorded' : `${finished.stepCount} steps`}, exit ${finished.exitCode ?? 'killed'}${finished.timedOut ? ' (timed out)' : ''}${h && h.requests ? `, ${h.requests} HTTP request(s) ${h.mode === 'off' ? 'seen' : h.mode === 'record' ? 'recorded' : 'replayed'}` : ''}`);
  if (profile) lines.push(`profile: ${profile}`);
  lines.push(`run: ${save}`);
  if (meta.keep) lines.push(`kept: runner pid ${meta.keep.pid}; tracelight_value eval and expand read the finished run, release ends it`);
  lines.push(profile ? 'next: load the .cpuprofile in Chrome DevTools (Performance > Load profile) or VS Code; a profile run has no steps to map'
    : `next: tracelight_map {"action": "walkthrough", "run": ${JSON.stringify(save)}}`);
  return [lines.join('\n') + '\n', false];
}

const TOOLS: Record<string, (a: Args) => string[]> = {
  tracelight_map: wordsMap,
  tracelight_step: wordsStep,
  tracelight_value: wordsValue,
  tracelight_coverage: wordsCoverage,
  tracelight_debug: wordsDebug,
  tracelight_investigate: wordsInvestigate,
  tracelight_verify: wordsVerify,
  tracelight_history: wordsHistory,
  tracelight_learn: wordsLearn,
  tracelight_pin: wordsPin,
  tracelight_narrate: wordsNarrate,
};

/** the tools answered outside `TOOLS`: they run something themselves instead of one verb */
const OWN_TOOLS = ['tracelight_run', 'tracelight_page', 'tracelight_scratchpad'];

export function knownTool(name: string): boolean {
  return OWN_TOOLS.includes(name) || !!TOOLS[name] || workflowDefinitions.some(d => d.name === name);
}

/**
 * Whether a call drives something live (the VS Code debugger, the browser page) and so must not
 * overlap another such call. Reading a saved run or recording a new one never conflicts. `pause`,
 * `stop` and `status` stay free so they can reach a `continue` that is still waiting, and a page's
 * `wait_pause` is the one page command the bridge lets wait beside another.
 */
export function isExclusive(name: string, a: Args): boolean {
  if (name === 'tracelight_debug') return !['pause', 'stop', 'status'].includes(a.action);
  if (name === 'tracelight_page') return !['wait_pause', 'list', 'open', 'close'].includes(a.action);
  if (name === 'tracelight_scratchpad') return !['list', 'history'].includes(a.op);
  if (name === 'tracelight_session' || name === 'tracelight_seek' || name === 'tracelight_open_investigation' || name === 'tracelight_save_investigation') return false;
  return !!(a.live || a.session);
}

let exclusiveTail: Promise<unknown> = Promise.resolve();

/** Run `call` now, or after the exclusive calls before it when it is exclusive itself. */
export function exclusiveCall<T>(name: string, a: Args, call: () => Promise<T>): Promise<T> {
  if (!a || typeof a !== 'object' || !isExclusive(name, a)) return call();
  const result = exclusiveTail.then(call, call);
  exclusiveTail = result.catch(() => undefined);
  return result;
}

/**
 * `tracelight_debug` action `status`: the live session's state, after waiting up to
 * `wait_seconds` for a pause or the end of the run when it is running. The watch is in place
 * before the state is read, so a pause between the two is not missed.
 */
export async function callStatus(a: Args): Promise<[string, boolean]> {
  const seconds = empty(a.wait_seconds) ? 0 : int(a.wait_seconds);
  if (seconds < 0 || seconds > 600) throw new ToolError('wait_seconds must be 0 to 600');
  const words = ['state', '--live', ...(a.session ? [`--session=${a.session}`] : []), ...(a.json ? ['--json'] : [])];
  if (!seconds) return runNative(words);
  const { openSource, parseVerbArgs } = await import('../agent/commands.ts');
  const verb = getVerb('watch')!;
  const parsed = parseVerbArgs(verb, ['--live', ...(a.session ? [`--session=${a.session}`] : [])], { out: () => {}, err: () => {} });
  if (typeof parsed === 'number') throw new ToolError('could not read the live session');
  const source = await openSource(verb, parsed) as any;
  let settle: (ev: Msg | null) => void = () => {};
  const event = new Promise<Msg | null>((res) => { settle = res; });
  let watching: () => void = () => {};
  const subscribed = new Promise<void>((res) => { watching = res; });
  const watch = source.watch((ev: Msg) => { if (ev.event === 'paused' || ev.event === 'finished') settle(ev); }, watching)
    .then(() => settle(null), () => settle(null));
  const timer = setTimeout(() => settle(null), seconds * 1000);
  const started = Date.now();
  try {
    await Promise.race([subscribed, watch]);
    const now = JSON.parse((await runNative(['state', '--live', '--json', ...(a.session ? [`--session=${a.session}`] : [])]))[0]);
    if (now.error || now.kind !== 'debug' || now.paused || now.running === false) return runNative(words);
    const ev = await event;
    const waited = Math.round((Date.now() - started) / 100) / 10;
    const [text, isError] = await runNative(words);
    if (a.json) return [text, isError];
    const head = ev ? `${ev.event === 'paused' ? 'paused' : `finished: exit ${ev.exitCode ?? '?'}`} after waiting ${waited} s` : `still running after ${seconds} s`;
    return [`${head}\n${text}`, isError];
  } finally {
    clearTimeout(timer);
    source.close();
  }
}

/** A `tools/call` result: the command's text, `isError` when it failed. */
export async function callTool(name: string, args: Args): Promise<Msg> {
  let text: string;
  let isError: boolean;
  try {
    if (workflowDefinitions.some(d => d.name === name)) {
      const payload = boundedEvidence(await callWorkflow(name, args));
      return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: false };
    }
    if (name === 'tracelight_run') [text, isError] = await callRun(args);
    else if (name === 'tracelight_page' || name === 'tracelight_scratchpad') {
      const r = await (name === 'tracelight_page' ? callPage(args) : callScratchpad(args));
      return { content: [{ type: 'text', text: r.text }], ...(r.structured ? { structuredContent: r.structured } : {}), isError: r.isError };
    }
    else if (name === 'tracelight_debug' && args.action === 'status') [text, isError] = await callStatus(args);
    else if (TOOLS[name]) {
      const words = TOOLS[name]!(args);
      if (!nativeFor(words)) throw refusal(words);
      [text, isError] = await runNative(words);
      if ((name === 'tracelight_investigate' || name === 'tracelight_verify') && (!isError || text.trimStart().startsWith('{'))) {
        const result = JSON.parse(text);
        // A negative verification is an answer about the program, not a tool failure.
        if (!isError || (name === 'tracelight_verify' && typeof result.verified === 'boolean' && Array.isArray(result.checks))) {
          const source = name === 'tracelight_investigate' ? { run: resolve(args.run) } : { before: resolve(args.before), after: resolve(args.after) };
          let payload: Msg;
          try { payload = boundedEvidence({ ...source, ...result }, args.limit ?? 20); }
          catch (error) { throw new ToolError((error as Error).message, 'request fewer expectations or inspect the cited values separately with tracelight_value'); }
          return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: false };
        }
      }
    }
    else throw new ToolError(`unknown tool ${name}`, 'tools: ' + [...OWN_TOOLS, ...Object.keys(TOOLS)].join(', '));
  } catch (e) {
    if (e instanceof ToolError || e instanceof AgentError || e instanceof PageError) text = `error: ${e.message}${e.hint ? '\n' + e.hint : ''}`;
    else if (e instanceof TypeError) text = `error: bad argument: ${e.message}`;
    else {
      process.stderr.write(`${(e as Error).stack ?? e}\n`);
      text = `error: ${(e as Error).name}: ${(e as Error).message} (a bug in ${NAME}; the stack is in the server's log)`;
    }
    isError = true;
  }
  return { content: [{ type: 'text', text }], isError };
}

// -- JSON-RPC over stdio ----------------------------------------------------------------------

function rpcError(id: unknown, code: number, message: string): Msg {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** The reply to one message, or null for a notification. */
export async function handle(msg: any): Promise<Msg | null> {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    if (msg && typeof msg === 'object' && ('result' in msg || 'error' in msg)) return null; // a response to a request the server never sends
    return rpcError(msg && typeof msg === 'object' ? msg.id : null, -32600, 'invalid request');
  }
  if (!('id' in msg)) return null; // notifications/initialized, notifications/cancelled, …
  const id = msg.id;
  const params = msg.params ?? {};
  switch (msg.method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'tracelight', title: 'Tracelight', version: RUNTIME_VERSION },
          instructions: INSTRUCTIONS,
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: toolDefinitions(commandHelps()) } };
    case 'tools/call': {
      if (!params || typeof params !== 'object' || typeof params.name !== 'string') return rpcError(id, -32602, 'tools/call needs params.name');
      const args = params.arguments ?? {};
      if (!args || typeof args !== 'object' || Array.isArray(args)) return rpcError(id, -32602, 'tools/call params.arguments must be an object');
      if (!knownTool(params.name)) return rpcError(id, -32602, `unknown tool ${params.name}`);
      return { jsonrpc: '2.0', id, result: await callTool(params.name, args) };
    }
    case 'resources/list':
    case 'prompts/list':
      return { jsonrpc: '2.0', id, result: { [msg.method.split('/')[0]]: [] } };
    default:
      return rpcError(id, -32601, `method not found: ${msg.method}`);
  }
}

/** Read one JSON-RPC message per line until EOF and answer each on stdout, in order. */
export async function serve(input: NodeJS.ReadableStream = process.stdin, write: (line: string) => void = (l) => process.stdout.write(l)): Promise<number> {
  // the wire is ours: a console.log from anything in this process goes to the client's log
  console.log = console.info = console.debug = (...a: unknown[]) => console.error(...a);
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) continue;
    let reply: Msg | Msg[] | null;
    try {
      const msg = JSON.parse(line);
      if (Array.isArray(msg)) {
        const replies: Msg[] = [];
        for (const m of msg) {
          const r = await handle(m);
          if (r) replies.push(r);
        }
        reply = replies.length ? replies : null;
      } else reply = await handle(msg);
    } catch (e) {
      reply = rpcError(null, -32700, `parse error: ${(e as Error).message}`);
    }
    if (reply) write(JSON.stringify(reply) + '\n');
  }
  return 0;
}
