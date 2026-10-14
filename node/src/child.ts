/**
 * The run child: one Node process per run, spawned by the runner with an IPC channel.
 *
 * It installs the `__tk` hooks, a `module.registerHooks` load hook that instruments every project
 * file as it is required or imported (ESM, CommonJS and TypeScript alike), runs the program, and
 * when the event loop has nothing left for it sends coverage, times, the caught exceptions and the
 * final trace. Then it stays alive serving `expand` and `source` from its value registry until the
 * runner replaces it with the next run's child.
 *
 * runner -> child, over IPC: {type: 'run', request} | {type: 'expand' | 'source', id, ...} | {type: 'stop'}
 * child -> runner, NDJSON on fd 3: {kind: 'event', event} | {kind: 'reply', id, msg} | {kind: 'done', exitCode, stepCount, logCount}
 */
import { Session } from 'node:inspector';
import { createRequire, isBuiltin } from 'node:module';
import * as nodeModule from 'node:module';
import { tmpdir } from 'node:os';
import { existsSync, mkdtempSync, realpathSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSync } from './parse.ts';
import { inlineConfig, instrument, relocate, toJavaScript, isJsxPath, isTypeScriptPath, type InstrumentedFile } from './instrument.ts';
import * as cache from './cache.ts';
import { NAME, runConfig, type RunConfig } from './protocol.ts';
import { secrets } from './secrets.ts';
import { getters, Registry, Serializer } from './serialize.ts';
import { EXIT, Tracer } from './tracer.ts';
import { kindOf, type Kind } from './select.ts';
import { pathCandidates, pathConfigFor } from './tsconfig.ts';
import { api } from './execute.ts';
import { loadPlugins, runAfter, runStage, withHttpPlugin, type Loaded } from './plugins.ts';
import { LineWriter, newLock } from './debug/wire.ts';
import { recordFromOf, startDebugger, wantsDebugger, type DebugSession } from './debug/index.ts';
import { debugHooks, type DebugHooks } from './recorder/debugHooks.ts';
import { childDebugHost, debugFile } from './debug/host.ts';
import { evaluateFinished, completeFinished, shadowFinished } from './evaluate.ts';
import { describeFallback } from './debug/describe.ts';
import { pruneProfile, type CpuProfile } from './profile.ts';
import { fingerprint, ID_FILE, ID_RANGE, newIds, ThreadHub, type Alias } from './threads/hub.ts';

type Msg = Record<string, any>;

/** The source-returning Bun plugin hook loses CommonJS export semantics. */
function bunCommonJS(filename: string, source: string): boolean {
  if (/\.(?:cjs|cts)$/i.test(filename)) return true;
  const lang = /\.tsx$/i.test(filename) ? 'tsx' : /\.jsx$/i.test(filename) ? 'jsx' : /\.(?:ts|mts)$/i.test(filename) ? 'ts' : 'js';
  const tree = parseSync(filename, source, { sourceType: 'unambiguous', lang }).program;
  const visit = (node: any): boolean => {
    if (!node || typeof node !== 'object') return false;
    if (Array.isArray(node)) return node.some(visit);
    if (node.type === 'MemberExpression' && node.object?.type === 'Identifier' &&
      (node.object.name === 'exports' || node.object.name === 'module' &&
        (node.property?.name === 'exports' || node.property?.value === 'exports'))) return true;
    return Object.values(node).some(value => typeof value === 'object' && visit(value));
  };
  return visit(tree);
}

const EVENTS_FD = 3;
/** what a debug run that records nothing never sends: all of it describes a recording (an uncaught `error` still goes out) */
const UNRECORDED_DROP = new Set(['trace', 'coverage', 'log', 'locals', 'time', 'watch', 'http.exchange', 'error']);
/** the control pipe of a debug run, read by the debugger's worker thread (debug/agent.ts) */
const CONTROL_FD = 5;
/** one lock for every thread that writes on fd 3 (the debugger's worker answers there too) */
const wireLock = newLock();
const wire = new LineWriter(EVENTS_FD, wireLock);

/**
 * Everything the child says goes out on fd 3 with blocking writes: a program stuck in a loop never
 * yields to the event loop, so an asynchronous channel would hold its partial traces forever, and a
 * `process.exit` would drop whatever was still queued.
 */
function send(msg: Msg, cb?: () => void): void {
  wire.write(msg);
  cb?.();
}

