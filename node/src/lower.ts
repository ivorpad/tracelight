/**
 * TypeScript that `module.stripTypeScriptTypes` cannot strip in place: `enum`, `namespace` with a
 * body, constructor parameter properties, `import x = require()` and `export =`. They are lowered here to JavaScript (types inside
 * stay, the stripper removes them afterwards), as small edits on the source:
 *
 *   enum E { A, B = 5 }       var E=(function(E){const A=0;E[E["A"]=A]="A";...;return E})(E||{});
 *   namespace N { export const k = 1 }   var N;(function(N){       const k = 1;N.k=k;})(N||(N={}));
 *   constructor(public x: number)        constructor(       x: number){this.x=x;
 *
 * Every edit keeps its span's line count (a lowered enum is padded with the newlines it replaced),
 * so lines, and with them stack traces, stay the source's; `toOrig` / `toLow` map columns between
 * the lowered text and the source, which `MappedLineIndex` uses to report ranges in source terms.
 */
import { parseSync } from './parse.ts';
import { LineIndex } from './lines.ts';
import type { Range } from './protocol.ts';

type Node = any;

interface Edit {
  start: number;
  end: number;
  text: string;
}

export interface Lowered {
  code: string;
  toOrig(low: number): number;
  toLow(orig: number): number;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

function newlines(text: string): string {
  return '\n'.repeat((text.match(/\n/g) ?? []).length);
}

export interface LowerOptions {
  /** lower JSX too (`.jsx`, `.tsx`) */
  jsx?: boolean;
  /** the file is TypeScript (lower its enums and friends; the caller strips the rest) */
  ts?: boolean;
  /** how the file is evaluated, for the JSX runtime import (`import` or `require`) */
  sourceType?: 'module' | 'commonjs' | 'unambiguous';
}

export function lowerTypeScript(source: string, filename = 'x.ts', opts: LowerOptions = { ts: true }): Lowered | null {
  const ts = opts.ts !== false;
  const lang = opts.jsx ? (ts ? 'tsx' : 'jsx') : 'ts';
  const r = parseSync(`x.${lang}`, source, { lang, sourceType: 'unambiguous' });
  if (r.errors?.length) return null;
  const edits: Edit[] = [];
  const text = (n: Node) => source.slice(n.start, n.end);
  const jsx = opts.jsx ? jsxRuntime(r.comments ?? [], source) : null;
  let usedJsx = false;

  /** keep `pieces`' nodes in place and write the strings around them, each gap keeping its newlines */
  const emit = (start: number, end: number, pieces: (string | Node)[]): void => {
    let cursor = start;
    let buf = '';
    for (const p of pieces) {
      if (typeof p === 'string') {
        buf += p;
        continue;
      }
      edits.push({ start: cursor, end: p.start, text: buf + newlines(source.slice(cursor, p.start)) });
      visit(p, false);
      cursor = p.end;
      buf = '';
    }
    edits.push({ start: cursor, end, text: buf + newlines(source.slice(cursor, end)) });
  };

  /** a JSX element or fragment as call pieces: strings around the expressions it keeps in place */
  const element = (n: Node): (string | Node)[] => {
    usedJsx = true;
    const rt = jsx!;
    const children = (n.children ?? []).map(child).filter((c: (string | Node)[] | null): c is (string | Node)[] => c !== null);
    const open = n.type === 'JSXFragment' ? null : n.openingElement;
    const tag = open ? tagName(open.name) : rt.fragment;
    const out: (string | Node)[] = [];
    const props: (string | Node)[] = [];
    for (const a of open?.attributes ?? []) {
      if (a.type === 'JSXSpreadAttribute') {
        props.push('...(', a.argument, '),');
        continue;
      }
      const name = a.name.type === 'JSXNamespacedName' ? `${a.name.namespace.name}:${a.name.name.name}` : a.name.name;
      const value = attrValue(a.value);
      props.push(`${IDENT.test(name) ? name : JSON.stringify(name)}:`, ...value, ',');
    }
    if (rt.classic) {
      out.push(`${rt.factory}(${tag},{`, ...props, '}');
      for (const c of children) out.push(',', ...c);
      out.push(')');
      return out;
    }
    const many = children.length > 1;
    // `__tk.jsx` moves a `key` prop to jsx()'s third argument (the props stay in source order)
    out.push(`__tk.jsx(${many ? rt.jsxs : rt.jsx},${tag},{`, ...props);
    if (children.length === 1) out.push('children:', ...children[0]!);
    else if (many) {
      out.push('children:[');
      children.forEach((c, i) => out.push(...(i ? [','] : []), ...c));
      out.push(']');
    }
    out.push('})');
    return out;
  };

  const tagName = (t: Node): string => {
    if (t.type === 'JSXIdentifier') return /^[a-z]/.test(t.name) || t.name.includes('-') ? JSON.stringify(t.name) : t.name;
    if (t.type === 'JSXNamespacedName') return JSON.stringify(`${t.namespace.name}:${t.name.name}`);
    if (t.type === 'JSXMemberExpression') return `${tagName(t.object).replace(/^"(.*)"$/, '$1')}.${t.property.name}`;
    return text(t);
  };

  const attrValue = (v: Node): (string | Node)[] => {
    if (!v) return ['true'];
    if (v.type === 'Literal') return [JSON.stringify(decodeEntities(String(v.value)))];
    if (v.type === 'JSXExpressionContainer') return v.expression.type === 'JSXEmptyExpression' ? ['true'] : ['(', v.expression, ')'];
    if (v.type === 'JSXElement' || v.type === 'JSXFragment') return element(v);
    return [text(v)];
  };

  const child = (c: Node): (string | Node)[] | null => {
    if (c.type === 'JSXText') {
      const t = cleanText(c.value);
      return t === null ? null : [JSON.stringify(t)];
    }
    if (c.type === 'JSXExpressionContainer') return c.expression.type === 'JSXEmptyExpression' ? null : ['(', c.expression, ')'];
    if (c.type === 'JSXSpreadChild') return ['...(', c.expression, ')'];
    return element(c);
  };

  const lowerEnum = (n: Node): string => {
    const name = n.id.name;
    const parts: string[] = [];
    let prev: string | null = null;
    for (const m of n.body?.members ?? n.members ?? []) {
      const key = m.id.type === 'Identifier' ? m.id.name : String(m.id.value);
      const local = IDENT.test(key) ? key : null;
      const value = m.initializer ? `(${text(m.initializer)})` : prev === null ? '0' : `${prev}+1`;
      const v = local ?? `_tk_m${parts.length}_`;
      parts.push(`const ${v}=${value};${name}[${JSON.stringify(key)}]=${v};if(typeof ${v}!=="string")${name}[${v}]=${JSON.stringify(key)};`);
      prev = v;
    }
    return `var ${name}=(function(${name}){${parts.join('')}return ${name}})(${name}||{});`;
  };

  /** the edits that lower a namespace body; `exportsTo` collects `N.x=x;` assignments */
  const lowerBody = (stmts: Node[], ns: string): void => {
    for (const s of stmts) {
      if (s.type === 'ExportNamedDeclaration' && s.declaration) {
        const d = s.declaration;
        const names: string[] = [];
        if (d.type === 'VariableDeclaration') {
          if (d.declare) continue;
          for (const x of d.declarations) if (x.id.type === 'Identifier') names.push(x.id.name);
        } else if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id && !d.declare) names.push(d.id.name);
        else if (d.type === 'TSEnumDeclaration' && !d.declare) names.push(d.id.name);
        else if (d.type === 'TSModuleDeclaration' && d.id.type === 'Identifier' && d.body && !d.declare) names.push(d.id.name);
        else if (d.type === 'TSModuleDeclaration' && d.id.type === 'TSQualifiedName' && d.body && !d.declare) {
          let id = d.id;
          while (id.type === 'TSQualifiedName') id = id.left;
          names.push(id.name);
        }
        else continue; // types: the stripper removes them
        edits.push({ start: s.start, end: d.start, text: ' '.repeat(d.start - s.start) }); // `export ` -> blanks
        visit(d, false);
        edits.push({ start: s.end, end: s.end, text: names.map((x) => `;${ns}.${x}=${x};`).join('') });
      } else visit(s, false);
    }
  };

