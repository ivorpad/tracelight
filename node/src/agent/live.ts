/**
 * `--live`: the verbs over the bridge of an open VS Code session.
 *
 * The extension (`src/agent/bridge.ts`, setting `tracelight.agentAccess`) listens on one Unix socket
 * per session and describes it in a descriptor (`sessions.ts` says where). `LiveRun` sends the
 * token line, then one request per command, and hands the reply to the same renderer as a saved
 * run: the bridge already answers with the context-slice shape. What the bridge does not serve
 * (the whole trace: `story`, `find`, `steps --line`) is refused with a hint that names the
 * saved-run command instead.
 *
 * Debugging (`debug`, `continue`, `pause`, `stop`, `restart`, `break`, `watches`, `locals`,
 * `exec`, `record`) is live only: every stop is the same slice plus `paused` (`stopReason` turns
 * it into the text after `paused at`), or `finished` when the program ended.
 *
 * This module also installs `openLive` as `commands.ts`'s `--live` seam (`setLiveOpener`) and
 * `watchLine` as the `watch` verb's line format.
 */
import { basename, dirname, resolve } from 'node:path';
import { NAME } from '../protocol.ts';
import { pyRepr } from './argparse.ts';
import { setLiveOpener, type Args } from './commands.ts';
import { PROVENANCE_DEPTH } from './protocol.ts';
import { oneLine } from './render.ts';
import { stopReason } from './render_debug.ts';
import { AgentError, SavedRun, callSource, displayPath } from './source.ts';
import { LinkClosed, SocketLink } from './link.ts';
import { DEBUG_VERBS, NO_SESSION, NO_SESSION_HINT, descriptorKind, fileMatches, listSessions, pickSession, preferKind, substitutionNote } from './sessions.ts';
import { watchFormat } from './verbs/watch.ts';
import { moveKind } from './verbs/step.ts';
import { atText, debugStart, resolveAt } from './debug_start.ts';
import { RELAUNCH_VERBS, commandLine, hasDebugSession, recall, remember } from './relaunch.ts';

type Msg = Record<string, any>;

export { stopReason };
export const CONNECT_TIMEOUT_S = 5;
export const WATCH_VALUES = 6;
/** what a debug session answers for the verbs that read a recording */
export const RECORDING_HINT = `start the debug session with recording (\`${NAME} debug FILE --record\`, or "Tracelight: Debug Current File (Recording)"), or read a run-all session of the file`;
/** the host's answer to a request type it does not know: `unknown request "recording"` */
export const OLD_EXTENSION = /^unknown request ["']([^"']*)["']$/;

export class LiveRun {
  readonly descriptor: Msg;
  readonly file: string;
  readonly workspaceRoot: string;
  readonly displayName: string;
  readonly kind: 'run' | 'debug';
  link!: SocketLink;
  private stale = false;

  constructor(descriptor: Msg) {
    this.descriptor = descriptor;
    this.file = String(descriptor.file || '');
    this.workspaceRoot = String(descriptor.workspace || dirname(this.file));
    this.displayName = String(descriptor.displayName || basename(this.file));
    this.kind = descriptorKind(descriptor);
  }

  /** connect and send the token line */
  static async open(descriptor: Msg): Promise<LiveRun> {
    const run = new LiveRun(descriptor);
    try {
      run.link = await SocketLink.open(String(descriptor.socket), CONNECT_TIMEOUT_S);
    } catch (e) {
      if (e instanceof LinkClosed) throw new AgentError(`cannot connect to the live session ${run.displayName}: ${e.message}`, 'the VS Code window may be gone; ' + NO_SESSION_HINT);
      throw e;
    }
    run.link.sendRaw({ token: descriptor.token ?? null });
    return run;
  }

