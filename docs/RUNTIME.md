# The Tracelight runtime

Tracelight's runtime is the Node.js program in `node/`: it instruments JavaScript and TypeScript,
runs the program in a child process, records what happened and speaks the runner protocol
(`docs/PROTOCOL.md`) on stdio. The VS Code extension, the browser page (`docs/WEB.md`), the
`tracelight` CLI and `tracelight mcp` all drive it. A `.js`/`.mjs`/`.cjs`/`.ts`/`.mts`/`.cts`/
`.jsx`/`.tsx` document starts a session whose runner is `node node/bin/tracelight.mjs serve`
(`dist/node/bin/tracelight.mjs` in a build).

This file says what is built, how it fits together and where to look in the code.

## The extension and the runtime

`node esbuild.mjs` builds the extension into `dist/` and copies the runtime (`node/src`,
`node/bin`, `node/package.json` and `node/node_modules`) to `dist/node`. The runtime ships as
TypeScript source: Node 22.18+ strips the types itself, so there is no compile step. oxc-parser
carries a platform binary, so a vsix is built per platform.

Extension side: `src/runtime/language.ts` decides which documents run (JS/TS only) and holds the
minimum Node version, `src/runtime/interpreter.ts` finds Node (`tracelight.nodePath`, else `node`
on PATH), `src/session/session.ts` starts the runner, and `src/runtime/runnerClient.ts` speaks
NDJSON to it.

**The wire was inherited.** Tracelight was split from Pyokka, a Python extension built on the same
protocol, and the protocol keeps a few names from that origin: `ready.pythonVersion` (it carries the
Node version), the `python` field of a saved run's `meta` (also the Node version, next to `node`),
and the Python-style type names of value nodes (below). They are part of the contract, not leftovers
to rename.

## Try it

```sh
npm ci --prefix node                 # oxc-parser, magic-string, @mswjs/interceptors
node node/bin/tracelight.mjs run examples/demo.ts --save /tmp/run.json
node node/bin/tracelight.mjs story /tmp/run.json --file examples/demo.ts
npm test --prefix node               # the runtime's tests (node:test)
```

`node node/bin/tracelight.mjs` with no arguments prints every command and verb.

The CLI needs Node 22.18 or newer because it runs its TypeScript sources directly. The program
itself can run on any Node from 22.15 (`run --node PATH` or `$TRACELIGHT_NODE`), the first release
with `module.registerHooks`; before 22.18 the runner passes the type-stripping flag itself.

## Layout (`node/src`)

