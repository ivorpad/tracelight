/**
 * The walk behind `origin`: from a name at a step back through arguments, returns, assignments
 * and containers, over the oxc AST (`js.ts`).
 *
 * JavaScript differs from Python in a few places the walk knows about: a missing argument or a
 * function that ends without `return` gives `undefined`; a callback of `map` / `reduce` / ... gets
 * its parameter from an element of the array (matched by text, `inferred`); an expression-bodied
 * arrow returns its body; and the recorder leaves out a name's first value when it is `undefined`
 * (it cannot tell it from "declared, not assigned yet"), so a name whose assigning statement ran
 * with no recorded change is read as `undefined` when the statement's right side was one.
 */
import { History, isDefinition, previousStepInScope } from '../history.ts';
import { MomentBuilder } from '../moments.ts';
import { calleeName } from '../provenance.ts';
import { pyStrip } from '../recording.ts';
import { UNKNOWN, parse, pathText, project, textOf, typeOf } from '../reprs.ts';
import type { SavedRun } from '../source.ts';
import { elementSearch, inserts, type Insert } from './containers.ts';
import { ELEMENT_CALLBACKS, JsFile, baseName, constantKey, headerNodes, isFunction, isLiteral, namesIn, patternNames, propertyName, unwrap, walk, type Node } from './js.ts';
import { evaluate } from './pick.ts';

type Msg = Record<string, any>;
export type Key = string | number;

export const ORIGIN_DEPTH = 20;
export const ORIGIN_MAX_DEPTH = 60;
export const MUTATIONS_SKIPPED_MAX = 10_000;

/** calls whose result is usually a function, which the recorder does not record either */
const FUNCTION_MAKERS = new Set(['bind', 'require', 'debounce', 'throttle', 'memoize', 'curry', 'compose', 'pipe']);
const LOGICAL_ASSIGN = new Set(['=', '??=', '||=', '&&=']);

/** `name[k] = v`, `name.x = v`, `name.x++`, `delete name.x` or `name.push(v)`: the statement changes `name` in place */
export function isMutation(node: Node, name: string): boolean {
  if (!node || node.type !== 'ExpressionStatement') return false;
  const e = unwrap(node.expression);
  let target: Node = null;
  if (e?.type === 'AssignmentExpression') target = e.left;
  else if (e?.type === 'UpdateExpression') target = e.argument;
  else if (e?.type === 'UnaryExpression' && e.operator === 'delete') target = e.argument;
  else if (e?.type === 'CallExpression') target = e.callee;
  target = unwrap(target);
  return !!target && target.type === 'MemberExpression' && baseName(target) === name;
}

/** the `=` binding of `name` in a statement: its right side, and whether `name` is the whole target (not a part of a pattern) */
export function assignment(node: Node, name: string): { whole: boolean; value: Node; declarator?: Node } | null {
  if (!node) return null;
  const decl = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
  if (decl?.type === 'VariableDeclaration') {
    const own = decl.declarations.find((d: Node) => patternNames(d.id).includes(name));
    const d = own ?? decl.declarations.find((x: Node) => x.init);
    if (!d) return null;
    return { whole: !!own && d.id.type === 'Identifier', value: d.init, declarator: d };
  }
  if (node.type === 'ExpressionStatement') {
    const e = unwrap(node.expression);
    if (e?.type === 'AssignmentExpression' && LOGICAL_ASSIGN.has(e.operator)) {
      const left = unwrap(e.left);
      if (left.type === 'MemberExpression') return null;
      return { whole: left.type === 'Identifier' && left.name === name, value: e.right };
    }
  }
  return null;
}

/** `x += v`, `x++`: the statement updates `name` from its old value */
function augmented(node: Node, name: string): Node | null {
  if (node?.type !== 'ExpressionStatement') return null;
  const e = unwrap(node.expression);
  if (e?.type === 'AssignmentExpression' && !LOGICAL_ASSIGN.has(e.operator) && unwrap(e.left).type === 'Identifier' && unwrap(e.left).name === name) return e;
  if (e?.type === 'UpdateExpression' && unwrap(e.argument).type === 'Identifier' && unwrap(e.argument).name === name) return e;
  return null;
}

function rawString(text: string | null | undefined): string | null {
  if (typeOf(text) !== 'string') return null;
  const value = parse(text);
  return typeof value === 'string' && value ? value : null;
}

function lastName(name: unknown): string {
  return String(name).split('.').pop()!;
}

/** `m.get(k)`: a Map read, followed as the key `k` of `m` */
export function isMapGet(n: Node): boolean {
  return n?.type === 'CallExpression' && n.arguments.length === 1 && unwrap(n.callee)?.type === 'MemberExpression' && propertyName(unwrap(n.callee)) === 'get';
}