  // -- wire ----------------------------------------------------------------------------------------
  async request(msg: Msg): Promise<Msg> {
    let reply: Msg;
    try {
      reply = await this.link.call({ ...msg });
    } catch (e) {
      if (e instanceof LinkClosed) throw new AgentError(`the live session ${this.displayName} stopped answering: ${e.message}`, 'a closed connection right away means a stale descriptor (bad token); ' + NO_SESSION_HINT);
      throw e;
    }
    if (!reply.ok) {
      const unknown = OLD_EXTENSION.exec(String(reply.error || ''));
      if (unknown) {
        // the window runs an extension older than this CLI: say so, not the host's list of types
        throw new AgentError(
          `the VS Code extension is older than this CLI (no ${unknown[1]} request): install the vsix built from this checkout and run Developer: Reload Window`,
          `the CLI sent ${pyRepr(String(msg.type))}, which the installed extension does not serve`,
        );
      }
      let hint: string | null = reply.hint ? String(reply.hint) : null;
      const note = substitutionNote(this.descriptor);
      if (note) hint = hint ? `${hint} ${note}` : note;
      throw new AgentError(String(reply.error || `${msg.type} failed`), hint);
    }
    const out: Msg = {};
    for (const [k, v] of Object.entries(reply)) if (k !== 'id' && k !== 'ok') out[k] = v;
    if ('stale' in out) this.stale = !!out.stale;
    return out;
  }

  /** fill what the renderer reads and a saved run has: the block's first step, the values' file */
  private slice(reply: Msg): Msg {
    const block = reply.block;
    if (block && typeof block === 'object' && !Array.isArray(block)) {
      const steps = (block.lines || []).filter((l: Msg) => l && typeof l === 'object' && l.step !== null && l.step !== undefined).map((l: Msg) => l.step);
      if (steps.length) {
        if (!('firstStep' in block)) block.firstStep = Math.min(...steps);
      } else if ('count' in reply && !('firstStep' in block)) block.firstStep = reply.step ?? null;
      for (const v of reply.values || []) if (v && typeof v === 'object' && !('file' in v)) v.file = block.file ?? null;
    }
    return reply;
  }

  private fileOf(name: string | null | undefined): string | null {
    if (!name || fileMatches(this.descriptor, name)) return this.file;
    return name;
  }

  // -- RunSource -------------------------------------------------------------------------------------
  async state(): Promise<Msg> {
    const out = await this.request({ type: 'state' });
    out.live = { pid: this.descriptor.pid ?? null, descriptor: this.descriptor.descriptor ?? null, workspace: this.workspaceRoot };
    return out;
  }

  async context(opts: { step?: number | null; file?: string | null; line?: number | null; scope?: boolean } = {}): Promise<Msg> {
    const req: Msg = { type: 'context' };
    if (opts.step !== null && opts.step !== undefined) req.step = opts.step;
    else if (opts.line !== null && opts.line !== undefined) {
      if (opts.file) req.file = opts.file;
      req.line = opts.line;
    }
    if (opts.scope) req.scope = true;
    return this.slice(await this.request(req));
  }

  async step(step: number | null, opts: { kind?: string | null; to?: number | null; scope?: boolean; count?: number | null } = {}): Promise<Msg> {
    const extra: Msg = opts.scope ? { scope: true } : {};
    if (opts.count !== null && opts.count !== undefined && opts.count > 1) extra.count = opts.count; // N stops in a row; the reply is the last one
    let reply: Msg;
    if (opts.to !== null && opts.to !== undefined) reply = await this.request({ type: 'step', to: opts.to, ...extra });
    else {
      if (step !== null && step !== undefined) await this.request({ type: 'step', to: step });
      reply = await this.request({ type: 'step', kind: opts.kind ?? null, ...extra });
    }
    const out = this.slice(reply);
    if (step !== null && step !== undefined) out.from = step;
    return out;
  }

  async values(file: string, line: number): Promise<Msg> {
    const reply = await this.request({ type: 'values', file, line });
    const values = (reply.values || []).filter((v: unknown) => v && typeof v === 'object');
    for (const v of values) if (!('file' in v)) v.file = this.fileOf(file);
    return { file: this.fileOf(file), line, values };
  }

  async eval(expression: string, opts: { frame?: number | null } = {}): Promise<Msg> {
    const req: Msg = { type: 'eval', expression };
    if (opts.frame) req.frameId = opts.frame;
    const reply = await this.request(req);
    return { expression, text: reply.text ?? null, valueBag: reply.valueBag ?? null, logId: reply.logId ?? null };
  }

  async expand(valueId: string, queryPath: string[]): Promise<Msg> {
    const reply = await this.request({ type: 'expand', valueId, queryPath: [...queryPath] });
    return { node: reply.node ?? null };
  }

  story(_opts: Msg = {}): Msg {
    this.needsRecording('story');
    throw new AgentError('story needs the whole trace, which the bridge does not serve', this.savedHint(`story run.json --file ${this.displayName}`));
  }