export class RunChild {
  tracer!: Tracer;
  config!: RunConfig;
  readonly registry = new Registry();
  readonly overrides = new Map<string, string>();
  readonly sources = new Map<number, string>();
  mainPath = '';
  root = '';
  done = false;
  exitCode: number | null = 0;
  plugins: Loaded[] = [];
  mode = 'normal';
  profiler: Session | null = null;
  rawConfig: Msg = {};
  realExit = process.exit.bind(process);
  realStdout = process.stdout.write.bind(process.stdout);
  realStderr = process.stderr.write.bind(process.stderr);
  debug: DebugSession | null = null;
  /** a debug run that records nothing (yet): `record: false`, or `recordFrom` before its pause */
  unrecorded: 'none' | 'from' | null = null;
  dbgHooks: DebugHooks | null = null;
  /** the run's file ids, rids and segment clock, shared with its worker threads (threads/hub.ts) */
  ids: Int32Array = newIds();
  /** worker_threads recording: the main thread's hub, once the program may start workers */
  hub: ThreadHub | null = null;
  /** in a worker: files the main thread had instrumented when the worker started */
  aliases: Map<string, Alias> | null = null;
  /** in a worker: its entry file, instrumented like a main file (its body is the worker's own scope) */
  entry = '';
  markers: unknown[] = [];
  expressionsToEvaluate: Record<string, unknown> | undefined;
  /** in a worker: a file it instrumented, and whether it is the main thread's (an alias) */
  onFile: ((info: InstrumentedFile, aliased: boolean) => void) | null = null;

  private debugLive = false;

  /** threads/hub.ts: a live debug run, so workers stop for the debugger too */
  get debugRun(): boolean {
    return this.debugLive;
  }

  /** threads/hub.ts: a file a worker instrumented, for the debugger's breakpoints */
  fileAdded(info: InstrumentedFile): void {
    this.debug?.debugger.fileAdded(debugFile(info));
  }

  /** threads/hub.ts: the function breakpoints a new worker traps on itself (threads/worker.ts) */
  functionBreakpoints(): { function: string; path: string; echo: Record<string, unknown> }[] {
    return this.debug?.debugger.functionBreakpoints() ?? [];
  }

  /** false while a debug run records nothing */
  get recording(): boolean {
    return this.unrecorded === null;
  }

  emit = (event: Msg): void => {
    if (this.done && event.type !== 'runner.error') return;
    if (this.unrecorded !== null && UNRECORDED_DROP.has(event.type) && !(event.type === 'error' && !event.handled)) return;
    if (this.hub !== null && this.hub.route(event)) return;
    send({ kind: 'event', event });
  };

  /** threads/hub.ts: a code string's format by its syntax */
  formatOf(source: string): 'module' | 'commonjs';
  formatOf(path: string, source: string): 'module' | 'commonjs';
  formatOf(a: string, b?: string): 'module' | 'commonjs' {
    return b === undefined ? this.formatOfPath('', a) : this.formatOfPath(a, b);
  }

  /** threads/hub.ts: `eval: true` worker code, instrumented as a worker's entry */
  instrumentEntry(path: string, source: string): InstrumentedFile {
    const saved = this.entry;
    this.entry = path;
    try {
      return this.instrumentFile(path, source, 'commonjs', []);
    } finally {
      this.entry = saved;
    }
  }

  /** an event straight to the runner (the hub's, already in the merged numbering) */
  out = (event: Msg): void => {
    send({ kind: 'event', event });
  };

  /** the step code runs at now: the attributed trace index, or the statement counter of a run that records nothing */
  stepNow(): number {
    if (this.unrecorded !== null && this.dbgHooks) return Math.max(0, this.dbgHooks.count() - 1);
    return this.tracer.attributedStep();
  }

  /** recordFrom: the recording starts at the pause being served (the debugger calls this on the paused thread) */
  startRecording(rid: number, scope: number): { scope: number; step: number } {
    if (this.unrecorded !== 'from' || !this.dbgHooks) return { scope, step: this.tracer.curStep };
    const top = this.tracer.startRecording(this.dbgHooks.chain(), rid, scope);
    this.unrecorded = null;
    return { scope: top, step: 0 };
  }

