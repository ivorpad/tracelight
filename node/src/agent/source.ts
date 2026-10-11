/**
 * Where a run comes from, as Pyokka's `agent/source.py`: `RunSource` is the seam, `SavedRun`
 * reads `run.json` (written by `tracelight run --save`, Pyokka's `{meta, events}` shape).
 *
 * The command layer (`commands.ts`) only ever sees the JSON shapes of docs/PROTOCOL.md ("Context
 * slice", the bridge replies). A live source (the extension's bridge, `live.ts` once ported)
 * implements the same methods and answers with the same shapes. Anything a source cannot do
 * throws `AgentError` with a `hint` that says what to do next. A method may answer with a
 * Promise (the kept runner is reached over a socket); the command layer awaits every answer.
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
import { bindings as statementBindings, type StatementBinding } from '../bindings.ts';
import { NAME } from '../protocol.ts';
import { functionBindings, indexBindings } from './bindings.ts';
import * as sliceMod from './context.ts';
import * as historyMod from './history.ts';
import { LinkClosed, SocketLink } from './link.ts';
import { PROVENANCE_DEPTH, decodeSteps } from './protocol.ts';
import { capInfo } from './recording.ts';
import { redactValue } from './redact.ts';
import { fileHash, readText } from './save.ts';
import { Trace } from './trace.ts';

type Msg = Record<string, any>;

export class AgentError extends Error {
  readonly hint: string | null;

  constructor(message: string, hint: string | null = null) {
    super(message);
    this.hint = hint;
  }

  toJson(): Msg {
    const out: Msg = { ok: false, error: this.message };
    if (this.hint) out.hint = this.hint;
    return out;
  }
}

type Answer = Msg | Promise<Msg>;

/** what every command needs; answers are the contract's JSON shapes (plain objects) */
export interface RunSource {
  state(): Answer;
  context(opts: { step?: number | null; file?: string | null; line?: number | null; scope?: boolean }): Answer;
  step(step: number | null, opts: { kind?: string | null; to?: number | null; scope?: boolean; count?: number }): Answer;
  values(file: string, line: number): Answer;
  eval(expression: string, opts?: { frame?: number | null }): Answer;
  expand(valueId: string, queryPath: string[]): Answer;
  story(opts: { file?: string | null; scope?: string | null; line?: [string, number] | null; limit?: number }): Answer;
  steps(opts: { start?: number; count?: number; line?: [string, number] | null }): Answer;
  find(text: string, limit?: number): Answer;
  var(name: string, opts: { file?: string | null; scope?: string | null; limit?: number }): Answer;
  displayPath(path: string | null | undefined): string;
  close(): void | Promise<void>;
  /** set when the step cap cut the recording behind this source (`recording.ts` capInfo) */
  recording?: Msg | null;
  /** a source may answer more verbs (`release`, `watch`, a later verb's own method) */
  [method: string]: any;
}

const SAVED_METHODS = new Map<string, (run: SavedRun, ...args: any[]) => Answer>();

/**
 * Teach `SavedRun` a method without editing it: a later module (walkthrough, graph, exceptions,
 * http, why, ...) registers `name` with its implementation over a saved run, and `callSource`
 * reaches it. A live source answers the same method over its bridge instead.
 */
export function registerSavedMethod(name: string, impl: (run: SavedRun, ...args: any[]) => Answer): void {
  SAVED_METHODS.set(name, impl);
}

/** `source[method](...args)`: the source's own method (a live session's bridge, `SavedRun`'s built-ins), else the registered saved-run one */
export function callSource(source: RunSource, method: string, ...args: unknown[]): Answer {
  if (typeof source[method] === 'function') return source[method](...args);
  const impl = SAVED_METHODS.get(method);
  if (impl && source instanceof SavedRun) return impl(source, ...args);
  throw new AgentError(`this run cannot answer ${method}`, `${NAME} has no ${method} for this source yet`);
}

const LIBRARY_MARKERS = ['node_modules' + sep, 'site-packages' + sep, 'dist-packages' + sep];

/** workspace-relative, or from `node_modules/` on (the package and its path), or the path itself: never a bare absolute dump */
export function displayPath(path: string | null | undefined, workspaceRoot: string): string {
  if (!path) return '<unknown>';
  for (const marker of LIBRARY_MARKERS) {
    // a node_modules (or a venv) inside the workspace is still a library
    const i = path.lastIndexOf(marker);
    if (i >= 0 && (i === 0 || path[i - 1] === sep)) return path.slice(i + marker.length);
  }
  const root = workspaceRoot.replace(new RegExp(`${sep === '\\' ? '\\\\' : sep}+$`), '') + sep;
  if (path.startsWith(root)) return path.slice(root.length);
  return path;
}

