# Tracelight in a browser

The browser page is the Tracelight panel, a code pane and the Time Machine in a plain browser
tab, outside VS Code. A small local bridge runs the runtime and relays its NDJSON protocol
(`docs/PROTOCOL.md`) to the page over a WebSocket. It runs JavaScript and TypeScript files with the
runtime in `node/`; `--runtime "CMD ARGS"` points it at any other command that speaks the protocol.

```
npm run build
node dist/web/server.js path/to/file.ts --open        # or: npm run tracelight-web -- path/to/file.ts
```

From an installed extension, `tracelight web path/to/file.ts --open` runs the same bridge (the vsix
ships `dist/web`), and `tracelight web ctl ...` takes every `ctl` command below.

Open http://127.0.0.1:4777/. The left side is the file in Monaco with values after their lines,
coverage in the gutter and the exception on its line; the right side is the same panel the
extension shows. The bridge re-runs the file whenever it changes on disk, so saving in VS Code
or any other editor updates the page. While the page's debugger has a run, paused or running, a
save or a settings change only refreshes the page: the paused program keeps the code it started
with, and Run, Restart or the next save after the debug run executes the new text. Typing in the
page's code pane runs the edited buffer without saving it, Quokka-style; Ctrl/Cmd+S writes it to disk.

The default **Aprender** presentation gives the code the full width. At a live pause its compact
bar offers Siguiente (step over), Entrar (step into), and Variables y pila. That last button opens
the lower inspector only when requested. **Depurar** shows the right panel and the full debugger
controls. Changing presentation preserves the run, pause and inspector state. Presentation does
not change whether execution is live or recorded, and a live run has no backwards step.

Inline arrays show their serialized element count instead of their contents. Objects use a short
preview. Ghost values that would extend past the code pane are omitted; hovering the binding still
shows its runtime text. The earlier-recording warning appears only when consulting a recording
view during live debugging.

Every view of the panel works as it does in VS Code:

- Entries, Details, Compare and the value diagram; Exceptions; Walkthrough.
- The Time Machine with its steps strip, timeline guide and watch expressions. A watch is recorded
  by one run of the file around the current step, as in Automatic mode.