  async run(req: Msg): Promise<void> {
    applyInlineConfig(req);
    if (req.config?.debug && req.config.record === false) {
      // the Debugger: everything that describes a recording is off (docs/PROTOCOL.md "A debug run without a recording")
      this.unrecorded = 'none';
      Object.assign(req.config, { recordLocals: false, autoLog: false, http: 'off', httpObserve: false });
      req.mode = 'normal';
      for (const k of ['markers', 'watch', 'expressionsToEvaluate', 'traceContext']) delete req[k];
    } else if (recordFromOf(req.config)) this.unrecorded = 'from';
    this.config = runConfig(req.config);
    secrets.configure(this.config.secrets.mask, this.config.secrets.names);
    this.tracer = new Tracer(this.config, this.emit, { registry: this.registry, expressionsToEvaluate: req.expressionsToEvaluate });
    this.markers = req.markers ?? [];
    this.expressionsToEvaluate = req.expressionsToEvaluate;
    (globalThis as any).__tk = this.tracer.hooks;
    getters.resolve = this.config.resolveGetters;
    getters.invoke = (fn) => {
      this.tracer.quiet++; // an instrumented getter run for a value records nothing
      try {
        return fn();
      } finally {
        this.tracer.quiet--;
      }
    };
    const file = req.file ?? {};
    if (typeof req.module === 'string' && req.module) {
      // the module launch: a package's bin or a specifier resolved from cwd, the way `npx` / `node -e "import(...)"` find it
      if (file.path) this.emit({ type: 'runner.error', message: `run.module and run.file are both set; running the module ${req.module}` });
      try {
        this.mainPath = resolveModule(req.module, resolve(req.cwd ?? req.workspaceRoot ?? process.cwd()));
      } catch (e) {
        this.emit({ type: 'runner.error', message: `cannot run -m ${req.module}: ${(e as Error).message}` });
        return this.finish(undefined, false, 1);
      }
      req.workspaceRoot ??= req.cwd;
      delete file.content;
    } else if (!file.path) {
      this.emit({ type: 'runner.error', message: 'run.file.path is missing' });
      return this.finish(undefined, false, 1);
    } else this.mainPath = resolve(file.path);
    // Node resolves imports through real paths. Match selection and unsaved buffers to them.
    try { this.mainPath = realpathSync(this.mainPath); } catch { /* unsaved file */ }
    this.root = resolve(req.workspaceRoot ?? dirname(this.mainPath));
    try { this.root = realpathSync(this.root); } catch { /* virtual workspace */ }
    if (typeof file.content === 'string') this.overrides.set(this.mainPath, file.content);
    for (const pf of req.projectFiles ?? []) if (pf?.path && typeof pf.content === 'string') {
      let path = resolve(pf.path);
      try { path = realpathSync(path); } catch { /* unsaved file */ }
      this.overrides.set(path, pf.content);
    }
    try {
      if (req.cwd) process.chdir(req.cwd);
    } catch (e) {
      this.emit({ type: 'runner.error', message: `cannot change to ${req.cwd}: ${(e as Error).message}` });
    }
    for (const [k, v] of Object.entries(req.env ?? {})) process.env[k] = String(v);
    process.argv = [process.execPath, this.mainPath, ...(req.argv ?? []).map(String)];
    this.rawConfig = req.config ?? {};
    const tracer = this.tracer;
    const position = () => {
      const rec = tracer.rec;
      const step = tracer.attributedStep();
      return step >= 0 && step < Math.min(rec.n, rec.cap) ? { rid: rec.buffer[step * 4]!, step } : { rid: -1, step: -1 };
    };
    api.current = { filePath: this.mainPath, workspaceRoot: this.root, runId: req.runId, config: this.rawConfig, emit: this.emit, position };
    (globalThis as any).__tracelight = api;
    const report = (message: string) => this.emit({ type: 'runner.error', message });
    // plugins load before the runtime's load hook, so their own code is never instrumented
    const names = withHttpPlugin(this.rawConfig, Array.isArray(this.rawConfig.plugins) ? this.rawConfig.plugins.map(String) : []);
    this.plugins = await loadPlugins(names, [dirname(this.mainPath), this.root], report, 'beforeEach');
    this.patchStreams();
    this.mode = req.mode === 'profile' || req.mode === 'snaps' ? req.mode : 'normal';
    if (this.mode === 'profile') this.startProfile(req);
    else this.installLoader(req);
    await runStage(this.plugins, 'beforeEach', this.rawConfig, report);
    process.on('uncaughtException', (err) => this.finish(err, true, 1));
    process.on('unhandledRejection', (reason) => this.finish(reason, true, 1));
    process.on('beforeExit', () => this.finish(undefined, false, 0));
    (process as any).exit = (code?: number) => {
      const c = typeof code === 'number' ? code : typeof process.exitCode === 'number' ? process.exitCode : 0;
      this.finish(undefined, false, c, () => this.realExit(c));
      throw new ExitSignal(c); // stop the program here, as process.exit would
    };
    const flush = setInterval(() => {
      if (!this.done) this.tracer.flushTrace();
    }, 1000);
    flush.unref();
    process.channel?.unref(); // the program's own work decides when it is done
    const wants = wantsDebugger(req);
    const recordWorkers = !process.versions.bun && this.unrecorded === null && this.mode !== 'profile' && this.config.workers;
    // a worker's pause in a live debug run: its step in the merged trace, from the hub to the debugger (agent.ts)
    this.debugLive = wants === 'live';
    const pauseCell = wants === 'live' && recordWorkers ? new Int32Array(new SharedArrayBuffer(16)) : null;
    if (wants) {
      try {
        // only a live debugger takes the control pipe; a watch window leaves requests on IPC
        this.debug = await startDebugger(childDebugHost(this), req, { ctlFd: wants === 'live' ? CONTROL_FD : undefined, eventFd: EVENTS_FD, lock: wireLock, pause: pauseCell?.buffer as SharedArrayBuffer | undefined, onExit: () => this.finish(undefined, false, null, () => this.realExit(0)) });
        const dbg = this.debug.debugger;
        this.tracer.rec.onStep = (n, rid, scope) => {
          if (dbg.armed) dbg.onStep(n, rid, scope);
        };
        for (const info of this.tracer.files) dbg.fileAdded(debugFile(info));
        if (this.unrecorded !== null && wants === 'live') {
          this.dbgHooks = debugHooks(dbg, this.tracer.rec, { recordFrom: this.unrecorded === 'from', locals: this.config.recordLocals });
          this.tracer.useDebugHooks(this.dbgHooks.hooks);
        }
      } catch (e) {
        this.emit({ type: 'runner.error', message: (e as Error).message });
        // A requested live session must never execute the program as a recording fallback.
        if (wants === 'live') return this.finish(undefined, false, 1);
      }
    }
    if (this.unrecorded !== null && !this.dbgHooks) this.unrecorded = null; // no debugger: an ordinary recording run
    if (recordWorkers && this.unrecorded === null) {
      // worker_threads record too; in a live debug run the debugger stops in them as well (debug/threads.ts)
      this.hub = new ThreadHub(this);
      this.hub.pauseCell = this.debug ? pauseCell : null;
      this.hub.install();
    }
    try {
      await import(pathToFileURL(this.mainPath).href);
    } catch (e) {
      if (e instanceof ExitSignal) return;
      if (e instanceof InstrumentFailure) return this.finish(undefined, false, 1);
      this.finish(e, true, 1);
    }
  }

