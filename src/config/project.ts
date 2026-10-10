/**
 * "Is this file part of a project?" A project file defaults to Run on Save: its code is likely
 * to have side effects, while a scratch file wants live values as you type.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** a file's project: a package.json, a tsconfig, or a lockfile */
export const PROJECT_MARKERS = ['package.json', 'tsconfig.json', 'jsconfig.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'deno.json'];

/** True when any of `dirs` contains a project marker file. */
export function looksLikeProject(dirs: (string | undefined)[]): boolean {
  const markers = PROJECT_MARKERS;
  for (const dir of dirs) {
    if (!dir) continue;
    for (const m of markers) {
      try {
        if (fs.existsSync(path.join(dir, m))) return true;
      } catch {
        /* unreadable dir: not a project */
      }
    }
  }
  return false;
}
