/**
 * The live debugger, worker half: a `node:inspector` session connected to the program's thread.
 *
 * It owns the run's control descriptor for the whole life of a debug run, as control.py's reader
 * thread does, so a breakpoint change, a `pause` or an `exit` lands while the program runs and
 * every request is served while V8 holds the program at a stop. Requests are answered on the event
 * descriptor (`*.result` / `*.error` with the request's `id`) through the shared `LineWriter`;
 * `debug.paused` and `debug.resumed` are emitted by the main half (`debugger.ts`), which this
 * worker calls on the suspended thread with `Runtime.evaluate`.
 *
 * Three kinds of V8 pause arrive:
 *
 * - the trap (`Debugger.trap`'s `debugger` statement): the main half found a reason at a statement.
 *   A breakpoint condition and the break-when watches are evaluated here, in the frame; when none
 *   holds the program goes on at once.
 * - an exception (`Debugger.setPauseOnExceptions`): `raised` pauses at the first sighting of an
 *   exception in a user file (the instrumenter's rethrows show the same object again and are
 *   skipped), `uncaught` where V8 predicts nobody catches it. V8's prediction sees the
 *   instrumenter's catch-and-rethrow wrappers, so it reports an exception as uncaught at the
 *   outermost frame it leaves, which is where that pause lands (Python's lands on the innermost
 *   frame of the traceback; a JavaScript frame that has unwound has no locals to read).
 * - anything else (a `debugger` statement in the program): ignored, the run goes on.
 *
 * Frames: the runtime's own frames (`runtimeRoots`) and Node's internals are dropped; what is left
 * is the chain `frameId` indexes, innermost 0. The first instrumented frame is the paused one.
 */
import { Session } from 'node:inspector/promises';
import { parentPort, workerData, type MessagePort } from 'node:worker_threads';
import fs from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSync } from 'oxc-parser';
import { LineWriter, toWire } from './wire.ts';
import { evaluatePure, isRuntimeName, probeScope, RefusedError, EvalException, type Post, type Remote, type Target } from '../pure.ts';
import { completionsFor, type Completion } from './complete.ts';
import { showsValue } from './repl.ts';
import { predict, regionsOf, type FrameView, type Regions, type Verdict } from './predict.ts';
import { expressionName } from './describe.ts';
import { functionSourceAt } from './functionSource.ts';
import { logMessageParts, syntaxError } from './breakpoints.ts';
import { MASK, secrets } from '../secrets.ts';

export interface AgentData {
  ctlFd?: number;
  eventFd: number;
  lock: SharedArrayBuffer;
  runtimeRoots: string[];
  /** expression naming the finished run's scope probe */
  probe?: string;
  /** the program's worker threads, relayed by the main half (threads.ts) */
  threads?: MessagePort;
  /** a recorded worker's pause: [sequence asked, its merged step, sequence answered, merged steps so far] (threads/hub.ts) */
  pause?: SharedArrayBuffer;
}

const data = workerData as AgentData;
const out = new LineWriter(data.eventFd, data.lock);
const session = new Session();
session.connectToMainThread();
const post: Post = (method, params) => session.post(method as any, params as any);
const GROUP = 'tracelight-req';
/** the session of the stopped thread: the main thread's, or a worker's while one is held */
const at: Post = (method, params) => (stopped?.thread?.post ?? post)(method, params);
// keeps this thread alive: an inspector session alone does not
const keepAlive = setInterval(() => {}, 1 << 30);

interface FileView {
  fileId: number;
  path: string;
  library: boolean;
  lines: Map<number, number>;
  ridLine: Map<number, number>;
}

interface Frame {
  callFrameId: string;
  name: string;
  path: string;
  line: number;
  file: FileView | null;
  scopeChain: any[];
  isModule: boolean;
  /** an uncaught pause over a frame that has returned: its bindings as they were at the raise */
  snapshot?: Binding[];
}

interface Binding {
  name: string;
  value: Remote;
  /** listed by `locals` (module noise and module-level functions are not) */
  shown: boolean;
}

interface Stop {
  frames: Frame[];
  step: number;
  /** a pause in one of the program's worker threads, not the main thread */
  thread?: Thread;
  /** a second stop at the same place once this one is continued (`raised`, then `uncaught`) */
  then?: () => Promise<void>;
}

interface Watch {
  id: string;
  exp: string;
  mode: 'change' | 'true';
  last: unknown;
  missing: boolean;
  error?: string;
  evaluationError?: string;
}

const files: FileView[] = [];
const byPath = new Map<string, FileView>();
let stopped: Stop | null = null;
let finished = false;
let watches: Watch[] = [];
let queue: Promise<void> = Promise.resolve();
let globalId: string | null = null;

function send(message: Record<string, unknown>): void {
  out.write(toWire(message));
}

/** Run a main-half call on the program's thread (suspended or not); its JSON value. */
async function main(expression: string): Promise<any> {
  const r = await post('Runtime.evaluate', { expression: `globalThis.__tk_dbg.${expression}`, returnByValue: true, silent: true });
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).split('\n')[0]);
  return r.result.value;
}

const J = (v: unknown): string => JSON.stringify(v ?? null);

async function refreshFiles(): Promise<void> {
  const added: { fileId: number; path: string; library: boolean; lines: [number, number][] }[] = await main(`filesSince(${files.length})`);
  for (const f of added) {
    const view: FileView = { fileId: f.fileId, path: f.path, library: f.library, lines: new Map(f.lines), ridLine: new Map(f.lines.map(([l, r]) => [r, l])) };
    files.push(view);
    byPath.set(f.path, view);
  }
}

function urlPath(url: string): string {
  if (url.startsWith('file:')) {
    try {
      return fileURLToPath(url);
    } catch {
      return url;
    }
  }
  return url;
}

function isRuntimeFrame(path: string): boolean {
  if (!path || path.startsWith('node:') || path.startsWith('internal/')) return true;
  return data.runtimeRoots.some((root) => path.startsWith(root));
}

async function framesOf(callFrames: any[], urls = scriptUrls): Promise<Frame[]> {
  await refreshFiles();
  const out: Frame[] = [];
  for (const cf of callFrames) {
    const path = urlPath(frameUrl(cf, urls));
    if (isRuntimeFrame(path)) continue;
    const scopes = cf.scopeChain ?? [];
    out.push({
      callFrameId: cf.callFrameId,
      name: cf.functionName || '<module>',
      path,
      line: (cf.location?.lineNumber ?? 0) + 1,
      file: byPath.get(path) ?? null,
      scopeChain: scopes,
      isModule: !cf.functionName && !scopes.some((s: any) => s.type === 'local' && s.name),
    });
    if (out.length >= 64) break;
  }
  return out;
}

async function scopeIdOf(frame: Frame): Promise<number | null> {
  try {
    const r = await post('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression: '_tk_scope_', throwOnSideEffect: true, returnByValue: true, silent: true });
    return !r.exceptionDetails && typeof r.result.value === 'number' ? r.result.value : null;
  } catch {
    return null;
  }
}

async function frameStack(frames: Frame[], top: { line: number | null; rid: number; scope: number }): Promise<Record<string, unknown>[]> {
  const stack: Record<string, unknown>[] = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    const entry: Record<string, unknown> = { frameId: i, name: f.name, fileId: f.file && !f.file.library ? f.file.fileId : 0, line: i === 0 && top.line ? top.line : f.line };
    if (f.file && !f.file.library) {
      const rid = i === 0 ? top.rid : f.file.lines.get(f.line);
      if (rid !== undefined) entry.rid = rid;
      const sid = i === 0 ? top.scope : await scopeIdOf(f);
      if (sid !== null) entry.scopeId = sid;
    } else {
      entry.path = f.path;
    }
    stack.push(entry);
  }
  return stack;
}

