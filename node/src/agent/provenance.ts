/**
 * The provenance tree (`why`): why a value is what it is, walked backwards through the run, as
 * Pyokka's `agent/provenance.py` (docs/PROTOCOL.md, "Provenance").
 *
 * Nothing here is new data: the root is the change `var` lists at the step (or the value the
 * name had when the step ran), a node's reads are `var`'s reads resolved one statement further
 * back, its calls are the walkthrough's call moments in short, and the calls no stepped scope
 * claimed come from the bindings' `calls` texts. Expansion is breadth-first with a depth and a
 * node budget, so a tree over a long chain stays readable.
 */
import { PROVENANCE_DEPTH, PROVENANCE_MAX_DEPTH, PROVENANCE_NODES } from './protocol.ts';
import { History } from './history.ts';
import { MomentBuilder } from './moments.ts';
import { conclusion } from './why_text.ts';
import type { SavedRun } from './source.ts';

type Msg = Record<string, any>;

export const CALLS_SHOWN = 8;
export const INPUTS_SHOWN = 8;

/** the last dotted name before the parenthesis: `describe` for `helper.describe(total, sep)`, `Box` for `new Box(xs)` */
export function calleeName(callText: string): string {
  const head = callText.split('(')[0]!.trim().replace(/^new\s+/, '');
  return head.split('.').pop()!.trim().replace(/^#/, '').replace(/\?$/, '');
}

export class ProvenanceBuilder {
  readonly run: SavedRun;
  readonly trace: SavedRun['trace'];
  readonly history: History;
  readonly moments: MomentBuilder;
  /** call site -> the scopes it entered, in entry order (the walkthrough's rule: the parent's last step before the scope's first) */
  readonly scopesBySite = new Map<number, Msg[]>();

  constructor(run: SavedRun) {
    this.run = run;
    this.trace = run.trace;
    this.history = new History(run);
    this.moments = new MomentBuilder(run);
    const scopes = this.trace.scopes.filter((s) => Number(s.parent ?? -1) >= 0).sort((a, b) => Number(a.first) - Number(b.first));
    for (const s of scopes) {
      const site = this.moments.callSite(s);
      let list = this.scopesBySite.get(site);
      if (!list) this.scopesBySite.set(site, (list = []));
      list.push(s);
    }
  }

  // -- nodes ------------------------------------------------------------------------------------------------
  /** the first source line of the statement at `step`, trimmed, ` …` appended when it spans more lines */
  statement(step: number): string | null {
    const loc = this.trace.location(step);
    if (!loc) return null;
    const src = this.run.sourceLines(loc[0]);
    const line = Number(loc[1][0]);
    const end = Number(loc[1][2]);
    if (!(line > 0 && line <= src.length)) return null;
    const text = src[line - 1]!.trim();
    return end > line ? text + ' …' : text;
  }

  node(name: string, step: number, opts: { text?: string | null; source?: string | null; logId?: string | null; unchanged?: boolean } = {}): Msg {
    const out: Msg = { name };
    if (opts.text !== null && opts.text !== undefined) out.text = opts.text;
    if (opts.source) out.source = opts.source;
    if (opts.logId) out.logId = opts.logId;
    if (opts.unchanged) out.unchanged = true;
    Object.assign(out, this.history.location(step));
    const statement = this.statement(step);
    if (statement !== null) out.statement = statement;
    return out;
  }

  /** nothing recorded for the name; in a recording that began mid-run that is where the chain ends: at step 0 */
  leaf(name: string): Msg {
    return this.run.midRun ? { name, beforeRecording: true } : { name };
  }

  /** a node for what `valueAt` found: a leaf when nothing was recorded, else the producing statement */
  fromRead(read: Msg): Msg {
    if (read.step === null || read.step === undefined) return read.text === null || read.text === undefined ? this.leaf(read.name) : { name: read.name };
    return this.node(read.name, Number(read.step), { text: read.text, source: read.source, logId: read.logId });
  }

  /**
   * The value `name` had after `step`: the change made there, else the value read there, else a
   * leaf. A dotted name nothing recorded falls back to its first segment (`this` for
   * `this.balance`); an empty name is the statement itself.
   */
  root(name: string, step: number): Msg {
    if (!name) return this.node('', step);
    const rows = this.history.rows(name).filter((r) => Number(r.step) === step);
    const exact = rows.filter((r) => r.name === name);
    const row = exact.length ? exact[0] : rows.length ? rows[0] : null;
    if (row) {
      const logId = row.logId || this.history.logFor(step, String(row.name));
      return this.node(String(row.name), step, { text: row.text, source: row.source, logId, unchanged: !!row.unchanged });
    }
    const loc = this.trace.location(step);
    const scopeId = this.trace.scopeId(step);
    const fileId = loc ? loc[0] : -1;
    let read = this.history.valueAt(name, step, scopeId, fileId);
    if ((read.step === null || read.step === undefined) && name.includes('.')) read = this.history.valueAt(name.split('.')[0]!, step, scopeId, fileId);
    return read.step !== null && read.step !== undefined ? this.fromRead(read) : this.leaf(name);
  }

  // -- a statement's inputs ---------------------------------------------------------------------------------
  reads(step: number): Msg[] {
    return this.history.resolvedReads(step).map((r) => this.fromRead(r));
  }

  /** the scopes the statement entered, as the walkthrough's call moments list them, in entry order */
  calls(step: number): Msg[] {
    const scopeId = this.trace.scopeId(step);
    const out: Msg[] = [];
    for (const s of this.scopesBySite.get(step) ?? []) {
      if (Number(s.parent) !== scopeId) continue;
      const first = Number(s.first);
      const last = Number(s.last);
      const loc = this.run.locate(Number(s.rid));
      const fid = loc ? loc.fileId : -1;
      this.moments.consumed.clear(); // params and result mark the log entries they use; every call node stands alone
      const inputs = this.moments
        .params(s)
        .filter((p) => p.role === 'in')
        .map((p) => ({ name: p.name, text: p.text }))
        .slice(0, INPUTS_SHOWN);
      const result = this.moments.result(s, step, last).find((v) => v.role === 'out')?.text ?? null;
      const call: Msg = { name: String(s.name), scopeId: Number(s.scopeId), entryStep: first, returnStep: last, file: this.run.filePath(fid), fileId: fid, line: loc ? Number(loc.range[0]) : 0, inputs };
      if (result !== null) call.result = result;
      out.push(call);
      if (out.length === CALLS_SHOWN) break;
    }
    return out;
  }

  /**
   * The bindings' call texts no stepped scope claimed: each scope takes the first unclaimed text
   * whose callee is its name (a `constructor` scope: `new X(...)` or a callee that starts with a capital).
   */
  opaque(step: number, calls: Msg[]): string[] {
    const binding: Msg = this.history.bindingAt(step) ?? {};
    const texts: string[] = [...(binding.calls ?? [])];
    const claimed = new Set<number>();
    for (const call of calls) {
      for (let i = 0; i < texts.length; i++) {
        if (claimed.has(i)) continue;
        const callee = calleeName(texts[i]!);
        const ctor = call.name === 'constructor' || call.name === '__init__';
        if (callee === call.name || (ctor && (/^\s*new\s/.test(texts[i]!) || /^[A-Z]/.test(callee)))) {
          claimed.add(i);
          break;
        }
      }
    }
    return texts.filter((_, i) => !claimed.has(i));
  }

  // -- the tree ---------------------------------------------------------------------------------------------
  build(name: string, step: number, depthIn: number, budget: number): Msg {
    const depth = Math.max(1, Math.min(PROVENANCE_MAX_DEPTH, Math.trunc(depthIn)));
    const root = this.root(name, step);
    let count = 1;
    let truncated = false;
    const queue: [Msg, number][] = [[root, 0]];
    while (queue.length) {
      const [node, level] = queue.shift()!;
      if (node.step === null || node.step === undefined) continue;
      if (level >= depth) {
        node.cut = true;
        continue;
      }
      const reads = this.reads(Number(node.step));
      if (count + reads.length > budget) {
        node.cut = true;
        truncated = true;
        continue;
      }
      count += reads.length;
      const calls = this.calls(Number(node.step));
      node.reads = reads;
      node.calls = calls;
      node.opaque = this.opaque(Number(node.step), calls);
      // a name read from itself, or a loop variable, ends here: only an earlier statement is walked
      for (const read of reads) if (read.step !== null && read.step !== undefined && Number(read.step) < Number(node.step)) queue.push([read, level + 1]);
    }
    const result: Msg = { name, step, depth, nodes: count, truncated, recordedLocals: this.run.localsEntries.length > 0, root };
    result.conclusion = conclusion(result); // the answer in words (why_text.ts); empty when nothing was recorded
    return result;
  }
}

/** the tree of what produced the value `name` had after `step` (docs/PROTOCOL.md, "Provenance") */
export function provenance(run: SavedRun, step: number, name = '', depth = PROVENANCE_DEPTH, nodes = PROVENANCE_NODES): Msg {
  return new ProvenanceBuilder(run).build(name.trim(), step, depth, nodes);
}
