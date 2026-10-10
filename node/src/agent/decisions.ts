/**
 * What a source file's statements *are*, for the walkthrough:
 * decisions, loops, returns, qualified names, from the oxc AST. Nothing here reads a run. Shapes
 * (lines 1-based, as the range tables):
 *
 * - `decisions`: by header line, with the header's column (a statement on the same line is not
 *   the header). `if` / `else if` (each is its own statement and its own step): `{kind: 'if',
 *   label: 'if' | 'else if', line, col, text: '(<condition>)', body: [first, last], orelse:
 *   [first, last]}`, the body's line span (the next step landing in it means the condition was
 *   true) and the else arm's (an `else if` chain: its header through the end of the chain;
 *   `[0, 0]` without one). `switch` is a `match`: `{kind: 'match', keyword: 'switch', line,
 *   col, text: '(<discriminant>)', arms: [{text: <case test> | 'default', body, default}]}`.
 * - `loops`: by header line, `{kind: 'for' | 'while', line, col, text, end}`; texts read as written:
 *   `(const x of xs)`, `(let i = 0; i < n; i++)`, `(n < 2)`.
 * The texts are node/src/walk.ts's, the table the runtime sends the host, so both say the same.
 * - `returns`: the lines holding a `return` statement.
 * - `qualnames`: by function header line, `Class.method` (nested classes joined with dots).
 * - `functions`: by header line, `{name, line, end}`.
 */
import { isJsxPath, isTypeScriptPath, toJavaScript } from '../instrument.ts';
import { LineIndex } from '../lines.ts';
import { MappedLineIndex, type Lowered } from '../lower.ts';
import { parseSync } from '../parse.ts';

type Node = any;
type Msg = Record<string, any>;

const WORD_CUT = 60;

export interface FileMap {
  decisions: Map<number, Msg>;
  loops: Map<number, Msg>;
  returns: Set<number>;
  qualnames: Map<number, string>;
  functions: Map<number, Msg>;
}

export function collapse(text: string, limit = WORD_CUT): string {
  const s = text.split(/\s+/).filter(Boolean).join(' ');
  return [...s].length <= limit ? s : [...s].slice(0, limit - 1).join('') + '…';
}

const empty = (): FileMap => ({ decisions: new Map(), loops: new Map(), returns: new Set(), qualnames: new Map(), functions: new Map() });