// -- values -----------------------------------------------------------------------------------------

function argOf(r: Remote): Record<string, unknown> {
  if (r.objectId) return { objectId: r.objectId };
  if (r.unserializableValue) return { unserializableValue: r.unserializableValue };
  return { value: r.value };
}

async function globalObject(): Promise<string> {
  if (!globalId) globalId = (await post('Runtime.evaluate', { expression: 'globalThis', objectGroup: 'tracelight-global' })).result.objectId;
  return globalId!;
}

/** `{text, valueBag}` of a remote value, by the main half's serializer, on the program's thread. */
async function describe(remote: Remote, name: string): Promise<{ text: string; valueBag: unknown }> {
  const r = await post('Runtime.callFunctionOn', {
    objectId: await globalObject(), functionDeclaration: 'function (v, n) { return globalThis.__tk_dbg.describe(v, n); }',
    arguments: [argOf(remote), { value: name }], returnByValue: true, silent: true,
  });
  if (r.exceptionDetails) return { text: String(r.exceptionDetails.exception?.description ?? 'error').split('\n')[0]!, valueBag: null };
  const described = r.result.value;
  if (remote.type === 'function' && remote.objectId && described.valueBag?.data) {
    const node = described.valueBag.data;
    if (remote.description) {
      const source = secrets.scrub(remote.description);
      node.functionSource = source.slice(0, 2000);
      if (source.length > 2000) node.functionSourceCapped = true;
    }
    try {
      const properties = await post('Runtime.getProperties', { objectId: remote.objectId, ownProperties: true });
      const loc = properties.internalProperties?.find((p: any) => p.name === '[[FunctionLocation]]')?.value?.value;
      const path = loc && urlPath(scriptUrls.get(loc.scriptId) ?? '');
      if (path) {
        node.functionLocation = { path, line: loc.lineNumber + 1, column: (loc.columnNumber ?? 0) + 1 };
        // Runtime identity supplies the location. Show the corresponding original
        // callback rather than the tracing wrappers in V8's description.
        const original = functionSourceAt(path, fs.readFileSync(path, 'utf8'), loc.lineNumber + 1);
        if (original) {
          const source = secrets.scrub(original);
          node.functionSource = source.slice(0, 2000);
          node.functionSourceCapped = source.length > 2000;
        }
      }
    } catch { /* Native or bound functions may have no source location. */ }
  }
  return described;
}

async function textOf(remote: Remote, name: string): Promise<string> {
  const r = await post('Runtime.callFunctionOn', {
    objectId: await globalObject(), functionDeclaration: 'function (v, n) { return globalThis.__tk_dbg.text(v, n); }',
    arguments: [argOf(remote), { value: name }], returnByValue: true, silent: true,
  });
  return r.exceptionDetails ? '<error>' : String(r.result.value);
}

async function truthy(remote: Remote): Promise<boolean> {
  if (!remote.objectId) return Boolean(remote.unserializableValue ? remote.unserializableValue !== '-0' && remote.unserializableValue !== '0n' && remote.unserializableValue !== 'NaN' : remote.value);
  return true; // every object is truthy
}

// -- the pauses ---------------------------------------------------------------------------------------

// a call frame's own `url` is empty in Node; the script's comes with `scriptParsed`
const scriptUrls = new Map<string, string>();
session.on('Debugger.scriptParsed', ({ params }) => {
  scriptUrls.set(params.scriptId, params.url);
});

function frameUrl(cf: any, urls = scriptUrls): string {
  return cf?.url || urls.get(cf?.location?.scriptId) || '';
}

session.on('Debugger.paused', ({ params }) => {
  // while a worker thread is held (or about to be) the main thread must run: the worker's relay is
  // its event loop. A trap is let go and comes back as a pause request once the worker resumes.
  if (stopped?.thread || threadBusy > 0) {
    const top = params.callFrames?.[0];
    if (top?.functionName.endsWith('trap') && isRuntimeFrame(urlPath(frameUrl(top)))) mainDeferred = true;
    void post('Debugger.resume').catch(() => {});
    return;
  }
  queue = queue.then(() => onPaused(params)).catch((e) => internalError('pause', e));
});

function internalError(where: string, e: unknown): void {
  send({ type: 'runner.error', message: `debugger hook failed in ${where}: ${(e as Error)?.stack ?? e}` });
  if (!stopped) void post('Debugger.resume').catch(() => {});
}

async function onPaused(params: any): Promise<void> {
  const reason: string = params.reason;
  if (reason === 'exception' || reason === 'promiseRejection') return onException(params);
  const top = params.callFrames?.[0];
  const isTrap = top && top.functionName.endsWith('trap') && isRuntimeFrame(urlPath(frameUrl(top)));
  if (!isTrap) {
    await post('Debugger.resume');
    return;
  }
  const cand = await main('candidate');
  if (!cand) {
    await post('Debugger.resume');
    return;
  }
  if (cand.reason === 'postmortem') return onPostmortem();
  const frames = await framesOf(params.callFrames);
  const frame = frames[0];
  if (cand.stepWatches && frame) await evaluateStepWatches(cand.stepWatches, cand.n, frame);
  let why: string | null = cand.reason;
  const extra: Record<string, unknown> = { ...cand.extra };
  for (const logpoint of frame ? cand.logpoints ?? [] : []) {
    try {
      const checked = logpoint.expression ? await conditionResult(post, frame!, logpoint.expression) : { matches: true };
      if (checked.error) throw new Error(checked.error);
      if (checked.matches) await main(`logpointMessage(${cand.n}, ${J(await logpointText(post, frame!, logpoint.bp))}, ${J(logpoint.bp)})`);
    } catch (error) {
      why = why ?? 'breakpoint';
      extra.breakpoint ??= logpoint.bp;
      extra.conditionError = `logpoint: ${expressionError(error)}`;
    }
  }
  if (why === null && cand.condition && frame) {
    const checked = await conditionResult(post, frame, cand.condition.expression);
    if (checked.matches || checked.error) {
      why = 'breakpoint';
      extra.breakpoint = cand.condition.bp;
      if (checked.error) extra.conditionError = checked.error;
    }
  }
  if (why === null && cand.watches && frame) {
    for (const w of watches) {
      const result = await watchFires(w, frame);
      if (result !== null) {
        why = 'watch';
        extra.watch = { id: w.id, exp: w.exp, ...result };
        break;
      }
    }
  }
  await post('Runtime.releaseObjectGroup', { objectGroup: GROUP });
  if (why === null || !frame) {
    await post('Debugger.resume');
    return;
  }
  const file = frame.file;
  const line = file?.ridLine.get(cand.rid) ?? frame.line;
  const stack = await frameStack(frames, { line, rid: cand.rid, scope: cand.scope });
  await main(`stop(${cand.n}, ${cand.rid}, ${cand.scope}, ${J(why)}, ${J(extra)}, ${J(stack)}, ${J(line)}, ${file?.fileId ?? 0})`);
  stopped = { frames, step: cand.n };
}

