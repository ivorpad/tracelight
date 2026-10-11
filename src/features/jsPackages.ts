/**
 * Module-not-found for JS/TS runs: which npm package a Node error names, which package manager the
 * project uses, the install command, and the line that imports it. vscode-free so it is unit
 * tested; `packageInstall.ts` wires it into the hover, the code action and the two commands.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** ESM: `Cannot find package 'x' imported from …`; CommonJS: `Cannot find module 'x'\nRequire stack: …`. */
const MISSING_RE = /Cannot find (?:package|module) '([^']+)'/;

/** The package a bare specifier lives in: `lodash/map.js` → `lodash`, `@scope/pkg/sub` → `@scope/pkg`. */
export function npmPackageName(specifier: string): string | undefined {
  if (/^(\.{0,2}\/|[A-Za-z]:[\\/]|[a-z][a-z0-9+.-]*:|#)/.test(specifier)) return undefined; // relative, absolute, `node:`, `file:`, subpath imports
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
  return /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(name) ? name : undefined;
}

/** The specifier and package a Node resolution error names, when it is a missing package (not a missing relative file). */
export function missingJsPackage(message: string): { specifier: string; packageName: string } | undefined {
  const m = MISSING_RE.exec(message);
  if (!m) return undefined;
  const packageName = npmPackageName(m[1]!);
  return packageName ? { specifier: m[1]!, packageName } : undefined;
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

const LOCKFILES: [string, PackageManager][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];

/**
 * The package manager of the project `dir` is in: the nearest lockfile going up, else the
 * `packageManager` field of the nearest package.json, else npm. Stops at `stopAt` (the workspace
 * folder) when given.
 */
export function packageManagerFor(dir: string, stopAt?: string, exists: (p: string) => boolean = fs.existsSync, read: (p: string) => string = (p) => fs.readFileSync(p, 'utf8')): PackageManager {
  let fromField: PackageManager | undefined;
  for (let d = path.resolve(dir); ; ) {
    for (const [file, pm] of LOCKFILES) if (exists(path.join(d, file))) return pm;
    const pkg = path.join(d, 'package.json');
    if (!fromField && exists(pkg)) {
      try {
        const field = (JSON.parse(read(pkg)) as { packageManager?: unknown }).packageManager;
        const name = typeof field === 'string' ? field.split('@')[0] : undefined;
        if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') fromField = name;
      } catch {
        /* an unreadable package.json says nothing */
      }
    }
    const up = path.dirname(d);
    if (up === d || (stopAt && path.resolve(d) === path.resolve(stopAt))) break;
    d = up;
  }
  return fromField ?? 'npm';
}

const ADD: Record<PackageManager, string> = { npm: 'npm install', pnpm: 'pnpm add', yarn: 'yarn add', bun: 'bun add' };

/**
 * The command that installs `packageName`. `pyokka.installPackageCommand` wins when set (with
 * `{packageName}`, `{target}` and `{packageManager}` filled in); a per-file install (`target`) goes
 * into a private folder with npm, whatever the project uses, and is found through `NODE_PATH`.
 */
export function buildJsInstallCommand(opts: { template: string; manager: PackageManager; packageName: string; target?: string }): string {
  const q = (s: string): string => (/[\s"']/.test(s) ? JSON.stringify(s) : s);
  if (opts.template.trim() && !opts.target) return opts.template.replace(/\{packageName\}/g, opts.packageName).replace(/\{packageManager\}/g, opts.manager).replace(/\{target\}/g, '');
  if (opts.target) return `npm install --prefix ${q(opts.target)} --no-save --no-package-lock ${opts.packageName}`;
  return `${ADD[opts.manager]} ${opts.packageName}`;
}

/** The 0-based line that imports or requires `specifier` in `text`, or -1. */
export function importLine(text: string, specifier: string): number {
  const esc = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:\\bfrom\\s*|\\bimport\\s*\\(?\\s*|\\brequire\\s*\\(\\s*)['"\`]${esc}['"\`]`);
  const lines = text.split(/\r?\n/);
  return lines.findIndex((l) => re.test(l));
}