  patchStreams(): void {
    const route = (stream: 'stdout' | 'stderr') =>
      ((chunk: any, encoding?: any, cb?: any) => {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8');
        if (!this.done) this.emit({ type: 'output', stream, text: secrets.scrub(text), step: this.stepNow() });
        else (stream === 'stdout' ? this.realStdout : this.realStderr)(chunk, encoding, cb);
        const done = typeof encoding === 'function' ? encoding : cb;
        if (typeof done === 'function') queueMicrotask(done);
        return true;
      }) as typeof process.stdout.write;
    process.stdout.write = route('stdout');
    process.stderr.write = route('stderr');
  }

  /** `project`, `library` (libraryCode) or null (run as is), after `exclude` and `only` */
  kindOf(path: string): Kind | null {
    const c = this.config;
    return kindOf(path, { root: this.root, mainPath: this.mainPath, libraryCode: c.libraryCode, libraryPackages: c.libraryPackages, exclude: c.exclude, only: c.only });
  }

  /** `module` or `commonjs` the way Node decides it: extension, then package.json `type`, then syntax (no path: syntax) */
  formatOfPath(path: string, source: string): 'module' | 'commonjs' {
    const ext = extname(path).toLowerCase();
    if (ext === '.mjs' || ext === '.mts') return 'module';
    if (ext === '.cjs' || ext === '.cts') return 'commonjs';
    for (let dir = dirname(path); path; dir = dirname(dir)) {
      const pkg = join(dir, 'package.json');
      if (existsSync(pkg)) {
        try {
          const type = JSON.parse(readFileSync(pkg, 'utf8')).type;
          if (type === 'module') return 'module';
          if (type === 'commonjs') return 'commonjs';
        } catch {
          /* unreadable package.json: fall through to syntax detection */
        }
        break;
      }
      if (dirname(dir) === dir) break;
    }
    try {
      const lang = /\.tsx$/i.test(path) ? 'tsx' : /\.jsx$/i.test(path) ? 'jsx' : /\.(ts|mts|cts)$/i.test(path) ? 'ts' : 'js';
      const r = parseSync(`x.${lang}`, source, { sourceType: 'unambiguous', lang } as any);
      return r.module?.hasModuleSyntax ? 'module' : 'commonjs';
    } catch {
      return 'commonjs';
    }
  }