async function evaluateStepWatches(watches: { id: string; exp: string }[], step: number, frame: Frame): Promise<void> {
  for (const w of watches) {
    try {
      const remote = await evaluatePure(post, { callFrameId: frame.callFrameId }, w.exp, GROUP);
      await post('Runtime.callFunctionOn', {
        objectId: await globalObject(), functionDeclaration: 'function (v, id, n, e) { globalThis.__tk_dbg.watchValue(v, id, n, e); }',
        arguments: [argOf(remote), { value: w.id }, { value: step }, { value: w.exp }], silent: true,
      });
    } catch (e) {
      const err = e as Error;
      const text = err instanceof RefusedError || err instanceof EvalException ? err.message : `${err.name}: ${err.message}`;
      await main(`watchError(${J(w.id)}, ${step}, ${J(text)})`);
    }
  }
}

function expressionError(error: unknown): string {
  const err = error as Error;
  return (err instanceof RefusedError || err instanceof EvalException ? err.message : `${err.name}: ${err.message}`).split('\n')[0]!;
}

async function conditionResult(p: Post, frame: Frame, expression: string): Promise<{ matches: boolean; error?: string }> {
  try {
    const remote = await evaluatePure(p, { callFrameId: frame.callFrameId }, expression, GROUP);
    return { matches: await truthy(remote) };
  } catch (error) {
    return { matches: false, error: expressionError(error) };
  }
}

async function logpointText(p: Post, frame: Frame, bp: Record<string, unknown>, thread?: Thread): Promise<string> {
  const { parts, error } = logMessageParts(String(bp.logMessage ?? ''));
  if (error) throw new Error(error);
  let message = '';
  for (const part of parts) {
    if ('text' in part) message += part.text;
    else {
      const remote = await evaluatePure(p, { callFrameId: frame.callFrameId }, part.expression, GROUP);
      message += thread ? (await describeAt(remote, part.expression, thread)).text : await textOf(remote, part.expression);
    }
  }
  return secrets.scrub(message);
}

async function watchFires(w: Watch, frame: Frame): Promise<{ text: string; error?: string } | null> {
  let remote: Remote;
  try {
    remote = await evaluatePure(post, { callFrameId: frame.callFrameId }, w.exp, GROUP);
  } catch (error) {
    // A watch may be installed before a binding exists or entered from another frame. That is
    // temporary absence, not a broken expression; its first available value still counts.
    if (error instanceof EvalException && error.errorType === 'ReferenceError') {
      if (w.last === undefined) w.missing = true;
      return null;
    }
    const message = expressionError(error);
    if (message === w.evaluationError) return null;
    w.evaluationError = message;
    return { text: '<evaluation failed>', error: message };
  }
  w.evaluationError = undefined;
  if (w.mode === 'true') {
    const now = await truthy(remote);
    const fired = now && !w.last;
    w.last = now;
    return fired ? { text: await textOf(remote, w.exp) } : null;
  }
  const text = await textOf(remote, w.exp);
  if (w.last === undefined) {
    w.last = text;
    return w.missing ? { text } : null;
  }
  if (text === w.last) return null;
  w.last = text;
  return { text };
}

let exceptionMode = 'uncaught';

async function applyExceptionMode(mode: string): Promise<void> {
  exceptionMode = mode;
  // `uncaught` needs every first sighting too: V8's own prediction cannot tell (predict.ts)
  await post('Debugger.setPauseOnExceptions', { state: mode === 'off' ? 'none' : 'all' });
}

const regionCache = new Map<string, Regions | null>();

async function regionsFor(scriptId: string, path: string, p: Post = post, key = ''): Promise<Regions | null> {
  const k = `${key}:${scriptId}`;
  if (regionCache.has(k)) return regionCache.get(k)!;
  let regions: Regions | null = null;
  try {
    const { scriptSource } = await p('Debugger.getScriptSource', { scriptId });
    regions = regionsOf(scriptSource, path);
  } catch {
    regions = null;
  }
  regionCache.set(k, regions);
  return regions;
}

/** Will anyone catch it (predict.ts); `t`: a worker thread's frames, whose program files run uninstrumented */
async function verdict(callFrames: any[], t?: Thread): Promise<Verdict> {
  const views: FrameView[] = [];
  for (const cf of callFrames) {
    const path = urlPath(frameUrl(cf, t?.urls));
    const file = byPath.get(path);
    const runtime = isRuntimeFrame(path);
    const program = t ? !runtime && !(file?.library ?? path.includes(`${pathSep}node_modules${pathSep}`)) : !!file && !file.library;
    views.push({
      url: path, line0: cf.location.lineNumber, col: cf.location.columnNumber ?? 0,
      regions: program ? await regionsFor(cf.location.scriptId, path, t?.post, t?.sessionId) : null,
      library: !program && !runtime,
    });
  }
  return predict(views);
}

async function onException(params: any): Promise<void> {
  const exc: Remote | undefined = params.data;
  const all = await framesOf(params.callFrames);
  const k = all.findIndex((f) => f.file && !f.file.library);
  const own = isRuntimeFrame(urlPath(frameUrl(params.callFrames?.[0])));
  if (k < 0 || exceptionMode === 'off' || own || (await main('finished'))) {
    await post('Debugger.resume');
    return;
  }
  let first = true;
  if (exc?.objectId) {
    const r = await post('Runtime.callFunctionOn', { objectId: exc.objectId, functionDeclaration: 'function () { return globalThis.__tk_dbg.firstSighting(this); }', returnByValue: true, silent: true });
    first = r.exceptionDetails ? true : r.result.value !== false;
  }
  if (!first) {
    await post('Debugger.resume');
    return;
  }
  const v = await verdict(params.callFrames);
  const uncaught = v === 'uncaught';
  const frames = all.slice(k);
  const frame = frames[0]!;
  const file = frame.file!;
  const rid = file.lines.get(frame.line) ?? -1;
  const scope = (await scopeIdOf(frame)) ?? 0;
  const n = await main('currentStep()');
  const description = String(exc?.description ?? exc?.value ?? 'exception');
  const type = exc?.className ?? (exc?.type === 'object' ? 'Object' : exc?.type ?? 'Error');
  const firstLine = description.split('\n')[0]!;
  const message = exc?.objectId && firstLine.startsWith(type) ? firstLine.slice(type.length).replace(/^:\s*/, '') : firstLine;
  if (!uncaught && exceptionMode !== 'raised' && v !== 'unknown') {
    await post('Debugger.resume');
    return;
  }
  const stack = await frameStack(frames, { line: frame.line, rid, scope });
  // nobody can tell yet whether this one ends the run: keep its frames' bindings for the uncaught pause
  if (v === 'unknown' && exc?.objectId) await remember(exc, frames, { n, rid, scope, line: frame.line, fileId: file.fileId, type, message, stack });
  if (!uncaught && exceptionMode !== 'raised') {
    await post('Debugger.resume');
    return;
  }
  if (uncaught && exc?.objectId) await markUncaught(exc);
  // `raised` reports the sighting first (uncaught: false, as nobody can know yet); one nobody catches stops again
  const raisedFirst = exceptionMode === 'raised';
  const stopAs = async (isUncaught: boolean) => {
    const extra = { exception: { type, message, uncaught: isUncaught } };
    await main(`stop(${n}, ${rid}, ${scope}, "exception", ${J(extra)}, ${J(stack)}, ${frame.line}, ${file.fileId})`);
  };
  await stopAs(raisedFirst ? false : uncaught);
  stopped = { frames, step: n, then: raisedFirst && uncaught ? () => stopAs(true) : undefined };
}

async function markUncaught(exc: Remote): Promise<void> {
  await post('Runtime.callFunctionOn', { objectId: exc.objectId, functionDeclaration: 'function () { globalThis.__tk_dbg.markUncaught(this); }', silent: true });
}

