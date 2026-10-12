/**
 * `tracelight`: the runner and the agent entry points.
 *
 *   tracelight serve                      the NDJSON runner a host spawns (docs/PROTOCOL.md)
 *   tracelight run FILE [--save run.json] [--json] [--timeout MS] [--max-steps N] [--auto-log] [--record-locals | --no-locals] [--http record|replay] [-- ARGS]
 *                                        (a saved run records local variables unless --no-locals)
 *                                        run once; print the logs, output and errors; save the run
 *   tracelight instrument FILE [--json]   print the instrumented JavaScript (or the range tables)
 *   tracelight bindings FILE              the `bindings` table of FILE
 *   tracelight VERB RUN.json ...          an agent verb over a saved run (`agent/`): story, steps,
 *                                        step, context, values, find, var, eval, expand, release, state
 *   tracelight mcp                        the agent tools as an MCP server on stdin/stdout (src/mcp/server.ts)
 *   tracelight web FILE | web ctl ...     the browser page and the commands that drive it (src/web.ts, docs/WEB.md)
 *   tracelight version
 *
 * A saved run is `{meta, events}` (docs/PROTOCOL.md "Saved run"); the agent verbs that read one
 * (`agent/commands.ts`, the registry `agent/verbs.ts` lists) answer with the shapes and text the
 * extension and the skill read.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { instrument } from './instrument.ts';
import { ENV, NAME, RUNTIME_VERSION } from './protocol.ts';
import { Runner } from './runner.ts';
import { report as cacheReport } from './cache.ts';
import { KeepLink, keepMain, socketPath, spawnKeeper } from './keep.ts';
import { dispatchVerb, getVerb, verbNames, verbsHelp } from './agent/commands.ts';
import './agent/verbs.ts';
import { statementBindings } from './bindings.ts';
import { capInfo, warningLines } from './agent/recording.ts';
import { redact, redactValue } from './agent/redact.ts';
import { isUserFile } from './agent/walkthrough.ts';

type Msg = Record<string, any>;

export interface RunArgs {
  file: string;
  save?: string;
  json: boolean;
  timeoutMs: number;
  maxSteps?: number;
  autoLog: boolean;
  /** undefined: on with --save, off without */
  recordLocals?: boolean;
  http?: string;
  argv: string[];
  libraryCode?: boolean;
  exclude?: string[];
  only?: string[];
  plugins?: string[];
  mode?: string;
  maxValueChars?: number;
  keep?: boolean;
  /** `--trace-context STEP`: evaluate the `--watch` expressions from this step */
  traceContext?: number;
  watch?: string[];
  instrumented?: boolean;
  /** `--node PATH`: the Node that runs the program (else `${ENV}NODE`, else this one) */
  node?: string;
}

const RUN_USAGE = `usage: ${NAME} run FILE [--save run.json] [--json] [--timeout MS] [--max-steps N] [--library-code] [--exclude P] [--only P] [--plugin M] [--mode normal|profile|snaps] [--max-value-chars N] [--keep] [--trace-context STEP --watch EXPR] [--instrumented] [--node PATH] [-- ARGS]`;

function parseRunArgs(args: string[]): RunArgs {
  const out: RunArgs = { file: '', json: false, timeoutMs: 30000, autoLog: false, argv: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') {
      out.argv = args.slice(i + 1);
      break;
    } else if (a === '--save') out.save = args[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--timeout') out.timeoutMs = Number(args[++i]);
    else if (a === '--max-steps') out.maxSteps = Number(args[++i]);
    else if (a === '--auto-log') out.autoLog = true;
    else if (a === '--library-code') out.libraryCode = true;
    else if (a === '--keep') out.keep = true;
    else if (a === '--exclude') (out.exclude ??= []).push(args[++i]!);
    else if (a === '--only') (out.only ??= []).push(args[++i]!);
    else if (a === '--plugin') (out.plugins ??= []).push(args[++i]!);
    else if (a === '--mode') out.mode = args[++i];
    else if (a === '--max-value-chars') out.maxValueChars = Number(args[++i]);
    else if (a === '--record-locals') out.recordLocals = true;
    else if (a === '--no-locals') out.recordLocals = false;
    else if (a === '--http') out.http = args[++i];
    else if (a === '--trace-context') out.traceContext = Number(args[++i]);
    else if (a === '--watch') (out.watch ??= []).push(args[++i]!);
    else if (a === '--instrumented') out.instrumented = true;
    else if (a === '--node') out.node = args[++i];
    else if (!out.file) out.file = a;
    else out.argv.push(a);
  }
  if (!out.file) throw new Error(`${RUN_USAGE}\n\n${RUN_EPILOG}`);
  if (out.maxSteps !== undefined && !(out.maxSteps >= 1)) throw new Error('--max-steps must be at least 1');
  return out;
}

