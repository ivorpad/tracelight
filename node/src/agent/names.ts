/**
 * The names a statement assigns and reads, from its source text alone, as Pyokka's
 * `agent/names.py` does for Python, here for JavaScript and TypeScript.
 *
 * A character scanner, not a parser: string literals, template literals (with the `${…}` parts,
 * which are code) and comments (`//`, `/* *\/`) are recognised so that the identifiers of the rest
 * can be picked out with a regular expression. A statement that needs more than this (the
 * bindings of a function, a destructuring) has its AST answer in `../bindings.ts`.
 */

export const KEYWORDS = new Set(
  'number boolean any unknown never bigint await break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof let new null of return static super switch throw true try typeof var void while with yield async get set undefined as satisfies interface type declare readonly abstract implements private protected public keyof infer is'.split(' '),
);
const OPEN = '([{';
const CLOSE = ')]}';
// a name that is not the tail of a number (`10_000`, `0x1f`)
const NAME = /(?<![A-Za-z0-9_$])[A-Za-z_$][A-Za-z0-9_$]*/g;
const DECL = /^\s*(?:export\s+)?(?:const|let|var|using)\s+/;
const TARGETS = /^\s*(?:[A-Za-z_$][\w$]*|[[{][^=]*[\]}])(?:\s*,\s*[A-Za-z_$][\w$]*)*\s*(?::\s*[^=]*)?\s*$/;
const AUGMENTED = ['>>>', '**', '<<', '>>', '&&', '||', '??', '+', '-', '*', '/', '%', '&', '|', '^'];

interface Lit {
  quote: string;
  depth: number;
}

/**
 * One output line per input line: comments gone; literals kept verbatim, or replaced by a space
 * plus the template literal's `${…}` parts. Block comments and template literals span lines.
 */
