/**
 * `debug FILE`: the three routes to a window, as Pyokka's `agent/debug_start.py`. In order:
 *
 * (a) a `kind: "debug"` descriptor whose launch matches: connect and read the current pause.
 * (b) else a `kind: "run"` descriptor for the file: send `debug` with the launch over that socket.
 * (c) else the URI: `<code> --open-url vscode://ivor.tracelight/debug?…`, then poll the sessions
 *     directory for the descriptor the window writes and connect to it.
 *
 * Node has no `-m`: a launch is always a file. `--node PATH` (default `$<ENV>NODE`) names the
 * binary; it travels as `node` in the launch and the URI. `$<ENV>CODE` names the `code` binary,
 * `$<ENV>NO_FOCUS=1` keeps the window where it is.
 */
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path';
import { ENV, NAME } from '../protocol.ts';

const TITLE = NAME[0]!.toUpperCase() + NAME.slice(1);
import { pyRepr } from './argparse.ts';
import { LiveRun } from './live.ts';
import { descriptorKind, listSessions } from './sessions.ts';
import { AgentError } from './source.ts';

type Msg = Record<string, any>;

export const POLL_TIMEOUT_S = 20;
export const POLL_INTERVAL_S = 0.1;
/** a descriptor written this long before the request still counts (clock slack between processes) */
export const CLOCK_SLACK_S = 1;
/** the Tracelight extension's URI handler (`ivor.tracelight`) */
export const URI_PREFIX = `vscode://ivor.${NAME}/debug?`;
export const CODE_ENV = `${ENV}CODE`;
export const NODE_ENV = `${ENV}NODE`;
export const NO_FOCUS_ENV = `${ENV}NO_FOCUS`;

export const CODE_MISSING = 'cannot find the `code` command';
export const CODE_MISSING_HINT = `install it from VS Code's Command Palette ("Shell Command: Install code command in PATH"), or set ${CODE_ENV} to the binary`;

export const TIMEOUT_HINT =
  `look at the VS Code window first: the first time, VS Code asks whether to let ${TITLE} open the URI and waits for an answer. ` +
  `Click Open and the session starts anyway, however late the click comes, so \`${NAME} state --live\` is the next command, not a ` +
  `second \`debug\`. To stop VS Code asking, add \`ivor.${NAME}\` to the setting \`extensions.confirmedUriHandlerExtensionIds\`. ` +
  `Then check \`${NAME}.agentAccess\`: with it off the window asks whether to allow agents, and Allow starts this same launch, so the ` +
  `answer to that question is also followed by \`${NAME} state --live\`. ` +
  `Then check that the folder is open in VS Code with the ${TITLE} extension active: the URI goes to the focused window, and a window ` +
  `that is not running ${TITLE} cannot answer. The ${TITLE} output channel logs every URI it received.`;

export const AT_UNREADABLE = '--at wants FILE:LINE or a function name';
/** a function name `--at` accepts: `rrf`, or `Ranker.rank` for a method */
const AT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

export const MODULE_REFUSED = `--module runs a Python module; ${NAME} debugs a JavaScript or TypeScript file`;
export const MODULE_HINT = `give the entry file instead: \`${NAME} debug app.ts\` (\`--args ...\` passes the program's arguments)`;

export interface LaunchOpts {
  program?: string | null;
  module?: string | null;
  args?: string[];
  cwd?: string | null;
  env?: Record<string, string>;
  node?: string | null;
  stopOnEntry?: boolean;
  libraryCode?: boolean;
  record?: boolean;
  recordFrom?: string | null;
}

/** the launch the host parses: absolute paths, the flags that are set */
export function buildLaunch(o: LaunchOpts = {}): Msg {
  if (o.module) throw new AgentError(MODULE_REFUSED, MODULE_HINT);
  if (!o.program) throw new AgentError('debug needs a file', `e.g. \`${NAME} debug app.ts\`, or \`${NAME} debug server.ts --args --port 8000\``);
  const launch: Msg = { args: [...(o.args || [])], env: { ...(o.env || {}) }, stopOnEntry: !!o.stopOnEntry, libraryCode: !!o.libraryCode, record: !!o.record };
  launch.program = resolve(o.program);
  launch.cwd = o.cwd ? resolve(o.cwd) : dirname(launch.program);
  if (o.node) launch.node = resolve(o.node);
  if (o.recordFrom) {
    launch.record = true; // recording from a pause is a recording session that starts later
    launch.recordFrom = o.recordFrom;
  }
  return launch;
}