  find(text: string, _limit = 50): Msg {
    this.needsRecording('find');
    throw new AgentError('find needs the whole trace and every value, which the bridge does not serve', this.savedHint(`find run.json ${pyRepr(text)}`));
  }

  async steps(opts: { start?: number; count?: number; line?: [string, number] | null } = {}): Promise<Msg> {
    this.needsRecording('steps');
    if (opts.line) throw new AgentError('steps --line needs the trace; the bridge serves one step per request', `\`context --live --line ${opts.line[0]}:${opts.line[1]}\` gives the first step on the line; a saved run lists them all`);
    const total = Number(((await this.request({ type: 'state' })).nav || {}).count || 0);
    const start = Math.max(0, opts.start ?? 0);
    const end = Math.min(total, start + Math.max(1, opts.count ?? 40));
    const rows: Msg[] = [];
    for (let i = start; i < end; i++) {
      const c = await this.request({ type: 'context', step: i });
      const l = c.location || {};
      rows.push({ step: i, file: l.file ?? null, line: l.line ?? null, function: l.function ?? null, depth: Math.max(0, (c.stack || []).length - 1), scopeId: (c.block || {}).scopeId ?? null, flags: [] });
    }
    return { steps: rows, count: total, from: start, next: end < total ? end : null };
  }

  walkthrough(opts: { file?: string | null; scope?: string | null; start?: number | null; end?: number | null; allScopes?: boolean } = {}): Promise<Msg> {
    const req: Msg = { type: 'walkthrough' };
    if (opts.file !== null && opts.file !== undefined) req.file = opts.file;
    if (opts.scope !== null && opts.scope !== undefined) req.scope = opts.scope;
    if (opts.start !== null && opts.start !== undefined) req.from = opts.start;
    if (opts.end !== null && opts.end !== undefined) req.to = opts.end;
    if (opts.allScopes) req.all = true;
    return this.request(req);
  }

  async var(name: string, opts: { file?: string | null; scope?: string | null; limit?: number } = {}): Promise<Msg> {
    const req: Msg = { type: 'var', name, limit: opts.limit ?? 200 };
    if (opts.file) req.file = opts.file;
    if (opts.scope) req.scope = opts.scope;
    const out = await this.request(req);
    for (const row of out.changes || []) if (row && typeof row === 'object' && (row.file === null || row.file === undefined)) row.file = this.file;
    return out;
  }

  private async currentStep(example: string): Promise<number> {
    const nav = (await this.request({ type: 'state' })).nav || {};
    if (!nav.active || nav.step === null || nav.step === undefined) throw new AgentError('the Time Machine is not active, so there is no current step', example);
    return Number(nav.step);
  }

  async why(step: number | null, name = '', opts: { depth?: number } = {}): Promise<Msg> {
    if (step === null || step === undefined) step = await this.currentStep('give one: `why --live 21 total`; `step --live --to N` starts the Time Machine there');
    const out = await this.request({ type: 'why', step, name, depth: opts.depth ?? PROVENANCE_DEPTH });
    const fill = (node: unknown): void => {
      // the session's file where the bridge sent none, on every node with a step and every call
      if (!node || typeof node !== 'object') return;
      const n = node as Msg;
      if (n.step !== null && n.step !== undefined && (n.file === null || n.file === undefined)) n.file = this.file;
      for (const read of n.reads || []) fill(read);
      for (const call of n.calls || []) if (call && typeof call === 'object' && (call.file === null || call.file === undefined)) call.file = this.file;
    };
    fill(out.root);
    return out;
  }

  /** built here over the session's recording (bridge `recording`), with the saved run's `origin` (registered by its module) */
  async origin(step: number | null, expr = '', opts: { depth?: number } = {}): Promise<Msg> {
    if (step === null || step === undefined) step = await this.currentStep('give one: `origin --live 64`; `exceptions --live` lists the steps where exceptions were raised');
    const doc = await this.request({ type: 'recording' });
    const run = new SavedRun(String((doc.meta || {}).file || this.file || 'live-session.json'), doc);
    const out = await callSource(run, 'origin', run.checkStep(step), expr, { depth: opts.depth ?? 20 });
    out.stale = !!this.stale;
    out.staleFiles = this.staleFiles();
    return out;
  }

  graph(opts: { allScopes?: boolean; scope?: string | null; expand?: string[] | null; statements?: boolean } = {}): Promise<Msg> {
    const req: Msg = { type: 'graph' };
    if (opts.allScopes) req.all = true;
    if (opts.scope !== null && opts.scope !== undefined) req.scope = opts.scope;
    if (opts.expand?.length) req.expand = [...opts.expand];
    if (opts.statements === false) req.statements = false;
    return this.request(req);
  }

