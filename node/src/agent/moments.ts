/**
 * The moment builder behind `walkthrough.ts`: one pass per kind over a `SavedRun`, as Pyokka's
 * `agent/moments.py`.
 *
 * Calls (with library scopes merged per user-code call site), decisions and loops (from the
 * `decisions.ts` file map), logged values, prints and errors, then the start and end. The
 * sentences are templates over recorded data; the shape is in docs/PROTOCOL.md. A decision reads
 * as the host's (`src/session/moments.ts`) over the same run: `if (x) took true`, `for (const x of
 * xs) ran 3 times`, `switch (k) took case 'a'` / `took default`.
 */
import { resolve } from 'node:path';
import { enclosingFunction, fileMap, walkFileMap, type FileMap } from './decisions.ts';
import { displayPath, type SavedRun } from './source.ts';
import { INLINE_MAX, PRINT_MAX, VALUE_MAX, cut, formatDuration, isUserFile, libraryPackage } from './walkthrough.ts';

type Msg = Record<string, any>;

const ORDER: Record<string, number> = { start: 0, call: 1, tool: 1, decision: 2, value: 3, print: 4, error: 5, end: 9 };
export const VALUE_KINDS = new Set(['value', 'autoLog', 'logpoint']);
const SKIP_PARAMS = new Set(['this', 'self', 'cls']);
export const PARAM_MAX = 20;
/** methods the language calls with no call in the statement */
const IMPLICIT = new Set(['toString', 'valueOf', 'toJSON', 'then', 'next', 'return', 'throw', 'get', 'set', 'has', 'apply', 'construct', 'deleteProperty', 'ownKeys', 'defineProperty', 'getOwnPropertyDescriptor', 'getPrototypeOf', 'setPrototypeOf', 'isExtensible', 'preventExtensions']);
const IDENT = /^[A-Za-z_$\p{L}][\w$\p{L}\p{N}]*$/u;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `bisect_left(xs, x)` */
export function bisectLeft(xs: number[], x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** `bisect_right(xs, x)` */
export function bisectRight(xs: number[], x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (x < xs[mid]!) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

export class MomentBuilder {
  readonly run: SavedRun;
  readonly trace: SavedRun['trace'];
  readonly all: boolean;
  readonly main: string;
  readonly root: string;
  private readonly fmaps = new Map<number, FileMap>();
  private readonly users = new Map<number, boolean>();
  /** log events used as in/out/took */
  readonly consumed = new Set<Msg>();
  moments: Msg[] = [];
  readonly stepsByScope = new Map<number, number[]>();
  readonly logsByStep = new Map<number, Msg[]>();
  readonly logSteps: number[];

  constructor(run: SavedRun, allScopes = false) {
    this.run = run;
    this.trace = run.trace;
    this.all = allScopes;
    this.main = String(run.meta.file ?? '');
    this.root = run.workspaceRoot;
    for (let i = 0; i < this.trace.count; i++) {
      const sid = this.trace.scopeId(i);
      let list = this.stepsByScope.get(sid);
      if (!list) this.stepsByScope.set(sid, (list = []));
      list.push(i);
    }
    for (const ev of run.logs) {
      if (ev.step === null || ev.step === undefined) continue;
      const step = Number(ev.step);
      let list = this.logsByStep.get(step);
      if (!list) this.logsByStep.set(step, (list = []));
      list.push(ev);
    }
    this.logSteps = [...this.logsByStep.keys()].sort((a, b) => a - b);
  }

  /** `[step, event]` for every log event recorded at a step in `first..last`, in step order */
  *logsIn(first: number, last: number): Generator<[number, Msg]> {
    let i = bisectLeft(this.logSteps, first);
    while (i < this.logSteps.length && this.logSteps[i]! <= last) {
      const step = this.logSteps[i]!;
      for (const ev of this.logsByStep.get(step)!) yield [step, ev];
      i++;
    }
  }

  // -- files ----------------------------------------------------------------------------------------------
  /** the runtime's AST table (`file.instrumented.walk`, what the host's walkthrough reads) when the run has one, else the source parsed here */
  fmap(fid: number): FileMap {
    let m = this.fmaps.get(fid);
    if (!m) {
      const walk = this.run.files.get(fid)?.walk;
      m = walk && typeof walk === 'object' ? walkFileMap(walk, fileMap(this.run.sourceLines(fid).join('\n'), this.run.filePath(fid) ?? 'x.js')) : fileMap(this.run.sourceLines(fid).join('\n'), this.run.filePath(fid) ?? 'x.js');
      this.fmaps.set(fid, m);
    }
    return m;
  }

  user(fid: number): boolean {
    let u = this.users.get(fid);
    if (u === undefined) {
      u = isUserFile(this.run.filePath(fid), this.root, this.main);
      this.users.set(fid, u);
    }
    return u;
  }

  /** `[fileId, line, rid]` of a step; `[-1, 0, rid]` without a mapping */
  loc(step: number): [number, number, number] {
    const l = this.trace.location(step);
    return l ? [l[0], Number(l[1][0]), this.trace.rid(step)] : [-1, 0, this.trace.rid(step)];
  }

  location(step: number, fn: string | null = null): Msg {
    const [fid, line] = this.loc(step);
    return { file: this.run.filePath(fid), line, function: fn !== null ? fn : this.scopeQualname(this.trace.scopeId(step)), fileId: fid };
  }

  mainFileId(): number {
    const main = resolve(this.main);
    for (const [fid, f] of this.run.files) if (resolve(String(f.path)) === main) return fid;
    return this.run.files.size ? Math.min(...this.run.files.keys()) : 1;
  }

  display(fid: number): string {
    return displayPath(this.run.filePath(fid), this.root);
  }

  // -- names ----------------------------------------------------------------------------------------------
  scopeQualname(scopeId: number): string {
    const s = this.trace.scope(scopeId);
    if (!s || Number(s.parent ?? -1) < 0) return '<module>';
    const loc = this.run.locate(Number(s.rid));
    if (loc === null) return String(s.name);
    if (String(s.name) === '<module>') return '<module>';
    const qual = this.fmap(loc.fileId).qualnames.get(Number(loc.range[0]));
    return qual || String(s.name);
  }

  functionAt(fid: number, line: number): string {
    const fn = enclosingFunction(this.fmap(fid), line);
    return fn ? String(fn.name) : '<module>';
  }

  // -- scopes --------------------------------------------------------------------------------------------
  callSite(scope: Msg): number {
    const steps = this.stepsByScope.get(Number(scope.parent)) ?? [];
    const i = bisectLeft(steps, Number(scope.first)) - 1;
    return i >= 0 ? steps[i]! : Number(scope.first);
  }

  /** the last step of scope `scopeId` before step `before` (`before` itself when there is none) */
  siteIn(scopeId: number, before: number): number {
    const steps = this.stepsByScope.get(scopeId) ?? [];
    const i = bisectLeft(steps, before) - 1;
    return i >= 0 ? steps[i]! : before;
  }

  /** the source of the whole statement a step ran (every line of its range) */
  statementText(step: number): string {
    const loc = this.run.locate(this.trace.rid(step));
    if (loc === null) return '';
    const lines = this.run.sourceLines(loc.fileId);
    const rng = loc.range;
    return lines.slice(Number(rng[0]) - 1, Number(rng[2])).join('\n');
  }

  /**
   * The scope that was running when code the recording does not show called `s` back, else null.
   * `s` is a callback when the statement at its call site has a call but does not name it (a
   * library invoking a handler; `<arrow>`/`<anonymous>` functions and generators are never
   * counted). Its recorded parent can be too shallow, so the caller is the latest-entered scope
   * under the recorded parent that was still running; else the recorded parent.
   */
  callbackCaller(s: Msg, site: number, openScopes: Msg[]): number | null {
    const name = String(s.name).split('.').pop()!;
    const first = Number(s.first);
    if (name.startsWith('<') || (name.startsWith('__') && name.endsWith('__')) || site >= first) return null;
    const text = this.statementText(site);
    // `new Box(...)` names the class, not `constructor`; an implicit call (`toString`, `valueOf`, a getter) names nothing
    if (name === 'constructor') {
      const cls = this.scopeQualname(Number(s.scopeId)).split('.').slice(-2, -1)[0];
      if (!cls || new RegExp(`(?<![A-Za-z0-9_$])(?:new\\s+)?${escapeRe(cls)}(?![A-Za-z0-9_$])|\\bsuper\\s*\\(`).test(text)) return null;
    }
    if (IMPLICIT.has(name) || name.startsWith('get ') || name.startsWith('set ') || name.startsWith('[')) return null;
    if (!text.includes('(') || new RegExp(`(?<![A-Za-z0-9_$])${escapeRe(name)}(?![A-Za-z0-9_$])`).test(text) || this.generator(s)) return null;
    const parent = Number(s.parent);
    let best: Msg | null = null;
    for (const q of openScopes) {
      if (Number(q.last) > first && Number(q.first) < first && (best === null || Number(q.first) > Number(best.first)) && this.descends(Number(q.scopeId), parent)) best = q;
    }
    return best !== null ? Number(best.scopeId) : parent;
  }

  /** whether the scope's function has a `yield`: `it.next()` resumes it under a name the statement does not show */
  generator(s: Msg): boolean {
    const loc = this.run.locate(Number(s.rid));
    if (loc === null) return false;
    const line = Number(loc.range[0]);
    const fn = this.fmap(loc.fileId).functions.get(line);
    const end = fn ? Number(fn.end) : line;
    return this.run
      .sourceLines(loc.fileId)
      .slice(line - 1, end)
      .some((ln) => /(?<![A-Za-z0-9_$])yield(?![A-Za-z0-9_$])/.test(ln));
  }

  /** whether `scopeId` is a strict descendant of `ancestor` in the recorded parents */
  descends(scopeId: number, ancestor: number): boolean {
    let s = this.trace.scope(scopeId);
    let hops = 0;
    while (s && Number(s.parent ?? -1) >= 0 && hops < 10_000) {
      const p = Number(s.parent);
      if (p === ancestor) return true;
      s = this.trace.scope(p);
      hops++;
    }
    return false;
  }

  params(scope: Msg): Msg[] {
    const first = Number(scope.first);
    const out: Msg[] = [];
    outer: for (const step of [first, first + 1]) {
      for (const entry of this.run.localsByStep.get(step) ?? []) {
        if (Number(entry.scopeId ?? -1) === Number(scope.scopeId)) {
          for (const ch of entry.changes ?? []) if (!SKIP_PARAMS.has(ch.name)) out.push({ role: 'in', name: String(ch.name), text: cut(ch.text, VALUE_MAX) });
          if (out.length) break outer;
        }
      }
    }
    for (const step of [first, first + 1]) {
      for (const ev of this.logsByStep.get(step) ?? []) {
        if (Number(ev.rid ?? -1) === Number(scope.rid) && VALUE_KINDS.has(ev.kind) && !this.consumed.has(ev)) {
          this.consumed.add(ev);
          out.push({ role: 'in', name: String(ev.context || 'value'), text: cut(ev.text, VALUE_MAX) });
        }
      }
    }
    return out.slice(0, PARAM_MAX);
  }

  /** the `out` row: what the scope recorded at its exit (`returned`), else what the logs suggest */
  result(scope: Msg, callSite: number, last: number): Msg[] {
    const first = Number(scope.first);
    const loc = this.run.locate(Number(scope.rid));
    if ('returned' in scope || 'raised' in scope) {
      this.consumeReturnLogs(scope, loc, first, last);
      const returned = scope.returned; // null: the body ran off its end, nothing to show
      return returned !== null && returned !== undefined ? [{ role: 'out', name: 'return', text: cut(returned, VALUE_MAX) }] : [];
    }
    // an arrow or anonymous function's value is the statement's, not its own
    if (String(scope.name).startsWith('<') && String(scope.name) !== '<module>') return [];
    if (loc !== null && this.user(loc.fileId)) {
      const returns = this.fmap(loc.fileId).returns;
      let best: Msg | null = null;
      for (const [, ev] of this.logsIn(first, last)) {
        if (VALUE_KINDS.has(ev.kind) && Number(ev.fileId ?? -1) === loc.fileId && !this.consumed.has(ev)) {
          const l = this.run.locate(Number(ev.rid ?? -1));
          if (l && returns.has(Number(l.range[0]))) best = ev;
        }
      }
      if (best !== null) {
        this.consumed.add(best);
        return [{ role: 'out', name: 'return', text: cut(best.text, VALUE_MAX) }];
      }
    }
    const siteRid = this.trace.rid(callSite);
    let best: Msg | null = null;
    for (const [, ev] of this.logsIn(callSite, last + 1)) {
      if (Number(ev.rid ?? -1) === siteRid && VALUE_KINDS.has(ev.kind) && !this.consumed.has(ev)) best = ev;
    }
    if (best !== null) {
      this.consumed.add(best);
      return [{ role: 'out', name: String(best.context || 'value'), text: cut(best.text, VALUE_MAX) }];
    }
    const [lfid, lline] = this.loc(last);
    const src = lfid >= 0 ? this.run.sourceLines(lfid) : [];
    const stmt = lline > 0 && lline <= src.length ? src[lline - 1]!.trim() : '';
    const returned = stmt.startsWith('return ') ? stmt.slice('return '.length).trim().replace(/;$/, '') : null;
    if (returned && IDENT.test(returned)) {
      for (const entry of this.run.localsByStep.get(last) ?? []) {
        if (Number(entry.scopeId ?? -1) === Number(scope.scopeId)) {
          for (const ch of entry.changes ?? []) if (ch.name === returned) return [{ role: 'out', name: 'return', text: cut(ch.text, VALUE_MAX) }];
        }
      }
    }
    return [];
  }

  /** the value logs of this function's own `return` lines, so they are not listed again as values */
  consumeReturnLogs(scope: Msg, loc: Msg | null, first: number, last: number): void {
    if (loc === null || !this.user(loc.fileId)) return;
    const fmap = this.fmap(loc.fileId);
    const returns = fmap.returns;
    const defLine = Number(loc.range[0]);
    // `return f(x)` logs after f's steps, at f's last one: read on to the caller's next step
    const after = this.stepsByScope.get(Number(scope.parent ?? -1)) ?? [];
    const i = bisectRight(after, last);
    const end = i < after.length ? after[i]! : this.trace.count;
    for (const [, ev] of this.logsIn(first, Math.max(end, last + 2) - 1)) {
      if (VALUE_KINDS.has(ev.kind) && Number(ev.fileId ?? -1) === loc.fileId && !this.consumed.has(ev)) {
        const l = this.run.locate(Number(ev.rid ?? -1));
        const line = l ? Number(l.range[0]) : -1;
        const fn = returns.has(line) ? enclosingFunction(fmap, line) : null;
        if (fn !== null && Number(fn.line) === defLine) this.consumed.add(ev);
      }
    }
  }

  /** the exception a scope recorded leaving it by, when `raised` found no unhandled error event (the caller caught it) */
  exitRaised(scope: Msg, first: number, last: number): Msg[] {
    const name = scope.raised;
    if (!name) return [];
    for (const ev of this.run.errors) {
      if (ev.errorType === name && ev.step !== null && ev.step !== undefined && first <= Number(ev.step) && Number(ev.step) <= last) {
        const message = cut(ev.message, VALUE_MAX);
        return [{ role: 'out', name: 'raised', text: `${name}${message ? ': ' + message : ''}` }];
      }
    }
    return [{ role: 'out', name: 'raised', text: String(name) }];
  }

  raised(first: number, last: number): Msg[] {
    for (const ev of this.run.errors) {
      if (!ev.handled && ev.step !== null && ev.step !== undefined && first <= Number(ev.step) && Number(ev.step) <= last) {
        const message = cut(ev.message, VALUE_MAX);
        return [{ role: 'out', name: 'raised', text: `${ev.errorType ?? 'None'}${message ? ': ' + message : ''}` }];
      }
    }
    return [];
  }

  calls(): void {
    const scopes = this.trace.scopes.filter((s) => Number(s.parent ?? -1) >= 0).sort((a, b) => Number(a.first) - Number(b.first));
    const groups = new Map<number, Msg>(); // root scopeId -> group
    const groupOf = new Map<number, number>(); // member scopeId -> root scopeId
    const rootBySite = new Map<string, number>();
    const entries: Msg[] = [];
    let running: Msg[] = []; // non-library scopes entered so far that may still record a step
    for (const s of scopes) {
      const sid = Number(s.scopeId);
      const parent = Number(s.parent);
      const loc = this.run.locate(Number(s.rid));
      const fid = loc ? loc.fileId : -1;
      const library = !this.user(fid) && fid >= 0 && String(s.name) !== '<module>';
      const first = Number(s.first);
      running = running.filter((q) => Number(q.last) > first);
      if (!library) running.push(s);
      if (library && !this.all) {
        if (groupOf.has(parent)) {
          const root = groupOf.get(parent)!;
          groups.get(root)!.members.push(s);
          groupOf.set(sid, root);
          continue;
        }
        const site = this.callSite(s);
        const pkg = libraryPackage(this.run.filePath(fid));
        const siteKey = JSON.stringify([site, pkg]);
        const prior = rootBySite.get(siteKey);
        if (prior !== undefined && Number(this.trace.scope(prior)!.parent) === parent) {
          groups.get(prior)!.members.push(s);
          groupOf.set(sid, prior);
          continue;
        }
        const g = { kind: 'call', scope: s, callSite: site, members: [s], library: true, caller: null };
        groups.set(sid, g);
        groupOf.set(sid, sid);
        rootBySite.set(siteKey, sid);
        entries.push(g);
        continue;
      }
      let kind = (groupOf.has(parent) || (this.all && this.isLibraryScope(parent))) && !library ? 'tool' : 'call';
      let site = this.callSite(s);
      let caller: number | null = kind === 'tool' ? parent : null;
      if (kind === 'call' && !library && String(s.name) !== '<module>') {
        caller = this.callbackCaller(s, site, running);
        if (caller !== null) {
          kind = 'tool';
          site = this.siteIn(caller, first);
        }
      }
      entries.push({ kind, scope: s, callSite: site, members: [s], library, caller });
    }
    // a call's extent: its own steps and those of every scope under it
    const subtreeLast = new Map<number, number>(scopes.map((s) => [Number(s.scopeId), Number(s.last)]));
    for (const s of [...scopes].reverse()) {
      const sid = Number(s.scopeId);
      const parent = Number(s.parent);
      if (subtreeLast.has(parent) && subtreeLast.get(sid)! > subtreeLast.get(parent)!) subtreeLast.set(parent, subtreeLast.get(sid)!);
    }
    // numbering: calls of the same function from the same site
    const counts = new Map<string, number>();
    for (const e of entries) {
      e.key = `${Number(e.scope.rid)},${this.trace.rid(e.callSite)}`;
      counts.set(e.key, (counts.get(e.key) ?? 0) + 1);
    }
    const seen = new Map<string, number>();
    for (const e of entries) {
      const s = e.scope;
      const key: string = e.key;
      seen.set(key, (seen.get(key) ?? 0) + 1);
      const n = counts.get(key)!;
      const i = seen.get(key)!;
      const callee = this.scopeQualname(Number(s.scopeId));
      const first = Number(s.first);
      const last = Math.max(...e.members.map((m: Msg) => subtreeLast.get(Number(m.scopeId))!));
      const site: number = e.callSite;
      const loc = this.run.locate(Number(s.rid));
      const fid = loc ? loc.fileId : -1;
      let text: string;
      let step: number;
      let location: Msg;
      if (String(s.name) === '<module>') {
        text = `module ${this.display(fid)} runs`;
        step = site;
        location = this.location(site);
      } else if (e.kind === 'tool') {
        const caller = this.scopeQualname(Number(e.caller));
        const siteFid = this.loc(site)[0];
        const pkg = this.user(siteFid) ? null : libraryPackage(this.run.filePath(siteFid));
        text = pkg ? `${pkg} calls back into ${callee} (${caller})` : `callback into ${callee} from ${caller}`;
        step = first;
        location = this.location(first, callee);
      } else {
        const caller = this.scopeQualname(Number(s.parent));
        const who = callee + (e.library ? ` (${libraryPackage(this.run.filePath(fid))})` : '');
        text = n > 1 ? `call ${i} of ${n} to ${who} from ${caller}` : `call to ${who} from ${caller}`;
        const nested = e.members.length - 1;
        if (nested) text += `, ${nested} nested call${nested === 1 ? '' : 's'}`;
        step = site;
        location = this.location(site, caller);
      }
      const raisedRows = this.raised(first, last);
      const values = [...this.params(s), ...this.result(s, site, last), ...(raisedRows.length ? raisedRows : this.exitRaised(s, first, last))];
      const moment: Msg = { kind: e.kind, step, location, text, values, scopeId: Number(s.scopeId), entryStep: first, endStep: last, callee: { file: this.run.filePath(fid), line: loc ? Number(loc.range[0]) : 0, function: callee, fileId: fid }, key };
      if (e.kind === 'tool') moment.callerScopeId = Number(e.caller);
      this.moments.push(moment);
    }
  }

  isLibraryScope(scopeId: number): boolean {
    const s = this.trace.scope(scopeId);
    if (!s || Number(s.parent ?? -1) < 0) return false;
    const loc = this.run.locate(Number(s.rid));
    return loc !== null && !this.user(loc.fileId) && String(s.name) !== '<module>';
  }

  // -- decisions, loops ----------------------------------------------------------------------------------
  nextInScope(step: number): number | null {
    const steps = this.stepsByScope.get(this.trace.scopeId(step)) ?? [];
    const i = bisectRight(steps, step);
    return i < steps.length ? steps[i]! : null;
  }

  tookValue(step: number, rid: number): Msg[] {
    for (const ev of this.logsByStep.get(step) ?? []) {
      if (Number(ev.rid ?? -1) === rid && VALUE_KINDS.has(ev.kind) && !this.consumed.has(ev)) {
        this.consumed.add(ev);
        return [{ role: 'took', name: String(ev.context || 'value'), text: cut(ev.text, VALUE_MAX) }];
      }
    }
    return [];
  }

  decisionsAndLoops(): void {
    const openLoops = new Map<number, Msg[]>(); // scope -> stack of open loop moments
    for (let i = 0; i < this.trace.count; i++) {
      const [fid, line, rid] = this.loc(i);
      if (fid < 0 || !this.user(fid)) continue;
      const sid = this.trace.scopeId(i);
      const loc = this.run.locate(rid);
      const startsHere = loc !== null && Number(loc.range[0]) === line;
      let stack = openLoops.get(sid);
      if (!stack) openLoops.set(sid, (stack = []));
      while (stack.length && !(stack[stack.length - 1]!._fid === fid && stack[stack.length - 1]!._line <= line && line <= stack[stack.length - 1]!._end)) stack.pop();
      if (!startsHere) continue;
      const fm = this.fmap(fid);
      // a statement sharing the header's line (`if (p > 3) log(p);`) is not the header
      const at = (h: Msg | undefined) => (h !== undefined && (h.col === undefined || Number(loc!.range[1]) === Number(h.col)) ? h : undefined);
      const loop = at(fm.loops.get(line));
      if (loop !== undefined) {
        const top = stack[stack.length - 1];
        if (top && top._line === line && top._fid === fid) top.count += 1;
        else {
          const m = { kind: 'decision', step: i, location: this.location(i), text: '', values: this.tookValue(i, rid), count: 1, _loop: loop, _fid: fid, _line: line, _end: Number(loop.end) };
          stack.push(m);
          this.moments.push(m);
        }
        continue;
      }
      const dec = at(fm.decisions.get(line));
      if (dec === undefined) continue;
      const nxt = this.nextInScope(i);
      const nline = nxt !== null && this.loc(nxt)[0] === fid ? this.loc(nxt)[1] : -1;
      const nloc = nline >= 0 ? this.run.locate(this.loc(nxt!)[2]) : null;
      const ncol = nloc ? Number(nloc.range[1]) : -1;
      this.moments.push({ kind: 'decision', step: i, location: this.location(i), text: MomentBuilder.decisionText(dec, nline, ncol), values: this.tookValue(i, rid) });
    }
    for (const m of this.moments) {
      const loop = m._loop;
      if (loop === undefined) continue;
      delete m._loop;
      const runs = Number(m.count) - 1;
      delete m.count;
      delete m._fid;
      delete m._line;
      delete m._end;
      m.text = `${loop.kind} ${loop.text} ran ${runs} time${runs === 1 ? '' : 's'}`;
      m.count = runs;
    }
  }

  /** `if x took true`: the next step of the scope landed in the body; `switch x took case y` likewise */
  static decisionText(dec: Msg, nextLine: number, nextCol = -1): string {
    if (dec.kind === 'match') {
      const arm = (dec.arms ?? []).find((a: Msg) => a.body[0] <= nextLine && nextLine <= a.body[1]);
      return `switch ${dec.text} took ${arm ? (arm.default ? 'default' : `case ${arm.text}`) : 'no case'}`;
    }
    let took = dec.body[0] <= nextLine && nextLine <= dec.body[1];
    // a body on the header's line (`for (…) if (r >= 0) total += r;`): the line alone says nothing, the column does
    const at = dec.bodyAt;
    if (took && Array.isArray(at) && nextCol >= 0 && (nextLine === at[0] || nextLine === at[2])) {
      took = (nextLine > at[0] || nextCol >= at[1]) && (nextLine < at[2] || nextCol <= at[3]);
    }
    return `${dec.label} ${dec.text} took ${took ? 'true' : 'false'}`;
  }

  // -- values, prints, errors ------------------------------------------------------------------------------
  values(): void {
    for (const ev of this.run.logs) {
      if (this.consumed.has(ev) || ev.step === null || ev.step === undefined) continue;
      const fid = Number(ev.fileId ?? -1);
      if (!this.user(fid)) continue;
      const step = Number(ev.step);
      const loc = this.run.locate(Number(ev.rid ?? -1));
      const line = loc ? Number(loc.range[0]) : 0;
      const kind = ev.kind;
      const location = { file: this.run.filePath(fid), line, function: this.functionAt(fid, line), fileId: fid };
      if (kind === 'log') {
        const where = ev.context === 'stderr' ? ' to stderr' : '';
        this.moments.push({ kind: 'print', step, location, text: `prints${where} ${cut(ev.text, PRINT_MAX)}`, values: [] });
      } else if (VALUE_KINDS.has(kind)) {
        const ctx = ev.context;
        const text = ctx ? `${ctx} = ${cut(ev.text, INLINE_MAX)}` : cut(ev.text, INLINE_MAX);
        this.moments.push({ kind: 'value', step, location, text, values: [{ role: 'value', name: String(ctx || 'value'), text: cut(ev.text, VALUE_MAX) }] });
      }
    }
  }

  errors(): void {
    const seen = new Set<string>();
    const sorted = [...this.run.errors].sort((a, b) => Number(!!a.handled) - Number(!!b.handled));
    for (const ev of sorted) {
      const raw = ev.step;
      const key = JSON.stringify([ev.errorType ?? null, ev.message ?? null, raw ?? null]);
      if (seen.has(key) || raw === null || raw === undefined) continue;
      seen.add(key);
      const step = Number(raw);
      const frame = (ev.stack ?? []).find((f: Msg) => this.user(Number(f.fileId ?? -1)));
      let location: Msg;
      if (frame !== undefined) {
        const fid = Number(frame.fileId);
        const line = Number(frame.line || 0);
        location = { file: this.run.filePath(fid), line, function: this.functionAt(fid, line), fileId: fid };
      } else location = this.location(step);
      const message = cut(ev.message, INLINE_MAX);
      let text = `raised ${ev.errorType ?? 'None'}${message ? ': ' + message : ''}`;
      if (ev.handled) {
        const nxt = this.trace.valid(step + 1) ? step + 1 : null;
        if (nxt !== null && this.loc(nxt)[0] >= 0) {
          const [nfid, nline] = this.loc(nxt);
          text += `, handled at ${this.display(nfid)}:${nline}`;
        } else text += ' (handled)';
      } else text += ' uncaught';
      this.moments.push({ kind: 'error', step, location, text, values: [] });
    }
  }

  ends(): void {
    if (this.trace.count === 0) return;
    const main = this.mainFileId();
    this.moments.push({ kind: 'start', step: 0, location: this.location(0), text: `module ${this.display(main)} starts`, values: [] });
    const last = this.trace.count - 1;
    const fin = this.run.finished ?? {};
    const code = 'exitCode' in this.run.meta ? this.run.meta.exitCode : fin.exitCode;
    const ms = 'durationMs' in this.run.meta ? this.run.meta.durationMs : fin.durationMs;
    let text: string;
    if (fin.timedOut) text = `run killed by the timeout after ${formatDuration(ms)}`;
    else if (fin.stopped) text = `run stopped after ${formatDuration(ms)}`;
    else text = `run ends with exit code ${code ?? 'None'} after ${formatDuration(ms)}`;
    this.moments.push({ kind: 'end', step: last, location: this.location(last), text, values: [] });
  }

  // -- assembly --------------------------------------------------------------------------------------------
  build(): Msg[] {
    this.calls();
    this.decisionsAndLoops();
    this.values();
    this.errors();
    this.ends();
    const order = new Map(this.moments.map((m, n) => [m, n]));
    this.moments.sort((a, b) => Number(a.step) - Number(b.step) || (ORDER[a.kind] ?? 5) - (ORDER[b.kind] ?? 5) || order.get(a)! - order.get(b)!);
    this.moments.forEach((m, n) => {
      m.id = `m${n}`;
      if (!('durationMs' in m)) m.durationMs = null;
      if (!('gloss' in m)) m.gloss = null;
    });
    return this.moments;
  }
}
