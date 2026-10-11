/**
 * `tracelight mcp`: the agent tools as an MCP server on stdin/stdout, a port of `pyokka mcp`
 * (python/pyokka_runtime/agent/mcp.py) with the same six tools and the same arguments.
 *
 * Stdlib JSON-RPC 2.0, one message per line (the MCP stdio transport), no SDK.
 *
 * - `pyokka_run` records a JavaScript / TypeScript file in this process (`tracelight run FILE --save`);
 *   a `.py` file goes to `pyokka run --save`.
 * - The other five turn a call into the words of the one-shot agent command and run it with the
 *   `pyokka` CLI, which reads a saved JavaScript run as it reads a Python one (docs/tracelight). The
 *   tool answers exactly what the command prints: its text, its `error:` and hint (as `isError`),
 *   or the `--json` shape with `json: true`.
 *
 * The `pyokka` CLI is `$TRACELIGHT_PYOKKA` (a command line), else `pyokka` on PATH, else
 * `python3 -m pyokka_runtime` from this checkout's python/ directory.
 *
 * stdout is the wire: replies go out on fd 1 and `console.log` is pointed at stderr, so a stray
 * print lands in the client's log instead of corrupting the stream.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, extname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { ENV, NAME, RUNTIME_VERSION } from '../protocol.ts';
import { dispatchVerb, getVerb, liveAvailable, verbNames, type Io } from '../agent/commands.ts';
import '../agent/verbs.ts';
import { DEBUG_ACTIONS, DEBUG_COMMAND, MAP_ACTIONS, MOVES, VALUE_ACTIONS, toolDefinitions } from './tools.ts';

type Args = Record<string, any>;
type Msg = Record<string, any>;

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export const INSTRUCTIONS = `Pyokka records a JavaScript or TypeScript program (or a Python one) and answers questions from the recording, so you read what the program did instead of guessing from the source. Every value comes from the run.

1. pyokka_run {file} records it and prints the run.json path (default .pyokka/runs/<name>.json next to the file).
2. pyokka_map {action: "walkthrough", run} is the map: calls with arguments and results, branches, loops, logs, exceptions, each with a step number.
3. pyokka_step {run, step, move: "into"} is the Time Machine: code, values, stack and moves at a step; move back and forward freely.
4. pyokka_value {action: "why", run, step, name} explains where a value came from; "var" lists every change of a name; "origin" follows a bad value from an exception back to its root.
5. pyokka_coverage {run} lists the lines that never ran.
For a program running now in VS Code (setting pyokka.agentAccess), pass live: true instead of run; pyokka_debug {action: "start", file, at: ["func"]} starts the debugger and returns the first stop, then "continue", "locals", pyokka_step with a move.
The text results are the form to read; json: true gives the raw shape.`;

const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx']);

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
  const opts: string[] = [];
  const pos: string[] = [];
  if (a.json) opts.push('--json');
  if (a.live || a.session) {
    opts.push('--live');
    if (a.session) opts.push(`--session=${a.session}`);
  } else if (a.run && positional) pos.push(String(a.run));
  else if (positional) throw new ToolError('give `run` (a run.json from pyokka_run) or `live: true`', 'record one with pyokka_run {file}; live reads the open VS Code session (setting pyokka.agentAccess)');
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
  const action = need(a, 'action', 'pyokka_map', '{"action": "walkthrough", "run": "run.json"}');
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
  }
  if (action === 'tour') {
    opt(words, a, 'goal', '--goal');
    opt(words, a, 'budget', '--budget');
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
  const action = need(a, 'action', 'pyokka_value', '{"action": "var", "run": "run.json", "name": "total"}');
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
    if (empty(a.step) && !opts.includes('--live')) throw new ToolError(`${action} needs \`step\``, 'pyokka_value var lists the steps where a name changed; pyokka_map exceptions lists the steps that raised');
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

export function wordsDebug(a: Args): string[] {
  const action = need(a, 'action', 'pyokka_debug', '{"action": "start", "file": "app.ts", "at": ["main"]}');
  oneOf(action, DEBUG_ACTIONS);
  const words = [DEBUG_COMMAND[action] ?? action, '--live'];
  opt(words, a, 'json', '--json');
  opt(words, a, 'session', '--session');
  if (action === 'start') {
    for (const flag of ['module', 'cwd', 'python', 'record_from']) opt(words, a, flag, '--' + flag.replace('_', '-'));
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
    opt(words, a, 'when', '--when');
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
  if (action === 'locals') opt(words, a, 'frame', '--frame');
  if (action === 'exec') {
    opt(words, a, 'frame', '--frame');
    return [...words, '--', String(need(a, 'source', 'exec', '{"action": "exec", "source": "rank = 3"}'))];
  }
  return words;
}

// -- running a call ---------------------------------------------------------------------------

export interface PyokkaCli {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function onPath(name: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    try {
      if (dir && statSync(join(dir, name)).isFile()) return true;
    } catch {
      // not here
    }
  }
  return false;
}

/** How to run the `pyokka` agent CLI. */
export function pyokkaCli(): PyokkaCli {
  const custom = process.env[`${ENV}PYOKKA`]?.trim();
  if (custom) {
    const [command, ...args] = custom.split(/\s+/);
    return { command: command!, args, env: process.env };
  }
  const checkout = resolve(import.meta.dirname, '../../../python');
  if (existsSync(join(checkout, 'pyokka_runtime', '__main__.py'))) {
    const pythonPath = [checkout, process.env.PYTHONPATH].filter(Boolean).join(delimiter);
    return { command: process.env.PYOKKA_PYTHON || 'python3', args: ['-m', 'pyokka_runtime'], env: { ...process.env, PYTHONPATH: pythonPath } };
  }
  if (onPath('pyokka')) return { command: 'pyokka', args: [], env: process.env };
  return { command: 'python3', args: ['-m', 'pyokka_runtime'], env: process.env };
}

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
 * Whether this runtime answers `words` itself: its agent CLI has the verb, and the source is a
 * Tracelight run or a live session it can reach. A Python run, and a verb not ported yet, go to
 * the `pyokka` CLI.
 */
