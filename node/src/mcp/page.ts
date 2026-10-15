/**
 * `tracelight_page` and `tracelight_scratchpad`: the browser page (docs/WEB.md) as MCP tools.
 *
 * `open` starts `tracelight web FILE` as a child of this server (one per port) and waits until it
 * listens; `close` stops a page this server started. Every other action is one `AgentCommand`
 * (web/bridgeProtocol.ts) POSTed to the bridge's `/api/command`, the same request
 * `tracelight web ctl` sends, and the reply comes back as its JSON. Commands reach the one open
 * browser tab, so a page needs exactly one tab: none or two is the bridge's own error.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV, NAME } from '../protocol.ts';
import { DEFAULT_PORT, findServer, listening } from '../web.ts';

type Args = Record<string, any>;
type Msg = Record<string, any>;

export const PAGE_ACTIONS = ['open', 'close', 'list', 'state', 'position', 'goto', 'step', 'line', 'say', 'clear', 'values', 'inspect', 'peek', 'start', 'stop', 'run', 'eval', 'var', 'why', 'watch', 'breakpoint', 'debug', 'story', 'profile', 'wait_pause'] as const;
export const PAGE_STEP_KINDS = ['next', 'into', 'over', 'out', 'back', 'backOver', 'backOut'] as const;
export const PAGE_DEBUG_OPS = ['start', 'restart', 'continue', 'step', 'pause', 'stop', 'state'] as const;
export const SCRATCH_OPS = ['experiment', 'open', 'close', 'state', 'update', 'run', 'restore', 'create', 'save', 'list', 'load', 'history'] as const;

/** A page call that cannot be made: an `isError` result with a hint. */
export class PageError extends Error {
  hint: string | undefined;
  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}

export interface PageResult {
  text: string;
  isError: boolean;
  structured?: Msg;
}

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'tracelight.mjs');

interface Started {
  child: ChildProcess;
  file: string;
  port: number;
  url: string;
  stderr: string;
}

/** the pages this server started, by port */
const started = new Map<number, Started>();

/** stop every page this server started (the server is ending) */
export function closePages(): void {
  for (const p of started.values()) p.child.kill('SIGTERM');
  started.clear();
}
process.once('exit', closePages);

const empty = (v: unknown): boolean => v === undefined || v === null || v === '';

function portOf(a: Args): number {
  const port = empty(a.port) ? Number(process.env[`${ENV}PORT`] ?? DEFAULT_PORT) : Number(a.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new PageError(`port must be 1 to 65535, got ${JSON.stringify(a.port)}`);
  return port;
}

function int(a: Args, key: string, min = 0): number | undefined {
  const v = a[key];
  if (empty(v)) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) throw new PageError(`${key} must be an integer of at least ${min}`);
  return v;
}

function str(a: Args, key: string): string | undefined {
  const v = a[key];
  if (empty(v)) return undefined;
  if (typeof v !== 'string') throw new PageError(`${key} must be a string`);
  return v;
}

function need<T>(v: T | undefined, action: string, key: string, example: string): T {
  if (v === undefined) throw new PageError(`${action} needs \`${key}\``, `e.g. ${example}`);
  return v;
}

function names(a: Args, key = 'names'): string[] | undefined {
  const v = a[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((n) => typeof n !== 'string')) throw new PageError(`${key} must be a list of strings`);
  return v;
}

