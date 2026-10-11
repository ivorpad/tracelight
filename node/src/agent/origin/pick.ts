/**
 * Which value at the failing statement the exception is about, as Pyokka's `origin/pick.py`: the
 * value of the type the error names (`undefined` whose `.price` was read), the value whose method
 * is not a function, the object without the key or the array too short to have the index (both
 * give `undefined` in JavaScript, which then fails one step later).
 *
 * A callback's element parameter (`xs.map((x) => x.price)`) fans out over the array's elements,
 * as a Python comprehension's variable does over its iterable.
 */
import { parseSync } from '../../parse.ts';
import { Entries, Opaque, TypedList, UNKNOWN, parse, pathText, project, textOf, typeOfValue } from '../reprs.ts';
import { ELEMENT_CALLBACKS, headerNodes, isFunction, isReference, propertyName, unwrap, walk, type Node } from './js.ts';
import { containerNoun, hasKey, keyRepr, type Need } from './need.ts';
import { isMapGet, type Key, type OriginBuilder } from './walk.ts';

export type Hit = [string, Key[], unknown];

/** `xs.map((x) => …)`, `xs.reduce((sum, x) => …)`: the element parameter's name -> the array expression */
export function callbackTargets(roots: Node[]): Map<string, Node> {
  const out = new Map<string, Node>();
  for (const [n] of walk(roots)) {
    if (n.type !== 'CallExpression' || !n.arguments.length) continue;
    const callee = unwrap(n.callee);
    const method = callee?.type === 'MemberExpression' ? propertyName(callee) : null;
    if (method === null || !(method in ELEMENT_CALLBACKS)) continue;
    const fn = unwrap(n.arguments[0]);
    if (!isFunction(fn)) continue;
    const p = fn.params[ELEMENT_CALLBACKS[method]!];
    if (p?.type === 'Identifier') out.set(p.name, callee.object);
  }
  return out;
}

/** `[base name, path, value]` for an access chain at `step`; a callback's element parameter fans out over its array */
export function evaluate(b: OriginBuilder, nodeIn: Node, step: number, comp: Map<string, Node>, depth = 0): Hit[] {
  if (depth > 6) return [];
  const node = unwrap(nodeIn);
  if (!node) return [];
  if (node.type === 'Identifier' || node.type === 'ThisExpression') {
    const name = node.type === 'ThisExpression' ? 'this' : node.name;
    if (comp.has(name)) {
      const out: Hit[] = [];
      for (const [base, path, value] of evaluate(b, comp.get(name), step, comp, depth + 1)) {
        const items = value instanceof TypedList ? value.items : value;
        if (Array.isArray(items)) items.forEach((el, i) => out.push([base, [...path, i], el]));
      }
      return out;
    }
    if (name === 'undefined') return [];
    const found = b.value(name, step);
    if (found.text === null || found.text === undefined || ((found.step === null || found.step === undefined) && typeOfValue(parse(found.text)) === 'function')) return [];
    return [[name, [], parse(found.text)]];
  }
  if (node.type === 'MemberExpression') {
    const k = node.computed ? b.keyOf(node.property, step) : propertyName(node);
    if (k === UNKNOWN || k === null || (typeof k !== 'string' && typeof k !== 'number')) return [];
    return evaluate(b, node.object, step, comp, depth + 1).map(([base, p, v]) => [base, [...p, k], project(v, [k])]);
  }
  if (isMapGet(node) && !b.calleeScopes(step, 'get').length) {
    const k = b.keyOf(node.arguments[0], step);
    if (typeof k !== 'string' && typeof k !== 'number') return [];
    return evaluate(b, unwrap(node.callee).object, step, comp, depth + 1)
      .filter(([, , v]) => v instanceof Entries && (v.type === 'Map' || v.type === 'WeakMap'))
      .map(([base, p, v]) => [base, [...p, k], project(v, [k])]);
  }
  return [];
}

const PROTOS: Record<string, any> = { string: String.prototype, number: Number.prototype, boolean: Boolean.prototype, bigint: BigInt.prototype, Array: Array.prototype, Map: Map.prototype, Set: Set.prototype, Object: Object.prototype };

/** whether `value.m` is a function; null when the text does not tell (a class instance's methods are on its prototype) */
function methodOf(value: unknown, m: string): boolean | null {
  if (value === UNKNOWN) return null;
  if (value === null || value === undefined) return false;
  if (value instanceof Opaque) return value.type === 'function' ? typeof (Function.prototype as any)[m] === 'function' : null;
  if (value instanceof TypedList) return null;
  if (value instanceof Entries) {
    if (hasKey(value, m)) {
      const x = project(value, [m]);
      return x === UNKNOWN ? null : x instanceof Opaque && x.type === 'function';
    }
    const proto = PROTOS[value.type];
    if (!proto) return null;
    if (typeof proto[m] === 'function') return true;
    return [...value.entries.keys()].some((k) => String(k).startsWith('\u0000')) ? null : false;
  }
  const proto = PROTOS[typeOfValue(value) ?? ''];
  return proto ? typeof proto[m] === 'function' : null;
}

