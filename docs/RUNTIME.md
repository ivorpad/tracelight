# The runtime (`node/`)

The runtime runs a JavaScript or TypeScript program under the tracer and answers the extension
over NDJSON (`docs/PROTOCOL.md`). The extension spawns it as `node dist/node/bin/tracelight.mjs
serve` (from a checkout, `node/bin/tracelight.mjs`); the same entry is the `tracelight` CLI and
`tracelight mcp`. It runs on Node 22.18 or newer, because it runs its TypeScript sources directly;
the program itself may run on any Node from 22.15 or native Bun (`--node PATH` or
`$TRACELIGHT_NODE`; browser aliases `--runtime node` and `--runtime bun`). Node uses
`module.registerHooks`; Bun uses `Bun.plugin` and the JavaScriptCore WebSocket inspector
(`debug/bunInspector.ts`). TypeScript offset-preserving stripping for Bun is prepared by the
host Node process (`stripForBun.mjs`), then the resulting program executes in Bun.

```sh
npm ci --prefix node                        # oxc-parser, magic-string, @mswjs/interceptors
node node/bin/tracelight.mjs run examples/demo.ts --save /tmp/run.json
node node/bin/tracelight.mjs story /tmp/run.json --file examples/demo.ts
npm test --prefix node                      # node:test, about 300 tests in 15 s
```

## Layout (`node/src`)

| File | Role |
|---|---|
| `instrument.ts` | oxc-parser AST, hook insertion with magic-string, range tables, live comments, markers, logpoints, ignore hints, TypeScript through `module.stripTypeScriptTypes` (strip mode keeps every offset) |
| `tracer.ts` | the `__tk` hooks: steps, scopes, coverage, returned values, logs, timings, caught and uncaught exceptions, partial and final trace |
| `recorder/` | the trace itself: the step and scope tables, recorded locals (`localsPlan.ts`), the debug-run stand-in (`debugHooks.ts`) |
| `serialize.ts` | value nodes, previews, the registry behind `expand` |
| `secrets.ts` | masking by value and by name |
| `child.ts` | the run child: the `module.registerHooks` loader (ESM, CJS, TS), stream patching, the end of a run, `expand` and `source` |
| `runner.ts` | the NDJSON server: one child per run, timeout, stop, `runId` and `seq` |
| `bindings.ts` | the `bindings` request: what each statement assigns, reads and calls |
| `cli.ts` | `tracelight serve`, `run [--save] [--keep] [--http]`, `instrument`, `bindings`, `mcp`, `cache`, `version`, and the agent verbs |
| `lower.ts` | `enum`, `namespace`, parameter properties, `import =`, `export =` and JSX lowered as edits, columns mapped back |
| `select.ts` | which files are instrumented: project files, `libraryCode`, `exclude`, `only` |
| `cache.ts` | the library instrumentation cache (`~/.tracelight/cache`, `TRACELIGHT_CACHE_DIR`) |
| `plugins.ts`, `execute.ts` | `config.plugins` and the API they get |
| `keep.ts` | the keeper behind `run --keep` |
| `threads/` | `worker_threads` recording: `hub.ts` (the main thread's side), `worker.ts` (the worker's preload), `merge.ts` (segments in ticket order) |
| `debug/` | the live debugger: `debugger.ts` (the trap, stops, steps), `agent.ts` (the worker half over `connectToMainThread`), `breakpoints.ts`, `predict.ts`, `complete.ts`, `repl.ts`, `wire.ts`, `host.ts` |
| `pure.ts`, `evaluate.ts` | side-effect-free evaluation (write check, V8 `throwOnSideEffect`, allowlisted methods); evaluate and complete after a run |
| `http/` | `store.ts` (the recording file and its keys), `record.ts` (`@mswjs/interceptors` for http/https, `fetch`, XHR); `plugins/http.ts` loads it |
| `agent/` | the agent verbs (`story`, `step`, `why`, `origin`, `tour`, `history`, `debug`, ...), registered in `agent/verbs.ts` |
| `mcp/` | `tracelight mcp`: six tools over the agent verbs, answered in this process |

On the extension's side, `src/runtime/language.ts` says which documents run,
`src/runtime/interpreter.ts` `resolveNode` finds Node, `src/session/session.ts` starts the runner
with the runtime's entry, and `esbuild.mjs` copies `node/` to `dist/node`.