const pick = (o: Msg): Msg => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** The `AgentCommand` for a page action other than open, close and list. */
export function pageCommand(a: Args): Msg {
  const action = String(a.action);
  const say = str(a, 'say');
  const expect = a.expect === undefined ? undefined : a.expect;
  if (expect !== undefined && (!expect || typeof expect !== 'object' || Array.isArray(expect))) throw new PageError('expect must be an object: source, runId, step, frame, file');
  const base = (cmd: Msg): Msg => pick({ ...cmd, ...(expect ? { expect } : {}) });
  switch (action) {
    case 'state': case 'start': case 'stop': case 'run': case 'story': case 'profile':
      return base({ action });
    case 'position': {
      const mode = str(a, 'mode');
      if (mode !== undefined && !['live', 'recorded', 'visible'].includes(mode)) throw new PageError('position mode is live, recorded or visible');
      return base({ action, mode, focus: typeof a.focus === 'boolean' ? a.focus : undefined });
    }
    case 'goto':
      return base({ action, step: need(int(a, 'step'), 'goto', 'step', '{"action": "goto", "step": 12}'), say });
    case 'step': {
      const kind = str(a, 'kind') ?? 'into';
      if (!(PAGE_STEP_KINDS as readonly string[]).includes(kind)) throw new PageError(`step kind is one of ${PAGE_STEP_KINDS.join(', ')}`);
      return base({ action, kind, say });
    }
    case 'line':
      return base({ action, line: need(int(a, 'line', 1), 'line', 'line', '{"action": "line", "line": 12}'), file: str(a, 'file'), say });
    case 'say': {
      const kind = str(a, 'note_kind');
      if (kind !== undefined && !['explanation', 'prediction'].includes(kind)) throw new PageError('note_kind is explanation or prediction');
      return base({ action, text: need(str(a, 'text'), 'say', 'text', '{"action": "say", "text": "total is 0 here", "line": 12}'), line: int(a, 'line', 1), step: int(a, 'step'), file: str(a, 'file'), noteId: str(a, 'note_id'), kind });
    }
    case 'clear':
      return base({ action, noteId: str(a, 'note_id') });
    case 'values': {
      const mode = str(a, 'mode') ?? 'selected';
      if (!['selected', 'all', 'none'].includes(mode)) throw new PageError('values mode is selected, all or none');
      return base({ action, mode, names: names(a), file: str(a, 'file'), line: int(a, 'line', 1) });
    }
    case 'inspect': {
      const list = names(a);
      const name = str(a, 'name') ?? list?.[0];
      return base({ action, name: need(name, 'inspect', 'names', '{"action": "inspect", "names": ["cart", "total"]}'), names: list, open: a.visible !== false });
    }
    case 'peek':
      return base({ action, name: str(a, 'name') ?? '' });
    case 'eval':
      return base({ action, expression: need(str(a, 'expression'), 'eval', 'expression', '{"action": "eval", "expression": "items.length"}') });
    case 'var':
      return base({ action, name: need(str(a, 'name'), 'var', 'name', '{"action": "var", "name": "total"}') });
    case 'why':
      return base({ action, name: str(a, 'name') ?? '', step: int(a, 'step') });
    case 'watch':
      return base({ action, exp: need(str(a, 'expression'), 'watch', 'expression', '{"action": "watch", "expression": "total * 2"}'), remove: a.remove === true ? true : undefined });
    case 'breakpoint':
      return base({ action, line: need(int(a, 'line', 1), 'breakpoint', 'line', '{"action": "breakpoint", "line": 12, "on": true}'), file: str(a, 'file'), on: typeof a.on === 'boolean' ? a.on : undefined, condition: str(a, 'condition') });
    case 'debug': {
      const op = str(a, 'op') ?? 'state';
      if (!(PAGE_DEBUG_OPS as readonly string[]).includes(op)) throw new PageError(`debug op is one of ${PAGE_DEBUG_OPS.join(', ')}`);
      const kind = str(a, 'kind');
      if (op === 'step' && kind !== undefined && !['into', 'over', 'out'].includes(kind)) throw new PageError('debug step kind is into, over or out');
      return base({ action, op, ...(op === 'step' ? { kind: kind ?? 'over' } : {}), say });
    }
    case 'wait_pause': {
      const timeoutMs = int(a, 'timeout_ms');
      if (timeoutMs !== undefined && timeoutMs > 25000) throw new PageError('timeout_ms is at most 25000');
      return base({ action: 'waitPause', after: int(a, 'after'), timeoutMs });
    }
    default:
      throw new PageError(`unknown page action ${JSON.stringify(action)}`, 'one of ' + PAGE_ACTIONS.join(', '));
  }
}

