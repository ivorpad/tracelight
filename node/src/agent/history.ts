/**
 * Variable history over a `SavedRun`: every recorded change of one
 * name, in step order (docs/PROTOCOL.md, "Variable history").
 *
 * Three sources, in order of trust: recorded locals (`locals` events, once the runtime records
 * them), logged values whose context is the name (`// ?`, Auto Log), and the statements that
 * assign the name (bindings from the AST, `../bindings.ts`) when nothing recorded the value. The
 * provenance tree reuses the same lookups: `rows` for the change at a step, `valueAt` for what a
 * statement read.
 *
 * A locals entry at step S is the state at the *start* of S, so a change it reports was made by
 * the scope's previous step; when that statement binds the name the change is attributed to it.
 * Loop headers are the exception: the per-iteration step fires after the target is bound, so an
 * iteration step owns the change it observes. Each change carries `reads`: the names the
 * statement loaded, with the latest value recorded for each before the step, one level.
 */
import type { StatementBinding } from '../bindings.ts';
import { matchesName } from './bindings.ts';
import { sortBy } from './context.ts';
import { MAX_LOCALS_ENTRIES } from './protocol.ts';
import type { SavedRun } from './source.ts';
import type { Trace } from './trace.ts';

type Msg = Record<string, any>;

export const VAR_CAP = 200;
export const VAR_READS = 8;
/** a `// ?+` entry is a value of its context like a `// ?` */
export const VALUE_KINDS = ['value', 'autoLog', 'autoExpand'];

/** the text of a function or a class: a value no statement of the run made */
export function isDefinition(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = String(text);
  return t.startsWith('[Function') || t.startsWith('[AsyncFunction') || t.startsWith('[GeneratorFunction') || t.startsWith('[AsyncGeneratorFunction') || t.startsWith('[class ') || t.startsWith('<function ') || t.startsWith('<class ');
}

/** scopes that are a module body of `fileId`: scope 0 for the main file, the depth-1 module scope of an imported project file */
function moduleScopeIds(run: SavedRun, fileId: number): Set<number> {
  const out = new Set<number>();
  for (const s of run.trace.scopes) {
    const loc = run.locate(Number(s.rid ?? -1));
    if (loc && loc.fileId === fileId && loc.localRid === 0) out.add(Number(s.scopeId));
  }
  if (fileId === run.mainFileId()) out.add(0);
  return out;
}

export function previousStepInScope(run: SavedRun, step: number, scopeId: number): number {
  const scope = run.trace.scope(scopeId);
  const first = scope ? Number(scope.first) : 0;
  for (let j = step - 1; j >= first && j >= 0; j--) if (run.trace.scopeId(j) === scopeId) return j;
  return -1;
}

export function nextStepInScope(run: SavedRun, step: number, scopeId: number): number {
  const scope = run.trace.scope(scopeId);
  const last = scope ? Number(scope.last) : run.trace.count - 1;
  for (let j = step + 1; j <= last && j < run.trace.count; j++) if (run.trace.scopeId(j) === scopeId) return j;
  return -1;
}

export class History {
  readonly run: SavedRun;
  readonly trace: Trace;
  /** name -> [observed step, scopeId, text] ascending */
  readonly localsByName = new Map<string, [number, number, string][]>();
  /** context -> log events ascending by step, the kinds that carry a variable's value */
  readonly valuesByContext = new Map<string, Msg[]>();
  /** every step was observed, so a name with no recorded change at the next step of its scope kept its object */
  readonly observedAll: boolean;
  private readonly objectIds = new Map<string, [number, number, number | undefined][]>();
  private readonly moduleScopeCache = new Map<number, Set<number>>();

