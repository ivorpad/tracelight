/**
 * What the failing statement needed from the value, read from the exception's type and message, as
 * Pyokka's `origin/need.py` does for Python's. JavaScript's errors are V8's: `Cannot read
 * properties of undefined (reading 'price')`, `x.toFixed is not a function`, `xs is not iterable`.
 * A missing object key or array index gives `undefined` instead of raising, so a need of kind
 * `key` or `index` is made by the pick (`pick.ts`) when the undefined came from one.
 */
import { pyRepr } from '../argparse.ts';
import { Entries, NUMERIC, TypedList, UNKNOWN, parse, typeOf } from '../reprs.ts';

/** what a `for…of`, a spread or a destructuring array pattern can read */
export const ITERABLE = new Set(['string', 'Array', 'Map', 'Set', 'Arguments', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array']);

/** `'port'` for a string key (Python's `%r`), `3` for a number */
export function keyRepr(key: unknown): string {
  return typeof key === 'string' ? pyRepr(key) : String(key);
}

/** `a string`, `an array`, `an object`, `undefined`: a type as a noun phrase */
export function typePhrase(t: string | null | undefined): string {
  if (!t) return 'a value';
  if (t === 'undefined' || t === 'null') return t;
  if (t === 'Object') return 'an object';
  if (t === 'Array') return 'an array';
  return (/^[aeiouAEIOU]/.test(t) ? 'an ' : 'a ') + t;
}

/** `object` for a plain object, else the type's own name (`Map`, `User`) */
export function containerNoun(t: string | null | undefined): string {
  return !t || t === 'Object' ? 'object' : t === 'Array' ? 'array' : t;
}

function cut(text: string | null | undefined): boolean {
  return String(text ?? '').includes('…(+');
}

export interface NeedInit {
  bad?: string | null;
  fits?: string | null;
  key?: unknown;
  index?: number | null;
  attr?: string | null;
  expr?: string | null;
  container?: string | null;
}

export class Need {
  kind: string; // "type", "key", "index"
  bad: string | null;
  fitsType: string | null;
  key: unknown;
  index: number | null;
  attr: string | null;
  /** the expression the message names (`item.price.toFixed` of `… is not a function`) */
  expr: string | null;
  /** the type of the container a key was missing from (`Object`, `Map`) */
  container: string | null;

  constructor(kind: string, init: NeedInit = {}) {
    this.kind = kind;
    this.bad = init.bad ?? null;
    this.fitsType = init.fits ?? null;
    this.key = init.key;
    this.index = init.index ?? null;
    this.attr = init.attr ?? null;
    this.expr = init.expr ?? null;
    this.container = init.container ?? null;
  }

  describe(): string {
    if (this.kind === 'type') {
      if (this.fitsType === 'number') return 'a number';
      if (this.fitsType === 'iterable') return 'an iterable';
      if (this.fitsType) return typePhrase(this.fitsType);
      return `a value that is not ${typePhrase(this.bad)}`;
    }
    if (this.kind === 'key') return `${typePhrase(this.container ?? 'Object')} with key ${keyRepr(this.key)}`;
    if (this.kind === 'index') return `an array longer than ${this.index ?? 0}`;
    return '';
  }

  typeFits(t: string | null): boolean | null {
    if (t === null) return null;
    if (this.fitsType === 'number') return NUMERIC.has(t);
    if (this.fitsType === 'iterable') return ITERABLE.has(t);
    if (this.fitsType) return t === this.fitsType;
    return t !== this.bad;
  }

  /** whether a recorded value would have done; null when its text does not tell */
  fits(text: string | null | undefined): boolean | null {
    if (text === null || text === undefined) return null;
    if (this.kind === 'type') return this.typeFits(typeOf(text));
    if (this.kind === 'key') {
      const value = parse(text);
      if (!(value instanceof Entries)) return value === UNKNOWN ? null : false;
      return hasKey(value, this.key) ? true : cut(text) ? null : false;
    }
    if (this.kind === 'index') {
      const value = parse(text);
      const items = value instanceof TypedList ? value.items : value;
      if (!(Array.isArray(items) || typeof items === 'string') || cut(text)) return null;
      return items.length > Number(this.index ?? 0);
    }
    return null;
  }
}

export function hasKey(value: Entries, key: unknown): boolean {
  return value.entries.has(key as string | number) || value.entries.has(String(key)) || (typeof key === 'string' && /^\d+$/.test(key) && value.entries.has(Number(key)));
}

const NOT_ITERABLE_SUFFIX = / \(cannot read property Symbol\(Symbol\.iterator\)\)$/;

/** the type a V8 message names for a value: `undefined`, `null` (`object null` in some) */
function namedBad(text: string): string | null {
  const t = text.replace(/^object /, '');
  return t === 'undefined' || t === 'null' ? t : null;
}

/** `Need` for the errors origin reads; null for the rest */
export function needFromError(errorType: string, message: string): Need | null {
  if (errorType !== 'TypeError') return null;
  const msg = message.trim();
  let m = /^Cannot (?:read|set) propert(?:y|ies) of (undefined|null)(?: \((?:reading|setting) '(.*)'\))?$/.exec(msg);
  if (m) return new Need('type', { bad: m[1]!, attr: m[2] ?? null });
  m = /^Cannot (?:read|set) property '(.*)' of (undefined|null)$/.exec(msg);
  if (m) return new Need('type', { bad: m[2]!, attr: m[1]! });
  m = /^Cannot destructure property '.*' of '(.*)' as it is (undefined|null)\.?$/.exec(msg);
  if (m) return new Need('type', { bad: m[2]!, expr: namedBad(m[1]!) ? null : m[1]! });
  m = /^Cannot destructure '(.*)' as it is (undefined|null)\.?$/.exec(msg);
  if (m) return new Need('type', { bad: m[2]!, expr: namedBad(m[1]!) ? null : m[1]! });
  m = /^(.+) is not a (function|constructor)$/.exec(msg);
  if (m) {
    const bad = namedBad(m[1]!);
    return bad ? new Need('type', { bad, fits: 'function' }) : new Need('type', { fits: 'function', expr: m[1]! });
  }
  m = /^(.+) is not iterable$/.exec(msg.replace(NOT_ITERABLE_SUFFIX, ''));
  if (m) {
    const bad = namedBad(m[1]!);
    return bad ? new Need('type', { bad, fits: 'iterable' }) : new Need('type', { fits: 'iterable', expr: m[1]! });
  }
  m = /^Cannot use 'in' operator to search for '.*' in (undefined|null)$/.exec(msg);
  if (m) return new Need('type', { bad: m[1]! });
  m = /\b(undefined|null)\b/.exec(msg);
  if (m) return new Need('type', { bad: m[1]! });
  return null;
}