/** The bindings of one frame, innermost scope first, as `locals` lists them (`shown`) and as evaluate needs them. */
async function bindingsOf(frame: Frame, group: string): Promise<Binding[]> {
  if (frame.snapshot) return frame.snapshot;
  const out: Binding[] = [];
  const seen = new Set<string>();
  const hasLocal = frame.scopeChain.some((sc) => sc.type === 'local');
  let pastLocal = false;
  for (const sc of frame.scopeChain) {
    const t = sc.type;
    if (t === 'global' || t === 'with' || t === 'eval' || t === 'wasm-expression-stack') continue;
    const listed = !(t === 'module' && hasLocal && !frame.isModule) && !(t === 'script' && !frame.isModule) && !(pastLocal && t !== 'closure');
    if (t === 'local') pastLocal = true;
    if (!sc.object?.objectId) continue;
    const props = await at('Runtime.getProperties', { objectId: sc.object.objectId, ownProperties: true, objectGroup: group });
    for (const p of props.result ?? []) {
      if (!p.value || seen.has(p.name) || isRuntimeName(p.name)) continue;
      seen.add(p.name);
      // the CommonJS wrapper's parameters are the runtime's, never the program's: hidden in the
      // module frame and in the closure every function of that module sees
      const noise = frame.isModule ? MODULE_NOISE.has(p.name) || p.value.type === 'function' : t !== 'local' && MODULE_NOISE.has(p.name);
      out.push({ name: p.name, value: p.value, shown: listed && !noise });
    }
  }
  return out;
}

const PM_GROUP = 'tracelight-postmortem';
const PM_FRAMES = 10;

/** Hand the main half the bindings of the raising frames (values by reference), keyed by the exception. */
async function remember(exc: Remote, frames: Frame[], top: Record<string, unknown>): Promise<void> {
  const values: Record<string, unknown>[] = [];
  const meta: Record<string, any> = { ...top, frames: [] };
  for (const f of frames.slice(0, PM_FRAMES)) {
    if (!f.file || f.file.library) break;
    const bound = await bindingsOf(f, GROUP);
    meta.frames.push({ name: f.name, path: f.path, line: f.line, fileId: f.file.fileId, isModule: f.isModule, names: bound.map((b) => [b.name, b.shown]) });
    for (const b of bound) values.push(argOf(b.value));
  }
  await post('Runtime.callFunctionOn', {
    objectId: exc.objectId, functionDeclaration: 'function (meta, ...values) { globalThis.__tk_dbg.remember(this, meta, values); }',
    arguments: [{ value: meta }, ...values], silent: true,
  });
}

/** The uncaught pause of an exception whose frames have returned: frames rebuilt from its snapshot. */
async function onPostmortem(): Promise<void> {
  const holder = await post('Runtime.evaluate', { expression: 'globalThis.__tk_dbg.postmortem', objectGroup: PM_GROUP, silent: true });
  const id = holder.result?.objectId;
  if (!id) {
    await post('Debugger.resume');
    return;
  }
  const meta = (await post('Runtime.callFunctionOn', { objectId: id, functionDeclaration: 'function () { return this.meta; }', returnByValue: true, silent: true })).result.value;
  const arr = await post('Runtime.callFunctionOn', { objectId: id, functionDeclaration: 'function () { return this.values; }', objectGroup: PM_GROUP, silent: true });
  const props = await post('Runtime.getProperties', { objectId: arr.result.objectId, ownProperties: true, objectGroup: PM_GROUP });
  const byIndex = new Map<string, Remote>();
  for (const p of props.result ?? []) if (p.value && /^\d+$/.test(p.name)) byIndex.set(p.name, p.value);
  await refreshFiles();
  let i = 0;
  const frames: Frame[] = meta.frames.map((f: any) => ({
    callFrameId: '', name: f.name, path: f.path, line: f.line, file: files.find((v) => v.fileId === f.fileId) ?? null, scopeChain: [], isModule: f.isModule,
    snapshot: f.names.map(([name, shown]: [string, boolean]) => ({ name, shown, value: byIndex.get(String(i++)) ?? { type: 'undefined' } })),
  }));
  const extra = { exception: { type: meta.type, message: meta.message, uncaught: true } };
  await main(`stop(${meta.n}, ${meta.rid}, ${meta.scope}, "exception", ${J(extra)}, ${J(meta.stack)}, ${J(meta.line)}, ${meta.fileId})`);
  stopped = { frames, step: meta.n };
}

// -- worker threads -----------------------------------------------------------------------------------

/**
 * One of the program's worker threads, through the main half's relay (threads.ts). Its files run
 * uninstrumented, so its pauses are V8's own: breakpoints by URL and line, V8's step and its
 * uncaught prediction. Its frames carry the source's lines; a file the main thread also
 * instrumented keeps its `fileId`, any other is `fileId: 0` with its `path`.
 */
interface Thread {
  sessionId: string;
  ident: number;
  name: string;
  urls: Map<string, string>;
  post: Post;
  globalObject(): Promise<string>;
  /** the step kind V8 was asked for, so the next pause is reported as that step */
  stepping: string | null;
  /** V8 breakpoint id -> the breakpoint as `debug` echoes it */
  breakpoints: Map<string, Record<string, unknown>>;
  /**
   * A recorded worker runs instrumented code: a pause V8 makes before a statement's step hook
   * (a breakpoint's line, a step) goes on to just after it, where the statement's step is in the
   * trace. Meanwhile this holds what the pause will be reported as.
   */
  settle: { why: string; extra: Record<string, unknown>; conditionChecked?: boolean } | null;
  /** scriptId -> where its step hooks are (`hookSpans`) */
  spans: Map<string, Map<number, number[]> | null>;
  /** it records (threads/worker.ts): it stops itself for a step */
  recorded: boolean;
}

const threads = new Map<string, Thread>();
/** worker pauses that arrived while another pause was served; each runs once the stop before it ends */
const held: (() => Promise<void>)[] = [];
/** thread work in flight: the main thread must not be held meanwhile (see `Debugger.paused`) */
let threadBusy = 0;
/** a main-thread trap let go while a worker was held: pause the main thread once the worker resumes */
let mainDeferred = false;
const relay = data.threads;

function threadExceptionState(): string {
  return exceptionMode === 'off' ? 'none' : 'all';
}

function newThread(sessionId: string, ident: number, name: string): Thread {
  let seq = 0;
  let globalId: string | null = null;
  const waits = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const t: Thread = {
    sessionId, ident, name, urls: new Map(), stepping: null, breakpoints: new Map(), settle: null, spans: new Map(), recorded: false,
    post: (method, params) => new Promise((resolve, reject) => {
      const id = ++seq;
      waits.set(id, { resolve, reject });
      relay!.postMessage({ op: 'send', sessionId, message: JSON.stringify({ id, method, params: params ?? {} }) });
    }),
    async globalObject() {
      if (!globalId) globalId = (await t.post('Runtime.evaluate', { expression: 'globalThis', objectGroup: 'tracelight-global' })).result.objectId;
      return globalId!;
    },
  };
  (t as any).waits = waits;
  return t;
}