  http(): Promise<Msg> {
    return this.request({ type: 'http' });
  }

  exceptions(): Promise<Msg> {
    return this.request({ type: 'exceptions' });
  }

  /** the session's run as a saved run's `{meta, events}`, for verbs that read the whole trace */
  recording(): Promise<Msg> {
    this.needsRecording('tour');
    return this.request({ type: 'recording' });
  }

  release(): Msg {
    throw new AgentError('release is for the kept runner of a saved run', 'a live session belongs to VS Code; stop it there');
  }

  // -- debugging: the pause ------------------------------------------------------------------------------
  /** start (or read) a debug session of this file; the reply is the first stop */
  async debug(opts: { stopOnEntry?: boolean; launch?: Msg | null } = {}): Promise<Msg> {
    const req = debugRequest('debug', !!opts.stopOnEntry);
    if (opts.launch !== null && opts.launch !== undefined) req.launch = opts.launch;
    return this.stopReply(await this.request(req));
  }

  async restart(opts: { stopOnEntry?: boolean } = {}): Promise<Msg> {
    return this.stopReply(await this.request(debugRequest('restart', !!opts.stopOnEntry)));
  }

  stop(): Promise<Msg> {
    return this.request({ type: 'stop' });
  }

  /** resume; the reply is the next stop (`noWait`: `{resumed: true}` at once) */
  async continue(opts: { noWait?: boolean; until?: string | null; to?: [string, number] | null } = {}): Promise<Msg> {
    const req: Msg = { type: 'continue' };
    if (opts.noWait) req.noWait = true;
    if (opts.until) req.until = opts.until;
    if (opts.to) req.to = { file: opts.to[0], line: opts.to[1] };
    return this.stopReply(await this.request(req));
  }

  /** run a statement in the paused frame; the session stays paused even when it raised */
  async exec(source: string, opts: { frame?: number | null } = {}): Promise<Msg> {
    const req: Msg = { type: 'exec', source };
    if (opts.frame) req.frameId = opts.frame;
    const reply = await this.request(req);
    const out: Msg = { source, text: reply.text ?? null, modified: !!reply.modified, valueBag: reply.valueBag ?? null, exception: reply.exception ?? null };
    if (out.exception && typeof out.exception === 'object' && !Array.isArray(out.exception)) out.location = await this.pausedLocation();
    return out;
  }

  async record(): Promise<Msg> {
    return this.stopReply(await this.request({ type: 'record' }));
  }

  private async pausedLocation(): Promise<Msg | null> {
    let dbg: unknown;
    try {
      dbg = (await this.request({ type: 'state' })).debug;
    } catch (e) {
      if (e instanceof AgentError) return null;
      throw e;
    }
    const paused = dbg && typeof dbg === 'object' ? (dbg as Msg).paused : null;
    if (!paused || typeof paused !== 'object' || Array.isArray(paused)) return null;
    return { file: paused.file ?? null, line: paused.line ?? null };
  }

  async pause(opts: { noWait?: boolean } = {}): Promise<Msg> {
    const req: Msg = { type: 'pause' };
    if (opts.noWait) req.noWait = true;
    return this.stopReply(await this.request(req));
  }

  private stopReply(reply: Msg): Msg {
    const fin = reply.finished;
    return fin && typeof fin === 'object' && !Array.isArray(fin) ? reply : this.slice(reply);
  }

  /** `at` is a function name whose entry pauses; the runtime resolves it, not the host */
  breakpoints(opts: { add?: Msg[] | null; remove?: Msg[] | null; exceptions?: string | null; at?: string | null } = {}): Promise<Msg> {
    const req: Msg = { type: 'break' };
    if (opts.add?.length) req.add = [...opts.add];
    if (opts.remove?.length) req.remove = [...opts.remove];
    if (opts.exceptions) req.exceptions = opts.exceptions;
    if (opts.at) req.at = opts.at;
    if (!opts.add?.length && !opts.remove?.length && !opts.exceptions && !opts.at) req.list = true;
    return this.request(req);
  }

