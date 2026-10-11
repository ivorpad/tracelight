/**
 * Tracelight's per-user directories, in one place.
 *
 * - `tracelightHome()`: `$TRACELIGHT_HOME`, else `~/.tracelight`. The library cache lives under it
 *   (`cache.ts`), and so do the sessions.
 * - `sessionsDir()`: where the Tracelight VS Code extension (`tracelight/`, `src/agent/bridge.ts`,
 *   setting `tracelight.agentAccess`) describes the sessions it serves: `$TRACELIGHT_SESSIONS_DIR`,
 *   else `$TRACELIGHT_HOME/sessions`. The extension resolves the same two variables
 *   (`src/util/paths.ts` in its build), so a terminal finds the sessions of a window that sees them.
 *
 * A leading `~` is expanded and an empty value counts as unset, as Pyokka's `home.py` does.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ENV, NAME } from './protocol.ts';

export const HOME_ENV = `${ENV}HOME`;
export const SESSIONS_ENV = `${ENV}SESSIONS_DIR`;

function expand(value: string): string {
  return resolve(value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value);
}

export function tracelightHome(env: NodeJS.ProcessEnv = process.env): string {
  const value = env[HOME_ENV];
  return value ? expand(value) : join(homedir(), `.${NAME}`);
}

export function sessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env[SESSIONS_ENV];
  return dir ? expand(dir) : join(tracelightHome(env), 'sessions');
}