/** `FILE:LINE` -> `{file, line}`; a function name -> `{function}` (the runtime resolves it, not the host) */
export function parseAt(at: string | null | undefined): Msg {
  const value = (at || '').replace(/^\s+|\s+$/g, '');
  const i = value.lastIndexOf(':');
  const file = i >= 0 ? value.slice(0, i) : '';
  const line = i >= 0 ? value.slice(i + 1) : value;
  if (file && /^\d+$/.test(line) && parseInt(line, 10) >= 1) return { file, line: parseInt(line, 10) };
  if (AT_NAME_RE.test(value)) return { function: value };
  throw new AgentError(`${AT_UNREADABLE}, got ${pyRepr(String(at ?? ''))}`, 'e.g. `--at rrf` for a function, `--at app.ts:42` for a line');
}


function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** `parseAt`, with FILE resolved against the directory the CLI was run in; a path that is not there is refused */
export function resolveAt(at: string): Msg {
  const spec = parseAt(at);
  if ('function' in spec) return spec;
  const given = String(spec.file);
  const line = Number(spec.line);
  const path = resolve(given);
  if (isFile(path)) return { file: path, line };
  // a bare name is not a path: the host matches it against the files of the run
  if (!given.includes(sep) && !given.includes('/')) return { file: given, line };
  throw new AgentError(
    `--at names no file: ${given}`,
    `--at is resolved from the directory you ran \`${NAME}\` in, like FILE itself; give \`--at ${basename(given)}:${line}\`, a path that exists from here, or an absolute one`,
  );
}

/** a parsed `--at` back as the one string the URI and the socket both carry */
export function atText(spec: Msg): string {
  return 'function' in spec ? String(spec.function) : `${spec.file}:${spec.line}`;
}