| File | Role |
|---|---|
| `instrument.ts` | oxc-parser AST, hook insertion with magic-string, range tables, live comments, markers, logpoints, ignore hints, TypeScript via `module.stripTypeScriptTypes` (strip mode keeps every offset) |
| `lower.ts` | `enum`, `namespace`, parameter properties, `import =`, `export =` and JSX lowered as edits, columns mapped back |
| `tracer.ts` | the `__tk` hooks: logs, timings, caught and uncaught exceptions, coverage, partial and final trace |
| `recorder/` | `recorder.ts` (the trace: steps, scopes, the frame chain), `localsPlan.ts` (`recordLocals`), `debugHooks.ts` (the hooks of a run that records nothing), `valueText.ts` |
| `serialize.ts` | value nodes, previews, the registry behind `expand` |
| `secrets.ts` | value and name provenance masking |
| `child.ts` | the run child: `module.registerHooks` loader (ESM, CJS, TS), stream patching, end of run, `expand` / `source`, the module launch |
| `runner.ts` | NDJSON server, one child per run, timeout, stop, `runId` / `seq` |
| `bindings.ts` | the `bindings` request |
| `cli.ts` | `tracelight serve`, `run [--save] [--keep] [--http]`, `instrument`, `bindings`, `mcp`, `cache`, `version`, and the agent verbs |
| `agent/` | the agent verbs over a saved run or a live session (`story`, `step`, `context`, `walkthrough`, `graph`, `exceptions`, `var`, `why`, `tour`, `debug`, ...), redaction, narration |
| `select.ts` | which files are instrumented: project, `libraryCode`, `exclude`, `only` |
| `cache.ts` | the library instrumentation cache (`~/.tracelight/cache`, `TRACELIGHT_CACHE_DIR`) |
| `plugins.ts`, `execute.ts` | `config.plugins` and the API they get |
| `plugins/http.ts`, `http/` | the HTTP plugin: `record.ts` (`@mswjs/interceptors` for http/https, `fetch`, XHR), `store.ts` (the recording format and keys) |
| `keep.ts` | the keeper behind `run --keep` |
| `parse.ts` | oxc-parser with raw transfer |
| `profile.ts` | `mode: "profile"`: the runtime's own frames removed from the `.cpuprofile` |
| `threads/` | `worker_threads` recording: `hub.ts` (main thread: the `Worker` subclass, synchronisation ticks, held events, value routing), `worker.ts` (the worker's preload), `merge.ts` (segments in ticket order) |
| `debug/` | the live debugger: `debugger.ts` (main half: the trap, stops, steps), `agent.ts` (worker half over `connectToMainThread`), `breakpoints.ts`, `predict.ts` (uncaught or caught), `complete.ts`, `repl.ts`, `wire.ts` (one fd 3 writer for both threads), `host.ts` |
| `pure.ts`, `evaluate.ts` | pure evaluate (V8 `throwOnSideEffect`, then an allowlisted-method fallback); evaluate and complete after a run |
| `mcp/` | `tracelight mcp`: six tools over the same commands (`skills/tracelight/references/mcp.md`) |

## How a run works

1. The runner spawns `node --disable-warning=ExperimentalWarning node/src/child.ts` with fds 1
   and 2 piped (fd-level output), fd 3 a pipe for everything the child says (NDJSON, written
   with blocking `writeSync`, so a program stuck in a loop still delivers its partial traces and
   `process.exit` drops nothing), and an IPC channel for requests to the child. Every run child
   is spawned (`ready.capabilities[0]` is `spawn`).
2. The child installs `globalThis.__tk`, patches `process.stdout.write` / `stderr.write`
   (JS-level writes become `output` with `step`), and registers a synchronous `load` hook. Every
   project file (under the workspace root or the main file's directory, not `node_modules`) is
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
  top, `__tk.x(_tk_scope_)` at the end), depth 1.
- `function` / `class` declarations, imports and `export { … }` are coverage-only. Loops record
  one header step per iteration.

## What the protocol's values look like from JavaScript

- `ready` carries `language: "javascript"` and `nodeVersion`; `pythonVersion` repeats the Node
  version for hosts that read that field.
- Value nodes use the protocol's container vocabulary: Array is `list`, a plain object or Map is
  `dict` (`keyRepr` is the JS key), Set is `set`, string `str`, boolean `bool`, `null` and
  `undefined` are `None` with `value` `null` / `undefined`; other objects are named by their
  constructor (`Date`, `Promise`, `User`). Accessors are `type: "accessor"`, never invoked. Every
  `value` and `text` is JavaScript (`[ 2, 4, 6 ]`, `{ a: 1 }`, `'x'`, `true`), and the panel spells
  them as JavaScript.
- `handledAt.broad` is always `true` (a JS `catch` catches everything).
- Capabilities advertised (`node/src/protocol.ts` `CAPABILITIES`): `spawn, expand, source,
  bindings, markers, logpoints, partialTrace, recordLocals, plugins, libraryCode, profile, snaps,
  module, typescript, jsx, esm, cjs, evaluate, shadow, watch, complete, exec, debug, record,
  recordFrom`.

## Time Machine and async stepping

`recorder/recorder.ts` owns the trace and the `s`/`c`/`f`/`x`/`ex`/`ap`/`aw` hooks; `tracer.ts`
reads its tables for logs, errors and coverage.

- Step attribution is exact by construction (every hook carries the frame's `_tk_scope_`), so
  steps of async calls that interleave across awaits belong to their own call.
- Parents come from a synchronous frame chain: `f` pushes, `x` pops, `ap` pops the suspended
  frame, `aw` pushes it back. A resume that skips `aw` (a rejected await, `for await`, a
  generator resumed with `throw`) is repaired at the frame's next statement, and a microtask
  clears whatever is left once the JS stack unwinds. A callback the event loop enters gets the
  module as parent; `asyncParent` (a JS addition, ignored by hosts that do not know it) names the
  scope that scheduled it.
- An AsyncLocalStorage store follows frames into continuations: output, console calls and
  logs from code without hooks (library callbacks, timers) are attributed to the step of the call
  that scheduled them (`tracer.attributedStep()`).
- `recordLocals`: the instrumenter hands `s` a getter over the names visible at the statement
  (`recorder/localsPlan.ts`, `() => [a, b, i]`), and the recorder keeps per-step change entries
  (identity plus length marker, 100,000 entry cap) that the variable history reads.
  `tracelight run --save` records locals unless `--no-locals`.
- `bindings.ts` lists method and arrow parameters (and `this` for methods), and a saved run
  carries the table on each `file.instrumented`, so `tracelight var` and `why` work on saved runs.
- Speed: `node/bench/record.ts` (recording, about 30 to 200 ns per step) and
  `node/bench/stepping.sh` (stepping and seek over saved runs with the host's own `TraceModel`).
- Watch expressions at a step are built on the debugger's trap (`debug/index.ts` `wantsDebugger`
  returns `watch`).
- Worker threads (`threads/`): outside a live debug run every worker records too, through the same
  load hook with ids from counters the threads share; the traces are merged in the order of a
  shared ticket clock taken at synchronisation points (PROTOCOL.md "Worker threads").

## Live debugger, pure evaluate, HTTP

- A debug run gets a control pipe on fd 5 that a worker thread reads, because IPC is dead while
  the main thread is paused; the runner writes requests there for debug runs. The pause point is
  the `s`/`f` hooks; while paused the main thread is blocked, and the worker half
  (`debug/agent.ts`) serves the paused frame through `inspector.Session.connectToMainThread()`.
  Debug runs are off the timeout clock (`config.debug` in `runner.ts`).
- `record: false` and `recordFrom`: `recorder/debugHooks.ts` stands in for the recorder's hooks
  (`Tracer.useDebugHooks`): a statement counter, per-call ids from a counter (from `FOREIGN` in a
  `recordFrom` run) and a shadow stack for step over / out. At the `recordFrom` pause (or the
  `record` action) `Tracer.startRecording` gives every frame on the shadow stack a scope, records
  the paused statement as step 0 and puts the recording hooks back, wrapped so a frame's id from
  before the switch maps to its scope (`Recorder.midRunHooks`, `foreign`). The debugger also pauses
  in worker threads.
- Pure evaluate (`pure.ts`): V8's own side-effect analysis (`throwOnSideEffect`) decides, and an
  expression V8 refuses gets a second chance under an allowlist of non-mutating string, number and
  static methods. Neither path is a sandbox: a member access may run a getter.
- HTTP is the runtime's own plugin (`plugins/http.ts`, `BUILTIN.http` in `plugins.ts`), loaded for
  every run unless `httpObserve: false`; it reads the current statement through the plugin API's
  `position()`. `record` and `replay` write and read `.tracelight/replay/<hash>.jsonl`.

## Browser page and agents

The runner is a plain NDJSON process (`tracelight serve`), and `cli.ts` `runOnce` drives one run
in-process. `web/server.ts` relays the same messages to a browser page over a WebSocket
(`docs/WEB.md`). A saved run (`tracelight run --save`) is the event stream plus `meta`, and every
agent verb reads it, or a live VS Code session with `--live`
(`skills/tracelight/references/tracelight-cli.md`).
