/**
 * The closing sentence of a provenance tree: the answer in words,
 * built from the tree alone, for JavaScript statements and values.
 *
 * `conclusion(tree)` reads the root of a `why` result and its first level (the reads with
 * recorded values, the stepped calls) and writes two sentences at most: what the value is and
 * where, then the one cause the tree supports. A clause appears only when the tree recorded the
 * value it names, and a root without a recorded value says nothing.
 *
 * Rules, in order, the first that applies wins:
 * 1. the root: `NAME is VALUE at #STEP (file.ts:LINE)`;
 * 2. a conditional expression `test ? a : b` whose arm is known: `The else arm ran: TEST is VALUE`
 *    when the test is a name with a recorded value, or `The else arm ran: TEST was false, since A
 *    is X` when the produced value is the arm's literal; `since` names up to two recorded reads;
 * 3. a stepped call with a recorded return: `f(args) returned VALUE`, plus `with P = undefined`
 *    for the first parameter recorded as null, undefined or empty;
 * 4. a plain copy `x = y` of one recorded read: `It copies y, which has been VALUE since #STEP (file.ts:LINE)`;
 * 5. a `.get(...)` or subscript (also `?.get(...)`, `?.[...]`) that produced undefined from a recorded container: `EXPR is
 *    undefined: the key is not in CONTAINER (N keys)`, the count when the recorded text is a whole object;
 * 6. otherwise `It reads a = X, b = Y` for up to three recorded reads.
 * Values are one line cut at 60 characters, as the panel shows them.
 */

type Msg = Record<string, any>;

export const VALUE_LIMIT = 60;
/** the texts of JavaScript's falsy values, as the recording writes them */
const FALSY = new Set(['false', 'null', 'undefined', '0', '-0', '0n', 'NaN', "''", '""', '``']);
const NULL_OR_EMPTY = new Set(['null', 'undefined', "''", '""', '``', '[]', '{}', 'Map(0) {}', 'Set(0) {}']);
const KEYWORDS = new Set(['typeof', 'instanceof', 'in', 'of', 'new', 'void', 'delete', 'await', 'null', 'undefined', 'true', 'false', 'this', 'function', 'return']);
const NAME = /^[A-Za-z_$][\w$.]*$/;
const IDENT = /(?<![\w$.])[A-Za-z_$][\w$]*/g;
const STRING = /'[^']*'|"[^"]*"|`[^`]*`/g;

export function clip(text: unknown): string {
  const s = String(text ?? '').split('\n').join(' ').trim();
  const chars = [...s];
  return chars.length <= VALUE_LIMIT ? s : chars.slice(0, VALUE_LIMIT - 1).join('') + '…';
}

export function shortFile(path: unknown): string {
  const parts = String(path || '').split(/[\\/]/);
  return parts[parts.length - 1] || '<unknown>';
}

function where(node: Msg): string {
  return `#${node.step ?? 'None'} (${shortFile(node.file)}:${node.line !== null && node.line !== undefined ? node.line : '?'})`;
}

export function conclusion(tree: Msg): string {
  const root = tree.root ?? {};
  const name = root.name;
  if (!name || root.step === null || root.step === undefined || root.text === null || root.text === undefined) return '';
  const first = `${name} is ${clip(root.text)} at ${where(root)}`;
  const reads = ((root.reads ?? []) as Msg[]).filter((r) => r && typeof r === 'object' && r.text !== null && r.text !== undefined);
  const calls = ((root.calls ?? []) as Msg[]).filter((c) => c && typeof c === 'object');
  const second = conditional(root, reads) || call(root, calls) || copy(root, reads) || lookup(root, reads) || readsText(reads);
  return first + '.' + (second ? ' ' + second + '.' : '');
}

/** the expression after the first `=` of an assignment (`==`, `===`, `=>` are not one); the statement itself otherwise */
function rhs(statement: string): string {
  const m = /(?<![=!<>])=(?![=>])/.exec(statement);
  return (m ? statement.slice(m.index + 1) : statement).trim().replace(/;$/, '').trim();
}

function names(text: string): string[] {
  const seen: string[] = [];
  for (const m of text.replace(STRING, "''").matchAll(IDENT)) if (!KEYWORDS.has(m[0]) && !seen.includes(m[0])) seen.push(m[0]);
  return seen;
}

function since(test: string, reads: Msg[], skip: string | null): string {
  const byName = new Map(reads.map((r) => [r.name, r]));
  const parts = names(test).filter((n) => n !== skip && byName.has(n)).map((n) => `${n} is ${clip(byName.get(n)!.text)}`).slice(0, 2);
  return parts.length ? ', since ' + parts.join(' and ') : '';
}

