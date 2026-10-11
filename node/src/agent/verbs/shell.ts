/**
 * `shell --live`: many verbs over one bridge connection.
 *
 * It reads one command line per stdin line, keeps the live connection open and prints every result
 * the way the one-shot verb would (a blank line after each, or one JSON line with `--json`), so a
 * long session of stops costs the answers and nothing else. The words of a line are the one-shot
 * words without `--live`. `watch` is refused (it streams until Ctrl-C and would block the loop);
 * `exit`, `quit` or EOF end the shell.
 */
import { createInterface } from 'node:readline';
import { NAME } from '../../protocol.ts';
import { ArgError, HelpRequested, UnrecognizedArguments, pyRepr } from '../argparse.ts';
import { fixLivePositionals, getVerb, parserFor, pyDumps, registerVerb, renderVerb, verbNames, type Args } from '../commands.ts';
import { openLive } from '../live.ts';
import { annotateCut } from '../recording.ts';
import { redact } from '../redact.ts';
import { AgentError, type RunSource } from '../source.ts';
import { debugLiveArg } from './debugger.ts';

type Msg = Record<string, any>;

export const LINE_HINT = 'one command per line, the words of the one-shot command without --live; `exit` ends the shell';

/** where the shell's lines come from: stdin, or what a test hands it */
export const shellInput: { lines: () => AsyncIterable<string> } = {
  lines: () => createInterface({ input: process.stdin, crlfDelay: Infinity }),
};

/** `shlex.split`: POSIX words, quotes and backslashes; throws on an unbalanced quote */
export function shlexSplit(text: string): string[] {
  const words: string[] = [];
  let cur = '';
  let inWord = false;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && i + 1 < text.length && '\\"$`\n'.includes(text[i + 1]!)) cur += text[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === '\\') {
      if (i + 1 >= text.length) throw new Error('No escaped character');
      cur += text[++i];
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) words.push(cur);
      cur = '';
      inWord = false;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (quote) throw new Error('No closing quotation');
  if (inWord) words.push(cur);
  return words;
}

/** the line's arguments, live like the shell itself; null when the line only printed help */
function prepare(words: string[], jsonMode: boolean, out: (t: string) => void): Args | null {
  const verb = getVerb(words[0]!);
  if (!verb) {
    if (words[0]!.startsWith('-')) throw new AgentError('the following arguments are required: command', LINE_HINT);
    throw new AgentError(`argument command: invalid choice: ${pyRepr(words[0]!)} (choose from ${verbNames().map((n) => pyRepr(n)).join(', ')})`, LINE_HINT);
  }
  let args: Args;
  try {
    args = parserFor(verb).parse(words.slice(1));
  } catch (e) {
    if (e instanceof HelpRequested) {
      out(e.message);
      return null;
    }
    if (e instanceof ArgError || e instanceof UnrecognizedArguments) throw new AgentError(e.message, LINE_HINT);
    throw e;
  }
  args.command = verb.name;
  if (args.session) throw new AgentError('the shell already has a session', `start a second \`${NAME} shell --live --session NAME\` for another one`);
  if (verb.name === 'watch') throw new AgentError('watch streams every stop until Ctrl-C, so it would block the shell', `run \`${NAME} watch --live\` in another terminal`);
  if (verb.name === 'shell') throw new AgentError('the shell is already running', LINE_HINT);
  args.live = true; // a --live on the line is accepted and ignored: every line is live
  if (jsonMode) args.json = true;
  fixLivePositionals(args);
  if (args.run !== null && args.run !== undefined) throw new AgentError(`the shell reads the live session, not ${args.run}`, `leave the file out; \`${NAME} ${args.command} ${args.run} ...\` reads the saved run in its own process`);
  return args;
}

function writeError(e: AgentError, out: (t: string) => void, err: (t: string) => void, asJson: boolean): void {
  if (asJson) {
    out(pyDumps(e.toJson()) + '\n');
    return;
  }
  err(`error: ${redact(e.message)}\n`);
  if (e.hint) err(`${redact(e.hint)}\n`);
}

/** read the lines and answer each over `source`; 0 on `exit`, `quit` or EOF */
export async function runShell(args: Args, source: RunSource, out: (t: string) => void, err: (t: string) => void): Promise<number> {
  const jsonMode = !!args.json;
  for await (const line of shellInput.lines()) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    let asJson = jsonMode;
    let words: string[];
    try {
      words = shlexSplit(text);
    } catch (e) {
      writeError(new AgentError(`cannot read the line: ${(e as Error).message}`, 'quote as a shell does: `eval \'payload["x"]\'`'), out, err, asJson);
      continue;
    }
    if (!words.length) continue;
    if (words[0] === 'exit' || words[0] === 'quit') return 0;
    let lineArgs: Args | null;
    let result: Msg;
    try {
      lineArgs = prepare(words, jsonMode, out);
      if (lineArgs === null) {
        if (!asJson) out('\n');
        continue;
      }
      asJson = !!lineArgs.json;
      const verb = getVerb(lineArgs.command)!;
      if (!verb.run) throw new AgentError(`${verb.name} has no answer in the shell`, LINE_HINT);
      result = await verb.run(source, lineArgs);
    } catch (e) {
      if (!(e instanceof AgentError)) throw e;
      writeError(e, out, err, asJson);
      continue;
    }
    if (asJson) out(pyDumps(annotateCut(result)) + '\n');
    else out(renderVerb(getVerb(lineArgs.command)!, result, source, lineArgs) + '\n');
  }
  return 0;
}

registerVerb({
  name: 'shell',
  help: '--live: read one command per stdin line, the same words as the one-shot commands without --live, over one bridge connection; each result prints as the one-shot command would, a blank line after it; --json prints one JSON line per result',
  common: 'none',
  configure: debugLiveArg,
  open(args) {
    args.live = true; // the shell has no saved-run form, so `shell` and `shell --session demo.ts` are live
    fixLivePositionals(args);
    return openLive(args);
  },
  stream: (source, args, out, err) => runShell(args, source, out, err),
});