export function buildRequest(path: string, content: string, a: Partial<RunArgs>, runId: string): Msg {
  const config: Msg = { logLimit: 100, maxConsoleMessages: 1000, timeoutMs: a.timeoutMs ?? 30000, autoLog: !!a.autoLog };
  if (a.maxSteps) config.maxTraceSteps = a.maxSteps;
  if (a.libraryCode) config.libraryCode = true;
  if (a.exclude?.length) config.exclude = a.exclude;
  if (a.only?.length) config.only = a.only;
  if (a.plugins?.length) config.plugins = a.plugins.map((p) => (p.startsWith('.') ? resolve(p) : p));
  if (a.maxValueChars !== undefined) config.maxValueChars = a.maxValueChars;
  const mode = a.mode && a.mode !== 'normal' ? a.mode : undefined;
  if (a.recordLocals ?? !!a.save) config.recordLocals = true;
  if (a.http && a.http !== 'off') config.http = a.http;
  const req: Msg = { type: 'run', id: 1, runId, file: { path, displayName: path.split('/').pop(), content }, workspaceRoot: dirname(path), cwd: dirname(path), argv: a.argv ?? [], env: {}, config, ...(mode ? { mode } : {}) };
  if (a.watch?.length) req.watch = a.watch.map((exp, i) => ({ id: `w${i}`, exp }));
  if (a.traceContext !== undefined) req.traceContext = { step: a.traceContext, prefetch: 10 };
  if (a.node) req.node = a.node;
  return req;
}

/** run one file through a runner in this process; resolves with every event of the run */
export function runOnce(request: Msg): Promise<{ ready: Msg; events: Msg[]; finished: Msg }> {
  return new Promise((resolveRun, rejectRun) => {
    const events: Msg[] = [];
    let ready: Msg = {};
    const runner = new Runner((line) => {
      const msg = JSON.parse(line) as Msg;
      if (msg.type === 'ready') ready = msg;
      else if (msg.type === 'error' && msg.id === request.id) rejectRun(new Error(String(msg.message)));
      else if (msg.runId === request.runId) {
        events.push(msg);
        if (msg.type === 'run.finished') {
          runner.child?.kill();
          resolveRun({ ready, events, finished: msg });
        }
      }
    });
    void runner.dispatch({ type: 'hello', id: 0 }).then(() => runner.dispatch(request));
  });
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function display(path: string, root: string): string {
  const r = relative(root, path);
  return r && !r.startsWith('..') ? r : path;
}

/** run `a.file` once and, with `a.save`, write the saved run; the MCP server's `tracelight_run` too */
export async function recordRun(a: RunArgs): Promise<{ meta: Msg; events: Msg[]; finished: Msg; files: Msg[]; request: Msg }> {
  const path = resolve(a.file);
  const content = readFileSync(path, 'utf8');
  const runId = `cli-${Date.now()}`;
  const request = buildRequest(path, content, a, runId);
  const started = new Date();
  if (a.keep && !a.save) throw new Error('--keep needs --save: the saved run records where the kept runner listens');
  let keep: Msg | undefined;
  let result: { ready: Msg; events: Msg[]; finished: Msg };
  if (a.keep) {
    const socket = socketPath();
    const pid = await spawnKeeper(socket);
    const link = await KeepLink.open(socket);
    result = await link.run(request);
    link.close(); // the keeper stays; only this connection goes
    keep = { pid, socket };
  } else result = await runOnce(request);
  const { ready, events, finished } = result;
  const sources = new Map<number, string>();
  const files = events
    .filter((e) => e.type === 'file.instrumented')
    .map((e) => {
      let source: string | undefined;
      try {
        source = e.path === path ? content : readFileSync(e.path, 'utf8');
      } catch {
        source = undefined;
      }
      if (source === undefined) return { fileId: e.fileId, path: e.path, sha256: null };
      sources.set(e.fileId, source);
      // the user's own files keep the text that ran, redacted, so `diff` can read a run after the edit; a library keeps its hash
      return { fileId: e.fileId, path: e.path, sha256: sha256(source), ...(isUserFile(e.path, request.workspaceRoot, path) ? { source: redact(source) } : {}) };
    });
  const meta: Msg = {
    runtimeVersion: ready.runtimeVersion ?? RUNTIME_VERSION,
    language: 'javascript',
    node: ready.nodeVersion ?? process.versions.node,
    python: ready.nodeVersion ?? process.versions.node,
    executable: process.execPath,
    runId,
    file: path,
    workspaceRoot: request.workspaceRoot,
    argv: request.argv,
    config: request.config,
    started: started.toISOString().replace(/\.\d+Z$/, '+00:00'),
    durationMs: finished.durationMs,
    exitCode: finished.exitCode,
    stepCount: finished.stepCount,
    files,
  };
  if (keep) meta.keep = keep;
  if (a.save) {
    // a saved run carries each file's statement bindings, which the agent verbs (`var`, `why`) read
    // every event is redacted before it is written (docs/PROTOCOL.md, "Redaction")
    for (const e of events) redactValue(e);
    for (const e of events) {
      if (e.type !== 'file.instrumented') continue;
      const source = sources.get(e.fileId);
      if (source === undefined) continue;
      try {
        // the call texts are code from the file: redacted as the kept source is
        e.bindings = statementBindings(source, e.path).map((b: Msg) => (Array.isArray(b.calls) ? { ...b, calls: b.calls.map((c: unknown) => redact(c)) } : b));
      } catch {
        // a file that does not parse has no bindings
      }
    }
    const out = resolve(a.save);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out + '.tmp', JSON.stringify({ meta, events }) + '\n');
    renameSync(out + '.tmp', out);
  }
  return { meta, events, finished, files, request };
}