/** decisions, loops, return lines, qualified names and function spans of `source`; empty on a syntax error */
export function fileMap(source: string, path = 'x.js'): FileMap {
  let js = source;
  let lowered: Lowered | null = null;
  try {
    if (isTypeScriptPath(path) || isJsxPath(path)) ({ js, lowered } = toJavaScript(source, path));
  } catch {
    return empty();
  }
  const r = parseSync('x.js', js, { sourceType: 'unambiguous', lang: 'js' } as any);
  if (r.errors.length) return empty();
  const lines = lowered ? new MappedLineIndex(js, source, lowered) : new LineIndex(js);
  const src = new LineIndex(source);
  const out = empty();
  const line = (offset: number) => lines.pos(offset)[0];
  const col = (n: Node) => lines.pos(n.start)[1];
  const endLine = (n: Node) => lines.pos(Math.max(n.start, n.end - 1))[0];
  /** the source text of a node (the original, not the stripped JavaScript) */
  const segment = (n: Node | null | undefined): string => {
    if (!n) return '';
    const [sl, sc] = lines.pos(n.start);
    const [el, ec] = lines.pos(Math.max(n.start, n.end - 1));
    return source.slice(src.offset(sl, sc), src.offset(el, ec) + (n.end > n.start ? 1 : 0)).split(/\r\n|\r|\n/).join(' ');
  };
  /** `[first, last]` source lines of a block or a single statement (`[0, 0]` when empty) */
  const span = (body: Node | null | undefined): number[] => {
    if (!body) return [0, 0];
    const list = body.type === 'BlockStatement' ? body.body : [body];
    if (!list.length) return [0, 0];
    return [line(list[0].start), endLine(list[list.length - 1])];
  };
  /** `[firstLine, firstCol, lastLine, lastCol]` of a block's statements, so a body on its header's line is told apart */
  const cols = (body: Node | null | undefined): number[] | undefined => {
    if (!body) return undefined;
    const list = body.type === 'BlockStatement' ? body.body : [body];
    if (!list.length) return undefined;
    const last = list[list.length - 1];
    return [line(list[0].start), col(list[0]), ...lines.pos(Math.max(last.start, last.end - 1))];
  };
  const listSpan = (list: Node[]): number[] => (list.length ? [line(list[0].start), endLine(list[list.length - 1])] : [0, 0]);
  const classes: string[] = [];
  const fn = (name: string, header: Node, whole: Node) => {
    const qual = [...classes, name].join('.');
    const l = line(header.start);
    out.qualnames.set(l, qual);
    out.functions.set(l, { name: qual, line: l, end: endLine(whole) });
  };
  const inferName = (n: Node, parent: Node | null, key: string): string => {
    if (n.id?.name) return n.id.name;
    if (parent?.type === 'VariableDeclarator' && key === 'init' && parent.id?.type === 'Identifier') return parent.id.name;
    if (parent?.type === 'AssignmentExpression' && key === 'right') return segment(parent.left);
    if ((parent?.type === 'Property' || parent?.type === 'PropertyDefinition') && key === 'value') return keyName(parent.key, parent.kind);
    return n.type === 'ArrowFunctionExpression' ? '<arrow>' : '<anonymous>';
  };
  const keyName = (k: Node, kind?: string): string => {
    let name = k?.type === 'Identifier' ? k.name : k?.type === 'PrivateIdentifier' ? `#${k.name}` : k?.type === 'Literal' ? String(k.value) : '<computed>';
    if (kind === 'get' || kind === 'set') name = `${kind} ${name}`;
    return name;
  };
  const walk = (n: Node, parent: Node | null = null, key = ''): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      for (const x of n) walk(x, parent, key);
      return;
    }
    if (typeof n.type !== 'string') return;
    switch (n.type) {
      case 'ClassDeclaration':
      case 'ClassExpression': {
        walk(n.superClass, n, 'superClass');
        classes.push(n.id?.name || (parent?.type === 'VariableDeclarator' && parent.id?.name) || '<class>');
        walk(n.body, n, 'body');
        classes.pop();
        return;
      }
      case 'MethodDefinition':
      case 'Property':
        if ((n.type === 'MethodDefinition' || n.method || n.kind === 'get' || n.kind === 'set') && n.value && /Function/.test(n.value.type)) {
          fn(n.type === 'MethodDefinition' ? keyName(n.key, n.kind === 'constructor' ? undefined : n.kind) : keyName(n.key, n.kind), n, n.value);
          walk(n.value.body, n.value, 'body');
          return;
        }
        break;
      case 'FunctionDeclaration':
        fn(n.id?.name ?? 'default', parent?.type === 'ExportNamedDeclaration' || parent?.type === 'ExportDefaultDeclaration' ? parent : n, n);
        walk(n.body, n, 'body');
        return;
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        fn(inferName(n, parent, key), n, n);
        walk(n.body, n, 'body');
        return;
      case 'ReturnStatement':
        out.returns.add(line(n.start));
        break;
      case 'IfStatement': {
        const elseIf = parent?.type === 'IfStatement' && key === 'alternate';
        const alt = n.alternate;
        const orelse = !alt ? [0, 0] : alt.type === 'IfStatement' ? [line(alt.start), endLine(alt)] : span(alt);
        out.decisions.set(line(n.start), { kind: 'if', label: elseIf ? 'else if' : 'if', line: line(n.start), col: col(n), text: collapse(`(${segment(n.test)})`), body: span(n.consequent), bodyAt: cols(n.consequent), orelse });
        break;
      }
      case 'SwitchStatement': {
        const arms = (n.cases ?? []).map((c: Node) => ({ text: c.test ? collapse(segment(c.test)) : 'default', body: listSpan(c.consequent ?? []), default: !c.test }));
        out.decisions.set(line(n.start), { kind: 'match', keyword: 'switch', line: line(n.start), col: col(n), text: collapse(`(${segment(n.discriminant)})`), arms });
        break;
      }
      case 'ForOfStatement':
      case 'ForInStatement':
        out.loops.set(line(n.start), { kind: 'for', line: line(n.start), col: col(n), text: collapse(`${n.await ? 'await ' : ''}(${segment(n.left)} ${n.type === 'ForOfStatement' ? 'of' : 'in'} ${segment(n.right)})`), end: endLine(n) });
        break;
      case 'ForStatement':
        out.loops.set(line(n.start), { kind: 'for', line: line(n.start), col: col(n), text: collapse(`(${segment(n.init)}; ${segment(n.test)}; ${segment(n.update)})`), end: endLine(n) });
        break;
      case 'WhileStatement':
      case 'DoWhileStatement':
        out.loops.set(line(n.start), { kind: 'while', line: line(n.start), col: col(n), text: collapse(`(${segment(n.test)})`), end: endLine(n) });
        break;
    }
    for (const k in n) if (k !== 'type' && n[k] && typeof n[k] === 'object') walk(n[k], n, k);
  };
  walk(r.program.body);
  return out;
}

/**
 * A file's map from the runtime's AST table (`file.instrumented.walk`, node/src/walk.ts), the
 * table the host's walkthrough reads, so a saved run and the live session say the same; the
 * qualified names come from `parsed`, the table's bare names only when the source does not parse.
 */
export function walkFileMap(walk: Msg, parsed: FileMap): FileMap {
  const out: FileMap = { decisions: new Map(), loops: new Map(), returns: new Set((walk.returns ?? []).map(Number)), qualnames: new Map(), functions: new Map() };
  for (const d of walk.decisions ?? []) out.decisions.set(Number(d.line), d.kind === 'if' ? { kind: 'if', label: d.label, line: d.line, col: d.col, text: d.text, body: d.body, bodyAt: d.bodyAt ?? (parsed.decisions.get(Number(d.line))?.col === d.col ? parsed.decisions.get(Number(d.line))?.bodyAt : undefined), orelse: d.orelse } : { kind: 'match', keyword: 'switch', line: d.line, col: d.col, text: d.text, arms: d.arms });
  for (const l of walk.loops ?? []) out.loops.set(Number(l.line), { kind: l.kind, line: l.line, col: l.col, text: l.text, end: l.end });
  // the source's own parse names a method by its class (`Box.constructor`); the table's names are bare
  for (const [k, v] of parsed.qualnames) out.qualnames.set(k, v);
  for (const [k, v] of parsed.functions) out.functions.set(k, v);
  if (!out.functions.size) {
    for (const f of walk.functions ?? []) {
      if (!out.qualnames.has(f.line)) out.qualnames.set(f.line, f.name);
      if (!out.functions.has(f.line)) out.functions.set(f.line, { name: f.name, line: f.line, end: f.end });
    }
  }
  return out;
}

/** the innermost function whose span holds `line` (null at module level) */
export function enclosingFunction(fmap: FileMap, line: number): Msg | null {
  let best: Msg | null = null;
  for (const fn of fmap.functions.values()) if (fn.line <= line && line <= fn.end && (best === null || fn.end - fn.line <= best.end - best.line)) best = fn;
  return best;
}