- Variable History (the rail's variable button) and the Details pane's "why" tree.
- The Execution Diagram (the Time Machine's diagram button, or More > Show Execution Diagram).
- HTTP: the requests of the run, and record/replay from the view's mode menu. Open Recording shows
  the recording in the code pane.
- Narrate (the Walkthrough's sparkle) and the Tour with Narrate Tour. The bridge makes the one
  model call with `TRACELIGHT_EXPLAIN_COMMAND` when set (a command that reads the prompt on stdin),
  else `claude -p`, else `codex exec`. The tour runs the runtime's own `tour` verb over the run.
- The live Debugger: the header's debug button runs the file for real, with nothing recorded, and
  pauses at breakpoints (at the first statement when none is set). Click the gutter or press F9 to
  set one. Under the code pane are the call
  stack, the variables and continue, pause, step over, into and out, restart and stop (F5, F10,
  F11, Shift+F11, Shift+F5). The panel's Debugger view keeps the watches, breakpoints, where
  exceptions pause, and the output. It runs on a second runtime process, so the recorded run and
  its Time Machine stay as they were.

  While the debugger runs, the source hides annotations, coverage and errors from that earlier
  recording. At a pause, Aprender shows a wrapping row of actual selected-frame bindings below the active statement. Click a name or preview to open its runtime text and object tree. Depurar keeps short ghost values beside source. Hover an
  identifier for its runtime text; display never evaluates source expressions.
  Values disappear on resume and refresh when stepping or selecting another frame. Edited source
  does not show values from a different buffer. The panel opens the live Debugger view and labels
  the recording views as earlier results.

  Drag the top edge of the lower Debugger pane to set its height, or the divider between Call Stack
  and Variables to set their widths. Both dividers also accept arrow keys. Click a variable to read
  its text and open its object/array tree. Expandable nodes request more detail using the paused
  runtime's value ID. Runtime truncation is labelled separately from the row's visual ellipsis;
  nodes without expansion support keep their available preview.

- Code Story (the rail's book button): the run as one read-only document in the code pane, one
  block per pass through a scope, with the step's box and its values. It starts the Time Machine
  and follows it; select text on a row (or click its gutter) to go to the step that ran it, and
  Ctrl/Cmd+click to open the source line. Stopping the Time Machine closes it.
- Profile (the rail's pulse button): one run under the runtime's profiler on a runtime process of
  its own, shown in the code pane as a table of functions by self and total time (Ctrl/Cmd+click
  opens one). `GET /api/profile` downloads the `.cpuprofile` for Chrome DevTools or VS Code.
- Run modes from the Settings view: Automatic runs edits as you type, On Save runs on Ctrl/Cmd+S
  and saves from other editors, On Demand only on Run (a change on disk then just refreshes the text).
- More > Show Instrumented File, Show Logs (the bridge's log), Edit Session Settings (the Settings
  view) and View Recent Files: the files this bridge ran (kept in `~/.tracelight/recent.json`);
  picking one makes it the page's file. Only files of the runtime's language under the starting
  file's directory can be opened.

Nothing is left out for being impossible in a browser; the page's limits are the bridge's: one
main file at a time, of one runtime's language.

| Option | |
|---|---|
| `--port N` | default 4777 (`TRACELIGHT_PORT`) |
| `--runtime js` | the default for `.js`/`.mjs`/`.cjs`/`.jsx`/`.ts`/`.mts`/`.cts`/`.tsx`: `node <dist>/node/bin/tracelight.mjs serve`, else the checkout's `node/bin/tracelight.mjs` |
| `--runtime node` / `--runtime bun` | select the program's engine explicitly; the bridge and protocol server stay on Node |
| `--node PATH` | a specific Node or Bun executable for recording, watch reloads and live debug; overrides the runtime alias |
| `--runtime "CMD ARGS"` | any command that speaks the protocol on stdio, started in the file's directory (`TRACELIGHT_RUNTIME`); the only way to run a file of another language |
| `--open` | open the page in the default browser |
| `--no-run` | serve the source without executing it on startup; explicit Run and Automatic page edits still execute it |
| `--no-watch` | optional: a change on disk refreshes the page's source but never runs the file; Run, `debug start` and Automatic page edits still execute it. Agent sessions start with watching enabled |
| `--verbose` | log the runtime's spawn, stderr and exits |

Bun executes the actual program with `Bun.plugin` instrumentation and its JavaScriptCore
WebSocket inspector. TypeScript source preparation uses the bridge's Node executable to keep
source offsets intact. No Bun APIs are polyfilled. Live startup errors stop execution rather
than falling back to a recording. Bun worker recording and V8 CPU profiling are unavailable;
pure expression evaluation/watches are refused because its inspector cannot enforce
`throwOnSideEffect`. Read captured locals, or use explicit live `exec`. Finished recordings
without a live debugger support recorded values but not finished-run evaluation.
CommonJS instrumentation is refused on Bun: its `onLoad` source result loses CommonJS default
exports, and a precompiled CommonJS wrapper does not execute through that hook. Use Node for
CommonJS modules. ESM JavaScript and TypeScript retain native Bun execution.

## Side by side with VS Code

Run the bridge on the file, then in VS Code run **Simple Browser: Show** with
`http://127.0.0.1:4777/?layout=panel`. `?layout=panel` drops the code pane, since VS Code's editor
is next to it; `?layout=code` shows the code pane alone. The layout button in the header cycles
through the three. A window narrower than 760px stacks the code over the panel.

## Agents: step through code while explaining

For live learning or debugging without a preliminary run, start with
`tracelight web FILE --no-run`, open the page, set breakpoints, then issue
`tracelight web ctl debug start`. Watching stays enabled: saves from VS Code or another agent
refresh the page, and while the debugger has a run they execute nothing. Between debug runs a save
runs the file under the page's run mode; `--no-watch` is optional, for a person who wants saves
never to run it. Use `debug continue` to resume between stages, including
known imported files targeted by `break LINE on --file FILE`. The debugger captures the same
execution as it pauses for Code history. Recording navigation does not resume the live program.

An agent (Claude Code, Codex, a script) drives the open page and reads back where it is. Every
command answers with the page's state: the step, file, line and function, the source line, the
variables of the current frame as of the step, the call stack, the values logged so far, the
output and the errors.

```
node dist/web/server.js ctl state
node dist/web/server.js ctl line 19 --say "The loop pairs each point with the next one."
node dist/web/server.js ctl step into --say "distance() gets the first pair."
node dist/web/server.js ctl step over      # into | over | out | back | backOver | backOut
node dist/web/server.js ctl goto 42
node dist/web/server.js ctl say "Squaring makes the sign irrelevant." --line 13
node dist/web/server.js ctl clear          # remove the bubble
node dist/web/server.js ctl eval "points.length"   # in the paused frame while the debugger is paused
node dist/web/server.js ctl run            # run again and wait for it
node dist/web/server.js ctl var total      # every recorded change of a variable
node dist/web/server.js ctl why total --step 13
node dist/web/server.js ctl watch "total * 2"   # --remove drops it
node dist/web/server.js ctl break 11       # toggles; `on` / `off`, --if "i > 2"
node dist/web/server.js ctl debug start    # the live debugger: restart | continue | step [into|over|out] | pause | stop | state
node dist/web/server.js ctl story          # open the Code Story and read it back
node dist/web/server.js ctl profile        # profile one run: the hottest functions
```

`--say` shows the explanation as a bubble under the new line, for the person watching; a move
without it clears the previous bubble. `debug start` runs to the first breakpoint and pauses at the
first statement only when no breakpoint is set in a file the run touches, the rule VS Code follows
(`entryPause` in `src/session/debugState.ts`). While the live debugger is paused, `eval` runs in the
paused frame and sees its variables, like `tracelight eval --live`; otherwise it reads the finished
run without running anything. The same commands are the HTTP API the CLI calls:
`GET /api/state`, and `POST /api/command` with a JSON body such as
`{"action": "step", "kind": "over", "say": "..."}` (see `AgentCommand` in
`web/bridgeProtocol.ts`). A command needs a page open; without one the API answers 409.

An agent that works in the browser itself gets the same commands as WebMCP tools when the browser
offers `navigator.modelContext` (a draft spec): `tracelight_state`, `tracelight_goto`, `tracelight_step`,
`tracelight_line`, `tracelight_say`, `tracelight_run`, `tracelight_eval`, `tracelight_var`, `tracelight_why`,
`tracelight_watch`, `tracelight_breakpoint`, `tracelight_story`, `tracelight_profile`, `tracelight_debug`. The header shows a WebMCP chip when
they registered. A browser-automation agent can also call `window.tracelight` (the page host) directly.

## Agent control and execution context

Read `state.context` before teaching or moving. It identifies the active source (`live` or
`recording`), `runId`, `step`, selected `frame`, absolute `file`, `line`, `paused` and
`localsReady`. `context.locals` belongs to that context. The existing top-level execution fields
still describe the recording for compatibility. A completed recording and a live pause can coexist.
`shownFile` identifies the editor document, which can differ from the selected frame.

Commands accept `expect: {source, runId, step, frame, file}`. Supply the fields from the context
you read to reject a request after another actor changes the run, pause or selected frame.
CLI equivalents are `--expect-source`, `--expect-run`, `--expect-step`, `--expect-frame` and
`--expect-file` (`null` is accepted for step/file). WebMCP has the same `expect` object on each tool. An obsolete request fails before
changing the page. Presentation commands also reject a pause change while waiting for rendering.

HTTP control requires exactly one connected page. Zero pages, multiple pages, overlapping commands
and a disconnected target return 409 with an error. State never falls back to cached page data.
After reconnection read state again; a timed-out command might already have changed the runtime.
Recorded navigation reviews history while the live debugger stays paused. Confirm the visible
position before explaining it; `debug step` advances live execution.
A debugger move waits for a new pause or the run's end, then for that frame's locals and rendering;
a runtime rejection or an unconfirmed move fails instead of reporting the old pause as success.

`say` replaces a note with the same `noteId`; `clear` removes that ID (all notes when omitted).
`file` and `line` anchor the note, `kind` labels explanation or prediction, and `observed` stores
the execution context when the note was created. It does not turn prose into a runtime observation.
`say` and `clear` wait for the code view's presentation barrier. `noteRendering` reports actual
connected DOM nodes and viewport visibility, or null when that view cannot confirm rendering.
A note for another file remains stored with `rendered: false`. Notes persist in that page until cleared or reloaded;
check their `observed` context before using one at a later pause.

`values` selects names supplied by the paused runtime; `inspect` opens/closes those serialized
bindings. Both return run/step/frame/file provenance and rendered inspector state. They do not
call `eval`. Explicit live `eval` can execute code in the paused frame and must not be used as a
substitute for reading an observed binding.

Verified failure modes and limits:

| Failure | Handling and evidence |
|---|---|
| Finished recording mistaken for live state | Additive `context`; handler test keeps w-1 beside d-context. |
| Command moves several browser pages | Refuse multiple pages before sending; socket test sees zero commands on either page. |
| Old run, pause, frame or file used for a note | `expect` rejects mismatches; shared handler and WebMCP execute tests. |
| Disconnection returns cached state | Pending target fails; GET state returns 409/null until a page reconnects. |
| Runtime step error appears successful | Strict agent control propagates the runtime error; handler regression test. |
| Note reply precedes rendering | Presentation barrier and DOM confirmation; test holds the barrier pending. |
| Note with same ID stays on its old line | Not reproduced on c9c2808: isolated queue/worker pause moved note 5 to 6, confirmed by screenshot. |
| Missing values mistaken for an empty scope | `localsReady` distinguishes pending locals from an observed empty list. |
| Native WebMCP unavailable | Codex browser discovery returned no tools; real UI verification used the public HTTP API. |

Browser checks used two isolated multifile programs: queue/worker at worker:6 and a second program
at helper:3 containing `0`, `false`, `''`, `null`, an array and an object. The second inspector
opened with native mouse input. These checks do not establish hover behavior or every viewport.

## How it fits together

```
runtime (node node/bin/tracelight.mjs serve, or --runtime "CMD ARGS")
   │ NDJSON on stdio, docs/PROTOCOL.md
web/server.ts  ── the bridge: spawns it (RunnerClient), runs the file, watches it,
   │              relays events and requests, serves the page, the agent API;
   │              a second runtime for the live debugger, a third per Profile;
   │              recent files and Open; Narrate and the tour
   │              (web/serverViews.ts) over the run it keeps (web/runState.ts)
   │ WebSocket /ws, web/bridgeProtocol.ts
web/pageHost.ts ── the page's stand-in for the extension host: keeps the run and the
   │               Time Machine position, sends the panel HostToWebview messages;
   │               web/panes.ts answers the other views with the extension's builders,
   │               web/debugHost.ts is the live debugger, web/story.ts the Code Story,
   │               web/profileSummary.ts the profile table
webview/App.tsx (unchanged) + web/codePane.ts (Monaco) + web/debugPane.tsx
```

The page reuses only vscode-free modules of the extension: FileTable, TraceModel, and the
walkthrough, exceptions, variable history, provenance, execution graph, HTTP table and tour panel
builders, and the Code Story's document rules (`src/session/storyLines.ts`). `node:path`, which the walkthrough builders import, is swapped for `web/pathShim.ts` in
the page bundle.

## Security

The bridge listens on 127.0.0.1 only. It refuses a WebSocket or an API call whose `Host` is not
`127.0.0.1`/`localhost` on its port (DNS rebinding) or whose `Origin`, when sent, is another site,
and `POST /api/command` must be `application/json`, which a cross-site page cannot send without a
preflight the bridge never approves. The page can read only files a run instrumented and the HTTP
recording the run wrote.
Anyone with a shell on the machine can drive it, as with the runtime itself.

`ctl peek NAME` opens the paused value hover through the same command used by WebMCP. `ctl peek --hide` dismisses it. Nested arrays and objects keep indentation in the syntax-highlighted hover. WebMCP registers on `document.modelContext`, with compatibility for older navigator APIs.


The visible scratchpad has a complete agent lifecycle through `tracelight_scratchpad` WebMCP
and the same `/api/command` bridge: `op: experiment|open|close|state|update|run|restore|create|save|list|load|history`. `update` replaces
any supplied `code`, `inputs`, `mocks` and `autoRun` atomically. Give every explicit mock a
`mockLabels` entry. `run` awaits execution; `state` returns code, JSON/text inputs and mocks,
labels, captured provenance, revision, status, runtime errors, missing fixture paths, values,
console output, cap flags and application error fields from the result. A completed worker can
still return an application error. Fixtures remain synthetic, and the captured original inputs
retain unavailable markers. The controls share Monaco models and manual Run's isolated worker.
No scratch operation sends a live debugger execution request or makes real provider calls.

CLI: `ctl scratchpad open [--line N]`, `close`, `state`, `run`, `restore`, or
`update --data /absolute/experiment.json`. The JSON file contains the update fields above.
See `skills/tracelight/references/scratchpad.md` for the preparation and explanation workflow.

Named scratchpads autosave creation, edits, names and completed results under
`$TRACELIGHT_HOME/scratchpads` (default `~/.tracelight/scratchpads`). `create` makes a
separate experiment, `list` finds saved copies, `history` reads immutable versions,
`load` reopens without execution and `save` adds an optional checkpoint. The pane exposes
the library, version history and autosave status. CLI accepts `--id`, `--title` and
`--version`. Use `experiment --data FILE` for complete prepared teaching packages.
