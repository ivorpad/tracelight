/**
 * Under Node, an uncaught error that says the program was written for Bun: one line naming the
 * flag that runs it under Bun. Nothing changes the runtime by itself; a project with `bun.lock`
 * may target Node too, so the project alone only counts for a failure before the first step.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BUN_FILES = ['bun.lock', 'bun.lockb', 'bunfig.toml'];

/** `DIR (bun.lock)` for the package `file` belongs to (its nearest `package.json`) when that package uses Bun, else null */
export function bunProject(file: string): string | null {
  if (!file.startsWith('/') || file.includes('/node_modules/')) return null;
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const marker = BUN_FILES.find((f) => existsSync(join(dir, f)));
    if (marker) return `${dir} (${marker})`;
    if (existsSync(join(dir, 'package.json')) || dirname(dir) === dir) return null;
  }
}

export function bunHint(err: { errorType: string; message: string }, paths: string[], beforeFirstStep: boolean): string | undefined {
  if (process.versions.bun) return undefined;
  const fix = 'this run used Node; run it under Bun with --node bun (tracelight web: --runtime bun)';
  if (/\bBun is not defined\b|\bbun:\w|protocol 'bun:'/.test(err.message)) return `the program calls Bun APIs; ${fix}`;
  if (!beforeFirstStep) return undefined;
  for (const p of paths) {
    const project = bunProject(p);
    if (project) return `${project.replace(' (', ' is a Bun project (')}; ${fix}`;
  }
  return undefined;
}