async function syncBreakpoints(t: Thread): Promise<void> {
  const ids = [...t.breakpoints.keys()];
  t.breakpoints.clear();
  for (const id of ids) await t.post('Debugger.removeBreakpoint', { breakpointId: id }).catch(() => {});
  const specs: { path: string; line: number; condition: string | null; echo: Record<string, unknown> }[] = await main('lineBreakpoints()');
  const groups = new Map<string, typeof specs>();
  for (const bp of specs) {
    const key = JSON.stringify([bp.path, bp.line]);
    const list = groups.get(key) ?? [];
    list.push(bp);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    const bp = list[0]!;
    // Check conditions ourselves with the same pure evaluator as main-thread stops. Native CDP
    // conditions can write state and silently skip a breakpoint when evaluation throws.
    const r = await t.post('Debugger.setBreakpointByUrl', { url: pathToFileURL(bp.path).href, lineNumber: bp.line - 1 }).catch(() => null);
    if (r?.breakpointId) t.breakpoints.set(r.breakpointId, list.length === 1 ? bp.echo : { ...bp.echo, coincident: list.map(item => item.echo) });
  }
  // a recorded worker traps its function breakpoints itself (threads/worker.ts); one that has not
  // loaded its preload yet takes them from the hub when it starts
  const fns = await main('functionBreakpoints()');
  await t.post('Runtime.evaluate', { expression: `globalThis.__tracelight_bp__?.(${J(fns)})`, silent: true }).catch(() => {});
}

/** a recorded worker's step hooks in one of its scripts, per line: flat [start column, end column, ...]; null: a script with none */
async function hookSpans(t: Thread, scriptId: string): Promise<Map<number, number[]> | null> {
  let source: string;
  try {
    source = (await t.post('Debugger.getScriptSource', { scriptId })).scriptSource;
  } catch {
    return null;
  }
  const starts = [0];
  for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1)) starts.push(i + 1);
  const out = new Map<number, number[]>();
  for (const m of source.matchAll(/(?:const _tk_scope_=)?__tk\.[sf]\(\d+(?:,_tk_scope_)?\);/g)) {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= m.index) lo = mid;
      else hi = mid - 1;
    }
    const col = m.index - starts[lo]!;
    let spans = out.get(lo);
    if (!spans) out.set(lo, (spans = []));
    spans.push(col, col + m[0].length);
  }
  return out.size ? out : null;
}

/** Is a recorded worker's pause where a statement starts, its step just recorded: not inside a step hook. */
async function atStatement(t: Thread, cf: any): Promise<boolean> {
  const id = cf?.location?.scriptId;
  if (!id) return true;
  let spans = t.spans.get(id);
  if (spans === undefined) {
    spans = await hookSpans(t, id);
    t.spans.set(id, spans);
  }
  if (spans === null) return true; // a script that runs as is
  const col = cf.location.columnNumber ?? 0;
  const line = spans.get(cf.location.lineNumber) ?? [];
  for (let i = 0; i + 1 < line.length; i += 2) if (col >= line[i]! && col < line[i + 1]!) return false;
  return true;
}

const pauseCell = data.pause ? new Int32Array(data.pause) : null;
let pauseSeq = 0;

/**
 * A worker's pause, as a step of the merged trace: the worker sends what it ran to the main
 * thread's hub, which merges it (threads/hub.ts `workerPaused`) and answers in `pauseCell`. A main
 * thread too busy to answer (blocked in `Atomics.wait`) leaves the trace's last step.
 */
async function threadStep(t: Thread): Promise<number> {
  if (!pauseCell) return main('currentStep()');
  const seq = ++pauseSeq;
  const r = await t.post('Runtime.evaluate', { expression: `typeof globalThis.__tracelight_pause__ === 'function' ? globalThis.__tracelight_pause__(${seq}) : -1`, returnByValue: true, silent: true }).catch(() => null);
  const local = r?.result?.value;
  if (typeof local !== 'number' || local < 0) return Math.max(0, Atomics.load(pauseCell, 3) - 1);
  t.recorded = true;
  const until = Date.now() + PAUSE_WAIT_MS;
  for (let seen = Atomics.load(pauseCell, 2); seen !== seq && Date.now() < until; seen = Atomics.load(pauseCell, 2)) {
    const w = (Atomics as any).waitAsync(pauseCell, 2, seen, until - Date.now());
    if (w.async) await w.value;
  }
  return Atomics.load(pauseCell, 2) === seq ? Atomics.load(pauseCell, 1) : Math.max(0, Atomics.load(pauseCell, 3) - 1);
}
const PAUSE_WAIT_MS = 2000;

