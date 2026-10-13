/**
 * The agent verbs over a run (`tracelight story`, `step`, `var`, ...): the registry, argument
 * parsing, dispatch and `--json`.
 *
 * Every verb is a module that calls `registerVerb` and is listed in `verbs.ts`; nothing here
 * names a verb. The text form of every result comes from the verb's `render` (bounded listings an
 * agent reads: `file:line`, step numbers, values inline, moves listed; never a range id, never
 * base64). `--json` prints the contract shapes raw. Errors go to stderr as `error: <what>` plus a
 * line that says what to do next; exit status 2 (`--json`: `{"ok": false, "error", "hint"}` on stdout).
 *
 * Every verb takes `RUN` (a saved run) or `--live` (the bridge of an open VS Code session, once
 * `live.ts` is ported and calls `setLiveOpener`); the replies have the same shape and go through
 * the same renderer.
 */
import { NAME } from '../protocol.ts';
import { ArgError, ArgumentParser, HelpRequested, UnrecognizedArguments, pyRepr } from './argparse.ts';
import { annotateCut, noteLine } from './recording.ts';
import { redact } from './redact.ts';
import { joinLines, staleLines } from './render.ts';
import { AgentError, SavedRun, type RunSource } from './source.ts';

type Msg = Record<string, any>;
/** the parsed arguments: argparse's namespace, plus `command` */
export type Args = Record<string, any>;

export interface Verb {
  name: string;
  /** one line for `tracelight --help` */
  help: string;
  /**
   * the arguments every verb shares, added before `configure`'s own: `run` (the default) adds
   * `RUN` (optional positional), `--json`, `--live`, `--session`; `live` the same without `RUN`
   * (a verb that only drives a live session); `none` nothing (the verb adds its own, e.g. two runs)
   */
  common?: 'run' | 'live' | 'none';
  /** the verb's own arguments, in argparse terms (`p.addArgument('--count', {type: 'int', default: 40})`) */
  configure?(p: ArgumentParser): void;
  /** open the source yourself (a pair of runs); default: `RUN` as a `SavedRun`, or `--live` */
  open?(args: Args): RunSource | Promise<RunSource>;
  /** the result: a contract shape, printed raw by `--json` and through `render` otherwise */
  run?(source: RunSource, args: Args): Msg | Promise<Msg>;
  /** the text form; the stale lines are printed before it unless `ownStale` */
  render?(result: Msg, source: RunSource, args: Args): string[];
  /** render prints the stale lines itself (`render(result, source, args)` gets them as `args._stale`) */
  ownStale?: boolean;
  exitCode?(result: Msg): number;
  /** a verb that prints as it goes (`watch`) instead of one result: write lines with `out`, return the exit code */
  stream?(source: RunSource, args: Args, out: (text: string) => void, err: (text: string) => void): Promise<number>;
  /** a line for stderr before the text form (a statement that raised in `exec`), or null */
  stderrLine?(result: Msg): string | null;
}

const VERBS = new Map<string, Verb>();

/** add a verb to `tracelight`; a module calls this at import, and `verbs.ts` imports the module */
export function registerVerb(verb: Verb): void {
  if (VERBS.has(verb.name)) throw new Error(`verb ${verb.name} registered twice`);
  VERBS.set(verb.name, verb);
}

export function verbNames(): string[] {
  return [...VERBS.keys()];
}

export function getVerb(name: string): Verb | undefined {
  return VERBS.get(name);
}

/** `RUN` and the shared flags */
export function runArg(p: ArgumentParser): void {
  p.addArgument('run', { nargs: '?', metavar: 'RUN', help: `a run.json written by \`${NAME} run FILE --save run.json\` (omit with --live)` });
  liveArg(p, false);
}

/** the shared flags without `RUN` */
export function liveArg(p: ArgumentParser, noRun = true): void {
  if (noRun) p.setDefaults({ run: null });
  p.addArgument('--json', { action: 'store_true', help: 'print the raw JSON shape' });
  p.addArgument('--live', { action: 'store_true', help: 'the open VS Code session instead of a saved run (setting tracelight.agentAccess)' });
  p.addArgument('--session', { metavar: 'NAME|PATH', help: 'with --live: the session\'s file name or descriptor path, when more than one is open' });
}

export function parserFor(verb: Verb): ArgumentParser {
  const p = new ArgumentParser(`${NAME} ${verb.name}`);
  if ((verb.common ?? 'run') === 'run') runArg(p);
  else if (verb.common === 'live') liveArg(p);
  verb.configure?.(p);
  return p;
}

