/**
 * Where a bad value was made (`origin`): a chain of steps from the failing statement back to its
 * source, as Pyokka's `agent/origin/__init__.py`.
 *
 * `why` stops at a function's parameter. `origin` keeps going across calls and containers:
 *
 * - a parameter to the argument at the call site (the call found in the call-site statement's
 *   AST, the parameter mapped by position; a callback's element parameter to the array element
 *   with the same text),
 * - a name to the statement that bound it (`History.valueAt`, the recorded locals),
 * - a call result to the callee's `return` and the expression it returned,
 * - an element of a container to the statement that put it there,
 * - down to a literal, or to a value computed from more than one input.
 *
 * Every link says its footing: `recorded` (structural), `inferred` (picked by value among
 * structural candidates) or `text match` (only the text says so). The root is the first link,
 * forward in time, from which the value has the form that failed: a statement whose other runs
 * made a value that fits, else the earliest link that already carries the failing value.
 */
import { parse, pathText, project, textOf, typeOf, typeOfValue } from '../reprs.ts';
import type { SavedRun } from '../source.ts';
import { NAME } from '../../protocol.ts';
import { headerNodes, unwrap, type Node } from './js.ts';
import { Need, needFromError } from './need.ts';
import { callbackTargets, evaluate, pick } from './pick.ts';
import { markRoot } from './root.ts';
import { ORIGIN_DEPTH, ORIGIN_MAX_DEPTH, OriginBuilder } from './walk.ts';
import { parseSync } from '../../parse.ts';

type Msg = Record<string, any>;

function errorAt(run: SavedRun, step: number): Msg | null {
  const rid = run.trace.rid(step);
  let best: Msg | null = null;
  for (const ev of run.errors) {
    if (ev.step === null || ev.step === undefined) continue;
    const first = Number(ev.step);
    const last = Number(ev.lastStep ?? ev.step);
    if (first === step || (Number(ev.rid ?? -1) === rid && first <= step && step <= last)) {
      best = ev;
      if (first === step) break;
    }
  }
  return best;
}

/** an EXPR as JavaScript: a name or an access chain of one (`items[0].price`, `m.get('k')`); null otherwise */
function parseAccess(expr: string): Node | null {
  try {
    const r = parseSync('x.js', `(${expr});`, { sourceType: 'module', lang: 'js' } as any);
    if (r.errors?.length || r.program.body.length !== 1) return null;
    return unwrap(r.program.body[0].expression) ?? null;
  } catch {
    return null;
  }
}

function readsOf(b: OriginBuilder, step: number): Msg[] {
  return b.history.readsFor(step).filter((r) => typeOf(r.text) !== 'function' && !String(r.text ?? '').startsWith('<class '));
}

/** the chain from the value at `step` back to where it was made */
export function origin(run: SavedRun, step: number, expr = '', depth = ORIGIN_DEPTH): Msg {
  const b = new OriginBuilder(run, depth);
  const out: Msg = { ...b.history.location(step), statement: b.statement(step), recordedLocals: run.localsEntries.length > 0, links: [], root: null, truncated: false };
  const error = errorAt(run, step);
  let need: Need | null = null;
  if (error !== null) {
    out.error = { type: String(error.errorType || ''), message: String(error.message || ''), caught: !!error.handled };
    need = needFromError(out.error.type, out.error.message);
  }
  if (!run.localsEntries.length) {
    out.end = 'this run recorded no locals, so values cannot be followed back';
    out.hint = `save the run again with locals: \`${NAME} run FILE --save run.json --record-locals\``;
    return out;
  }
  let picked: Msg | null = null;
  const named = expr.trim();
  if (named) {
    const tree = parseAccess(named);
    const node = b.stmt(step);
    const comp = node !== null ? callbackTargets(headerNodes(node)) : new Map();
    const access = tree && (tree.type === 'Identifier' || tree.type === 'ThisExpression' || tree.type === 'MemberExpression' || tree.type === 'CallExpression');
    let hits = access ? evaluate(b, tree, step, comp) : [];
    if (need !== null && need.kind === 'type' && need.bad) hits = hits.filter((h) => typeOfValue(h[2]) === need!.bad).length ? hits.filter((h) => typeOfValue(h[2]) === need!.bad) : hits;
    if (!hits.length) {
      out.end = `${named} has no recorded value at #${step}; give a name or a property path of one (items[0].price)`;
      out.reads = readsOf(b, step);
      return out;
    }
    const [base, path, value] = hits[0]!;
    let text = textOf(value);
    if (text === null) {
      const found = b.value(base, step);
      text = path.length ? textOf(project(parse(found.text), path)) : (found.text ?? null);
    }
    picked = { expr: pathText(base, path), base, path, text, chosen: 'named' };
    // the named value is not the one the error is about, so the error says nothing of its form
    if (need !== null && (need.kind === 'type' && need.bad ? typeOf(text) !== need.bad : need.fits(text) !== false)) need = null;
  } else if (need !== null) picked = pick(b, step, need, out.error.type);
  if (picked === null) {
    out.reads = readsOf(b, step);
    out.end = error === null ? `no exception at #${step}: give EXPR, one of the values the statement read` : `could not tell which value the ${out.error.type} is about: give EXPR, one of the values the statement read`;
    return out;
  }
  out.value = { expr: picked.expr, text: picked.text, type: typeOf(picked.text), chosen: picked.chosen };
  if (need !== null && need.describe()) out.need = need.describe();
  b.add(step, picked.expr, picked.text, 'read', 'recorded', error !== null ? 'the failing statement reads it' : 'read here');
  b.followName(picked.base, [...picked.path], step, picked.text);
  const root = markRoot(b, need, error !== null);
  for (const link of b.links) {
    delete link.scopeReturned;
    delete link._sib;
  }
  out.links = b.links;
  out.root = root;
  out.truncated = b.truncated;
  out.end = b.truncated ? `the chain is longer than ${b.depth} links; raise --depth` : b.end;
  if (root === null && b.links.length) out.rootUnknown = 'the chain stops before a statement that made the value, so its root is not known';
  return out;
}

export { ORIGIN_DEPTH, ORIGIN_MAX_DEPTH, OriginBuilder, Need, needFromError };
