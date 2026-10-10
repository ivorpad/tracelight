/**
 * What the statements of a JS/TS file *are*, for the host's walkthrough and execution graph: the
 * table `src/session/decisions.ts` otherwise reads from Python's indentation, built here from the
 * AST and sent on `file.instrumented` as `walk`. Shapes as decisions.ts (1-based lines):
 *
 * - `decisions`: `if` (label `if`, or `else if` for an `if` that is another's `else`) with `body`
 *   and `orelse` line spans; `switch` as `{kind: 'match', keyword: 'switch', arms}` (`case X` /
 *   `default`).
 * - `loops`: `for` (`for`, `for in`, `for of`, `for await`) and `while` (`while`, `do ... while`).
 * - `returns`: lines holding a `return`.
 * - `functions`: `{name, line, end}` from the instrumenter's function table.
 * - `names`: what each statement assigns and reads (the `bindings` table), for the execution
 *   graph's data edges; Python's are scanned from the source text instead.
 */
import { bindingsOf, type StatementBinding } from './bindings.ts';

type Node = any;

export interface WalkTable {
  decisions: Record<string, unknown>[];
  loops: { kind: 'for' | 'while'; line: number; col: number; text: string; end: number }[];
  returns: number[];
  functions: { name: string; line: number; end: number }[];
  names: { line: number; col: number; assigns: string[]; reads: string[] }[];
}

interface Lines {
  pos(offset: number): [number, number];
  line(offset: number): number;
}

const CUT = 60;
function collapse(text: string): string {
  const s = text.trim().split(/\s+/).join(' ');
  return s.length <= CUT ? s : s.slice(0, CUT - 1) + '…';
}

export function walkTable(program: Node, js: string, lines: Lines, functions: { name: string; bodyRange: number[] }[]): WalkTable {
  const out: WalkTable = { decisions: [], loops: [], returns: [], functions: functions.filter((f) => f.name !== '<module>').map((f) => ({ name: f.name, line: f.bodyRange[0]!, end: f.bodyRange[2]! })), names: [] };
  // JS headers read as written: `if (n > 90)`, `for (const x of xs)`, `switch (kind)`
  const text = (n: Node) => collapse(`(${js.slice(n.start, n.end)})`);
  const line = (off: number) => lines.pos(off)[0];
  /** where the header statement starts: a loop body on the header's line steps on the same line */
  const col = (off: number) => lines.pos(off)[1];
  /** the lines a branch's statements cover: a block's first statement through its last; [0, 0] when empty */
  const span = (n: Node | null | undefined): [number, number] => {
    if (!n) return [0, 0];
    if (n.type === 'BlockStatement') {
      const body = n.body ?? [];
      if (!body.length) return [0, 0];
      return [line(body[0].start), line(body[body.length - 1].end - 1)];
    }
    return [line(n.start), line(n.end - 1)];
  };
  const elseIfs = new WeakSet<object>();
  const visit = (n: Node): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      for (const x of n) visit(x);
      return;
    }
    if (typeof n.type !== 'string') return;
    switch (n.type) {
      case 'IfStatement': {
        if (n.alternate?.type === 'IfStatement') elseIfs.add(n.alternate);
        // the else arm of a chain runs from the `else if` header through the end of the chain, as Python's `elif`
        const orelse: [number, number] = n.alternate ? (n.alternate.type === 'IfStatement' ? [line(n.alternate.start), line(n.alternate.end - 1)] : span(n.alternate)) : [0, 0];
        out.decisions.push({ kind: 'if', label: elseIfs.has(n) ? 'else if' : 'if', line: line(n.start), col: col(n.start), text: text(n.test), body: span(n.consequent), orelse, js: true });
        break;
      }
      case 'SwitchStatement': {
        const arms = (n.cases ?? []).map((c: Node) => {
          const body = c.consequent ?? [];
          const only = body.length === 1 && body[0].type === 'BlockStatement' ? span(body[0]) : body.length ? ([line(body[0].start), line(body[body.length - 1].end - 1)] as [number, number]) : ([0, 0] as [number, number]);
          return { text: c.test ? collapse(js.slice(c.test.start, c.test.end)) : 'default', body: only, default: !c.test };
        });
        out.decisions.push({ kind: 'match', keyword: 'switch', line: line(n.start), col: col(n.start), text: text(n.discriminant), arms, js: true });
        break;
      }
      case 'ForStatement':
        out.loops.push({ kind: 'for', line: line(n.start), col: col(n.start), text: collapse(`(${[n.init, n.test, n.update].map((p) => (p ? js.slice(p.start, p.end) : '')).join('; ')})`), end: line(n.end - 1) });
        break;
      case 'ForInStatement':
      case 'ForOfStatement':
        out.loops.push({ kind: 'for', line: line(n.start), col: col(n.start), text: collapse(`${n.await ? 'await ' : ''}(${js.slice(n.left.start, n.left.end)} ${n.type === 'ForInStatement' ? 'in' : 'of'} ${js.slice(n.right.start, n.right.end)})`), end: line(n.end - 1) });
        break;
      case 'WhileStatement':
        out.loops.push({ kind: 'while', line: line(n.start), col: col(n.start), text: text(n.test), end: line(n.end - 1) });
        break;
      case 'DoWhileStatement':
        // the header the trace steps on is the `do` line; the test is at the end
        out.loops.push({ kind: 'while', line: line(n.start), col: col(n.start), text: text(n.test), end: line(n.end - 1) });
        break;
      case 'ReturnStatement':
        out.returns.push(line(n.start));
        break;
    }
    for (const k in n) {
      if (k === 'type' || k === 'start' || k === 'end') continue;
      const v = n[k];
      if (v && typeof v === 'object') visit(v);
    }
  };
  visit(program.body);
  out.names = bindingsOf(program, js, lines).map((b: StatementBinding) => ({ line: b.line, col: b.col, assigns: b.assigns, reads: b.reads }));
  return out;
}
