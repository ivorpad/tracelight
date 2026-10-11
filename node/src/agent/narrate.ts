/**
 * Narration: one batched model call adds a sentence of gloss per walkthrough moment (never
 * automatic), as Pyokka's `agent/narrate.py`.
 *
 * The prompt is `narrate_prompt.md` (beside this file: Pyokka's template, worded for a
 * JavaScript / TypeScript program) filled with the walkthrough JSON (values redacted) and the
 * source of the user functions the moments touch. The backend is a command that reads the prompt
 * on stdin: `--command` when set, else `claude -p --output-format json` when `claude` is on the
 * PATH, else `codex exec` with its last message written to a file. The answer must be a JSON
 * object `{id: sentence}`; anything else keeps `gloss: null` and reports the error once.
 *
 * The extension's host-side twin is `src/agent/narrate.ts` (backends, parsing, prompt); this
 * runtime cannot import from the extension's `src/` at run time, so what it needs is copied here
 * and kept in step with both it and the Python module.
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { constants as osConstants, tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { NAME } from '../protocol.ts';
import { fileMap, type FileMap } from './decisions.ts';
import { redact, redactValue } from './redact.ts';
import { AgentError, displayPath, type SavedRun } from './source.ts';
import { isUserFile, squash, walkthrough } from './walkthrough.ts';

type Msg = Record<string, any>;

export const PROMPT_FILE = join(import.meta.dirname, 'narrate_prompt.md');
export const GLOSS_MAX = 140;
export const SOURCE_LINES_MAX = 200;
export const SOURCE_FUNCTIONS_MAX = 20;
export const TIMEOUT_S = 180;
export const CLAUDE_ARGS = ['-p', '--output-format', 'json', '--tools', '', '--no-session-persistence'];
export const CODEX_ARGS = ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--color', 'never', '-o'];

export class NarrationError extends Error {
  readonly hint: string | null;

  constructor(message: string, hint: string | null = null) {
    super(message);
    this.hint = hint;
  }
}

export interface Backend {
  /** claude | codex | custom */
  name: string;
  argv: string[];
  /** codex writes its last message here */
  outputFile?: string | null;
  cwd?: string | null;
}

/** Python's `shlex.split` (POSIX mode): spaces separate, quotes group, a backslash escapes */
export function shlexSplit(command: string): string[] {
  const out: string[] = [];
  let word: string | null = null;
  let i = 0;
  while (i < command.length) {
    const c = command[i]!;
    if (/\s/.test(c)) {
      if (word !== null) out.push(word);
      word = null;
      i++;
    } else if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) throw new AgentError('the narration command has an unclosed quote', 'check --command');
      word = (word ?? '') + command.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      word = word ?? '';
      i++;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === '\\' && i + 1 < command.length && '\\"$`\n'.includes(command[i + 1]!)) i++;
        word += command[i];
        i++;
      }
      if (i >= command.length) throw new AgentError('the narration command has an unclosed quote', 'check --command');
      i++;
    } else if (c === '\\') {
      word = (word ?? '') + (command[i + 1] ?? '');
      i += 2;
    } else {
      word = (word ?? '') + c;
      i++;
    }
  }
  if (word !== null) out.push(word);
  return out;
}

