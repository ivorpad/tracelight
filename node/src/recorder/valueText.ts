/**
 * The bounded text of a recorded value (a local's change, a function's return): at most `max` characters, a cut text ending in `…(+N chars)` when the full
 * length is known and `…(cut)` when it is not, newlines escaped, secrets masked.
 *
 * Primitives and small arrays/plain objects of primitives are formatted inline (no user code runs);
 * anything else goes through util.inspect with custom inspectors and getters off, so a recorded
 * value never runs the program's own code. The caller still raises its quiet counter around this,
 * because a Proxy trap or a toString on a key can be instrumented code.
 */
import { inspect } from 'node:util';
import { MASK, secrets } from '../secrets.ts';

export const LOCALS_CHARS = 120;
export const VALUE_CHARS_CEILING = 1_000_000;

export interface ValueText {
  text: string;
  truncated?: true;
  length?: number;
}

/** The text budget for one recorded value: `fallback` when unset, the ceiling for 0 or anything past it. */
export function valueChars(setting: number | null | undefined, fallback = LOCALS_CHARS): number {
  if (setting == null || !Number.isFinite(setting)) return fallback;
  const n = Math.trunc(setting);
  return n <= 0 || n > VALUE_CHARS_CEILING ? VALUE_CHARS_CEILING : n;
}

const PLAIN_ITEMS = 16;

function quote(s: string): string {
  // util.inspect's quoting: single quotes unless the string holds one
  return inspect(s);
}

function primitive(v: unknown): string | undefined {
  switch (typeof v) {
    case 'number':
      return Object.is(v, -0) ? '-0' : String(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'undefined':
      return 'undefined';
    case 'bigint':
      return `${v}n`;
    case 'string':
      return v.length <= 200 ? quote(v) : undefined;
    case 'object':
      return v === null ? 'null' : undefined;
    default:
      return undefined;
  }
}

/** `[1, 'a']`, `{ a: 1, b: 'x' }` for small arrays / plain objects of primitives, else undefined. */
function plain(v: object): string | undefined {
  if (Array.isArray(v)) {
    if (v.length > PLAIN_ITEMS) return undefined;
    const parts: string[] = [];
    for (let i = 0; i < v.length; i++) {
      if (!(i in v)) return undefined; // holes: inspect says `<1 empty item>`
      const p = primitive(v[i]);
      if (p === undefined) return undefined;
      parts.push(p);
    }
    return parts.length ? `[ ${parts.join(', ')} ]` : '[]';
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return undefined;
  const keys = Object.keys(v);
  if (keys.length > PLAIN_ITEMS) return undefined;
  const parts: string[] = [];
  for (const k of keys) {
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (!d || !('value' in d)) return undefined; // an accessor would run code
    const p = primitive(d.value);
    if (p === undefined) return undefined;
    parts.push(`${/^[A-Za-z_$][\w$]*$/.test(k) ? k : quote(k)}: ${p}`);
  }
  if (proto === null) return parts.length ? `[Object: null prototype] { ${parts.join(', ')} }` : '[Object: null prototype] {}';
  return parts.length ? `{ ${parts.join(', ')} }` : '{}';
}

const INSPECT = {
  depth: 2,
  colors: false,
  customInspect: false,
  getters: false,
  showProxy: true,
  breakLength: Infinity,
  compact: true,
  maxArrayLength: 100,
  maxStringLength: 10_000,
  sorted: false,
} as const;

/** async_hooks bookkeeping Node stores on promises and resources while AsyncLocalStorage is active */
const ASYNC_SYMBOLS = /,? ?(?:\[)?Symbol\((?:async_id_symbol|trigger_async_id_symbol|kResourceStore)\)(?:\])?: [^,} ]*/g;

/** The full display text of a value, unbounded (the caller cuts it). Never throws. */
export function displayText(v: unknown): string {
  const p = primitive(v);
  if (p !== undefined) return p;
  if (typeof v === 'string') return quote(v);
  if (typeof v === 'object' && v !== null) {
    try {
      const t = plain(v);
      if (t !== undefined) return t;
    } catch {
      // a Proxy that throws from ownKeys: inspect shows it as a Proxy
    }
  }
  try {
    const text = inspect(v, INSPECT);
    return text.includes('Symbol(') ? text.replace(ASYNC_SYMBOLS, '').replace(/\{ \}/g, '{}') : text;
  } catch {
    try {
      return `<${Object.prototype.toString.call(v).slice(8, -1)}>`;
    } catch {
      return '<object>';
    }
  }
}

/** `text` bounded to `max` characters, with the cut marked. */
export function cutText(full: string, max: number): ValueText {
  let text = full.includes('\n') || full.includes('\r') ? full.replace(/\r\n?/g, '\n').replace(/\n/g, '\\n') : full;
  if (text.length <= max) return { text: secrets.scrub(text) };
  const shown = secrets.scrub(text.slice(0, Math.max(0, max - 1)));
  const length = text.length;
  return { text: `${shown}…(+${(length - shown.length).toLocaleString('en-US')} chars)`, truncated: true, length };
}

/** The recorded text of `name = value`: a secret-named string is the quoted mask, and a masked text keeps no length. */
export function valueText(name: string | null, value: unknown, max: number): ValueText {
  if (name !== null && typeof value === 'string' && secrets.isSecretName(name)) return { text: quote(MASK) };
  return cutText(displayText(value), max);
}
