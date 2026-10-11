/**
 * Reading a recorded value back from its text, as Pyokka's `agent/reprs.py` does for Python's
 * `repr`: the type it names and, when it is a literal, the value.
 *
 * A Tracelight recording keeps values as `util.inspect` text (`serialize.ts`: one line, depth 2, at
 * most 20 array items), cut to a budget (`'abc…'…(+69 chars)`), with `[Object]` / `[Array]` for a
 * level the serializer did not open and `User { name: 'ann' }` for an instance. `tracelight origin`
 * needs the type, to say where a value's type stops fitting, and the elements, to follow
 * `items[0].price` into an array of objects. Both are best effort: a cut text parses up to the
 * cut (its complete top-level elements), and what did not parse is `UNKNOWN`.
 *
 * Type names are JavaScript's: `string`, `number`, `bigint`, `boolean`, `null`, `undefined`,
 * `symbol`, `function`, `Array`, `Object`, `Map`, `Set`, or the constructor's name.
 */
import { inspect } from 'node:util';

const CUT = /…\(\+[\d,]+ chars\)$/;
const NUMBER = /^-?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;
const CTOR = /^([A-Za-z_$][\w$]*)(?:\s*\(\d+\))?\s*[{[]/;
export const NUMERIC = new Set(['number', 'bigint']);

class Unknown {
  toString(): string {
    return 'UNKNOWN';
  }
}

/** a part of a value the text does not show (cut off, or a level the serializer left closed) */
export const UNKNOWN: unknown = Object.freeze(new Unknown());

/** an object the text shows only by its type (`[Function: f]`, `Promise { <pending> }`, a Date) */
export class Opaque {
  readonly type: string;
  constructor(type: string) {
    this.type = type;
  }
  toString(): string {
    return `<${this.type} object>`;
  }
}

/** an object, a Map, a Set or an instance the text shows with its entries */
export class Entries {
  readonly type: string;
  readonly entries: Map<string | number, unknown>;
  constructor(type: string, entries: Map<string | number, unknown>) {
    this.type = type;
    this.entries = entries;
  }
}

/** a typed array or an Array subclass: its constructor's name and its elements */
export class TypedList {
  readonly type: string;
  readonly items: unknown[];
  constructor(type: string, items: unknown[]) {
    this.type = type;
    this.items = items;
  }
}

function stripRef(t: string): string {
  return t.replace(/^<ref \*\d+>\s*/, '');
}

/** the type a recorded text names: `string` for `'a'`, `number` for `49.9`, `User` for `User { … }` */
export function typeOf(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  const t = stripRef(String(text).trim().replace(CUT, '').trim());
  if (!t) return null;
  if (t[0] === "'" || t[0] === '"' || t[0] === '`') return 'string';
  if (t === 'null') return 'null';
  if (t === 'undefined') return 'undefined';
  if (t === 'true' || t === 'false') return 'boolean';
  if (t === 'NaN' || t === 'Infinity' || t === '-Infinity') return 'number';
  if (/^-?\d[\d_]*n$/.test(t)) return 'bigint';
  if (NUMBER.test(t) && /\d/.test(t)) return 'number';
  if (/^Symbol\(/.test(t)) return 'symbol';
  if (/^\[(?:Async)?(?:Generator)?Function\b|^\[class /.test(t)) return 'function';
  if (/^\[Object: null prototype\]/.test(t)) return 'Object';
  const boxed = /^\[(Number|String|Boolean|BigInt|Symbol): /.exec(t);
  if (boxed) return boxed[1]!;
  if (t[0] === '[') return 'Array';
  if (t[0] === '{') return 'Object';
  if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(t) || t === 'Invalid Date') return 'Date';
  const err = /^([A-Z][\w$]*(?:Error|Exception))\b/.exec(t);
  if (err) return err[1]!;
  const m = CTOR.exec(t);
  if (m) return m[1]!;
  if (/^\/.*\/[a-z]*$/.test(t)) return 'RegExp';
  return null;
}

/** the type name of a value `parse` returned; null for a part the text did not show */
export function typeOfValue(value: unknown): string | null {
  if (value === UNKNOWN) return null;
  if (value instanceof Opaque || value instanceof Entries || value instanceof TypedList) return value.type;
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'Array';
  return typeof value;
}

class Cut extends Error {}
class Bad extends Error {}

class Reader {
  readonly t: string;
  i = 0;
  constructor(t: string) {
    this.t = t;
  }

  ws(): void {
    while (this.i < this.t.length && /\s/.test(this.t[this.i]!)) this.i++;
  }

  peek(s: string): boolean {
    return this.t.startsWith(s, this.i);
  }

  eof(): never {
    throw new Cut();
  }

  need(): void {
    if (this.i >= this.t.length) this.eof();
  }

  string(): string {
    const q = this.t[this.i++]!;
    let out = '';
    for (;;) {
      this.need();
      const c = this.t[this.i++]!;
      if (c === q) break;
      if (c !== '\\') {
        out += c;
        continue;
      }
      this.need();
      const e = this.t[this.i++]!;
      const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' };
      if (e in simple) out += simple[e];
      else if (e === 'x') {
        out += String.fromCharCode(parseInt(this.t.slice(this.i, this.i + 2), 16));
        this.i += 2;
      } else if (e === 'u') {
        if (this.t[this.i] === '{') {
          const end = this.t.indexOf('}', this.i);
          if (end < 0) this.eof();
          out += String.fromCodePoint(parseInt(this.t.slice(this.i + 1, end), 16));
          this.i = end + 1;
        } else {
          out += String.fromCharCode(parseInt(this.t.slice(this.i, this.i + 4), 16));
          this.i += 4;
        }
      } else out += e;
    }
    return out;
  }

  /** `[` … `]` placeholders and boxed values: `[Object]`, `[Function: f]`, `[Getter]`, `[Circular *1]` */
  bracketWord(): unknown {
    const m = /^\[(Object|Array|Circular \*\d+|Getter|Setter|Getter\/Setter|Function(?:[^\]]*)|AsyncFunction(?:[^\]]*)|GeneratorFunction(?:[^\]]*)|AsyncGeneratorFunction(?:[^\]]*)|class [^\]]*|Number: [^\]]*|String: [^\]]*|Boolean: [^\]]*)\]/.exec(this.t.slice(this.i));
    if (!m) return null;
    this.i += m[0].length;
    const w = m[1]!;
    if (/Function|^class /.test(w)) return new Opaque('function');
    const boxed = /^(Number|String|Boolean): /.exec(w);
    if (boxed) return new Opaque(boxed[1]!);
    return UNKNOWN;
  }

  value(): unknown {
    this.ws();
    this.need();
    if (this.peek('<ref *')) {
      this.i = this.t.indexOf('>', this.i) + 1;
      this.ws();
    }
    const c = this.t[this.i]!;
    if (c === "'" || c === '"' || c === '`') {
      const s = this.string();
      if (/^\.\.\. \d+ more characters?/.test(this.t.slice(this.i).trimStart())) {
        this.ws();
        this.i += /^\.\.\. \d+ more characters?/.exec(this.t.slice(this.i))![0].length;
        return UNKNOWN;
      }
      return s;
    }
    if (c === '[') {
      if (this.peek('[Object: null prototype] ')) {
        this.i += '[Object: null prototype] '.length;
        return this.object('Object');
      }
      const w = this.bracketWord();
      if (w !== null) return w;
      return this.array();
    }
    if (c === '{') return this.object('Object');
    if (c === '<') {
      const end = this.t.indexOf('>', this.i);
      if (end < 0) this.eof();
      this.i = end + 1;
      return UNKNOWN;
    }
    const date = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/.exec(this.t.slice(this.i));
    if (date) {
      this.i += date[0].length;
      return new Opaque('Date');
    }
    const word = /^(?:-?Infinity|NaN|-?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?n?|true|false|null|undefined)(?![\w$])/.exec(this.t.slice(this.i));
    if (word) {
      this.i += word[0].length;
      const w = word[0];
      if (w === 'true') return true;
      if (w === 'false') return false;
      if (w === 'null') return null;
      if (w === 'undefined') return undefined;
      if (w.endsWith('n')) return BigInt(w.slice(0, -1));
      return Number(w.replace(/_/g, ''));
    }
    const ctor = /^([A-Za-z_$][\w$]*)(?:\s*\((\d+)\))?\s*(?=[{[])/.exec(this.t.slice(this.i));
    if (ctor) {
      this.i += ctor[0].length;
      const name = ctor[1]!;
      if (this.t[this.i] === '[') {
        const items = this.array();
        return name === 'Array' ? items : new TypedList(name, items as unknown[]);
      }
      return this.object(name);
    }
    const sym = /^Symbol\([^)]*\)/.exec(this.t.slice(this.i));
    if (sym) {
      this.i += sym[0].length;
      return new Opaque('symbol');
    }
    throw new Bad();
  }

  /** the elements of `[ … ]`: holes are undefined, `... N more items` is an unknown tail */
  array(): unknown[] {
    this.i++; // [
    const out: unknown[] = [];
    for (;;) {
      this.ws();
      this.need();
      if (this.t[this.i] === ']') {
        this.i++;
        return out;
      }
      const empty = /^<(\d+) empty items?>/.exec(this.t.slice(this.i));
      const more = /^\.\.\. \d+ more items?/.exec(this.t.slice(this.i));
      if (empty) {
        this.i += empty[0].length;
        for (let k = 0; k < Number(empty[1]); k++) out.push(undefined);
      } else if (more) {
        this.i += more[0].length;
        out.push(UNKNOWN);
      } else {
        const mark = this.i;
        try {
          const v = this.value();
          this.ws();
          if (this.t[this.i] === ':' && /^[A-Za-z_$][\w$]*$|^'/.test(this.t.slice(mark, this.i).trim())) {
            // an array's extra property (`[ 1, 2, foo: 3 ]`): not an element
            this.i++;
            this.value();
          } else out.push(v);
        } catch (e) {
          if (e instanceof Cut) (e as Cut & { partial?: unknown[] }).partial = out;
          throw e;
        }
      }
      this.ws();
      if (this.i >= this.t.length) {
        // cut right after an element: one that does not end in a closer may itself be shortened (`4` of `42`)
        if (!/['"`\])}>]$/.test(this.t)) out.pop();
        throw Object.assign(new Cut(), { partial: out });
      }
      if (this.t[this.i] === ',') this.i++;
      else if (this.t[this.i] !== ']') throw new Bad();
    }
  }

  key(): string | number {
    this.ws();
    this.need();
    const c = this.t[this.i]!;
    if (c === "'" || c === '"' || c === '`') return this.string();
    if (c === '[') {
      const end = this.t.indexOf(']', this.i);
      if (end < 0) this.eof();
      const k = this.t.slice(this.i + 1, end);
      this.i = end + 1;
      return k;
    }
    const m = /^[^\s:,{}[\]]+/.exec(this.t.slice(this.i));
    if (!m) throw new Bad();
    this.i += m[0].length;
    return m[0];
  }

  /** `{ a: 1 }`, `Map(1) { 'a' => 1 }`, `Set(1) { 1 }`, `User { name: 'ann' }`, `Promise { 1 }` */
  object(type: string): unknown {
    this.i++; // {
    const entries = new Map<string | number, unknown>();
    const isSet = type === 'Set' || type === 'WeakSet' || type === 'Promise';
    const isMap = type === 'Map' || type === 'WeakMap';
    let index = 0;
    for (;;) {
      this.ws();
      this.need();
      if (this.t[this.i] === '}') {
        this.i++;
        return new Entries(type, entries);
      }
      if (/^\.\.\. \d+ more items?/.test(this.t.slice(this.i))) {
        this.i += /^\.\.\. \d+ more items?/.exec(this.t.slice(this.i))![0].length;
        entries.set(`\u0000more${index++}`, UNKNOWN);
      } else {
        const before = new Set(entries.keys());
        try {
          if (isSet) entries.set(index++, this.value());
          else if (isMap) {
            const k = this.value();
            this.ws();
            if (!this.peek('=>')) this.need();
            if (!this.peek('=>')) throw new Bad();
            this.i += 2;
            entries.set(typeof k === 'number' || typeof k === 'string' ? k : String(k), this.value());
          } else {
            const k = this.key();
            this.ws();
            this.need();
            if (this.t[this.i] !== ':') throw new Bad();
            this.i++;
            entries.set(k, this.value());
          }
        } catch (e) {
          if (e instanceof Cut) (e as Cut & { partial?: unknown }).partial = new Entries(type, entries);
          throw e;
        }
        this.ws();
        // cut right after an entry: a value that does not end in a closer may itself be shortened
        if (this.i >= this.t.length && !/['"`\])}>]$/.test(this.t)) for (const k of entries.keys()) if (!before.has(k)) entries.delete(k);
      }
      this.ws();
      if (this.i >= this.t.length) throw Object.assign(new Cut(), { partial: new Entries(type, entries) });
      if (this.t[this.i] === ',') this.i++;
      else if (this.t[this.i] !== '}') throw new Bad();
    }
  }
}

/**
 * The value a recorded text shows, as JavaScript values (`Entries` for an object, a Map, a Set
 * or an instance; `TypedList` for a typed array); `UNKNOWN` for what it does not show. A cut
 * text keeps its complete top-level elements; a level the serializer left closed (`[Object]`)
 * becomes `UNKNOWN`, a function or a Date an `Opaque`.
 */
export function parse(text: string | null | undefined): unknown {
  if (text === null || text === undefined) return UNKNOWN;
  const raw = String(text).trim();
  const cut = CUT.test(raw);
  const t = raw.replace(CUT, '');
  const r = new Reader(t);
  try {
    const v = r.value();
    r.ws();
    if (r.i !== t.length) return UNKNOWN;
    if (!cut) return v;
    // the text was cut right after a whole value: its last element may be the one the cut shortened
    if (Array.isArray(v) && v.length > 1) return [...v.slice(0, -1), UNKNOWN];
    if (v instanceof Entries && v.entries.size > 1) {
      v.entries.delete([...v.entries.keys()].pop()!);
      v.entries.set('\u0000cut', UNKNOWN);
      return v;
    }
    return UNKNOWN;
  } catch (e) {
    if (e instanceof Cut && cut) {
      // every container the cut ran through set `partial` on the way out, the top-level one last:
      // only its complete elements are kept (an object cut inside would read as one without its later keys)
      const partial = (e as Cut & { partial?: unknown }).partial;
      if (Array.isArray(partial) && partial.length) return [...partial, UNKNOWN];
      if (partial instanceof Entries && partial.entries.size) {
        partial.entries.set('\u0000cut', UNKNOWN);
        return partial;
      }
    }
    return UNKNOWN;
  }
}

/** `value[p0][p1]…`; `UNKNOWN` as soon as a step does not apply. A number key indexes an array or a string */
export function project(value: unknown, path: (string | number)[]): unknown {
  let v = value;
  for (const key of path) {
    if (v === UNKNOWN) return UNKNOWN;
    if (v instanceof Entries) {
      const k = v.entries.has(key) ? key : v.entries.has(String(key)) ? String(key) : typeof key === 'string' && /^\d+$/.test(key) && v.entries.has(Number(key)) ? Number(key) : undefined;
      if (k === undefined) return v.entries.has('\u0000cut') || [...v.entries.keys()].some((x) => String(x).startsWith('\u0000more')) ? UNKNOWN : undefined;
      v = v.entries.get(k);
    } else if (Array.isArray(v) || v instanceof TypedList || typeof v === 'string') {
      const items = v instanceof TypedList ? v.items : v;
      const n = typeof key === 'number' ? key : /^\d+$/.test(String(key)) ? Number(key) : key === 'length' ? -1 : NaN;
      if (n === -1) return hasUnknown(items) ? UNKNOWN : items.length;
      if (!Number.isInteger(n) || n < 0) return UNKNOWN;
      if (n >= items.length) return Array.isArray(items) && items.includes(UNKNOWN) ? UNKNOWN : undefined;
      v = items[n];
    } else return UNKNOWN;
  }
  return v;
}

function hasUnknown(value: unknown): boolean {
  if (value === UNKNOWN || value instanceof Opaque) return true;
  if (Array.isArray(value)) return value.some(hasUnknown);
  if (typeof value === 'string') return false;
  if (value instanceof TypedList) return value.items.some(hasUnknown);
  if (value instanceof Entries) return [...value.entries.values()].some(hasUnknown);
  return false;
}

function rebuild(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rebuild);
  if (value instanceof Entries) {
    if (value.type === 'Map') return new Map([...value.entries].map(([k, v]) => [k, rebuild(v)]));
    if (value.type === 'Set') return new Set([...value.entries.values()].map(rebuild));
    const obj: Record<string, unknown> = value.type === 'Object' ? {} : new ({ [value.type]: class {} }[value.type]!)();
    for (const [k, v] of value.entries) obj[String(k)] = rebuild(v);
    return obj;
  }
  return value;
}

/** the text a value would have had in the recording; null when part of it is not known */
export function textOf(value: unknown): string | null {
  if (hasUnknown(value) || value instanceof TypedList) return null;
  return inspect(rebuild(value), { depth: 2, breakLength: Infinity, compact: true, maxArrayLength: 20, customInspect: false });
}

/** `items[0].price`: a property path as JavaScript writes it */
export function pathText(base: string, path: (string | number)[]): string {
  let out = base;
  for (const key of path) out += typeof key === 'string' ? (/^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`) : `[${key}]`;
  return out;
}