  const visit = (n: Node, exported: boolean): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      for (const x of n) visit(x, exported);
      return;
    }
    if (typeof n.type !== 'string') return;
    if (jsx && (n.type === 'JSXElement' || n.type === 'JSXFragment')) {
      emit(n.start, n.end, element(n));
      return;
    }
    if (!ts) {
      for (const k in n) if (k !== 'type' && k !== 'start' && k !== 'end' && n[k] && typeof n[k] === 'object') visit(n[k], false);
      return;
    }
    if (n.type === 'TSEnumDeclaration') {
      if (n.declare) return;
      edits.push({ start: n.start, end: n.end, text: lowerEnum(n) + newlines(text(n)) });
      return;
    }
    if (n.type === 'TSModuleDeclaration') {
      if (n.declare || !n.body || n.body.type !== 'TSModuleBlock') return;
      // `namespace A.B.C {}` is A { B { C {} } }, each level hung on its parent
      const chain: string[] = [];
      for (let id = n.id; id; id = id.type === 'TSQualifiedName' ? id.left : null) chain.unshift(id.type === 'TSQualifiedName' ? id.right.name : id.name);
      if (chain.some((x) => !IDENT.test(x))) return;
      const head = chain.map((x) => `var ${x};(function(${x}){`).join('');
      const tail = chain
        .map((x, i) => (i === 0 ? `})(${x}||(${x}={}));` : `})(${x}=${chain[i - 1]}.${x}||(${chain[i - 1]}.${x}={}));`))
        .reverse()
        .join('');
      edits.push({ start: n.start, end: n.body.start + 1, text: head + newlines(source.slice(n.start, n.body.start + 1)) });
      lowerBody(n.body.body, chain[chain.length - 1]!);
      edits.push({ start: n.body.end - 1, end: n.end, text: tail });
      return;
    }
    if (n.type === 'TSImportEqualsDeclaration' && n.importKind !== 'type' && n.moduleReference?.type === 'TSExternalModuleReference') {
      // `import fs = require("fs")` -> `const  fs = require("fs")` (CommonJS, as TypeScript emits it)
      edits.push({ start: n.start, end: n.start + 6, text: 'const ' });
      return;
    }
    if (n.type === 'TSExportAssignment') {
      // `export = x` -> `module.exports = x`
      edits.push({ start: n.start, end: n.expression.start, text: 'module.exports = ' });
      return;
    }
    if ((n.type === 'MethodDefinition' && n.kind === 'constructor') || (n.type === 'TSAbstractMethodDefinition' && n.kind === 'constructor')) {
      const fn = n.value;
      const props = (fn?.params ?? []).filter((p: Node) => p.type === 'TSParameterProperty');
      if (props.length && fn.body) {
        const assigns: string[] = [];
        for (const p of props) {
          const param = p.parameter;
          const id = param.type === 'AssignmentPattern' ? param.left : param;
          if (id.type !== 'Identifier') continue;
          edits.push({ start: p.start, end: param.start, text: ' '.repeat(param.start - p.start) });
          assigns.push(`this.${id.name}=${id.name};`);
        }
        // after `super(...)` in a derived class: `this` exists only from there
        const first = fn.body.body.find((s: Node) => s.type === 'ExpressionStatement' && s.expression.type === 'CallExpression' && s.expression.callee.type === 'Super');
        const at = first ? first.end : fn.body.start + 1;
        edits.push({ start: at, end: at, text: assigns.join('') });
        visit(fn.body, false);
        return;
      }
    }
    for (const k in n) {
      if (k === 'type' || k === 'start' || k === 'end') continue;
      const v = n[k];
      if (v && typeof v === 'object') visit(v, k === 'declaration' && n.type === 'ExportNamedDeclaration');
    }
  };
  visit(r.program.body, false);
  if (usedJsx && !jsx!.classic) {
    // the automatic runtime's import, after the directives, on the first line's own text
    const body = r.program.body;
    let at = 0;
    for (const s of body) if (s.type === 'ExpressionStatement' && typeof s.directive === 'string') at = s.end;
    const esm = opts.sourceType === 'module' || (opts.sourceType !== 'commonjs' && r.module?.hasModuleSyntax);
    const spec = JSON.stringify(jsx!.source + '/jsx-runtime');
    edits.push({ start: at, end: at, text: esm ? `import * as _tk_rt from ${spec};` : `const _tk_rt=require(${spec});` });
  }
  if (!edits.length) return null;
  edits.sort((a, b) => a.start - b.start || a.end - b.end);

  // apply, recording [lowStart, origStart, origEnd, lowEnd] per edit
  let code = '';
  let pos = 0;
  const marks: [number, number, number, number][] = [];
  for (const e of edits) {
    if (e.start < pos) continue; // overlapping: the outer edit won
    code += source.slice(pos, e.start);
    const lowStart = code.length;
    code += e.text;
    marks.push([lowStart, e.start, e.end, code.length]);
    pos = e.end;
  }
  code += source.slice(pos);

  const toOrig = (low: number): number => {
    let shift = 0;
    for (const [ls, os, oe, le] of marks) {
      if (low < ls) break;
      if (low < le) return os + Math.min(low - ls, Math.max(0, oe - os - 1));
      shift = oe - le;
    }
    return low + shift;
  };
  const toLow = (orig: number): number => {
    let shift = 0;
    for (const [ls, os, oe, le] of marks) {
      if (orig < os) break;
      if (orig < oe) return ls + Math.min(orig - os, le - ls);
      shift = le - oe;
    }
    return orig + shift;
  };
  return { code, toOrig, toLow };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '©', reg: '®', hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', middot: '·', times: '×', bull: '•' };

