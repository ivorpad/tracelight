/**
 * The Debugger's verbs, live only: `debug`, `continue`, `pause`,
 * `stop`, `restart`, `break`, `watches`, `locals`, `record`, `exec`. They drive the session's
 * program at its frontier and print every stop the way `step` prints one; a saved run refuses
 * them. `debug FILE` is a cold start (`debug_start.ts`); `break`, `continue` and `restart` with no
 * debug session start the last launch from this directory again (`relaunch.ts`).
 */
import { NAME } from '../../protocol.ts';
import { pyRepr, type ArgumentParser } from '../argparse.ts';
import { fixLivePositionals, parseLine, registerVerb, type Args, type Verb } from '../commands.ts';
import { atText, buildLaunch, focusEditor, NODE_ENV, NO_FOCUS_ENV, parseAt, resolveAt, debugStart } from '../debug_start.ts';
import { DEBUG_COMMANDS, openLive, splitAt } from '../live.ts';
import { remember } from '../relaunch.ts';
import { renderStop } from '../render.ts';
import { execError, renderBreak, renderDebugExec, renderLocals, renderRecord, renderStopped, renderWatches } from '../render_debug.ts';
import { AgentError, type RunSource } from '../source.ts';

type Msg = Record<string, any>;

export const LIVE_HINT = 'debugging needs a live session (`--live`)';

/** the shared flags of a live-only verb */
export function debugLiveArg(p: ArgumentParser): void {
  p.setDefaults({ run: null });
  p.addArgument('--json', { action: 'store_true', help: 'print the raw JSON shape' });
  p.addArgument('--live', { action: 'store_true', help: 'the open VS Code session (setting tracelight.agentAccess); these commands have no saved-run form' });
  p.addArgument('--session', { metavar: 'NAME|PATH', help: 'the session\'s file name or descriptor path, when more than one is open' });
}

function entryArg(p: ArgumentParser): void {
  p.addArgument('--stop-on-entry', { dest: 'stop_on_entry', action: 'store_true', help: 'pause before the first statement even when a breakpoint is set, so break-when watches and breakpoints can be placed before anything runs' });
}

function noStartArg(p: ArgumentParser): void {
  p.addArgument('--no-start', { dest: 'no_start', action: 'store_true', help: `with no debug session, fail instead of starting the last \`${NAME} debug\` launch from this directory again` });
}

/** `debug FILE` needs no flag: a file is always live */
function isLiveDebug(args: Args): boolean {
  if (args.command === 'debug' && args.program) return true;
  return !!(args.live || args.session);
}

function parseEnv(items: unknown[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of items || []) {
    const s = String(item);
    const i = s.indexOf('=');
    if (i <= 0) throw new AgentError(`--env wants K=V, got ${pyRepr(s)}`, 'e.g. `--env PORT=8000`; repeat it for more');
    out[s.slice(0, i)] = s.slice(i + 1);
  }
  return out;
}


/** the launch `debug FILE` asks for; null when it names no file */
export function debugLaunch(args: Args): Msg | null {
  if (!args.program) return null;
  splitAt(args);
  for (const one of [args.at, ...(args.also_at || [])]) if (one) parseAt(one); // anything else is an error before anything starts
  const record = !!args.record;
  const recordFrom = args.record_from ?? null;
  if (recordFrom) parseAt(recordFrom);
  return buildLaunch({
    program: args.program ?? null,
    args: [...(args.args || [])],
    cwd: args.cwd ?? null,
    env: parseEnv(args.env || []),
    node: args.node || process.env[NODE_ENV] || null,
    stopOnEntry: !!args.stop_on_entry,
    libraryCode: !!args.library_code,
    record,
    recordFrom,
  });
}

/** `debug FILE`: the three routes, then the connection to drive */
async function openDebugStart(args: Args): Promise<RunSource> {
  const launch = debugLaunch(args)!;
  if (launch.recordFrom) {
    // the resolved text, as `--at` travels; and a pause there, since the recording starts at a pause
    launch.recordFrom = atText(resolveAt(launch.recordFrom));
    if (![args.at, ...(args.also_at || [])].includes(launch.recordFrom)) {
      if (args.at) args.also_at = [...(args.also_at || []), launch.recordFrom];
      else args.at = launch.recordFrom;
    }
  }
  let at = args.at ?? null;
  if (at) args.at = at = atText(resolveAt(at));
  const also: string[] = (args.also_at || []).map((a: string) => atText(resolveAt(a)));
  args.also_at = also;
  const [source, send, route] = await debugStart.openDebugSession(launch, [at, ...also].filter((a): a is string => !!a));
  remember(launch, at, also);
  args._route = route;
  args._launch = send;
  // the URI carries `--at`; on the other two routes the breakpoint goes over the socket first
  args._at_over_socket = !!at && route !== 'uri';
  return source;
}

