/**
 * The instrumentation cache for library files: `~/.tracelight/cache/`
 * (`$TRACELIGHT_HOME/cache` when that is set, `home.ts`; `TRACELIGHT_CACHE_DIR`
 * overrides both, an empty value disables the cache), keyed by runtime version, real path, mtime, size and the instrumentation options. The code is stored relocatable
 * (`instrument.ts` `relocatable`) and moved to the run's range base on load. Project files are
 * never cached. Entries not read or written for 30 days are swept when a run writes one.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InstrumentedFile } from './instrument.ts';
import { tracelightHome } from './home.ts';
import { ENV, RUNTIME_VERSION } from './protocol.ts';

const SWEEP_DAYS = 30;

export function cacheDir(): string | null {
  const env = process.env[`${ENV}CACHE_DIR`];
  if (env === '') return null;
  return env ?? join(tracelightHome(), 'cache');
}

export function cacheKey(path: string, options: Record<string, unknown>): string | null {
  try {
    const real = realpathSync(path);
    const st = statSync(real);
    return createHash('sha256').update(JSON.stringify([RUNTIME_VERSION, process.versions.node, real, st.mtimeMs, st.size, options])).digest('hex').slice(0, 40);
  } catch {
    return null;
  }
}

type Stored = Omit<InstrumentedFile, 'code' | 'exprChildren' | 'lineRids' | 'ignored' | 'functionNames' | 'localNames'> & {
  exprChildren: [number, number[]][];
  lineRids: [number, number][];
  ignored: number[];
  functionNames: [number, string][];
  localNames: [number, string[]][];
};

export function load(key: string): InstrumentedFile | null {
  const dir = cacheDir();
  if (!dir) return null;
  try {
    const meta = JSON.parse(readFileSync(join(dir, `${key}.json`), 'utf8')) as Stored;
    const code = readFileSync(join(dir, `${key}.js`), 'utf8');
    const now = new Date();
    try {
      utimesSync(join(dir, `${key}.json`), now, now);
    } catch {
      /* read-only cache: still usable */
    }
    return { ...meta, code, exprChildren: new Map(meta.exprChildren), lineRids: new Map(meta.lineRids), ignored: new Set(meta.ignored), functionNames: new Map(meta.functionNames), localNames: new Map(meta.localNames ?? []) };
  } catch {
    return null;
  }
}

export function store(key: string, info: InstrumentedFile): void {
  const dir = cacheDir();
  if (!dir || info.code === null || info.relocSlot === undefined) return;
  try {
    mkdirSync(dir, { recursive: true });
    const { code, exprChildren, lineRids, ignored, functionNames, localNames, ...rest } = info;
    const meta: Stored = { ...rest, exprChildren: [...exprChildren], lineRids: [...lineRids], ignored: [...ignored], functionNames: [...functionNames], localNames: [...(localNames ?? [])] };
    const tmp = `.${key}.${process.pid}`;
    writeFileSync(join(dir, `${tmp}.js`), code);
    writeFileSync(join(dir, `${tmp}.json`), JSON.stringify(meta));
    renameSync(join(dir, `${tmp}.js`), join(dir, `${key}.js`));
    renameSync(join(dir, `${tmp}.json`), join(dir, `${key}.json`)); // the meta last: an entry is complete when it exists
    sweep(dir);
  } catch {
    /* a cache that cannot be written only costs time */
  }
}

let swept = false;
function sweep(dir: string): void {
  if (swept) return;
  swept = true;
  const old = Date.now() - SWEEP_DAYS * 86400_000;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      if (statSync(join(dir, name)).mtimeMs < old) remove(dir, name.slice(0, -5));
    } catch {
      /* raced with another run */
    }
  }
}

function remove(dir: string, key: string): void {
  rmSync(join(dir, `${key}.json`), { force: true });
  rmSync(join(dir, `${key}.js`), { force: true });
}

export interface CacheReport {
  dir: string | null;
  entries: number;
  bytes: number;
  cleared?: number;
}

/** `tracelight cache [--clear]` */
export function report(clear = false): CacheReport {
  const dir = cacheDir();
  if (!dir) return { dir: null, entries: 0, bytes: 0 };
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return { dir, entries: 0, bytes: 0 };
  }
  let bytes = 0;
  let entries = 0;
  for (const n of names) {
    try {
      bytes += statSync(join(dir, n)).size;
    } catch {
      /* gone */
    }
    if (n.endsWith('.json') && !n.startsWith('.')) entries++;
  }
  if (!clear) return { dir, entries, bytes };
  for (const n of names) rmSync(join(dir, n), { force: true });
  return { dir, entries: 0, bytes: 0, cleared: entries };
}
