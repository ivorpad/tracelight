# Tracelight parity map: every Pyokka feature against its Node.js / TypeScript equivalent

> History: the checklist Tracelight was built against while it lived in the Pyokka repository,
> before the split of 2026-10-11. File paths on the Pyokka side point into that repository, not this one.

Tracelight is Pyokka (live values, coverage, Time Machine, frontier debugger, agent CLI) for
JavaScript and TypeScript on Node.js. This file lists every Pyokka feature with its source
file, the Node mechanism or library that replaces it, a difficulty, and the workstream that
owns it. Sources: `README.md`, `docs/PROTOCOL.md`, `docs/HANDOFF.md`,
`skills/pyokka/references/pyokka-cli.md`, `package.json` `contributes`,
`python/pyokka_runtime/**` and `src/**`.

**Legend.** Difficulty: **S** under a day, **M** a few days, **L** a week or more or an open
design problem. Owner: **Core** (this PR: runner, protocol, instrumentation, values, errors,
saved runs, the read-only CLI verbs), **TM** (Time Machine and async stepping), **DBG** (live
debugger, pure evaluate, HTTP record/replay), **UI** (browser UI over WebSocket + Monaco, the
MCP server and the heavier agent analyses), **EXT** (VS Code extension wiring for JS/TS),
**N/A** (Python-only; the JS analogue, when there is one, is in the Node column).
"Reuse" means the TypeScript code in `src/` is language-agnostic and can be lifted as is.

**Baseline.** Node >= 22.15 for the program (first LTS line with `module.registerHooks()` and
`module.stripTypeScriptTypes()`); the CLI and extension host's runtime need 22.18 (they run their
own TypeScript sources with default type stripping), target Node 24 LTS (AsyncLocalStorage on `AsyncContextFrame`,
type stripping on by default). Libraries are pinned to exact versions: `oxc-parser` (ESTree AST
for JS/TS/JSX/TSX, comments with spans), `magic-string` (insert-only edits plus a hires source
map), `@mswjs/interceptors` (http/https `ClientRequest`, `fetch`, XHR), `undici` (only for its
`Dispatcher` hooks when a program imports the npm `undici`). The wire protocol stays
`docs/PROTOCOL.md` with JS-specific additions marked "wire add"; positions stay 1-based lines
and 0-based columns, columns in UTF-16 code units (what VS Code uses).

**As built.** `docs/tracelight/README.md` describes the runtime this branch ships (where it
differs from the plan below, the README wins: one `__tk` object with literal range ids rather
than a per-file base; `ap`/`aw` around awaits; `h` at the head of `catch`; fd 3 for events with
blocking writes, IPC for requests). The rows below keep the plan for what is not built yet.

**Status of the Core rows (this branch).**

- Done: runner and NDJSON protocol (`hello`, `run`, `stop`, `expand`, `source`, `bindings`,
  `shutdown`), child per run with fd 3 events and `output.step`, timeout with `instrumentMs`,
  `stop` with flush, signal deaths; the `module.registerHooks` loader for ESM, CJS and
  TypeScript (strip mode), project files and unsaved buffers; statement steps, header ranges,
  loop iteration steps, coverage-only declarations, expression coverage, function and arrow
  scopes with flag 4, returned values and `raised`, module scopes for imported files, await and
  yield scope hand-back; live comments (`// ?`, `?+`, `?.`, `?.+`, `? $.code`), identifier
  values, `console.*` attribution, Auto Log, markers, logpoints with `{expr}`, timings, Promise
  values; coverage states 0-5 with ignore hints; value nodes, previews, the registry and
  load-more; secrets (value and name provenance); uncaught errors with source-mapped stacks and
  the error path, caught exceptions aggregated with `handledAt`; partial and final traces, the
  step cap with `spentBy`; `tracelight run --save` in Pyokka's saved-run format (Pyokka's agent
  verbs read it); the extension starts JS/TS documents on Tracelight (EXT, minimal).