function decodeEntities(t: string): string {
  return t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

/** JSX text the way Babel and TypeScript keep it: lines trimmed where they meet a newline, joined by a space */
function cleanText(raw: string): string | null {
  const lines = raw.split(/\r\n|\n|\r/);
  let out = '';
  lines.forEach((line, i) => {
    let l = line.replace(/\t/g, ' ');
    if (i > 0) l = l.replace(/^[ ]+/, '');
    if (i < lines.length - 1) l = l.replace(/[ ]+$/, '');
    if (!l) return;
    out += (out && i > 0 ? ' ' : '') + l;
  });
  return out ? decodeEntities(out) : null;
}

interface JsxRuntime {
  classic: boolean;
  factory: string;
  fragment: string;
  jsx: string;
  jsxs: string;
  source: string;
}

/** `@jsxImportSource x`, `@jsxRuntime classic`, `@jsx h`, `@jsxFrag F` pragmas; React's automatic runtime by default */
function jsxRuntime(comments: Node[], _source: string): JsxRuntime {
  const all = comments.map((c) => c.value).join('\n');
  const pick = (re: RegExp) => re.exec(all)?.[1];
  const factory = pick(/@jsx\s+([\w$.]+)/);
  const classic = pick(/@jsxRuntime\s+(\w+)/) === 'classic' || !!factory;
  if (classic) return { classic, factory: factory ?? 'React.createElement', fragment: pick(/@jsxFrag\s+([\w$.]+)/) ?? 'React.Fragment', jsx: '', jsxs: '', source: '' };
  return { classic: false, factory: '', fragment: '_tk_rt.Fragment', jsx: '_tk_rt.jsx', jsxs: '_tk_rt.jsxs', source: pick(/@jsxImportSource\s+(\S+)/) ?? 'react' };
}

/** positions over the lowered text reported in the source's terms (lines are the same; columns map) */
export class MappedLineIndex extends LineIndex {
  readonly src: LineIndex;
  readonly map: Lowered;

  constructor(lowered: string, source: string, map: Lowered) {
    super(lowered);
    this.src = new LineIndex(source);
    this.map = map;
  }

  override pos(offset: number): [number, number] {
    return this.src.pos(this.map.toOrig(offset));
  }

  override range(start: number, end: number): Range {
    const [sl, sc] = this.pos(start);
    const [el, ec] = this.src.pos(this.map.toOrig(Math.max(start, end - 1)) + (end > start ? 1 : 0));
    return [sl, sc, el, ec];
  }

  override offset(line: number, col: number): number {
    return this.map.toLow(this.src.offset(line, col));
  }
}
