/**
 * Wire constants and event builders shared by the runner and the run child.
 * The contract is docs/PROTOCOL.md; docs/tracelight/PROTOCOL-JS.md lists where Tracelight differs.
 */

export const RUNTIME_VERSION = '0.1.0';
export const PROTOCOL_VERSION = '1';

/** What `ready.capabilities` advertises. `capabilities[0]` is how run children are made. */
/** The runtime's working name: the CLI command, the cache and temp file names. Rename here. */
export const NAME = 'tracelight';
/** The prefix of its environment variables (`${ENV}CACHE_DIR`, `KEEP_DIR`, `RAW_TRANSFER`). */
export const ENV = 'TRACELIGHT_';

export const CAPABILITIES = ['spawn', 'expand', 'source', 'bindings', 'markers', 'logpoints', 'partialTrace', 'recordLocals', 'plugins', 'libraryCode', 'profile', 'snaps', 'module', 'typescript', 'jsx', 'esm', 'cjs', 'evaluate', 'shadow', 'watch', 'complete', 'exec', 'debug', 'record', 'recordFrom'];

export const COV_NOT_RUN = 0;
export const COV_COVERED = 1;
export const COV_PARTIAL = 2;
export const COV_ERROR_SOURCE = 3;
export const COV_ERROR_PATH = 4;
export const COV_IGNORED = 5;

export const FLAG_LOG = 1;
export const FLAG_ERROR = 2;
export const FLAG_SCOPE_ENTRY = 4;
export const FLAG_NO_CODE_MAPPING = 8;
export const FLAG_UNWINDING = 16;

export const KIND_VALUE = 'value';
export const KIND_TIME = 'time';
export const KIND_AUTO_EXPAND = 'autoExpand';
export const KIND_TIME_AUTO_EXPAND = 'timeAutoExpand';

/** [startLine (1-based), startCol (0-based), endLine, endCol] */
export type Range = [number, number, number, number];

export interface Limits {
  depth: number;
  elements: number;
  stringLength: number;
}

export interface RunConfig {
  logLimit: number;
  maxConsoleMessages: number;
  maxLogEntrySize: number;
  maxTraceSteps: number;
  timeoutMs: number;
  recordLocals: boolean;
  autoLog: boolean;
  maxValueChars: number | null;
  inline: Limits;
  values: Limits;
  autoExpand: Limits;
  hints: { ignoreCoverage: string; ignoreCoverageForFile: string };
  secrets: { mask: boolean; names: string[] };
  resolveGetters: boolean;
  libraryCode: boolean;
  libraryPackages: string[];
  exclude: string[];
  only: string[];
  /** record inside `worker_threads` too (threads/); `workers: false` runs them as they are */
  workers: boolean;
}

type Obj = Record<string, any>;

function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

function limits(raw: Obj | undefined, d: Limits): Limits {
  return { depth: num(raw?.depth, d.depth), elements: num(raw?.elements, d.elements), stringLength: num(raw?.stringLength, d.stringLength) };
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map(String) : [];
}

/** The run request's `config`, with the protocol's defaults for anything missing. */
export function runConfig(raw: Obj | undefined): RunConfig {
  const c = raw ?? {};
  const ll = c.logLimits ?? {};
  return {
    logLimit: num(c.logLimit, 100),
    maxConsoleMessages: num(c.maxConsoleMessages, 1000),
    maxLogEntrySize: num(c.maxLogEntrySize, 16384),
    maxTraceSteps: num(c.maxTraceSteps, 999999),
    timeoutMs: num(c.timeoutMs, 30000),
    recordLocals: !!c.recordLocals,
    autoLog: !!c.autoLog,
    maxValueChars: typeof c.maxValueChars === 'number' ? c.maxValueChars : null,
    inline: limits(ll.inline, { depth: 5, elements: 5000, stringLength: 8192 }),
    values: limits(ll.values?.default, { depth: 3, elements: 100, stringLength: 8192 }),
    autoExpand: limits(ll.values?.autoExpand, { depth: 10, elements: 5000, stringLength: 8192 }),
    hints: {
      ignoreCoverage: c.hints?.ignoreCoverage ?? 'ignore coverage|istanbul ignore|c8 ignore',
      ignoreCoverageForFile: c.hints?.ignoreCoverageForFile ?? 'ignore file coverage',
    },
    secrets: { mask: c.secrets?.mask !== false, names: Array.isArray(c.secrets?.names) ? c.secrets.names : [] },
    resolveGetters: !!c.resolveGetters,
    libraryCode: !!c.libraryCode,
    libraryPackages: strings(c.libraryPackages),
    exclude: strings(c.exclude),
    only: strings(c.only),
    workers: c.workers !== false,
  };
}

/** base64 of an Int32Array of [rid, scopeId, depth, flags] quads (little-endian, as the host decodes it). */
export function encodeSteps(steps: Int32Array): string {
  return Buffer.from(steps.buffer, steps.byteOffset, steps.byteLength).toString('base64');
}

export function decodeSteps(b64: string): Int32Array {
  const buf = Buffer.from(b64, 'base64');
  const out = new Int32Array(buf.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt32LE(i * 4);
  return out;
}