- Done since: plugins (`before` in the runner, `beforeEach` and `after` in the child, `after`'s
  object merged into `run.finished`); `libraryCode` / `libraryPackages` (import-time library code
  runs quiet) with the relocatable library cache and `tracelight cache`; `exclude` / `only`;
  `mode: "profile"` (the plain program under V8's sampling profiler, a real `.cpuprofile`); snaps
  (`/*{{ ... }}*/` fences run in place, every top-level and snap statement guarded); `resolveGetters`
  (own and class getters, quietly); Quokka's inline config `({ ... })`; the keeper (`run --keep`,
  `release`, `expand`, on Pyokka's wire, so `pyokka expand/release` work too); the `module` launch
  (a package `bin` or a specifier from `cwd`); TypeScript `enum`, `namespace` (dotted too),
  parameter properties, `import = require` and `export =` lowered with columns mapped back to the
  source; JSX/TSX (React's automatic runtime, `@jsxImportSource`, classic `@jsx` pragmas);
  `./a.js` specifiers that are `a.ts` files and extensionless imports; oxc raw transfer for
  parsing. Capabilities: `spawn, expand, source, bindings, markers, logpoints, partialTrace,
  plugins, libraryCode, profile, snaps, module, typescript, jsx, esm, cjs`.
- Core differences worth knowing: snaps run in place (Pyokka runs them after the module body);
  a `const` / `let` declaration in snaps mode is guarded per initializer, so its binding stays the
  module's; `profile` is V8's sampling profile, not a flat one; library files carry no source map
  (insertions never add a line, so stack lines are right; columns map back through a per-line
  table of the insertions, `colMap`);
  the nearest `tsconfig.json` / `jsconfig.json` `paths` and `baseUrl` resolve bare specifiers
  (`extends` followed), in the run's resolve hook (`tsconfig.ts`).
- Moved: the agent verbs stay Pyokka's Python CLI for now (they read Tracelight's saved runs); a
  Node port of them, if wanted, goes with UI and the MCP server. EXT beyond the minimal wiring
  (snippets, New File for JS/TS, hover peek on JS, the panel's JS value syntax) goes with UI.

**Status of the DBG rows (branch `js-debug-eval-replay-mcp`).**

- Done: the live debugger (`config.debug` / `breakpoints`): a worker thread with
  `inspector.Session.connectToMainThread()` reads a control pipe (fd 5) and pauses the main thread
  through a `debugger;` trap in the step hook; `debug` actions `breakpoints` (line and function,
  conditions), `watches` (break on change / when true), `exceptions` (`raised` / `uncaught`,
  uncaught predicted from the user `try` regions because Node's loader catches everything at top
  level), `pause`, `locals`, `continue`, `step` (into / over / out on the recording);
  `debug.paused` / `debug.resumed`; `evaluate` (pure: the `pure.ts` write check, then V8
  `throwOnSideEffect`, then an allowlisted-method rewrite for what V8 refuses, such as
  `toUpperCase`), `complete`, `exec` at a pause; `evaluate` / `complete` against a finished
  run's module scope; watch expressions at a step (`traceContext` window) through the same trap;
  HTTP observe / record / replay (`config.http`, `httpObserve`) on `@mswjs/interceptors` for
  http/https, `fetch` and XHR, in Pyokka's recording format; `tracelight mcp`, the same six tools as
  `pyokka mcp` (a Tracelight run is answered by the Node verbs in-process; a Python run, and a verb
  the Node CLI does not have yet, go to the `pyokka` CLI), and `tracelight run --http`; `shadow`
  (`evaluate.ts` `shadowFinished`: what an edited `console.log(...)`, bare expression or assignment
  would show, from the finished run); an uncaught pause on the frame that raised an async or
  deferred exception after it returned (a snapshot of its bindings; `exec` refused there).
- Done (TM follow-up): `record: false`, the Debugger (`recorder/debugHooks.ts`: `s` is a counter
  increment and an `armed` read, `f`/`x` a per-call id and a shadow stack; only `run.started`,
  `file.instrumented`, `output`, the pauses, the replies, one uncaught `error`, `runner.error` and
  `run.finished`; `console` calls are the program's own `output`); `recordFrom` (`"pause"`,
  `{function}`, `{path, line}`) and the `record` action (scopes for the shadow stack, step 0 with
  flag 4 at an entry, `recordingStarted`, `midRun` on every `trace`, a silent locals baseline from
  each frame's latest getter, a frame suspended at the switch adopted at its next statement);
  coverage over the whole run in a `recordFrom` run. Capabilities `record` and `recordFrom`.
  `bench/record.ts`: 8 to 70 ns per statement under `record: false` against 25 to 135 ns recorded.
- Done (debugger follow-ups): `shadow`; the uncaught pause of an async or deferred exception lands on the
  frame that raised it, from a snapshot of its bindings taken at the first sighting (`evaluate`,
  `complete` and `locals` answer from it, `exec` is refused); a caller frame of a recording pause
  carries its own `fileId` and `line`; the CommonJS wrapper's names are hidden from `locals`;
  worker threads: the main half holds the `NodeWorker` domain (`debug/threads.ts`) and relays each
  worker's inspector session to the debugger worker, so a breakpoint, a step or an uncaught
  exception in a worker pauses that thread (`thread: {name, ident: threadId}`, frame-chain stack,
  `evaluate` / `complete` / `locals` / `exec` in its frames). A worker's files run uninstrumented,
  so its pauses are V8's own and its values are not expandable; function breakpoints, watches and
  the async postmortem stay main-thread only. One pause at a time: a main-thread trap reached
  while a worker is held is let go and comes back as a `pause` at the main thread's next
  statement, because the relay is the main thread's event loop.

- Done (worker threads recorded, `threads/`): each `worker_threads`
  worker preloads the runtime (`--import`), instruments its files with ids and rids from counters
  the threads share (a file both threads load is one file), and records its own trace. Each
  thread's trace is cut into segments at synchronisation points (`postMessage`, a callback after
  another thread moved, `receiveMessageOnPort`, `Atomics.wait`/`notify`) stamped from one shared
  ticket counter, and the segments are merged in ticket order, so every send precedes its receipt
  and nothing is added per statement (a worker's 1M-statement loop records in 47.8 ms against the
  main thread's 47.1). A worker's scopes sit under a `<worker N>` scope (parent the module, depth
  1, `thread: {name, ident}`). The merge is incremental (what went out never moves), so partial
  trace deltas, logs, output and errors go out while workers run, in the merged numbering;
  coverage and timings add up. A worker that is terminated or still running at the end
  is asked for its recording. A value a worker logged (`w<N>|` ids) expands through that worker
  while it lives, from a bounded snapshot after it exits. TM watch windows count main-thread
  statements (`traceContext.mainStep`, sent by the host). The Time Machine's over/out moves now
  use a per-scope step index, so stepping out of a long worker handler is microseconds (it was a
  scan of the handler: p99 5 ms on an 800k-step run). Live debug runs record their workers too:
  every pause carries the merged step (a main pause asks the workers for their recording, a worker
  pause merges the others up to it through a shared cell), and line and function breakpoints and
  step into / over / out work in workers. Stepping there is done by the worker's own step hooks
  (`debugTraps`), because V8's stepOut never stops in a caller that returns through `finally`,
  which every instrumented function does. Not covered: watches (break on change / when true) in
  worker code, which would need an inspector round trip through the main thread per statement,
  and `evaluate` in a worker after the run, whose heap is gone. `eval: true` workers record from a temporary
  file of their code (`worker-eval-N.js`); a nested worker reports to the main thread's hub like any
  other. A worker starts about 0.1 s later than without recording: it loads the runtime from
  sources stripped once and cached (`worker-runtime-<hash>.json`).

**Status of the EXT rows (the extension in JS/TS editors).**

- Done: Value Peek hovers (keywords, `$` names, `#private`, `?.` chains; values fenced as
  JS/TS); snaps discovery, hover, Insert/Delete Snap Output with `/*{{ }}*/` fences (multi-line and
  one-line) and `//» ` output lines, the `snap`/`snapo`/`?` snippets and the output grammar for
  `source.js/ts/tsx/js.jsx`; module-not-found quick install (`Cannot find package/module` →
  `npm install` / `pnpm add` / `yarn add` / `bun add` by lockfile or the `packageManager` field;
  "only for this file" is `npm install --prefix` into a private folder that the runtime reads
  through `NODE_PATH`, for `import` as well as `require`); the Start button and the Time Machine
  palette entries; New JavaScript File / New TypeScript File (File > New, the New File picker,
  snippets opened in their `scope`'s language, recent files reopened in theirs); Select Node.js
  (`pyokka.selectNode`, also what Select Interpreter does in a JS/TS editor) and a restart offer
  when `pyokka.nodePath` changes; Clear Library Cache also clears the JS cache
  (`${ENV}CACHE_DIR`, else `${ENV}HOME/cache`, else `~/.${NAME}/cache`); smart run mode reads JS
  project markers; the panel spells values as JavaScript (`null`,
  `undefined`, `true`, `NaN`, `Name {k: v}`) and colours DETAILS, Compare and the preview as
  JavaScript; the Pyokka debugger type, breakpoints and inline values at a pause cover JS/TS, and
  F5 with no launch.json works in a JS/TS file.
- The Debugger (`record: false`, the default for Debug Current File, the panel's Debug button, the
  URI and the bridge's `debug`) launches Node with the JS runtime for a `.js`/`.ts` program
  (launch attribute `node`, URI `node=`), against the runtime's `record` capability; a runtime
  without it gets a recording debug session instead of an error.
- Also done: `≈` shadow values on edited JS/TS lines (JS statement filter), the Code Story as
  `pyokka-story-js` (rows coloured as TypeScript, walkthrough rows as `//` comments, JSDoc and
  decorators above a function kept in its span), the start view's TypeScript demo
  (`examples/demo.ts`), New TypeScript File and Select Node.js buttons, and the Tour of a JS/TS run,
  built by `pyokka tour` with the workspace's Python (the saved-run format is shared) until a
  TypeScript tour exists.
- Not yet: a Tour that needs no Python (A2.21).
---

## 1. Runtime, runner and protocol messages

### 1a. Process model

| Pyokka feature (source) | Node / TS equivalent | Diff | Owner | Notes |
|---|---|---|---|---|
| Long-lived runner, `python -m pyokka_runtime serve`, NDJSON stdin/stdout (`runner.py`, `protocol.py`) | `node <ext>/dist/runtime/serve.js`; `readline` over stdin, `JSON.stringify` + `\n` on stdout; one runner per Node binary | S | Core | Host side reuse: `src/runtime/runnerClient.ts`, `ndjson.ts`, `shared/protocol.ts` |
| Child per run: `os.fork` on Linux, spawn on macOS/Windows (`forksafety.py`, `PYOKKA_FORK`/`PYOKKA_SPAWN`) | Always `child_process.spawn(process.execPath, ...)`; warm pool: pre-spawn and preload the next child (runtime, oxc, hooks) while idle, hand it the run spec over fd 3 | M | Core | No fork in Node. `child_process.fork` is a spawn too. A `worker_threads` run was rejected: no `process.exit`/`chdir`, a shared heap, native addons not worker-safe |
| macOS objc fork-safety abort, `OBJC_DISABLE_INITIALIZE_FORK_SAFETY` | none needed (spawn only) | - | N/A | Python-only problem |
| `ready.capabilities[0]` = `fork` or `spawn` | always `spawn` (or `spawn-warm`); keep the slot for wire compatibility | S | Core | |
| Child fds 1/2 piped and forwarded as `output` (`runner.py`, `child.py`) | `stdio: ["pipe","pipe","pipe","pipe"]`: 1/2 → `output`, 3 = event pipe, plus a control pipe (fd 4) | S | Core | Spawn mode in Python uses a localhost socket; Node gets extra fds for free |
| `output.step` for Python-level writes (`sys.stdout` wrapper) | wrap `process.stdout.write` / `process.stderr.write` in the child: `step` = the tracer's current step; fd-level writes (native addons, child processes) arrive without it | S | Core | |
| Finished child stays alive to serve `expand`/`evaluate`/`shadow`/`source` (`control.py`) | the run ends at `process.on("beforeExit")` (event loop drained). The child flushes final events, then keeps the control pipe ref'd and serves requests until the next run or `exit` | M | Core | "Finished" means the loop drained. A server never finishes (timeout or stop). New concept: `run.finished` is sent while the child lives on |
| Timeout `timeoutMs`, `instrumentMs` added to the deadline (`runner.py`) | runner-side timer, extended by each `file.instrumented.instrumentMs`; `child.kill("SIGKILL")` | S | Core | |
| Debug runs never on the clock (`Runner.handle_run`) | same rule | S | DBG | |
| `stop` → SIGTERM flush then kill (`child.py` signal handling) | `process.on("SIGTERM")` in the child: `fs.writeSync` of pending trace/coverage on fd 3, then `process.exit`; the runner escalates to SIGKILL after a grace period | S | Core | `beforeExit` does not fire on a signal or `process.exit`. Use the `exit` handler with sync writes only |
| Child killed by a signal → `runner.error` naming it, never re-run (`forksafety.py`) | `child.on("exit", (code, signal))`, same message; SIGSEGV from native addons is the common case | S | Core | |
| `_child --port --token` spawn entry (`__main__.py`, `child.py`) | `node --import <preload> <runtime>/child.js` with fds inherited; no port or token needed | S | Core | |
| Control channel thread from start in debug runs (`control.py`) | debug runs: a worker thread reads the control pipe and talks to the inspector, because the main thread may be paused; normal runs: the main-thread reader after `beforeExit` | M | DBG | |
| Run-child environment: `env`, `cwd`, `argv`, `sys.path[0]` = file dir (`execute.py`) | `spawn(..., {cwd, env})`; `process.argv = [execPath, file, ...argv]`; resolution is relative to the file, so there is nothing like `sys.path` | S | Core | |
| Plugin `before(config)` once per runner in fork mode | runs in each warm child before the run spec arrives (no fork inheritance) | S | Core | |

### 1b. Host → runner requests

| Pyokka feature (source) | Node / TS equivalent | Diff | Owner | Notes |
|---|---|---|---|---|
| `hello` → `ready {pythonVersion, executable, platform, capabilities, runtimeVersion, protocolVersion}` | `ready {nodeVersion, v8Version, executable, platform, capabilities, runtimeVersion, protocolVersion, language: "js"}` | S | Core | wire add: `nodeVersion`, `language`. Keep `pythonVersion` absent |
| `run` (file, content, workspaceRoot, cwd, argv, env, projectFiles, config, markers, expressionsToEvaluate, watch, traceContext, breakpoints, mode) | same request. `file.content` and `projectFiles` become an in-memory override map the `load` hook reads before disk | S | Core | |
| `run.config.logLimit`, `maxConsoleMessages`, `logLimits`, `maxLogEntrySize`, `maxValueChars` | same, in the serializer and log store | S | Core | |
| `run.config.resolveGetters` | when on, the serializer calls accessor `get`s (each guarded by try/catch) | S | Core | |
| `run.config.autoLog` | instrumenter logs declarations, assignments, returns and `if`/`while`/ternary tests | M | Core | |
| `run.config.maxTraceSteps` + cap report (`cap`, `stepsRun`, `spentBy`) | same counters in the step hook | S | Core | |
| `run.config.recordLocals` | see §5 (assignment-site recording) | M | TM | **Done: per-step getter over visible names (`recorder/localsPlan.ts`)** |
| `run.config.libraryCode`, `libraryPackages` | instrument `node_modules/**` (never `node:` builtins); package-name and dotted-glob filter on the package dir | M | Core | |
| `run.config.exclude` / `only` | `resolve` hook tags the URL; `load` skips instrumentation; patterns are package names, path globs and bare names | S | Core | |
| `run.config.hints.ignoreCoverage` / `ignoreCoverageForFile` | same regexes over oxc comments; defaults add `istanbul ignore next`, `c8 ignore next`, `v8 ignore next` | S | Core | |
| `run.config.plugins` | ESM modules exporting `before`, `beforeEach`, `after` (§8) | S | Core | |
| `run.config.secrets {mask, names}` | §3 | M | Core | |
| `run.config.http`, `httpObserve` | §7 | L | DBG | |
| `run.config.debug`, `record`, `stopOnEntry`, `breakOnException`, `recordFrom` | §6 | L | DBG | Done |
| `run.mode: normal / profile / snaps` | §2 (snaps), §8 (profile) | M | Core | |
| `run.module` (python -m launch, `module_run.py`) | `module: "pkg"` or `"pkg/sub"`: resolve with `import.meta.resolve` / `require.resolve` from `cwd` (package `exports`/`main`, or a `bin` entry); run it as the entry; `process.argv[1]` = resolved file | M | DBG | Closest JS analogues: an npm `bin`, or `node -e "import('pkg')"`. An npm-script launch is a separate open question |
| `module` and `file` together → `runner.error`, module wins | same | S | DBG | |
| `expand {runId, valueId, queryPath, limits}` + `loadActionNode` (`id + " +"`, 100k elements) | same, over the child's registry (`Map<id, object>`, strong refs until the next run) | S | Core | |
| `evaluate {expression, frameId?}`: pure against finished `__main__` or the paused frame (`pure.py`) | finished: a module-scope closure `__tk.mod(fileId, (s) => eval(s))` injected at the top of the main module, called after a static purity check (port of `pure.py` over the oxc AST), and through a same-thread `inspector.Session` with `Runtime.callFunctionOn(..., throwOnSideEffect: true)`. Paused: `Debugger.evaluateOnCallFrame({throwOnSideEffect: true})` from the worker session | L | DBG | V8 side-effect mode would allow side-effect-free user functions. Pyokka refuses every user function, so keep the static rule as the contract and V8's check as the backstop (it also blocks getters with side effects, which Pyokka would run) |
| `exec {source, frameId?}` → `executed {text, valueBag?, modified, exception?}` (`dbgexec.py`) | `Debugger.evaluateOnCallFrame` without `throwOnSideEffect`. Writes to existing `let`/`var`/params land in the frame; `const` refuses; a new declaration stays in eval scope (the analogue of a "brand-new name"). The value of the last expression is the REPL result | M | DBG | Replaces `PyFrame_LocalsToFast` (3.12) and PEP 667 (3.13). Multi-statement blocks work. Top-level `await` needs `replMode: true` (V8 option on `Runtime.evaluate`; at a call frame use `awaitPromise` on an async IIFE) |
| `complete {expression, limit, frameId}` (`complete.py`) | paused: `Debugger.evaluateOnCallFrame` for the object before the dot, then `Runtime.getProperties({ownProperties: false, accessorPropertiesOnly: false})` up the prototype chain. Kinds come from property descriptors; a getter is never invoked, which is `inspect.getattr_static`'s job in Python. Bare prefix: names from the call frame's `scopeChain` (local, block, closure, module, script, global), plus JS keywords. Finished: the module closure and a static name list from the AST | M | DBG | |
| `shadow {source}`: what an edited statement would show (`tracer` + `features/shadowValues.ts`) | the same pure evaluate on the parsed edited statement: `console.log(a, b)` → log rendering, `x = expr` / `const x = expr` → value; no mutation | M | DBG | |
| `source {fileId}` → instrumented source (library files omitted from `file.instrumented`) | same; the child keeps the instrumented text per fileId | S | Core | |
| `bindings {source}` → per-statement assigns/reads/loop/calls (`bindings.py`) | oxc walk: declarators and assignment targets (incl. destructuring), update expressions, `for` heads, `function` params; reads = Identifier references not shadowed (a small scope walker); calls = source text of `CallExpression`/`NewExpression` | M | Core | Better: emit these tables in `file.instrumented` (wire add `bindings`), so hosts and the CLI never parse JS |
| `debug {action: breakpoints / watches / exceptions / pause / locals / continue / step / record}` | §6 | L | DBG | |
| `stop {runId}` | kill the child (SIGTERM then SIGKILL); final `run.finished {stopped: true}` | S | Core | |
| `shutdown` | `process.exit(0)` after the children are killed | S | Core | |

### 1c. Runner → host run events

| Pyokka feature (source) | Node / TS equivalent | Diff | Owner | Notes |
|---|---|---|---|---|
| `run.started {pid}` | `child.pid` | S | Core | |
| `file.instrumented {fileId, path, rangeBase, ranges, statements, functions, magic, instrumentedSource?, instrumentMs?}` | emitted from the `load` hook after instrumenting; `path` = real path from `fileURLToPath`; `functions[].name` inferred (declaration name, `Class.method`, `const f = () =>`) | S | Core | wire add: `language: "js"/"ts"/"jsx"/"tsx"`, `moduleKind: "esm"/"cjs"`, optional `bindings`, `decisions` |
| `output {stream, text, step?}` | §1a | S | Core | |
| `log {logId, kind, fileId, rid, hit, step, context, text, runtimeKey, changeId, markerId, valueBag}` (kinds log, value, autoLog, autoExpand, time, logpoint, system, error) | same; `print` → `console.*` (§2) | S | Core | |
| `error {fileId, rid, step, message, errorType, stack, handled, handledAt?, count?, lastStep?, traceback?}` | §4 | M | Core | |
| `coverage {fileId, states, hits}` (0..5) | same; states computed from hits and `c` hits | S | Core | |
| `time {rid, n, total, min, max}` + 250 ms flush | `performance.now()` deltas; a `setInterval` flush timer `unref()`'d so it never keeps a run alive | S | Core | |
| `trace {steps: base64(Int32Array quads), scopes, truncated}` + `partial` deltas each second + `midRun` + cap fields | `Int32Array` grown by doubling; `Buffer.from(arr.buffer, 0, n*16).toString("base64")` (little-endian, same as Python `array("i")`); delta timer `unref()`'d | S | Core | TM consumes it; `src/timeMachine/traceModel.ts` reuse |
| Scope `returned`, `returnedTruncated`, `returnedLength`, `raised` | from the exit hook (§2 return values) | S | Core | |
| `locals {entries: [{step, scopeId, changes}]}` | §5 | M | TM | **Done (`recorder/recorder.ts`)** |
| `watch {watchId, step, valueBag / error}` for `traceContext.step .. +prefetch` | §5 | M | TM | |
| `debug.paused` (both stack shapes, `reason`, `kind`, `breakpoint`, `conditionError`, `watch`, `exception`, `recordingStarted`, `thread`, `modified`) | §6; `thread` = `{name: "main", ident: 0}`, a worker's `{name, ident: threadId}` | L | DBG | |
| `debug.resumed {step, action, kind?}` | same | S | DBG | |
| `http.exchange {n, client, method, url, status, reason, bytes, ms, recordedMs?, source, rid, step}` | §7; `client` ∈ `fetch`, `undici`, `http`, `https` (plus `axios`/`got` when attributed) | M | DBG | |
| `run.finished {exitCode, durationMs, timedOut, stopped, stepCount, logCount, profile?, replayed?, http?}` | same; `exitCode` from `process.exitCode` / an uncaught error (1) / `process.exit(n)` (patched to flush first) | S | Core | |
| `runner.error {message, detail?}` | same | S | Core | |
| Typed replies `value`, `evaluated`, `executed`, `completed`, `source`, `bindings`, `debug.result` and their `.error` twins | same | S | Core | |
| Step flags 1 log, 2 raised here, 4 scope entry, 8 no code mapping, 16 unwinding | same | S | Core | |
| `src/shared/protocol.ts` types | reuse, add the JS fields | S | Core | |

---

## 2. Instrumentation

| Pyokka feature (source) | Node / TS equivalent | Diff | Owner | Notes |
|---|---|---|---|---|
| AST rewrite compiled with original positions, so tracebacks and `f_lineno` stay true (`instrument.py`, `rewrite.py`) | `oxc-parser` AST plus `magic-string` insert-only edits (`appendLeft`/`prependRight`, never `overwrite` of user tokens). An inline `//# sourceMappingURL=data:` from `generateMap({hires: true, includeContent: true})`; `process.setSourceMapsEnabled(true)` in the child so `err.stack` maps back; our own `SourceMap` (`node:module`) for mapping inspector positions | M | Core | JS cannot compile with fake positions; the source map is the replacement. Check that oxc spans are UTF-16 offsets in the pinned npm binding, and convert from UTF-8 if not |
| Import hook `_Finder` first on `sys.meta_path` (`execute.py`) | `module.registerHooks({resolve, load})` (sync, in-thread, both CJS `require` and ESM `import`) installed by `--import <preload>`; `load` returns `{format, source, shortCircuit}` | M | Core | Node >= 22.15 / 23.5. The async `module.register()` worker hooks were rejected: off-thread, and they miss `require` on older lines |
| TypeScript | `module.stripTypeScriptTypes(src, {mode: "strip"})` after instrumentation (whitespace blank-out keeps offsets, so our map stays exact); `mode: "transform", sourceMap: true` for enums, namespaces and parameter properties, with maps composed; TSX/JSX: oxc-transform (or esbuild) for JSX, map chained | M | Core | API since 22.13 / 23.2 (experimental). The `--experimental-strip-types` flag is 22.6+. `tsconfig` paths and `.js`→`.ts` specifier rewriting go in the `resolve` hook |
| ESM vs CJS | format from `package.json` `type` / extension (`.mjs`/`.cjs`/`.mts`/`.cts`); hooks only use statement-level inserts legal in both; ESM `import`/`export` declarations are never wrapped or preceded by code that would break hoisting semantics | M | Core | |
| Hooks as builtins `_pk_s`, `_pk_c`, `_pk_f`, `_pk_x`, `_pk_v`, `_pk_t`, `_pk_print`, `_pk_logpoint`, `_pk_time`, `_pk_snap_error`, `_pk_u`, `_pk_end`, `_pk_scope_` (`instrument.py`) | `globalThis.__tk` (non-enumerable, frozen) with the same members; per-file `const __tk_b = __tk.base(N)`; per-function `const __tk_sc = __tk.f(__tk_b+r)` and `let __tk_rv = __tk.U` | S | Core | `_pk_` vs `__pk_` (Python name mangling): N/A. `__tk_` names cannot collide with user code in practice; reserve the prefix |
| Directive prologue / `__future__` / docstring kept first (`spans.is_future_import`, `is_docstring`) | inserts go after `"use strict"` / `"use client"` directives; a shebang line stays line 1 | S | Core | |
| Statement step `_pk_s(rid[, scope])` | `__tk.s(__tk_b+n, __tk_sc)` before each statement. Braceless bodies (`if (a) x();`, `for (...) x();`, `else x()`) are wrapped in `{}`. Labels: insert before the label, not between label and loop. `case` consequents: before each statement in the consequent | M | Core | Passing the scope explicitly, as Python already does, means steps need no global "current scope" |
| Compound statements get a header range (`spans.py`) | `if (test)`, `for (init; test; update)`, `for (x of xs)`, `while (t)`, `do … while (t)` (the step goes on the `while` test), `switch (d)`, `try`, `with` (sloppy only); ranges are the header only | S | Core | |
| `def` / `class` statements and class bodies are never steps (HANDOFF decision) | `function` declarations, `class` declarations, class bodies, TS `type`/`interface`/`declare`, ESM `import`/`export ... from` are never steps. Class field initializers and `static {}` blocks: open question | S | Core | `require()` statements are ordinary steps |
| Loop header one step per iteration | step before the body runs (`for`/`for-of`/`for-in`/`while`: first body statement preceded by a header step `__tk.s(headerRid)`); `do-while` test via a comma in the test `(__tk.s(r), test)` | M | Core | |
| Function entry `_pk_f(rid)` flag 4 on the `def` header | body prologue `const __tk_sc = __tk.f(rid)`; arrow expression bodies `x => e` → `x => { const __tk_sc = __tk.f(r); try { return (__tk_rv = e) } finally { __tk.x(__tk_sc, __tk_rv) } }`; methods, getters/setters, constructors (after `super()` is not needed: the prologue reads no `this`) | M | Core | Must not change `arguments`, `this`, `new.target`, `super` (none are touched). Generators and async functions: the prologue runs at call time for async, at first `next()` for generators (as in Python) |
| Exit `_pk_x(_pk_scope_, _pk_rv_)` in a `finally` | `try { body } catch (e) { __tk.ux(__tk_sc, e); throw e } finally { __tk.x(__tk_sc, __tk_rv) }`; module bodies: CJS wrapper body / ESM top level get exit at `beforeExit` (ESM `export` cannot sit inside `try`) | M | Core | The added `catch` rethrows the same value, so behaviour is unchanged |
| Lambda entry `(_pk_f(rid), body)[1]`, exit inferred | arrow expression bodies are converted to block bodies as above (exact exit); no inference needed | S | Core | |
| Return values `_pk_rv_ = _pk_u`, `return (_pk_rv_ := value)`, bare return → `None`, end → `_pk_end` (`returns.py`) | `let __tk_rv = __tk.U`; `return (__tk_rv = value)`; bare `return;` → `__tk_rv = undefined; return;`; the end of the body sets `__tk_rv = __tk.END`; async: the awaited value (`return await x` already resolved), generator `return v` likewise | S | Core | A `finally` that returns again wins, as in Python |
| Expression coverage `(_pk_c(rid), expr)[1]` for and/or, ternary, comprehension parts (`rewrite.py`) | `(__tk.c(r), expr)` on the right operand of `&&`, `\|\|`, `??`, both ternary arms, default param values, `?.` (only whole chains), logical assignments `&&=` / `\|\|=` / `??=` (on the right side) | M | Core | Never wrap `delete` operands, `typeof ident` (ReferenceError), assignment targets, callees (`this` loss), `super`, tagged-template tags or optional-chain links |
| Coverage states 0 not run, 1 covered, 2 partial, 3 error source, 4 error path, 5 ignored | same computation | S | Core | |
| Range ids global across files via `rangeBase`, source order (`instrument.py` pre-pass) | `__tk.base(fileId)` returns the run's base, so file text is base-independent | S | Core | |
| `instrumentedSource` (omitted for library files), `instrumentMs` | same | S | Core | |
| Scope parents: `_pk_f` reads the caller's `_pk_scope_` up to 4 `f_back` frames; module ends the walk; loop-resumed tasks and thread targets get module (`tracer.py` `PARENT_FRAMES`) | shadow stack: parent = top of `__tk.stack` at entry (empty → module scope of the entry file, or of the importing module for imported files). Sync callbacks via uninstrumented code (`arr.map(cb)`, decorators, `sort(compare)`) still see the caller on top | M | TM | **Done: frame chain in `recorder/recorder.ts`, repaired at the next statement, swept by a microtask**. No frame introspection in JS (`Error.stack` is text and slow). Cheaper than Python's walk |
| Gathered coroutines side by side, never nested (PROTOCOL `trace` notes) | JS calls `a()` and `b()` synchronously from the caller of `Promise.all([a(), b()])`, so their parent is the caller (not module); steps after their first `await` run in microtasks but keep the parent fixed at creation | M | TM | **Done, tested (interleaving and fuzz)**. Semantic difference: in JS the tasks nest under the caller, which is closer to the code. Step Over a `Promise.all` still skips them, since they are descendants. Document it |
| Async suspension: Python frames carry `_pk_scope_`; a resumed frame's statements carry their scope | `await e` → `__tk.rs(__tk_sc, await __tk.aw(__tk_sc, e))`: `aw` pops this scope (restoring the caller on the shadow stack), `rs` pushes it on resume; same for `yield`, `yield*`, `for await` (the head step after each `next()`) | L | TM | **Done: a resume without `aw` (rejected await, `for await`, `gen.throw`) is repaired at the frame's next step**. Exceptions out of an `await` must restore the stack (`rs` in the catch path too); top-level `await` in ESM likewise |
| Callbacks entered from the event loop (timers, I/O, promise reactions, EventEmitter): parent = module | empty shadow stack → module (same rule). Optional: `AsyncLocalStorage` (Node 24 `AsyncContextFrame`) storing the scope that scheduled the callback, as a `scheduledBy` field (wire add) | M | TM | **Done: module parent, the scheduling scope as `asyncParent`; AsyncLocalStorage also attributes hookless output and logs** |
| Threads: each thread's target has the module as parent | `worker_threads`: preload via `execArgv`, hooks per isolate, scopes tagged with `thread`; segments merged by a shared ticket clock at synchronisation points; the worker's scope has the module as parent | L | TM | Done (`threads/`), `eval` and nested workers included; not in live debug runs |
| Library code (`libraryCode`): module body coverage-only via `_pk_f(<module rid>)` / `_pk_x` quiet mode (`tracer.py` `LIB_MODULE`) | CJS: wrap the module body (`__tk.lq(r); try { ... } finally { __tk.lx(r) }`, legal inside the CJS wrapper); ESM: `__tk.lq` as the first statement and `__tk.lx` as the last, plus a `load`-hook-tracked fallback in case evaluation throws (the next stepped statement outside the module ends quiet mode) | L | Core | ESM evaluation completion is not observable from hooks; top-level `await` in a library module can interleave. Risk |
| Library file cache, keyed by version, bytecode magic, real path, mtime, size, options; code object relocated (`cache.py`, `instrument.relocate`) | `$TRACELIGHT_HOME/cache/<sha>.js` + `.map`, keyed by tracelight version, `process.versions.v8`, real path, mtime, size, options; no relocation (base is a runtime value); optional V8 code cache via `module.enableCompileCache()` (22.1+) | S | Core | 30-day sweep, `cache --clear` same |
| `PYOKKA_CACHE_DIR` (empty disables), `PYOKKA_HOME` | `TRACELIGHT_CACHE_DIR`, `TRACELIGHT_HOME` (`~/.tracelight`) | S | Core | |
| Stdlib never instrumented | `node:` builtins cannot be (they are in the snapshot); never instrument `node:*` | - | N/A | |
| Library detection `site-packages`/`dist-packages` (`walkthroughShared.ts`, `moments.py`) | a path with a `node_modules/` segment; package = the dir after the last `node_modules/` (`@scope/name` aware); workspace packages (pnpm/yarn workspaces, symlinks) count as project | S | Core | Real path vs symlink path matters with pnpm |
| Unsaved project buffers (`projectFiles`) | `load` hook reads the override map before `fs` | S | Core | |
| Live comments `# ?`, `# ?+`, `# ?.`, `# ?.+`/`# ?+.`, `# ? $.code` found with `tokenize` (`magic.py`) | Quokka's own syntax: `//?`, `/*?*/`, `//?+`, `//?.`, `//?.+`, `//? $.code`, `/*? $.x */`; comments come from oxc `comments` (never inside strings or templates); attach to the expression ending before the comment (port of `spans.attach_to_line`) | S | Core | Back to the Quokka.js original. `/*?*/` can target a sub-expression mid-line, which Python cannot |
| `$` code parsed as an expression (`magic.parse_dollar_code`) | oxc `parseSync` of the text wrapped `($ => (<code>))`; a non-expression is an ordinary comment | S | Core | |
| Third-party files honour no live comments | same | S | Core | |
| Identifier alone on a line shows its value | `ExpressionStatement` whose expression is an `Identifier` or member chain without calls | S | Core | |
| `print()` attribution, `file=sys.stderr` → context `stderr`, other `file=` pass through, not echoed (`logs.py`, `_pk_print`) | rewrite literal `console.log/info/debug/warn/error/trace/table/dir(...)` call sites in instrumented files to `__tk.print(rid, "<method>", ...)`; `warn`/`error` → context `stderr`; also patch the global `console` methods (attributed to the current step) for aliased and library calls; `process.stdout.write` stays `output` | M | Core | `console.table`/`dir` render specially; format strings (`%s`, `%o`) use `util.format` semantics, our own implementation, no `inspect` |
| Auto Log (assignments, returns, conditions) | `const/let/var` declarators, assignment expressions at statement level, `return` arguments, `if`/`while` tests, ternary tests | M | Core | |
| Markers `value` / `time` / `logpoint`, `autoExpand`, `exp`, `context`, `changeId` (`run.markers`) | same; a marker range is mapped to the covering expression by span (`spans.find_covering`) | S | Core | |
| Logpoints with `{expr}` interpolation `_pk_logpoint`, `is_expr`, def-line logpoints `<rid>:<param>` | each `{expr}` parsed at instrumentation and compiled into a closure `__tk.lp(rid, ..., () => [e1, e2])` (lexical access, no `eval`); a parse failure becomes an `error` log; on a function line: log params at entry | M | Core | Closures avoid the deopt that direct `eval` causes |
| Timing `_pk_t(rid, ctx, t0, value, ...)`, aggregates and 250 ms flush | `(__tk_t0 = performance.now(), __tk.t(rid, ..., __tk_t0, expr))`; a Promise value: timed to settlement (option) | S | Core | |
| Awaitables: coroutine run to completion (`asyncio.run` or the running loop), Tasks logged on completion, a named coroutine left alone (`logs.py`) | a logged thenable is logged as `Promise {<pending>}` at once, then re-logged with the resolved/rejected value on settle (Quokka behaviour); no event loop to start | S | Core | Simpler than Python |
| Snaps mode: `"""{{ ... }}"""` fences, each top-level and snap statement in its own try/except, `_pk_snap_error` (`magic.extract_snaps`, `instrument.py`) | fence = a block comment `/*{{ ... }}*/` or a template-literal statement `` `{{ ... }}` `` (open question); each statement wrapped `try { ... } catch (e) { __tk.snapErr(e, rid) }`. `let`/`const`/`class` declarations must be hoisted out of the `try` (declare before, assign inside) or later statements lose the binding | M | Core | Block scoping is the JS-specific trap |
| Coverage-ignore hints on a compound statement ignore the block; file hint | same; also `/* istanbul ignore next */`, `/* c8 ignore next/start/stop */` | S | Core | |
| Inline config: a dict literal as the first statement, stripped, not applied (`magic.inline_config`) | Quokka's form: a parenthesised object literal first statement `({ ... })`; strip it; apply it (Pyokka does not yet) | S | Core | |
| `magic: [{rid, kind}]` in `file.instrumented` | same | S | Core | |
| `functions: [{rid, name, bodyRange}]` | names: declaration id, `obj.method`, `Class.method`, `Class.prototype.method`, `const f = function/arrow`, `export default function`; anonymous → `<anonymous@L:C>` | S | Core | |
| Partial trace deltas each second (`TRACE_FLUSH_S`) | `setInterval(..., 1000).unref()`; a busy synchronous loop starves timers, so also flush from the step hook every N steps when `performance.now()` passed the deadline | S | Core | JS-specific: a timer cannot preempt sync code |
| `--instrumented` CLI flag: print the instrumented source | same | S | Core | |
| `__annotate__` NotImplementedError ignore (3.14) | - | - | N/A | Python 3.14 annotation protocol |

---

## 3. Values, serialization, expand, secrets, redaction

| Pyokka feature (source) | Node / TS equivalent | Diff | Owner | Notes |
|---|---|---|---|---|
| Value node schema (`type, value, length, capped, cappedProps, cappedElements, props, id, queryPath, expressionPath, expandable, circular, nan, positiveInfinity, negativeInfinity, loadActionNode, secret`) (`serialize.py`) | same schema; `type` values: `string number bigint boolean undefined null symbol array object function class Map Set WeakMap WeakSet Date RegExp Error Promise ArrayBuffer TypedArray Buffer Proxy <ClassName>`; add `negativeZero` | M | Core | wire add: the JS type names; webview `format.ts` needs JS renderings |
| Attribute discovery via `__dict__`/`__slots__` only, never `dir()`/`getattr()` | `Reflect.ownKeys` + `Object.getOwnPropertyDescriptor`: data properties are read; accessors are shown as `(getter)` unless `resolveGetters`; symbol keys as `[Symbol(x)]`; non-enumerable hidden by default | M | Core | A custom serializer that never calls `util.inspect` (it runs `[util.inspect.custom]` and user `toString`/`toJSON`) |
| Proxies (no Python analogue) | `util.types.isProxy(v)` first; a proxy is shown as `Proxy` and not introspected (`ownKeys` would run traps), unless `resolveGetters` | S | Core | |
| Map/Set/WeakMap entries, Promise state, internal slots | Map/Set via their iterators (built-in methods, safe unless the prototype was patched: use the captured `Map.prototype.entries`). WeakMap/WeakSet contents and `[[PromiseState]]`: only through the inspector `Runtime.getProperties` (`internalProperties`) on a same-thread session in the finished child; otherwise `<unknown>` | M | Core | |
| Cycles along the current path (`circular: true`) | path stack `Set` | S | Core | |
| Strings capped (`capped: "first N chars"`), containers capped, load-more node `id + " +"` | same | S | Core | |
| `expressionsToEvaluate` query-path trees force expansion (`runtimeKey → queryPath`) | same | S | Core | |
| `child_by_segment` walks `queryPath` without `dir()` (`values.py`) | segments `_p_<name>` / `_p_<index>` / Map key ids; read via own data descriptors | S | Core | |
| `short_repr`: one-line bounded rendering (`values.py`) | own JS-literal renderer: `{ a: 1, b: 'x' }`, `[ 1, 2 ]`, `Map(2) { 'a' => 1 }`, `Foo { x: 1 }`, `[Function: f]`, `[class A]`, `2n`, `Symbol(x)` (Quokka/`util.inspect` look, without running user code) | M | Core | |
| `…(+N chars)` / `…(cut)` marks, `truncated`/`length` (`values.value_text`, `cut_entry`) | same; "repr not a builtin's" ⇒ class instances with a user `toString`/`[Symbol.toPrimitive]` are rendered structurally, so the length is always known | S | Core | |
| `Registry` keeps logged objects for `expand` | `Map<number, object>`, id from a `WeakMap<object, number>` serial (no `id()` in JS) | S | Core | |
| Locals change marker `(id(value), len(value))` | `WeakMap` identity + length/size for arrays, Maps, Sets; see §5 for the assignment-site fix | S | TM | **Done: `Object.is` plus length/size** |
| `resolveGetters` | invoke `get` with try/catch, with a timeout guard impossible for sync code; document it | S | Core | |
| Secrets, value provenance: env vars with secret names and ≥8 chars are replaced everywhere, `os.environ` re-scanned on size change (`secrets.py`) | scan `process.env` at start and when `Object.keys(process.env).length` changes (checked at each event flush, not per value); `process.loadEnvFile()`, `--env-file` and `dotenv` all write `process.env`, so they are caught | S | Core | |
| Secrets, name provenance: str/bytes under secret names (attrs, dict keys, kwargs inside reprs, hovered/watched expressions, locals) | string/Buffer/Uint8Array values under secret-looking keys (camelCase splitting is already in the rule: `apiKey`, `accessToken`, `clientSecret`); object literal text inside renderings | S | Core | |
| Secret word list, bare `key` excluded, `config.secrets.names` | same list; consider adding `jwt`, `cookie` | S | Core | |
| `secret: true` nodes, `••••••••`, trace never scanned | same | S | Core | |
| `secrets.current.scrub` for HTTP bodies and headers | same function, used by §7 | S | DBG | |
| Redaction of agent-facing output (`redact.py`, `src/util/redact.ts`, fixture `redact.json`) | reuse `src/util/redact.ts` as is; the CLI becomes TS, so one implementation | S | Core | |
| `valueText.ts` Python-flavoured multi-line rendering (Compare, Copy Data), `webview/format.ts` | JS-flavoured renderer | S | EXT | |
| `reprs.py`: parse a recorded repr back into type and literal (for `origin`) | parse the JS rendering with oxc as an expression (object/array literals parse directly; `Map(2) {…}` and `Foo {…}` need a small grammar) | M | UI | |
| Value table for list of dicts in DETAILS (`webview/valueTable.ts`) | agnostic | S | UI | |

---

## 4. Errors and caught-exception tracking

| Pyokka feature (source) | Node / TS equivalent | Diff | Owner | Notes |
|---|---|---|---|---|
| `sys.monitoring` tool id 3: RAISE, EXCEPTION_HANDLED, RERAISE, filtered by `co_filename` (`errors.py`) | no engine hook for throw/catch outside the inspector. Instrument instead: `throw x` → `throw __tk.th(rid, x)` (origin), the head of every `catch (e)` → `__tk.cx(tryRid, e)` (tentative handler), a rethrow of the same object clears it (as RERAISE does), and the function wrapper's `catch` (`__tk.ux`) sees unwinding | M | Core | `Debugger.setPauseOnExceptions("all")` would see every throw, but each one is a pause (far too slow). Not used for recording |
| Origin = first sighting of an exception object (flag 2); later sightings = unwinding path (flag 16) | `WeakSet` of seen error objects (primitives thrown, such as `throw "x"`, are keyed by value plus step); first sighting in `th`, or in `ux` for engine/library throws (`TypeError` from `undefined.x`, `JSON.parse`), attributed to the scope's last step rid | M | Core | JS throws arbitrary values: `errorType` = `e?.constructor?.name ?? typeof e` |
| Uncaught: `handled: false` with `traceback` (last 4000 chars) | `process.on("uncaughtException")` and `process.on("unhandledRejection")` in the child: emit, flush, exit 1 (Node's default for both since v15); traceback = source-mapped `err.stack` (+ `cause` chain, `AggregateError.errors`) | S | Core | Promise rejections are the JS-specific uncaught path |
| `stack: [{fileId, line, col, rid?, function, path}]`, `fileId: 0` outside instrumented files | `Error.captureStackTrace` + a scoped `Error.prepareStackTrace` reading `CallSite`s (`getFileName`, `getLineNumber`, `getColumnNumber`, `getFunctionName`, `getTypeName`, `isAsync`), mapped through our source maps; async frames from V8 zero-cost async stack traces | M | Core | `--enable-source-maps` wraps `prepareStackTrace`; map positions ourselves to avoid fighting it |
| `handledAt {fileId, line, rid, function, broad}`: the `except` clause, or the `with` whose `__exit__` swallowed it | `catch` clause line, `rid` of the owning `try`; `.catch(fn)` / `then(_, fn)` / `Promise.allSettled` handlers are user functions or library code. A `.catch(handler)` call site in user code can be rewritten to tag the handler (optional); otherwise "caught outside stepped code" | M | Core | No `with`/`__exit__` in JS. `using`/`await using` (explicit resource management, Node 24) do not suppress errors either |
| `broad`: bare `except:` or `except Exception/BaseException` | every JS `catch` is untyped. Define broad as a `catch` body that neither rethrows on some path nor tests the error (`instanceof`, `.name`, `.code`, `.status`); also `catch {}` without a binding; `.catch(() => {})` | M | Core | A JS-specific definition; document it in PROTOCOL |
| Tentative handler cleared by RERAISE/RAISE of the same object; matching clause chosen by the first step after the event | `cx` marks tentative; a later `th`/`ux` of the same object in the same scope clears it; JS has one clause per `try`, so there is no clause choice | S | Core | |
| Aggregation per (`errorType`, origin rid, handler rid), `count`, `step`, `lastStep`, cap 50 groups | same | S | Core | |
| Exceptions handled inside library files never emitted; library → user caught are | same rule on `node_modules` paths | S | Core | |
| SyntaxError in the scratch file → `errorType: "SyntaxError"`, `rid = rangeBase` | oxc `errors[]` (recoverable parse with positions); emit before running | S | Core | |
| `SystemExit`, `KeyboardInterrupt`, `StopIteration`, `GeneratorExit` special cases | `process.exit(n)` (patched: flush, then exit; not an error), SIGINT (exit 130, `stopped`), `AbortError` from `AbortSignal` is an ordinary error | S | Core | |
| `ModuleNotFoundError` → quick package install | `ERR_MODULE_NOT_FOUND` / `MODULE_NOT_FOUND` codes, specifier in the message | S | EXT | |
| Exceptions report builder (`agent/exceptions.py`, `src/session/exceptionReport.ts`, fixture) | reuse `exceptionReport.ts` | S | Core | |

---

## 5. Time Machine, trace, locals, watches

| Pyokka feature (source) | Node / TS equivalent | Diff | Owner | Notes |
|---|---|---|---|---|
| Navigation model over step quads: into/over/out/back/backOver/backOut by parent chain (`src/timeMachine/traceModel.ts`, `trace.py`, fixture `trace-moves.json`) | reuse `traceModel.ts` | S | TM | Language-agnostic |
| Time Machine controller: commands, auto play, run to line/breakpoint, call stack, edit-and-continue, code preview (`timeMachine/navigator.ts`) | reuse | S | TM | |
| Re-anchor after an edit by statement text + occurrence (`timeMachine/reanchor.ts`) | reuse; the normalisation strips JS comments (`//`, `/* */`) instead of `#` | S | TM | |
| Partial trace assembly (`session/traceDelta.ts`) | reuse | S | TM | |
| Replay debug session (Call Stack, Variables at step, Watch, `stepBack`, `reverseContinue`) (`debug/replaySession.ts`, `dapReplay.ts`, `session/replayFrames.ts`) | reuse; debugger type `tracelight` | S | TM | |
| Evaluate in replay answers recorded names and `.attr` / `[0]` / `['k']` (`replayFrames.ts`) | reuse; JS member syntax is the same | S | TM | |
| Values as of the step, `×N` hit prefix, `timeMachine.inlineValues` modes (`session/valuesAsOf.ts`, `decorations/decorator.ts`) | reuse | S | TM | |
| Auto Log switched on while navigating (`timeMachine.autoLog`) | reuse (re-run with autoLog) | S | TM | |
| Step strip, timeline, function colours, echo, code preview, truncated mark (`webview/timeline.ts`) | reuse | S | UI | |
| Watch expressions at a step with a 10-step prefetch (`traceContext`, `watch` events, `timeMachine/watches.ts`) | runtime: a re-run where the step hook, for steps in the window, evaluates watches in the stepping frame. Two options: (a) the hook runs `debugger;` and the worker evaluates via `Debugger.evaluateOnCallFrame` on frame 1 (pure, `throwOnSideEffect`), cheap because the window is about 10 steps; (b) instrument with a per-function `(s) => eval(s)` closure passed to the step hook (deopts every function: rejected) | M | TM | Prefer (a): it shares the DBG pause path |
| Watch sources: paused frame at the frontier, finished child at the last step, recorded variables behind, "not recorded at this step" with Evaluate (`watches.ts`) | reuse host logic | S | TM | |
| Watch editor completion (`webview/watchComplete.ts` + `complete`) | reuse UI; runtime `complete` in §1b | S | UI | |
| Record Variable Changes: `_record_locals` reads `f_locals` at each step with the `(id, len)` marker, cap 100,000 entries (`tracer.py`) | no `f_locals` in JS. Instrument assignment sites: after each statement that binds names (from the bindings table: declarators, assignments, updates, `for` heads, params at entry), emit `__tk.l(sc, "x", x)` (or one call per statement with a closure returning the values). Exact per statement and O(1) per step. A container write (`d[k] = v`, `arr.push(x)`) records the container with a shallow-change hash | L | TM | **Done as per-step snapshots (Pyokka's semantics, no host rule change), not assignment sites**. This is the fix HANDOFF wants for Pyokka's re-bind blindness. Wire semantics: attribute the change to the binding statement's own step (wire add `at: "after"`), and update `variableHistory.ts`/`history.py` rules accordingly |
| Locals flushed at a pause not re-sent (`locals_flushed`) | same | S | DBG | |
| Closures and captured variables | captured outer variables are recorded at their own assignment sites (in their own scope); Variables view shows `Closure` from replay data only for names recorded in that scope | M | TM | |
| Code Story document (`features/codeStory.ts`, `session/storyLines.ts`, language `pyokka-story`, grammar) | reuse; story grammar embeds `source.js`/`source.ts` instead of Python | S | EXT | |
| Story hover maps rows back to source (`features/storyHover.ts`) | reuse | S | EXT | |
| Gathered tasks under the module in the call stack | see §2: they nest under the caller in JS | M | TM | Document the difference |
| Step over an awaited gather skips the gathered tasks | holds by the parent chain | S | TM | **Done, tested** |
| Generators / async generators stepping | suspension hooks on `yield` (§2) | M | TM | **Done, tested** |
| Breakpoints as Time Machine targets (`F8`) | reuse | S | TM | |
| Auto play (`codeAutoPlayDelay`) | reuse | S | TM | |

---

## 6. Debugger

| Pyokka feature (source) | Node / TS equivalent | Diff | Owner | Notes |
|---|---|---|---|---|
| The frontier debugger is the runtime's own pause, not debugpy (HANDOFF decision; `debugger.py`) | hybrid: the hooks decide the pause (same reasons and the same scope-chain step logic, ported); the pause is V8's (`debugger;` inside a hook while a worker holds `inspector.Session.connectToMainThread()` with `Debugger.enable`). The runtime's own scripts are blackboxed (`Debugger.setBlackboxPatterns`); frame 0 (the hook) is dropped | L | DBG | `connectToMainThread` is only callable from a worker. Pausing the main thread from a same-thread session deadlocks |
| `record: false` hook set: one integer increment, one list read per statement (`hooks_debug.py`) | `__tk` swaps to a debug hook set: `s` = `count++` plus an armed check against a `Uint8Array` breakpoint index; `f`/`x` keep the per-call id counter and the shadow stack (needed for over/out) | M | DBG | Alternative for full speed: run uninstrumented code under the plain inspector (`setBreakpointByUrl`, native stepping). This loses the statement counter, break-when watches and our step semantics Done: `recorder/debugHooks.ts` |
| Reasons: start, breakpoint, step, watch, pause, exception (`debugger.py` `on_step`) | same | M | DBG | |
| `stopOnEntry` | pause at the first step | S | DBG | |
| Line breakpoints resolved at instrumentation: blank/comment → next statement, `def` line → entry, past last → earlier (`dbgbreakpoints.py`) | same against the rid table; a `function` line → entry step | S | DBG | |
| Conditions, `conditionError` pauses and says why | evaluate the condition at the hook's pause point: `Debugger.evaluateOnCallFrame(frame 1, throwOnSideEffect)` after pausing; to avoid pausing on every hit, compile the condition into a closure in the hook (`__tk.bp(rid, () => cond)`) when breakpoints are known at instrumentation; otherwise pause-evaluate-resume | M | DBG | Pause-evaluate-resume costs about 1 ms per hit, acceptable for conditions |
| Function breakpoints by name, runtime-resolved, dotted names match the last segment, "also defined in …" (`dbgbreakpoints.py`, `info.function_names`) | same table from §2 `functions[].name` (`Class.method` available natively) | S | DBG | JS gives real qualified names, so a dotted match can check the class |
| Breakpoint set before a module loads holds when it loads (`Debugger.file_added`) | same (resolution on `file.instrumented`) | S | DBG | |
| Break-when watches `change` / `true` (`debugger.py`) | needs per-statement evaluation in the frame: closures compiled into the hooks when the watch is known at start; added mid-run, the step hook pauses briefly at each statement (slow; document) | L | DBG | |
| `breakOnException` off / uncaught / raised, `exceptions` action mid-run (`dbgexceptions.py`) | `raised`: `th`/`ux` hooks pause at first sighting in user code; `uncaught`: `process.on("uncaughtExceptionMonitor")` cannot pause in the throwing frame, so use `Debugger.setPauseOnExceptions("uncaught")` in the worker (V8 knows "uncaught" at throw time via its catch prediction) and blackbox library frames; `off`: none | M | DBG | Pyokka's post-mortem uncaught pause (innermost frame live after unwinding) has no V8 analogue; V8 pauses before unwinding, which is better. Promise-rejection catch prediction is heuristic |
| Never pause on `StopIteration`, `GeneratorExit`, `SystemExit`, `KeyboardInterrupt`, or library frames | skip `process.exit`, AbortError optional; library frames blackboxed | S | DBG | |
| `pause` request (one flag; a thread blocked in `accept()` stops at its next statement) | worker sets the flag; the next step hook pauses; idle event loop: `Debugger.pause` from the worker pauses at the next JS executed (any callback); answers `{paused: false}` until then | S | DBG | |
| One thread at a time, `thread {name, ident}` | main thread plus `worker_threads` through the `NodeWorker` domain held on the main thread (`debug/threads.ts`), relayed to the debugger worker; one pause at a time | M | DBG | Done. A worker runs uninstrumented: V8 breakpoints by URL, V8 stepping |
| Step into/over/out from the scope parent chain; "just my code" degrade when no instrumented ancestor within 4 frames (`debugger.py`, `hooks_debug.py`) | port as is over the shadow stack; a handler called from a framework (express, fastify) with an empty stack degrades the same way | M | DBG | |
| Frame-chain stack (`dbgframes.py`): `f_back` up to 64 frames, runtime frames dropped, real lines, `fileId: 0` + `path` for foreign frames | `Debugger.paused.callFrames` (with async parent stacks via `Debugger.setAsyncCallStackDepth(32)`), positions mapped through our source maps; frame 0 (hook) dropped; `node:internal` frames → `fileId: 0` | M | DBG | Async stack frames are a bonus with no Python analogue |
| `locals {frameId}` with `type`, `length` | `Runtime.getProperties` on the frame's `local`/`block`/`closure` scope objects; serialize through our serializer via `Runtime.callFunctionOn` (function = `__tk.ser`, arg = remote object) | M | DBG | |
| `evaluate` in the paused frame (`pure.py`) | `Debugger.evaluateOnCallFrame({throwOnSideEffect: true, timeout})` after the static purity check | M | DBG | |
| `complete` in the paused frame (`complete.py`) | §1b | M | DBG | |
| `exec` writes into the frame; 3.12 `PyFrame_LocalsToFast` via ctypes, 3.13 PEP 667 proxy; `modified` flag (`dbgexec.py`) | `Debugger.evaluateOnCallFrame` (writes land directly); `Debugger.setVariableValue` for the Variables view; `modified` the same | S | DBG | No version split. `const` bindings refuse with a TypeError, reported as `exception` |
| `setVariable` (DAP) | `Debugger.setVariableValue` (local/closure/catch scopes) | S | DBG | |
| `recordFrom` (`pause`, `{function}`, `{path, line}`) and the `record` action: swap hook sets, build scopes for the paused stack, step 0, `midRun`, coverage from start (`record_from.py`) | swap `__tk` members (the code calls through `__tk`, so a swap is atomic); the shadow stack already holds every instrumented frame, so build scopes from it; frames suspended in `await` at the switch get their scope on resume (the `rs` hook) | M | DBG | Easier than Python: no frame walk Done: `recorder/debugHooks.ts` |
| Pause flushes output, partial trace, `time`, `locals` | same, synchronous writes on fd 3 before `debugger;` | S | DBG | |
| Debugger failure → `runner.error` "debugger hook failed in …" | same | S | DBG | |
| DAP translator and adapter, inline adapter, configuration provider (`debug/dapTranslator.ts`, `dapAdapter.ts`, `dapTypes.ts`, `dapShared.ts`) | reuse; debugger type `tracelight`, languages `javascript`, `typescript`, `javascriptreact`, `typescriptreact` | S | EXT | Do not compete with js-debug on `F5` by default (open question) |
| Debug session, registry, launch state (`debugSession.ts`, `debugSessionManager.ts`, `debugSessionState.ts`, `debugTarget.ts`, `debugWaiters.ts`, `debugContext.ts`) | reuse | S | EXT | |
| Launch attributes `program`, `module`, `args`, `cwd`, `env`, `python`, `stopOnEntry`, `breakOnException`, `libraryCode`, `record` | same, with `runtimeExecutable` (node binary) instead of `python`, plus `runtimeArgs` (`--conditions`, `--env-file`) | S | EXT | |
| Servers and reload mode (`uvicorn --reload` spawns a worker) | `node --watch`, `nodemon`, `tsx watch`, `next dev` spawn children: same advice; optional `child_process` auto-attach later | S | EXT | |
| Frontier execute vs replay behind it (`session/debugState.ts`, `debugController.ts`) | reuse | S | DBG | |
| Debugger view in the panel, output tail with ANSI, `\r`, live line, silence marks (`views/debuggerView.ts`, `webview/debuggerView.ts`, `ansi.ts`, `session/outputBuffer.ts`) | reuse | S | UI | |
| Debugger status bar (`views/debugStatusBar.ts`) | reuse | S | EXT | |
| Inline values at a pause (`debug/debugInlineValues.ts`, Python keyword list) | reuse with a JS keyword list, or name extraction via oxc in the host | S | EXT | |
| URI handler `vscode://ivor.pyokka/debug` (`debug/debugUri.ts`) | `vscode://<publisher>.tracelight/debug` | S | EXT | |
| Breakpoints view exception filters ("Raised Exceptions") | reuse (`exceptionBreakpointFilters`) | S | EXT | |
| Library import-time bodies never pause; library functions pause with `libraryCode` | same rule | S | DBG | |
| A breakpoint in `node_modules` without `libraryCode` | same as Python: does not hit; message says so | S | DBG | |

---

## 7. HTTP record and replay

| Pyokka feature (source) | Node / TS equivalent | Diff | Owner | Notes |
|---|---|---|---|---|
| Plugin `pyokka_runtime.plugins.http_record`, appended when `config.http` is set (`plugins/http_record.py`) | built-in runtime plugin `tracelight/http`, loaded in the preload when `http` ≠ off or `httpObserve` | S | DBG | |
| httpx `Client/AsyncClient._transport_for_url` (+ `httpx2`) (`_http_clients.py`) | `fetch` (Node's undici): `@mswjs/interceptors` `FetchInterceptor` | M | DBG | |
| aiohttp `ClientSession._request` + `StreamReader.feed_data`, not counted twice under httpx (`_http_aiohttp.py`) | npm `undici` (`request`, `Pool`, `Client`, `stream`): wrap the global dispatcher (`setGlobalDispatcher` with `Dispatcher.compose` interceptors) plus `undici.Agent` instances through a `registerHooks` load patch of the `undici` package; de-dupe fetch-over-undici with an AsyncLocalStorage flag | L | DBG | The npm `undici` and Node's bundled undici are separate copies |
| requests `HTTPAdapter.send` | axios, got, node-fetch, superagent all sit on `http`/`https` (or fetch); attribute `client` by the outermost layer seen (an ALS flag set by optional thin wrappers), else `http` | M | DBG | |
| `http.client.HTTPConnection` fallback (`send`/`getresponse`/`connect`), thread-local depth (`_http_fallback.py`) | `ClientRequestInterceptor` (patches `http.request`/`get`, `https.*`, `ClientRequest`); depth via ALS | M | DBG | |
| Observe mode (`off`): patched, rows emitted, response untouched, sizes from `content-length` | `node:diagnostics_channel`: `undici:request:create` / `:headers` / `:trailers` / `:error`; `http.client.request.start` / `http.client.response.finish` (Node 22+); no patching at all, so behaviour is unchanged | M | DBG | Better than Python: observe without patches |
| Record: let through, write each exchange; streamed bodies as chunks with boundaries (SSE) | interceptor `response` event: `response.clone()` and read the clone's stream chunk by chunk (boundaries preserved) while the program consumes the original at network speed; ClientRequest: tap `data` events | M | DBG | |
| Replay: answer from the recording, never touch the network (no DNS/TCP) | interceptor `request` listener → `controller.respondWith(new Response(ReadableStream of recorded chunks))`; for http.ClientRequest the interceptor's mock socket (no connect) | M | DBG | |
| Miss → `runner.error` once per key + `ConnectionError("pyokka replay: …")` in the program | `controller.errorWith(new TypeError("fetch failed", {cause: Object.assign(new Error("tracelight replay: no recorded response …"), {code: "ECONNREFUSED"})}))`; http: socket `error` event with the same code (SDK retries see a network error) | S | DBG | |
| Recording file `<root>/.pyokka/replay/<hash>.jsonl`, `.pyokka-replay/` when `.pyokka` is a config file, ancestor lookup, replace on first exchange (`_http_store.py`) | `<root>/.tracelight/replay/<hash>.jsonl`, same rules; header `{"tracelight": "http", "version": 1, "file", "recorded", "node"}` | S | DBG | Format otherwise identical. A shared format with Pyokka is possible (`client` values differ) |
| Bodies stored decoded (gzip, deflate, br, zstd), encoding/length/transfer headers dropped | `zlib.gunzipSync` / `inflateSync` / `brotliDecompressSync` / `zstdDecompressSync` (Node 23.8+/22.15+); fetch already decodes, and Node `http` does not (decode in the tap) | S | DBG | |
| Credential headers dropped, every value through `secrets.scrub` | same | S | DBG | |
| Key = sha256(`METHOD\nURL\n<normalised body>`), canonical JSON | same (`crypto.createHash`); `FormData` multipart boundaries random → new key per run (same caveat) | S | DBG | |
| Replay order: entries of a key in `n` order, the last one repeated | same | S | DBG | |
| `http.exchange` rows: `rid`/`step` from a frame walk to the innermost user statement | `rid` = the tracer's current step rid when the request starts (sync); for requests started in callbacks, the ALS-captured initiator step (set by the step hook into an `AsyncLocalStorage`, read at request start) | M | DBG | |
| Query values stripped in `url` | same | S | DBG | |
| `run.finished.http {mode, requests, recorded, served, misses, file, exists, recordedAt, entries}`, `replayed` | same | S | DBG | |
| HTTP table builder (`session/httpTable.ts`, `agent/http.py`, fixtures) | reuse `httpTable.ts` | S | Core | |
| HTTP view, badge, status bar text (`views/httpPane.ts`, `views/statusText.ts`, `webview/http.css`) | reuse | S | UI | |
| `.gitignore` offer (`features/replayGitignore.ts`) | reuse with `.tracelight/replay/` | S | EXT | |
| Open HTTP Recording (`features/httpRecording.ts`) | reuse | S | EXT | |
| A failing patch site → `runner.error`, the run goes on | same | S | DBG | |
| HTTP only observed while a run records; `record: false` leaves clients untouched | same | S | DBG | |

---

## 8. Profile mode and plugins

| Pyokka feature (source) | Node / TS equivalent | Diff | Owner | Notes |
|---|---|---|---|---|
| `mode: "profile"`: uninstrumented file under `cProfile`, flat `.cpuprofile` (`profile.py`) | uninstrumented run (TS stripped only) with an inspector `Profiler.enable/start/stop` (same-thread session) or `--cpu-prof --cpu-prof-dir`; a real call tree, not flat; `run.finished.profile.path` | S | Core | Better than Pyokka: V8 writes the native format |
| Re-run normally after profiling (`features/profiler.ts`) | reuse | S | EXT | |
| `config.plugins` modules with `before(config)`, `before_each(config)`, `after(config) -> dict` | ESM modules (resolved from the file dir, workspace root, then `node_modules`) exporting `before`, `beforeEach`, `after` (async allowed); returned object merged into `run.finished` | S | Core | Quokka.js's plugin names are `before`/`beforeEach`, so keep camelCase |
| `before_each` finder at position 0 of `sys.meta_path` sees every import first | a plugin may call `module.registerHooks` itself (hooks chain; later registrations run first) | S | Core | |
| `pyokka_runtime.execute.current` (`spec.file_path`, `workspace_root`), `runner_error(message)` | `import { current, runnerError } from "tracelight/runtime"` | S | Core | |
| A raising hook → `runner.error` "plugin NAME failed in STAGE", run goes on | same | S | Core | |
| Fork-mode `before` inherited un-instrumented by every run | N/A (spawn); `before` runs per warm child | - | N/A | |

---

## 9. Agent CLI, bridge, analyses

The Python agent layer (`python/pyokka_runtime/agent/**`) reads `run.json` and is mostly
language-agnostic. Its Python-specific parts are `bindings.py`, `decisions.py`, `names.py`,
`reprs.py`, `origin/*` (call-site AST), `tour/astinfo.py`, `diff.py` statement parsing, and the
interpreter picker. The host already has TS twins of most builders (`src/session/*`), so the
`tracelight` CLI is TS on Node, built on those twins. Moving AST-derived tables into the recording
(`file.instrumented.bindings`, `decisions`) is what lets every builder stay language-agnostic.

### 9a. Commands

| Pyokka feature (source) | Node / TS equivalent | Diff | Owner | Notes |
|---|---|---|---|---|
| CLI framework: stdlib argparse, `--json`, `error:` + hint, exit 2 (`__main__.py`, `agent/commands.py`) | `tracelight` bin (`node:util` `parseArgs`, no deps), same conventions; ships in the extension's `dist` and on npm | M | Core | |
| `serve` | `tracelight serve` | S | Core | |
| `run FILE [--save] [--library-code] [--keep] [--no-locals] [--record-locals] [--http] [--timeout] [--watch] [--trace-context] [--auto-log] [--mode] [--instrumented] [--max-steps] [--exclude] [--only] [--max-value-chars] [--python] -- ARGS` | same flags; `--node PATH` instead of `--python`; `--tsconfig` | M | Core | |
| Which interpreter runs the program (`agent/interpreter.py`: `--python`, `$PYOKKA_PYTHON`, `$VIRTUAL_ENV`, `.venv`, own) | `--node PATH`, `$TRACELIGHT_NODE`, `.nvmrc`/`.node-version`/`package.json engines` reported (not resolved: no tool-specific detection, per the HANDOFF decision), `node` on PATH, else `process.execPath`; refuse < 22.15 by name | S | Core | Package resolution is per-file (`node_modules`), so no PYTHONPATH trick |
| `cache [--clear] [--json]` | same | S | Core | |
| `_child`, `_keep` internal entries | same | S | Core | |
| `state RUN` | reuse shapes | S | Core | |
| `context RUN N [--scope]` / `--line F:L` (`agent/context.py`, `src/session/contextSlice.ts`) | reuse `contextSlice.ts` | S | Core | |
| `step RUN N --into/--over/--out/--back/--back-over/--back-out/--to M [--scope]` (live: executes at a debug pause) | reuse `traceModel.ts` + `contextSlice.ts`; live part DBG | S | Core | |
| `story RUN [--file/--scope/--line] [--limit]` | port `block_lines` (`context.py`) onto `storyLines.ts` | S | Core | |
| `steps RUN [--from --count / --line]` | trivial over the trace | S | Core | |
| `values RUN --line F:L` | reuse | S | Core | |
| `find RUN TEXT [--limit]` | port (`source.py` `find`) | S | Core | |
| `var RUN NAME [--file] [--scope] [--limit]` (`agent/history.py`, `session/variableHistory.ts`) | reuse `variableHistory.ts`; bindings from the recording | S | Core | Rule changes with assignment-site locals (§5) |
| `why RUN STEP [NAME] [--depth]` + conclusion (`agent/provenance.py`, `why_text.py`, `session/provenance.ts`, `shared/provenanceText.ts`) | reuse; the conclusion's "else arm" rule must know JS ternaries and `if/else`; `.get(...)` → `Map.prototype.get` and `obj[k]` returning `undefined` | M | Core | Wording says `undefined`/`null` instead of `None` |
| `origin RUN STEP [EXPR] [--depth]` (`agent/origin/*`, `reprs.py`) | port to TS over oxc ASTs of call sites; `need.py` reads JS error messages (`Cannot read properties of undefined (reading 'x')`, `x is not a function`, `x.map is not a function`); `pick.py` (the odd operand) is weaker in JS (`1 + "2"` does not throw: no TypeError to start from) | L | UI | JS coerces where Python raises, so origin starts from fewer exceptions. Add a "NaN/undefined appeared" start |
| `eval RUN EXPR` (needs `--keep` or `--live`) | §1b evaluate | M | DBG | |
| `expand RUN VALUE_ID [--path]` | same | S | Core | |
| `release RUN` + keeper daemon multiplexing clients (`agent/keep.py`, `link.py`) | `net.createServer` on a Unix socket / Windows named pipe, id rewriting `c<conn>:<id>` | S | Core | |
| `watch --live` | over the bridge | S | EXT | |
| `walkthrough RUN [--file/--scope/--from/--to] [--all]` (`agent/walkthrough.py`, `moments.py`, `session/walkthrough.ts`, `moments.ts`) | reuse `walkthrough.ts`/`moments.ts`; decision kinds from the recording's `decisions` table: `if`/`else if`, `switch` (case taken), ternary (optional), loops; `tool` callbacks = user functions entered from `node_modules` | M | Core | `src/session/decisions.ts` reads Python indentation: replace it |
| `graph RUN [--all/--expand] [--scope] [--no-statements] [--dot]` (`agent/graph*.py`, `session/executionGraph*.ts`) | reuse `executionGraph*.ts`; port `graph_dot.py` (S); `names.ts` targets/reads from the recording's bindings instead of the Python scanner | M | Core | |
| `exceptions RUN` | reuse `exceptionReport.ts` | S | Core | |
| `http RUN` | reuse `httpTable.ts` | S | Core | |
| `diff BEFORE AFTER [--limit]` / `diff BEFORE --live` (`agent/diff.py`, `diff_match.py`) | port to TS: statements from oxc per file (enclosing function + comment-free text), same matching and facts | L | UI | |
| `narrate RUN [--command] [--dry-run]` (`agent/narrate.py`, `narrate_prompt.md`, `src/agent/narrate.ts`) | reuse `narrate.ts`; prompt says JS/TS | S | UI | |
| `tour RUN [--goal] [--budget] [--prose] [--out]` (`agent/tour/*`, `docs/TOUR.md`; host runs the Python command via `tourRun.ts`) | port `tour/*` to TS (about 2,200 lines); `astinfo.py` call classes become fs writes (`fs.writeFile*`), `child_process` (subprocess), user / `node:` builtin / library | L | UI | Until ported, the panel's TOUR section is absent |
| `history RUN --at/--var/--why [--pause] --out [--prose] [--pad] [--limit] [--lang] [--append] [--value-chars]` + renderer (`agent/codehistory.py`, `checkpoint.py`, `skills/pyokka/scripts/render-code-history.cjs`) | port codehistory to TS; renderer (already Node, Handlebars + Shiki) reused with `lang: "ts"/"js"` | M | UI | |
| `debug FILE/--module M [--args] [--cwd] [--env] [--python] [--at] [--stop-on-entry] [--library-code] [--record] [--record-from]` with three routes (`agent/debug_start.py`) | same routes; `--node` instead of `--python` | M | DBG | |
| `continue --live [--no-wait/--until/--to]` | same | S | DBG | |
| `pause --live [--no-wait]` | same | S | DBG | |
| `stop --live`, `restart --live [--stop-on-entry]` | same | S | DBG | |
| `break --live [F:L] [--when] [--at] [--remove] [--list] [--on-exception]` | same | S | DBG | |
| `watches --live [--add [--break-when]] [--remove] [--list]` | same | S | DBG | |
| `locals --live [--frame N]` | same | S | DBG | |
| `exec --live SOURCE [--frame N]` | same | S | DBG | |
| `record --live` | same | S | DBG | |
| `shell --live [--session] [--json]` (`agent/shell.py`) | same; a Node process costs about 40 ms, so the saving matters less but the shell stays | S | EXT | |
| Relaunch memory `last-debug.json` (`agent/relaunch.py`) | same file under `$TRACELIGHT_HOME` | S | DBG | |
| Session picking by verb, `--session` (`agent/sessions.py`) | port | S | EXT | |
| Rendering of every shape (`agent/render.py`, `render_debug.py`) | port to TS (text forms are pinned by fixtures; reuse `provenanceText.ts`, `executionGraphText.ts`) | M | Core | |
| Recording-loss notes, `meta.recording` (`agent/recording.py`, `shared/traceCap.ts`) | reuse `traceCap.ts` | S | Core | |
| `suspects` (referenced by the Claude band, not in this CLI) | - | - | UI | Track if Pyokka adds it |

### 9b. Saved runs, bridge, live

| Pyokka feature (source) | Node / TS equivalent | Diff | Owner | Notes |
|---|---|---|---|---|
| Saved run `{meta, events}` with file hashes, redacted, `stale:` lines, a redacted copy of sources for `diff` (`agent/save.py`, `source.py`) | same format; `meta.node`, `meta.language` (wire add) | S | Core | |
| `RunSource` seam, `SavedRun` (`agent/source.py`) | TS interface over saved run and live bridge | S | Core | |
| `LiveRun` over the bridge socket (`agent/live.py`) | TS client, `net.connect` to the Unix socket, token line | S | EXT | |
| Bridge: Unix socket per session, descriptor `<pid>-<n>.json`, token, `kind: run/debug`, socket path cap 103 bytes (`src/agent/bridge.ts`, `bridgeSupport.ts`) | reuse; directory `$TRACELIGHT_HOME/sessions` | S | EXT | |
| Bridge requests `state`, `step`, `context`, `values`, `var`, `why`, `eval`, `expand`, `select`, `watch`/`unwatch`, `walkthrough`, `graph`, `exceptions`, `http`, `recording` | reuse | S | EXT | |
| Bridge debug requests `debug`, `stop`, `restart`, `continue`, `pause`, `break`, `watches`, `locals`, `record`, `exec` (`bridgeDebug*.ts`, `bridgeRecordFrom.ts`) | reuse | S | EXT | |
| Debug socket `kind: "debug"` with stop slice, watch stream `output`/`finished` (`bridgeDebugSocket.ts`, `bridgeDebugReply.ts`, `bridgeDebugShapes.ts`) | reuse | S | EXT | |
| `recording` reply for `tour --live` (`bridgeRecording.ts`) | reuse | S | EXT | |
| `pyokka.agentAccess` gate (off by default) | `tracelight.agentAccess` | S | EXT | |
| `~/.local/bin/pyokka` shim rewritten on activation (`features/cliShim.ts`) | `~/.local/bin/tracelight` running `node <ext>/dist/cli.js`; Windows: a `.cmd` shim (Pyokka has none) | S | EXT | |
| Browser UI over WebSocket (no Pyokka analogue; the panel is a VS Code webview) | `tracelight ui`: an HTTP server and WebSocket carrying `webviewProtocol.ts` messages, the panel bundle with Monaco served as is; the bridge requests over the same socket | L | UI | New product surface |
| MCP server (README: "there is no MCP server yet") | `@modelcontextprotocol/sdk` stdio server exposing the CLI verbs as tools over `RunSource` | M | UI | |
| Skill `skills/pyokka` (modes debug / explain / show, CLI reference) | `skills/tracelight` with the same modes; CLI reference regenerated | M | UI | |
| Claude Code band (`claude-plugin/pyokka-band`) | agnostic over the CLI JSON; point at `tracelight` | S | UI | |
| Context slice, variable history, provenance, walkthrough, graph, exceptions report, narration, tour, code history | see 9a | - | - | |

---

## 10. VS Code extension UI

Language-agnostic means the code reuses as is once the language id, file globs and binary
names change. Python-specific means it needs new logic.

| Pyokka feature (source) | Node / TS equivalent | Diff | Owner | Agnostic? |
|---|---|---|---|---|
| Activation `onLanguage:python`, `onStartupFinished`, `onUri` | `onLanguage:javascript`, `typescript`, `javascriptreact`, `typescriptreact` | S | EXT | wiring |
| Coexistence with Pyokka and Quokka in one window (command ids, keybinding `when` clauses, context keys) | separate extension id; `when: editorLangId in tracelight.languages`; Quokka's chords collide, so document it | M | EXT | Python-specific (open question) |
| Session per document, run loop, modes onSave/auto/onDemand/smart, debounce (`session/session.ts`, `sessionManager.ts`) | reuse | S | EXT | agnostic |
| Smart mode project markers (`config/project.ts`: pyproject.toml, setup.py, requirements.txt, Pipfile, locks) | `package.json`, `tsconfig.json`, `deno.json`, lockfiles | S | EXT | Python-specific list |
| Config layering: settings → `~/.pyokka/config.json` → `pyproject.toml [tool.pyokka]` → `.pyokka` (`config/merge.ts`) | settings → `~/.tracelight/config.json` → `package.json` `"tracelight"` key → `.tracelight` (and Quokka's `.quokka` / `package.json` `"quokka"` read as a fallback) | S | EXT | mostly agnostic |
| Quokka-style `env.params.env` / `args` | same | S | EXT | agnostic |
| `.env` via `python.envFile` (`config/dotenv.ts`) | `tracelight.envFile` (default `${workspaceFolder}/.env`); Node `--env-file` semantics | S | EXT | agnostic parser |
| Interpreter resolution: setting, Python extension env, `python.defaultInterpreterPath`, `python3`; picker; restart on env change (`runtime/interpreter.ts`, `@vscode/python-extension`) | `tracelight.node.path`, `node` on PATH (the login-shell PATH, which matters on macOS with nvm), picker over `which -a node`; version check ≥ 22.18 (`MIN_NODE`, `src/runtime/language.ts`; the program alone may run on 22.15). Python-extension integration: N/A | M | EXT | Python-specific |
| Untrusted workspace prompt, `automaticRestart`, `automaticStartRegex`, `smartStart` | reuse | S | EXT | agnostic |
| Commands: Start on Current File, Toggle, Run on save/automatically/on demand, Re-execute, Stop Current, Stop All, Focus Active File, Select Workspace Folder, Edit Session Settings, Select Action, Show Output, Focus Output, Show Logs, Open Start View | reuse | S | EXT | agnostic |
| Show Instrumented Code (`features/instrumentedView.ts`) | reuse; language `javascript` | S | EXT | agnostic |
| Clear Library Cache (`features/libraryCache.ts`) | reuse, `TRACELIGHT_CACHE_DIR` | S | EXT | agnostic |
| Value commands: Show Value, Show Line Value(s), Show Line Timing(s), Copy Value, Clear Value, Clear File Values, Toggle Show Value On Selection, Show Last/All Displayed Values, Toggle Auto Log, Copy Hover Value, Explore Value (`features/liveValues.ts`, `valueCommands.ts`, `session/markers.ts`, `util/text.ts`) | reuse; `util/text.ts` member-chain detection needs `?.`, `#private`, `$`-identifiers | S | EXT | mostly agnostic |
| Copy Path / Copy Data (hidden) | same | S | EXT | agnostic |
| Value Peek hover with Explore/diagram/Copy/Why/Add watch, footer as-of step (`features/valuePeek.ts`, `hoverLocals.ts`) | reuse | S | EXT | agnostic |
| Shadow values `≈` for edited lines (`features/shadowValues.ts`, `session/dirtyLines.ts`) | reuse host; runtime `shadow` in DBG | S | EXT | agnostic |
| Inline decorations, coverage gutter, themes, `pyokka.colors` (`decorations/decorator.ts`, `styles.ts`) | reuse | S | EXT | agnostic |
| Logpoints from VS Code breakpoints (`features/logpoints.ts`), breakpoints into runs (`features/debugBreakpoints.ts`) | reuse; `contributes.breakpoints` languages JS/TS | S | EXT | agnostic |
| Time Machine commands: Start / Start With Auto Play / Stop, Step Into/Back Into/Over/Back Over/Out/Back Out, Run to/Back to Active Line, Run to/Back to Breakpoint, Open Call Stack Frame, View/Hide Call Stack, Reveal Trace Step, Auto Play, Pause, Toggle Code Preview, Toggle Step Echo, Add/Remove Watch Expression, View Code Story | reuse | S | TM | agnostic |
| Debugger commands: Debug Current File, Debug Current File (Recording), Continue, Pause, Stop, Step Over/Into/Out, Restart, Show Debugger | reuse | S | EXT | agnostic |
| `F5` five-state routing | reuse; must not steal `F5` from js-debug in JS projects (open question) | M | EXT | agnostic logic, policy differs |
| Show Variable History, Why This Value (editor and Variables view) (`features/variableHistory.ts`, `views/variablePane.ts`, `views/whyPane.ts`) | reuse | S | EXT | agnostic |
| Narrate Walkthrough (`features/narrator.ts`) | reuse | S | EXT | agnostic |
| Show Tour, Narrate Tour (`views/tourPane.ts`, `agent/tourRun.ts`, `session/tourPanel.ts`) | reuse once the TS tour exists (no Python subprocess) | S | UI | agnostic |
| Show Execution Diagram (`features/executionGraph.ts`, `views/graphPane.ts`, `webview/executionDiagram.ts`, `execLayout.ts`, `execStory.ts`, `diagram.ts`, phases) | reuse; `executionGraphPhases.ts` comment detection `#` → `//` and `/* */` | S | UI | mostly agnostic |
| Show HTTP Requests, Open HTTP Recording | reuse | S | EXT | agnostic |
| Profile (`features/profiler.ts`) | reuse; opens the `.cpuprofile` in VS Code's viewer | S | EXT | agnostic |
| Quick package install: hover, code action, Install into Project / only for this file, import→package map (`features/packageInstall.ts`) | `npm i` / `pnpm add` / `yarn add` / `bun add` by lockfile; "only for this file" → a per-scratch dir under `$TRACELIGHT_HOME/scratch-deps` added to resolution; map `@types/*` hints; `tracelight.installPackageCommand` | M | EXT | Python-specific |
| Snippets, New File, New Python File, From Recent / Snippet, Edit Snippets, Create Snippet from Selection (`features/snippets.ts`, `snippets/pyokka.code-snippets`) | `New JavaScript File`, `New TypeScript File`; snippets `//?`, `snap` | S | EXT | mostly agnostic |
| Snaps: Allow File Snaps Execution, Insert/Delete Snap Output (`#» ` lines), Start/Stop Snaps Discovery, confirm on open/edit, grammar injection into `source.python` (`features/snaps.ts`, `snapFences.ts`, `syntaxes/pyokka-snap.tmLanguage.json`) | fence syntax per §2; output lines `//» `; injection into `source.js`/`source.ts` | M | EXT | Python-specific fence |
| Recent files document with code lenses, Run Recent, Remove (`features/recentFiles.ts`, `session/recentFilesStore.ts`, `syntaxes/pyokka-recent.tmLanguage.json`) | reuse | S | EXT | agnostic |
| Start view with the interactive demo (`features/startView.ts`, `examples/demo.py`) | port `demo.py` to `demo.ts` (same outline as Quokka's demo) | S | EXT | content |
| Panel webview: rail, Output view (entries list/tree, filters, Monaco DETAILS, Compare, Show as diagram), EXCEPTIONS / WALKTHROUGH / TOUR sections, Settings view, Variable pane, HTTP view, Time Machine view, Debugger view (`views/outputPanel.ts`, `panelSupport.ts`, `webview/**`) | reuse; Monaco language for values = `javascript`; Settings labels (Step Into Library Code = node_modules) | S | UI | agnostic |
| Status bar (`views/statusBar.ts`, `statusText.ts`) | reuse | S | EXT | agnostic |
| Story language + grammar (`syntaxes/pyokka-story.tmLanguage.json`) | embed JS/TS grammar | S | EXT | Python-specific grammar include |
| Settings: every `pyokka.*` key (55, listed in `package.json`) | `tracelight.*` with the same meanings; drop `python.interpreter` (→ `node.path`); add `tsconfig`, `conditions` (export conditions), `moduleKind` override | S | EXT | agnostic except the interpreter |
| Keybindings (`Cmd/Ctrl+K` chords, `Ctrl+Alt+P` Cursor twins, `Shift+F5`, `F8`, `F10`/`F11` families) | same, `when` scoped to JS/TS and a Tracelight session | S | EXT | agnostic |
| Inline values provider at a pause, language `python` (`debug/debugInlineValues.ts`) | languages JS/TS | S | EXT | keyword list |
| Output channel logs, build stamp in tooltip | reuse | S | EXT | agnostic |
| e2e suite on `examples/demo.py`, vitest fixtures pinning Python/TS twins | new JS fixtures; the twin-pinning fixtures go away where only TS remains | M | EXT | |

---

## Python-specific things without a direct analogue

| Python thing | What replaces it in Node |
|---|---|
| `os.fork` warm children (Linux) vs spawn (macOS/Windows), `forksafety.py` | spawn only, plus a warm pool of preloaded children |
| `sys.monitoring` (RAISE / EXCEPTION_HANDLED / RERAISE, tool id 3) | instrumented `throw` / `catch` heads / function-wrapper `catch`, plus `process` `uncaughtException` / `unhandledRejection`; the inspector's `setPauseOnExceptions` for debugger pauses only |
| `f_back` frame walk for scope parents (4 frames) | shadow call stack kept by the entry/exit hooks; `await`/`yield` suspension hooks |
| `f_locals` per-step snapshots and the `(id, len)` marker | assignment-site recording from the bindings table (exact) |
| `PyFrame_LocalsToFast` via ctypes (3.12) vs PEP 667 write-through proxy (3.13) | `Debugger.evaluateOnCallFrame` / `Debugger.setVariableValue` (one path for every Node version) |
| 3.12 vs 3.13 vs 3.14 behaviour splits | Node 22.15 LTS vs 24 LTS: ALS implementation (`AsyncContextFrame` default in 24), type stripping default-on (23.6 / 22.18), `registerHooks` (22.15 / 23.5), zstd in zlib (22.15 / 23.8) |
| Compiling the rewritten AST with original positions | inline source maps (`magic-string`), `process.setSourceMapsEnabled(true)`, our own mapping for inspector and `CallSite` positions |
| Builtins as hooks (`builtins._pk_*`), name mangling of `__x` in classes | `globalThis.__tk` object, `__tk_` prefix; no mangling issue |
| `ast` + `tokenize` (stdlib) | `oxc-parser` (native, per-platform binaries; `@oxc-parser/wasm` fallback) |
| `cProfile` flat profile | V8 CPU profiler, a real call tree |
| `python -m MODULE` | package specifier / `bin` resolution (§1b `run.module`) |
| `__main__` namespace for hover evaluation | a module-scope `(s) => eval(s)` closure injected into the main module |
| `inspect.getattr_static` | property descriptors via `Runtime.getProperties` / `Object.getOwnPropertyDescriptor` |
| Typed `except` clauses, `broad` | untyped `catch`; broad = no rethrow and no type test (§4) |
| `with` / `contextlib.suppress` as handlers | none (`using` does not suppress) |
| Threads (one paused at a time) | main thread and `worker_threads` (the debugger pauses in workers natively; outside a live debug run workers are recorded into the same trace) |
| `site-packages` / stdlib split | `node_modules` / `node:` builtins |
| Interpreter picker + Python extension API | Node binary picker; no extension API dependency |

---

## Open questions and risks

1. **ESM module bodies cannot be wrapped in `try/finally`** (`import`/`export` must be
   top-level). Module-scope exit, library quiet mode and the module-scope eval closure need
   special handling. Top-level `await` in a library module can interleave with stepped code
   while quiet mode is on. Risk: wrong quiet-mode state, costing coverage or steps.
2. **Async scope parents.** The shadow stack plus `await`/`yield` hooks must stay balanced on
   every path (throw out of an `await`, `return` inside `finally`, generators abandoned
   mid-iteration, `for await` breaks). One missed pop corrupts every later parent. It needs a
   fuzz test over async control flow. The semantics also differ from Pyokka: `Promise.all`
   children nest under the caller.
3. **Cost of instrumenting JS.** Inserting statement calls into hot code defeats V8
   optimisations (inlining budgets, try/catch in every function, more bytecode). Expect a
   larger multiple than Pyokka's ~9x per statement on tight loops. Measure early on a
   numeric loop and on an express request handler.
4. **Pure evaluation semantics.** V8 `throwOnSideEffect` permits side-effect-free user
   functions and blocks some getters, while Pyokka's rule refuses all user functions and
   allows properties. Decide the contract: the recommendation is the static rule first, V8
   second. `throwOnSideEffect` also rejects some harmless builtins (for example `Date.now`
   in older V8).
5. **Hybrid pause (`debugger;` in a hook plus a worker inspector session).** Unproven at scale.
   Open points: blackboxing the hook frame, step requests issued while paused at our frame,
   `Debugger.paused` latency, what happens if user code also attaches an inspector or runs
   `--inspect`, and VS Code js-debug attaching to the same process (only one main-thread
   session can pause it).
6. **Source-position fidelity.** oxc span encoding (UTF-8 vs UTF-16), composing maps across
   instrument → `stripTypeScriptTypes(transform)` → JSX transform, and Node's own
   `--enable-source-maps` handling of `prepareStackTrace`. Columns are load-bearing for
   ranges, markers and live comments.
7. **`beforeExit` as "finished".** Programs with open handles (servers, intervals, open
   sockets in SDK clients) never finish. Clients with keep-alive agents can hold the loop for
   seconds after the last request. The run looks hung until the timeout. Consider
   "finished = main module done and no pending user steps for N ms" as a second trigger.
8. **`process.exit()` and signal deaths** skip `beforeExit`, so all final flushing must be
   synchronous (`fs.writeSync` on fd 3) in an `exit` handler. A large trace flushed
   synchronously can be slow.
9. **HTTP coverage.** The npm `undici` vs Node's bundled undici, HTTP/2 (`node:http2`, gRPC),
   WebSockets, and clients that use raw `net`/`tls` are outside the interceptors. Streaming
   record via `response.clone()` doubles buffering under backpressure.
10. **Recorded locals redesign.** Assignment-site recording changes the `locals` wire semantics
    ("state at the start of S"). `variableHistory.ts`, `history.py`, `why` and `diff` rules must
    move together, and the Pyokka twin should follow or diverge explicitly.
11. **Value rendering without `util.inspect`.** Map/Set via prototype methods can be patched by
    user code. WeakMap and Promise state need the inspector. Class instances with private
    `#fields` are invisible without the inspector (`Runtime.getProperties` shows private
    members).
12. **Snaps fence syntax and inline config** for JS are not settled (`/*{{ }}*/` vs template
    literal). Hoisting `let`/`const` out of per-statement `try` blocks changes TDZ behaviour.
13. **Editor coexistence.** `F5`, `Shift+F5`, `F10`/`F11` and the `Cmd+K` chords collide with
    js-debug and with Quokka.js itself on the same languages. Tracelight probably cannot take
    `F5` by default in JS projects.
14. **Native dependency in the vsix.** `oxc-parser` ships per-platform binaries, so the vsix
    is per-platform or needs the WASM build (slower). The runtime child loads it too.
15. **Worker threads, child processes, cluster.** `worker_threads` are recorded (merged by a
    ticket clock at synchronisation points); child processes are uninstrumented. Servers started via `cluster` or `--watch` debug the
    parent, as `uvicorn --reload` does in Pyokka.
16. **Bun / Deno** are out of scope. `registerHooks` and `stripTypeScriptTypes` are
    Node-specific.