  constructor(run: SavedRun) {
    this.run = run;
    this.trace = run.trace;
    for (const entry of run.localsEntries) {
      const step = Number(entry.step ?? -1);
      const sid = Number(entry.scopeId ?? 0);
      for (const ch of entry.changes ?? []) {
        const name = ch.name;
        if (!name) continue;
        {
          const records = this.objectIds.get(name) ?? [];
          records.push([step, sid, ch.objectId]); this.objectIds.set(name, records);
        }
        if (!this.localsByName.has(String(name))) this.localsByName.set(String(name), []);
        this.localsByName.get(String(name))!.push([step, sid, String(ch.text ?? '')]);
      }
    }
    for (const [k, lst] of this.localsByName) this.localsByName.set(k, sortBy(lst, (t) => [t[0]]));
    for (const ev of run.logs) {
      const ctx = ev.context;
      if (ctx && VALUE_KINDS.includes(ev.kind) && ev.step !== null && ev.step !== undefined) {
        if (!this.valuesByContext.has(String(ctx))) this.valuesByContext.set(String(ctx), []);
        this.valuesByContext.get(String(ctx))!.push(ev);
      }
    }
    for (const [k, lst] of this.valuesByContext) this.valuesByContext.set(k, sortBy(lst, (e) => [Number(e.step)]));
    this.observedAll = run.localsEntries.length > 0 && run.localsEntries.length < MAX_LOCALS_ENTRIES;
  }

  moduleScopes(fileId: number): Set<number> {
    let s = this.moduleScopeCache.get(fileId);
    if (!s) {
      s = moduleScopeIds(this.run, fileId);
      this.moduleScopeCache.set(fileId, s);
    }
    return s;
  }

  /** where the statement at `step` is, as a change row (and a provenance node) carries it */
  location(step: number): Msg {
    const loc = this.trace.location(step);
    const sid = this.trace.scopeId(step);
    return {
      step,
      file: loc ? this.run.filePath(loc[0]) : null,
      fileId: loc ? loc[0] : -1,
      line: loc ? Number(loc[1][0]) : 0,
      function: this.run.scopeName(sid),
      scopeId: sid,
    };
  }

  private row(step: number, name: string, text: string | null, source: string): Msg {
    const row: Msg = { ...this.location(step), name, source };
    if (text !== null) row.text = text;
    return row;
  }

  /**
   * The log entry the statement at `step` wrote for `name`, when there is one. A value is logged
   * when its statement completes, so the entry's step is the last step the statement ran (inside
   * a callee when it called one): the entry belongs to the statement whose range it names and
   * lies between the step and the scope's next step.
   */
  logFor(step: number, name: string): string | null {
    const rid = this.trace.rid(step);
    let end = nextStepInScope(this.run, step, this.trace.scopeId(step));
    if (end < 0) end = this.trace.count;
    let found: Msg | null = null;
    for (const ev of this.valuesByContext.get(name) ?? []) {
      const s = Number(ev.step);
      if (s >= end) break;
      if (s >= step && Number(ev.rid ?? -1) === rid) found = ev;
    }
    return found && found.logId ? String(found.logId) : null;
  }

  /**
   * The latest recorded value of `name` visible at the start of `step`, from the step's scope or
   * its module: `{name}` alone when nothing was recorded; else `text`, `source` (`locals` or
   * `value`), `step` (the statement that made it) and `logId` when a log entry holds the value.
   */
  valueAt(name: string, step: number, scopeId: number, fileId: number): Msg {
    const scopes = new Set([scopeId, ...this.moduleScopes(fileId)]);
    let bestStep = -1;
    let bestText: string | null = null;
    let bestScope = scopeId;
    const locals = this.localsByName.get(name) ?? [];
    for (let i = locals.length - 1; i >= 0; i--) {
      const [s, sid, text] = locals[i]!;
      if (s > step) continue;
      if (scopes.has(sid)) {
        [bestStep, bestText, bestScope] = [s, text, sid];
        break;
      }
    }
    let event: Msg | null = null;
    const values = this.valuesByContext.get(name) ?? [];
    for (let i = values.length - 1; i >= 0; i--) {
      const ev = values[i]!;
      const s = Number(ev.step);
      if (s >= step || s <= bestStep) continue;
      if (scopes.has(this.trace.scopeId(s))) {
        [bestStep, bestText, event] = [s, String(ev.text ?? ''), ev];
        break;
      }
    }
    const out: Msg = { name };
    if (bestStep < 0) return out;
    out.text = bestText;
    let logId: string | null;
    if (event === null && isDefinition(bestText)) {
      // a recorded local that is a definition has no producing step: declarations are never steps
      out.source = 'locals';
      return out;
    }
    if (event === null) {
      out.source = 'locals';
      out.step = this.attribute(bestStep, bestScope, name);
      logId = this.logFor(Number(out.step), name);
    } else {
      out.source = 'value';
      out.step = bestStep;
      logId = event.logId ?? null;
    }
    if (logId) out.logId = String(logId);
    return out;
  }

