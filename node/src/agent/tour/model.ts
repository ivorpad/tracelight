/**
 * `TourRun`: one pass over a `SavedRun` into the arrays and indexes the tour's rules read.
 *
 * Per step: file, line, scope, depth, whether it entered a scope. Per scope: its steps, its
 * parent, the last step of everything under it. The walkthrough's moments with every library
 * scope unrolled (`MomentBuilder(run, true)`), the HTTP rows with the step of the statement that
 * issued each request, and every recorded local change filed at the statement that made it (the
 * rule `var` uses, with the bindings the run's own statements have).
 */
import { sep } from 'node:path';
import { matchesName } from '../bindings.ts';
import { httpTable } from '../http.ts';
import { MomentBuilder, bisectLeft, bisectRight } from '../moments.ts';
import { FLAG_SCOPE_ENTRY } from '../protocol.ts';
import type { SavedRun } from '../source.ts';
import { isUserFile } from '../walkthrough.ts';
import { FileInfo, moduleRoots, type Stmt } from './astinfo.ts';

type Msg = Record<string, any>;
/** `[role, name, text]`: `in` for a parameter at a scope's entry, `set` for what a statement bound */
export type Change = [string, string, string];

const LLM_URL = /\/(chat\/)?completions\b|\/v1\/messages\b|\/responses\b|\/embeddings\b|:generateContent|:streamGenerateContent|\/api\/(chat|generate)\b/i;

/** a request to a model API: chat or text completions, messages, responses, embeddings, Gemini, Ollama */
export function isLlmUrl(url: unknown): boolean {
  return LLM_URL.test(String(url ?? ''));
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  let list = m.get(k);
  if (!list) m.set(k, (list = []));
  list.push(v);
}

export class TourRun {
  readonly run: SavedRun;
  readonly trace: SavedRun['trace'];
  readonly n: number;
  readonly main: string;
  readonly fid: number[] = [];
  readonly line: number[] = [];
  readonly col: number[] = [];
  readonly scope: number[] = [];
  readonly depth: number[] = [];
  readonly entry: boolean[] = [];
  readonly byScope = new Map<number, number[]>();
  readonly stepsByRid = new Map<number, number[]>();
  readonly scopes = new Map<number, Msg>();
  readonly builder: MomentBuilder;
  readonly moments: Msg[];
  readonly calls: Msg[];
  readonly callByEntry = new Map<number, Msg>();
  private readonly infos = new Map<number, FileInfo>();
  private readonly users = new Map<number, boolean>();
  readonly userPaths: string[];
  readonly roots: Set<string>;
  readonly defs = new Set<string>();
  readonly children = new Map<number, Msg[]>();
  readonly childFirsts = new Map<number, number[]>();
  readonly decisions = new Map<number, Msg[]>();
  readonly mainFid: number | null;
  readonly http: Msg[];
  readonly changes: Map<number, Change[]>;
  /**
   * The main module's scope (recorded parent -1). Python's step 0 runs in it; JavaScript evaluates
   * the imported modules first, so step 0 can be another module's body.
   */
  readonly rootScope: number;

  constructor(run: SavedRun) {
    this.run = run;
    const trace = run.trace;
    this.trace = trace;
    this.n = trace.count;
    this.main = String(run.meta.file || '');
    for (let i = 0; i < this.n; i++) {
      const loc = trace.location(i);
      this.fid.push(loc ? loc[0] : -1);
      this.line.push(loc ? Number(loc[1][0]) : 0);
      this.col.push(loc ? Number(loc[1][1]) : 0);
      const sid = trace.scopeId(i);
      this.scope.push(sid);
      this.depth.push(trace.depth(i));
      this.entry.push(!!(trace.flags(i) & FLAG_SCOPE_ENTRY));
      push(this.byScope, sid, i);
      push(this.stepsByRid, trace.rid(i), i);
    }
    for (const s of trace.scopes) this.scopes.set(Number(s.scopeId), s);
    const root = trace.scopes.find((s) => Number(s.parent ?? -1) < 0 && this.byScope.has(Number(s.scopeId)));
    this.rootScope = root ? Number(root.scopeId) : this.n ? this.scope[0]! : -1;
    this.builder = new MomentBuilder(run, true);
    this.moments = this.builder.build();
    this.calls = this.moments.filter((m) => (m.kind === 'call' || m.kind === 'tool') && m.entryStep !== null && m.entryStep !== undefined && !String(m.text).startsWith('module '));
    for (const m of this.calls) this.callByEntry.set(Number(m.entryStep), m);
    const userFids = [...new Set(this.fid)].filter((f) => f >= 0 && this.user(f));
    this.userPaths = [...new Set(userFids.map((f) => String(run.filePath(f))))].sort();
    this.roots = moduleRoots(this.userPaths);
    for (const f of userFids) for (const d of this.info(f).defs) this.defs.add(d);
    for (const s of [...trace.scopes].sort((a, b) => Number(a.first) - Number(b.first))) {
      if (String(s.name) !== '<module>') push(this.children, Number(s.parent ?? -1), s);
    }
    for (const [p, kids] of this.children) this.childFirsts.set(p, kids.map((s) => Number(s.first)));
    for (const m of this.moments) if (m.kind === 'decision') push(this.decisions, Number(m.step), m);
    this.mainFid = this.n ? run.mainFileId() : null;
    this.http = this.httpRows();
    this.changes = this.collectChanges();
  }