/** Python's `urllib.parse.quote(v, safe="")` */
function quote(v: string): string {
  return encodeURIComponent(v).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** `json.dumps(x, separators=(",", ":"))`, ASCII-escaped like Python's default */
function compactJson(x: unknown): string {
  return JSON.stringify(x).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** the `vscode://ivor.tracelight/debug` URI of a launch; every value is percent-encoded */
export function buildUri(launch: Msg, at: string | string[] | null = null): string {
  const parts: [string, string][] = [];
  if (launch.program) parts.push(['program', String(launch.program)]);
  if (launch.module) parts.push(['module', String(launch.module)]);
  if (launch.args?.length) parts.push(['args', compactJson([...launch.args])]);
  if (launch.cwd) parts.push(['cwd', String(launch.cwd)]);
  if (launch.env && Object.keys(launch.env).length) parts.push(['env', compactJson({ ...launch.env })]);
  if (launch.python) parts.push(['python', String(launch.python)]);
  if (launch.node) parts.push(['node', String(launch.node)]);
  if (launch.stopOnEntry) parts.push(['stopOnEntry', '1']);
  if (launch.record) parts.push(['record', '1']);
  if (launch.recordFrom) parts.push(['recordFrom', String(launch.recordFrom)]);
  if (launch.libraryCode) parts.push(['libraryCode', '1']);
  if (launch.breakOnException && launch.breakOnException !== 'uncaught') parts.push(['breakOnException', String(launch.breakOnException)]);
  for (const one of typeof at === 'string' ? [at] : [...(at || [])]) if (one) parts.push(['at', one]);
  return URI_PREFIX + parts.map(([k, v]) => `${k}=${quote(v)}`).join('&');
}

function which(name: string): string | null {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    try {
      accessSync(p, constants.X_OK);
      if (statSync(p).isFile()) return p;
    } catch {
      /* next */
    }
  }
  return null;
}

/** `$<ENV>CODE` if set, else `code` on PATH */
export function codeCommand(): string {
  const explicit = process.env[CODE_ENV];
  if (explicit) return explicit;
  const found = which('code');
  if (!found) throw new AgentError(CODE_MISSING, CODE_MISSING_HINT);
  return found;
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function sameFile(a: unknown, b: unknown): boolean {
  if (!a || !b) return false;
  return real(String(a)) === real(String(b));
}

/** a debug descriptor that describes this launch: the same program (by realpath) or module */
export function matchesLaunch(descriptor: Msg, launch: Msg): boolean {
  if (descriptorKind(descriptor) !== 'debug') return false;
  const d = descriptor.launch && typeof descriptor.launch === 'object' ? descriptor.launch : {};
  if (launch.module) return d.module === launch.module;
  if (!launch.program) return false;
  const theirs = d.program || descriptor.file;
  return !!theirs && sameFile(theirs, launch.program);
}

function startedAtOrAfter(descriptor: Msg, since: number): boolean {
  const started = descriptor.started;
  if (typeof started !== 'string') return true;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(started.slice(0, 19));
  if (!m) return true;
  const stamp = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) / 1000; // the host writes UTC
  return stamp >= since - CLOCK_SLACK_S;
}

/** the debug descriptor of this launch, newest first; `since` (seconds) ignores one written before the request */
export function findDebugDescriptor(launch: Msg, opts: { since?: number | null; directory?: string | null } = {}): Msg | null {
  for (const d of listSessions(opts.directory)) {
    if (!matchesLaunch(d, launch)) continue;
    if (opts.since !== null && opts.since !== undefined && !startedAtOrAfter(d, opts.since)) continue;
    return d;
  }
  return null;
}

/** a run-all descriptor for the launch's program: route (b) */
export function findRunDescriptor(launch: Msg, opts: { directory?: string | null } = {}): Msg | null {
  if (!launch.program) return null;
  for (const d of listSessions(opts.directory)) if (descriptorKind(d) !== 'debug' && sameFile(d.file, launch.program)) return d;
  return null;
}

/** which route applies: `['debug', d]`, `['run', d]` or `['uri', null]` */
export function buildRoute(launch: Msg, opts: { directory?: string | null } = {}): ['debug' | 'run' | 'uri', Msg | null] {
  const debug = findDebugDescriptor(launch, opts);
  if (debug) return ['debug', debug];
  const run = findRunDescriptor(launch, opts);
  if (run) return ['run', run];
  return ['uri', null];
}

/** hand the URI to VS Code; which window answers is VS Code's choice: the focused one */
export function openUrl(uri: string): void {
  const command = codeCommand();
  const r = spawnSync(command, ['--open-url', uri], { stdio: 'pipe', timeout: 30000 });
  if (r.error && (r.error as NodeJS.ErrnoException).code !== 'ETIMEDOUT') throw new AgentError(`cannot run ${command}: ${r.error.message}`, CODE_MISSING_HINT);
}

const sleep = (s: number) => new Promise((res) => setTimeout(res, s * 1000));

/** wait for the window to write the debug descriptor of this launch, or say why it did not */
export async function pollForDescriptor(launch: Msg, since: number, opts: { timeout?: number; directory?: string | null } = {}): Promise<Msg> {
  const deadline = Date.now() / 1000 + (opts.timeout ?? POLL_TIMEOUT_S);
  while (Date.now() / 1000 < deadline) {
    let found = findDebugDescriptor(launch, { since, directory: opts.directory });
    if (!found && launch.record) found = await recordingInDebug(launch, since, opts.directory ?? null);
    if (found) return found;
    await sleep(POLL_INTERVAL_S);
  }
  const name = launch.module ? `-m ${launch.module}` : basename(String(launch.program || ''));
  throw new AgentError(`the VS Code window did not start a debug session for ${name}`, TIMEOUT_HINT);
}

/** `--record`: the window runs it as a recording session (`kind: "run"`); it is the one once its debug run has paused */
async function recordingInDebug(launch: Msg, since: number, directory: string | null): Promise<Msg | null> {
  for (const d of listSessions(directory)) {
    if (descriptorKind(d) === 'debug' || !sameFile(d.file, launch.program) || !startedAtOrAfter(d, since)) continue;
    try {
      const source = await LiveRun.open(d);
      try {
        const debug = (await source.request({ type: 'state' })).debug;
        if (debug && typeof debug === 'object' && debug.paused) return d;
      } finally {
        source.close();
      }
    } catch (e) {
      if (!(e instanceof AgentError)) throw e;
    }
  }
  return null;
}

/** bring the VS Code window to the front at `file:line` for the first stop of a session an agent started; best effort */
export function focusEditor(file: string, line: unknown): boolean {
  if (process.env[NO_FOCUS_ENV] || !file || !line) return false;
  try {
    const command = codeCommand();
    const child = spawn(command, ['--goto', `${file}:${Number.parseInt(String(line), 10)}`], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    return false;
  }
  return true;
}

/** route (c): open the URI, poll for the descriptor, return it */
export async function startViaUri(launch: Msg, at: string | string[] | null = null, opts: { timeout?: number; directory?: string | null } = {}): Promise<Msg> {
  const since = Date.now() / 1000;
  openUrl(buildUri(launch, at));
  return pollForDescriptor(launch, since, opts);
}

/** the three routes, in order: the connection, the launch to send over it (route b only), and the route */
export async function openDebugSession(launch: Msg, at: string | string[] | null = null, opts: { timeout?: number; directory?: string | null } = {}): Promise<[LiveRun, Msg | null, string]> {
  const [route, descriptor] = buildRoute(launch, opts);
  if (route === 'debug') return [await LiveRun.open(descriptor || {}), null, route];
  if (route === 'run') return [await LiveRun.open(descriptor || {}), launch, route];
  return [await LiveRun.open(await startViaUri(launch, at, opts)), null, route];
}

/** a seam for tests: `openDebugSession` as the verbs reach it */
export const debugStart = { openDebugSession };