const RUN_EPILOG = `The program runs under --node PATH, else $${ENV}NODE, else the Node running ${NAME}; that Node
must be 22.15 or newer, and ${NAME} itself 22.18 or newer (it runs its TypeScript sources directly).
A run cut at --max-steps prints a WARNING naming the files that spent the most steps; --exclude
them to record the rest at full speed. A saved run records local variables unless --no-locals.`;

async function cmdRun(args: string[]): Promise<number> {
  if (args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(`${RUN_USAGE}\n\n${RUN_EPILOG}\n`);
    return 0;
  }
  const a = parseRunArgs(args);
  if (a.instrumented) return cmdInstrument([a.file]);
  const { meta, events, finished, files, request } = await recordRun(a);
  const path = meta.file as string;
  if (a.json) {
    process.stdout.write(JSON.stringify({ meta, events }) + '\n');
  } else {
    const byId = new Map<number, string>(files.map((f) => [f.fileId, f.path]));
    const ranges = new Map<number, number[][]>();
    const bases = new Map<number, number>();
    for (const e of events) if (e.type === 'file.instrumented') {
      ranges.set(e.fileId, e.ranges);
      bases.set(e.fileId, e.rangeBase);
    }
    const where = (fileId: number, rid: number) => {
      const r = ranges.get(fileId)?.[rid - (bases.get(fileId) ?? 0)];
      return `${display(byId.get(fileId) ?? '?', request.workspaceRoot)}:${r ? r[0] : '?'}`;
    };
    for (const e of events) {
      if (e.type === 'log') process.stdout.write(`${where(e.fileId, e.rid)}  ${e.context && e.kind !== 'log' ? e.context + ' = ' : ''}${e.text}\n`);
      else if (e.type === 'output') process.stdout.write(e.text);
      else if (e.type === 'watch') process.stdout.write(`[watch ${e.watchId} step ${e.step}] ${e.text ?? e.valueBag?.data?.value ?? e.error ?? ''}\n`);
      else if (e.type === 'error' && !e.handled) process.stdout.write(`error: ${e.errorType}: ${e.message}  (${where(e.fileId, e.rid)})\n`);
      else if (e.type === 'runner.error') process.stderr.write(`runner: ${e.message}\n`);
    }
    const traceEv = [...events].reverse().find((e) => e.type === 'trace' && !e.partial);
    const cap = capInfo(traceEv, meta, (p) => display(p, request.workspaceRoot), Math.min(finished.stepCount ?? 0, traceEv?.cap ?? Infinity));
    if (cap) for (const l of warningLines(cap)) process.stderr.write(l + '\n');
    const caught = events.filter((e) => e.type === 'error' && e.handled).length;
    // a profile run records no steps: its result is the .cpuprofile, which only --json showed
    const profile = typeof finished.profile?.path === 'string' ? finished.profile.path : null;
    if (profile) process.stderr.write(`profile: ${profile}\n`);
    process.stderr.write(`${a.save ? `saved ${a.save}: ` : ''}${profile ? 'profiled, no steps recorded' : `${finished.stepCount} steps`}, ${files.length} files, exit ${finished.exitCode}${finished.timedOut ? ' (timed out)' : ''}${caught ? `, ${caught} caught exception group(s)` : ''}\n`);
  }
  return finished.exitCode ?? 1;
}

