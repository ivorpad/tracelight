/**
 * Bounded value snapshots in the protocol's value-node schema (docs/PROTOCOL.md "Value node").
 *
 * The node vocabulary reuses the protocol's container types so the panel renders JS values without a
 * second code path: an Array is `list`, a plain object or a Map is `dict` (with `keyRepr`), a Set is
 * `set`, a string `str`, a boolean `bool`, `null`/`undefined` are `None` with their own `value`
 * text. Anything else is an instance named by its constructor (`Date`, `Promise`, `User`).
 * `value` texts are JavaScript (`true`, `null`, `'a'`), not Python.
 *
 * Rules: own enumerable properties only; accessors are reported, never invoked; Proxies are not
 * looked through; cycles along the current path are `circular: true`; every preview is bounded.
 */
import { inspect, types } from 'node:util';
import type { Limits } from './protocol.ts';
import { MASK, secrets } from './secrets.ts';

export const LOAD_MORE_SUFFIX = ' +';
export const PREVIEW_LEN = 200;
export const LOG_CHARS = 200;
export const LOCALS_CHARS = 120;

export interface ValueNode {
  type: string;
  value?: string;
  length?: number;
  capped?: string | boolean;
  cappedProps?: boolean;
  cappedElements?: boolean;
  props?: ValueProp[];
  id: string;
  queryPath: string[];
  expressionPath?: string;
  expandable?: boolean;
  circular?: boolean;
  nan?: boolean;
  positiveInfinity?: boolean;
  negativeInfinity?: boolean;
  loadActionNode?: boolean;
  secret?: boolean;
}

