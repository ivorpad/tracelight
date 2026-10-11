/**
 * `compilerOptions.paths` and `baseUrl` from the nearest tsconfig.json (or jsconfig.json), so a
 * project that imports `@app/util` or `src/util` runs as `tsc` and bundlers resolve it. `extends`
 * is followed (a relative path or a package), and `paths` are relative to `baseUrl` when it is set,
 * else to the config that declares them, as TypeScript does. Looked up once per directory.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export interface PathConfig {
  /** where non-relative specifiers resolve when no pattern matches (`baseUrl`) */
  baseUrl: string | null;
  /** [pattern, targets], the targets absolute */
  paths: [string, string[]][];
  /** the patterns' base directory */
  pathsBase: string;
}

const CONFIG_NAMES = ['tsconfig.json', 'jsconfig.json'];
const byDir = new Map<string, PathConfig | null>();

/** JSON with comments and trailing commas, as tsconfig.json is written */
export function parseJsonc(text: string): any {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function readConfig(file: string, seen: Set<string>): { baseUrl?: string; paths?: Record<string, string[]>; pathsDir?: string } {
  if (seen.has(file)) return {};
  seen.add(file);
  const json = parseJsonc(readFileSync(file, 'utf8'));
  const dir = dirname(file);
  let base: { baseUrl?: string; paths?: Record<string, string[]>; pathsDir?: string } = {};
  const parents = json.extends === undefined ? [] : Array.isArray(json.extends) ? json.extends : [json.extends];
  for (const ext of parents) {
    if (typeof ext !== 'string') continue;
    const target = extendsPath(ext, dir);
    if (target) {
      const p = readConfig(target, seen);
      base = { ...base, ...p };
    }
  }
  const co = json.compilerOptions ?? {};
  if (typeof co.baseUrl === 'string') base.baseUrl = resolve(dir, co.baseUrl);
  if (co.paths && typeof co.paths === 'object') {
    base.paths = co.paths;
    base.pathsDir = dir;
  }
  return base;
}

function extendsPath(ext: string, dir: string): string | null {
  const cands = ext.startsWith('.') || isAbsolute(ext) ? [resolve(dir, ext)] : [];
  if (!cands.length) {
    try {
      cands.push(createRequire(join(dir, 'noop.js')).resolve(ext));
    } catch {
      try {
        cands.push(createRequire(join(dir, 'noop.js')).resolve(join(ext, 'tsconfig.json')));
      } catch {
        return null;
      }
    }
  }
  for (const c of cands) {
    for (const f of [c, c + '.json']) {
      try {
        if (statSync(f).isFile()) return f;
      } catch {
        /* next */
      }
    }
  }
  return null;
}

/** the path config that governs files in `dir` (null when no config sets paths or baseUrl) */
export function pathConfigFor(dir: string): PathConfig | null {
  const hit = byDir.get(dir);
  if (hit !== undefined) return hit;
  let found: PathConfig | null = null;
  const name = CONFIG_NAMES.find((n) => existsSync(join(dir, n)));
  if (name) {
    try {
      const c = readConfig(join(dir, name), new Set());
      const pathsBase = c.baseUrl ?? c.pathsDir ?? dir;
      const paths = Object.entries(c.paths ?? {})
        .filter(([, t]) => Array.isArray(t))
        .map(([p, t]) => [p, t.map((x) => resolve(pathsBase, x))] as [string, string[]]);
      if (c.baseUrl || paths.length) found = { baseUrl: c.baseUrl ?? null, paths, pathsBase };
    } catch {
      found = null; // a broken config resolves nothing
    }
    // the nearest config decides, as tsc's project lookup: no walking past it
  } else if (dirname(dir) !== dir && !dir.endsWith('node_modules')) found = pathConfigFor(dirname(dir));
  byDir.set(dir, found);
  return found;
}

/**
 * The files `specifier` may be under `cfg`, best first: the exact pattern, else the one with the
 * longest prefix (TypeScript's rule), then `baseUrl/specifier`. Unresolved: no candidates.
 */
export function pathCandidates(specifier: string, cfg: PathConfig): string[] {
  let best: { targets: string[]; star: string } | null = null;
  let bestLen = -1;
  for (const [pattern, targets] of cfg.paths) {
    const star = pattern.indexOf('*');
    if (star < 0) {
      if (pattern === specifier) {
        best = { targets, star: '' };
        break;
      }
      continue;
    }
    const pre = pattern.slice(0, star);
    const post = pattern.slice(star + 1);
    if (specifier.length >= pre.length + post.length && specifier.startsWith(pre) && specifier.endsWith(post) && pre.length > bestLen) {
      bestLen = pre.length;
      best = { targets, star: specifier.slice(pre.length, specifier.length - post.length) };
    }
  }
  const out = best ? best.targets.map((t) => t.replace('*', best!.star)) : [];
  if (cfg.baseUrl) out.push(resolve(cfg.baseUrl, specifier));
  return out;
}

/** test seam: configs are read once per directory per process */
export function clearPathConfigs(): void {
  byDir.clear();
}
