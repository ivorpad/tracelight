# The browser page

The Tracelight panel, a code pane and the Time Machine in a plain browser tab, outside VS Code. A
small local bridge runs the file with the runtime, re-runs it when it changes on disk (not while
the page's debugger has a run), and relays everything to the page over a WebSocket. An agent
drives the page with `tracelight web ctl`, and every command answers with where the page is now.

Use it to teach a person who watches a browser rather than their editor (narration bubbles sit
under the line being explained), next to VS Code in its Simple Browser, or to debug a program with
breakpoints and steps without touching anyone's VS Code window. When nobody is watching, the CLI
over a saved run is cheaper: the page only adds what a person sees.

Contents: [Start it](#start-it) · [A page must be open](#a-page-must-be-open) ·
[Commands](#commands) · [What each answers](#what-each-answers) ·
[The live debugger on the page](#the-live-debugger-on-the-page) · [Narration](#narration) ·
[HTTP API and WebMCP](#the-http-api-and-webmcp) · [Layouts](#layouts) · [Limits](#limits) ·
[Stop it](#stop-it)

## Start it

```
tracelight web FILE [--port N] [--open] [--no-run] [--no-watch] [--verbose] [--runtime js|node|bun|"CMD ARGS"] [--node PATH]
tracelight web -h | --help
```

```sh
tracelight web examples/js/rrf/demo.ts --port 4790 --open
# Tracelight: http://127.0.0.1:4790/  (demo.ts, re-runs on save; Ctrl+C stops)
```

It serves until it is stopped, so start it in the background (your harness's background mode, or
`... > "$S/web.log" 2>&1 &` and keep the PID) and wait for the URL to answer before the first
`ctl`: `until curl -s -o /dev/null http://127.0.0.1:4790/; do sleep 0.2; done`.

- `--port N`: default 4777, or `$TRACELIGHT_PORT`. Another page may hold 4777 already: the error
  says `port 4777 is taken` and `tracelight web ctl --port 4777 state` names that page's file. Pick
  a free port and pass the same `--port` to every `ctl`.
- `--open`: open the page in the default browser, for a person at this machine.
- `--no-run`: serve the source without executing it on startup. For live teaching or debugging,
  open the page, set breakpoints, then issue `debug start`. Without the flag, startup runs the
  file once. It skips only that run: explicit Run and page edits under Automatic mode still
  execute code.
- Watching is on by default; always start with it. A save in any editor refreshes the page's
  source. While the page's debugger has a run, paused or running, neither a save nor a settings
  change executes anything: the paused program keeps the code it loaded, and `position` reports
  the visible source as changed. Between debug runs a save runs the file under the page's run
  mode (Automatic and On Save run it, On Demand does not). Typing in the page's code pane runs the
  edited buffer under Automatic mode, and Ctrl/Cmd+S writes the file and runs it under On Save,
  both even while the debugger is paused.
- `--no-watch` is optional: a change on disk still refreshes the source but never runs the file.
  Pass it when the person wants that. Run, `debug start` and `debug restart` still execute.
- `--verbose`: log the runtime's spawn, stderr and exits to stderr.
- `--runtime "CMD ARGS"` (or `$TRACELIGHT_RUNTIME`): any command that speaks the runtime's NDJSON
  protocol on stdio, started in the file's directory. `js`, the default for `.js`, `.mjs`, `.cjs`,
  `.jsx`, `.ts`, `.mts`, `.cts` and `.tsx`, is the runtime shipped next to the bridge.
- `--runtime node` explicitly selects Node for the program; `--runtime bun` selects native Bun.
  The CLI and bridge protocol server still run on Node. `--node PATH` selects a specific Node
  or Bun executable and overrides the alias and `$TRACELIGHT_NODE`.
  Bun recording, disk reloads, live breakpoints, stepping and captured locals use Bun's loader
  and JavaScriptCore inspector. Bun worker recording and V8 CPU profiles are unavailable.
  Pure evaluation and expression watches are refused because Bun's inspector cannot enforce
  `throwOnSideEffect`; captured locals remain available. Explicit `exec` uses native evaluation.
  Finished recordings without a debugger provide recorded values, not finished-run evaluation.
  Bun's source-returning loader does not preserve CommonJS exports. Instrumented CommonJS
  modules are refused with a runtime error; use Node for those modules.
- Narrate and the tour on the page call a model through `$TRACELIGHT_EXPLAIN_COMMAND` (a command
  that reads the prompt on stdin), else `claude -p`, else `codex exec`.

`tracelight web` runs the bridge that ships next to the runtime (`dist/web/server.js`). A runtime
older than the verb prints the top-level usage without `web`; from a Tracelight checkout,
`npm run build` and run `node <checkout>/dist/web/server.js` with the same arguments, and
`node <checkout>/dist/web/server.js ctl ...` for the commands.

## A page must be open

The bridge only relays: the page in the browser carries out every command except `profile`. With no page connected, a command answers `{"result": null, "error": "no page is
open: open http://127.0.0.1:4790/ first"}` and exits 1. `tracelight web ctl state` says how many
are connected (`"pages": 1`), so read it first.

- A person is watching: `--open`, or give them the URL.
- Nobody is, and you still need the page (to check it, or for its debugger): hold it open in
  headless Chrome, with a profile directory of your own so the user's browser is untouched.

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
  --no-first-run --user-data-dir="$S/chrome" --remote-debugging-port=0 http://127.0.0.1:4790/ \
  > "$S/chrome.log" 2>&1 & chrome=$!
until tracelight web ctl --port 4790 state | grep -q '"pages": 1'; do sleep 0.2; done
```

The bridge requires exactly one page for control and state reads. Multiple pages, concurrent
commands and a disconnected target return errors; no cached state is reported as a fresh reply.

## Confirm the visible position

Navigation replies include `position`, confirmed after rendering from Monaco's actual model,
highlight and visible ranges. Require `ready: true` before narrating source or values. `source`
is the editor's visible file/line/code/highlight; `activePane` distinguishes source from Story.
`recorded` and `live` each carry run, step, frame, file, line, function and source text. A selected
recording step does not describe the live pause. `recordedDiffersFromLive` makes that difference
explicit. `sourceMatches` compares the editor with the run's source, and `blockers` identify
hidden/out-of-view, edited/stale, changed-position or mismatched presentation.

`tracelight_position({mode: "live", focus: true})` reveals the paused frame; use debugger moves
and captured live values for a live lesson. `mode: "recorded"` reveals the selected recording's
source and highlight, closes Story without stopping navigation, and hides live value overlays.
Declare that this is a recorded moment and use recorded values. The live program stays paused
where it was. `mode: "visible"` checks the current presentation without changing its selection.
CLI uses `position live|recorded|visible --focus true|false`. Do not teach until a blocked
position is repaired and confirmed. Never infer visible source from legacy `location` or `step`.

The HTTP/CLI bridge refuses control when multiple pages are connected, before dispatching any
command. State returns 409 with the page count and a blocker instead of guessing from cached
state. Use tab-bound WebMCP or close duplicate pages. A connected page is required to confirm
visible position.

## Commands

Every command prints the bridge's JSON reply and exits 0, or 1 when the page answered an error,
or 2 for a usage error or when nothing is served on the port. `--port N` goes on every one.
Exit 1 also covers an unconfirmed position after navigation or explicit position confirmation,
and scratchpad experiment/run replies with incomplete execution, missing mocks, runtime or
application errors, or a changed live execution. The full reply remains on stdout for repair.
State reads remain informational; a live control that reaches the end of a run succeeds but
does not establish a paused position suitable for teaching.

```
tracelight web ctl [--port N] state
tracelight web ctl position live|recorded|visible [--focus true|false]
tracelight web ctl start
tracelight web ctl stop
tracelight web ctl goto STEP [--say TEXT]
tracelight web ctl step into|over|out|back|backOver|backOut [--say TEXT]
tracelight web ctl line LINE [--file FILE] [--say TEXT]
tracelight web ctl say TEXT [--line N] [--step N] [--file FILE] [--id ID] [--kind explanation|prediction]
tracelight web ctl clear [--id ID]
tracelight web ctl values NAME... [--file FILE] [--line N]
tracelight web ctl values --all|--hide
tracelight web ctl peek NAME | peek --hide
tracelight web ctl inspect open|close NAME...
tracelight web ctl run
tracelight web ctl eval EXPR
tracelight web ctl var NAME
tracelight web ctl why NAME [--step N]
tracelight web ctl watch EXPR [--remove]
tracelight web ctl break LINE [on|off] [--file FILE] [--if COND]
tracelight web ctl debug start|restart|continue|pause|stop|state [--say TEXT]
tracelight web ctl debug step [into|over|out] [--say TEXT]
tracelight web ctl story
tracelight web ctl profile
```

| command | what it does |
|---|---|
| `state` | reads where the page is, moves nothing |
| `start`, `stop` | start the Time Machine at step 0, or stop it |
| `goto STEP` | the Time Machine to a recorded step (0-based), starting it if needed |
| `step KIND` | a Time Machine move: `into`, `over`, `out`, or back with `back`, `backOver`, `backOut`; with the Time Machine off, any `step` starts it at step 0 |
| `line LINE` | the next time line LINE of the shown file runs after the current step, else its first run (and the first run when the Time Machine is off) |
| `say TEXT` | a narration bubble under the current line, or `--line N`; `--step N` moves there first |
| `clear` | removes all notes, or one with `--id ID` |
| `values` | selects actual paused-frame bindings by name; `--all` restores all, `--hide` hides the visible row. Modes are `selected`, `all`, `none`. Hovers retain all current bindings. |
| `run` | runs the file again and waits for it to finish |
| `eval EXPR` | while the page's debugger is paused, an expression in the paused frame; otherwise a side-effect-free expression over the recorded run's finished state, at module scope |
| `var NAME` | every recorded change of NAME, and opens the Variable History view for the person |
| `why NAME` | where NAME's value came from after `--step N` (default: the Time Machine's step); an empty NAME explains the statement |
| `watch EXPR` | adds a Time Machine watch, starting it if needed; `--remove` drops the watch with that text |
| `break LINE` | toggles a breakpoint in the main file or a known imported source named with `--file FILE`; `on` or `off` sets it, `--if COND` makes it conditional (`breakpoint` is the same command) |
| `debug OP` | the page's live debugger: `start`, `continue`, `step` (`over` by default, or `into`, `out`), `pause`, `stop`, `state` |
| `story` | opens the Code Story in the code pane and returns its text |
| `profile` | one run under the profiler, on a runtime of its own; returns the hottest functions |

Quote anything your shell would split or expand (spaces, quotes, brackets, `*`):
`tracelight web ctl eval "DISCOUNTS[order.tier]"`, `tracelight web ctl say "base = 2 × 3.5 = 7"
--line 4`. The words after the command are joined with spaces into TEXT, EXPR or NAME; a word that
starts with `--` is a flag and takes the next word as its value.

Commands also accept `--expect-source live|recording`, `--expect-run ID`, `--expect-step N`,
`--expect-frame N` and `--expect-file PATH`. Copy the expected context from `state.context`;
a mismatch rejects the command before changing presentation or execution. Recorded navigation can review history while the live debugger stays paused. Use the returned
position to confirm the selected source; use `debug step` to advance live execution.

## What each answers

`state` answers `{url, file, runtime, pages, state}`. `runtime` is what the bridge spawned and the
runtime's handshake (`runtimeVersion`, `nodeVersion`, `capabilities`; `pythonVersion` is an old
protocol field and holds Node's version too). `state` is the page's position, `null` before a page
connected:

```
{runId, running, file, steps, timeMachine, step, location: {file, line, function}, code,
 locals: [{name, text}], stack: [{function, line, step}], values: [{line, context?, text, step}],
 output, errors: [{type, message, line}], narration: {text, line} | null}
```

`state.context` identifies the active live or recording run, pause, frame, source file, line and
locals readiness. Top-level execution fields retain the recording contract. `notes[].observed`
identifies the context in which a note was written, and `noteRendering` confirms its actual
rendered and visible state. Notes, values and inspection commands wait for presentation.

`steps` is the size of the last recording, `step` the Time Machine's position (`null` while it is
off), `code` the source line at `location`, `locals` the variables recorded at the step (the page
records every changed local), `values` what was logged up to the step.

| command | `result` |
|---|---|
| `start`, `stop`, `goto`, `line`, `say`, `clear`, `run` | the same `state` object |
| `step` | `{moved, state}`; `moved: false` when the move had nowhere to go (the edge of the run) |
| `eval` | `{text}`, and `at` (`"queue.ts:15"`) when it ran in a debugger pause |
| `var` | `{name, changes: [{step, line, function, file, source, text?}]}`; a change without `text` was assigned but its value was not recorded |
| `why` | the provenance tree: `{name, step, depth, nodes, truncated, recordedLocals, root, conclusion}` |
| `watch` | `{step, watches: [{exp, value?, text?, error?, at?}]}`; a new watch costs one run of the file around the step |
| `break` | `{line, on, breakpoints: [{line, condition?}]}` |
| `debug ...` | `{running, paused, reason, location: "file:line", stack: [{name, file, line}], locals: [{name, text}], output}`; `{running: false}` before a start; `reason: "ended"` once the program finished |
| `story` | `{text}`, the run as one document, one block per pass through a scope |
| `profile` | `{path, totalMs, rows: [{name, file, line, selfMs, totalMs}]}`, top 20 by self time; `path` is the `.cpuprofile` |

An error is `{"result": null, "error": "..."}` with exit 1: `no page is open`, `the page did not
answer` (a page gets 15 seconds), `nothing recorded yet: the run has no trace`, `name a step, or
start the Time Machine first`, `no recorded run to tell: run the file first`, or the program's own
error from `eval` (`ReferenceError: nope is not defined`).

The replies are big (every local of every frame, the runtime's capability list in `state`). Read
the fields you need with a JSON tool rather than pasting the reply:

```sh
tracelight web ctl --port 4790 debug continue | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).result??{};console.log(r.reason,r.location,(r.locals??[]).map(l=>l.name+" = "+l.text).join(", "))})'
```

## The live debugger on the page

`debug start` runs the file for real on its debugger runtime and captures that same execution
for Code history. It needs no preliminary recording. Breakpoints come from `break LINE` (or
gutter clicks, F9), stay set across debug runs, and can target a known imported source with
`--file FILE`. Set several before starting, then use `debug continue` to resume between them.
Check the returned location: an earlier breakpoint or exception may intercept the route.

```sh
tracelight web ctl --port 4790 break 32 on
tracelight web ctl --port 4790 break 27 on --if "item.qty > 2"
tracelight web ctl --port 4790 debug start          # paused at 32, reason "breakpoint", with the frame's locals
tracelight web ctl --port 4790 eval "order.tier"    # in the paused frame: {"text": "'gold'", "at": "invoices.ts:32"}
tracelight web ctl --port 4790 debug continue       # the next breakpoint, or the end
tracelight web ctl --port 4790 debug step into      # into the call on that line
tracelight web ctl --port 4790 debug stop
```

Each move waits for the next pause or the end and answers with it. The person sees the stop in the
code pane, with the call stack, the variables and the controls under it (F5, F10, F11, Shift+F11,
Shift+F5).

`debug start` follows VS Code's rule: it runs to the first breakpoint, and pauses at the first
statement (`reason: "start of the run"`) only when no breakpoint is set in a file the run
touches. A run that ends without pausing answers `{running: false, ...}` as soon as it ends. While
the debugger is paused, `eval` runs in the paused frame and answers with `at`, the place it ran;
at the start pause the file's own names may not exist yet (`ReferenceError: jobs is not
defined`), since that statement has not run.

Differences from the VS Code debugger, each with what to do:

- **`debug pause` on a program that is already paused** returns the existing pause immediately.
- **A move longer than 10 seconds** (a server waiting for a request) returns an error when no new
  pause or end can be confirmed. Read `debug state` before retrying; the program can still run.
- `ctl` has no command for watches that pause the run, for where exceptions pause (the person
  sets that in the Debugger view), for `exec`, function breakpoints or recording. The VS Code
  debugger has all of them ([live-debugger.md](live-debugger.md)).

These may change with the page; when a stop does not match this list, believe the stop.

## Narration

`--say TEXT` on `goto`, `step`, `line` and `debug` puts a bubble under the new line for the person
watching. A Time Machine move without `--say` clears the bubble; a `debug` move without it leaves
the last bubble where it was, so `clear` before a silent debug move. `say TEXT --line N` places a
bubble without moving, and `--step N` moves the Time Machine first. `state` reads the bubble back
as `narration`.

Write the bubble for the stop it lands on, after you have its values: move with the plain command,
read the reply, then `say` what those values mean. A bubble written before the move describes a
line the person may not be looking at.

## The HTTP API and WebMCP

`tracelight web ctl` is a client of the bridge's API, which any HTTP client can call:

- `GET /api/state`: the `state` reply above, or 409 when no single responding page is available.
- `POST /api/command` with `content-type: application/json` and one command as JSON:
  `{"action": "step", "kind": "over", "say": "..."}`, `{"action": "goto", "step": 42}`,
  `{"action": "line", "line": 19}`, `{"action": "say", "text": "...", "line": 13}`,
  `{"action": "eval", "expression": "..."}`, `{"action": "var", "name": "total"}`,
  `{"action": "why", "name": "total", "step": 13}`, `{"action": "watch", "exp": "...", "remove": true}`,
  `{"action": "breakpoint", "line": 11, "on": true, "condition": "i > 2"}`,
  `{"action": "debug", "op": "step", "kind": "into"}`, and `start`, `stop`, `clear`, `run`, `story`,
  `profile` with no other field. 200 with `{result}`, 409 with `{result: null, error}`.
- `GET /api/profile`: the last profile's `.cpuprofile` as a download, 404 before one ran.
- `POST /api/definitions` with JSON `{file, content, offset}` resolves a known source file's
  symbol to implementation paths, source text and editor ranges without executing imports.
  Unknown source files are refused; resolved targets can then be opened through `file.read`.

The bridge listens on 127.0.0.1 only and answers 403 to a request whose `Host` is not
`127.0.0.1`, `localhost` or `[::1]` on its port, or whose `Origin` is another site; a POST that is
not `application/json` gets 415. The page can read only files a run instrumented and the HTTP
recording the run wrote.

An agent that works inside the browser gets the same commands as WebMCP tools when the browser
offers `document.modelContext` (with a fallback for older navigator APIs) (the header then shows a WebMCP chip): `tracelight_state`,
`tracelight_goto`, `tracelight_step`, `tracelight_wait_pause`, `tracelight_position`, `tracelight_line`, `tracelight_say`, `tracelight_values`, `tracelight_peek`, `tracelight_inspect`, `tracelight_run`,
`tracelight_eval`, `tracelight_var`, `tracelight_why`, `tracelight_watch`, `tracelight_breakpoint`,
`tracelight_story`, `tracelight_profile`, `tracelight_debug`. A browser-automation agent can also
call `window.tracelight`, the page's host object, directly.

## Layouts

The learning view's **Code history** button opens executed code in order in a side panel,
keeping the current source visible. Browser debug runs record the same execution that pauses.
History follows each live pause by default. Its recording controls review earlier events
without advancing the program, and the banner changes to “reviewing an earlier step”.
**Return to current pause** restores following. A run started by an older bridge without
recording shows history as unavailable, never a previous run as its substitute.
The same Code history button closes the panel. Drag its divider to resize it.

The separate **Inline values** toggle shows captured values beside variable declarations.
Repeated observed changes appear as a short value sequence; hover shows the captured values
with syntax highlighting and their pause provenance. The toggle remembers the preference.
Hiding inline values leaves variable hovers working.
The values come from visited pauses of this live execution, not a full execution recording.
A new debug run clears them. Editing the source hides snapshots that no longer match it.
Values from earlier pauses are unavailable after reconnecting unless captured during this visit.

`http://127.0.0.1:4790/` is the code pane next to the panel; `?layout=panel` drops the code pane
and `?layout=code` shows it alone; the header's layout button cycles the three, and a window
narrower than 760px stacks the code over the panel. Next to VS Code: run **Simple Browser: Show**
with `http://127.0.0.1:4790/?layout=panel`, since the editor is beside it.

The panel is the extension's: Entries, Details, Compare, Exceptions, the Walkthrough, Variable
History, the Execution Diagram, HTTP (record and replay from its mode menu), Narrate and the Tour,
the Debugger view, the Code Story (the rail's book button) and Profile (the rail's pulse button).
Settings changes the run config for the page's later runs (Auto Log, library code, record locals,
secret masking, timeout, HTTP mode) and its run mode (Automatic, On Save, On Demand). `tracelight
web` has no flags for these; a person sets them in the page.

## Limits

- One main file at a time, of one runtime's language. View Recent Files (kept in
  `~/.tracelight/recent.json`) opens only files of that language under the starting file's
  directory.
- The page's run records locals at every step, with HTTP off, unless the page's Settings say
  otherwise.
- `break --file FILE` targets a source known to the page. Library code must be instrumented
  for its breakpoints to pause. An unknown source cannot yet be a browser breakpoint target.
  For imported sources outside the caller's directory, include their directory with `--only`
  alongside the caller's directory. Once imports load, their source paths become breakpoint targets.
  Known imported sources refresh automatically after disk edits, including atomic saves.
  Changes refresh the source while paused or in on-demand mode without restarting execution.
  An edited imported source blocks the visible-position gate for the old run; restart explicitly
  before teaching from new execution values.

## Stop it

Ctrl+C in its terminal, or `kill` the PID you kept; kill the headless browser too. Leave it
running only when the person is still using it, and tell them the URL and port.

Notes accept a known source `--file`, positive `--line`, and stable `--id` for replacement. `--kind prediction` labels a prediction separately from an explanation. `tracelight_values` accepts `mode`, `names`, `file`, and `line`; it selects existing locals without evaluation or source edits. Replies include the observed run, step, frame and source location. Values refresh on stepping and vanish on resume. Notes remain separate from runtime observations.

`peek NAME` opens the syntax-highlighted hover on a binding in the selected paused frame. Arrays and objects are indented. `peek --hide` dismisses it. WebMCP `tracelight_peek` takes `name` (empty to dismiss). Peeks show only captured bindings and serialized properties, never evaluate an expression, and return pause provenance. They navigate to the selected frame’s source before showing the hover.

`inspect open NAME...` opens a focused value card beneath the live paused line and replaces its selection atomically. Choose all relevant bindings first and open them in one call. `inspect close NAME...` removes those bindings, and the card's close button dismisses all. WebMCP `tracelight_inspect` takes `names` and `open`; the legacy single `name` is also accepted. Use `{"names":["input","options"],"open":true}` for a complete selection rather than a call per binding. The card uses the captured, syntax-highlighted value tree, loads nested fields on expansion, and clears when the pause changes. Expand taught fields and leave unrelated metadata collapsed. A runtime cap remains explicit. Verify the card is visible before teaching from it.

Function inspection can include captured runtime `functionSource` and `functionLocation` with a source link. Use those fields to explain the actual runtime function when available. An LSP signature or declaration adds static context; a parameter declaration is not the source of the runtime callback. Do not claim runtime source or identity when the captured fields are unavailable.

`tracelight_wait_pause` supports active teaching while the user steps manually. Without `after`,
it returns the current cursor immediately. With `after`, it waits event-driven for a newer live
pause, matching captured locals, and ready presentation; `timeoutMs` is at most `25000`. Its
reply is `{cursor, changed, state, source}`. Live state and control replies, including this wait,
carry a debug summary with `runId`, `step`, `frame`, nearby source, and each local's captured
`valueBag`. Explain directly from the returned source and structured values, retaining capped
and unavailable markers. Extra inspection calls are needed only for relevant missing detail or
a user-requested visible inspector. Explain a changed pause, then re-arm with its cursor.
The tool does not advance execution or open an overlay. It is a wait inside the agent's turn, not
an integration that wakes an idle or ended chat. Take the first cursor when the page connects,
including `--no-run` sessions, before `debug start` or handing over the controls, and take a fresh
one after reconnecting. Arm a wait when a pause is about to happen, and otherwise tell the person
that you explain the latest pause when they write
([explain.md](explain.md#when-the-learner-steps-by-hand)). Chained waits do not make the agent
listen between turns.

`scratchpad open [--line N]` opens a TypeScript scratchpad beside the source. WebMCP
`tracelight_scratchpad` accepts `op: experiment|open|close|state|update|run|restore|create|save|list|load|history`, optional `line`,
and atomic `code`, `inputs`, `mocks`, `mockLabels`, `autoRun` updates. It copies the containing
function and captured inputs, returns current editor state and completed structured results. Code and JSON input edits auto-run in a separate worker. Local helpers
and imports resolve from the source file; external calls need explicit mock fixtures.
The live program remains paused. Missing captured data stays marked unavailable.
For teaching, use ONE `experiment` command with the complete prepared package. It formats code,
publishes no intermediate copy, and awaits one scratch execution. Prepare and repair it before
teaching ([scratchpad.md](scratchpad.md#prepare-before-teaching)), and verify visible indentation
and errors first. Its results show what the copy computes, not how the application wires it.
Bare receiver-dependent copies wait with `needsPreparation`.
`scratchpad close` dismisses the pane without advancing execution.
For the full editing, inspection, mock and verification workflow, read
[scratchpad.md](scratchpad.md).

```sh
tracelight web FILE [--only PATTERN]
tracelight web ctl scratchpad experiment|open|close|state|update|run|restore|create|save|list|load|history [--line N] [--data FILE] [--id ID] [--title TITLE] [--version N]
```

`--only` can be repeated to select project files to instrument.
WebMCP `tracelight_start` starts navigating the recording from its beginning;
`tracelight_stop` stops navigating it. Neither executes the program.

Scratchpads autosave as named experiments with stable IDs and version history. Use
`tracelight_scratchpad` with `create`, `list`, `save`, `load` (`id`, optional `version`) or
`history` (`id`, optional `version`). Creation, edits and completed results persist on the
server under `$TRACELIGHT_HOME/scratchpads` (default `~/.tracelight/scratchpads`). Reopening
never runs code. The pane has saved-scratchpad and history selectors and an autosave status.
`Save checkpoint` adds an optional version. See the scratchpad reference for exact fields.
