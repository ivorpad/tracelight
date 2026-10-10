/**
 * Pure config merging: VS Code settings -> ~/.tracelight/config.json -> package.json "tracelight"
 * -> .tracelight (JSON). Later sources win; nested objects are merged key by key.
 */
import type { RunConfig } from '../shared/protocol';

export type ConfigObject = Record<string, unknown>;

export const DEFAULT_RUN_CONFIG: RunConfig = {
  logLimit: 100,
  maxConsoleMessages: 1000,
  logLimits: {
    inline: { depth: 5, elements: 5000 },
    values: { default: { stringLength: 8192 }, autoExpand: { depth: 10, elements: 5000, stringLength: 8192 } },
  },
  maxLogEntrySize: 16384,
  resolveGetters: false,
  autoLog: false,
  maxTraceSteps: 999999,
  timeoutMs: 30000,
  recordLocals: false,
  libraryCode: false,
  libraryPackages: [],
  hints: { ignoreCoverage: 'ignore coverage|pragma: no cover', ignoreCoverageForFile: 'ignore file coverage' },
  plugins: [],
  secrets: { mask: true, names: [] },
  http: 'off',
  httpObserve: true,
};

function isPlainObject(v: unknown): v is ConfigObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function deepMerge(base: ConfigObject, patch: ConfigObject): ConfigObject {
  const out: ConfigObject = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const prev = out[k];
    out[k] = isPlainObject(prev) && isPlainObject(v) ? deepMerge(prev, v) : v;
  }
  return out;
}

/** Merge in order; `undefined` sources are skipped. */
export function mergeConfigSources(...sources: (ConfigObject | undefined)[]): ConfigObject {
  let acc: ConfigObject = {};
  for (const s of sources) if (s) acc = deepMerge(acc, s);
  return acc;
}

/** Keys that live in config files but are host-side (not sent to the runner). */
export interface HostSideConfig {
  runMode?: 'smart' | 'auto' | 'onSave' | 'onDemand';
  delay?: number;
  showValueOnSelection?: boolean;
  showSingleInlineValue?: boolean;
  installPackageCommand?: string;
  env?: { params?: { env?: string; args?: string } } & Record<string, unknown>;
  smartStart?: unknown;
}

export function toRunConfig(merged: ConfigObject): RunConfig {
  const m = deepMerge(DEFAULT_RUN_CONFIG as unknown as ConfigObject, merged);
  const cfg = m as unknown as RunConfig & ConfigObject;
  // runTimeout is the VS Code setting name; timeoutMs the protocol name
  if (typeof m['runTimeout'] === 'number') cfg.timeoutMs = m['runTimeout'] as number;
  const tm = isPlainObject(m['timeMachine']) ? (m['timeMachine'] as ConfigObject) : {};
  if (typeof tm['recordLocals'] === 'boolean') cfg.recordLocals = tm['recordLocals'] as boolean;
  if (typeof tm['libraryCode'] === 'boolean') cfg.libraryCode = tm['libraryCode'] as boolean;
  if (Array.isArray(tm['libraryPackages'])) cfg.libraryPackages = (tm['libraryPackages'] as unknown[]).map(String);
  if (Array.isArray(tm['exclude'])) cfg.exclude = (tm['exclude'] as unknown[]).map(String);
  const sec = isPlainObject(m['secrets']) ? (m['secrets'] as ConfigObject) : {};
  return {
    logLimit: num(cfg.logLimit, DEFAULT_RUN_CONFIG.logLimit),
    maxConsoleMessages: num(cfg.maxConsoleMessages, DEFAULT_RUN_CONFIG.maxConsoleMessages),
    logLimits: cfg.logLimits,
    maxLogEntrySize: num(cfg.maxLogEntrySize, DEFAULT_RUN_CONFIG.maxLogEntrySize),
    resolveGetters: !!cfg.resolveGetters,
    autoLog: !!cfg.autoLog,
    maxTraceSteps: num(cfg.maxTraceSteps, DEFAULT_RUN_CONFIG.maxTraceSteps),
    timeoutMs: num(cfg.timeoutMs, DEFAULT_RUN_CONFIG.timeoutMs),
    recordLocals: !!cfg.recordLocals,
    libraryCode: !!cfg.libraryCode,
    libraryPackages: Array.isArray(cfg.libraryPackages) ? cfg.libraryPackages.map(String) : [],
    ...(Array.isArray(cfg.exclude) && cfg.exclude.length ? { exclude: cfg.exclude.map(String).filter((p) => p.trim()) } : {}),
    ...(typeof cfg.maxValueChars === 'number' && Number.isFinite(cfg.maxValueChars) ? { maxValueChars: cfg.maxValueChars } : {}),
    hints: cfg.hints,
    plugins: Array.isArray(cfg.plugins) ? cfg.plugins.map(String) : [],
    secrets: { mask: typeof sec['mask'] === 'boolean' ? (sec['mask'] as boolean) : true, names: Array.isArray(sec['names']) ? (sec['names'] as unknown[]).map(String) : [] },
    http: cfg.http === 'record' || cfg.http === 'replay' ? cfg.http : 'off',
    httpObserve: typeof cfg.httpObserve === 'boolean' ? cfg.httpObserve : true,
  };
}

function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

/** Parse `A=1;B=2` (Quokka's env.params.env format) into a record. */
export function parseEnvParams(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text) return out;
  for (const part of text.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

/** Split a command line into argv (quotes respected, no shell expansion). */
export function splitArgs(text: string | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

/* ---------- minimal TOML reader for [tool.tracelight] ---------- */

/** The `"tracelight"` object of a package.json (the JS/TS projects' `[tool.tracelight]`); undefined when absent or not an object. */
export function readTracelightKeyFromPackageJson(text: string): ConfigObject | undefined {
  const pkg = JSON.parse(text) as unknown;
  const v = pkg && typeof pkg === 'object' ? (pkg as Record<string, unknown>)['tracelight'] : undefined;
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as ConfigObject) : undefined;
}