  bindingAt(step: number): StatementBinding | null {
    const loc = this.trace.location(step);
    if (loc === null) return null;
    return this.run.bindings(loc[0]).get(this.trace.rid(step)) ?? null;
  }

  /** a loop header step that follows a step of the loop's own lines in the same scope (not the step before the loop) */
  isIterationStep(step: number, binding: StatementBinding): boolean {
    const end = binding.loop;
    if (end === undefined || end === null) return false;
    const prev = previousStepInScope(this.run, step, this.trace.scopeId(step));
    if (prev < 0) return false;
    const here = this.trace.location(step);
    const there = this.trace.location(prev);
    return !!(here && there && there[0] === here[0] && Number(here[1][0]) <= Number(there[1][0]) && Number(there[1][0]) <= Number(end));
  }

  private objectAt(name: string, step: number, scope: number): number | undefined {
    return this.objectIds.get(name)?.findLast(([s, sid]) => s <= step && sid === scope)?.[2];
  }

  /** the step whose statement made the change observed at `observed` */
  attribute(observed: number, scopeId: number, changed: string): number {
    const own = this.bindingAt(observed);
    if (own && own.loop !== undefined && own.loop !== null && (own.assigns ?? []).some((a) => matchesName(a, changed)) && this.isIterationStep(observed, own)) return observed;
    const prev = previousStepInScope(this.run, observed, scopeId);
    if (prev >= 0) {
      const binding = this.bindingAt(prev);
      if (binding && (binding.assigns ?? []).some((a) => matchesName(a, changed))) return prev;
      const id = this.objectAt(changed, observed, scopeId);
      if (id !== undefined && this.objectAt(changed, prev, scopeId) === id && binding) {
        const targets = binding.assigns ?? [];
        if (targets.some(target => {
          const root = /^[A-Za-z_$][\w$]*/.exec(target)?.[0];
          return root && this.objectAt(root, prev, scopeId) === id;
        })) return prev;
      }
    }
    return observed;
  }

  /** the names the statement at `step` loaded (at most `VAR_READS`), each resolved with `valueAt` */
  resolvedReads(step: number): Msg[] {
    const loc = this.trace.location(step);
    const binding = this.bindingAt(step);
    if (loc === null || !binding) return [];
    const sid = this.trace.scopeId(step);
    return (binding.reads ?? []).slice(0, VAR_READS).map((n) => this.valueAt(n, step, sid, loc[0]));
  }

  /** the change list's reads: `{name, text?, step?}`, one level (the provenance tree keeps the rest) */
  readsFor(step: number): Msg[] {
    return this.resolvedReads(step).map((r) => {
      const o: Msg = {};
      for (const k of Object.keys(r)) if (k === 'name' || k === 'text' || k === 'step') o[k] = r[k];
      return o;
    });
  }

