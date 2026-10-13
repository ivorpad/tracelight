/**
 * Which files a run instruments: `libraryCode` / `libraryPackages`, `exclude` and `only`
 * (docs/PROTOCOL.md "Recording limits").
 *
 * A pattern is a package name or glob (`lodash`, `@scope/*`; `lodash` also covers `lodash/fp`), or
 * a path glob, absolute or relative to the workspace root, where a directory covers what is under
 * it (`src/gen`, `lib/*.ts`); a bare file or directory name (no `/`) matches anywhere, with or
 * without its extension. `exclude` wins over `only`, with `only` just the matching files are
 * instrumented (library ones included without `libraryCode`), and neither applies to the program
 * file itself.
 */
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

/** the runtime's own files and dependencies, which load lazily during a run and are never the program's */
const RUNTIME_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const RUNTIME_DEPS = (() => { try { return realpathSync(resolve(RUNTIME_ROOT, 'node_modules')); } catch { return resolve(RUNTIME_ROOT, 'node_modules'); } })();

export const SOURCE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx']);

export type Kind = 'project' | 'library';

export interface Selection {
  root: string;
  mainPath: string;
  libraryCode: boolean;
  libraryPackages: string[];
  exclude: string[];
  only: string[];
}

function globRe(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') i++;
        re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}(?:/.*)?$`);
}

/** `{name, sub}` of a file under node_modules: the package that owns it and the path inside it */
export function packageOf(path: string): { name: string; sub: string } | null {
  const parts = path.split(sep);
  const at = parts.lastIndexOf('node_modules');
  if (at < 0 || at + 1 >= parts.length) return null;
  const scoped = parts[at + 1]!.startsWith('@');
  const nameParts = parts.slice(at + 1, at + (scoped ? 3 : 2));
  return { name: nameParts.join('/'), sub: parts.slice(at + 1 + nameParts.length).join('/') };
}

const noExt = (p: string) => p.slice(0, p.length - extname(p).length);

export function matches(pattern: string, path: string, root: string): boolean {
  const pat = pattern.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!pat) return false;
  const posix = path.split(sep).join('/');
  const pkg = packageOf(path);
  if (pkg) {
    const id = pkg.sub ? `${pkg.name}/${pkg.sub}` : pkg.name;
    if (globRe(pat).test(id) || globRe(pat).test(noExt(id))) return true;
  }
  if (!pat.includes('/')) {
    const re = globRe(pat);
    return posix.split('/').some((seg) => re.test(seg) || re.test(noExt(seg)));
  }
  const abs = isAbsolute(pat) ? resolve(pat).split(sep).join('/') : null;
  const rel = relative(root, path).split(sep).join('/');
  const re = globRe(abs ?? pat);
  const target = abs ? posix : rel;
  return re.test(target) || re.test(noExt(target));
}

export function kindOf(path: string, sel: Selection): Kind | null {
  if (!SOURCE_EXTS.has(extname(path).toLowerCase()) && path !== sel.mainPath) return null;
  if (path === sel.mainPath) return 'project';
  if (path.startsWith(RUNTIME_ROOT + sep)) return null;
  if (path.startsWith(RUNTIME_DEPS + sep)) return null;
  const library = path.split(sep).includes('node_modules');
  const inProject = path.startsWith(sel.root + sep) || path.startsWith(resolve(sel.mainPath, '..') + sep);
  if (sel.exclude.some((p) => matches(p, path, sel.root))) return null;
  if (sel.only.length) return sel.only.some((p) => matches(p, path, sel.root)) ? (library ? 'library' : 'project') : null;
  if (!library && !inProject) return null;
  if (!library) return 'project';
  if (!sel.libraryCode) return null;
  if (sel.libraryPackages.length && !sel.libraryPackages.some((p) => matches(p, path, sel.root))) return null;
  return 'library';
}