export class SavedRun implements RunSource {
  readonly path: string;
  readonly meta: Msg;
  readonly events: Msg[];
  readonly workspaceRoot: string;
  readonly files = new Map<number, Msg>();
  readonly logs: Msg[] = [];
  readonly logsByRid = new Map<number, Msg[]>();
  readonly localsEntries: Msg[] = [];
  readonly coverage = new Map<number, Msg>();
  readonly errors: Msg[] = [];
  readonly output: Msg[] = [];
  readonly httpEvents: Msg[] = [];
  finished: Msg = {};
  readonly sortedFiles: Msg[];
  readonly localsByStep = new Map<number, Msg[]>();
  readonly trace: Trace;
  /** the recording began at a pause (`recordFrom`): step 0 is that pause, not the program's start */
  readonly midRun: boolean;
  /** the step cap cut the trace: every verb says so first (`recording.ts`) */
  readonly recording: Msg | null;
  private readonly bases: number[];
  private readonly sources = new Map<number, string[]>();
  private readonly bindingTables = new Map<number, Map<number, StatementBinding>>();
  private stale: string[] | null = null;

  /** `doc` is the `{meta, events}` document already in memory (a live session's `recording` reply); `path` then only names it */
  constructor(path: string, doc?: unknown) {
    this.path = resolve(path);
    if (doc === undefined) {
      let text: string;
      try {
        text = readFileSync(this.path, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new AgentError(`no saved run at ${this.path}`, `create one with \`${NAME} run FILE --save ${basename(this.path)}\``);
        throw new AgentError(`${this.path} is not a saved run: ${(e as Error).message}`, `save it again with \`${NAME} run FILE --save ...\``);
      }
      try {
        doc = JSON.parse(text);
      } catch (e) {
        throw new AgentError(`${this.path} is not a saved run: ${(e as Error).message}`, `save it again with \`${NAME} run FILE --save ...\``);
      }
    }
    const d = doc as Msg;
    if (!d || typeof d !== 'object' || Array.isArray(d) || !('events' in d) || !('meta' in d)) throw new AgentError(`${this.path} is not a saved run (no meta/events)`, `save it with \`${NAME} run FILE --save ...\``);
    this.meta = d.meta;
    this.events = d.events;
    this.workspaceRoot = String(this.meta.workspaceRoot || dirname(String(this.meta.file || this.path)));
    let traceEv: Msg | null = null;
    for (const ev of this.events) {
      const kind = ev.type;
      if (kind === 'file.instrumented') this.files.set(Number(ev.fileId), ev);
      else if (kind === 'log') {
        this.logs.push(ev);
        const rid = Number(ev.rid ?? -1);
        if (!this.logsByRid.has(rid)) this.logsByRid.set(rid, []);
        this.logsByRid.get(rid)!.push(ev);
      } else if (kind === 'locals') this.localsEntries.push(...(ev.entries ?? []));
      else if (kind === 'coverage') this.coverage.set(Number(ev.fileId), ev);
      else if (kind === 'error') this.errors.push(ev);
      else if (kind === 'output') this.output.push(ev);
      else if (kind === 'http.exchange') this.httpEvents.push(ev);
      else if (kind === 'trace' && !ev.partial) traceEv = ev;
      else if (kind === 'run.finished') this.finished = ev;
    }
    this.sortedFiles = [...this.files.values()].sort((a, b) => Number(a.rangeBase) - Number(b.rangeBase));
    this.bases = this.sortedFiles.map((f) => Number(f.rangeBase));
    for (const entry of this.localsEntries) {
      const step = Number(entry.step ?? -1);
      if (!this.localsByStep.has(step)) this.localsByStep.set(step, []);
      this.localsByStep.get(step)!.push(entry);
    }
    const resolver = (rid: number) => this.locateForTrace(rid);
    this.trace = traceEv ? new Trace(decodeSteps(String(traceEv.steps ?? '')), traceEv.scopes ?? [], resolver, !!traceEv.truncated) : new Trace([], [], resolver);
    this.midRun = traceEv ? !!traceEv.midRun : false;
    this.recording = capInfo(traceEv, this.meta, (p) => this.displayPath(p), this.trace.count);
  }

  // -- files -----------------------------------------------------------------------------
  mainFileId(): number | null {
    const main = resolve(String(this.meta.file ?? ''));
    for (const f of this.sortedFiles) if (resolve(String(f.path)) === main) return Number(f.fileId);
    return this.sortedFiles.length ? Number(this.sortedFiles[0]!.fileId) : null;
  }

  /** what each statement of the file assigns and reads, by global range id (`../bindings.ts`); empty when the source is gone or does not parse */
  bindings(fileId: number): Map<number, StatementBinding> {
    let table = this.bindingTables.get(fileId);
    if (!table) {
      const f = this.files.get(fileId);
      const src = this.sourceLines(fileId).join('\n');
      table = new Map();
      if (f && src) {
        // a statement's entry wins over a function header at the same position
        // a run's own table (`run --save` writes it) wins; a source that does not parse as JS (a Python run) has none
        let entries: StatementBinding[] = Array.isArray(f.bindings) ? f.bindings : [];
        if (!Array.isArray(f.bindings)) {
          try {
            entries = [...functionBindings(src, String(f.path)), ...statementBindings(src, String(f.path))];
          } catch {
            entries = [];
          }
        }
        table = indexBindings(entries, f.ranges ?? [], f.statements ?? [], (f.functions ?? []).map((fn: Msg) => Number(fn.rid ?? -1)), Number(f.rangeBase ?? 0));
      }
      this.bindingTables.set(fileId, table);
    }
    return table;
  }

  /** `{fileId, path, range, localRid}` for a global range id */
  locate(rid: number): { fileId: number; path: string; range: number[]; localRid: number } | null {
    if (!this.sortedFiles.length) return null;
    // bisect_right(bases, rid) - 1
    let lo = 0;
    let hi = this.bases.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rid < this.bases[mid]!) hi = mid;
      else lo = mid + 1;
    }
    const idx = lo - 1;
    if (idx < 0) return null;
    const f = this.sortedFiles[idx]!;
    const local = rid - Number(f.rangeBase);
    const ranges = f.ranges ?? [];
    if (local < 0 || local >= ranges.length) return null;
    return { fileId: Number(f.fileId), path: String(f.path), range: ranges[local], localRid: local };
  }

  locateForTrace(rid: number): [number, number[]] | null {
    const loc = this.locate(rid);
    return loc ? [loc.fileId, loc.range] : null;
  }

  filePath(fileId: number): string | null {
    const f = this.files.get(fileId);
    return f ? String(f.path) : null;
  }

  displayPath(path: string | null | undefined): string {
    return displayPath(path, this.workspaceRoot);
  }

  /** the file of the run that `name` (absolute path, suffix or basename) means */
  resolveFile(name: string): Msg {
    if (!this.files.size) throw new AgentError('the run has no files', `the run did not start; check \`${NAME} run FILE --save\``);
    const wanted = name.includes(sep) || name.startsWith('.') ? resolve(name) : null;
    const exact = this.sortedFiles.filter((f) => wanted && resolve(String(f.path)) === wanted);
    if (exact.length) return exact[0]!;
    const suffix = this.sortedFiles.filter((f) => String(f.path).endsWith(sep + name) || basename(String(f.path)) === name || this.displayPath(String(f.path)) === name);
    if (suffix.length === 1) return suffix[0]!;
    if (suffix.length > 1) throw new AgentError(`${name} matches ${suffix.length} files of the run`, 'use a longer suffix: ' + suffix.slice(0, 6).map((f) => this.displayPath(String(f.path))).join(', '));
    const names = this.sortedFiles.slice(0, 8).map((f) => this.displayPath(String(f.path))).join(', ');
    const more = this.sortedFiles.length <= 8 ? '' : `, … (${this.sortedFiles.length} files)`;
    throw new AgentError(`no file ${name} in the run`, `files that ran: ${names}${more}`);
  }

  /** the file as it is on disk; the copy the run kept (`meta.files[].source`) when the file is gone */
  sourceLines(fileId: number): string[] {
    let lines = this.sources.get(fileId);
    if (!lines) {
      const path = this.filePath(fileId);
      try {
        lines = path ? readText(path).split('\n') : [];
      } catch {
        const kept = this.keptSource(path);
        lines = kept !== null ? kept.split('\n') : [];
      }
      this.sources.set(fileId, lines);
    }
    return lines;
  }

  /** the redacted copy of `path` the run saved when it ran, if it saved one */
  keptSource(path: string | null): string | null {
    for (const f of this.meta.files ?? []) if (f && typeof f === 'object' && String(f.path) === String(path) && typeof f.source === 'string') return f.source;
    return null;
  }

  scopeName(scopeId: number): string {
    const s = this.trace.scope(scopeId);
    return s ? String(s.name) : '<module>';
  }

  // -- staleness ----------------------------------------------------------------------------------
  staleFiles(): string[] {
    if (this.stale === null) {
      const out: string[] = [];
      for (const f of this.meta.files ?? []) {
        const path = String(f.path ?? '');
        if (!path || !f.sha256) continue;
        if (fileHash(path) !== f.sha256) out.push(path);
      }
      this.stale = out;
    }
    return this.stale;
  }

  // -- the RunSource methods -----------------------------------------------------------------------------
  state(): Msg {
    return {
      runId: this.meta.runId ?? null,
      running: false,
      finished: true,
      stale: this.staleFiles().length > 0,
      staleFiles: this.staleFiles(),
      nav: { active: true, step: 0, count: this.trace.count },
      file: this.meta.file ?? null,
      displayName: basename(String(this.meta.file ?? '')),
      exitCode: this.meta.exitCode ?? null,
      keep: this.meta.keep ?? null,
    };
  }

  checkStep(step: number): number {
    if (this.trace.count === 0) throw new AgentError('the run recorded no steps', `the file did not execute (syntax error?); see \`${NAME} story\``);
    if (!this.trace.valid(step)) throw new AgentError(step >= 0 ? `step ${step} is past the recorded ${this.trace.count} steps (0..${this.trace.count - 1})` : `step ${step} is negative`, 'use `steps` or `find` to pick one');
    return step;
  }

  stepOnLine(file: string, line: number): number {
    const f = this.resolveFile(file);
    const fid = Number(f.fileId);
    const on = this.trace.stepsOnLine(fid, line);
    if (on.length) return on[0]!;
    for (let j = 0; j < this.trace.count; j++) if (this.trace.containsLine(j, fid, line)) return j;
    const ranSet = new Set<number>();
    for (let j = 0; j < this.trace.count; j++) {
      const loc = this.trace.location(j);
      if (loc && loc[0] === fid) ranSet.add(loc[1][0]!);
    }
    const ran = [...ranSet].sort((a, b) => a - b);
    const near = ran.filter((l) => Math.abs(l - line) <= 5);
    const shown = this.displayPath(String(f.path));
    const hint = near.length ? `lines of ${shown} that ran near it: ${near.join(', ')}` : !ran.length ? `no line of ${shown} ran` : `use \`story --file ${shown}\` to see which lines ran`;
    throw new AgentError(`no step on ${shown}:${line}`, hint);
  }

  context(opts: { step?: number | null; file?: string | null; line?: number | null; scope?: boolean } = {}): Msg {
    let step = opts.step ?? null;
    if (step === null) {
      if (opts.file == null || opts.line == null) throw new AgentError('context needs a step or --line FILE:LINE', 'e.g. `context 12` or `context --line agent.ts:16`');
      step = this.stepOnLine(opts.file, opts.line);
    }
    return sliceMod.contextSlice(this, this.checkStep(step), !!opts.scope);
  }

  step(step: number | null, opts: { kind?: string | null; to?: number | null; scope?: boolean } = {}): Msg {
    const from = this.checkStep(step ?? NaN);
    let target: number;
    if (opts.to !== null && opts.to !== undefined) target = this.checkStep(opts.to);
    else if (opts.kind) {
      target = this.trace.move(from, opts.kind);
      if (target < 0) {
        const where = ['back', 'backOver', 'backOut'].includes(opts.kind) ? 'the start of the run' : 'the end of the run';
        const possible = Object.entries(this.trace.moves(from)).filter(([, v]) => v !== null).map(([k]) => k);
        throw new AgentError(`cannot step ${opts.kind} from step ${from}: ${where}`, possible.length ? 'possible moves: ' + possible.join(', ') : 'no move is possible from here');
      }
    } else target = from;
    const out = sliceMod.contextSlice(this, target, !!opts.scope);
    out.from = from;
    return out;
  }

  values(file: string, line: number): Msg {
    const f = this.resolveFile(file);
    return { file: String(f.path), line, values: sliceMod.valuesOnLine(this, Number(f.fileId), line) };
  }

  story(opts: { file?: string | null; scope?: string | null; line?: [string, number] | null; limit?: number } = {}): Msg {
    const fileId = opts.file ? Number(this.resolveFile(opts.file).fileId) : null;
    const lineKey: [number, number] | null = opts.line ? [Number(this.resolveFile(opts.line[0]).fileId), opts.line[1]] : null;
    return sliceMod.story(this, { fileId, scope: opts.scope ?? null, line: lineKey, lineCap: opts.limit ?? sliceMod.STORY_LINE_CAP });
  }

  steps(opts: { start?: number; count?: number; line?: [string, number] | null } = {}): Msg {
    return sliceMod.listSteps(this, { start: opts.start ?? 0, count: opts.count ?? sliceMod.STEPS_DEFAULT, line: opts.line ? [Number(this.resolveFile(opts.line[0]).fileId), opts.line[1]] : null });
  }

  find(text: string, limit = sliceMod.FIND_CAP): Msg {
    return sliceMod.find(this, text, limit);
  }

  var(name: string, opts: { file?: string | null; scope?: string | null; limit?: number } = {}): Msg {
    if (!name.trim()) throw new AgentError('var needs a variable name', 'e.g. `var run.json total`, or `var run.json this.balance`');
    const fileId = opts.file ? Number(this.resolveFile(opts.file).fileId) : null;
    return historyMod.variableHistory(this, name, { fileId, scope: opts.scope ?? null, limit: opts.limit ?? historyMod.VAR_CAP });
  }

  /** `{file, line, col, fileId}` of a range id: the shape of a context slice's `location` */
  httpLocation(rid: number): Msg | null {
    const loc = this.locate(rid);
    return loc ? { file: loc.path, line: Number(loc.range[0]), col: Number(loc.range[1]), fileId: loc.fileId } : null;
  }

  // -- the kept runner ------------------------------------------------------------------------------------
  private rerun(): string {
    return `run again with \`${NAME} run ${this.meta.file} --save ${basename(this.path)} --keep\``;
  }

  private async keepLink(): Promise<SocketLink> {
    const keep = this.meta.keep;
    if (!keep) throw new AgentError('this run was saved without --keep, so its values are gone', `${this.rerun()}, or use --live with an open VS Code session`);
    try {
      return await SocketLink.open(String(keep.socket), 10);
    } catch (e) {
      if (e instanceof LinkClosed) throw new AgentError(`the kept runner (pid ${keep.pid}) is gone`, this.rerun());
      throw e;
    }
  }

  async keepCall(req: Msg): Promise<Msg> {
    const link = await this.keepLink();
    let reply: Msg;
    try {
      reply = await link.call(req);
    } catch (e) {
      if (e instanceof LinkClosed) throw new AgentError(`the kept runner stopped answering: ${e.message}`, 'run again with --keep');
      throw e;
    } finally {
      link.close();
    }
    if (reply.type === 'error') throw new AgentError(String(reply.message || 'request failed'), KEEP_EVAL_HINT);
    return redactValue(reply);
  }

  async eval(expression: string): Promise<Msg> {
    let reply: Msg;
    try {
      reply = await this.keepCall({ type: 'evaluate', runId: this.meta.runId ?? null, expression });
    } catch (e) {
      // the JavaScript runner has no evaluator yet: say so rather than pass on its protocol error
      if (e instanceof AgentError && /unsupported request type "evaluate"/.test(e.message)) {
        throw new AgentError(`the kept ${NAME} runner cannot evaluate expressions yet`, 'read what the run recorded with `values`, `var` or `context`, or open a logged value with `expand VALUE_ID`');
      }
      throw e;
    }
    return { expression, text: reply.text ?? null, valueBag: reply.valueBag ?? null };
  }

  async expand(valueId: string, queryPath: string[]): Promise<Msg> {
    const reply = await this.keepCall({ type: 'expand', runId: this.meta.runId ?? null, valueId, queryPath });
    return { node: reply.node ?? null };
  }

  async release(): Promise<Msg> {
    const keep = this.meta.keep;
    if (!keep) throw new AgentError('this run has no kept runner', 'nothing to release');
    let link: SocketLink;
    try {
      link = await SocketLink.open(String(keep.socket), 5);
    } catch (e) {
      if (e instanceof LinkClosed) return { released: false, pid: keep.pid ?? null, note: 'already gone' };
      throw e;
    }
    try {
      link.send({ type: 'shutdown' });
    } finally {
      link.close();
    }
    return { released: true, pid: keep.pid ?? null };
  }

  close(): void {}
}

/** what a refused `evaluate` hint says can be evaluated (JavaScript's pure subset, as Pyokka's names Python's) */
export const KEEP_EVAL_HINT = 'names, properties, subscripts, operators and pure calls can be evaluated (Math, JSON, non-mutating methods of String, Array, Object, Map and Set); a user function is refused and no statement is re-run';

export { PROVENANCE_DEPTH };