  /** every change of `name` from the three sources, ascending by step, before caps, filters and reads */
  rows(name: string): Msg[] {
    const rows = new Map<string, Msg>();
    const add = (row: Msg) => {
      const key = `${Number(row.step)}\u0000${String(row.name)}`;
      const have = rows.get(key);
      if (have === undefined) rows.set(key, row);
      else if (row.logId && !have.logId) have.logId = row.logId;
    };
    // 1. recorded locals, attributed to the statement that bound the name when the scope's previous step did
    for (const entry of this.run.localsEntries) {
      const observed = Number(entry.step ?? -1);
      const sid = Number(entry.scopeId ?? 0);
      if (!this.trace.valid(observed)) continue;
      for (const ch of entry.changes ?? []) {
        const changed = String(ch.name || '');
        if (!matchesName(changed, name)) continue;
        add(this.row(this.attribute(observed, sid, changed), changed, String(ch.text ?? ''), 'locals'));
      }
    }
    // 2. logged values whose context is the name (or a path under it)
    for (const [ctx, events] of this.valuesByContext) {
      if (!matchesName(ctx, name)) continue;
      for (const ev of events) {
        const step = Number(ev.step);
        if (!this.trace.valid(step)) continue;
        const row = this.row(step, ctx, String(ev.text ?? ''), 'value');
        if (ev.logId) row.logId = ev.logId;
        add(row);
      }
    }
    // 3. statements that assign the name, where nothing recorded the value (a loop header only on its iteration steps)
    const assigning = new Map<number, [string, StatementBinding]>();
    for (const fid of this.run.files.keys()) {
      for (const [rid, binding] of this.run.bindings(fid)) {
        for (const a of binding.assigns ?? []) {
          if (matchesName(a, name)) {
            assigning.set(rid, [a, binding]);
            break;
          }
        }
      }
    }
    if (assigning.size) {
      const stepsWithRows = new Set([...rows.values()].map((r) => Number(r.step)));
      for (let step = 0; step < this.trace.count; step++) {
        const hit = assigning.get(this.trace.rid(step));
        if (hit === undefined || stepsWithRows.has(step)) continue;
        const [a, binding] = hit;
        if (binding.loop !== undefined && binding.loop !== null && !this.isIterationStep(step, binding)) continue;
        const row = this.row(step, a, null, 'assign');
        // The scope's next step recorded no change for the name, so it is the same object (which is
        // not the same as unchanged: rendered as `(same object)` for that reason).
        if (this.observedAll && a === name && nextStepInScope(this.run, step, row.scopeId) >= 0) {
          const before = this.valueAt(a, step, row.scopeId, row.fileId);
          if (before.text !== null && before.text !== undefined) {
            row.text = before.text;
            row.unchanged = true;
          }
        }
        add(row);
      }
    }
    return sortBy([...rows.values()], (r) => [Number(r.step), String(r.name)]);
  }

  build(name: string, opts: { fileId?: number | null; scope?: string | null; limit?: number } = {}): Msg {
    let ordered = this.rows(name);
    if (opts.fileId !== null && opts.fileId !== undefined) ordered = ordered.filter((r) => r.fileId === opts.fileId);
    if (opts.scope !== null && opts.scope !== undefined) ordered = ordered.filter((r) => r.function === opts.scope);
    const shown = ordered.slice(0, Math.max(1, opts.limit ?? VAR_CAP));
    for (const row of shown) {
      const reads = this.readsFor(Number(row.step));
      if (reads.length) row.reads = reads;
    }
    return {
      name,
      changes: shown,
      total: ordered.length,
      truncated: ordered.length > shown.length,
      recordedLocals: this.run.localsEntries.length > 0,
      stale: this.run.staleFiles().length > 0,
      staleFiles: this.run.staleFiles(),
    };
  }
}

/** every recorded change of `name` (docs/PROTOCOL.md, "Variable history"), ascending by step */
export function variableHistory(run: SavedRun, name: string, opts: { fileId?: number | null; scope?: string | null; limit?: number } = {}): Msg {
  return new History(run).build(name.trim(), opts);
}
