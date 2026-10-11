/**
 * The execution graph: the diagram of a run as a projection of the walkthrough (docs/PROTOCOL.md,
 * "Execution graph").
 *
 * Nodes are the modules, the user functions, the library packages (or, unrolled, their functions),
 * the decisions a run touched and the simple statements it ran in user code (`graph_statements.ts`);
 * edges are the calls between them (from the statement that made the call), the tool callbacks,
 * the values that went from one node into a call of another and the names one statement assigned
 * for another to read. Everything comes from the uncapped moments of `walkthrough.ts` plus the
 * trace's scope table, the file maps and the source lines; a model never touches it. The JSON is
 * Python's, key for key (`src/session/executionGraph.ts` is the same builder over a live session).
 * `renderGraph` is the text form; `graph_dot.ts` the Graphviz one.
 */
import { NODE_RANK, STATEMENTS_MAX, collectStatements, nodeOrder, raised, row, statementDataEdges, statementRows } from './graph_statements.ts';
import { MomentBuilder, bisectRight } from './moments.ts';
import { loopNames, namesOf } from './names.ts';
import { CUT_RE, cutLine, pyStrip } from './recording.ts';
import type { Args } from './render.ts';
import type { RunSource, SavedRun } from './source.ts';
import { libraryPackage, walkthrough } from './walkthrough.ts';

type Msg = Record<string, any>;

export const GRAPH_CAP = 200;
export const SPANS_MAX = 50;
export const STEPS_MAX = 50;
export const ROWS_MAX = 12;
export const DATA_EDGES_MAX = 100;
export const LINE_MAX = 100;
/** a cut value on a node line: short enough that its `…(+N chars)` survives the line's own cut */
export const CUT_ROW_MAX = 36;
export const EDGE_STEPS_SHOWN = 6;
export { STATEMENTS_MAX };

const EDGE_RANK: Record<string, number> = { call: 0, tool: 0, data: 1 };

