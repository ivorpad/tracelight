/**
 * The last `debug` launch per directory, so a debugger verb with no session starts it again.
 * `debug FILE` records the launch in `last-debug.json` beside the
 * sessions directory, keyed by the directory it was run from; `break`, `continue` and `restart`
 * with no debug session start that launch again and print its first stop. Re-running a program
 * repeats its side effects, so the reply says what it re-ran, and `--no-start` refuses instead.
 * The file is the Python CLI's own, so either CLI relaunches what the other started.
 */
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { NAME } from '../protocol.ts';
import { descriptorKind, sessionsDir } from './sessions.ts';

type Msg = Record<string, any>;

/** the verbs that start the remembered launch when no debug session exists */
export const RELAUNCH_VERBS = new Set(['break', 'continue', 'restart']);

/** beside the sessions directory, never in it: everything there is read as a descriptor */
export function memoryPath(): string {
  return join(dirname(resolve(sessionsDir())), 'last-debug.json');
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function load(): Msg {
  try {
    const data = JSON.parse(readFileSync(memoryPath(), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/** record `launch` as the last one started from `cwd`; a failure to write loses only the convenience */
export function remember(launch: Msg, at: string | null, also: string[] = [], cwd?: string): void {
  const key = real(cwd || process.cwd());
  const data = load();
  data[key] = { launch, at: at ?? null, also: [...(also || [])], savedAt: Date.now() / 1000 };
  const path = memoryPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, path);
  } catch {
    /* the convenience is lost, nothing else */
  }
}

/** the launch last started from `cwd` or the nearest directory above it; null when there is none */
export function recall(cwd?: string): Msg | null {
  const here = real(cwd || process.cwd());
  let best: [number, Msg] | null = null;
  for (const [key, entry] of Object.entries(load())) {
    if (!entry || typeof entry !== 'object' || !entry.launch || typeof entry.launch !== 'object') continue;
    if (here === key || here.startsWith(key.replace(/\/+$/, '') + sep)) {
      if (best === null || key.length > best[0]) best = [key.length, entry];
    }
  }
  return best ? best[1] : null;
}

/** the `debug` command that would start `launch`, for the reply to name what it re-ran */
export function commandLine(launch: Msg, at: string | null | undefined, also: string[] | null = []): string {
  const parts = [`${NAME} debug`];
  if (launch.program) parts.push(relative(process.cwd(), String(launch.program)) || '.');
  for (const one of [at, ...(also || [])]) if (one) parts.push(`--at ${one}`);
  if (launch.recordFrom) parts.push(`--record-from ${launch.recordFrom}`);
  else if (launch.record) parts.push('--record');
  if (launch.args?.length) parts.push(`--args ${launch.args.map(String).join(' ')}`);
  return parts.join(' ');
}

export function hasDebugSession(descriptors: Msg[]): boolean {
  return descriptors.some((d) => descriptorKind(d) === 'debug');
}