  watches(opts: { add?: Msg[] | null; remove?: string[] | null } = {}): Promise<Msg> {
    const req: Msg = { type: 'watches' };
    if (opts.add?.length) req.add = [...opts.add];
    if (opts.remove?.length) req.remove = [...opts.remove];
    if (!opts.add?.length && !opts.remove?.length) req.list = true;
    return this.request(req);
  }

  locals(opts: { valueBag?: boolean; frame?: number | null } = {}): Promise<Msg> {
    const req: Msg = { type: 'locals' };
    if (opts.valueBag) req.valueBag = true;
    if (opts.frame) req.frameId = opts.frame;
    return this.request(req);
  }

  /** `watch` once, then hand every streamed event over until the bridge closes */
  async watch(onEvent: (ev: Msg) => void): Promise<void> {
    await this.request({ type: 'watch' });
    try {
      for (;;) {
        let msg: Msg;
        try {
          msg = await this.link.recv();
        } catch (e) {
          if (e instanceof LinkClosed) return;
          throw e;
        }
        if (msg && typeof msg === 'object' && msg.event) onEvent(msg);
      }
    } finally {
      try {
        this.link.send({ type: 'unwatch' });
      } catch (e) {
        if (!(e instanceof LinkClosed)) throw e;
      }
    }
  }

  /** a debug session records nothing, so the verbs that read a trace are refused */
  private needsRecording(verb: string): void {
    if (this.kind === 'debug') throw new AgentError(`${verb} needs a recording`, RECORDING_HINT);
  }

  private savedHint(command: string): string {
    return `save a run (\`${NAME} run ${this.displayPath(this.file)} --save run.json\`) and use \`${NAME} ${command}\`; live, \`context --live --line F:L\` and \`step --live\` navigate without it`;
  }

  // -- what the renderer asks a source ------------------------------------------------------------------
  staleFiles(): string[] {
    return this.stale ? [this.displayPath(this.file)] : [];
  }

  displayPath(path: string | null | undefined): string {
    return displayPath(path, this.workspaceRoot);
  }

  close(): void {
    this.link?.close();
  }
}

function debugRequest(type: string, stopOnEntry: boolean): Msg {
  const req: Msg = { type };
  if (stopOnEntry) req.stopOnEntry = true;
  return req;
}

function valuesPart(event: Msg, oneLine: (text: unknown, limit?: number) => string): string {
  const parts: string[] = [];
  const values = (event.values || []).filter((v: unknown) => v && typeof v === 'object');
  for (const v of values.slice(0, WATCH_VALUES)) {
    const text = oneLine(v.text, 60);
    parts.push(v.context ? `${v.context} = ${text}` : text);
  }
  if (values.length > WATCH_VALUES) parts.push(`… ${values.length - WATCH_VALUES} more`);
  return parts.length ? '   values: ' + parts.join(', ') : '';
}

const pyStr = (v: unknown) => (v === null || v === undefined ? 'None' : v === true ? 'True' : v === false ? 'False' : String(v));

/** one bounded line per streamed event: `step N  file:line  function   values: a = 1`, `paused at file:line (reason)` */
export function watchLine(event: Msg, source: Msg, oneLine: (text: unknown, limit?: number) => string): string {
  const kind = event.event;
  const l = event.location || {};
  if (kind === 'step') return `step ${pyStr(event.step)}  ${source.displayPath(l.file)}:${pyStr(l.line)}  ${l.function || ''}` + valuesPart(event, oneLine);
  if (kind === 'paused') return `paused at ${source.displayPath(l.file || event.file)}:${pyStr(l.line || event.line)} (${stopReason(event)})` + valuesPart(event, oneLine);
  if (kind === 'resumed') return 'resumed';
  if (kind === 'output') return `output: ${String(event.text || '').split('\n').join(' ').trim()}`;
  if (kind === 'finished') return `finished: exit ${pyStr(event.exitCode)}`;
  if (kind === 'rerun') return 'rerun';
  if (kind === 'stopped') return 'stopped';
  return pyStr(kind);
}

// -- opening a live source ---------------------------------------------------------------------------------

/** the live-only verbs: no saved-run form */
export const DEBUG_COMMANDS = new Set([...DEBUG_VERBS, 'record']);

export const NO_DEBUG_HINT = `start one with \`${NAME} debug FILE --at NAME\`; it opens the session and prints the first stop`;