function scan(lines: string[], keepLiterals: boolean): string[] {
  const outLines: string[] = [];
  let lit: Lit | null = null;
  let block = false;
  for (const line of lines) {
    let out = '';
    let i = 0;
    const n = line.length;
    while (i < n) {
      const ch = line[i]!;
      if (block) {
        if (line.startsWith('*/', i)) {
          block = false;
          i += 2;
        } else i++;
        continue;
      }
      if (lit === null) {
        if (line.startsWith('//', i)) break;
        if (line.startsWith('/*', i)) {
          block = true;
          i += 2;
          continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') {
          lit = { quote: ch, depth: 0 };
          out += keepLiterals ? ch : ' ';
          i++;
          continue;
        }
        out += ch;
        i++;
        continue;
      }
      if (lit.depth > 0) {
        // inside a template literal's `${…}`: code
        if (ch === '{') lit.depth++;
        else if (ch === '}') lit.depth--;
        out += lit.depth === 0 && !keepLiterals ? ' ' : ch;
        i++;
        continue;
      }
      if (ch === '\\') {
        if (keepLiterals) out += line.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (lit.quote === '`' && line.startsWith('${', i)) {
        lit.depth = 1;
        out += keepLiterals ? '${' : ' ';
        i += 2;
        continue;
      }
      if (ch === lit.quote) {
        lit = null;
        if (keepLiterals) out += ch;
        i++;
        continue;
      }
      if (keepLiterals) out += ch;
      i++;
    }
    if (lit !== null && lit.quote !== '`') lit = null; // an unterminated quote ends with its line
    outLines.push(out);
  }
  return outLines;
}

/** the lines without their comments, literals kept: the source a statement node shows */
export function stripComments(lines: string[]): string[] {
  return scan(lines, true);
}

/** the lines joined by a space, comments gone, literals reduced to a space plus their `${…}` parts */
export function stripCode(lines: string[]): string {
  return scan(lines, false).join(' ');
}

function identifiers(stripped: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let pos = 0;
  const n = stripped.length;
  for (const m of stripped.matchAll(NAME)) {
    for (const ch of stripped.slice(pos, m.index)) {
      if (OPEN.includes(ch)) depth++;
      else if (CLOSE.includes(ch)) depth--;
    }
    pos = m.index! + m[0].length;
    const name = m[0];
    if (m.index! > 0 && stripped[m.index! - 1] === '.' && stripped[m.index! - 2] !== '.') continue; // a property, not a spread
    if (KEYWORDS.has(name)) continue;
    let j = pos;
    while (j < n && (stripped[j] === ' ' || stripped[j] === '\t')) j++;
    // an object key (`{ a: 1 }`) or a default (`(a = 1) =>`) inside brackets is not a read
    if (depth > 0 && j < n && stripped[j] === ':' && stripped[j + 1] !== ':') continue;
    if (depth > 0 && j < n && stripped[j] === '=' && stripped[j + 1] !== '=' && stripped[j + 1] !== '>') continue;
    out.push(name);
  }
  return out;
}

function targets(stripped: string): [string[], boolean] {
  let depth = 0;
  let eq = -1;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i]!;
    if (OPEN.includes(ch)) depth++;
    else if (CLOSE.includes(ch)) depth--;
    else if (ch === '=' && depth === 0) {
      const prev = i > 0 ? stripped[i - 1]! : '';
      const next = stripped[i + 1] ?? '';
      if (!'=!<>'.includes(prev || '#') && next !== '=' && next !== '>') {
        eq = i;
        break;
      }
      if ((prev === '<' || prev === '>') && stripped[i - 2] === prev && next !== '=') {
        eq = i; // `<<=`, `>>=`
        break;
      }
    }
  }
  if (eq < 0) {
    // JavaScript only: `let a, b;` declares without `=`, `x++` / `--x` assign and read
    const bare = DECL.test(stripped) ? stripped.replace(DECL, '').replace(/;\s*$/, '') : null;
    if (bare !== null && /^\s*[A-Za-z_$][\w$]*(?:\s*:[^,]*)?(?:\s*,\s*[A-Za-z_$][\w$]*(?:\s*:[^,]*)?)*\s*$/.test(bare)) {
      return [bare.split(',').map((p) => p.split(':')[0]!.trim()).filter((x) => x && !KEYWORDS.has(x)), false];
    }
    const update = /^\s*(?:(?:\+\+|--)\s*([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)\s*(?:\+\+|--))\s*;?\s*$/.exec(stripped);
    if (update) return [[(update[1] ?? update[2])!], true];
    return [[], false];
  }
  let left = stripped.slice(0, eq).replace(DECL, '');
  let augmented = false;
  for (const op of AUGMENTED) {
    if (left.endsWith(op)) {
      left = left.slice(0, -op.length);
      augmented = true;
      break;
    }
  }
  if (!TARGETS.test(left)) return [[], augmented];
  const head = /^\s*[[{]/.test(left) ? left : left.split(':')[0]!;
  return [[...head.matchAll(NAME)].map((m) => m[0]).filter((x) => !KEYWORDS.has(x)), augmented];
}

/** `[targets, reads]` of a statement given as its raw source lines */
export function namesOf(lines: string[]): [string[], string[]] {
  const stripped = stripCode(lines);
  const [tg, augmented] = targets(stripped);
  const seen = new Set<string>();
  const reads: string[] = [];
  for (const name of identifiers(stripped)) {
    if (seen.has(name) || (tg.includes(name) && !augmented)) continue;
    seen.add(name);
    reads.push(name);
  }
  return [tg, reads];
}

/** `[targets, reads]` of a `for` header's text (`const x of xs`, `k in obj`, `let i = 0; i < n; i++`) */
export function loopNames(text: string): [string[], string[]] {
  const m = /^\s*(?:const|let|var)?\s*(.*?)\s+(?:of|in)\s+(.*)$/s.exec(text);
  if (!m || text.includes(';')) return [[], namesOf([text])[1]];
  return [[...m[1]!.matchAll(NAME)].map((x) => x[0]).filter((x) => !KEYWORDS.has(x)), namesOf([m[2]!])[1]];
}