/** `FILE:LINE` -> `[file, line]`; the error names the flag and gives an example */
export function parseLine(spec: string, flag = '--line'): [string, number] {
  const example = flag.startsWith('--') ? `e.g. ${flag} agent.ts:16` : `e.g. \`${flag} --live agent.ts:16\``;
  const at = spec.lastIndexOf(':');
  if (at < 0) throw new AgentError(`${flag} wants FILE:LINE, got ${pyRepr(spec)}`, example);
  const line = spec.slice(at + 1);
  if (!/^\s*[+-]?\d+(_\d+)*\s*$/.test(line)) throw new AgentError(`${flag} wants FILE:LINE, got ${pyRepr(spec)}`, example);
  return [spec.slice(0, at), parseInt(line.replace(/_/g, ''), 10)];
}

export function isLive(args: Args): boolean {
  return !!(args.live || args.session);
}

/**
 * `step --live 5 --into`: argparse handed the number to RUN; it is the step. A verb with two
 * optional words (`why --live [STEP] [NAME]`) sets `args._words` to their dests and the leading
 * number becomes the step, the next word the name; a run file among them stays RUN.
 */
export function fixLivePositionals(args: Args): void {
  const words: string[] | undefined = args._words;
  if (words) {
    let vals = [args.run, ...words.map((w) => args[w])].filter((v) => v !== null && v !== undefined).map(String);
    args.run = null;
    for (const w of words) args[w] = null;
    const files = vals.filter((w) => w.endsWith('.json') || w.includes('/'));
    if (files.length) {
      args.run = files[0];
      vals = vals.filter((w) => !files.includes(w));
    }
    if (vals.length && /^\d+$/.test(vals[0]!.replace(/^-+/, ''))) args[words[0]!] = vals.shift();
    if (vals.length && words[1]) args[words[1]] = vals.shift();
    if (vals.length) args.run = args.run || vals.shift();
    return;
  }
  const run = args.run;
  if (run !== null && run !== undefined && 'step' in args && (args.step === null || args.step === undefined) && /^\d+$/.test(String(run).replace(/^-+/, ''))) {
    args.step = parseInt(String(run), 10);
    args.run = null;
  }
}

type LiveOpener = (args: Args) => RunSource | Promise<RunSource>;
let liveOpener: LiveOpener | null = null;

/** the seam for `--live`: `live.ts` (the bridge of an open VS Code session) installs its opener here */
export function setLiveOpener(open: LiveOpener | null): void {
  liveOpener = open;
}

/** whether `--live` works here: `live.ts` installed its opener */
export function liveAvailable(): boolean {
  return liveOpener !== null;
}

/** the seam: `RUN` opens a saved run, `--live` connects to the VS Code session's bridge */
export async function openSource(verb: Verb, args: Args): Promise<RunSource> {
  if (verb.open) return verb.open(args);
  if (isLive(args)) {
    fixLivePositionals(args);
    if (args.run !== null && args.run !== undefined) throw new AgentError(`--live reads the open VS Code session, not ${args.run}`, 'drop --live to read the saved run, or drop the file');
    if (!liveOpener) throw new AgentError(`--live is not available in ${NAME} yet`, `save a run with \`${NAME} run FILE --save run.json\` and pass it instead`);
    return liveOpener(args);
  }
  if (args.run === null || args.run === undefined) throw new AgentError(`${args.command} needs a saved run, or --live for the open VS Code session`, `save one with \`${NAME} run FILE --save run.json\`, or turn on tracelight.agentAccess and add --live`);
  return new SavedRun(String(args.run));
}

/** what the step cap cut from the run(s) behind `source`: `[label, info]` per capped run; the label names the side of a diff */
export function recordingNotes(source: RunSource): [string | null, Msg][] {
  let sides: [string | null, RunSource | null][] = [[null, source]];
  if (source && 'a' in source && 'b' in source) sides = [['a', source.a?.source ?? null], ['b', source.b?.source ?? null]];
  const out: [string | null, Msg][] = [];
  for (const [label, src] of sides) {
    const info = src?.recording;
    if (info && typeof info === 'object' && info.truncated) out.push([label, info]);
  }
  return out;
}

