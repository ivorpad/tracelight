/**
 * Where an element came from when its container is not followed further back.
 *
 * The recording keeps a value's text, not its identity, so this is a match by key and text over the
 * statements that put values into containers (`xs.push(v)`, `o[k] = v`, `o.k = v`, `{ k: v }`,
 * `m.set(k, v)`, `s.add(v)`); every link it makes is marked `inferred`.
 */
import { pathText } from '../reprs.ts';
import { keyRepr } from './need.ts';
import { constantKey, headerNodes, propertyName, unwrap, walk, type Node } from './js.ts';
import type { Key, OriginBuilder } from './walk.ts';

const APPENDERS = new Set(['push', 'unshift', 'add']);

/** `[kind, key, value node]`: `key` is a constant, or a node whose value is read at the step (`keyNode`) */
export type Insert = { kind: 'key' | 'item'; key: unknown; keyNode: Node | null; value: Node };

/** each place the statement at `step` puts a value into a container */
export function inserts(b: OriginBuilder, step: number): Insert[] {
  const rid = b.trace.rid(step);
  const cached = b.insertCache.get(rid);
  if (cached) return cached;
  const node = b.stmt(step);
  const out: Insert[] = [];
  if (node !== null && node.type !== 'FunctionDeclaration' && node.type !== 'ClassDeclaration' && !/Function/.test(node.type)) {
    for (const [n] of walk(headerNodes(node))) {
      if (n.type === 'ObjectExpression') {
        for (const p of n.properties) {
          if (p.type !== 'Property' || p.kind !== 'init' || p.method) continue;
          if (!p.computed && p.key.type === 'Identifier') out.push({ kind: 'key', key: p.key.name, keyNode: null, value: p.value });
          else {
            const c = constantKey(p.key);
            if (c) out.push({ kind: 'key', key: c.value, keyNode: null, value: p.value });
          }
        }
      } else if (n.type === 'AssignmentExpression' && unwrap(n.left)?.type === 'MemberExpression') {
        const t = unwrap(n.left);
        if (t.computed) out.push({ kind: 'key', key: null, keyNode: t.property, value: n.right });
        else if (propertyName(t) !== null) out.push({ kind: 'key', key: propertyName(t), keyNode: null, value: n.right });
      } else if (n.type === 'CallExpression' && unwrap(n.callee)?.type === 'MemberExpression') {
        const method = propertyName(unwrap(n.callee));
        const args = n.arguments.filter((a: Node) => a.type !== 'SpreadElement');
        if (method !== null && APPENDERS.has(method) && args.length) out.push({ kind: 'item', key: null, keyNode: null, value: args[args.length - 1] });
        else if (method === 'set' && n.arguments.length === 2) {
          const c = constantKey(n.arguments[0]);
          out.push(c ? { kind: 'key', key: c.value, keyNode: null, value: n.arguments[1] } : { kind: 'key', key: null, keyNode: n.arguments[0], value: n.arguments[1] });
        }
      }
    }
  }
  b.insertCache.set(rid, out);
  return out;
}

/** the container the value sat in is not followed further back: find the statement that put a value with this key and text into one */
export function elementSearch(b: OriginBuilder, path: Key[], before: number, carried: string | null): void {
  let at = -1;
  for (let i = path.length - 1; i >= 0; i--) {
    if (typeof path[i] === 'string') {
      at = i;
      break;
    }
  }
  const key = at >= 0 ? path[at] : null;
  const tail = at >= 0 ? path.slice(at + 1) : [];
  if (carried === null) {
    b.end = `the value sits at ${pathText('…', path)} in a container the recording does not follow further`;
    return;
  }
  const found: [number, Node][] = [];
  for (let j = Math.min(before, b.trace.count) - 1; j >= 0; j--) {
    for (const ins of inserts(b, j)) {
      if (key !== null) {
        if (ins.kind !== 'key') continue;
        const kv = ins.keyNode ? b.keyOf(ins.keyNode, j) : ins.key;
        if (kv !== key) continue;
      } else if (ins.kind !== 'item') continue;
      if (b.simpleText(ins.value, tail, j) === carried) found.push([j, ins.value]);
    }
  }
  const where = key !== null ? `under key ${keyRepr(key)}` : 'as an element';
  if (!found.length) {
    b.end = `no statement before #${before} put this value ${where} with the same text; the container was probably filled in place after it was made, which the recording does not tie to a statement`;
    return;
  }
  const [j, v] = found[0]!;
  let note = `put ${where} here; matched by key and value text, the recording has no object identity`;
  if (found.length > 1) note += `; ${found.length} statements put the same text there, the latest is shown`;
  if (b.add(j, b.seg(j, v), carried, 'element', 'inferred', note) === null) return;
  b.followExpr(v, tail, j, carried);
}