export function nativeFor(words: string[]): boolean {
  const verb = getVerb(words[0]!);
  if (!verb) return false;
  if (words.includes('--live')) return verb.common === 'live' || !!verb.open || liveAvailable();
  const sep = words.indexOf('--');
  const run = sep >= 0 ? words[sep + 1] : undefined;
  return run !== undefined && isTracelightRun(run);
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

/** Run one agent command the way the CLI would: `[text, isError]`. */
export function runWords(words: string[], cli: PyokkaCli = pyokkaCli()): [string, boolean] {
  const r = spawnSync(cli.command, [...cli.args, ...words], { env: cli.env, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error) throw new ToolError(`cannot run the pyokka CLI (${[cli.command, ...cli.args].join(' ')}): ${r.error.message}`, `install pyokka (pip install pyokka-runtime) or set ${ENV}PYOKKA to its command`);
  const text = r.stdout ?? '';
  const extra = r.stderr ?? '';
  if (r.status !== 0) {
    const out = (text + extra).trim();
    const command = /invalid choice: '([\w-]+)'/.exec(out)?.[1];
    if (command) return [`error: this pyokka CLI has no \`${command}\` command; update pyokka (\`coverage\` comes with Pyokka's own MCP server)`, true];
    if (/invalid choice|unrecognized arguments|the following arguments are required/.test(out)) {
      return [`error: the pyokka CLI cannot read: ${words.join(' ')}\n${out.split('\n').pop()}`, true];
    }
    return [out || `error: the command failed (exit ${r.status})`, true];
  }
  return [(text + (extra ? '\n' + extra : '')).trimEnd() + '\n', false];
}

let helpCache: Record<string, string> | null = null;

/** Each agent command's one-line help: this runtime's own verbs, the rest from the parser the Python CLI uses. */
export function commandHelps(cli: PyokkaCli = pyokkaCli()): Record<string, string> {
  if (helpCache) return helpCache;
  const code = 'import json\nfrom pyokka_runtime.agent.shell import build_parser\nsub = build_parser()._subparsers._group_actions[0]\nprint(json.dumps({a.dest: a.help or "" for a in sub._choices_actions}))';
  const python = cli.args[0] === '-m' ? cli.command : process.env.PYOKKA_PYTHON || 'python3';
  const r = spawnSync(python, ['-c', code], { env: cli.env, encoding: 'utf8' });
  let fromPython: Record<string, string> = {};
  try {
    if (r.status === 0) fromPython = JSON.parse(r.stdout);
  } catch {
    // no Python CLI: this runtime's verbs only
  }
  helpCache = { ...fromPython, ...Object.fromEntries(verbNames().map((n) => [n, getVerb(n)!.help])) };
  return helpCache;
}

export function defaultSave(file: string): string {
  const path = resolve(file);
  const stem = basename(path, extname(path)) || 'run';
  return join(dirname(path), '.pyokka', 'runs', stem + '.json');
}

export async function callRun(a: Args): Promise<[string, boolean]> {
  const file = String(need(a, 'file', 'pyokka_run', '{"file": "app.ts"}'));
  const path = resolve(file);
  if (!existsSync(path) || !statSync(path).isFile()) throw new ToolError(`no file ${path}`, `give the path of a JavaScript or TypeScript file, relative to ${process.cwd()} or absolute`);
  const save = resolve(String(a.save || defaultSave(file)));
  if (!empty(a.max_steps) && int(a.max_steps) < 1) throw new ToolError(`max_steps must be 1 or more, got ${a.max_steps}`);
  const http = String(a.http || 'off');
  oneOf(http, ['off', 'record', 'replay'], 'http mode');
  if (extname(path) === '.py') {
    const words = ['run', path, '--save', save];
    if (a.no_locals) words.push('--no-locals');
    if (http !== 'off') words.push('--http', http);
    for (const [key, flag] of [['python', '--python'], ['timeout_ms', '--timeout'], ['max_steps', '--max-steps']] as const) if (!empty(a[key])) words.push(flag, String(a[key]));
    for (const [key, flag] of [['library_code', '--library-code'], ['keep', '--keep']] as const) if (a[key]) words.push(flag);
    if (Array.isArray(a.args) && a.args.length) words.push('--', ...strings(a.args));
    const [text, isError] = runWords(words);
    if (isError) return [text, true];
    return [text.trimEnd() + `\nnext: pyokka_map {"action": "walkthrough", "run": ${JSON.stringify(save)}}\n`, false];
  }
  if (!JS_EXTENSIONS.has(extname(path))) throw new ToolError(`cannot run ${basename(path)}`, 'pyokka_run takes .js, .mjs, .cjs, .ts, .mts, .cts or .py');
  const { recordRun } = await import('../cli.ts');
  const { meta, events, finished } = await recordRun({
    file: path, save, json: false, autoLog: false, argv: strings(a.args),
    timeoutMs: empty(a.timeout_ms) ? 30000 : int(a.timeout_ms),
    maxSteps: empty(a.max_steps) ? undefined : int(a.max_steps),
    recordLocals: !a.no_locals, http,
  });
  const lines = [`node ${meta.node} (${process.execPath}), ${NAME} ${RUNTIME_VERSION}`];
  const errors = events.filter((e) => e.type === 'error' && !e.handled);
  for (const e of events.filter((e) => e.type === 'runner.error')) lines.push(`runner: ${e.message}`);
  for (const e of errors) lines.push(`error: ${e.errorType}: ${e.message}`);
  const h = finished.http;
  lines.push(`${finished.stepCount} steps, exit ${finished.exitCode ?? 'killed'}${finished.timedOut ? ' (timed out)' : ''}${h && h.requests ? `, ${h.requests} HTTP request(s) ${h.mode === 'off' ? 'seen' : h.mode === 'record' ? 'recorded' : 'replayed'}` : ''}`);
  lines.push(`run: ${save}`);
  lines.push(`next: pyokka_map {"action": "walkthrough", "run": ${JSON.stringify(save)}}`);
  return [lines.join('\n') + '\n', false];
}

const TOOLS: Record<string, (a: Args) => string[]> = {
  pyokka_map: wordsMap,
  pyokka_step: wordsStep,
  pyokka_value: wordsValue,
  pyokka_coverage: wordsCoverage,
  pyokka_debug: wordsDebug,
};

/** A `tools/call` result: the command's text, `isError` when it failed. */
export async function callTool(name: string, args: Args): Promise<Msg> {
  let text: string;
  let isError: boolean;
  try {
    if (name === 'pyokka_run') [text, isError] = await callRun(args);
    else if (TOOLS[name]) {
      const words = TOOLS[name]!(args);
      [text, isError] = nativeFor(words) ? await runNative(words) : runWords(words);
    }
    else throw new ToolError(`unknown tool ${name}`, 'tools: pyokka_run, ' + Object.keys(TOOLS).join(', '));
  } catch (e) {
    if (e instanceof ToolError) text = `error: ${e.message}${e.hint ? '\n' + e.hint : ''}`;
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
      if (params.name !== 'pyokka_run' && !TOOLS[params.name]) return rpcError(id, -32602, `unknown tool ${params.name}`);
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