/** the source of a live-only verb: refused without --live, a cold start for `debug FILE`, else the live session */
export async function openDebugVerb(args: Args): Promise<RunSource> {
  if (args.command === 'debug' || args.command === 'break') splitAt(args);
  if (DEBUG_COMMANDS.has(args.command) && !isLiveDebug(args)) throw new AgentError(`${args.command} drives the open VS Code session, not a saved run`, LIVE_HINT);
  if (args.command === 'debug' && args.program) return openDebugStart(args);
  fixLivePositionals(args);
  if (args.run !== null && args.run !== undefined) throw new AgentError(`--live reads the open VS Code session, not ${args.run}`, 'drop --live to read the saved run, or drop the file');
  return openLive(args);
}

async function setAt(source: RunSource, at: string): Promise<void> {
  const spec = resolveAt(at);
  // a function name is resolved in the runtime, so it goes over as `at`, not as a line
  if ('function' in spec) await source.breakpoints({ at: spec.function });
  else await source.breakpoints({ add: [{ file: spec.file, line: spec.line }] });
}

/** `debug`: set what the cold start or relaunch left to the socket, then read (or start) the first stop */
export async function runDebug(source: RunSource, args: Args): Promise<Msg> {
  splitAt(args);
  const launch = '_launch' in args ? args._launch : debugLaunch(args);
  const at = args.at ?? null;
  if (at && ('_at_over_socket' in args ? args._at_over_socket : launch !== null)) await setAt(source, at);
  if ((args._route ?? 'uri') !== 'uri') for (const extra of args.also_at || []) await setAt(source, extra);
  for (const spec of args._extra_breaks || []) {
    const [f, l] = parseLine(spec, 'break');
    await source.breakpoints({ add: [{ file: f, line: l }] });
  }
  const result = await source.debug({ stopOnEntry: !!args.stop_on_entry, launch });
  // a cold start paused behind the terminal: bring the window up at the stop, once
  const paused = result && typeof result === 'object' ? result.paused : null;
  if ((args._route === 'uri' || args._route === 'run') && paused && typeof paused === 'object' && !args.no_focus) focusEditor(String(paused.file || ''), paused.line || 0);
  if (args._relaunched && result && typeof result === 'object') result.relaunched = args._relaunched;
  return result;
}

/** a stop, or the verb's own text; the relaunch line first, then the stale lines */
function rendered(own: NonNullable<Verb['render']>): NonNullable<Verb['render']> {
  return (result, source, args) => [
    ...(args._relaunched ? [`no debug session was running: started the last launch from this directory again, \`${args._relaunched}\``] : []),
    ...(args._stale || []),
    ...(args.command === 'debug' ? renderStop : own)(result, source, args),
  ];
}

function live(verb: Omit<Verb, 'common' | 'open'> & { relaunches?: boolean }): void {
  const run = verb.run!;
  registerVerb({
    ...verb,
    common: 'none',
    open: openDebugVerb,
    // a relaunched `break` / `continue` / `restart` became `debug`: the first stop is its answer
    run: (source, args) => (args.command === 'debug' ? runDebug(source, args) : run(source, args)),
    render: rendered(verb.render ?? renderStop),
    ownStale: true,
  });
}

/** `break --remove`: `FILE:LINE` is a line breakpoint, a bare name the function breakpoint `--at NAME` made */
export function removeItem(spec: string): Msg {
  if (spec.includes(':')) {
    const [f, l] = parseLine(spec, 'break --remove');
    return { file: f, line: l };
  }
  if (!/^[\p{L}\p{N}]+$/u.test(spec.replace(/\./g, '').replace(/_/g, ''))) throw new AgentError(`break --remove wants FILE:LINE or a function name, got ${pyRepr(spec)}`, 'e.g. `--remove demo.ts:82`, or `--remove rrf` for what `--at rrf` set');
  return { function: spec };
}