/** The `AgentCommand` of a `tracelight_scratchpad` call. */
export function scratchCommand(a: Args): Msg {
  const op = str(a, 'op');
  if (op === undefined || !(SCRATCH_OPS as readonly string[]).includes(op)) throw new PageError(`tracelight_scratchpad needs \`op\`: one of ${SCRATCH_OPS.join(', ')}`, 'prepare a teaching experiment in one call: {"op": "experiment", "code": "...", "inputs": {...}, "mocks": {...}, "mock_labels": {...}}');
  for (const key of ['inputs', 'mocks', 'mock_labels', 'expect']) {
    const v = a[key];
    if (v !== undefined && (!v || typeof v !== 'object' || Array.isArray(v))) throw new PageError(`${key} must be a JSON object`);
  }
  if ((op === 'history' || op === 'load') && empty(a.id)) throw new PageError(`${op} needs \`id\``, 'op "list" names the saved scratchpads');
  return pick({
    action: 'scratchpad', op, id: str(a, 'id'), title: str(a, 'title'), file: str(a, 'file'), version: int(a, 'version', 1), line: int(a, 'line', 1),
    code: str(a, 'code'), inputs: a.inputs, mocks: a.mocks, mockLabels: a.mock_labels, autoRun: typeof a.auto_run === 'boolean' ? a.auto_run : undefined, expect: a.expect,
  });
}

/**
 * Whether a reply means the command did what it was for: web/server.ts `ctlExitCode`, the rule
 * `tracelight web ctl` exits by. A 200 from the bridge is only transport.
 */
export function pageSucceeded(command: Msg, httpOk: boolean, reply: unknown): boolean {
  if (!httpOk || !reply || typeof reply !== 'object') return false;
  const envelope = reply as Msg;
  if (envelope.error) return false;
  const result = envelope.result as Msg | null | undefined;
  if (command.action === 'scratchpad' && (command.op === 'experiment' || command.op === 'run')) {
    return result?.status === 'completed' && !result.error && result.liveExecutionChanged === false
      && !!result.result && !result.result.error && !result.result.missingMocks?.length && !result.result.applicationErrors?.length;
  }
  if (command.action === 'position') return result?.ready === true;
  const navigation = ['goto', 'step', 'line', 'start'].includes(command.action)
    || (command.action === 'say' && command.step !== undefined)
    || (command.action === 'debug' && !['state', 'stop'].includes(command.op));
  if (navigation) {
    if (command.action === 'debug' && result?.runId && result.running === false && result.paused === false) return true;
    return (result?.position ?? result?.state?.position)?.ready === true;
  }
  return true;
}

const OPEN_HINT = (port: number): string => `start one with tracelight_page {"action": "open", "file": "app.ts"${port === DEFAULT_PORT ? '' : `, "port": ${port}`}}, then open its URL in a browser`;

async function send(port: number, command: Msg): Promise<PageResult> {
  const base = `http://127.0.0.1:${port}`;
  let res: Response;
  try {
    res = command.action === 'state'
      ? await fetch(`${base}/api/state`)
      : await fetch(`${base}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) });
  } catch {
    throw new PageError(`no Tracelight page is served on 127.0.0.1:${port}`, OPEN_HINT(port));
  }
  const body = await res.text();
  let reply: unknown;
  try {
    reply = JSON.parse(body);
  } catch {
    return { text: `error: the page answered ${res.status}: ${body.slice(0, 500)}`, isError: true };
  }
  const ok = pageSucceeded(command, res.ok, reply);
  const structured = reply && typeof reply === 'object' && !Array.isArray(reply) ? reply as Msg : undefined;
  return { text: JSON.stringify(reply, null, 2) + '\n', isError: !ok, structured };
}

/** what serves `port` now: its file, from the bridge's own `/api/state` */
async function servedFile(port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`);
    const body = await res.json() as Msg;
    return typeof body.file === 'string' ? body.file : null;
  } catch {
    return null;
  }
}