export class OriginBuilder {
  readonly run: SavedRun;
  readonly trace: SavedRun['trace'];
  readonly history: History;
  readonly moments: MomentBuilder;
  readonly depth: number;
  readonly scopesBySite = new Map<number, Msg[]>();
  readonly scopesByRid = new Map<number, Msg[]>();
  readonly files = new Map<number, JsFile>();
  readonly insertCache = new Map<number, Insert[]>();
  links: Msg[] = [];
  end = '';
  truncated = false;
  readonly visited = new Set<string>();
  certaintyNext: string | null = null;
  /** why the next link is not `recorded` */
  whyNext: string | null = null;

  constructor(run: SavedRun, depth = ORIGIN_DEPTH) {
    this.run = run;
    this.trace = run.trace;
    this.history = new History(run);
    this.moments = new MomentBuilder(run);
    this.depth = Math.max(2, Math.min(ORIGIN_MAX_DEPTH, Math.trunc(depth)));
    const scopes = this.trace.scopes.filter((s) => Number(s.parent ?? -1) >= 0).sort((a, b) => Number(a.first) - Number(b.first));
    for (const s of scopes) {
      const site = this.moments.callSite(s);
      if (!this.scopesBySite.has(site)) this.scopesBySite.set(site, []);
      this.scopesBySite.get(site)!.push(s);
      const rid = Number(s.rid);
      if (!this.scopesByRid.has(rid)) this.scopesByRid.set(rid, []);
      this.scopesByRid.get(rid)!.push(s);
    }
  }

  // -- source -------------------------------------------------------------------------------------------
  file(fid: number): JsFile {
    let f = this.files.get(fid);
    if (!f) {
      f = new JsFile(this.run.sourceLines(fid).join('\n'), this.run.filePath(fid) ?? 'x.js');
      this.files.set(fid, f);
    }
    return f;
  }

  stmt(step: number): Node | null {
    const loc = this.trace.location(step);
    if (!loc) return null;
    return this.file(loc[0]).at(Number(loc[1][0]), Number(loc[1][1]));
  }

  seg(step: number, node: Node): string {
    const loc = this.trace.location(step);
    const text = loc ? this.file(loc[0]).segment(node) : '';
    return text || String(node?.type ?? '');
  }

  statement(step: number): string | null {
    const loc = this.trace.location(step);
    if (!loc) return null;
    const lines = this.run.sourceLines(loc[0]);
    const line = Number(loc[1][0]);
    return line > 0 && line <= lines.length ? pyStrip(lines[line - 1]!) : null;
  }

  inserts(step: number): Insert[] {
    return inserts(this, step);
  }

  // -- values -------------------------------------------------------------------------------------------
  value(name: string, step: number): Msg {
    const loc = this.trace.location(step);
    const sid = this.trace.scopeId(step);
    const found = this.history.valueAt(name, step, sid, loc ? loc[0] : -1);
    if (found.text !== null && found.text !== undefined) return found;
    return this.unrecorded(name, step, sid, 0) ?? found;
  }

  /**
   * A name the recording has no value for, though a statement of its scope bound it before
   * `step`: the recorder leaves out a first value of `undefined`, so when that statement's right
   * side (or the call site's argument, for a parameter) is `undefined`, so is the name.
   */
  unrecorded(name: string, step: number, sid: number, depth: number): Msg | null {
    if (!this.history.observedAll || depth > 3) return null;
    const scope = this.trace.scope(sid);
    const first = scope ? Number(scope.first) : 0;
    for (let j = step - 1; j >= first && j >= 0; j--) {
      if (this.trace.scopeId(j) !== sid) continue;
      const binding = this.history.bindingAt(j);
      if (!binding || !(binding.assigns ?? []).includes(name)) continue;
      const node = this.stmt(j);
      let text: string | null = null;
      if (isFunction(node) && scope && j === first) {
        const bound = this.callArgument(node, name, scope);
        if (bound && bound.arg === null && bound.missing && !this.defaultOf(node, name)) text = 'undefined';
        else if (bound?.arg) text = this.exprText(bound.arg, bound.site, depth + 1);
      } else {
        const a = assignment(node, name);
        if (a?.whole) text = a.value ? this.exprText(a.value, j, depth + 1) : 'undefined';
      }
      return text === 'undefined' ? { name, text, source: 'locals', step: j } : null;
    }
    return null;
  }