live({
  name: 'debug',
  help: 'start the debugger on a file in VS Code and print the first stop: the first breakpoint, or the first statement when none is set. A file implies --live. With a debug session already paused it prints that pause instead of starting anything',
  configure(p) {
    p.addArgument('--no-focus', { dest: 'no_focus', action: 'store_true', help: `on a cold start, do not bring the VS Code window to the front at the first stop (also ${NO_FOCUS_ENV}=1)` });
    debugLiveArg(p);
    entryArg(p);
    p.addArgument('program', { metavar: 'FILE', nargs: '?', help: 'the JavaScript or TypeScript file to run (implies --live); omit it to debug the open session\'s file' });
    p.addArgument('--cwd', { metavar: 'DIR', help: 'working directory the program runs in (default: the file\'s directory)' });
    p.addArgument('--env', { action: 'append', default: [], metavar: 'K=V', help: 'an environment variable for the program (repeatable)' });
    p.addArgument('--node', { metavar: 'PATH', help: `the node binary to run with (default: $${NODE_ENV}, else the window's tracelight.nodePath)` });
    p.addArgument('--at', { action: 'append', metavar: 'FILE:LINE|NAME', help: 'stop here: a line, or a function name whose entry pauses; repeat it for one stop per stage (`continue` goes from one to the next). Every one is set before the program starts and shows in the Breakpoints view' });
    p.addArgument('--record', { action: 'store_true', help: 'also record the run, so the Time Machine, the Code Story and `why` open over it at every pause (slower)' });
    p.addArgument('--record-from', { dest: 'record_from', metavar: 'NAME|FILE:LINE', help: 'run at the debugger\'s speed up to here, pause, and record from this pause on: the Time Machine, `why`, `var` and `history` cover what runs after it. It is also an --at' });
    p.addArgument('--library-code', { dest: 'library_code', action: 'store_true', help: 'step into and pause inside third-party packages (node_modules) too; off by default, so a breakpoint in a library function and `step --into` on a library call both need it' });
    p.addArgument('--args', { nargs: 'remainder', default: [], metavar: '...', help: 'everything after this goes to the program (process.argv.slice(2)); must come last' });
  },
  run: runDebug,
  render: renderStop,
});

live({
  name: 'continue',
  help: '--live: resume the paused program; prints the next stop, or `finished: exit N`',
  configure(p) {
    noStartArg(p);
    debugLiveArg(p);
    p.addArgument('--no-wait', { dest: 'no_wait', action: 'store_true', help: 'answer `resumed` at once instead of waiting for the next stop (a server may not stop again for a while)' });
    const g = p.group();
    p.addArgument('--until', { metavar: 'EXPR', help: 'run until EXPR is true, then stop there (a watch that lives for this one resume)' }, g);
    p.addArgument('--to', { metavar: 'FILE:LINE', help: 'run to this line and stop there (a breakpoint that lives for this one resume)' }, g);
  },
  run(source, args) {
    const to = args.to ? parseLine(args.to, 'continue --to') : null;
    return source.continue({ noWait: !!args.no_wait, until: args.until ?? null, to });
  },
  render: renderStop,
});

live({
  name: 'pause',
  help: '--live: pause the running program at its next statement and print the stop',
  configure(p) {
    debugLiveArg(p);
    p.addArgument('--no-wait', { dest: 'no_wait', action: 'store_true', help: 'answer `pause requested` at once: a program blocked in accept() pauses only when the next request arrives' });
  },
  run: (source, args) => source.pause({ noWait: !!args.no_wait }),
  render: renderStop,
});

live({
  name: 'stop',
  help: '--live: end the debug run and leave debug mode; the session and its recording stay; prints `stopped: exit N, K steps`',
  configure: debugLiveArg,
  run: (source) => source.stop(),
  render: renderStopped,
});

live({
  name: 'restart',
  help: '--live: stop the debug run and start it again; prints the first stop like `debug`',
  configure(p) {
    noStartArg(p);
    debugLiveArg(p);
    entryArg(p);
  },
  run: (source, args) => source.restart({ stopOnEntry: !!args.stop_on_entry }),
  render: renderStop,
});