async function open(a: Args): Promise<PageResult> {
  const port = portOf(a);
  const file = resolve(String(need(str(a, 'file'), 'open', 'file', '{"action": "open", "file": "app.ts"}')));
  if (!existsSync(file) || !statSync(file).isFile()) throw new PageError(`no file ${file}`);
  findServer(); // the build exists, or say how to get it
  const url = `http://127.0.0.1:${port}/`;
  if (await listening(port)) {
    const serving = await servedFile(port);
    if (serving === file) return { text: `page: ${url} already serves ${file}\nnext: open it in one browser tab, then tracelight_page {"action": "state"${port === DEFAULT_PORT ? '' : `, "port": ${port}`}}\n`, isError: false, structured: { url, file, port, reused: true } };
    throw new PageError(`port ${port} is taken${serving ? ` by a page serving ${serving}` : ''}`, 'pass another port, or close that page first');
  }
  const words = ['web', file, '--port', String(port)];
  if (a.no_run !== false) words.push('--no-run');
  if (a.no_watch === true) words.push('--no-watch');
  if (a.open_browser === true) words.push('--open');
  const runtime = str(a, 'runtime');
  if (runtime) words.push('--runtime', runtime);
  const node = str(a, 'node');
  if (node) words.push('--node', node);
  for (const p of names(a, 'only') ?? []) words.push('--only', p);
  const child = spawn(process.execPath, [BIN, ...words], { cwd: dirname(file), stdio: ['ignore', 'ignore', 'pipe'], env: process.env });
  const entry: Started = { child, file, port, url, stderr: '' };
  child.stderr?.on('data', (d) => { entry.stderr = (entry.stderr + String(d)).slice(-4000); });
  started.set(port, entry);
  child.once('exit', () => { if (started.get(port) === entry) started.delete(port); });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode) throw new PageError(`the page for ${file} exited (${child.exitCode ?? child.signalCode})${entry.stderr ? `: ${entry.stderr.trim().split('\n').slice(-3).join(' | ')}` : ''}`);
    if (await listening(port, 300)) {
      const text = [
        `page: ${url} serves ${file} (pid ${child.pid}, started by this MCP server; close stops it)`,
        a.no_run === false ? 'it records the file now' : 'nothing has run yet (no_run)',
        `next: open ${url} in one browser tab${a.open_browser === true ? ' (asked the system browser to open it)' : ''}, set breakpoints with action "breakpoint", then action "debug" with op "start"`,
      ].join('\n');
      return { text: text + '\n', isError: false, structured: { url, file, port, pid: child.pid } };
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  child.kill('SIGTERM');
  throw new PageError(`the page for ${file} did not listen on ${port} within 20 s`, entry.stderr.trim().split('\n').slice(-3).join(' | ') || undefined);
}

function close(a: Args): PageResult {
  const port = portOf(a);
  const entry = started.get(port);
  if (!entry) throw new PageError(`this MCP server did not start the page on port ${port}`, `stop it where it was started (Ctrl+C on \`${NAME} web\`); action "list" shows the pages this server started`);
  entry.child.kill('SIGTERM');
  started.delete(port);
  return { text: `closed: the page on ${entry.url} (${entry.file})\n`, isError: false, structured: { closed: true, port, file: entry.file } };
}

async function list(): Promise<PageResult> {
  const pages = [...started.values()].map((p) => ({ port: p.port, url: p.url, file: p.file, pid: p.child.pid ?? null }));
  const defaultPort = Number(process.env[`${ENV}PORT`] ?? DEFAULT_PORT);
  if (!started.has(defaultPort) && await listening(defaultPort, 300)) pages.push({ port: defaultPort, url: `http://127.0.0.1:${defaultPort}/`, file: await servedFile(defaultPort) ?? '(unknown)', pid: null });
  const text = pages.length ? pages.map((p) => `${p.url}  ${p.file}${p.pid === null ? '  (not started by this server)' : ''}`).join('\n') + '\n' : `no page is served (none started here, nothing on ${defaultPort})\n`;
  return { text, isError: false, structured: { pages } };
}

export async function callPage(a: Args): Promise<PageResult> {
  const action = a.action;
  if (empty(action)) throw new PageError('tracelight_page needs `action`', 'one of ' + PAGE_ACTIONS.join(', '));
  if (action === 'open') return open(a);
  if (action === 'close') return close(a);
  if (action === 'list') return list();
  return send(portOf(a), pageCommand(a));
}

export async function callScratchpad(a: Args): Promise<PageResult> {
  return send(portOf(a), scratchCommand(a));
}