  /** the text of an expression the recording holds the value of: a name, a constant, a member of a name, a stepped call's result */
  exprText(node: Node, step: number, depth = 0): string | null {
    node = unwrap(node);
    if (!node) return null;
    if (node.type === 'Identifier') {
      if (node.name === 'undefined') return 'undefined';
      const found = this.history.valueAt(node.name, step, this.trace.scopeId(step), this.trace.location(step)?.[0] ?? -1);
      if (found.text !== null && found.text !== undefined) return String(found.text);
      return this.unrecorded(node.name, step, this.trace.scopeId(step), depth + 1)?.text ?? null;
    }
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      const scopes = this.calleeScopes(step, calleeName(this.seg(step, node)));
      if (scopes.length) {
        const s = scopes[scopes.length - 1]!;
        if ('returned' in s) return s.returned === null ? 'undefined' : String(s.returned);
        return null;
      }
      // a builtin's result (`xs.forEach(f)`): the name would have been recorded unless it is undefined or a function
      const callee = calleeName(this.seg(step, node));
      if (node.type === 'CallExpression' && !FUNCTION_MAKERS.has(callee) && !/^[A-Z]/.test(callee)) return 'undefined';
    }
    return this.simpleText(node, [], step);
  }

  scopeOf(step: number): Msg | undefined {
    return this.trace.scope(this.trace.scopeId(step));
  }

  calleeScopes(site: number, name: string): Msg[] {
    const out: Msg[] = [];
    for (const s of this.scopesBySite.get(site) ?? []) {
      const sname = lastName(s.name);
      if (sname === name || ((sname === 'constructor' || sname === '__init__') && /^[A-Z]/.test(name))) out.push(s);
    }
    return out;
  }

  // -- links --------------------------------------------------------------------------------------------
  add(step: number, expr: string, text: string | null | undefined, how: string, certainty = 'recorded', note: string | null = null, extra: Msg = {}): Msg | null {
    if (this.links.length >= this.depth) {
      this.truncated = true;
      return null;
    }
    if (this.certaintyNext && certainty === 'recorded') {
      certainty = this.certaintyNext;
      if (this.whyNext) note = note ? `${note}; ${this.whyNext}` : this.whyNext;
    }
    this.certaintyNext = null;
    this.whyNext = null;
    const link: Msg = { ...this.history.location(step), expr, how, certainty };
    if (text !== null && text !== undefined) {
      link.text = text;
      const t = typeOf(text);
      if (t) link.type = t;
    }
    if (note) link.note = note;
    const statement = this.statement(step);
    if (statement !== null) link.statement = statement;
    Object.assign(link, extra);
    this.links.push(link);
    return link;
  }

  full(): boolean {
    if (this.links.length >= this.depth) {
      this.truncated = true;
      return true;
    }
    return false;
  }

  // -- the walk -----------------------------------------------------------------------------------------
  followName(name: string, path: Key[], step: number, carried: string | null): void {
    if (this.full()) return;
    const key = JSON.stringify(['name', name, path.map((k) => (typeof k === 'string' ? `s${k}` : `n${k}`)), step]);
    if (this.visited.has(key)) {
      this.end = `the chain loops back to ${name} at #${step}`;
      return;
    }
    this.visited.add(key);
    const found = this.value(name, step);
    if (found.step === null || found.step === undefined) {
      // a parameter of a scope whose locals were not recorded (an expression-bodied arrow): its call site
      const scope = this.scopeOf(step);
      const fn = scope ? this.stmt(Number(scope.first)) : null;
      if (scope && isFunction(fn) && (fn.params ?? []).some((p: Node) => patternNames(p).includes(name))) {
        this.argument(fn, name, path, Number(scope.first), scope, carried);
        return;
      }
      if (path.length) {
        elementSearch(this, path, step, carried);
        return;
      }
      if (found.text !== null && found.text !== undefined) this.end = `${name} is a definition (a function or class), made by no step`;
      else this.end = `nothing recorded ${name} before #${step} (made in code the recording does not show, or before it started)`;
      return;
    }
    let made = Number(found.step);
    const whole = found.text;
    const projected = path.length ? textOf(project(parse(whole), path)) : whole;
    const text = projected !== null && projected !== undefined ? projected : carried;
    made = this.madeBy(name, made);
    let node = this.stmt(made);
    if (!isMutation(node, name)) {
      // changes in place the recording did not see (an object that keeps its identity keeps its recorded text)
      const unseen = this.unseenMutations(name, made, step);
      if (unseen.length && path.length) {
        for (const j of unseen) {
          const set = this.setTarget(this.stmt(j), name, j);
          if (set && set.key === path[0]) {
            this.mutation(this.stmt(j), name, path, j, carried ?? text, carried);
            return;
          }
        }
      } else if (unseen.length) {
        let note = 'changed in place';
        if (unseen.length > 1) note += `; ${unseen.length - 1} earlier change${unseen.length === 2 ? '' : 's'} in place not shown`;
        if (this.add(unseen[0]!, name, carried ?? text, 'assigned', 'recorded', note) === null) return;
      }
    }
    const scope = this.scopeOf(made);
    const expr = pathText(name, path);
    if (isFunction(node) && scope && Number(scope.first) === made) {
      this.argument(node, name, path, made, scope, text);
      return;
    }
    if (node && (node.type === 'ForOfStatement' || node.type === 'ForInStatement')) {
      if (path.length) {
        elementSearch(this, path, step, carried);
        return;
      }
      if (this.add(made, expr, text, 'element', 'recorded', `loop variable over ${this.seg(made, node.right)}`) === null) return;
      if (node.type === 'ForOfStatement') this.followExpr(node.right, [], made, null);
      else this.end = `${name} is a key of ${this.seg(made, node.right)}`;
      return;
    }
    if (node && isMutation(node, name)) {
      this.mutation(node, name, path, made, text, carried);
      return;
    }
    const a = assignment(node, name);
    if (a && (a.value || a.whole)) {
      if (!a.value) {
        // `let x;`: declared without a value
        this.add(made, this.seg(made, a.declarator), text, 'literal', 'recorded', 'declared without a value');
        this.end = `${name} was declared without a value, so it is undefined`;
        return;
      }
      if (isLiteral(a.value) && a.whole) {
        this.literal(made, expr, text, a.value, path);
        return;
      }
      if (this.add(made, expr, text, 'assigned', 'recorded', null, { _sib: [name, this.trace.rid(made), made] }) === null) return;
      if (a.whole) this.followExpr(a.value, path, made, text);
      // destructuring (`const [a, b] = f()`): the value is one part of what the right side made
      else this.computed(a.value, made, text, true);
      return;
    }
    const aug = augmented(node, name);
    if (aug) {
      if (this.add(made, expr, text, 'assigned', 'recorded', `updated in place (${this.seg(made, aug)})`) === null) return;
      const from = aug.type === 'UpdateExpression' ? '1' : this.seg(made, aug.right);
      this.end = `${name} is computed at #${made} from its old value and ${from}; ask origin for one of them`;
      return;
    }
    if (this.add(made, expr, text, 'assigned') === null) return;
    if (path.length) elementSearch(this, path, made, carried);
    else this.end = `${name} was bound by ${node ? node.type : 'a statement the source no longer has'}, which origin does not follow`;
  }

  /** `name` was changed in place at `made`. With a path whose first key the statement sets, that is the element's link */
  mutation(node: Node, name: string, path: Key[], made: number, text: string | null, carried: string | null): void {
    if (path.length) {
      const set = this.setTarget(node, name, made);
      if (set && set.key === path[0]) {
        if (this.add(made, this.seg(made, set.value), text, 'element', 'recorded', `set as ${pathText(name, [set.key])}`) === null) return;
        this.followExpr(set.value, path.slice(1), made, text);
        return;
      }
      elementSearch(this, path, made + 1, carried);
      return;
    }
    if (this.add(made, pathText(name, path), text, 'assigned', 'recorded', 'changed in place') === null) return;
    // the earlier changes in place are the same object filling up: jump to the statement that made it
    let skipped = 0;
    let at = made;
    while (skipped < MUTATIONS_SKIPPED_MAX) {
      const before = this.value(name, at);
      if (before.step === null || before.step === undefined || Number(before.step) >= at) break;
      const prev = this.madeBy(name, Number(before.step));
      const prevNode = this.stmt(prev);
      if (prevNode === null || !isMutation(prevNode, name)) {
        if (skipped) this.links[this.links.length - 1]!.note += `; ${skipped} earlier change${skipped === 1 ? '' : 's'} in place not shown`;
        this.followName(name, [], at, null);
        return;
      }
      skipped++;
      at = prev;
    }
    this.end = `${name} was changed in place ${skipped + 1} times; the statement that made it is not in the recording`;
  }

  /** `name[k] = v`, `name.k = v`, `name.set(k, v)`: the key the statement sets on `name` itself, and the value */
  setTarget(node: Node, name: string, step: number): { key: Key; value: Node } | null {
    const e = node?.type === 'ExpressionStatement' ? unwrap(node.expression) : null;
    let k: unknown = UNKNOWN;
    let value: Node = null;
    if (e?.type === 'AssignmentExpression' && LOGICAL_ASSIGN.has(e.operator)) {
      const t = unwrap(e.left);
      if (t.type === 'MemberExpression' && unwrap(t.object)?.type === 'Identifier' && unwrap(t.object).name === name) {
        k = t.computed ? this.keyOf(t.property, step) : (propertyName(t) ?? UNKNOWN);
        value = e.right;
      }
    } else if (e?.type === 'CallExpression' && propertyName(unwrap(e.callee)) === 'set' && e.arguments.length === 2) {
      const c = unwrap(e.callee);
      if (unwrap(c.object)?.type === 'Identifier' && unwrap(c.object).name === name) {
        k = this.keyOf(e.arguments[0], step);
        value = e.arguments[1];
      }
    }
    return typeof k === 'string' || typeof k === 'number' ? { key: k, value } : null;
  }

  /**
   * The step that made a change attributed to `made`: a change observed at a statement that does
   * not bind the name was made by a method call before it, which changed the object in place
   * (`m.set(k, v)`; the bindings list what a statement assigns, not what its calls change).
   */
  madeBy(name: string, made: number): number {
    if (isMutation(this.stmt(made), name) || (this.history.bindingAt(made)?.assigns ?? []).includes(name)) return made;
    const prev = previousStepInScope(this.run, made, this.trace.scopeId(made));
    return prev >= 0 && isMutation(this.stmt(prev), name) ? prev : made;
  }

  /** the statements of `made`'s scope after it and before `step` that change `name` in place, latest first */
  unseenMutations(name: string, made: number, step: number): number[] {
    const sid = this.trace.scopeId(made);
    const out: number[] = [];
    for (let j = step - 1; j > made; j--) if (this.trace.scopeId(j) === sid && isMutation(this.stmt(j), name)) out.push(j);
    return out;
  }

  /** the calls at the call site of `scope` that name its function */
  callsTo(site: number, siteNode: Node, fname: string): Node[] {
    return walk(headerNodes(siteNode).length ? headerNodes(siteNode) : [siteNode])
      .map(([n]) => n)
      .filter((c) => {
        if (c.type !== 'CallExpression' && c.type !== 'NewExpression') return false;
        const callee = calleeName(this.seg(site, c));
        return callee === fname || ((fname === 'constructor' || fname === '__init__') && (c.type === 'NewExpression' || /^[A-Z]/.test(callee)));
      });
  }

  /** the call that entered `scope` and the argument it passed for `param` (null with `missing` when it passed none) */
  callArgument(fn: Node, param: string, scope: Msg): { site: number; call: Node; arg: Node | null; missing: boolean } | null {
    const site = this.moments.callSite(scope);
    const siteNode = this.stmt(site);
    if (site === Number(scope.first) || siteNode === null) return null;
    const fname = lastName(scope.name);
    const calls = this.callsTo(site, siteNode, fname);
    if (!calls.length) return null;
    const same = this.calleeScopes(site, fname);
    let idx = same.findIndex((s) => Number(s.scopeId) === Number(scope.scopeId));
    if (idx < 0) idx = 0;
    const call = calls.length === same.length ? calls[Math.min(idx, calls.length - 1)] : calls[0];
    const b = OriginBuilder.bind(fn, call, param);
    return { site, call, arg: b.arg, missing: b.missing };
  }

  argument(fn: Node, param: string, path: Key[], made: number, scope: Msg, text: string | null): void {
    const site = this.moments.callSite(scope);
    const siteNode = this.stmt(site);
    const fname = lastName(scope.name);
    if (site === made || siteNode === null) {
      this.add(made, pathText(param, path), text, 'argument', 'recorded', `parameter of ${fname}, called from code the recording does not show`);
      this.end = `${fname} was called from code the recording does not show`;
      return;
    }
    const calls = this.callsTo(site, siteNode, fname);
    if (!calls.length) {
      if (this.callback(fn, param, path, made, site, siteNode, fname, text)) return;
      if (this.add(made, pathText(param, path), text, 'argument', 'recorded', `parameter of ${fname}; the call at #${site} does not name it (a callback)`) === null) return;
      if (path.length) elementSearch(this, path, made, text);
      else this.end = `${fname} was called back by code the recording does not show, from #${site}`;
      return;
    }
    const bound = this.callArgument(fn, param, scope)!;
    const { call, arg } = bound;
    if (arg === null) {
      const dflt = this.defaultOf(fn, param);
      if (dflt) {
        this.add(made, `${param}=${this.seg(made, dflt)}`, text, 'literal', 'recorded', `default value of ${fname}'s parameter ${param}`);
        this.end = `the default value of ${param}`;
        return;
      }
      if (param === 'this') {
        this.add(site, this.seg(site, call), text, 'argument', 'recorded', `this of ${fname}, the object ${call.type === 'NewExpression' ? 'new' : 'the call'} made`);
        this.end = `this is the object ${this.seg(site, call)} made`;
        return;
      }
      if (bound.missing) {
        this.add(site, this.seg(site, call), text, 'argument', 'recorded', `${param} of ${fname}, not passed, so it is undefined`);
        this.end = `${param} was not passed to ${fname}, so it is undefined`;
        return;
      }
      this.add(site, this.seg(site, call), text, 'argument', 'recorded', `${param} of ${fname}, passed through a spread or a destructured parameter`);
      this.end = `${param} reached ${fname} through a spread or a destructured parameter`;
      return;
    }
    const sib = path.length ? null : [param, this.trace.rid(made), made];
    if (this.add(site, path.length ? pathText(this.seg(site, arg), path) : this.seg(site, arg), text, 'argument', 'recorded', `${param} of ${fname}`, { _sib: sib }) === null) return;
    this.followExpr(arg, path, site, text);
  }

  /**
   * `xs.map((x) => …)`: the callback's element parameter is an element of `xs`. The recording does
   * not say which, so the element whose text is the carried value is taken (`inferred`).
   */
  callback(fn: Node, param: string, path: Key[], made: number, site: number, siteNode: Node, fname: string, text: string | null): boolean {
    for (const [n] of walk(headerNodes(siteNode))) {
      if (n.type !== 'CallExpression' || !n.arguments.length || unwrap(n.arguments[0])?.start !== fn.start) continue;
      const callee = unwrap(n.callee);
      const method = callee?.type === 'MemberExpression' ? propertyName(callee) : null;
      if (method === null || !(method in ELEMENT_CALLBACKS)) continue;
      const p = fn.params[ELEMENT_CALLBACKS[method]!];
      if (!p || p.type !== 'Identifier' || p.name !== param) return false;
      const array = unwrap(callee.object);
      const where = this.seg(site, array);
      if (text === null) return false;
      for (const [base, hp, value] of evaluate(this, array, site, new Map())) {
        if (!Array.isArray(value)) continue;
        const hits: number[] = [];
        value.forEach((_, i) => {
          if (textOf(project(value, [i, ...path])) === text) hits.push(i);
        });
        if (!hits.length) continue;
        const full = [...(hp as Key[]), hits[0]!, ...path];
        let note = `${param} of the ${method} callback (${fname}): element ${hits[0]} of ${where}, matched by value text`;
        if (hits.length > 1) note += `; ${hits.length} elements have the same text, the first is shown`;
        if (this.add(site, pathText(base, full), text, 'element', 'inferred', note) === null) return true;
        this.followName(base, full, site, text);
        return true;
      }
      if (this.add(made, pathText(param, path), text, 'element', 'recorded', `${param} of the ${method} callback over ${where}`) === null) return true;
      this.end = `no element of ${where} at #${site} has the same text`;
      return true;
    }
    return false;
  }

  /** the argument `call` passes for `param` of `fn`; `missing` when the call passes fewer arguments (no spread) */
  static bind(fn: Node, call: Node, param: string): { arg: Node | null; missing: boolean } {
    if (param === 'this') {
      const callee = unwrap(call.callee);
      return { arg: call.type === 'CallExpression' && callee?.type === 'MemberExpression' ? callee.object : null, missing: false };
    }
    const params: Node[] = (fn.params ?? []).map((p: Node) => (p.type === 'TSParameterProperty' ? p.parameter : p));
    const i = params.findIndex((p) => (p.type === 'Identifier' && p.name === param) || (p.type === 'AssignmentPattern' && p.left.type === 'Identifier' && p.left.name === param));
    if (i < 0) return { arg: null, missing: false };
    const args: Node[] = call.arguments ?? [];
    if (args.slice(0, i + 1).some((x) => x.type === 'SpreadElement')) return { arg: null, missing: false };
    if (i < args.length) return { arg: args[i], missing: false };
    return { arg: null, missing: !args.some((x) => x.type === 'SpreadElement') };
  }

  defaultOf(fn: Node, param: string): Node | null {
    for (const raw of fn.params ?? []) {
      const p = raw.type === 'TSParameterProperty' ? raw.parameter : raw;
      if (p.type === 'AssignmentPattern' && p.left.type === 'Identifier' && p.left.name === param) return p.right;
    }
    return null;
  }

  keyOf(node: Node, step: number): unknown {
    const c = constantKey(node);
    if (c) return c.value;
    const n = unwrap(node);
    if (n?.type === 'Identifier') {
      const found = this.value(n.name, step);
      const value = found.text !== null && found.text !== undefined ? parse(found.text) : UNKNOWN;
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null ? value : UNKNOWN;
    }
    return UNKNOWN;
  }

  /** `a.b[0]`, `m.get('k')`: the keys of an access chain and the node it starts from; null keys where one is not known */
  accessKeys(node: Node, step: number): { keys: Key[]; base: Node } {
    const keys: Key[] = [];
    let cur = unwrap(node);
    for (;;) {
      if (cur?.type === 'MemberExpression') {
        const k = cur.computed ? this.keyOf(cur.property, step) : propertyName(cur);
        if (k === UNKNOWN || k === null || (typeof k !== 'string' && typeof k !== 'number')) break;
        keys.unshift(k);
        cur = unwrap(cur.object);
      } else if (isMapGet(cur) && !this.calleeScopes(step, 'get').length) {
        const k = this.keyOf(cur.arguments[0], step);
        if (typeof k !== 'string' && typeof k !== 'number') break;
        keys.unshift(k);
        cur = unwrap(unwrap(cur.callee).object);
      } else break;
    }
    return { keys, base: cur };
  }

  followExpr(nodeIn: Node, path: Key[], step: number, carried: string | null, scope: Msg | null = null): void {
    if (this.full()) return;
    let node = unwrap(nodeIn);
    if (node?.type === 'AwaitExpression') node = unwrap(node.argument);
    if (!node) return;
    if (node.type === 'Identifier' && node.name !== 'undefined') {
      this.followName(node.name, path, step, carried);
      return;
    }
    if (node.type === 'ThisExpression') {
      this.followName('this', path, step, carried);
      return;
    }
    if (node.type === 'MemberExpression' || (isMapGet(node) && !this.calleeScopes(step, 'get').length)) {
      const { keys, base } = this.accessKeys(node, step);
      if (keys.length && (base?.type === 'Identifier' || base?.type === 'ThisExpression')) {
        this.followName(base.type === 'ThisExpression' ? 'this' : base.name, [...keys, ...path], step, carried);
        return;
      }
      this.computed(node, step, carried);
      return;
    }
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      const name = calleeName(this.seg(step, node));
      let scopes = scope !== null ? [scope] : this.calleeScopes(step, name);
      if (scopes.length) {
        if (scopes.length > 1 && carried !== null) {
          const matching = scopes.filter((s) => s.returned !== null && s.returned !== undefined && (path.length ? textOf(project(parse(s.returned), path)) : s.returned) === carried);
          if (matching.length >= 1) {
            if (matching.length > 1) {
              this.certaintyNext = 'inferred';
              this.whyNext = `${matching.length} calls at this step returned the same text`;
            }
            scopes = matching.slice(-1);
          }
        }
        this.returned(scopes[scopes.length - 1]!, path, carried);
        return;
      }
      this.computed(node, step, carried);
      return;
    }
    if (node.type === 'ConditionalExpression' || node.type === 'LogicalExpression') {
      const branches = node.type === 'ConditionalExpression' ? [node.consequent, node.alternate] : this.operands(node);
      for (const b of branches) {
        if (carried !== null && this.simpleText(b, path, step) === carried) {
          this.certaintyNext = 'inferred';
          this.whyNext = 'the branch whose value matches';
          this.followExpr(b, path, step, carried);
          return;
        }
      }
      this.computed(node, step, carried);
      return;
    }
    if (node.type === 'ObjectExpression' && path.length) {
      for (const p of node.properties) {
        if (p.type !== 'Property') continue;
        const k = p.computed ? this.keyOf(p.key, step) : p.key.type === 'Identifier' ? p.key.name : constantKey(p.key)?.value;
        if (k !== UNKNOWN && k !== undefined && (k === path[0] || String(k) === String(path[0]))) {
          this.followExpr(p.value, path.slice(1), step, carried);
          return;
        }
      }
    }
    if (node.type === 'ArrayExpression' && path.length && typeof path[0] === 'number') {
      const n = path[0];
      const els: Node[] = node.elements;
      const i = n < 0 ? els.length + n : n;
      if (i >= 0 && i < els.length && els[i] && !els.slice(0, i + 1).some((e) => e?.type === 'SpreadElement')) {
        this.followExpr(els[i], path.slice(1), step, carried);
        return;
      }
    }
    if (isLiteral(node)) {
      this.literal(step, this.seg(step, node), carried, node, path);
      return;
    }
    this.computed(node, step, carried);
  }

  /** `a || b || c`: the operands of a chain of the same logical operator */
  operands(node: Node): Node[] {
    const out: Node[] = [];
    const visit = (n: Node) => {
      const u = unwrap(n);
      if (u?.type === 'LogicalExpression' && u.operator === node.operator) {
        visit(u.left);
        visit(u.right);
      } else out.push(n);
    };
    visit(node);
    return out;
  }

  /** the text of a branch whose value is in the recording: a name, a constant, a member of a name, a stepped call's result */
  simpleText(nodeIn: Node, path: Key[], step: number): string | null {
    const node = unwrap(nodeIn);
    if (!node) return null;
    if (node.type === 'Identifier') {
      if (node.name === 'undefined') return path.length ? null : 'undefined';
      const found = this.value(node.name, step);
      return path.length ? textOf(project(parse(found.text), path)) : (found.text ?? null);
    }
    const c = constantKey(node);
    if (c && !path.length) return textOf(c.value);
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      for (const s of this.calleeScopes(step, calleeName(this.seg(step, node)))) {
        if (s.returned !== null && s.returned !== undefined) return path.length ? textOf(project(parse(s.returned), path)) : s.returned;
      }
    }
    if (node.type === 'MemberExpression' || isMapGet(node)) {
      const { keys, base } = this.accessKeys(node, step);
      if (keys.length && base?.type === 'Identifier') {
        const found = this.value(base.name, step);
        if (found.text !== null && found.text !== undefined) return textOf(project(parse(found.text), [...keys, ...path]));
      }
    }
    return null;
  }

  returned(scope: Msg, path: Key[], carried: string | null): void {
    const last = Number(scope.last);
    const node = this.stmt(last);
    const fname = lastName(scope.name);
    const whole = scope.returned;
    let text: string | null = whole !== null && whole !== undefined ? (path.length ? textOf(project(parse(whole), path)) : whole) : null;
    text = text ?? carried;
    if ('raised' in scope && !('returned' in scope)) {
      this.add(last, `${fname}()`, text, 'return', 'recorded', `${fname} raised instead of returning`);
      this.end = `${fname} raised`;
      return;
    }
    const sid = Number(scope.scopeId);
    if (node?.type === 'ReturnStatement' && node.argument) {
      if (this.add(last, `return ${this.seg(last, node.argument)}`, text, 'return', 'recorded', `${fname} returned it`, { scopeReturned: sid }) === null) return;
      this.followExpr(node.argument, path, last, text);
      return;
    }
    if (node?.type === 'ArrowFunctionExpression' && node.expression && Number(scope.first) === last) {
      if (this.add(last, `=> ${this.seg(last, node.body)}`, text, 'return', 'recorded', `${fname} returned it`, { scopeReturned: sid }) === null) return;
      this.followExpr(node.body, path, last, text);
      return;
    }
    if (node?.type === 'ReturnStatement') {
      this.add(last, `${fname}()`, 'undefined', 'return', 'recorded', `${fname} returned without a value, so the call gave undefined`, { scopeReturned: sid });
      this.end = `${fname} returned without a value at #${last}`;
      return;
    }
    if ('returned' in scope && (whole === null || whole === undefined)) {
      this.add(last, `${fname}()`, 'undefined', 'return', 'recorded', `${fname} ended without reaching a return statement, so the call gave undefined`, { scopeReturned: sid });
      this.end = `${fname} fell off its end at #${last}`;
      return;
    }
    this.add(last, `${fname}()`, text, 'return', 'recorded', `${fname}'s last step is not a return statement`, { scopeReturned: sid });
    this.end = `the return of ${fname} is not in the recording`;
  }

  /** the value is computed by code that left no steps (a builtin, a method of a string). One input: follow it */
  computed(node: Node, step: number, carried: string | null, unpacked = false): void {
    void unpacked;
    const u = unwrap(node);
    if (carried === 'undefined' && (u?.type === 'CallExpression' || u?.type === 'NewExpression')) {
      // undefined from a call is the call's own answer (`xs.forEach(f)` returns undefined), not one of its inputs
      this.end = `${this.seg(step, node)} gave undefined at #${step}: the undefined is the call's own result (forEach and other methods without a result return undefined)`;
      return;
    }
    const inputs: [string, Msg][] = [];
    for (const n of namesIn(node)) {
      const found = this.value(n, step);
      if (found.step === null || found.step === undefined || typeOf(found.text) === 'function' || isDefinition(found.text)) continue;
      inputs.push([n, found]);
    }
    if (inputs.length === 1) {
      this.certaintyNext = 'inferred';
      this.whyNext = `the one input of ${this.seg(step, node)}`;
      this.followName(inputs[0]![0], [], step, null);
      return;
    }
    const raw = rawString(carried);
    if (raw !== null) {
      const holding = inputs.filter(([, f]) => String(f.text ?? '').includes(raw));
      if (holding.length === 1) {
        this.certaintyNext = 'text match';
        this.whyNext = `the input of ${this.seg(step, node)} whose text holds the value`;
        this.followName(holding[0]![0], [], step, null);
        return;
      }
    }
    if (inputs.length) {
      this.end = `computed at #${step} by ${this.seg(step, node)} from ${inputs.map(([n]) => n).join(', ')}; ask origin for one of them`;
      if (this.links.length) this.links[this.links.length - 1]!.inputs = inputs.map(([n, f]) => ({ name: n, text: f.text ?? null, step: f.step ?? null }));
    } else this.end = `made at #${step} by ${this.seg(step, node)}, which reads no recorded name`;
  }

  /** a literal ends the chain. In a multi-line one, the line holding a string the chain carried is named (by text) */
  literal(step: number, expr: string, textIn: string | null, node: Node, _path: Key[]): void {
    let text = textIn;
    let line: number | null = null;
    const loc = this.history.location(step);
    const lines = this.run.sourceLines(loc.fileId);
    const [start, end] = this.file(loc.fileId).span(node);
    if (end > start) {
      for (let li = this.links.length - 1; li >= 0; li--) {
        const link = this.links[li]!;
        const raw = rawString(link.text);
        if (raw === null || raw.includes('\n')) continue;
        const hits: number[] = [];
        for (let i = start; i <= end; i++) if (i > 0 && i <= lines.length && lines[i - 1]!.includes(raw)) hits.push(i);
        if (hits.length === 1) {
          line = hits[0]!;
          text = link.text;
          break;
        }
      }
    }
    if (line !== null) this.add(step, pyStrip(lines[line - 1]!), text, 'literal', 'text match', `the line of the literal ${pyStrip(expr.split('=')[0]!)} that holds it`, { line });
    else this.add(step, expr, text, 'literal');
    this.end = 'a literal in the source';
  }
}