  // -- files and statements -----------------------------------------------------------------------------
  user(fid: number): boolean {
    let u = this.users.get(fid);
    if (u === undefined) {
      u = isUserFile(this.run.filePath(fid), this.run.workspaceRoot, this.main);
      this.users.set(fid, u);
    }
    return u;
  }

  info(fid: number): FileInfo {
    let info = this.infos.get(fid);
    if (!info) {
      info = new FileInfo(fid >= 0 ? this.run.sourceLines(fid) : [], (fid >= 0 && this.run.filePath(fid)) || 'x.js');
      this.infos.set(fid, info);
    }
    return info;
  }

  /** the run's bindings of a file; none when its source does not parse (a Python run read here) */
  private bindings(fid: number): Map<number, { assigns?: string[] }> {
    try {
      return this.run.bindings(fid);
    } catch {
      return new Map();
    }
  }

  stmt(i: number): Stmt | undefined {
    return this.info(this.fid[i]!).at(this.line[i]!, this.col[i]!);
  }

  text(i: number): string {
    return this.info(this.fid[i]!).statementText(this.line[i]!, this.col[i]!);
  }

  path(i: number): string {
    return String(this.run.filePath(this.fid[i]!) || '');
  }

  display(i: number): string {
    return this.run.displayPath(this.run.filePath(this.fid[i]!));
  }

  function(i: number): string {
    return this.builder.scopeQualname(this.scope[i]!);
  }

  scopeFunction(sid: number): string {
    return this.builder.scopeQualname(sid);
  }

  // -- scopes ----------------------------------------------------------------------------------------------
  parent(sid: number): number {
    const s = this.scopes.get(sid);
    return s ? Number(s.parent) : -1;
  }

  descends(sid: number, ancestor: number): boolean {
    return sid !== ancestor && this.builder.descends(sid, ancestor);
  }

  scopeLast(sid: number): number {
    const steps = this.byScope.get(sid);
    return steps ? steps[steps.length - 1]! : -1;
  }

  nextInScope(i: number): number | null {
    const steps = this.byScope.get(this.scope[i]!) ?? [];
    const k = bisectRight(steps, i);
    return k < steps.length ? steps[k]! : null;
  }

  prevInScope(i: number, sid: number | null = null): number | null {
    const steps = this.byScope.get(sid === null ? this.scope[i]! : sid) ?? [];
    const k = bisectLeft(steps, i) - 1;
    return k >= 0 ? steps[k]! : null;
  }

  /**
   * Last step of a call and everything it led to: the step before its caller's next step, else the
   * call's own end. A callback (`tool`) ends at its own end: its caller's next step is after the
   * whole library call.
   */
  extent(m: Msg): number {
    const e = Number(m.entryStep);
    const end = Number(m.endStep || e);
    if (m.kind === 'tool') return end;
    const own = this.byScope.get(e > 0 ? this.scope[e - 1]! : -1) ?? [];
    const k = bisectRight(own, e);
    return k < own.length ? own[k]! - 1 : Math.max(end, this.scopeLast(Number(m.scopeId)));
  }

  /**
   * Where the value a scope returned lands: its caller's next step (`if (reply)` after
   * `const reply = await ask(...)`), else the scope's own last step (a callback of unrecorded code).
   */
  landing(sid: number): number {
    const last = this.scopeLast(sid);
    const steps0 = this.byScope.get(sid);
    const m = steps0 ? this.callByEntry.get(steps0[0]!) : undefined;
    if (m !== undefined && m.kind === 'tool') return last; // the recorded parent of a callback is not the frame it returns to
    const parent = this.parent(sid);
    const steps = this.byScope.get(parent) ?? [];
    const k = bisectRight(steps, last);
    if (parent >= 0 && k < steps.length && this.user(this.fid[steps[k]!]!)) return steps[k]!;
    return last;
  }