/** `shutil.which`: an executable of that name on the PATH */
export function onPath(name: string): boolean {
  return (process.env.PATH ?? '').split(delimiter).filter(Boolean).some((d) => {
    try {
      accessSync(join(d, name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** The command to run: the explicit one, else `claude`, else `codex`; null when neither exists. */
export function resolveBackend(command: string | null = null, which: (name: string) => boolean = onPath): Backend | null {
  if (command && command.trim()) return { name: 'custom', argv: shlexSplit(command) };
  if (which('claude')) return { name: 'claude', argv: ['claude', ...CLAUDE_ARGS] };
  if (which('codex')) {
    const out = join(mkdtempSync(join(tmpdir(), 'pyokka-narrate-')), 'last-message.md');
    return { name: 'codex', argv: ['codex', ...CODEX_ARGS, out, '-'], outputFile: out };
  }
  return null;
}

/** The model's answer text (`claude`'s `result` field, `codex`'s last message, a custom command's stdout). */
export function runBackend(backend: Backend, prompt: string, opts: { timeoutS?: number } = {}): string {
  const timeout = opts.timeoutS ?? TIMEOUT_S;
  const cwd = backend.cwd || (backend.name !== 'custom' ? mkdtempSync(join(tmpdir(), 'pyokka-narrate-')) : undefined);
  const [cmd, ...args] = backend.argv;
  if (!cmd) throw new NarrationError('empty narration command', 'pass --command a command that reads the prompt on stdin');
  const proc = spawnSync(cmd, args, { input: prompt, encoding: 'utf8', timeout: timeout * 1000, cwd, maxBuffer: 64 * 1024 * 1024 });
  // a command that exits without reading all of its stdin is not an error (Python's `communicate` ignores the broken pipe)
  if (proc.error && (proc.error as NodeJS.ErrnoException).code !== 'EPIPE') {
    const code = (proc.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new NarrationError(`${cmd} is not on the PATH`, 'install it, or set pyokka.explain.command / --command to a command that reads the prompt on stdin');
    if (code === 'ETIMEDOUT') throw new NarrationError(`${cmd} took longer than ${Math.trunc(timeout)} s`, 'try again, or a faster model in --command');
    throw new NarrationError(`${cmd} failed: ${proc.error.message}`, 'run the command by hand to see why');
  }
  // Python's returncode: the exit status, or minus the signal that ended it
  const status = proc.status ?? (proc.signal ? -(osConstants.signals[proc.signal] ?? 0) : null);
  if (status !== 0) throw new NarrationError(`${cmd} exited with ${status}: ${redact((proc.stderr || proc.stdout || '').trim().slice(-400))}`, 'run the command by hand to see why');
  if (backend.outputFile) {
    try {
      return readFileSync(backend.outputFile, 'utf8');
    } catch {
      throw new NarrationError(`${cmd} wrote no last message`, 'check `codex exec --help` for the -o flag');
    }
  }
  const text = proc.stdout || '';
  if (backend.name === 'claude') {
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      return text;
    }
    if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
      const d = doc as Msg;
      if (d.is_error) throw new NarrationError(`claude reported an error: ${redact(String(d.result || '')).slice(0, 300)}`, 'run `claude -p` by hand to see why');
      if (typeof d.result === 'string') return d.result;
    }
  }
  return text;
}

/** The first JSON object in `text` (models wrap answers in fences and prose); null when none parses. */
export function extractJsonObject(text: string): Msg | null {
  let start = text.indexOf('{');
  while (start >= 0) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try {
            const doc: unknown = JSON.parse(text.slice(start, i + 1));
            if (doc && typeof doc === 'object' && !Array.isArray(doc)) return doc as Msg;
          } catch {
            /* not this one */
          }
          break;
        }
      }
    }
    start = text.indexOf('{', start + 1);
  }
  return null;
}

/** Strict: a JSON object whose values are strings; unknown ids dropped, sentences cut at 140 chars. */
export function parseGlosses(answer: string, ids: string[]): Record<string, string> {
  const doc = extractJsonObject(answer);
  if (!doc) throw new NarrationError('the model did not answer with a JSON object (no JSON object in the answer)', `the answer started: ${redact(answer.trim().slice(0, 120))}`);
  const wanted = new Set(ids);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (!wanted.has(key)) continue;
    if (typeof value !== 'string') throw new NarrationError(`the gloss for ${key} is not a string`, 'the model must answer {id: sentence}');
    const s = squash(value);
    if (s) out[key] = [...s].length <= GLOSS_MAX ? s : [...s].slice(0, GLOSS_MAX - 1).join('') + '…';
  }
  if (!Object.keys(out).length) throw new NarrationError(`the answer glossed none of the ${ids.length} moments`, 'the keys must be the moment ids (m0, m1, …)');
  return out;
}

// -- the prompt --------------------------------------------------------------------------------------------------

export function promptTemplate(): string {
  return readFileSync(PROMPT_FILE, 'utf8');
}

export interface SourceBlock {
  file: string;
  function: string;
  line: number;
  text: string;
}

/** the code fence's language for a source block: TypeScript for `.ts` / `.tsx` / `.mts` / `.cts`, else JavaScript */
export function fenceLanguage(file: string): string {
  return /\.[cm]?tsx?$/i.test(file) ? 'typescript' : 'javascript';
}

const PROMPT_KEYS = ['id', 'step', 'kind', 'text', 'values', 'location'];