function cmdInstrument(args: string[]): number {
  const file = args.find((x) => !x.startsWith('--'));
  if (!file) throw new Error(`usage: ${NAME} instrument FILE [--json]`);
  const path = resolve(file);
  const info = instrument(readFileSync(path, 'utf8'), path, 1, 0, { sourceMap: false });
  if (args.includes('--json')) {
    const { exprChildren, lineRids, ignored, functionNames, ...rest } = info;
    process.stdout.write(JSON.stringify({ ...rest, ignored: [...ignored] }, null, 1) + '\n');
  } else process.stdout.write((info.code ?? '') + '\n');
  if (info.error) process.stderr.write(info.error + '\n');
  return info.error ? 1 : 0;
}

function bytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

/** `tracelight cache [--clear] [--json]`: the library instrumentation cache */
function cmdCache(args: string[]): number {
  const clear = args.includes('--clear');
  const before = cacheReport(false);
  const r = clear ? cacheReport(true) : before;
  const entries = (n: number) => (n === 1 ? '1 entry' : `${n} entries`);
  if (args.includes('--json')) process.stdout.write(JSON.stringify(clear ? { dir: r.dir, removed: r.cleared ?? 0, bytes: before.bytes } : r) + '\n');
  else if (!r.dir) process.stdout.write(`library cache off (${ENV}CACHE_DIR is empty)${clear ? '; nothing to clear' : ''}\n`);
  else if (clear) process.stdout.write(`removed ${entries(r.cleared ?? 0)} (${bytes(before.bytes)}) from ${r.dir}\n`);
  else process.stdout.write(`${r.dir}: ${entries(r.entries)}, ${bytes(r.bytes)}\n`);
  return 0;
}

const USAGE = `usage: ${NAME} serve | run FILE [--save run.json] [--keep] | instrument FILE | bindings FILE | mcp | web FILE | web ctl ... | cache [--clear] | version | VERB RUN.json ...\n  verbs: ${verbNames().join(', ')}`;

/** the command line; a usage or input error prints its message (the stack with `${ENV}DEBUG=1`) and exits 2 */
export async function main(argv: string[]): Promise<number> {
  try {
    return await command(argv);
  } catch (e) {
    const err = e as Error;
    process.stderr.write(`${NAME}: ${process.env[`${ENV}DEBUG`] ? (err.stack ?? err.message) : (err.message ?? String(e))}\n`);
    return 2;
  }
}

async function command(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd && getVerb(cmd)) return dispatchVerb(cmd, rest);
  switch (cmd) {
    case 'serve':
      await new Runner().serve();
      return 0;
    case 'run':
      return cmdRun(rest);
    case 'instrument':
      return cmdInstrument(rest);
    case 'bindings': {
      const path = resolve(rest[0] ?? '');
      process.stdout.write(JSON.stringify(statementBindings(readFileSync(path, 'utf8'), path), null, 1) + '\n');
      return 0;
    }
    case 'cache':
      return cmdCache(rest);
    case '_keep':
      keepMain(rest);
      return new Promise<number>(() => {}); // the keeper ends the process itself
    case 'mcp': {
      const { serve } = await import('./mcp/server.ts');
      return serve();
    }
    case 'web': {
      const { cmdWeb } = await import('./web.ts');
      return cmdWeb(rest);
    }
    case 'version':
    case '--version':
      process.stdout.write(`${NAME} ${RUNTIME_VERSION} (node ${process.versions.node})\n`);
      return 0;
    default:
      process.stderr.write(`${USAGE}\n`);
      return 2;
  }
}