## How a run works

1. The runner spawns `node --disable-warning=ExperimentalWarning node/src/child.ts` with fds 1
   and 2 piped (fd-level output), fd 3 a pipe for everything the child says (NDJSON, written
   with blocking `writeSync`, so a program stuck in a loop still delivers its partial traces and
   `process.exit` drops nothing), and an IPC channel for requests to the child.
2. The child installs `globalThis.__tk`, patches `process.stdout.write` and `stderr.write` (each
   becomes an `output` event with its `step`), and registers a synchronous `load` hook. Every
   project file (under the workspace root or the main file's directory, not `node_modules`) is
   instrumented when it is first required or imported; its format comes from the extension, then
   `package.json` `type`, then syntax detection, as Node decides it.
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
  top, `__tk.x(_tk_scope_)` at the end), at depth 1.
- `function` and `class` declarations, imports and `export { … }` are coverage-only. Loops record
  one header step per iteration.

## On the wire

The protocol's field names come from its first runtime, Pyokka's, and the extension reads them as
they are:

- `ready` carries `language: "javascript"` and `nodeVersion`, and `pythonVersion` repeats the Node
  version.
- Value nodes use the protocol's container vocabulary: an Array is `list`, a plain object or Map is
  `dict` (`keyRepr` is the JS key), a Set is `set`, a string `str`, a boolean `bool`, and `null`
  and `undefined` are `None` with `value` `null` or `undefined`; other objects are named by their
  constructor (`Date`, `Promise`, `User`). Accessors are `type: "accessor"`, never invoked. Every
  `value` and `text` is JavaScript (`[ 2, 4, 6 ]`, `{ a: 1 }`, `'x'`, `true`).
- `handledAt.broad` is always `true`: a JS `catch` catches everything.
- `ready.capabilities` (`protocol.ts` `CAPABILITIES`): `spawn, expand, source, bindings, markers,
  logpoints, partialTrace, recordLocals, plugins, libraryCode, profile, snaps, module, typescript,
  jsx, esm, cjs, evaluate, shadow, watch, complete, exec, debug, record, recordFrom`.

## Stepping, async and workers

- Step attribution is exact by construction (every hook carries the frame's `_tk_scope_`), so
  steps of async calls that interleave across awaits belong to their own call.
- Parents come from a synchronous frame chain: `f` pushes, `x` pops, `ap` pops the suspended
  frame, `aw` pushes it back. A resume that skips `aw` (a rejected await, `for await`, a generator
  resumed with `throw`) is repaired at the frame's next statement, and a microtask clears whatever
  is left once the JS stack unwinds. A callback the event loop enters gets the module as parent;
  `asyncParent` names the scope that scheduled it.
- An AsyncLocalStorage store follows frames into continuations: output, console calls and logs
  from code without hooks (library callbacks, timers) are attributed to the step of the call that
  scheduled them (`tracer.attributedStep()`).
- `recordLocals`: the instrumenter hands `s` a getter over the names visible at the statement
  (`recorder/localsPlan.ts`, `() => [a, b, i]`), and the recorder keeps per-step change entries
  (identity plus a length marker, capped at 100,000). `tracelight run --save` records locals
  unless `--no-locals`.
- `record: false` and `recordFrom`: `recorder/debugHooks.ts` stands in for the recorder's hooks: a
  statement counter, per-call ids and a shadow stack for step over and out. At the `recordFrom`
  pause (or the `record` action) `Tracer.startRecording` gives every frame on the shadow stack a
  scope, records the paused statement as step 0 and puts the recording hooks back.
- A debug run gets a control pipe on fd 5 that the debugger's worker reads, because IPC is dead
  while the main thread is paused. The pause point is the `s` and `f` hooks; while paused, the
  control channel runs on a worker thread through `inspector.Session.connectToMainThread()`.
- Worker threads (`threads/`): every worker records through the same load hook, with ids from
  counters the threads share, and the traces are merged in the order of a ticket clock taken at
  synchronisation points (`docs/PROTOCOL.md`, "Worker threads").
- HTTP is the runtime's own plugin (`plugins/http.ts`), loaded for every run unless
  `httpObserve: false`; it reads the current statement through the plugin API's `position()`.
- Speed: `bench/record.ts` measures recording (about 30 to 200 ns per step) and
  `bench/stepping.sh` stepping and seeking over saved runs.