/** `test ? a : b` split at its top-level `?` and `:` (a nested conditional in an arm keeps its own) */
function ternary(expr: string): [string, string, string] | null {
  let depth = 0;
  let q = -1;
  let nested = 0;
  let quote: string | null = null;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (depth === 0 && ch === '?' && expr[i + 1] !== '?' && expr[i + 1] !== '.' && expr[i - 1] !== '?') {
      if (q < 0) q = i;
      else nested++;
    } else if (depth === 0 && ch === ':' && q >= 0) {
      if (nested) nested--;
      else return [expr.slice(0, q).trim(), expr.slice(q + 1, i).trim(), expr.slice(i + 1).trim()];
    }
  }
  return null;
}

function conditional(root: Msg, reads: Msg[]): string {
  const parts = ternary(rhs(String(root.statement || '')));
  if (!parts) return '';
  const [test, ifArm, elseArm] = parts;
  const byName = new Map(reads.map((r) => [r.name, r]));
  if (NAME.test(test) && byName.has(test)) {
    const text = String(byName.get(test)!.text);
    const arm = FALSY.has(text) ? 'else' : 'if';
    return `The ${arm} arm ran: ${test} is ${clip(text)}${since(test, reads, test)}`;
  }
  const value = String(root.text);
  if (value === elseArm) return `The else arm ran: ${test} was false${since(test, reads, null)}`;
  if (value === ifArm) return `The if arm ran: ${test} was true${since(test, reads, null)}`;
  return '';
}

function callText(statement: string, name: string): string {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`((?:[A-Za-z_$][\\w$]*\\.)*${esc})\\(`).exec(statement);
  if (!m) return `${name}(...)`;
  let depth = 0;
  for (let i = m.index + m[0].length - 1; i < statement.length; i++) {
    const ch = statement[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return statement.slice(m.index, i + 1);
    }
  }
  return statement.slice(m.index);
}

function call(root: Msg, calls: Msg[]): string {
  for (const c of calls) {
    if (c.result === null || c.result === undefined) continue;
    let text = `${callText(String(root.statement || ''), String(c.name))} returned ${clip(c.result)}`;
    for (const arg of c.inputs ?? []) {
      if (arg && typeof arg === 'object' && arg.text !== null && arg.text !== undefined && NULL_OR_EMPTY.has(String(arg.text))) {
        text += ` with ${arg.name} = ${arg.text}`;
        break;
      }
    }
    return text;
  }
  return '';
}

function copy(root: Msg, reads: Msg[]): string {
  const earlier = reads.filter((r) => r.step !== null && r.step !== undefined && Number(r.step) < Number(root.step));
  if (earlier.length !== 1) return '';
  const read = earlier[0]!;
  if (rhs(String(root.statement || '')) !== read.name) return '';
  return `It copies ${read.name}, which has been ${clip(read.text)} since ${where(read)}`;
}

/** top-level keys of a whole object's text (`{ a: 1, b: 2 }`); null when the text is not one or is cut */
function countKeys(text: string): number | null {
  if (!(text.startsWith('{') && text.endsWith('}')) || text.includes('…')) return null;
  let depth = 0;
  let keys = 0;
  let quote: string | null = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ':' && depth === 1) keys++;
  }
  return keys;
}

function lookup(root: Msg, reads: Msg[]): string {
  if (String(root.text) !== 'undefined') return '';
  const r = rhs(String(root.statement || ''));
  const m = /([A-Za-z_$][\w$.]*)(\??\.get\(|\?\.\[|\[)/.exec(r);
  if (!m) return '';
  const container = m[1]!;
  const byName = new Map(reads.map((x) => [x.name, x]));
  const read = byName.get(container) ?? byName.get(container.split('.')[0]);
  if (read === undefined) return '';
  const openAt = m.index + m[0].length - 1;
  const opener = r[openAt]!;
  const closer = opener === '(' ? ')' : ']';
  let depth = 0;
  let end = r.length;
  for (let i = openAt; i < r.length; i++) {
    if (r[i] === opener) depth++;
    else if (r[i] === closer) {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  const expr = r.slice(m.index, end);
  const keys = read.name === container ? countKeys(String(read.text)) : null;
  return `${expr} is undefined: the key is not in ${container}${keys !== null ? ` (${keys} keys)` : ''}`;
}

function readsText(reads: Msg[]): string {
  const parts = reads.slice(0, 3).map((r) => `${r.name} = ${clip(r.text)}`);
  return parts.length ? 'It reads ' + parts.join(', ') : '';
}
