/**
 * `config.plugins`: modules named by path (`./mock.mjs`, absolute) or package name, resolved from
 * the file's directory, then the workspace root, then the runtime. Each may export, all optional,
 * all called with the raw `config` and the plugin API (execute.ts):
 *
 * - `before(config, api)`: once per runner process, in the runner, before the first run that uses it.
 * - `beforeEach(config, api)` (or `before_each`): in the run child, after the runtime's load hook is
 *   registered (a hook the plugin registers runs before it) and before the main file is imported.
 *   It may return a promise; the run waits for it.
 * - `after(config, api)`: in the run child once the program has finished (end of the event loop,
 *   uncaught exception or `process.exit`), before `run.finished`. A plain object it returns is
 *   merged into `run.finished`; the runtime's own fields win. It runs synchronously (a promise it
 *   returns is reported, not awaited, since `process.exit` cannot wait).
 *
 * A hook that throws becomes a `runner.error` (`plugin NAME failed in STAGE: …`) and the run goes on.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { api } from './execute.ts';

type Obj = Record<string, any>;
export type Stage = 'before' | 'beforeEach' | 'after';

const RUNTIME_DIR = fileURLToPath(new URL('.', import.meta.url));
/** the runtime's own plugins, by short name */
export const BUILTIN: Record<string, string> = {
  http: fileURLToPath(new URL('./plugins/http.ts', import.meta.url)),
};

/**
 * `config.http` and `httpObserve` as Pyokka's protocol.py: the HTTP plugin loads for record and
 * replay, and for "off" too unless `httpObserve` is false (then it only observes). A debug run
 * that records nothing has no HTTP view to fill, so it loads nothing.
 */
export function withHttpPlugin(config: Obj, names: string[]): string[] {
  const http = config.http === 'record' || config.http === 'replay' ? config.http : 'off';
  const observe = config.httpObserve !== false;
  if (config.debug && config.record === false) return names;
  if ((http !== 'off' || observe) && !names.includes('http') && !names.includes(BUILTIN.http!)) return [...names, 'http'];
  return names;
}

export function resolvePlugin(name: string, dirs: string[]): string {
  if (BUILTIN[name]) return BUILTIN[name]!;
  if (name.startsWith('file:')) return fileURLToPath(name);
  if (isAbsolute(name)) return name;
  if (name.startsWith('.')) {
    for (const d of dirs) {
      const p = resolve(d, name);
      if (existsSync(p)) return p;
    }
    throw new Error(`cannot find ${name} from ${dirs.join(', ')}`);
  }
  for (const d of [...dirs, RUNTIME_DIR]) {
    try {
      return createRequire(join(d, 'noop.js')).resolve(name);
    } catch {
      /* try the next directory */
    }
  }
  throw new Error(`cannot find package ${name}`);
}

export interface Loaded {
  name: string;
  mod: Obj;
}

export async function loadPlugins(names: string[], dirs: string[], report: (msg: string) => void, stage = 'load'): Promise<Loaded[]> {
  const out: Loaded[] = [];
  for (const name of names) {
    try {
      const mod = await import(pathToFileURL(resolvePlugin(name, dirs)).href);
      out.push({ name, mod });
    } catch (e) {
      report(failure(name, stage, e));
    }
  }
  return out;
}

export function failure(name: string, stage: string, e: unknown): string {
  const err = e as Error;
  return `plugin ${name} failed in ${stage}: ${err?.name ?? 'Error'}: ${err?.message ?? String(e)}`;
}

function hook(mod: Obj, stage: Stage): ((config: Obj, a: typeof api) => unknown) | undefined {
  const m = mod.default && typeof mod.default === 'object' ? { ...mod.default, ...mod } : mod;
  const fn = stage === 'beforeEach' ? (m.beforeEach ?? m.before_each) : m[stage];
  return typeof fn === 'function' ? fn : undefined;
}

/** run one stage over the loaded plugins; `after` collects the objects they return */
export async function runStage(plugins: Loaded[], stage: 'before' | 'beforeEach', config: Obj, report: (msg: string) => void): Promise<void> {
  for (const p of plugins) {
    const fn = hook(p.mod, stage);
    if (!fn) continue;
    try {
      await fn(config, api);
    } catch (e) {
      report(failure(p.name, stage, e));
    }
  }
}

export function runAfter(plugins: Loaded[], config: Obj, report: (msg: string) => void): Obj {
  const merged: Obj = {};
  for (const p of plugins) {
    const fn = hook(p.mod, 'after');
    if (!fn) continue;
    try {
      const out = fn(config, api);
      if (out && typeof (out as any).then === 'function') {
        (out as Promise<unknown>).catch(() => {});
        report(`plugin ${p.name} failed in after: after must return synchronously (it returned a promise)`);
      } else if (out && typeof out === 'object' && !Array.isArray(out)) Object.assign(merged, out);
    } catch (e) {
      report(failure(p.name, 'after', e));
    }
  }
  return merged;
}