live({
  name: 'break',
  help: '--live: breakpoints: list them; FILE:LINE adds one (--when EXPR: only when true there); --remove FILE:LINE; --on-exception sets where an exception pauses the run',
  configure(p) {
    noStartArg(p);
    debugLiveArg(p);
    p.addArgument('positions', { nargs: '*', metavar: 'FILE:LINE', help: 'add a breakpoint here (a function\'s first line pauses at every call; a blank line moves to the next statement)' });
    p.addArgument('--when', { metavar: 'EXPR', help: 'only pause when EXPR is true there (applies to the FILE:LINE given)' });
    p.addArgument('--at', { action: 'append', metavar: 'NAME|FILE:LINE', help: 'break at a function\'s entry by name (`--at rrf`, `--at Ranker.rank`), repeatable; the runtime resolves it, so a module imported later gets it too' });
    p.addArgument('--remove', { action: 'append', default: [], metavar: 'FILE:LINE|NAME', help: 'remove this breakpoint (repeatable): FILE:LINE for a line, NAME for the function breakpoint `--at NAME` set' });
    p.addArgument('--list', { action: 'store_true', help: 'list the breakpoints (the default with nothing else)' });
    p.addArgument('--on-exception', { dest: 'on_exception', choices: ['off', 'uncaught', 'raised'], default: null, help: 'when the debugger pauses on an exception: uncaught (the default) stops where an exception nobody caught was thrown, raised stops at every throw in your code, off never' });
  },
  async run(source, args) {
    splitAt(args);
    const add = (args.positions || []).map((spec: string) => {
      const [f, l] = parseLine(spec, 'break');
      return { file: f, line: l, ...(args.when ? { condition: args.when } : {}) };
    });
    if (args.when && !add.length) throw new AgentError('--when needs a FILE:LINE to apply to', 'e.g. `break --live demo.ts:12 --when \'payload === null\'`');
    const remove = (args.remove || []).map(removeItem);
    for (const extra of args.also_at || []) await source.breakpoints({ at: extra });
    return source.breakpoints({ add, remove, exceptions: args.on_exception ?? null, at: args.at ?? null });
  },
  render: renderBreak,
});

live({
  name: 'watches',
  help: '--live: watch expressions: --add EXPR shows its value at every stop in the panel; with --break-when change|true it pauses the run instead; --remove ID; list',
  configure(p) {
    debugLiveArg(p);
    p.addArgument('--add', { action: 'append', default: [], metavar: 'EXPR', help: 'add a watch expression (repeatable): displayed at every stop, or pausing with --break-when' });
    p.addArgument('--break-when', { dest: 'break_when', choices: ['change', 'true'], default: null, help: 'make the added watches pause the run: on every change of the value, or when it turns true' });
    p.addArgument('--remove', { action: 'append', default: [], metavar: 'ID', help: 'remove this watch (repeatable)' });
    p.addArgument('--list', { action: 'store_true', help: 'list the watches (the default with nothing else)' });
  },
  run: (source, args) => source.watches({ add: (args.add || []).map((exp: string) => ({ exp, ...(args.break_when ? { breakWhen: args.break_when } : {}) })), remove: [...(args.remove || [])] }),
  render: renderWatches,
});

live({
  name: 'locals',
  help: '--live: the paused frame\'s variables, one `name = value` per line',
  configure(p) {
    debugLiveArg(p);
    p.addArgument('--frame', { type: 'int', default: null, metavar: 'N', help: 'which frame of the pause, innermost 0 (the stop\'s `stack` numbers them)' });
  },
  run: (source, args) => source.locals({ valueBag: !!args.json, frame: args.frame ?? null }),
  render: renderLocals,
});

live({
  name: 'record',
  help: '--live: record from the current pause on, in a run started with --record-from that has not reached that point yet; prints the pause as step 0',
  configure: debugLiveArg,
  run: (source) => source.record(),
  render: renderRecord,
});

live({
  name: 'exec',
  help: '--live: run a statement in the paused frame: an assignment, a call, an import, a block. The program sees the new value when it continues; `eval` reads without writing',
  configure(p) {
    debugLiveArg(p);
    p.addArgument('source', { metavar: 'SOURCE', help: 'the statement to run, e.g. \'rank = 3\' (quote it)' });
    p.addArgument('--frame', { type: 'int', default: null, metavar: 'N', help: 'which frame of the pause to run in, innermost 0 (the stop\'s `stack` numbers them)' });
  },
  run: (source, args) => source.exec(args.source, { frame: args.frame ?? null }),
  render: renderDebugExec,
  // a statement that raised is still a served request: the error goes on stderr, exit stays 0
  stderrLine: (result) => execError(result),
});
