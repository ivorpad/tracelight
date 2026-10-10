/**
 * The protocol and value constants the agent verbs read, next to the wire
 * constants this runtime already has (`../protocol.ts`, whose `decodeSteps` decodes a trace).
 */
export { COV_COVERED, COV_ERROR_PATH, COV_ERROR_SOURCE, COV_IGNORED, COV_NOT_RUN, COV_PARTIAL, FLAG_ERROR, FLAG_LOG, FLAG_NO_CODE_MAPPING, FLAG_SCOPE_ENTRY, FLAG_UNWINDING, decodeSteps } from '../protocol.ts';

export const LOG_KINDS = ['log', 'value', 'autoLog', 'autoExpand', 'time', 'logpoint', 'system', 'error'];
/** the most `locals` entries a run records; at the cap the history stops trusting "no change" */
export const MAX_LOCALS_ENTRIES = 100_000;
/** `why`: levels below the value, by default and at most; nodes one tree holds */
export const PROVENANCE_DEPTH = 5;
export const PROVENANCE_MAX_DEPTH = 8;
export const PROVENANCE_NODES = 60;
export const EXCEPTION_MODES = ['off', 'uncaught', 'raised'];
export const EXCEPTION_MODE_DEFAULT = 'uncaught';

/** characters of a logged value the recording keeps by default */
export const LOG_CHARS = 200;
export const VALUE_CHARS_CEILING = 1_000_000;

/** the text budget for one recorded value: `fallback` when unset, the ceiling for 0 or more than it */
export function valueChars(setting: unknown, fallback: number): number {
  if (setting === null || setting === undefined) return fallback;
  const n = typeof setting === 'number' ? Math.trunc(setting) : typeof setting === 'string' && /^\s*[+-]?\d+\s*$/.test(setting) ? parseInt(setting, 10) : NaN;
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0 || n > VALUE_CHARS_CEILING) return VALUE_CHARS_CEILING;
  return Math.max(32, n);
}
