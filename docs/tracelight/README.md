# Tracelight: Pyokka for JavaScript and TypeScript

Tracelight is two things: the Node.js runtime in `node/` that speaks Pyokka's runner protocol
(`docs/PROTOCOL.md`), and the Tracelight VS Code extension (`tracelight/`), Pyokka's extension
for JavaScript and TypeScript. A `.js`/`.mjs`/`.cjs`/`.ts`/`.mts`/`.cts`/`.jsx`/`.tsx` document
starts a session whose runner is `node node/bin/tracelight.mjs serve`.

`PARITY.md` is the checklist: every Pyokka feature, its Node equivalent and the workstream that
owns it. This file says what is built, how it fits together and where the follow-up work plugs in.

## The extension: one source, two builds

Pyokka (Python) and Tracelight (JavaScript / TypeScript) are separate extensions that install side
by side, built from the same `src/` and `webview/`:

- `node esbuild.mjs` builds Pyokka into `dist/` (manifest: `package.json`, edited by hand). It runs
  Python files only and ships `dist/python`.
- `node esbuild.mjs --tracelight` builds Tracelight into `tracelight/` (manifest:
  `tracelight/package.json`, written by `node scripts/tracelight-manifest.mjs` from Pyokka's). It
  runs JS/TS files only and ships the Node runtime as `tracelight/dist/node`.

Tracelight's build passes every source file through `scripts/brand.mjs`, which renames each
`pyokka` id to `tracelight`: commands (`tracelight.startOnCurrentFile`), settings
(`tracelight.nodePath`, `tracelight.agentAccess`), views, context keys, the debug type
(`"type": "tracelight"` in launch.json), language ids, `~/.tracelight`, `TRACELIGHT_HOME`,
`.tracelight/replay`, the URI handler `vscode://ivor.tracelight/debug`. Where the two behave
differently, the code tests `IS_TRACELIGHT` (`src/brand.ts`): which language runs
(`src/runtime/language.ts`), where the runtime is, which CLI shim is written (`tracelight` vs
`pyokka` in `~/.local/bin`), the start view. Never compare with the string `'pyokka'` in `src/`:
the rename would turn it into `'tracelight'`. A line ending in `// brand: keep` is not renamed.

Keybindings are the same keys in both; Pyokka's fire outside JS/TS editors, Tracelight's only in
them, so neither shadows the other.

## Try it

```sh
npm ci --prefix node                 # oxc-parser and magic-string, the runtime's two dependencies
node node/bin/tracelight.mjs run examples/x.ts --save /tmp/run.json
python3 -m pyokka_runtime story /tmp/run.json --file examples/x.ts   # Pyokka's verbs read Tracelight runs
npm test --prefix node               # the runtime's tests (node:test)
node esbuild.mjs --tracelight && (cd tracelight && npx vsce package --no-dependencies)   # tracelight-X.Y.Z.vsix
```

In VS Code: install the vsix, open a `.js` or `.ts` file and run "Tracelight: Start on Current
File" (`Cmd+K Q`), or F5 with a `tracelight` launch configuration. `tracelight.nodePath` picks the
Node binary (default `node` on PATH; Node 22.18 or newer, Node 24 recommended). The program itself
can run on any Node from 22.15 (`--node PATH` or `$TRACELIGHT_NODE`); the CLI needs 22.18 because
it runs its TypeScript sources directly.

End to end in a real VS Code: `test/e2e/tracelight.test.js` (run, F5 breakpoint, step out, finish
on a .js and a .ts file) and `test/e2e/side-by-side.test.js` (both extensions in one window).
`npx vscode-test --config .vscode-test.tracelight.mjs` runs them locally; in a cloud container
that cannot download VS Code, `test/code-server/run.sh` runs them in code-server (see its header).

## Layout (`node/src`)

| File | Role | Pyokka counterpart |
|---|---|---|
| `instrument.ts` | oxc-parser AST, hook insertion with magic-string, range tables, live comments, markers, logpoints, ignore hints, TypeScript via `module.stripTypeScriptTypes` (strip mode keeps every offset) | `instrument.py`, `rewrite.py`, `magic.py`, `spans.py` |
| `tracer.ts` | the `__tk` hooks: steps, scopes, coverage, returned values, logs, timings, caught and uncaught exceptions, partial and final trace | `tracer.py`, `logs.py`, `errors.py`, `returns.py` |
| `serialize.ts` | value nodes, previews, registry for `expand` | `serialize.py`, `values.py` |
| `secrets.ts` | value and name provenance masking | `secrets.py` |
| `child.ts` | the run child: `module.registerHooks` loader (ESM, CJS, TS), stream patching, end of run, `expand` / `source` | `child.py`, `execute.py`, `control.py` |
| `runner.ts` | NDJSON server, one child per run, timeout, stop, `runId` / `seq` | `runner.py` |
| `bindings.ts` | the `bindings` request | `bindings.py` |
| `cli.ts` | `tracelight serve`, `run [--save] [--keep] [--http]`, `instrument`, `bindings`, `mcp`, `cache`, `release`, `expand` | `cli.py`, `agent/save.py` |
| `lower.ts` | `enum`, `namespace`, parameter properties, `import =`, `export =` and JSX lowered as edits, columns mapped back | `rewrite.py` (no Python analogue for JSX) |
| `select.ts` | which files are instrumented: project, `libraryCode`, `exclude`, `only` | `execute.py` finder |
| `cache.ts` | the library instrumentation cache (`~/.tracelight/cache`, `TRACELIGHT_CACHE_DIR`) | `cache.py` |
| `plugins.ts`, `execute.ts` | `config.plugins` and the API they get | `execute.py` plugins |
| `keep.ts` | the keeper behind `run --keep` | `agent/keep.py` |
| `parse.ts` | oxc-parser with raw transfer | |
| `threads/` | `worker_threads` recording: `hub.ts` (main thread: the `Worker` subclass, synchronisation ticks, held events, value routing), `worker.ts` (the worker's preload), `merge.ts` (segments in ticket order) | the threads of `tracer.py` (one trace) |
| `debug/` | the live debugger: `debugger.ts` (main half: the trap, stops, steps), `agent.ts` (worker half over `connectToMainThread`), `breakpoints.ts`, `predict.ts` (uncaught or caught), `complete.ts`, `repl.ts`, `wire.ts` (one fd 3 writer for both threads), `host.ts` | `debugger.py`, `dbgbreakpoints.py`, `dbgexceptions.py`, `dbgexec.py`, `complete.py`, `control.py` |
| `pure.ts`, `evaluate.ts` | pure evaluate (write check, V8 `throwOnSideEffect`, allowlisted-method fallback); evaluate and complete after a run | `pure.py` |
| `http/` | `store.ts` (Pyokka's recording format and keys), `record.ts` (`@mswjs/interceptors` for http/https, `fetch`, XHR); `plugins/http.ts` loads it | `plugins/_http_store.py`, `plugins/http_record.py` |
| `mcp/` | `tracelight mcp`: the six tools of `pyokka mcp`, answered in-process for a Tracelight run or live session (Python only for a Python run) | `agent/mcp.py`, `agent/mcp_tools.py` |

Extension side: `src/runtime/language.ts` decides the runtime per document,
`src/runtime/interpreter.ts` `resolveNode` finds Node, `src/session/session.ts` starts the
runner with Tracelight's entry point, `esbuild.mjs` ships `node/` as `dist/node`.

## How a run works

1. The runner spawns `node --disable-warning=ExperimentalWarning node/src/child.ts` with fds 1
   and 2 piped (fd-level output), fd 3 a pipe for everything the child says (NDJSON, written
   with blocking `writeSync`, so a program stuck in a loop still delivers its partial traces and
   `process.exit` drops nothing), and an IPC channel for requests to the child.
2. The child installs `globalThis.__tk`, patches `process.stdout.write` / `stderr.write` (Python
   level writes: `output` with `step`), and registers a synchronous `load` hook. Every project
   file (under the workspace root or the main file's directory, not `node_modules`) is
   instrumented when it is first required or imported; its format comes from the extension,
   then `package.json` `type`, then syntax detection, as Node decides it.
3. `import()` of the main file runs the program. The IPC channel is unref'd, so `beforeExit`
   fires when the program's own work is done. Then the tracer sends the caught exceptions,
   coverage, times and the final trace, and the child sends `done` and stays alive for `expand`
   and `source`. An uncaught exception or rejection ends the run with exit code 1;
   `process.exit(n)` ends it with `n` (and stops the program there).

## Instrumentation contract

Hooks (all on `__tk`; per function `_tk_scope_`, `_tk_rv_`, `_tk_e_`):

```js
__tk.s(rid, _tk_scope_)                     // statement step (before the statement)
__tk.c(rid)                                 // coverage only: declarations, imports, expression parts
(__tk.c(rid), expr)                         // right side of && || ??, both arms of ?:
function f() {const _tk_scope_=__tk.f(rid);let _tk_rv_=__tk.u;try{ ...body... ;_tk_rv_=__tk.e}
  catch(_tk_e_){__tk.ex(_tk_scope_,_tk_e_);throw _tk_e_}finally{__tk.x(_tk_scope_,_tk_rv_)}}
return (_tk_rv_=(value))                    // every return
__tk.aw(_tk_scope_, await __tk.ap(_tk_scope_, x))   // await and yield: the parent is current while suspended
catch (e) {__tk.h(tryRid, e, true, line); ...}      // where a caught exception was handled
__tk.v(rid, ctx, value, kind, markerId, changeId, fn?) / __tk.t(...)   // `// ?` values and timings
__tk.log(rid, "log", ...args)               // console.log/info/warn/error/debug/trace
__tk.lp(rid, kind, template, ctx, m, c, isExpr, (_tk_e_) => eval(_tk_e_))   // logpoints, `exp` markers
```

- Positions: lines 1-based, columns 0-based UTF-16 units (what oxc and VS Code use). A range is
  `[startLine, startCol, endLine, endCol]`; compound statements have header ranges
  (`if (x)`, `for (const a of b)`, `function f(a: number): number`). Range ids are global across
  files through `rangeBase`, in source order (start, then longer first). Range 0 of every file is
  the whole file.
- Only insertions: no original character moves, and the inline source map (magic-string, hires)
  makes `error.stack` point at the source. TypeScript is stripped first in strip mode, so the
  `.ts` offsets are the JavaScript offsets; `enum`, `namespace`, parameter properties and JSX are
  lowered first (`lower.ts`) and their columns mapped back to the source.
- Imported project modules are a scope of their own (`var _tk_scope_=__tk.f(moduleRid)` at the
  top, `__tk.x(_tk_scope_)` at the end), depth 1, as Pyokka's `module_scope`.
- `function` / `class` declarations, imports and `export { … }` are coverage-only, as `def` and
  `class` are in Pyokka. Loops record one header step per iteration.

## Where Tracelight's wire differs from Pyokka's

- `ready` adds `language: "javascript"` and `nodeVersion`; `pythonVersion` carries the Node version
  so existing hosts show something sensible.
- Value nodes reuse Pyokka's container vocabulary: Array is `list`, a plain object or Map is
  `dict` (`keyRepr` is the JS key), Set is `set`, string `str`, boolean `bool`, `null` and
  `undefined` are `None` with `value` `null` / `undefined`; other objects are named by their
  constructor (`Date`, `Promise`, `User`). Accessors are `type: "accessor"`, never invoked. Every
  `value` and `text` is JavaScript (`[ 2, 4, 6 ]`, `{ a: 1 }`, `'x'`, `true`), and the panel spells
  them as JavaScript.
- `handledAt.broad` is always `true` (a JS `catch` catches everything).
- Capabilities advertised today: `spawn, expand, source, bindings, markers, logpoints,
  partialTrace, recordLocals, plugins, libraryCode, profile, snaps, module, typescript, jsx, esm,
  cjs, evaluate, shadow, watch, complete, exec, debug, record, recordFrom` (`protocol.ts`
  `CAPABILITIES`). Python's `monitoring` (`sys.monitoring`) has no JS counterpart.

## Seams for the follow-up threads

**Time Machine and async stepping (TM).** Built: `recorder/recorder.ts` owns the trace and the
`s`/`c`/`f`/`x`/`ex`/`ap`/`aw` hooks; `tracer.ts` reads its tables for logs, errors and coverage.

- Step attribution is exact by construction (every hook carries the frame's `_tk_scope_`), so
  steps of async calls that interleave across awaits belong to their own call.
- Parents come from a synchronous frame chain: `f` pushes, `x` pops, `ap` pops the suspended
  frame, `aw` pushes it back. A resume that skips `aw` (a rejected await, `for await`, a
  generator resumed with `throw`) is repaired at the frame's next statement, and a microtask
  clears whatever is left once the JS stack unwinds. A callback the event loop enters gets the
  module as parent, as Pyokka's tasks do; `asyncParent` (a JS addition, ignored by hosts) names the
  scope that scheduled it.
- An AsyncLocalStorage store follows frames into continuations: output, console calls and
  logs from code without hooks (library callbacks, timers) are attributed to the step of the call
  that scheduled them (`tracer.attributedStep()`).
- `recordLocals`: the instrumenter hands `s` a getter over the names visible at the statement
  (`recorder/localsPlan.ts`, `() => [a, b, i]`), and the recorder keeps Pyokka's per-step change
  entries (identity plus length marker, 100,000 entry cap), so `variableHistory.ts` and
  `history.py` read them unchanged. `tracelight run --save` records locals unless `--no-locals`.
- `bindings.ts` lists method and arrow parameters (and `this` for methods), and a saved run
  carries the table on each `file.instrumented`, so `pyokka var` and `why` work on JS runs.
- Speed: `bench/record.ts` (recording, about 30 to 200 ns per step against Pyokka's 1.1 to
  3.7 µs on the same programs) and `bench/stepping.sh` (stepping and seek over saved runs with the
  host's own `TraceModel`: JS and Python recordings of the same program have the same shape and
  the same latency).
- Watch expressions at a step: built on the DBG trap (`debug/index.ts` `wantsDebugger` returns
  `watch`).
- `record: false` and `recordFrom`: `recorder/debugHooks.ts` stands in for the recorder's hooks
  (`Tracer.useDebugHooks`): a statement counter, per-call ids from a counter (from `FOREIGN` in a
  `recordFrom` run) and a shadow stack for step over / out. At the `recordFrom` pause (or the
  `record` action) `Tracer.startRecording` gives every frame on the shadow stack a scope, records
  the paused statement as step 0 and puts the recording hooks back, wrapped so a frame's id from
  before the switch maps to its scope (`Recorder.midRunHooks`, `foreign`). The debugger also pauses in
  worker threads (natively; a live debug run does not record them).
- Worker threads (`threads/`): outside a live debug run every worker records too, through the same
  load hook with ids from counters the threads share; the traces are merged in the order of a
  shared ticket clock taken at synchronisation points (PROTOCOL.md "Worker threads").

**Live debugger, pure evaluate, HTTP replay (DBG).** Built (PARITY.md "Status of the DBG
rows"): a debug run gets a control pipe on fd 5 that the worker reads, because IPC is dead while
the main thread is paused; the runner writes requests there for debug runs. HTTP is the runtime's
own plugin (`plugins/http.ts`, `BUILTIN.http`), loaded for every run as Pyokka's `http_record`
is, unless `httpObserve: false`; it reads the current statement through the plugin API's
`position()`. The plan as written
before: the child already serves requests over IPC
(`child.ts` `serve`) and the runner forwards them (`runner.ts` `dispatch`, add `evaluate`,
`complete`, `shadow`, `exec`, `debug` next to `expand`). The pause point is the `s`/`f` hooks in
`tracer.ts` (Pyokka's `Debugger.on_step`); while paused the main thread is blocked, so the
control channel moves to a worker thread with `inspector.Session.connectToMainThread()` (PARITY.md
§6). Debug runs are already off the timeout clock (`config.debug` in `runner.ts`). HTTP record
and replay is a plugin (PARITY.md §7, `@mswjs/interceptors`); the plugin loader is the Core
remainder below and lands in this branch first.

**Browser UI and MCP server (UI).** The runner is a plain NDJSON process (`tracelight serve`), and
`cli.ts` `runOnce` drives one run in-process: a WebSocket bridge can relay the same messages to a
browser page with Monaco, which renders ranges, logs and traces exactly as the panel does. The
saved run (`tracelight run --save`) is Pyokka's format, so the Pyokka MCP server on the `mcp-server`
branch and every agent verb (`story`, `step`, `context`, `walkthrough`, `graph`, `exceptions`,
`find`, `values`) read Tracelight runs today; a Node port of the verbs is optional.

**Core is complete on this branch** (PARITY.md, "Status of the Core rows"): plugins, library
code with its cache, `exclude` / `only`, profile and snaps modes, `resolveGetters`, inline config,
the keeper, the module launch, the TypeScript constructs strip mode refuses, and JSX/TSX. Recorded
locals and watches are TM's; `evaluate`, `shadow`, `complete`, `exec`, `debug` and the HTTP plugin
are DBG's (the plugin loader they need is in `plugins.ts`).