async function attachThread(params: any): Promise<void> {
  const info = params.workerInfo ?? {};
  const path = urlPath(String(info.url ?? ''));
  const run = () => relay!.postMessage({ op: 'send', sessionId: params.sessionId, message: JSON.stringify({ id: 0, method: 'Runtime.runIfWaitingForDebugger' }) });
  if (isRuntimeFrame(path)) {
    if (params.waitingForDebugger) run();
    return;
  }
  const ident = Number(info.workerId) || threads.size + 1;
  // the title is `[worker N] name`; N is the thread's `threadId`
  const t = newThread(params.sessionId, ident, String(info.title ?? '').replace(/^\[worker \d+\]\s*/, '') || `Worker ${ident}`);
  threads.set(t.sessionId, t);
  try {
    await t.post('Debugger.enable');
    // the runtime a recorded worker loads: steps go through its hooks, never into them
    const runtime = data.runtimeRoots.map((r) => `^${pathToFileURL(r).href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    await t.post('Debugger.setBlackboxPatterns', { patterns: ['^node:', '^internal/', ...runtime] }).catch(() => {});
    await t.post('Debugger.setPauseOnExceptions', { state: threadExceptionState() });
    await syncBreakpoints(t);
  } finally {
    // a worker held at its start and never let go would hang the program
    if (params.waitingForDebugger) run();
  }
}

function detachThread(sessionId: string): void {
  const t = threads.get(sessionId);
  if (!t) return;
  threads.delete(sessionId);
  for (const w of (t as any).waits.values()) w.reject(new Error('the worker thread has exited'));
  if (stopped?.thread === t) {
    queue = queue.then(async () => {
      if (stopped?.thread !== t) return;
      send({ type: 'debug.resumed', step: stopped.step, action: 'continue' });
      stopped = null;
      await afterStop();
    });
  }
}

function threadMessage(sessionId: string, text: string): void {
  const t = threads.get(sessionId);
  if (!t) return;
  let msg: any;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  if (msg.id) {
    const w = (t as any).waits.get(msg.id);
    if (!w) return;
    (t as any).waits.delete(msg.id);
    if (msg.error) w.reject(new Error(String(msg.error.message ?? 'inspector error')));
    else w.resolve(msg.result);
  } else if (msg.method === 'Debugger.scriptParsed') {
    t.urls.set(msg.params.scriptId, msg.params.url);
  } else if (msg.method === 'Debugger.paused') {
    if (msg.params?.reason === 'Break on start') {
      // a worker held at its start (`waitForDebuggerOnStart`) breaks there once: nothing to stop for
      void t.post('Debugger.resume').catch(() => {});
      return;
    }
    threadBusy++;
    queue = queue
      .then(() => onThreadPaused(t, msg.params))
      .catch((e) => {
        send({ type: 'runner.error', message: `debugger hook failed in a worker pause: ${(e as Error)?.stack ?? e}` });
        if (stopped?.thread !== t) void t.post('Debugger.resume').catch(() => {});
      })
      .finally(async () => {
        threadBusy--;
        // a main-thread trap let go while this pause was looked at, and the worker went on
        if (threadBusy === 0 && !stopped) await afterStop();
      });
  }
}

relay?.on('message', (m: any) => {
  if (m?.op === 'attached') void attachThread(m).catch((e) => send({ type: 'runner.error', message: `debugger could not attach to a worker thread: ${(e as Error)?.message ?? e}` }));
  else if (m?.op === 'detached') detachThread(m.sessionId);
  else if (m?.op === 'message') threadMessage(m.sessionId, m.message);
});

function isLibrary(f: Frame): boolean {
  return f.file ? f.file.library : f.path.includes(`${pathSep}node_modules${pathSep}`);
}
const pathSep = process.platform === 'win32' ? '\\' : '/';

async function onThreadPaused(t: Thread, params: any): Promise<void> {
  if (!threads.has(t.sessionId)) return;
  if (stopped) {
    held.push(() => onThreadPaused(t, params));
    return;
  }
  const raw = params.callFrames ?? [];
  const reason: string = params.reason;
  if (raw[0]?.functionName === '__tracelight_trap__') {
    // a recorded worker stopped itself (threads/worker.ts `debugTraps`): a function breakpoint's
    // entry, or a step's next statement. Out of the trap, the thread is right after the step hook
    const r = await t.post('Runtime.evaluate', { expression: 'globalThis.__tracelight_hit__', returnByValue: true, silent: true }).catch(() => null);
    const hit = r?.result?.value ?? {};
    t.settle = hit.breakpoint ? { why: 'breakpoint', extra: { breakpoint: hit.breakpoint } } : { why: 'step', extra: { kind: hit.step ?? 'over' } };
    t.stepping = null;
    t.recorded = true;
    await t.post('Debugger.stepOut');
    return;
  }
  const all = await framesOf(raw, t.urls);
  const k = all.findIndex((f) => !isLibrary(f));
  const extra: Record<string, unknown> = {};
  let why: string | null = null;
  let conditionChecked = false;
  const stepping = t.stepping;
  t.stepping = null;
  if (reason === 'exception' || reason === 'promiseRejection') {
    t.settle = null;
    // V8 pauses at every throw (`all`): its own prediction counts Node's worker loader as a handler
    const exc = params.data ?? {};
    const first = k >= 0 && exceptionMode !== 'off' && (await firstSighting(t, exc));
    const v = first ? await verdict(raw, t) : 'caught';
    if (v === 'uncaught' || (exceptionMode === 'raised' && first)) {
      const description = String(exc.description ?? exc.value ?? 'exception');
      const type = exc.className ?? (exc.type === 'object' ? 'Object' : exc.type ?? 'Error');
      const firstLine = description.split('\n')[0]!;
      const message = exc.objectId && firstLine.startsWith(type) ? firstLine.slice(type.length).replace(/^:\s*/, '') : firstLine;
      why = 'exception';
      extra.exception = { type, message, uncaught: v === 'uncaught' };
    }
  } else if (params.hitBreakpoints?.length && k >= 0) {
    t.settle = null;
    why = 'breakpoint';
    const echo = t.breakpoints.get(params.hitBreakpoints[0]);
    if (echo) extra.breakpoint = echo;
  } else if (t.settle) {
    if (k < 0) {
      // out of the program's frames on the way: on to the next of its statements
      await t.post('Debugger.stepOut');
      return;
    }
    why = t.settle.why;
    conditionChecked = !!t.settle.conditionChecked;
    Object.assign(extra, t.settle.extra);
  } else if (stepping && k >= 0) {
    why = 'step';
    extra.kind = stepping;
  }
  let breakpoint = extra.breakpoint as Record<string, unknown> | undefined;
  if (why === 'breakpoint' && !conditionChecked && breakpoint && k >= 0) {
    const candidates = (Array.isArray(breakpoint.coincident) ? breakpoint.coincident : [breakpoint]) as Record<string, unknown>[];
    const logs: Record<string, unknown>[] = [];
    let stopping: Record<string, unknown> | undefined;
    for (const bp of candidates) {
      const checked = typeof bp.condition === 'string' ? await conditionResult(t.post, all[k]!, bp.condition) : { matches: true };
      if (checked.error) {
        stopping ??= bp;
        extra.conditionError ??= typeof bp.logMessage === 'string' ? `logpoint: ${checked.error}` : checked.error;
      } else if (checked.matches) {
        if (typeof bp.logMessage === 'string') logs.push(bp);
        else stopping ??= bp;
      }
    }
    conditionChecked = true;
    extra.logpoints = logs;
    extra.logpointOnly = !stopping;
    breakpoint = stopping ?? logs[0];
    extra.breakpoint = breakpoint;
    if (!breakpoint) {
      t.settle = null;
      await t.post('Runtime.releaseObjectGroup', { objectGroup: GROUP }).catch(() => {});
      await t.post('Debugger.resume');
      return;
    }
  }
  if (why === null) {
    // the program's own `debugger` statement, or a step that left the user's code: go on
    if (stepping && k < 0) t.stepping = stepping;
    await t.post(stepping && k < 0 ? 'Debugger.stepOut' : 'Debugger.resume');
    return;
  }
  if (why !== 'exception' && !(await atStatement(t, raw[0]))) {
    // a breakpoint's line pauses before its statement's step hook: on to just after it
    t.settle = { why, extra, conditionChecked };
    const runtime = isRuntimeFrame(urlPath(frameUrl(raw[0], t.urls)));
    await t.post(runtime ? 'Debugger.stepOut' : 'Debugger.stepOver');
    return;
  }
  t.settle = null;
  const frames = all.slice(k);
  const top = frames[0]!;
  const n = await threadStep(t);
  const logs = (extra.logpoints ?? []) as Record<string, unknown>[];
  const logpointOnly = extra.logpointOnly;
  delete extra.logpoints;
  delete extra.logpointOnly;
  for (const logpoint of logs) {
    try {
      const text = await logpointText(t.post, top, logpoint, t);
      send({ type: 'output', stream: 'stdout', text: text + '\n', step: n, logpoint, thread: { name: t.name, ident: t.ident } });
    } catch (error) { extra.conditionError = `logpoint: ${expressionError(error)}`; }
  }
  if (logpointOnly && !extra.conditionError) {
    await t.post('Runtime.releaseObjectGroup', { objectGroup: GROUP }).catch(() => {});
    await t.post('Debugger.resume');
    return;
  }
  const own = top.file && !top.file.library ? top.file : null;
  stopped = { frames, step: n, thread: t };
  send({
    type: 'debug.paused', step: n, rid: own?.lines.get(top.line) ?? -1, fileId: own?.fileId ?? 0, line: top.line,
    ...(own ? {} : { path: top.path }), scopeId: -1, depth: frames.length - 1, reason: why,
    thread: { name: t.name, ident: t.ident },
    stack: frames.map((f, i) => {
      const file = f.file && !f.file.library ? f.file : null;
      return { frameId: i, name: f.name, fileId: file?.fileId ?? 0, line: f.line, ...(file ? { rid: file.lines.get(f.line) } : { path: f.path }) };
    }),
    ...extra,
  });
}

/** the first time this thread's debugger sees an exception: a recorded worker's rethrow wrappers show it again in every frame it leaves */
async function firstSighting(t: Thread, exc: Remote): Promise<boolean> {
  if (!exc?.objectId) return true;
  const r = await t.post('Runtime.callFunctionOn', {
    objectId: exc.objectId, returnByValue: true, silent: true,
    // (a recorded worker keeps its shadow stack while held: this evaluation runs microtasks)
    functionDeclaration: 'function () { globalThis.__tracelight_hold__?.(); const seen = (globalThis.__tracelight_seen__ ??= new WeakSet()); if (seen.has(this)) return false; seen.add(this); return true; }',
  }).catch(() => null);
  return r?.result?.value !== false;
}

const STEP_METHOD: Record<string, string> = { into: 'Debugger.stepInto', over: 'Debugger.stepOver', out: 'Debugger.stepOut' };

async function resumeThread(t: Thread, action: string, kind: string | null): Promise<void> {
  await t.post('Runtime.releaseObjectGroup', { objectGroup: GROUP }).catch(() => {});
  const step = stopped!.step;
  t.stepping = kind;
  send({ type: 'debug.resumed', step, action, ...(kind ? { kind } : {}) });
  stopped = null;
  // the main thread's trap let go meanwhile: it pauses at its next statement, asked before the
  // worker goes on so nothing the worker sends it can run first. The worker's resume is not
  // awaited: it travels through the main thread's event loop, which that pause may hold
  if (mainDeferred) {
    mainDeferred = false;
    await main('requestPause()').catch(() => {});
  }
  if (t.recorded) {
    // a recorded worker stops itself at the step's next statement (threads/worker.ts `debugTraps`)
    void t.post('Runtime.evaluate', { expression: `globalThis.__tracelight_step__?.(${J(kind)})`, silent: true }).catch(() => {});
    t.stepping = null;
    void t.post('Debugger.resume').catch(() => {});
  } else void t.post(kind ? STEP_METHOD[kind]! : 'Debugger.resume').catch(() => {});
  await afterStop();
}

/** a stop ended: the next held worker pause, then a main-thread trap let go meanwhile */
async function afterStop(): Promise<void> {
  while (!stopped && held.length) {
    threadBusy++;
    try {
      await held.shift()!();
    } finally {
      threadBusy--;
    }
  }
  if (mainDeferred && !stopped?.thread) {
    mainDeferred = false;
    await main('requestPause()').catch(() => {});
  }
}

/** `{text, valueBag}` of a value in a worker thread: a bounded `util.inspect` there, masked here (not expandable) */
let threadValues = 0;
async function describeAt(remote: Remote, name: string, thread = stopped?.thread): Promise<{ text: string; valueBag: unknown }> {
  const t = thread;
  if (!t) return describe(remote, name);
  const r = await t.post('Runtime.callFunctionOn', {
    objectId: await t.globalObject(),
    functionDeclaration: `function (v) {
      const util = process.getBuiltinModule('node:util');
      let text;
      try { text = typeof v === 'string' ? JSON.stringify(v) : util.inspect(v, { depth: 2, breakLength: Infinity, maxArrayLength: 20, maxStringLength: 120, compact: true, customInspect: false, getters: false }); }
      catch (e) { text = '<unrepresentable>'; }
      const type = v === null ? 'null' : Array.isArray(v) ? 'Array' : typeof v === 'object' ? (v.constructor?.name ?? 'Object') : typeof v;
      return { text, type, secretable: typeof v === 'string' || v instanceof Uint8Array, length: typeof v === 'string' || Array.isArray(v) ? v.length : undefined };
    }`,
    arguments: [argOf(remote)], returnByValue: true, silent: true,
  });
  if (r.exceptionDetails) return { text: String(r.exceptionDetails.exception?.description ?? 'error').split('\n')[0]!, valueBag: null };
  const v = r.result.value as { text: string; type: string; secretable: boolean; length?: number };
  const secret = v.secretable && secrets.isSecretName(expressionName(name));
  let text = secret ? MASK : secrets.scrub(v.text);
  if (text.length > 120) text = `${text.slice(0, 120)}…(+${text.length - 120} chars)`;
  const data: Record<string, unknown> = { id: `t${t.ident}:${++threadValues}`, type: v.type, value: text };
  if (v.length !== undefined) data.length = v.length;
  if (secret) data.secret = true;
  return { text, valueBag: { data } };
}


// -- requests -----------------------------------------------------------------------------------------

type Req = Record<string, any>;

function frameFor(req: Req): Frame {
  const frames = stopped!.frames;
  const id = req.frameId === undefined || req.frameId === null ? 0 : Number(req.frameId);
  const f = frames[id];
  if (!Number.isInteger(id) || !f) throw new LookupError(`no frame ${req.frameId} in this pause`);
  return f;
}

class LookupError extends Error {
  name = 'LookupError';
}

async function evaluate(req: Req): Promise<void> {
  const expression = String(req.expression ?? '');
  let target: Target;
  if (stopped) target = targetOf(frameFor(req));
  else if (finished) target = { scope: await probeScope(post, data.probe, GROUP) };
  else throw new Error('the program is running; pause it first');
  const remote = await evaluatePure(at, target, expression, GROUP);
  send({ type: 'evaluate.result', id: req.id, ...(await describeAt(remote, expression)) });
}

/** where an expression runs: the live frame, or a returned frame's snapshot */
function targetOf(frame: Frame): Target {
  return frame.snapshot ? { scope: frame.snapshot.map((b) => ({ name: b.name, value: b.value })) } : { callFrameId: frame.callFrameId };
}

async function exec(req: Req): Promise<void> {
  if (finished) return send({ type: 'exec.error', id: req.id, message: 'the run has ended; there is no frame to execute in' });
  if (!stopped) return send({ type: 'exec.error', id: req.id, message: 'the program is running; pause it first' });
  const frame = frameFor(req);
  if (frame.snapshot) return send({ type: 'exec.error', id: req.id, message: 'this frame has returned (the exception left it); exec needs a live frame' });
  const source = String(req.source ?? '').trim();
  await main('markModified()');
  const r = await at('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression: source, silent: true, objectGroup: GROUP });
  const reply: Record<string, unknown> = { type: 'exec.result', id: req.id, text: '', modified: true };
  if (r.exceptionDetails) {
    const ex = r.exceptionDetails.exception;
    const desc = String(ex?.description ?? r.exceptionDetails.text);
    const type = ex?.className ?? 'Error';
    reply.exception = { type, message: desc.split('\n')[0]!.replace(new RegExp(`^${type}:\\s*`), ''), traceback: desc.split('\n').filter((l) => !/node:inspector|tracelight-|__tk/.test(l)).join('\n') };
  } else if (showsValue(source)) {
    Object.assign(reply, await describeAt(r.result, source));
  }
  send(reply);
}

// `arguments` too: V8 lists a function's own only when it uses it, so one in an enclosing
// scope is the wrapper's (require, module, ...), never the paused function's
const MODULE_NOISE = new Set(['exports', 'require', 'module', '__filename', '__dirname', 'arguments']);

async function locals(frame: Frame, req: Req): Promise<{ name: string; type?: string; text: string; valueBag?: unknown }[]> {
  const out: { name: string; type?: string; text: string; valueBag?: unknown }[] = [];
  if (req.namesOnly !== undefined && typeof req.namesOnly !== 'boolean') throw new TypeError('namesOnly must be a boolean');
  if (req.names !== undefined && (!Array.isArray(req.names) || req.names.some((name: unknown) => typeof name !== 'string'))) throw new TypeError('names must be an array of strings');
  const names = req.names === undefined ? null : new Set<string>(req.names);
  for (const b of await bindingsOf(frame, GROUP)) {
    if (!b.shown || names && !names.has(b.name)) continue;
    const type = b.value.subtype ?? b.value.type;
    out.push(req.namesOnly ? { name: b.name, type, text: '' } : { name: b.name, type, ...(await describeAt(b.value, b.name)) });
  }
  return out;
}

async function complete(req: Req): Promise<void> {
  let scopes: { names: { name: string; remote: Remote }[] }[] = [];
  let target: Target;
  if (stopped) {
    const frame = frameFor(req);
    target = targetOf(frame);
    if (frame.snapshot) scopes.push({ names: frame.snapshot.map((b) => ({ name: b.name, remote: b.value })) });
    for (const scope of frame.scopeChain) {
      if (scope.type === 'global' || !scope.object?.objectId) continue;
      const props = await at('Runtime.getProperties', { objectId: scope.object.objectId, ownProperties: true, objectGroup: GROUP });
      scopes.push({ names: (props.result ?? []).filter((p: any) => p.value).map((p: any) => ({ name: p.name, remote: p.value })) });
    }
  } else if (finished) {
    const bound = await probeScope(post, data.probe, GROUP);
    target = { scope: bound };
    scopes = [{ names: bound.map((b) => ({ name: b.name, remote: b.value })) }];
  } else {
    return send({ type: 'complete.error', id: req.id, message: 'the program is running; pause it first' });
  }
  const limit = req.limit ? Number(req.limit) : 100;
  const result = stopped?.thread
    ? await completionsFor(at, target, String(req.expression ?? ''), scopes, await stopped.thread.globalObject(), limit, GROUP)
    : await completionsFor(post, target, String(req.expression ?? ''), scopes, await globalObject(), limit, GROUP);
  send({ type: 'complete.result', id: req.id, ...result });
}

async function debugAction(req: Req): Promise<void> {
  const reply = (fields: Record<string, unknown>) => send({ type: 'debug.result', id: req.id, ...fields });
  const error = (message: string) => send({ type: 'debug.error', id: req.id, message });
  const action = req.action;
  switch (action) {
    case 'breakpoints': {
      const echo = await main(`setBreakpoints(${J(req.set ?? [])})`);
      // the relay needs the main thread running: never awaited here (threads.ts)
      for (const t of threads.values()) void syncBreakpoints(t).catch(() => {});
      return reply(echo);
    }
    case 'watches': {
      const echo: Record<string, unknown>[] = [];
      const kept: Watch[] = [];
      for (const spec of req.set ?? []) {
        const exp = String(spec?.exp ?? '').trim();
        if (!exp) continue;
        const w: Watch = { id: String(spec.id ?? `w${echo.length + 1}`), exp, mode: spec.breakWhen === 'true' ? 'true' : 'change', last: undefined, missing: false };
        w.error = syntaxError(exp) ?? undefined;
        if (spec.breakWhen !== undefined && !['true', 'change'].includes(spec.breakWhen)) w.error = `unknown watch mode '${spec.breakWhen}' (change, true)`;
        if (!w.error) {
          // A change watch starts with the value at the current pause, so the first resumed
          // assignment is not mistaken for its baseline. An unbound name waits for its frame.
          if (w.mode === 'change' && stopped && !stopped.thread) {
            try {
              const remote = await evaluatePure(post, targetOf(stopped.frames[0]!), exp, GROUP);
              if (remote.type !== 'undefined') w.last = await textOf(remote, exp);
            } catch { /* evaluation failures are explained at the next statement */ }
          }
          kept.push(w);
        }
        echo.push({ id: w.id, exp: w.exp, breakWhen: w.mode, ...(w.error ? { error: w.error } : {}) });
      }
      watches = kept;
      await main(`setWatching(${kept.length > 0})`);
      return reply({ watches: echo });
    }
    case 'exceptions': {
      const mode = await main(`setExceptionMode(${J(String(req.mode ?? ''))})`);
      if (!mode) return error(`unknown exception mode '${req.mode}' (off, uncaught, raised)`);
      await applyExceptionMode(mode.mode);
      for (const t of threads.values()) void t.post('Debugger.setPauseOnExceptions', { state: threadExceptionState() }).catch(() => {});
      return reply(mode);
    }
    case 'pause':
      if (stopped) return reply({ ok: true, paused: true });
      return reply(await main('requestPause()'));
    case 'locals': {
      if (!stopped) return error(finished ? 'the run has ended; there is no frame' : 'the program is running; pause it first');
      const fields: Record<string, unknown> = { locals: await locals(frameFor(req), req) };
      if (await main('modified')) fields.modified = true;
      return reply(fields);
    }
    case 'record':
      if (!stopped) return error('the program is running; pause it first');
      if (stopped.thread) return error('a recording starts at a pause of the main thread; this one is in a worker thread');
      try {
        return reply(await main('recordHere()'));
      } catch (e) {
        return error((e as Error).message);
      }
    case 'continue':
    case 'step': {
      if (!stopped) return error('the program is running; it resumes only from a pause');
      const kind = String(req.kind ?? 'into');
      if (action === 'step' && !['into', 'over', 'out'].includes(kind)) return error(`unknown step kind '${kind}' (into, over, out)`);
      reply({ ok: true });
      return resume(action, action === 'step' ? kind : null);
    }
    default:
      return error(`unknown debug action '${action}'`);
  }
}

async function resume(action: string, kind: string | null): Promise<void> {
  if (stopped?.thread) return resumeThread(stopped.thread, action, kind);
  const again = action === 'continue' ? stopped?.then : undefined;
  if (again && stopped) {
    stopped.then = undefined;
    await main(`resume(${J(action)}, null)`);
    await again();
    return;
  }
  stopped = null;
  await post('Runtime.releaseObjectGroup', { objectGroup: GROUP });
  await post('Runtime.releaseObjectGroup', { objectGroup: PM_GROUP });
  await main(`resume(${J(action)}, ${J(kind)})`);
  await post('Debugger.resume');
  await afterStop();
}

const REPLY_TYPE: Record<string, string> = { shadow: 'evaluate' };

async function handle(req: Req): Promise<void> {
  const type = String(req.type ?? '');
  try {
    switch (type) {
      case 'exit':
        if (stopped) await resume('continue', null);
        clearInterval(keepAlive);
        parentPort?.postMessage({ type: 'exit' });
        return;
      case 'debug':
        return await debugAction(req);
      case 'evaluate':
        return await evaluate(req);
      case 'exec':
        return await exec(req);
      case 'complete':
        return await complete(req);
      case 'shadow':
        if (stopped) throw new Error('shadow values need a finished run');
      // falls through: the finished run's handler serves it
      default:
        if (!(await main(`forward(${J(req)})`))) send({ type: `${REPLY_TYPE[type] ?? type}.error`, id: req.id, message: 'LookupError: no run data' });
    }
  } catch (e) {
    const err = e as Error;
    const message = err instanceof RefusedError ? err.message : err instanceof EvalException ? err.message : `${err.name === 'Error' ? 'Error' : err.name}: ${err.message}`;
    send({ type: `${REPLY_TYPE[type] ?? type}.error`, id: req.id, message });
  } finally {
    await post('Runtime.releaseObjectGroup', { objectGroup: GROUP }).catch(() => {});
  }
}

parentPort?.on('message', (msg: any) => {
  if (msg?.type === 'finished') finished = true;
  else if (msg?.type === 'request') queue = queue.then(() => handle(msg.req));
});

async function start(): Promise<void> {
  await post('Debugger.enable');
  await post('Runtime.enable');
  await applyExceptionMode(await main('breakOnException'));
  if (data.ctlFd !== undefined) {
    const rl = readline.createInterface({ input: fs.createReadStream('', { fd: data.ctlFd, autoClose: false }) });
    rl.on('line', (line) => {
      const text = line.trim();
      if (!text) return;
      let req: Req;
      try {
        req = JSON.parse(text);
      } catch {
        return;
      }
      queue = queue.then(() => handle(req));
    });
    rl.on('close', () => {
      queue = queue.then(() => handle({ type: 'exit' }));
    });
  }
  parentPort?.postMessage({ type: 'ready' });
}

start().catch((e) => {
  parentPort?.postMessage({ type: 'failed', message: String((e as Error)?.stack ?? e) });
});

export type { Completion };