/** Python's `s.rpartition(sep)` */
function rpartition(s: string, sep: string): [string, string, string] {
  const i = s.lastIndexOf(sep);
  return i < 0 ? ['', '', s] : [s.slice(0, i), sep, s.slice(i + sep.length)];
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface GraphOptions {
  allScopes?: boolean;
  scope?: string | null;
  expand?: string[] | null;
  cap?: number;
  statements?: boolean;
}

class Builder {
  readonly run: SavedRun;
  readonly trace: SavedRun['trace'];
  readonly unrollAll: boolean;
  readonly expand: Set<string>;
  readonly cap: number;
  readonly withStatements: boolean;
  readonly mb: MomentBuilder;
  readonly mainFid: number;
  readonly count: number;
  readonly moments: Msg[];
  /** the walkthrough's scope window, on steps: statements outside it are not nodes */
  readonly window: [number, number][] | null = null;
  readonly scopeFirsts: number[];
  mainKey = '';
  /** module, function, package records by key, in creation order */
  readonly nodes = new Map<string, Msg>();
  /** `d:fileId:line` -> decision record */
  readonly decisions = new Map<string, Msg>();
  /** `fileId:line` -> statement record (key `s:fileId:line`) */
  readonly statements = new Map<string, Msg>();
  readonly placeholders = new Map<string, Msg>();
  /** dropped function key -> placeholder key */
  readonly dropped = new Map<string, string>();
  /** [moment, callee key, caller scope key] */
  readonly calls: [Msg, string, string][] = [];
  /** JSON [from, to, kind] -> call edge record */
  readonly edges = new Map<string, Msg>();
  /** JSON [from, to, label] -> data edge record */
  readonly dataEdges = new Map<string, Msg>();
  readonly nodeOfMoment = new Map<string, string>();
  readonly edgeOfMoment = new Map<string, string>();
  capped = false;
  truncated = false;

  constructor(run: SavedRun, opts: { allScopes: boolean; scope: string | null; expand: string[] | null; cap: number; statements: boolean }) {
    this.run = run;
    this.trace = run.trace;
    this.unrollAll = !!opts.allScopes;
    this.expand = new Set(opts.expand ?? []);
    this.cap = opts.cap;
    this.withStatements = opts.statements;
    const all = this.unrollAll || this.expand.size > 0;
    this.mb = new MomentBuilder(run, all);
    this.mainFid = this.mb.mainFileId();
    const w = walkthrough(run, { allScopes: all, scope: opts.scope, cap: 10 ** 9 });
    this.count = Number(w.count);
    this.moments = w.moments;
    if (opts.scope !== null) {
      const scope = opts.scope;
      this.window = this.trace.scopes.filter((s) => String(s.name) === scope || this.mb.scopeQualname(Number(s.scopeId)).endsWith(scope)).map((s) => [Number(s.first), Number(s.last)]);
    }
    this.scopeFirsts = this.trace.scopes.map((s) => Number(s.first)).sort((a, b) => a - b);
  }

  // -- keys (rule 2) ---------------------------------------------------------------------------------------
  keyOf(file: string | null, fid: number, fn: string): string {
    if (this.mb.user(fid)) return `${fid}:${fn}`;
    const pkg = libraryPackage(file) || '?';
    if (!this.unrollAll && !this.expand.has(pkg)) return 'pkg:' + pkg;
    return `${fid}:${fn}`;
  }

  scopeKey(s: Msg): string | null {
    if (Number(s.parent ?? -1) < 0) return this.mainKey;
    const loc = this.run.locate(Number(s.rid));
    if (loc === null) return null;
    const fid = Number(loc.fileId);
    const fn = String(s.name) === '<module>' ? '<module>' : this.mb.scopeQualname(Number(s.scopeId));
    return this.keyOf(this.run.filePath(fid), fid, fn);
  }

  /** a module scope of a user file or a user function scope (never a library scope) */
  userScope(s: Msg): boolean {
    if (Number(s.parent ?? -1) < 0) return this.mb.user(this.mainFid);
    const loc = this.run.locate(Number(s.rid));
    return loc !== null && this.mb.user(Number(loc.fileId));
  }

  inWindow(step: number): boolean {
    return this.window === null || this.window.some(([a, b]) => a <= step && step <= b);
  }

  callerKey(m: Msg): string | null {
    if (m.kind === 'tool') {
      const parent = this.toolCaller(m);
      return parent ? this.scopeKey(parent) : null;
    }
    const key = this.locationKey(m);
    if (m.callee?.function === '<module>' && key === this.keyOf(m.callee.file, Number(m.callee.fileId), '<module>')) {
      // an ES module's imports run before its first statement: the call site is the module's own
      // first step, so the caller is the importing scope (Python's `import` runs from a statement)
      const s = this.trace.scope(Number(m.scopeId));
      const parent = s ? this.trace.scope(Number(s.parent)) : undefined;
      return parent ? this.scopeKey(parent) : key;
    }
    return key;
  }

  /** the scope a tool moment was called back under: `callerScopeId`, else the callee's recorded parent */
  toolCaller(m: Msg): Msg | undefined {
    if (m.callerScopeId !== null && m.callerScopeId !== undefined) return this.trace.scope(Number(m.callerScopeId));
    const s = this.trace.scope(Number(m.scopeId));
    return s ? this.trace.scope(Number(s.parent)) : undefined;
  }

  locationKey(m: Msg): string {
    const loc = m.location;
    return this.keyOf(loc.file, Number(loc.fileId), String(loc.function));
  }

  /** the statement node at a moment's location, when there is one */
  statementAt(m: Msg): Msg | undefined {
    const loc = m.location;
    return this.statements.get(`${Number(loc.fileId)}:${Number(loc.line)}`);
  }

  statementKey(m: Msg): string | null {
    return this.statementAt(m)?.key ?? null;
  }

  // -- nodes (rules 3, 4) --------------------------------------------------------------------------------
  static record(key: string, kind: string, label: string, step: number, fields: Msg = {}): Msg {
    return { key, kind, label, file: null, line: null, fileId: null, function: null, package: null, calls: 0, firstStep: step, spans: [], rows: [], nested: null, more: null, moments: [], ...fields };
  }

  addMain(): void {
    this.mainKey = `${this.mainFid}:<module>`;
    this.nodes.set(this.mainKey, Builder.record(this.mainKey, 'module', '<module>', 0, { file: this.run.filePath(this.mainFid), line: 1, fileId: this.mainFid, function: '<module>', calls: 1, spans: [[0, this.count - 1]] }));
  }

  nodeForCallee(m: Msg): Msg {
    const c = m.callee;
    const fid = Number(c.fileId);
    const key = this.keyOf(c.file, fid, String(c.function));
    let node = this.nodes.get(key);
    if (node !== undefined) return node;
    if (key.startsWith('pkg:')) node = Builder.record(key, 'package', key.slice(4), m.step, { package: key.slice(4), nested: 0 });
    else if (c.function === '<module>') node = Builder.record(key, 'module', this.run.displayPath(c.file), m.step, { file: c.file, line: Number(c.line), fileId: fid, function: '<module>' });
    else {
      const pkg = this.mb.user(fid) ? null : libraryPackage(c.file) || '?';
      node = Builder.record(key, 'function', String(c.function), m.step, { file: c.file, line: Number(c.line), fileId: fid, function: String(c.function), package: pkg });
    }
    this.nodes.set(key, node);
    return node;
  }

  addCalls(): void {
    for (const m of this.moments) {
      if (m.kind !== 'call' && m.kind !== 'tool') continue;
      const node = this.nodeForCallee(m);
      const caller = this.callerKey(m);
      this.nodeOfMoment.set(m.id, node.key);
      if (caller === node.key && node.kind === 'package') continue; // a call inside one folded package
      const entry = Number(m.entryStep);
      const end = Number(m.endStep);
      node.moments.push(m);
      node.calls += 1;
      node.spans.push([entry, end]);
      if (node.kind === 'package') node.nested += bisectRight(this.scopeFirsts, end) - bisectRight(this.scopeFirsts, entry);
      if (caller !== null) this.calls.push([m, node.key, caller]);
    }
  }

  // -- call edges (rule 7, S5): from the statement of the call site when it has a node -------------------
  addCallEdges(): void {
    for (const [m, callee, caller] of this.calls) {
      let src = caller;
      if (m.kind === 'call') src = this.statementKey(m) || caller;
      const ek = JSON.stringify([src, callee, m.kind]);
      let edge = this.edges.get(ek);
      if (edge === undefined) this.edges.set(ek, (edge = { from: src, to: callee, kind: m.kind, moments: [] }));
      edge.moments.push(m);
      this.edgeOfMoment.set(m.id, ek);
    }
  }

  // -- decisions (rule 6) --------------------------------------------------------------------------------
  addDecisions(): void {
    for (const m of this.moments) {
      if (m.kind !== 'decision') continue;
      const loc = m.location;
      const fid = Number(loc.fileId);
      const line = Number(loc.line);
      const loop = m.count !== null && m.count !== undefined;
      let label: string;
      let taken: string | null;
      if (loop) {
        label = rpartition(m.text, ' ran ')[0];
        taken = null;
      } else {
        const parts = rpartition(m.text, ' took ');
        label = parts[0];
        taken = parts[2];
      }
      const dk = `d:${fid}:${line}`;
      let rec = this.decisions.get(dk);
      if (rec === undefined) {
        rec = { key: dk, kind: 'decision', parent: this.locationKey(m), label, file: loc.file, line, fileId: fid, text: m.text, taken, firstStep: Number(m.step), hits: 0, notRun: [], rows: [], takens: [], loop, first: m, targets: [], reads: [] };
        this.decisions.set(dk, rec);
      }
      rec.hits += loop ? Number(m.count) : 1;
      if (!loop) rec.takens.push(taken);
      this.nodeOfMoment.set(m.id, dk);
    }
    for (const rec of this.decisions.values()) {
      const fm = this.mb.fmap(rec.fileId);
      if (rec.loop) {
        // internal: a `for` assigns its target and reads the iterable, a `while` reads its condition
        const lp = fm.loops.get(rec.line);
        if (lp !== undefined) {
          const text = String(lp.text).replace(/^\s*\(([\s\S]*)\)\s*$/, '$1'); // `(const x of xs)` as written
          [rec.targets, rec.reads] = lp.kind === 'for' ? loopNames(text) : [[], namesOf([text])[1]];
        }
        continue;
      }
      const dec = fm.decisions.get(rec.line);
      if (dec === undefined) continue;
      rec.reads = namesOf([dec.text])[1];
      const takens = new Set(rec.takens);
      if (dec.kind === 'match') {
        // an arm is taken as `case X` or `default`, as the moment's sentence names it
        rec.notRun = (dec.arms ?? []).filter((a: Msg) => !takens.has(a.default ? 'default' : `case ${a.text}`)).map((a: Msg) => a.body[0]);
      } else {
        const tookTrue = takens.has('true');
        const tookFalse = takens.has('false');
        if (tookFalse && !tookTrue && dec.body[0]) rec.notRun = [dec.body[0]];
        else if (tookTrue && !tookFalse && (dec.orelse ?? [0, 0])[0]) rec.notRun = [dec.orelse[0]];
      }
    }
  }

  // -- rows (rule 5, S4) ---------------------------------------------------------------------------------
  addRows(): void {
    for (const node of this.nodes.values()) {
      if (!node.moments.length) continue;
      const first = node.moments[0];
      for (const v of first.values) {
        if (v.role === 'in') node.rows.push(row('in', v.name, v.text, Number(first.entryStep)));
        else if (v.role === 'out' && v.name === 'raised') {
          const [name, text] = raised(v.text);
          node.rows.push(row('raised', name, text, Number(first.endStep)));
        } else if (v.role === 'out') node.rows.push(row('out', v.name, v.text, Number(first.endStep)));
      }
    }
    statementRows(this); // also the `raised` rows of error moments without a statement node
    for (const rec of this.decisions.values()) rec.rows = rec.first.values.filter((v: Msg) => v.role === 'took').map((v: Msg) => row('took', v.name, v.text, Number(rec.first.step)));
    for (const rec of [...this.nodes.values(), ...this.decisions.values(), ...this.statements.values()]) {
      const seen = new Set<string>();
      let rows: Msg[] = [];
      for (const r of rec.rows) {
        const k = JSON.stringify([r.kind, r.name, r.text]);
        if (!seen.has(k)) {
          seen.add(k);
          rows.push(r);
        }
      }
      if (rows.length > ROWS_MAX) {
        // a long parameter list must not push the result or the exception off the card: drop `in` rows first
        this.truncated = true;
        while (rows.length > ROWS_MAX && rows.some((r) => r.kind === 'in')) {
          let lastIn = -1;
          rows.forEach((r, i) => {
            if (r.kind === 'in') lastIn = i;
          });
          rows.splice(lastIn, 1);
        }
        rows = rows.slice(0, ROWS_MAX);
      }
      rec.rows = rows;
    }
  }

  // -- data edges (rule 8, S6) ---------------------------------------------------------------------------
  addDataEdges(): void {
    type Producer = [number, number, string, string, string];
    const byName = new Map<string, Producer[]>();
    const byText = new Map<string, Producer[]>();
    const add = (p: Producer) => {
      if (!byName.has(p[3])) byName.set(p[3], []);
      byName.get(p[3])!.push(p);
      if (!byText.has(p[4])) byText.set(p[4], []);
      byText.get(p[4])!.push(p);
    };
    let order = 0;
    for (const m of this.moments) {
      if (m.kind === 'call' || m.kind === 'tool') {
        for (const v of m.values) {
          if (v.role === 'out' && v.name !== 'raised') add([Number(m.endStep), order++, this.nodeOfMoment.get(m.id)!, v.name, v.text]);
        }
      } else if (m.kind === 'value' && m.values.length) {
        const key = this.locationKey(m);
        if (this.nodes.has(key)) {
          const v = m.values[0];
          add([Number(m.step), order++, key, v.name, v.text]);
        }
      }
    }
    for (const m of this.moments) {
      if (m.kind !== 'call' && m.kind !== 'tool') continue;
      const ins = m.values.filter((v: Msg) => v.role === 'in');
      if (!ins.length) continue;
      const step = Number(m.step);
      const scope = m.kind === 'tool' ? this.toolCaller(m) : this.trace.scope(this.trace.scopeId(step));
      if (!scope) continue;
      const first = Number(scope.first);
      const caller = this.callerKey(m);
      const callee = this.nodeOfMoment.get(m.id)!;
      for (const v of ins) {
        let best: Producer | null = null;
        for (const p of [...(byName.get(v.name) ?? []), ...(byText.get(v.text) ?? [])]) {
          if (first <= p[0] && p[0] < step && p[2] !== caller && (best === null || p[0] > best[0] || (p[0] === best[0] && p[1] > best[1]))) best = p;
        }
        if (best !== null) {
          const dk = JSON.stringify([best[2], callee, v.name]);
          if (!this.dataEdges.has(dk)) this.dataEdges.set(dk, { from: best[2], to: callee, kind: 'data', label: v.name, firstStep: Number(m.entryStep) });
        }
      }
    }
    if (this.withStatements) statementDataEdges(this);
  }

  // -- the cap (rule 9) ----------------------------------------------------------------------------------
  applyCap(): void {
    if (this.nodes.size <= this.cap) return;
    const keep = new Set([...this.nodes.values()].filter((n) => n.kind !== 'function').map((n) => n.key as string));
    for (const rec of this.decisions.values()) if (this.nodes.has(rec.parent)) keep.add(rec.parent);
    const rest = [...this.nodes.values()].filter((n) => !keep.has(n.key)).sort((a, b) => b.calls - a.calls || a.firstStep - b.firstStep);
    for (const n of rest) {
      if (keep.size >= this.cap) break;
      keep.add(n.key);
    }
    for (const key of [...this.nodes.keys()].filter((k) => !keep.has(k))) {
      const n = this.nodes.get(key)!;
      this.nodes.delete(key);
      const pk = `more:${n.fileId}`;
      let ph = this.placeholders.get(pk);
      if (ph === undefined) this.placeholders.set(pk, (ph = Builder.record(pk, 'package', '', n.firstStep, { file: n.file, fileId: n.fileId, more: 0 })));
      ph.more += 1;
      ph.calls += n.calls;
      ph.firstStep = Math.min(ph.firstStep, n.firstStep);
      this.dropped.set(key, pk);
    }
    for (const ph of this.placeholders.values()) ph.label = `${ph.more} more function${ph.more === 1 ? '' : 's'}`;
    this.capped = true;
  }

  // -- assembly (rules 10, 11, S8) -----------------------------------------------------------------------
  emitNode(n: Msg, ids: Map<string, string>): Msg {
    const out: Msg = { id: ids.get(n.key), kind: n.kind };
    if (n.kind === 'statement') {
      Object.assign(out, { parent: ids.get(n.parent), label: n.label, file: n.file, line: n.line, fileId: n.fileId, text: n.text, targets: [...n.targets], reads: [...n.reads], firstStep: n.firstStep, hits: n.hits, rows: n.rows });
      return out;
    }
    if (n.kind === 'decision') {
      Object.assign(out, { parent: ids.get(n.parent), label: n.label, file: n.file, line: n.line, fileId: n.fileId, text: n.text });
      if (n.taken !== null) out.taken = n.taken;
      Object.assign(out, { firstStep: n.firstStep, hits: n.hits, notRun: n.notRun, rows: n.rows });
      return out;
    }
    out.label = n.label;
    if (n.more !== null) Object.assign(out, { file: n.file, fileId: n.fileId });
    else if (n.kind !== 'package') Object.assign(out, { file: n.file, line: n.line, fileId: n.fileId, function: n.function });
    if (n.package !== null) out.package = n.package;
    let spans = n.spans;
    if (spans.length > SPANS_MAX) {
      spans = spans.slice(0, SPANS_MAX);
      this.truncated = true;
    }
    Object.assign(out, { calls: n.calls, firstStep: n.firstStep, spans, rows: n.rows });
    if (n.nested !== null) out.nested = n.nested;
    if (n.more !== null) out.more = n.more;
    return out;
  }

  /** call, tool and data edges in the global order; the data edges cut at DATA_EDGES_MAX */
  sortedEdges(ids: Map<string, string>): Msg[] {
    const edges: Msg[] = [];
    for (const [ek, e] of this.edges) {
      if (ids.has(e.from) && ids.has(e.to)) {
        const steps = e.moments.map((m: Msg) => Number(m.step));
        edges.push({ _key: ek, _first: steps[0], _label: '', id: '', from: ids.get(e.from), to: ids.get(e.to), kind: e.kind, count: steps.length, firstStep: steps[0], steps: steps.slice(0, STEPS_MAX), momentIds: e.moments.map((m: Msg) => m.id) });
        if (steps.length > STEPS_MAX) this.truncated = true;
      }
    }
    for (const [dk, e] of this.dataEdges) {
      if (ids.has(e.from) && ids.has(e.to)) edges.push({ _key: dk, _first: e.firstStep, _label: e.label, id: '', from: ids.get(e.from), to: ids.get(e.to), kind: 'data', label: e.label, firstStep: e.firstStep });
    }
    const num = (id: string) => Number(id.slice(1));
    edges.sort((a, b) => a._first - b._first || EDGE_RANK[a.kind]! - EDGE_RANK[b.kind]! || num(a.from) - num(b.from) || num(a.to) - num(b.to) || cmp(a._label, b._label));
    let nData = 0;
    const kept: Msg[] = [];
    for (const e of edges) {
      if (e.kind === 'data') {
        nData++;
        if (nData > DATA_EDGES_MAX) {
          this.truncated = true;
          continue;
        }
      }
      kept.push(e);
    }
    return kept;
  }

  build(): Msg {
    this.addMain();
    this.addCalls();
    if (this.withStatements) collectStatements(this);
    this.addCallEdges();
    this.addDecisions();
    this.addRows();
    this.addDataEdges();
    this.applyCap();
    const under = [...this.decisions.values(), ...this.statements.values()].filter((d) => this.nodes.has(d.parent));
    const records = [...this.nodes.values(), ...this.placeholders.values(), ...under].sort(nodeOrder);
    const ids = new Map<string, string>(records.map((n, i) => [n.key, `n${i}`]));
    const nodes = records.map((n) => this.emitNode(n, ids));
    const edges = this.sortedEdges(ids);
    const edgeIds = new Map<string, string>();
    edges.forEach((e, i) => {
      e.id = `e${i}`;
      edgeIds.set(e._key, e.id);
      delete e._key;
      delete e._first;
      delete e._label;
    });
    const moments: Msg[] = [];
    for (const m of this.moments) {
      const kind = m.kind;
      let key: string | null | undefined;
      if (kind === 'start' || kind === 'end') key = this.mainKey;
      else if (kind === 'call' || kind === 'tool' || kind === 'decision') key = this.nodeOfMoment.get(m.id);
      else key = this.statementKey(m) || this.locationKey(m);
      if (key === null || key === undefined || !ids.has(key)) continue;
      const ref: Msg = { id: m.id, kind, step: Number(m.step), nodeId: ids.get(key) };
      const ek = this.edgeOfMoment.get(m.id);
      if (ek !== undefined && edgeIds.has(ek)) ref.edgeId = edgeIds.get(ek);
      moments.push(ref);
    }
    const scopes: Msg = {};
    for (const s of [...this.trace.scopes].sort((a, b) => Number(a.scopeId) - Number(b.scopeId))) {
      let key = this.scopeKey(s);
      if (key !== null && this.dropped.has(key)) key = this.dropped.get(key)!;
      if (key !== null && ids.has(key)) scopes[String(Number(s.scopeId))] = ids.get(key);
    }
    return { count: this.count, nodes, edges, moments, scopes, capped: this.capped, truncated: this.truncated };
  }
}

/** the execution graph of a saved run; `expand` unrolls those packages, `allScopes` every one; `statements: false` leaves the statement nodes out */
export function graph(run: SavedRun, opts: GraphOptions = {}): Msg {
  return new Builder(run, { allScopes: !!opts.allScopes, scope: opts.scope ?? null, expand: opts.expand ?? null, cap: opts.cap ?? GRAPH_CAP, statements: opts.statements ?? true }).build();
}

// -- text form -----------------------------------------------------------------------------------------------

function graphLine(text: string, limit = LINE_MAX): string {
  const indent = text.length - text.replace(/^ +/, '').length;
  const s = pyStrip(text).split('\n').join(' ');
  const chars = [...s];
  return ' '.repeat(indent) + (chars.length <= limit - indent ? s : chars.slice(0, limit - indent - 1).join('') + '…');
}

export function rowText(r: Msg): string {
  if (r.kind === 'out' && r.name === 'return') return `out ${r.text}`;
  if (r.kind === 'raised') return `raised ${r.name}${r.text ? ': ' + r.text : ''}`;
  return `${r.kind} ${r.name} = ${r.text}`;
}

function where(source: RunSource, n: Msg): string {
  const name = typeof source?.displayPath === 'function' ? source.displayPath(n.file) : String(n.file);
  return n.line ? `${name}:${n.line}` : name;
}

/** `r` with a value the recording cut shortened to CUT_ROW_MAX, mark kept, so the line cut does not drop the mark */
function shortRow(r: Msg): Msg {
  const text = r.text;
  if (typeof text === 'string' && [...text].length > CUT_ROW_MAX && CUT_RE.test(text)) return { ...r, text: cutLine(text, CUT_ROW_MAX) };
  return r;
}

export function renderGraph(result: Msg, source: RunSource, _args: Args): string[] {
  const nodes: Msg[] = result.nodes;
  const nEdges = result.edges.length;
  let head = `${nodes.length} nodes, ${nEdges} edge${nEdges === 1 ? '' : 's'} over ${result.count} steps`;
  if (result.capped) head += ', capped';
  const out = [head];
  const under = new Map<string, Msg[]>(); // decisions and statements under their parent, in node (firstStep) order
  for (const n of nodes) {
    if (n.kind !== 'decision' && n.kind !== 'statement') continue;
    if (!under.has(n.parent)) under.set(n.parent, []);
    under.get(n.parent)!.push(n);
  }
  for (const n of nodes) {
    if (n.kind === 'decision' || n.kind === 'statement') continue;
    const bits = [`${n.id} ${n.label}` + (n.file ? (n.more ? '  ' : ' ') + where(source, n) : ''), `×${n.calls}`];
    if (n.nested !== null && n.nested !== undefined) bits.push(`${n.nested} nested`);
    if (n.rows.length) bits.push(n.rows.map((r: Msg) => rowText(shortRow(r))).join(' · '));
    out.push(graphLine(bits.join('  ')));
    for (const d of under.get(n.id) ?? []) {
      const dbits = [`   ${d.id} ${d.kind === 'decision' ? d.text : d.label}`, `×${d.hits}`];
      if (d.notRun?.length) dbits.push('not run: ' + d.notRun.map(String).join(', '));
      if (d.rows.length) dbits.push(d.rows.map((r: Msg) => rowText(shortRow(r))).join(' · '));
      out.push(graphLine(dbits.join('  ')));
    }
  }
  for (const e of result.edges) {
    if (e.kind === 'data') {
      out.push(graphLine(`${e.from} ⇢ ${e.to}  ${e.label}`));
      continue;
    }
    const steps = e.steps.slice(0, EDGE_STEPS_SHOWN).map((s: number) => `#${s}`).join(' ') + (e.steps.length > EDGE_STEPS_SHOWN ? ' …' : '');
    out.push(graphLine(`${e.from} → ${e.to}  ${e.kind === 'tool' ? 'tool ' : ''}×${e.count}  ${steps}`));
  }
  return out;
}

export { NODE_RANK };