export interface ValueProp extends ValueNode {
  name: string;
  keyRepr?: string;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function quote(s: string): string {
  return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + "'";
}

/** One-line preview of any value; never runs user code (no custom inspect, no getters). */
export function shortText(value: unknown, maxLen = PREVIEW_LEN, strings: 'quote' | 'raw' = 'quote'): string {
  let text: string;
  if (typeof value === 'string') text = strings === 'raw' ? value : quote(value);
  else {
    try {
      text = inspect(value, { depth: 2, breakLength: Infinity, compact: true, maxArrayLength: 20, maxStringLength: maxLen, customInspect: false, getters: getters.resolve, showProxy: !getters.resolve });
    } catch (e) {
      text = `<unserializable: ${(e as Error)?.message ?? e}>`;
    }
  }
  text = secrets.scrub(text);
  return text.length > maxLen ? text.slice(0, maxLen - 1) + '…' : text;
}

/** `value_text`: a bounded text with the full length when it was cut. */
export function cutText(text: string, max: number): { text: string; truncated?: boolean; length?: number } {
  if (max <= 0 || text.length <= max) return { text };
  return { text: `${text.slice(0, max - 1)}…(+${(text.length - max + 1).toLocaleString('en-US')} chars)`, truncated: true, length: text.length };
}

export function typeName(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  switch (typeof v) {
    case 'string':
      return 'str';
    case 'number':
    case 'bigint':
      return 'number';
    case 'boolean':
      return 'bool';
    case 'symbol':
      return 'symbol';
    case 'function':
      return /^class[\s{]/.test(Function.prototype.toString.call(v)) ? 'class' : 'function';
  }
  if (Array.isArray(v)) return 'list';
  if (v instanceof Map) return 'dict';
  if (v instanceof Set) return 'set';
  const proto = Object.getPrototypeOf(v);
  if (proto === null || proto === Object.prototype) return 'dict';
  const ctor = proto?.constructor;
  const name = typeof ctor === 'function' && typeof ctor.name === 'string' && ctor.name ? ctor.name : 'Object';
  return name;
}

export class Registry {
  readonly objects = new Map<string, unknown>();
  readonly roots = new Map<string, unknown>();
  readonly maxEntries: number;

  constructor(maxEntries = 20000) {
    this.maxEntries = maxEntries;
  }

  clear(): void {
    this.objects.clear();
    this.roots.clear();
  }

  register(id: string, obj: unknown): void {
    this.objects.set(id, obj);
    if (this.objects.size > this.maxEntries) this.objects.delete(this.objects.keys().next().value!);
  }

  resolve(valueId: string | undefined, queryPath: string[] | undefined): { obj: unknown; path: string[]; loadMore: boolean } {
    let loadMore = false;
    let id = valueId;
    if (id && id.endsWith(LOAD_MORE_SUFFIX)) {
      id = id.slice(0, -LOAD_MORE_SUFFIX.length);
      loadMore = true;
    }
    if (id && this.objects.has(id)) return { obj: this.objects.get(id), path: [...(queryPath ?? [])], loadMore };
    if (queryPath?.length) {
      const root = queryPath[0]!;
      if (!this.roots.has(root)) throw new Error(`unknown runtime key ${JSON.stringify(root)}`);
      let obj = this.roots.get(root);
      for (const seg of queryPath.slice(1)) obj = childBySegment(obj, seg);
      return { obj, path: [...queryPath], loadMore };
    }
    throw new Error(`value ${JSON.stringify(valueId)} is no longer available`);
  }
}

export function childBySegment(obj: any, segment: string): unknown {
  const name = segment.startsWith('_p_') ? segment.slice(3) : segment;
  if (obj instanceof Map) {
    for (const [k, v] of obj) if (keyName(k) === name) return v;
    throw new Error(`no key ${JSON.stringify(name)}`);
  }
  if (obj instanceof Set) return [...obj][Number(name)];
  if (obj !== null && (typeof obj === 'object' || typeof obj === 'function')) {
    const d = Object.getOwnPropertyDescriptor(obj, name);
    if (d && 'value' in d) return d.value;
    if (obj instanceof Error && name === 'stack') return obj.stack;
    if (getters.resolve) {
      const g = d?.get ? d : protoGetters(obj, new Set()).find(([k]) => k === name)?.[1];
      if (g?.get) {
        const r = callGetter(obj, g);
        if ('threw' in r) throw new Error(`${name} threw: ${(r.threw as Error)?.message ?? r.threw}`);
        return r.value;
      }
    }
    if (d) throw new Error(`${name} is an accessor; it is not invoked`);
  }
  throw new Error(`no attribute ${JSON.stringify(name)}`);
}

function keyName(k: unknown): string {
  return typeof k === 'string' ? k : shortText(k, 80);
}

function childExpr(parent: string, name: string, kind: 'index' | 'key' | 'attr' | 'mapkey', keyRepr?: string): string {
  if (!parent) return '';
  if (kind === 'index') return `${parent}[${name}]`;
  if (kind === 'mapkey') return `${parent}.get(${keyRepr ?? quote(name)})`;
  return IDENT.test(name) ? `${parent}.${name}` : `${parent}[${quote(name)}]`;
}

/**
 * `config.resolveGetters`: accessors are invoked (each in try/catch, through `invoke`, which the
 * run child points at the tracer so an instrumented getter records nothing), getters of user
 * classes up the prototype chain are listed too, and proxies are looked through. Off by default:
 * a value is then read without running a line of user code.
 */
export const getters = {
  resolve: false,
  invoke: (fn: () => unknown): unknown => fn(),
};

const isNative = (f: unknown) => typeof f === 'function' && /\{\s*\[native code\]\s*\}\s*$/.test(Function.prototype.toString.call(f));

/** getters of user prototypes (`get area()` of a class), name -> descriptor, nearest first */
function protoGetters(obj: object, own: Set<string>): [string, PropertyDescriptor][] {
  const out: [string, PropertyDescriptor][] = [];
  const seen = new Set(own);
  for (let p = Object.getPrototypeOf(obj); p && p !== Object.prototype && p !== Function.prototype; p = Object.getPrototypeOf(p)) {
    if (isNative(p.constructor)) break;
    for (const k of Object.getOwnPropertyNames(p)) {
      if (seen.has(k) || k === 'constructor') continue;
      const d = Object.getOwnPropertyDescriptor(p, k);
      if (d?.get) {
        seen.add(k);
        out.push([k, d]);
      }
    }
  }
  return out;
}

/** call an accessor's getter for `resolveGetters`: the value, or what it threw */
function callGetter(obj: object, d: PropertyDescriptor): { value?: unknown; threw?: unknown } {
  try {
    return { value: getters.invoke(() => d.get!.call(obj)) };
  } catch (e) {
    return { threw: e };
  }
}

export interface SerializeOptions {
  rootKey: string;
  hit?: number;
  registry?: Registry;
  expressionRoot?: string | null;
  expandTree?: Record<string, any> | null;
  idPrefix?: string;
}

export class Serializer {
  counter = 0;
  readonly stack: unknown[] = [];
  readonly idPrefix: string;
  readonly limits: Limits;
  readonly opts: SerializeOptions;

  constructor(limits: Limits, opts: SerializeOptions) {
    this.limits = limits;
    this.opts = opts;
    this.idPrefix = opts.idPrefix ?? `${opts.rootKey} ${opts.hit ?? 0}`;
  }

  nextId(): string {
    this.counter++;
    return `${this.idPrefix} ${this.counter}`;
  }

  root(obj: unknown, queryPath?: string[], depth?: number): ValueNode {
    const path = queryPath?.length ? [...queryPath] : [this.opts.rootKey];
    let expr = this.opts.expressionRoot ?? '';
    if (!expr && path.length > 1) expr = '$';
    this.opts.registry?.roots.set(this.opts.rootKey, obj);
    const node = this.node(obj, path, expr, depth ?? this.limits.depth, this.opts.expandTree ?? null);
    const tail = expr.replace(/[\])'" ]+$/, '').split(/[.[]/).pop() ?? '';
    if (secrets.isSecretName(tail.replace(/['"]/g, ''))) maskLeaf(node);
    return node;
  }

  leaf(type: string, value: string, path: string[], expr: string, extra?: Partial<ValueNode>): ValueNode {
    const out: ValueNode = { type, value, id: this.nextId(), queryPath: path };
    if (expr) out.expressionPath = expr;
    if (extra) Object.assign(out, extra);
    return out;
  }

  node(obj: unknown, path: string[], expr: string, depthLeft: number, tree: Record<string, any> | null): ValueNode {
    try {
      return this.inner(obj, path, expr, depthLeft, tree);
    } catch (e) {
      return this.leaf(safeTypeName(obj), `<unserializable: ${shortText((e as Error)?.message ?? e, 80, 'raw')}>`, path, expr);
    }
  }

  inner(obj: any, path: string[], expr: string, depthLeft: number, tree: Record<string, any> | null): ValueNode {
    if (obj === null) return this.leaf('None', 'null', path, expr);
    if (obj === undefined) return this.leaf('None', 'undefined', path, expr);
    switch (typeof obj) {
      case 'boolean':
        return this.leaf('bool', obj ? 'true' : 'false', path, expr);
      case 'number':
        if (Number.isNaN(obj)) return this.leaf('number', 'NaN', path, expr, { nan: true });
        if (obj === Infinity) return this.leaf('number', 'Infinity', path, expr, { positiveInfinity: true });
        if (obj === -Infinity) return this.leaf('number', '-Infinity', path, expr, { negativeInfinity: true });
        return this.leaf('number', Object.is(obj, -0) ? '-0' : String(obj), path, expr);
      case 'bigint':
        return this.leaf('number', `${obj}n`, path, expr);
      case 'string':
        return this.string(obj, path, expr);
      case 'symbol':
        return this.leaf('symbol', obj.toString(), path, expr);
      case 'function':
        return this.func(obj, path, expr);
    }
    if (this.stack.includes(obj)) return this.leaf(typeName(obj), '[Circular]', path, expr, { circular: true });
    this.stack.push(obj);
    try {
      return this.container(obj, path, expr, depthLeft, tree);
    } finally {
      this.stack.pop();
    }
  }

  string(s: string, path: string[], expr: string): ValueNode {
    const max = this.limits.stringLength;
    const text = secrets.scrub(s);
    if (max > 0 && text.length > max) {
      const node = this.leaf('str', text.slice(0, max), path, expr, { length: s.length, capped: `first ${max} chars` });
      this.opts.registry?.register(node.id, s);
      return node;
    }
    return this.leaf('str', text, path, expr, { length: s.length });
  }

  func(fn: Function, path: string[], expr: string): ValueNode {
    const t = typeName(fn);
    const name = fn.name || '(anonymous)';
    const isAsync = types.isAsyncFunction(fn);
    const isGen = types.isGeneratorFunction(fn);
    const value = t === 'class' ? `[class ${name}]` : `[${isAsync ? 'AsyncFunction' : isGen ? 'GeneratorFunction' : 'Function'}: ${name}]`;
    return this.leaf(t, value, path, expr);
  }

  container(obj: any, path: string[], expr: string, depthLeft: number, tree: Record<string, any> | null): ValueNode {
    const t = typeName(obj);
    const node: ValueNode = { type: t, id: this.nextId(), queryPath: path };
    if (expr) node.expressionPath = expr;
    this.opts.registry?.register(node.id, obj);
    let entries: { name: string; keyRepr?: string; value: unknown; kind: 'index' | 'key' | 'attr' | 'mapkey'; accessor?: string }[] | null = null;
    let length: number | undefined;
    const max = Math.max(1, this.limits.elements);
    if (types.isProxy(obj) && !getters.resolve) {
      node.value = 'Proxy {…}';
      return node;
    }
    if (Array.isArray(obj) || types.isTypedArray(obj)) {
      length = obj.length;
      entries = [];
      const n = Math.min(obj.length, max);
      for (let i = 0; i < n; i++) {
        const d = Object.getOwnPropertyDescriptor(obj, i);
        entries.push({ name: String(i), value: d && 'value' in d ? d.value : undefined, kind: 'index', accessor: d && !('value' in d) ? 'getter' : undefined });
      }
    } else if (obj instanceof Map) {
      length = obj.size;
      entries = [];
      for (const [k, v] of obj) {
        if (entries.length >= max) break;
        const keyRepr = typeof k === 'string' ? quote(k) : shortText(k, 80);
        entries.push({ name: keyName(k), keyRepr, value: v, kind: 'mapkey' });
      }
    } else if (obj instanceof Set) {
      length = obj.size;
      entries = [];
      let i = 0;
      for (const v of obj) {
        if (i >= max) break;
        entries.push({ name: String(i++), value: v, kind: 'index' });
      }
    } else if (obj instanceof Date || obj instanceof RegExp || types.isPromise(obj) || types.isBoxedPrimitive(obj) || obj instanceof WeakMap || obj instanceof WeakSet) {
      node.value = shortText(obj);
      return node;
    } else {
      const keys = Reflect.ownKeys(obj).filter((k) => typeof k === 'string' && Object.prototype.propertyIsEnumerable.call(obj, k)) as string[];
      if (obj instanceof Error) {
        for (const k of ['message', 'stack', 'cause']) if (!keys.includes(k) && Object.prototype.hasOwnProperty.call(obj, k)) keys.unshift(k);
        if (!keys.includes('name') && obj.name !== 'Error') keys.unshift('name');
      }
      length = t === 'dict' ? keys.length : undefined;
      entries = [];
      const descs: [string, PropertyDescriptor | undefined][] = keys.map((k) => [k, Object.getOwnPropertyDescriptor(obj, k) ?? (k === 'name' ? { value: obj.name } : undefined)]);
      if (getters.resolve) descs.push(...protoGetters(obj, new Set(keys)));
      for (const [k, d] of descs.slice(0, max)) {
        let accessor = d && !('value' in d) ? (d.get && d.set ? 'getter/setter' : d.get ? 'getter' : 'setter') : undefined;
        let value = d && 'value' in d ? d.value : undefined;
        if (accessor && d?.get && getters.resolve) {
          const r = callGetter(obj, d);
          if ('threw' in r) accessor = `threw ${String((r.threw as Error)?.message ?? r.threw).slice(0, 80)}`;
          else {
            accessor = undefined;
            value = r.value;
          }
        }
        entries.push({ name: k, keyRepr: t === 'dict' ? (IDENT.test(k) ? k : quote(k)) : undefined, value, kind: t === 'dict' ? 'key' : 'attr', accessor });
      }
      if (descs.length > keys.length) keys.push(...descs.slice(keys.length).map(([k]) => k));
      if (keys.length > max) node.cappedProps = true;
    }
    if (length !== undefined) node.length = length;
    node.value = shortText(obj);
    const forced = tree ?? null;
    if (depthLeft <= 0 && !forced) {
      if (entries.length || (length ?? 0) > 0) {
        node.capped = true;
        node.expandable = true;
      }
      return node;
    }
    node.props = [];
    const total = length ?? entries.length;
    for (const e of entries) {
      const seg = `_p_${e.name}`;
      const sub = forced ? (forced[seg] ?? null) : null;
      const childPath = [...path, seg];
      const cexpr = childExpr(expr, e.name, e.kind, e.keyRepr);
      let child: ValueNode;
      if (e.accessor) child = this.leaf('accessor', `[${e.accessor[0]!.toUpperCase()}${e.accessor.slice(1)}]`, childPath, cexpr);
      else if (typeof e.value === 'string' && secrets.isSecretName(e.name)) child = this.leaf('str', MASK, childPath, cexpr, { secret: true });
      else child = this.node(e.value, childPath, cexpr, sub ? Math.max(depthLeft - 1, 1) : depthLeft - 1, sub);
      const prop = child as ValueProp;
      prop.name = e.name;
      if (e.keyRepr !== undefined) prop.keyRepr = e.keyRepr;
      node.props.push(prop);
    }
    if (total > entries.length) {
      node.cappedElements = true;
      node.props.push({ name: '…', type: 'load', value: `${total - entries.length} more`, id: node.id + LOAD_MORE_SUFFIX, queryPath: path, loadActionNode: true } as ValueProp);
    }
    if (entries.length || total) node.expandable = true;
    return node;
  }
}

function safeTypeName(obj: unknown): string {
  try {
    return typeName(obj);
  } catch {
    return 'object';
  }
}

export function maskLeaf(node: ValueNode): void {
  if (node.type === 'str') {
    node.value = MASK;
    node.secret = true;
    delete node.capped;
  }
}

export function serialize(value: unknown, limits: Limits, opts: SerializeOptions): ValueNode {
  return new Serializer(limits, opts).root(value);
}
