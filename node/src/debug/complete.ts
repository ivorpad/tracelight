/**
 * Completions for a watch expression typed so far, as Pyokka's complete.py.
 *
 * `expression` is the text before the caret and `prefix` the identifier at its end (what a chosen
 * label replaces). After a dot, the balanced expression before it (`payload`, `rows[0]`,
 * `this.items`) is evaluated under the pure rule (`pure.ts`) and its properties are listed with
 * `Runtime.getProperties`, which reports an accessor without calling it, the way
 * `inspect.getattr_static` does. Otherwise the scope's names (innermost first), then the globals,
 * then the constant keywords. Underscored names only once the prefix starts with `_`; the
 * runtime's `_tk_` / `__tk` names never.
 */
import { evaluatePure, isRuntimeName, type Post, type Remote, type Target } from '../pure.ts';

export interface Completion {
  label: string;
  kind: string;
  type?: string;
}

export interface Completed {
  prefix: string;
  items: Completion[];
  error?: string;
}

const KEYWORDS = ['true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'this', 'typeof', 'instanceof', 'new', 'void', 'in'];
const IDENT_END = /[\p{L}_$][\p{L}\p{N}_$]*$/u;
const IDENT = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/** The expression before a trailing `.prefix`, or null when the caret is not after a dot. */
export function splitDotted(expression: string): { object: string | null; prefix: string } {
  const prefix = expression.match(IDENT_END)?.[0] ?? '';
  let i = expression.length - prefix.length - 1;
  while (i >= 0 && expression[i] === ' ') i--;
  if (i < 0 || expression[i] !== '.' || expression[i - 1] === '.') return { object: null, prefix };
  if (expression[i - 1] === '?') i--; // `a?.b`
  const end = i;
  i--;
  // walk back over a balanced primary: names, dots, calls, subscripts, string literals
  const stack: string[] = [];
  for (; i >= 0; i--) {
    const ch = expression[i]!;
    if (CLOSERS[ch]) stack.push(CLOSERS[ch]!);
    else if (ch === '(' || ch === '[' || ch === '{') {
      if (stack.pop() !== ch) break;
    } else if ((ch === '"' || ch === "'" || ch === '`') && stack.length) {
      const open = expression.lastIndexOf(ch, i - 1);
      if (open < 0) break;
      i = open;
    } else if (!stack.length && !/[\p{L}\p{N}_$.?]/u.test(ch)) break;
  }
  if (stack.length) return { object: null, prefix };
  const object = expression.slice(i + 1, end).trim();
  return { object: object || null, prefix };
}

function visible(name: string, prefix: string): boolean {
  if (!IDENT.test(name) || isRuntimeName(name)) return false;
  if (name.startsWith('_') && !prefix.startsWith('_')) return false;
  return name.startsWith(prefix);
}

function kindOf(remote: Remote | undefined, attribute: boolean): Completion {
  const out: Completion = { label: '', kind: attribute ? 'attribute' : 'variable' };
  if (!remote) return out;
  if (remote.type === 'function') {
    out.kind = /^class[\s{]/.test(remote.description ?? '') ? 'class' : attribute ? 'method' : 'function';
    return out;
  }
  out.type = remote.className ?? remote.subtype ?? remote.type;
  return out;
}

async function primitiveWrapper(post: Post, globalId: string, remote: Remote, group: string): Promise<string | undefined> {
  if (remote.objectId) return remote.objectId;
  if (remote.type === 'undefined' || remote.subtype === 'null') return undefined;
  const arg = remote.unserializableValue ? { unserializableValue: remote.unserializableValue } : { value: remote.value };
  const r = await post('Runtime.callFunctionOn', { objectId: globalId, functionDeclaration: 'function (v) { return Object(v); }', arguments: [arg], objectGroup: group, silent: true });
  return r.result?.objectId;
}

export async function completionsFor(
  post: Post, target: Target, expression: string, scopes: { names: { name: string; remote: Remote }[] }[], globalId: string, limit = 100, group = 'pyokka',
): Promise<Completed> {
  const { object, prefix } = splitDotted(expression);
  const items: Completion[] = [];
  const seen = new Set<string>();
  const add = (label: string, c: Completion) => {
    if (seen.has(label) || !visible(label, prefix)) return;
    seen.add(label);
    items.push({ ...c, label });
  };
  if (object !== null) {
    let remote: Remote;
    try {
      remote = await evaluatePure(post, target, object, group);
    } catch (e) {
      return { prefix, items: [], error: (e as Error).message };
    }
    const objectId = await primitiveWrapper(post, globalId, remote, group);
    if (!objectId) return { prefix, items: [], error: `TypeError: ${object} is ${remote.value === null ? 'null' : 'undefined'}` };
    const props = await post('Runtime.getProperties', { objectId, ownProperties: false, accessorPropertiesOnly: false, generatePreview: false, objectGroup: group });
    const found: [string, Completion][] = [];
    for (const p of props.result ?? []) {
      if (p.symbol || p.name === '__proto__' || p.name === 'constructor') continue;
      const c = p.get || p.set ? { label: '', kind: 'property' } : kindOf(p.value, true);
      found.push([p.name, c]);
    }
    found.sort((a, b) => a[0].localeCompare(b[0]));
    for (const [name, c] of found) add(name, c);
    return { prefix, items: items.slice(0, limit) };
  }
  for (const scope of scopes) {
    for (const { name, remote } of [...scope.names].sort((a, b) => a.name.localeCompare(b.name))) add(name, kindOf(remote, false));
  }
  const globals = await post('Runtime.getProperties', { objectId: globalId, ownProperties: true, generatePreview: false, objectGroup: group });
  const lexical = await post('Runtime.globalLexicalScopeNames', {}).catch(() => ({ names: [] }));
  for (const name of [...(lexical.names ?? [])].sort()) add(name, { label: '', kind: 'variable' });
  const builtins: [string, Completion][] = [];
  for (const p of globals.result ?? []) {
    if (p.symbol) continue;
    const c = kindOf(p.value, false);
    builtins.push([p.name, c.kind === 'function' ? { label: '', kind: 'builtin' } : c]);
  }
  builtins.sort((a, b) => a[0].localeCompare(b[0]));
  for (const [name, c] of builtins) add(name, c);
  for (const k of KEYWORDS) add(k, { label: '', kind: 'keyword' });
  return { prefix, items: items.slice(0, limit) };
}