  /**
   * The scopes the statement at `i` entered: children of its scope that began before its scope's
   * next step, without callbacks (a callback's recorded parent can be too shallow).
   */
  callsMade(i: number, cap = 20): Msg[] {
    const sid = this.scope[i]!;
    const nxt = this.nextInScope(i);
    const end = nxt !== null ? nxt : this.n;
    const firsts = this.childFirsts.get(sid) ?? [];
    const kids = this.children.get(sid) ?? [];
    let k = bisectRight(firsts, i);
    const out: Msg[] = [];
    while (k < kids.length && firsts[k]! < end && out.length < cap) {
      const m = this.callByEntry.get(firsts[k]!);
      if (m === undefined || m.kind !== 'tool') out.push(kids[k]!);
      k++;
    }
    return out;
  }

  decisionsAt(i: number): Msg[] {
    return this.decisions.get(i) ?? [];
  }

  // -- recorded values --------------------------------------------------------------------------------------
  /** statement step -> `[role, name, text]`: parameters at a scope's entry (`in`), else what the statement bound (`set`) */
  private collectChanges(): Map<number, Change[]> {
    const out = new Map<number, Change[]>();
    const assignsCache = new Map<number, string[]>();
    for (const entry of this.run.localsEntries) {
      let observed = Number(entry.step ?? -1);
      if (!(observed >= 0 && observed < this.n)) continue;
      const sid = entry.scopeId !== undefined && entry.scopeId !== null ? Number(entry.scopeId) : this.scope[observed]!;
      const s = this.scopes.get(sid);
      const first = s !== undefined ? Number(s.first ?? -1) : -1;
      const prev = observed !== first ? this.prevInScope(observed, sid) : null;
      // a function's first step is its header, which binds nothing: what its next step sees are the arguments
      const atEntry = s !== undefined && Number(s.parent ?? -1) >= 0 && String(s.name) !== '<module>' && (observed === first || prev === first);
      if (atEntry) observed = first;
      for (const ch of entry.changes ?? []) {
        const name = String(ch.name || '');
        const text = String(ch.text !== null && ch.text !== undefined ? ch.text : '');
        if (!name) continue;
        if (atEntry) {
          push(out, observed, ['in', name, text] as Change);
          continue;
        }
        let target = observed;
        if (prev !== null) {
          const rid = this.trace.rid(prev);
          let assigns = assignsCache.get(rid);
          if (assigns === undefined) {
            const fid = this.fid[prev]!;
            assigns = fid >= 0 ? (this.bindings(fid).get(rid)?.assigns ?? []) : [];
            assignsCache.set(rid, assigns);
          }
          if (assigns.some((a) => matchesName(a, name))) target = prev;
        }
        push(out, target, ['set', name, text] as Change);
      }
    }
    return out;
  }

  /**
   * The HTTP table's rows, each with `step` moved to the statement that issued it. When requests
   * share a step and their own statement (the `rid`) ran at least as often as it issued requests,
   * the k-th request from it is filed at its k-th step.
   */
  private httpRows(): Msg[] {
    if (!this.run.httpEvents.length) return [];
    const rows: Msg[] = httpTable(this.run.httpEvents, this.run.finished.http, { locate: (rid) => this.run.httpLocation(rid), runId: this.run.meta.runId }).requests ?? [];
    const ridOf = new Map<string, number>();
    for (const e of this.run.httpEvents) if (e.rid !== null && e.rid !== undefined) ridOf.set(String(e.n), Number(e.rid));
    const byRid = new Map<number, Msg[]>();
    for (const r of rows) {
      const rid = ridOf.get(String(r.n)) ?? -1;
      r.rid = rid;
      push(byRid, rid, r);
    }
    for (const [rid, group] of byRid) {
      const steps = this.stepsByRid.get(rid) ?? [];
      if (rid < 0 || !steps.length) continue;
      const filed = group.filter((r) => r.step !== null && r.step !== undefined).map((r) => Number(r.step));
      if (filed.length === group.length && new Set(filed).size === filed.length && filed.every((s) => this.trace.rid(s) === rid)) continue; // every request already at a step of its own statement
      if (steps.length >= group.length) {
        const sorted = [...group].sort((a, b) => Number(a.n || 0) - Number(b.n || 0));
        sorted.forEach((r, k) => {
          r.recordedStep = r.step;
          r.step = steps[k];
        });
      }
    }
    for (const r of rows) r.llm = isLlmUrl(r.url);
    return rows.filter((r) => r.step !== null && r.step !== undefined);
  }

  prints(): Msg[] {
    return this.run.logs.filter((ev) => ev.kind === 'log' && ev.step !== null && ev.step !== undefined);
  }

  fileLabel(path: string | null): string {
    return path ? this.run.displayPath(path) : '<unknown>';
  }

  shortPath(i: number): string {
    const p = this.display(i);
    const parts = p.split(sep);
    return parts.length > 2 ? parts.slice(-2).join(sep) : p;
  }
}