/** the file the command names (`--line F:L`, `--file F`, `debug FILE`): it picks the live session */
export function fileHint(args: Args): string | null {
  if (args.command === 'debug' && typeof args.program === 'string' && args.program) return args.program;
  const line = args.line;
  if (typeof line === 'string' && line.includes(':')) return line.slice(0, line.lastIndexOf(':'));
  return typeof args.file === 'string' ? args.file : null;
}

/** `--at` repeats on `debug` and `break`: the first stays `args.at`, the rest go to `args.also_at` */
export function splitAt(args: Args): void {
  const at = args.at;
  if (Array.isArray(at)) {
    args.at = at.length ? at[0] : null;
    args.also_at = at.slice(1);
  } else if (!('also_at' in args)) args.also_at = [];
}

/** `break` or `continue` landed on a recording session with no debug run in it */
async function idleRecording(args: Args, descriptor: Msg, source: LiveRun): Promise<boolean> {
  if (!['break', 'continue'].includes(args.command) || args.session || descriptorKind(descriptor) === 'debug') return false;
  if (recall() === null) return false; // nothing to start instead, so the host's own answer is the one to give
  try {
    const dbg = (await source.request({ type: 'state' })).debug;
    return dbg === null || dbg === undefined;
  } catch (e) {
    if (e instanceof AgentError) return false;
    throw e;
  }
}

/**
 * `break`, `continue`, `restart` with no debug session: start the last launch from this directory
 * again. The first stop is the answer: the `break` position or `continue --to` line when one was
 * given, else the launch's own `--at`. Null when this verb does not relaunch or there is a session.
 */
async function relaunch(args: Args, sessions: Msg[]): Promise<LiveRun | null> {
  if (!RELAUNCH_VERBS.has(args.command) || args.session || hasDebugSession(sessions)) return null;
  const entry = recall();
  if (entry === null) return null;
  if (args.no_start) throw new AgentError(NO_SESSION, `the last launch here was \`${commandLine(entry.launch, entry.at, entry.also)}\`; run it, or drop --no-start to let this command start it`);
  const positions: string[] = [...(args.positions || [])];
  const breakAt = args.command === 'break' ? args.at ?? null : null;
  // listing or removing breakpoints of a program that is not running starts nothing
  if (args.command === 'break' && !positions.length && !breakAt) throw new AgentError(NO_SESSION, NO_DEBUG_HINT);
  let extra: string[] = [];
  let at: string | null = entry.at ?? null;
  if (breakAt) [at, extra] = [breakAt, positions];
  else if (positions.length) [at, extra] = [positions[0]!, positions.slice(1)];
  else if (args.command === 'continue' && args.to) at = args.to;
  if (at) at = atText(resolveAt(at));
  const launch = entry.launch;
  const also: string[] = breakAt || positions.length || (args.command === 'continue' && args.to) ? [] : [...(entry.also || [])];
  const [source, send, route] = await debugStart.openDebugSession(launch, [at, ...also].filter((a): a is string => !!a));
  remember(launch, at, also);
  args._relaunched = commandLine(launch, at, also);
  args.also_at = also;
  args._route = route;
  args._launch = send;
  args._at_over_socket = !!at && route !== 'uri';
  args._extra_breaks = extra;
  args.at = at;
  args.stop_on_entry = false;
  args.command = 'debug';
  return source;
}

/** `--live`: pick the session the verb wants and connect; a debugger verb with nothing to drive starts the last launch again */
export async function openLive(args: Args): Promise<LiveRun> {
  const prefer = preferKind(args.command, moveKind(args));
  const sessions = listSessions();
  let picked: Msg;
  try {
    picked = pickSession(sessions, { session: args.session ?? null, fileHint: fileHint(args), prefer });
  } catch (e) {
    if (!(e instanceof AgentError) || !DEBUG_COMMANDS.has(args.command) || e.message !== NO_SESSION) throw e;
    const relaunched = await relaunch(args, sessions);
    if (relaunched) return relaunched;
    throw new AgentError(NO_SESSION, NO_DEBUG_HINT);
  }
  const source = await LiveRun.open(picked);
  if (await idleRecording(args, picked, source)) {
    // the debug session ended and only a recording is left: the remembered launch is the better answer
    const relaunched = await relaunch(args, sessions);
    if (relaunched) {
      source.close();
      return relaunched;
    }
  }
  return source;
}

setLiveOpener(openLive);
watchFormat.line = (event, source) => watchLine(event, source, oneLine);

export { listSessions, pickSession, preferKind, descriptorKind, substitutionNote, NO_SESSION, NO_SESSION_HINT };
