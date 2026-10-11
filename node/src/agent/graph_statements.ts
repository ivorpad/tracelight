/**
 * The statement nodes of the execution graph (docs/PROTOCOL.md, "statement"), for `graph.ts`, as
 * Pyokka's `agent/graph_statements.py`.
 *
 * One node per simple statement a step ran in a user-code scope: its source (comments gone), the
 * names it assigns and reads (`names.ts`), its hits, then its rows (the logged value, the print,
 * the raise) and the data edges from the statement that last assigned a name to the statements
 * and decisions that read it. The functions take the builder of `graph.ts` and fill its tables.
 *
 * JavaScript, not Python: a compound statement's range stops at its header (`if (x)`, `for (…)`,
 * `class A`, `function f(a)`), so a header is a statement whose code starts with a compound
 * keyword or is followed by `{`; imports, `export {…}`, `break`/`continue`, `debugger`, type
 * declarations and directives (`'use strict'`, the docstring's twin) make no node either.
 */
import { collapse } from './decisions.ts';
import { namesOf, stripComments } from './names.ts';

type Msg = Record<string, any>;

export const STATEMENTS_MAX = 60;
export const LABEL_MAX = 60;
export const TEXT_MAX = 200;

export const NODE_RANK: Record<string, number> = { module: 0, function: 1, package: 1, decision: 2, statement: 2 };