function parseExpression(text: string): Node | null {
  try {
    const r = parseSync('x.js', `(${text});`, { sourceType: 'module', lang: 'js' } as any);
    if (r.errors?.length) return null;
    return unwrap(r.program.body[0]?.expression) ?? null;
  } catch {
    return null;
  }
}

type Candidate = { prio: number; node: Node; base: string; path: Key[]; value: unknown; chosen: string };

/** the bad value at the failing statement: `{expr, base, path, text, chosen, source}`, or null */
export function pick(b: OriginBuilder, step: number, need: Need | null, _errorType: string): Msg | null {
  const node = b.stmt(step);
  if (node === null || need === null) return null;
  const roots = headerNodes(node);
  const comp = callbackTargets(roots);
  const candidates: Candidate[] = [];
  if (need.kind === 'type' && need.expr) {
    // the message names the expression (`item.price.toFixed is not a function`)
    const e = parseExpression(need.expr);
    if (e) {
      for (const [base, path, value] of evaluate(b, e, step, comp)) {
        if (value === UNKNOWN) continue;
        const t = typeOfValue(value);
        if (need.bad ? t === need.bad : need.typeFits(t) === false) candidates.push({ prio: 200 + path.length, node: e, base, path, value, chosen: `the ${t}` });
      }
      if (!candidates.length && need.fitsType === 'function' && e.type === 'MemberExpression' && propertyName(e) !== null) {
        const m = propertyName(e)!;
        for (const [base, path, value] of evaluate(b, e.object, step, comp)) {
          if (methodOf(value, m) !== false) continue;
          candidates.push({ prio: 100 + path.length, node: e.object, base, path, value, chosen: `the ${typeOfValue(value)} whose .${m} is not a function` });
        }
        if (candidates.length) {
          need.bad = typeOfValue(candidates[0]!.value);
          need.attr = m;
          need.fitsType = null;
        }
      } else if (candidates.length && !need.bad) need.bad = typeOfValue(candidates[0]!.value);
    }
  }
  if (!candidates.length && need.kind === 'type' && need.bad) {
    for (const [n, parent, key] of walk(roots)) {
      const access = n.type === 'MemberExpression' || n.type === 'ThisExpression' || (n.type === 'Identifier' && isReference(parent, key)) || isMapGet(n);
      if (access) {
        for (const [base, path, value] of evaluate(b, n, step, comp)) {
          if (value === UNKNOWN) continue;
          const t = typeOfValue(value);
          if (t === need.bad) candidates.push({ prio: path.length, node: n, base, path, value, chosen: `the ${t}` });
        }
      }
      if (need.attr !== null && n.type === 'MemberExpression') {
        const k = n.computed ? b.keyOf(n.property, step) : propertyName(n);
        if (k === UNKNOWN || k === null || String(k) !== need.attr) continue;
        for (const [base, path, value] of evaluate(b, n.object, step, comp)) {
          if (value !== UNKNOWN && typeOfValue(value) === need.bad) candidates.push({ prio: 100 + path.length, node: n.object, base, path, value, chosen: `the ${need.bad} whose .${need.attr} was read` });
        }
      }
    }
  }
  if (!candidates.length) return null;
  // the named expression first, then attribute reads, then the longest access path; the first in walk order among equals
  candidates.sort((x, y) => y.prio - x.prio);
  let { node: n, base, path, value, chosen } = candidates[0]!;
  if (need.kind === 'type' && need.bad === 'undefined' && path.length) {
    // `undefined` read out of an object without the key or an array too short: that container is the value
    const holder = b.value(base, step);
    const container = project(parse(holder.text), path.slice(0, -1));
    const last = path[path.length - 1]!;
    const items = container instanceof TypedList ? container.items : container;
    if (container instanceof Entries && !hasKey(container, last) && ![...container.entries.keys()].some((k) => String(k).startsWith('\u0000'))) {
      Object.assign(need, { kind: 'key', key: last, container: container.type, bad: null, attr: null, fitsType: null });
      chosen = `the ${containerNoun(container.type)} without key ${keyRepr(last)}`;
      path = path.slice(0, -1);
      value = container;
    } else if (Array.isArray(items) && typeof last === 'number' && last >= items.length && !items.includes(UNKNOWN)) {
      Object.assign(need, { kind: 'index', index: last, bad: null, attr: null, fitsType: null });
      chosen = `the array of length ${items.length} read at index ${last}`;
      path = path.slice(0, -1);
      value = container;
    }
  }
  let text = textOf(value);
  if (text === null) {
    const found = b.value(base, step);
    text = path.length ? textOf(project(parse(found.text), path)) : (found.text ?? null);
  }
  const expr = need.kind === 'type' && need.attr ? (path.length ? pathText(base, path) : b.seg(step, n)) : pathText(base, path);
  return { expr, base, path, text, chosen, source: b.seg(step, n) };
}

type Msg = Record<string, any>;