/** Python's `json.dumps(x, ensure_ascii=False)`: one line, `", "` and `": "` separators */
export function pyDumps(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(pyDumps).join(', ') + ']';
  if (typeof value === 'object') return '{' + Object.entries(value as Msg).filter(([, v]) => v !== undefined).map(([k, v]) => `${JSON.stringify(k)}: ${pyDumps(v)}`).join(', ') + '}';
  return JSON.stringify(value) ?? 'null';
}

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

const stdio: Io = { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) };

/** the top-level usage argparse prints for words no verb took */
function topUsage(): string {
  const p = new ArgumentParser(NAME);
  p.addArgument('command', { metavar: `{serve,run,instrument,bindings,cache,mcp,web,_keep,version,${verbNames().join(',')}}`, nargs: 'parser' });
  return p.usage();
}

/** parse `argv` for `verb`; prints usage errors as argparse does. Returns the namespace, or an exit code */
export function parseVerbArgs(verb: Verb, argv: string[], io: Io = stdio): Args | number {
  const p = parserFor(verb);
  try {
    const args = p.parse(argv);
    args.command = verb.name;
    return args;
  } catch (e) {
    if (e instanceof HelpRequested) {
      io.out(e.message);
      return 0;
    }
    if (e instanceof ArgError) {
      io.err(`${e.parser.usage()}\n${e.parser.prog}: error: ${e.message}\n`);
      return 2;
    }
    if (e instanceof UnrecognizedArguments) {
      io.err(`${topUsage()}\n${NAME}: error: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
}

/** `tracelight VERB ...`: parse, open the source, run, print; 0, or 2 for an error that says what to do */
export async function dispatchVerb(name: string, argv: string[], io: Io = stdio): Promise<number> {
  const verb = VERBS.get(name);
  if (!verb) throw new Error(`unknown verb ${name}`);
  const parsed = parseVerbArgs(verb, argv, io);
  if (typeof parsed === 'number') return parsed;
  return runVerb(verb, parsed, io);
}

/** run a parsed verb (the shell reuses this per line) */
export async function runVerb(verb: Verb, args: Args, io: Io = stdio): Promise<number> {
  let source: RunSource | undefined;
  let result: Msg;
  try {
    source = await openSource(verb, args);
    try {
      if (verb.stream) return await verb.stream(source, args, io.out, io.err);
      if (!verb.run) throw new AgentError(`unknown command ${verb.name}`);
      result = await verb.run(source, args);
    } finally {
      await source.close();
    }
  } catch (e) {
    if (!(e instanceof AgentError)) throw e;
    if (args.json) io.out(pyDumps(e.toJson()) + '\n');
    else {
      io.err(`error: ${redact(e.message)}\n`);
      if (e.hint) io.err(`${redact(e.hint)}\n`);
    }
    return 2;
  }
  let notes = recordingNotes(source);
  const liveCap = result && typeof result === 'object' ? result.recording : null;
  if (!notes.length && liveCap && typeof liveCap === 'object' && liveCap.truncated && 'kept' in liveCap) notes = [[null, liveCap]]; // a live session's `state` carries it
  if (args.json) {
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      annotateCut(result);
      if (notes.length) result.recording = notes.length === 1 && notes[0]![0] === null ? notes[0]![1] : Object.fromEntries(notes.map(([label, info]) => [label, info]));
    }
    io.out(JSON.stringify(result, null, 1) + '\n');
    return verb.exitCode?.(result) ?? 0;
  }
  for (const [label, info] of notes) {
    const line = noteLine(info);
    io.out((label ? `note: ${label}: ${line.slice('note: '.length)}` : line) + '\n');
  }
  const raised = verb.stderrLine?.(result) ?? null;
  if (raised) io.err(`${redact(raised)}\n`);
  io.out(renderVerb(verb, result, source, args));
  return verb.exitCode?.(result) ?? 0;
}

/** the text form of a result: stale lines, then the verb's lines, each redacted */
export function renderVerb(verb: Verb, result: Msg, source: RunSource, args: Args): string {
  const stale = staleLines(result, source);
  const lines = verb.ownStale ? [] : [...stale];
  if (verb.ownStale) args._stale = stale;
  lines.push(...(verb.render ? verb.render(result, source, args) : [JSON.stringify(result)]));
  return joinLines(lines);
}

/** `tracelight --help`: the verbs and what each does */
export function verbsHelp(): string {
  const width = Math.max(...verbNames().map((n) => n.length), 8);
  return [...VERBS.values()].map((v) => `    ${v.name.padEnd(width)}  ${v.help}`).join('\n');
}