const HEADER = /^(?:if|for|while|do|switch|try|catch|finally|else|with)(?![\w$])/;
const DECLARATION = /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function(?![\w$])|class(?![\w$]))/;
const TYPE_DECLARATION = /^(?:export\s+)?(?:declare\s+)?(?:type|interface|enum|namespace|module)\s+[A-Za-z_$]/;
const IMPORT = /^import(?:\s|\{|\*|['"])|^export\s*(?:\{|\*|type\s*\{)/;
const JUMP = /^(?:break|continue|debugger)(?![\w$])/;
const LABEL = /^[A-Za-z_$][\w$]*\s*:(?!:)/;
const DIRECTIVE = /^(['"])(?:[^\\]|\\.)*?\1\s*;?$/;

// -- rows -----------------------------------------------------------------------------------------------------

export function row(kind: string, name: string, text: string, step: number): Msg {
  return { kind, name, text, step };
}

/** `Error: too small: 6` -> `['Error', 'too small: 6']`; no message -> `''` (Python's `partition(': ')`) */
export function raised(text: string): [string, string] {
  const i = text.indexOf(': ');
  return i < 0 ? [text, ''] : [text.slice(0, i), text.slice(i + 2)];
}

/** an error moment's sentence (`raised X: m, handled at f:l` / `… (handled)` / `… uncaught`) as a row */
export function errorRow(text: string, step: number): Msg {
  let s = text.startsWith('raised ') ? text.slice('raised '.length) : text;
  if (s.endsWith(' uncaught')) s = s.slice(0, -' uncaught'.length);
  else if (s.endsWith(' (handled)')) s = s.slice(0, -' (handled)'.length);
  else {
    const i = s.lastIndexOf(', handled at ');
    if (i >= 0) s = s.slice(0, i);
  }
  const [name, message] = raised(s);
  return row('raised', name, message, step);
}

/** a print moment's sentence (`prints x` / `prints to stderr x`) as a row */
export function printRow(text: string, step: number): Msg {
  if (text.startsWith('prints to stderr ')) return row('print', 'stderr', text.slice('prints to stderr '.length), step);
  return row('print', 'stdout', text.startsWith('prints ') ? text.slice('prints '.length) : text, step);
}

// -- the source of a statement --------------------------------------------------------------------------------

/** the raw lines of a range: the first from its column, the last to its end column */
export function rangeLines(lines: string[], r: number[]): string[] {
  const [a, ca, b, cb] = r.map(Number) as [number, number, number, number];
  if (a < 1 || b < a || b > lines.length) return [];
  if (a === b) return [lines[a - 1]!.slice(ca, cb)];
  return [lines[a - 1]!.slice(ca), ...lines.slice(a, b - 1), lines[b - 1]!.slice(0, cb)];
}

/**
 * Compound headers (the code starts with `if`/`for`/`while`/`do`/`switch`/`try`, a function or
 * class declaration, a label, or a `{` follows the range, closing parentheses skipped), imports
 * and re-exports, `break`/`continue`/`debugger`, type declarations and directives make no node.
 */
export function notAStatement(lines: string[], rng: number[]): boolean {
  const first = stripComments([lines[Number(rng[0]) - 1]!.slice(Number(rng[1]))])[0]!.trim();
  const after = stripComments([lines[Number(rng[2]) - 1]!.slice(Number(rng[3]))])[0]!.replace(/^[) \t]+/, '');
  if (!first || first === ';' || first.startsWith('{') || after.startsWith('{')) return true;
  if (HEADER.test(first) || DECLARATION.test(first) || TYPE_DECLARATION.test(first) || IMPORT.test(first)) return true;
  if (JUMP.test(first) || LABEL.test(first)) return true;
  return DIRECTIVE.test(first);
}

// -- the passes over the builder ------------------------------------------------------------------------------

/** S1, S2, S7: one record per (fileId, line) a user-code step ran, at most STATEMENTS_MAX per parent */
export function collectStatements(b: any): void {
  const trace = b.trace;
  const hits = new Map<number, number>();
  for (let i = 0; i < trace.count; i++) {
    const rid = trace.rid(i);
    hits.set(rid, (hits.get(rid) ?? 0) + 1);
  }
  const statementRids = new Map<number, Set<number>>();
  const perParent = new Map<string, number>();
  for (let i = 0; i < trace.count; i++) {
    if (!b.inWindow(i)) continue;
    const rid = trace.rid(i);
    const loc = b.run.locate(rid);
    if (loc === null) continue;
    const fid = Number(loc.fileId);
    if (!b.mb.user(fid)) continue;
    if (!statementRids.has(fid)) {
      const f = b.run.files.get(fid) ?? {};
      statementRids.set(fid, new Set(((f.statements ?? []) as unknown[]).map(Number)));
    }
    if (!statementRids.get(fid)!.has(Number(loc.localRid))) continue;
    const rng = loc.range;
    const sk = `${fid}:${Number(rng[0])}`;
    if (b.statements.has(sk)) continue;
    const scope = trace.scope(trace.scopeId(i));
    if (!scope || !b.userScope(scope)) continue;
    const parent = b.scopeKey(scope);
    if (parent === null || !b.nodes.has(parent)) continue;
    const lines: string[] = b.run.sourceLines(fid);
    const raw = rangeLines(lines, rng);
    if (!raw.length || notAStatement(lines, rng)) continue;
    if ((perParent.get(parent) ?? 0) >= STATEMENTS_MAX) {
      b.truncated = true;
      continue;
    }
    perParent.set(parent, (perParent.get(parent) ?? 0) + 1);
    const code = stripComments(raw).join(' ');
    const [targets, reads] = namesOf(raw);
    const line = Number(rng[0]);
    b.statements.set(sk, { key: `s:${sk}`, kind: 'statement', parent, label: collapse(code, LABEL_MAX), file: b.run.filePath(fid), line, fileId: fid, text: collapse(code, TEXT_MAX), targets, reads, firstStep: i, hits: hits.get(rid) ?? 0, rows: [] });
  }
}

/**
 * S4: the first value moment of a statement is its `out` row, the first print its `print` row,
 * every error moment located on it a `raised` row (else the raise lands on the function node).
 */
export function statementRows(b: any): void {
  const seen = new Set<string>();
  for (const m of b.moments as Msg[]) {
    const kind = m.kind;
    if (kind !== 'value' && kind !== 'print' && kind !== 'error') continue;
    const stmt: Msg | undefined = b.statementAt(m);
    if (stmt === undefined) {
      if (kind === 'error') {
        const node = b.nodes.get(b.locationKey(m));
        if (node !== undefined) node.rows.push(errorRow(m.text, Number(m.step)));
      }
      continue;
    }
    if (kind === 'error') stmt.rows.push(errorRow(m.text, Number(m.step)));
    else if (!seen.has(`${stmt.key}\0${kind}`)) {
      seen.add(`${stmt.key}\0${kind}`);
      if (kind === 'value' && m.values.length) {
        const v = m.values[0];
        stmt.rows.push(row('out', v.name, v.text, Number(m.step)));
      } else if (kind === 'print') stmt.rows.push(printRow(m.text, Number(m.step)));
    }
  }
}

/** Python's sort key `(firstStep, NODE_RANK[kind], label)` */
export function nodeOrder(a: Msg, b: Msg): number {
  return a.firstStep - b.firstStep || NODE_RANK[a.kind]! - NODE_RANK[b.kind]! || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
}

/**
 * S6: for every name a statement or decision reads, the latest statement or loop under the same
 * parent that assigned it, else the parent function when the name is one of its `in` rows.
 */
export function statementDataEdges(b: any): void {
  const consumers: Msg[] = [...b.statements.values(), ...b.decisions.values()].sort(nodeOrder);
  const producers = consumers.filter((n) => n.kind === 'statement' || n.loop);
  for (const c of consumers) {
    for (const name of c.reads as string[]) {
      let best: Msg | null = null;
      for (const p of producers) {
        if (p.parent === c.parent && p.firstStep < c.firstStep && p.targets.includes(name) && (best === null || p.firstStep > best.firstStep)) best = p;
      }
      let src: string;
      if (best !== null) src = best.key;
      else {
        const parent = b.nodes.get(c.parent);
        if (parent === undefined || parent.kind !== 'function' || !parent.rows.some((r: Msg) => r.kind === 'in' && r.name === name)) continue;
        src = parent.key;
      }
      const dk = JSON.stringify([src, c.key, name]);
      if (!b.dataEdges.has(dk)) b.dataEdges.set(dk, { from: src, to: c.key, kind: 'data', label: name, firstStep: c.firstStep });
    }
  }
}
