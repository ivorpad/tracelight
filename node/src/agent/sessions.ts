/**
 * Which live session a command drives.
 *
 * The VS Code extension (`src/agent/bridge.ts`, setting `tracelight.agentAccess`) describes every
 * session it serves in the directory `../home.ts` `sessionsDir` names (`$TRACELIGHT_SESSIONS_DIR`,
 * else `$TRACELIGHT_HOME/sessions`), so a terminal finds the sessions of a window. A file may have two descriptors, the run-all session's (`kind: "run"`) and the
 * Debugger's (`kind: "debug"`); `preferKind` says which a verb wants, `pickSession` applies it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { sessionsDir } from '../home.ts';
import { NAME } from '../protocol.ts';
import { AgentError, displayPath } from './source.ts';

type Msg = Record<string, any>;

export { sessionsDir };

export const NO_SESSION = 'no live session';
export const NO_SESSION_HINT = `open the file in VS Code with tracelight.agentAccess on, or use a saved run (\`${NAME} run FILE --save run.json\`)`;

/** the verbs that drive a live program: they prefer a `kind: "debug"` descriptor */
export const DEBUG_VERBS = new Set(['debug', 'continue', 'pause', 'stop', 'restart', 'break', 'watches', 'locals', 'exec']);
/** the verbs that read a recording: they prefer a `kind: "run"` descriptor */
export const RUN_VERBS = new Set(['why', 'origin', 'var', 'story', 'walkthrough', 'graph', 'exceptions', 'http', 'values', 'find', 'steps']);
/** the verbs that fit either: a debug session when one exists, else a run */
export const EITHER_VERBS = new Set(['state', 'context', 'eval', 'expand', 'select', 'watch', 'shell']);


export function pidAlive(pid: unknown): boolean {
  const n = typeof pid === 'number' ? Math.trunc(pid) : typeof pid === 'string' && /^\s*[+-]?\d+\s*$/.test(pid) ? parseInt(pid, 10) : NaN;
  if (!Number.isFinite(n)) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** the descriptor at `path` when it is readable, complete and its extension host is alive */
export function readDescriptor(path: string): Msg | null {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const d = doc as Msg;
  if (!['socket', 'token', 'file'].every((k) => typeof d[k] === 'string' && d[k])) return null;
  if (!pidAlive(d.pid)) return null;
  return { ...d, descriptor: path };
}

/** live descriptors, newest first; dead pids and unreadable files are skipped */
export function listSessions(directory?: string | null): Msg[] {
  const dir = directory || sessionsDir();
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return [];
  }
  const out: Msg[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const d = readDescriptor(join(dir, name));
    if (d) out.push(d);
  }
  const key = (d: Msg) => String(d.started || '');
  return out.sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));
}

/** `run` or `debug`; a descriptor written by an older extension has no `kind` and is a run */
export function descriptorKind(d: Msg): 'run' | 'debug' {
  return d.kind === 'debug' ? 'debug' : 'run';
}

/** which descriptor a command wants; `step` prefers a debug session only for the moves that execute */
export function preferKind(command: string, kind: string | null = null): 'run' | 'debug' | null {
  if (command === 'step') return kind === 'into' || kind === 'over' || kind === 'out' ? 'debug' : 'run';
  if (DEBUG_VERBS.has(command)) return 'debug';
  if (RUN_VERBS.has(command)) return 'run';
  return EITHER_VERBS.has(command) ? 'debug' : null;
}

function byKind(matches: Msg[], prefer: string | null): Msg | null {
  if (prefer) {
    const same = matches.filter((d) => descriptorKind(d) === prefer);
    if (same.length === 1) return same[0]!;
    if (same.length > 1) return null;
    const other = matches.filter((d) => descriptorKind(d) !== prefer);
    // the substitution rides along, so a failed command can say which session answered
    if (other.length === 1) return { ...other[0]!, substituted: prefer };
  }
  return matches.length === 1 ? matches[0]! : null;
}

/** why this session is not the kind the verb asked for, for a failed command's hint */
export function substitutionNote(descriptor: Msg): string | null {
  const wanted = descriptor.substituted;
  const kind = descriptorKind(descriptor);
  if (!wanted || wanted === kind) return null;
  const name = descriptor.displayName || basename(String(descriptor.file));
  if (wanted === 'debug') return `no debug session here: this is the run session on ${name}. \`${NAME} debug FILE\` starts one.`;
  return `no recording here: this is the debug session on ${name}. \`${NAME} debug FILE --record\` records one.`;
}

function describe(d: Msg): string {
  return `${descriptorKind(d)} ${d.displayName || basename(String(d.file))} (pid ${d.pid ?? 'None'}, ${displayPath(String(d.file), String(d.workspace || ''))}) ${d.descriptor || ''}`;
}

export function fileMatches(d: Msg, name: string | null | undefined): boolean {
  const file = String(d.file || '');
  if (!name) return false;
  if (name === d.displayName || name === basename(file) || file.endsWith(sep + name)) return true;
  if (name.includes(sep) || name.startsWith('.')) return resolve(name) === file;
  return false;
}

/** `--session NAME|PATH`, else the session of the command's file, else the one whose workspace holds the cwd */
export function pickSession(descriptors: Msg[], opts: { session?: string | null; fileHint?: string | null; cwd?: string | null; prefer?: string | null } = {}): Msg {
  const prefer = opts.prefer ?? null;
  if (!descriptors.length) throw new AgentError(NO_SESSION, NO_SESSION_HINT);
  const listing = descriptors.slice(0, 6).map(describe).join('; ');
  if (opts.session) {
    const wanted = resolve(opts.session);
    const exact = descriptors.filter((d) => d.descriptor === wanted);
    if (exact.length) return exact[0]!;
    const matches = descriptors.filter((d) => fileMatches(d, opts.session));
    if (!matches.length) throw new AgentError(`${NO_SESSION} for ${opts.session}`, `live sessions: ${listing}`);
    const chosen = byKind(matches, prefer);
    if (chosen) return chosen;
    throw new AgentError(`${matches.length} live sessions match ${opts.session}`, 'pick one by descriptor: --session ' + matches.map((d) => d.descriptor).join(' | '));
  }
  if (opts.fileHint) {
    const matches = descriptors.filter((d) => fileMatches(d, opts.fileHint));
    if (matches.length) {
      const chosen = byKind(matches, prefer);
      if (chosen) return chosen;
      throw new AgentError(`${matches.length} live sessions on ${opts.fileHint}`, 'say which: --session ' + matches.map((d) => d.descriptor).join(' | '));
    }
  }
  const cwd = resolve(opts.cwd || process.cwd());
  const inWs = descriptors.filter((d) => d.workspace && (cwd === String(d.workspace) || cwd.startsWith(String(d.workspace).replace(/\/+$/, '') + sep)));
  const candidates = inWs.length ? inWs : descriptors;
  const chosen = byKind(candidates, prefer);
  if (chosen) return chosen;
  throw new AgentError(`${candidates.length} live sessions; say which`, `--session NAME with one of: ${candidates.slice(0, 6).map(describe).join('; ')}`);
}