/** Fill the template: the moments (redacted) and `[{file, function, line, text}]` source blocks. */
export function buildPrompt(template: string, walk: Msg, sources: SourceBlock[]): string {
  const doc = redactValue(structuredClone({ moments: (walk.moments as Msg[]).map((m) => Object.fromEntries(Object.entries(m).filter(([k]) => PROMPT_KEYS.includes(k)))) }));
  for (const m of doc.moments) {
    const loc: Msg = m.location || {};
    m.location = { file: basename(String(loc.file || '')), line: loc.line ?? null, function: loc.function ?? null };
  }
  // source is code, but a literal typed under an innocent name must not reach a model either
  const blocks = sources.length ? sources.map((s) => `### ${s.file}: ${s.function} (line ${s.line})\n\n\`\`\`${fenceLanguage(s.file)}\n${redact(s.text)}\n\`\`\``) : ['(no user source available)'];
  return template.replace('{{walkthrough}}', () => JSON.stringify(doc, null, 1)).replace('{{sources}}', () => blocks.join('\n\n'));
}

/** The user functions the moments touch (≤ 200 lines each, ≤ 20 functions), the module first. */
export function collectSources(run: SavedRun, moments: Msg[]): SourceBlock[] {
  const main = String(run.meta.file || '');
  const seen = new Set<string>();
  const out: SourceBlock[] = [];
  const maps = new Map<number, FileMap>();
  const add = (fid: number, fn: string): void => {
    const key = `${fid}\0${fn}`;
    if (fid < 0 || seen.has(key) || out.length >= SOURCE_FUNCTIONS_MAX) return;
    const path = run.filePath(fid);
    if (!isUserFile(path, run.workspaceRoot, main)) return;
    const lines = run.sourceLines(fid);
    if (!lines.length) return;
    if (!maps.has(fid)) maps.set(fid, fileMap(lines.join('\n'), String(path)));
    let start: number;
    let end: number;
    if (fn === '<module>') {
      start = 1;
      end = Math.min(lines.length, SOURCE_LINES_MAX);
    } else {
      const span = [...maps.get(fid)!.functions.values()].find((f) => f.name === fn);
      if (!span) return;
      start = span.line;
      end = Math.min(span.end, span.line + SOURCE_LINES_MAX - 1);
    }
    seen.add(key);
    out.push({ file: displayPath(path, run.workspaceRoot), function: fn, line: start, text: lines.slice(start - 1, end).join('\n') });
  };
  for (const m of moments) {
    const loc: Msg = m.location || {};
    add(Math.trunc(Number(loc.fileId ?? -1)), String(loc.function || '<module>'));
    const callee: Msg = m.callee || {};
    if (Object.keys(callee).length) add(Math.trunc(Number(callee.fileId ?? -1)), String(callee.function || ''));
  }
  return out;
}

// -- the command -------------------------------------------------------------------------------------------------

export function narrateSaved(run: SavedRun, opts: { command?: string | null; dryRun?: boolean; backend?: Backend | null } = {}): Msg {
  const result = walkthrough(run);
  const ids: string[] = result.moments.map((m: Msg) => m.id);
  if (!ids.length) throw new AgentError('nothing to narrate: the run recorded no moments', `see \`${NAME} state\``);
  const prompt = buildPrompt(promptTemplate(), result, collectSources(run, result.moments));
  if (opts.dryRun) return { prompt, moments: ids.length };
  const backend = opts.backend ?? resolveBackend(opts.command ?? null);
  if (!backend) throw new AgentError('no narration backend: neither claude nor codex is on the PATH', "install one, or pass --command 'your-model-cli' (prompt on stdin, JSON on stdout)");
  let glosses: Record<string, string>;
  try {
    glosses = parseGlosses(runBackend(backend, prompt), ids);
  } catch (e) {
    if (e instanceof NarrationError) throw new AgentError(`narration failed: ${e.message}`, e.hint);
    throw e;
  }
  run.meta.walkthroughGloss = glosses;
  writeMeta(run);
  return { path: run.path, backend: backend.name, moments: ids.length, glossed: Object.keys(glosses).length, gloss: glosses };
}

/** the saved run again, with its meta changed: compact, through a temporary file */
export function writeMeta(run: SavedRun): void {
  const tmp = run.path + '.tmp';
  writeFileSync(tmp, JSON.stringify({ meta: run.meta, events: run.events }) + '\n', 'utf8');
  renameSync(tmp, run.path);
}
