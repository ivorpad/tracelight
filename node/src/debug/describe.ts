/**
 * A value as `{text, valueBag}` when the run child has no serializer to lend the debugger
 * (`DebugHost.describe`): a one-line bounded `util.inspect`, masked by the secret filter, and a
 * value node with no children. The core's serializer replaces it, with `expand`.
 */
import util from 'node:util';
import { MASK, secrets } from '../secrets.ts';

export interface Described {
  text: string;
  valueBag: { data: Record<string, unknown>; runtimeKey?: string };
}

export const MAX_TEXT = 120;

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'Array';
  const t = typeof value;
  if (t === 'object') return (value as object).constructor?.name ?? 'Object';
  return t;
}

/** The last name of an expression (`self.api_key` -> `api_key`), for the name-provenance rule. */
export function expressionName(expression: string): string {
  const m = expression.trim().match(/([\p{L}_$][\p{L}\p{N}_$]*)\s*(?:\]|['"]\s*\])?\s*$/u);
  return m?.[1] ?? expression;
}

export function shortRepr(value: unknown, max = MAX_TEXT): string {
  let text: string;
  try {
    text = typeof value === 'string' ? JSON.stringify(value) : util.inspect(value, { depth: 2, breakLength: Infinity, maxArrayLength: 20, maxStringLength: max, compact: true });
  } catch (e) {
    text = `<unrepresentable ${typeName(value)}: ${(e as Error)?.message ?? e}>`;
  }
  return text.length > max ? `${text.slice(0, max)}…(+${text.length - max} chars)` : text;
}

export function describeFallback(value: unknown, name: string, key: string): Described {
  const secret = (typeof value === 'string' || value instanceof Uint8Array) && secrets.isSecretName(expressionName(name));
  const text = secret ? MASK : secrets.scrub(shortRepr(value));
  const data: Record<string, unknown> = { id: key, type: typeName(value), value: text };
  if (typeof value === 'string' || Array.isArray(value)) data.length = (value as string | unknown[]).length;
  if (secret) data.secret = true;
  return { text, valueBag: { data, runtimeKey: key } };
}