  installLoader(req: Msg): void {
    const markers = req.markers ?? [];
    if (process.versions.bun) {
      const bun = (globalThis as any).Bun;
      const hooked = new Set<string>();
      let resolving = false;
      bun.plugin({ name: 'tracelight-record', setup: (builder: any) => {
        // Bun onLoad cannot decline a file. Select in onResolve, where undefined falls
        // through to Bun, so excluded ESM and CommonJS keep their native loaders.
        builder.onResolve({ filter: /.*/, namespace: 'file' }, (args: {path: string; importer: string}) => {
          if (resolving || /^(?:node|bun):/.test(args.path)) return undefined;
          let filename: string;
          try {
            resolving = true;
            filename = realpathSync(bun.resolveSync(args.path, args.importer ? dirname(args.importer) : this.root));
          } catch { return undefined; }
          finally { resolving = false; }
          const kind = this.kindOf(filename);
          if (!kind) return undefined;
          if (!hooked.has(filename)) {
            hooked.add(filename);
            const filter = new RegExp('^' + filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
            builder.onLoad({ filter, namespace: 'file' }, () => {
              const source = this.overrides.get(filename) ?? readFileSync(filename, 'utf8');
              if (bunCommonJS(filename, source)) {
                throw new Error('Bun onLoad source modules do not preserve CommonJS exports; CommonJS recording requires Node');
              }
              const info = this.instrumentFile(filename, source, 'module', kind === 'library' ? [] : markers, kind === 'library');
              if (info.code === null) throw new InstrumentFailure(info.error ?? 'instrumentation failed');
              // Skip Bun's reformatter so inspector lines match the instrumented source (+ pragma).
              return { contents: `// @bun\n${info.code}`, loader: 'js' };
            });
          }
          return {path: filename};
        });
      }});
      return;
    }
    nodeModule.registerHooks({
      resolve: resolveTypeScript,
      load: (url, context, nextLoad) => {
        if (!url.startsWith('file:')) return nextLoad(url, context);
        let path: string;
        try {
          path = fileURLToPath(url);
        } catch {
          return nextLoad(url, context);
        }
        const kind = this.kindOf(path);
        if (!kind) return this.loadUnrecorded(path, url, context, nextLoad);
        const source = this.overrides.get(path) ?? readFileSync(path, 'utf8');
        const format = this.formatOf(path, source);
        const info = this.instrumentFile(path, source, format, kind === 'library' ? [] : markers, kind === 'library');
        if (info.code === null) throw new InstrumentFailure(info.error ?? 'instrumentation failed');
        return { format, source: info.code, shortCircuit: true };
      },
    });
  }

  /**
   * A file the run does not record, as Node would load it, except TypeScript and JSX: Node's own
   * loader only strips types, so a parameter property, enum or namespace outside the selection
   * (a driver in another directory importing a project) would stop the run before its first step.
   */
  loadUnrecorded(path: string, url: string, context: nodeModule.LoadHookContext, nextLoad: Parameters<nodeModule.LoadHookSync>[2]): nodeModule.LoadFnOutput {
    if (!isTypeScriptPath(path) && !isJsxPath(path)) return nextLoad(url, context);
    let text: string;
    try { text = readFileSync(path, 'utf8'); } catch { return nextLoad(url, context); }
    return { format: this.formatOf(path, text), source: toJavaScript(text, path).js, shortCircuit: true };
  }

  /**
   * `mode: "profile"`: the plain program under the V8 sampling profiler. The main file is still
   * instrumented once so the host gets its ranges, but nothing instrumented runs; the load hook only
   * serves unsaved buffers (types stripped). The `.cpuprofile` is V8's own, with real call trees.
   */
  startProfile(req: Msg): void {
    const source = this.overrides.get(this.mainPath) ?? readFileSync(this.mainPath, 'utf8');
    this.instrumentFile(this.mainPath, source, this.formatOf(this.mainPath, source), req.markers ?? []);
    nodeModule.registerHooks({
      resolve: resolveTypeScript,
      load: (url, context, nextLoad) => {
        if (!url.startsWith('file:')) return nextLoad(url, context);
        let path: string;
        try {
          path = fileURLToPath(url);
        } catch {
          return nextLoad(url, context);
        }
        const text = this.overrides.get(path);
        if (text === undefined) return this.loadUnrecorded(path, url, context, nextLoad);
        return { format: this.formatOf(path, text), source: isTypeScriptPath(path) || isJsxPath(path) ? toJavaScript(text, path).js : text, shortCircuit: true };
      },
    });
    const s = new Session();
    s.connect();
    s.post('Profiler.enable');
    s.post('Profiler.setSamplingInterval', { interval: 100 });
    s.post('Profiler.start');
    this.profiler = s;
  }

  /** stop the profiler (synchronous on a same-thread session) and write the `.cpuprofile`; its path */
  stopProfile(): string | null {
    const s = this.profiler;
    if (!s) return null;
    this.profiler = null;
    let profile: unknown = null;
    s.post('Profiler.stop', (err, r) => {
      if (!err) profile = pruneProfile(r.profile as unknown as CpuProfile);
    });
    s.disconnect();
    if (!profile) return null;
    try {
      const safe = (this.mainPath.split(/[\\/]/).pop() ?? 'scratch').replace(/[^A-Za-z0-9_.-]/g, '_');
      const path = join(mkdtempSync(join(tmpdir(), `${NAME}-`)), `${safe}.cpuprofile`);
      writeFileSync(path, JSON.stringify(profile));
      return path;
    } catch (e) {
      this.emit({ type: 'runner.error', message: `writing the profile failed: ${(e as Error).message}` });
      return null;
    }
  }

  instrumentFile(path: string, source: string, format: 'module' | 'commonjs', markers: any[], library = false): InstrumentedFile {
    const t0 = performance.now();
    const isMain = path === this.mainPath;
    const options = {
      sourceType: format,
      moduleScope: !isMain && path !== this.entry,
      library,
      relocatable: library,
      snaps: isMain && this.mode === 'snaps',
      // insertions never add a line, so a library's stack lines are right without a map (2 s saved on typescript.js)
      sourceMap: !library && !process.versions.bun,
      autoLog: isMain && this.config.autoLog,
      recordLocals: this.config.recordLocals,
      scopeProbe: isMain,
      markers: isMain ? markers : (markers ?? []).filter((m: any) => !m.path || resolve(m.path) === path),
      ignoreCoverage: this.config.hints.ignoreCoverage,
      ignoreCoverageForFile: this.config.hints.ignoreCoverageForFile,
    };
    // library files come from the cache when they can (never an unsaved buffer)
    const key = library && !this.overrides.has(path) ? cache.cacheKey(path, { format, hints: this.config.hints, recordLocals: !!this.config.recordLocals }) : null;
    const hit = key ? cache.load(key) : null;
    const make = (fileId: number, base: number): InstrumentedFile => {
      if (hit) return { ...relocate(hit, fileId, base), filename: path };
      const out = instrument(source, path, fileId, base, options);
      if (key) cache.store(key, out);
      return out;
    };
    // a file another thread of the run instrumented already: the same id and rids when it comes out the same
    const alias = this.aliases?.get(path) ?? this.hub?.aliasFor(path);
    let info: InstrumentedFile | null = null;
    if (alias) {
      info = make(alias.fileId, alias.rangeBase);
      if (fingerprint(info) !== alias.fp) info = null;
    }
    const aliased = info !== null;
    if (info === null) {
      // ids and rids come from counters the run's threads share
      const fileId = Atomics.add(this.ids, ID_FILE, 1) + 1;
      for (;;) {
        const base = Atomics.load(this.ids, ID_RANGE);
        info = make(fileId, base);
        if (Atomics.compareExchange(this.ids, ID_RANGE, base, base + info.rangeCount) === base) break;
      }
    }
    const fileId = info.fileId;
    if (process.versions.bun) info.runtimeLineOffset = 1;
    const ms = performance.now() - t0;
    this.tracer.addFile(info);
    this.debug?.debugger.fileAdded(debugFile(info));
    const shown = info.code?.replace(/\n\/\/# sourceMappingURL=data:[^\n]*$/, '') ?? null;
    if (shown !== null) this.sources.set(fileId, shown);
    this.onFile?.(info, aliased);
    if (!aliased) this.emit({ type: 'file.instrumented', fileId, path, rangeBase: info.rangeBase, ranges: info.ranges, statements: info.statements, functions: info.functions, magic: info.magic, ...(info.walk ? { walk: info.walk } : {}), instrumentedSource: library ? undefined : (shown ?? undefined), instrumentMs: ms });
    if (this.unrecorded !== 'none') for (const w of info.warnings) this.tracer.systemLog(info.rangeBase, w);
    if (info.error) this.tracer.syntaxError(info);
    return info;
  }

  finish(err: unknown, hasErr: boolean, exitCode: number | null, after?: () => void): void {
    if (this.done) {
      after?.();
      return;
    }
    if (hasErr) {
      try {
        this.debug?.debugger.uncaughtPause(err);
      } catch (e) {
        this.emit({ type: 'runner.error', message: `debugger hook failed in uncaught: ${(e as Error).message}` });
      }
    }
    let extra: Msg = {};
    // the workers' recordings join the main thread's (a worker's uncaught error it reported itself)
    if (this.hub?.beforeFinish(err)) hasErr = false;
    const profile = this.stopProfile();
    if (this.plugins.length) extra = runAfter(this.plugins, this.rawConfig, (message) => this.emit({ type: 'runner.error', message }));
    if (profile) extra.profile = { path: profile };
    const unrecorded = this.unrecorded !== null;
    try {
      if (unrecorded) this.tracer.finishUnrecorded(err, hasErr, this.stepNow());
      else this.tracer.finish(err, hasErr);
    } catch (e) {
      this.emit({ type: 'runner.error', message: `finishing the run failed: ${(e as Error).message}` });
    }
    this.done = true;
    this.exitCode = exitCode;
    this.debug?.finished();
    process.channel?.ref(); // stay alive for `expand` until the next run replaces this child
    api.current = null;
    const stepCount = unrecorded && this.dbgHooks ? this.dbgHooks.count() : (this.hub?.stepsRun() ?? this.tracer.nSteps);
    send({ kind: 'done', exitCode, stepCount, logCount: unrecorded ? 0 : this.tracer.logCount, extra }, after);
  }

  expand(msg: Msg): Msg {
    const { obj, path, loadMore } = this.registry.resolve(msg.valueId, msg.queryPath);
    const lim = msg.limits ?? {};
    const base = this.config.values;
    const limits = { depth: lim.depth ?? base.depth, elements: loadMore ? 100000 : (lim.elements ?? base.elements), stringLength: lim.stringLength ?? base.stringLength };
    const id = String(msg.valueId ?? path.join(' ')).replace(/ \+$/, '');
    const s = new Serializer(limits, { rootKey: path[0] ?? id, registry: this.registry, idPrefix: id });
    const node = s.node(obj, path.length ? path : [id], '', limits.depth, null);
    node.id = id;
    return { type: 'value', node };
  }

  serve(msg: Msg): void {
    const reply = (m: Msg) => send({ kind: 'reply', id: msg.id, msg: m });
    try {
      if (msg.type === 'expand' && this.hub?.owns(msg)) this.hub.expand(msg, reply);
      else if (msg.type === 'expand') reply(this.expand(msg));
      else if (msg.type === 'source') {
        const text = this.sources.get(Number(msg.fileId));
        reply(text === undefined ? { type: 'error', message: `no instrumented source for file ${msg.fileId}` } : { type: 'source', fileId: Number(msg.fileId), instrumentedSource: text });
      } else if (msg.type === 'evaluate') {
        if (!this.done) return reply({ type: 'error', message: 'the program is running; pause it first' });
        evaluateFinished(String(msg.expression ?? ''), (v, name) => this.describe(v, name)).then(
          (d) => reply({ type: 'evaluated', ...d }),
          (e) => reply({ type: 'error', message: (e as Error).message }),
        );
      } else if (msg.type === 'shadow') {
        if (!this.done) return reply({ type: 'error', message: 'the program is running; pause it first' });
        shadowFinished(String(msg.source ?? ''), (v, name) => this.describe(v, name)).then(
          (d) => reply({ type: 'evaluated', ...d }),
          (e) => reply({ type: 'error', message: `${(e as Error).name}: ${(e as Error).message}` }),
        );
      } else if (msg.type === 'complete') {
        if (!this.done) return reply({ type: 'error', message: 'the program is running; pause it first' });
        completeFinished(String(msg.expression ?? ''), msg.limit ? Number(msg.limit) : 100).then(
          (c) => reply({ type: 'completed', ...c }),
          (e) => reply({ type: 'error', message: (e as Error).message }),
        );
      } else if (msg.type === 'exec') {
        reply({ type: 'error', message: this.done ? 'the run has ended; there is no frame to execute in' : 'the program is running; pause it first' });
      } else if (msg.type === 'debug') {
        reply({ type: 'error', message: 'this run has no debugger: start it with config.debug or breakpoints in the run request' });
      } else reply({ type: 'error', message: `unsupported request ${msg.type}` });
    } catch (e) {
      reply({ type: 'error', message: (e as Error).message });
    }
  }

  private serial = 0;

  /** a finished run's value as `{text, valueBag}`, under a fresh `d:N` id `expand` can open */
  describe(value: unknown, name: string) {
    const key = `d:${++this.serial}`;
    return this.tracer ? childDebugHost(this).describe!(value, name, key) : describeFallback(value, name, key);
  }
}

const RESOLVE_CODES = new Set(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT']);
const SIBLINGS: Record<string, string[]> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };
const GUESSES = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];

/**
 * TypeScript's specifiers: `./a.js` that is `a.ts` on disk (what `tsc` with NodeNext asks you to
 * write), and extensionless or directory imports (`./a`, `./dir` for `dir/index.ts`), which
 * bundlers and `tsx` accept, only when Node's own resolution fails. A bare specifier first goes
 * through the nearest tsconfig's `paths` (tsconfig.ts), and through its `baseUrl` when Node finds
 * no package.
 */
function resolveTypeScript(specifier: string, context: any, nextResolve: (s: string, c?: any) => any): any {
  const parent: string | null = context?.parentURL?.startsWith('file:') ? fileURLToPath(context.parentURL) : null;
  // tsconfig `paths` come before node_modules, as tsc and bundlers resolve them
  const cfg = parent && isBare(specifier) && !parent.includes(`${sep}node_modules${sep}`) ? pathConfigFor(dirname(parent)) : null;
  const viaPaths = cfg ? pathCandidates(specifier, cfg) : [];
  const baseUrlCand = cfg?.baseUrl ? viaPaths.pop()! : null;
  for (const c of viaPaths) {
    const f = sourceFileFor(c);
    if (f) return { url: pathToFileURL(f).href, shortCircuit: true };
  }
  try {
    return nextResolve(specifier, context);
  } catch (e) {
    if (!RESOLVE_CODES.has((e as { code?: string }).code ?? '') || !parent) throw e;
    if (baseUrlCand) {
      const f = sourceFileFor(baseUrlCand);
      if (f) return { url: pathToFileURL(f).href, shortCircuit: true };
    }
    if (isBare(specifier)) {
      const viaNodePath = resolveFromNodePath(specifier, context, nextResolve);
      if (viaNodePath) return viaNodePath;
    }
    if (!/^\.{1,2}\//.test(specifier)) throw e;
    const f = sourceFileFor(resolve(dirname(parent), specifier), true);
    if (f) return { url: pathToFileURL(f).href, shortCircuit: true };
    throw e;
  }
}

/**
 * `NODE_PATH` for `import` too: Node honours it only for `require`. The editor's "install only for
 * this file" puts packages in a private `node_modules` and names it here, so an ES module finds
 * them the way a CommonJS one already does.
 */
function resolveFromNodePath(specifier: string, context: any, nextResolve: (s: string, c?: any) => any): any {
  for (const dir of (process.env['NODE_PATH'] ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir || !isAbsolute(dir)) continue;
    try {
      return nextResolve(specifier, { ...context, parentURL: pathToFileURL(join(dir, '_')).href });
    } catch {
      /* not in this one */
    }
  }
  return null;
}

const isBare = (s: string) => !/^(\.{0,2}\/|[a-z][a-z0-9+.-]*:)/i.test(s) && !isBuiltin(s);

/** the file `base` names as TypeScript resolves it: itself, `.js` as `.ts`, extensionless, `dir/index.*` */
function sourceFileFor(base: string, skipSelf = false): string | null {
  const ext = extname(base);
  const cands = [...(skipSelf ? [] : [base]), ...(SIBLINGS[ext] ? SIBLINGS[ext]!.map((x) => base.slice(0, -ext.length) + x) : []), ...GUESSES.map((x) => base + x), ...GUESSES.map((x) => join(base, 'index' + x))];
  for (const c of cands) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {
      /* not this one */
    }
  }
  return null;
}

/**
 * `run.module`: a path, a package's `bin` (the one named like the package, or its only one), or a
 * specifier resolved from `dir` (`exports` with `import`/`node`/`default`, then `main`).
 */
export function resolveModule(name: string, dir: string): string {
  if (name.startsWith('.') || isAbsolute(name)) return resolve(dir, name);
  const req = createRequire(join(dir, 'noop.js'));
  const m = /^((?:@[^/]+\/)?[^/]+)(\/.*)?$/.exec(name);
  if (m && !m[2]) {
    let pkgJson: string | null = null;
    try {
      pkgJson = req.resolve(`${name}/package.json`);
    } catch {
      for (let d = dir; ; d = dirname(d)) {
        const p = join(d, 'node_modules', name, 'package.json');
        if (existsSync(p)) {
          pkgJson = p;
          break;
        }
        if (dirname(d) === d) break;
      }
    }
    if (pkgJson) {
      const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'));
      const base = dirname(pkgJson);
      const short = name.split('/').pop()!;
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && (pkg.bin[short] ?? (Object.keys(pkg.bin).length === 1 ? Object.values(pkg.bin)[0] : undefined));
      if (typeof bin === 'string') return resolve(base, bin);
      const pick = (e: any): string | undefined => (typeof e === 'string' ? e : e && typeof e === 'object' ? (pick(e.node) ?? pick(e.import) ?? pick(e.default) ?? pick(e.require)) : undefined);
      const exp = pkg.exports && (typeof pkg.exports === 'string' || !('.' in pkg.exports) ? pick(pkg.exports) : pick(pkg.exports['.']));
      if (exp) return resolve(base, exp);
    }
  }
  return req.resolve(name);
}

/** the run options an inline config may set; it wins over the host's */
const INLINE_KEYS = new Set(['autoLog', 'logLimit', 'maxConsoleMessages', 'maxLogEntrySize', 'timeoutMs', 'maxTraceSteps', 'maxValueChars', 'resolveGetters', 'libraryCode', 'libraryPackages', 'exclude', 'only', 'plugins', 'secrets', 'hints', 'recordLocals']);

/**
 * Quokka's inline config: `({ autoLog: true, env: { A: '1' }, mode: 'snaps' })` as the main file's
 * first statement sets this run's options (`INLINE_KEYS`), its environment and its mode.
 */
function applyInlineConfig(req: Msg): void {
  const path = req.file?.path;
  if (!path) return;
  let source: string;
  try {
    source = typeof req.file.content === 'string' ? req.file.content : readFileSync(path, 'utf8');
  } catch {
    return;
  }
  if (!source.includes('({')) return; // the cheap test first
  const inline = inlineConfig(source, path);
  if (!inline) return;
  req.config = { ...(req.config ?? {}) };
  for (const [k, v] of Object.entries(inline)) {
    if (INLINE_KEYS.has(k)) req.config[k] = v;
    else if (k === 'env' && v && typeof v === 'object') req.env = { ...(req.env ?? {}), ...(v as Msg) };
    else if (k === 'mode' && (v === 'normal' || v === 'snaps' || v === 'profile')) req.mode = v;
  }
}

class ExitSignal extends Error {
  readonly code: number;
  readonly [EXIT] = true;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

class InstrumentFailure extends Error {}

if (process.send && process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.setSourceMapsEnabled(true);
  const child = new RunChild();
  process.on('message', (msg: Msg) => {
    if (msg?.type === 'run') void child.run(msg.request);
    else if (msg?.type === 'stop') child.finish(undefined, false, null, () => child.realExit(0));
    else if (msg?.type) child.serve(msg);
  });
  process.on('SIGTERM', () => child.finish(undefined, false, null, () => child.realExit(0)));
}
