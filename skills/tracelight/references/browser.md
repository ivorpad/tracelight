# The browser page

The Tracelight panel, a code pane and the Time Machine in a plain browser tab, outside VS Code. A
small local bridge runs the file with the runtime, re-runs it when it changes on disk, and relays
everything to the page over a WebSocket. An agent drives the page with `tracelight web ctl`, and
every command answers with where the page is now.

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
tracelight web FILE [--port N] [--open] [--no-watch] [--verbose] [--runtime js|"CMD ARGS"]
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
- `--no-watch`: do not re-run when the file changes on disk. Without it a save in any editor
  re-runs the file and refreshes the page; typing in the page's code pane runs the edited buffer
  without saving, and Ctrl/Cmd+S in the page writes the file.
- `--verbose`: log the runtime's spawn, stderr and exits to stderr.
- `--runtime "CMD ARGS"` (or `$TRACELIGHT_RUNTIME`): any command that speaks the runtime's NDJSON
  protocol on stdio, started in the file's directory. `js`, the default for `.js`, `.mjs`, `.cjs`,
  `.jsx`, `.ts`, `.mts`, `.cts` and `.tsx`, is the runtime shipped next to the bridge.
- Narrate and the tour on the page call a model through `$TRACELIGHT_EXPLAIN_COMMAND` (a command
  that reads the prompt on stdin), else `claude -p`, else `codex exec`.

`tracelight web` runs the bridge that ships next to the runtime (`dist/web/server.js`). A runtime
older than the verb prints the top-level usage without `web`; from a Tracelight checkout,
`npm run build` and run `node <checkout>/dist/web/server.js` with the same arguments, and
`node <checkout>/dist/web/server.js ctl ...` for the commands.

## A page must be open

The bridge only relays: the page in the browser carries out every command except `state` and
`profile`. With no page connected, a command answers `{"result": null, "error": "no page is
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

Two pages on one bridge both receive every command, and the first answer wins. Keep one.

## Commands

Every command prints the bridge's JSON reply and exits 0, or 1 when the page answered an error,
or 2 for a usage error or when nothing is served on the port. `--port N` goes on every one.

```
tracelight web ctl [--port N] state
tracelight web ctl start
tracelight web ctl stop
tracelight web ctl goto STEP [--say TEXT]
tracelight web ctl step into|over|out|back|backOver|backOut [--say TEXT]
tracelight web ctl line LINE [--say TEXT]
tracelight web ctl say TEXT [--line N] [--step N]
tracelight web ctl clear
tracelight web ctl run
tracelight web ctl eval EXPR
tracelight web ctl var NAME
tracelight web ctl why NAME [--step N]
tracelight web ctl watch EXPR [--remove]
tracelight web ctl break LINE [on|off] [--if COND]
tracelight web ctl debug start|continue|pause|stop|state [--say TEXT]
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
| `clear` | removes the bubble |
| `run` | runs the file again and waits for it to finish |
| `eval EXPR` | a side-effect-free expression over the recorded run's finished state, at module scope |
| `var NAME` | every recorded change of NAME, and opens the Variable History view for the person |
| `why NAME` | where NAME's value came from after `--step N` (default: the Time Machine's step); an empty NAME explains the statement |
| `watch EXPR` | adds a Time Machine watch, starting it if needed; `--remove` drops the watch with that text |
| `break LINE` | toggles a breakpoint on a line of the main file for the page's debugger; `on` or `off` sets it, `--if COND` makes it conditional (`breakpoint` is the same command) |
| `debug OP` | the page's live debugger: `start`, `continue`, `step` (`over` by default, or `into`, `out`), `pause`, `stop`, `state` |
| `story` | opens the Code Story in the code pane and returns its text |
| `profile` | one run under the profiler, on a runtime of its own; returns the hottest functions |

Quote anything your shell would split or expand (spaces, quotes, brackets, `*`):
`tracelight web ctl eval "DISCOUNTS[order.tier]"`, `tracelight web ctl say "base = 2 × 3.5 = 7"
--line 4`. The words after the command are joined with spaces into TEXT, EXPR or NAME; a word that
starts with `--` is a flag and takes the next word as its value.

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

`steps` is the size of the last recording, `step` the Time Machine's position (`null` while it is
off), `code` the source line at `location`, `locals` the variables recorded at the step (the page
records every changed local), `values` what was logged up to the step.

| command | `result` |
|---|---|
| `start`, `stop`, `goto`, `line`, `say`, `clear`, `run` | the same `state` object |
| `step` | `{moved, state}`; `moved: false` when the move had nowhere to go (the edge of the run) |
| `eval` | `{text}` |
| `var` | `{name, changes: [{step, line, function, file, source, text?}]}`; a change without `text` was assigned but its value was not recorded |
| `why` | the provenance tree: `{name, step, depth, nodes, truncated, recordedLocals, root, conclusion}` |
| `watch` | `{step, watches: [{exp, value?, text?, error?, at?}]}`; a new watch costs one run of the file around the step |
| `break` | `{line, on, breakpoints: [{line, condition?}]}` |
| `debug ...` | `{running, paused, reason, location: "file:line", stack: [{name, file, line}], locals: [{name, text}], output}`; `{running: false}` before a start; `reason: "ended"` once the program finished |
| `story` | `{text}`, the run as one document, one block per pass through a scope |
| `profile` | `{path, totalMs, rows: [{name, file, line, selfMs, totalMs}]}`, top 20 by self time; `path` is the `.cpuprofile` |

An error is `{"result": null, "error": "..."}` with exit 1: `no page is open`, `the page did not
answer` (a page gets 10 seconds), `nothing recorded yet: the run has no trace`, `name a step, or
start the Time Machine first`, `no recorded run to tell: run the file first`, or the program's own
`ReferenceError` from `eval`.

The replies are big (every local of every frame, the runtime's capability list in `state`). Read
the fields you need with a JSON tool rather than pasting the reply:

```sh
tracelight web ctl --port 4790 debug continue | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).result??{};console.log(r.reason,r.location,(r.locals??[]).map(l=>l.name+" = "+l.text).join(", "))})'
```

## The live debugger on the page

`debug start` runs the file for real on a second runtime process: nothing is recorded, and the
recorded run and its Time Machine stay as they were. Breakpoints come from `break LINE` (or the
person's clicks in the gutter, F9), stay set across debug runs, and belong to the main file.

```sh
tracelight web ctl --port 4790 break 32 on
tracelight web ctl --port 4790 break 27 on --if "item.qty > 2"
tracelight web ctl --port 4790 debug start          # paused, reason "start of the run"
tracelight web ctl --port 4790 debug continue       # paused at 32, reason "breakpoint", with the frame's locals
tracelight web ctl --port 4790 debug step into      # into the call on that line
tracelight web ctl --port 4790 debug stop
```

Each move waits for the next pause or the end and answers with it. The person sees the stop in the
code pane, with the call stack, the variables and the controls under it (F5, F10, F11, Shift+F11,
Shift+F5).

Differences from the VS Code debugger, each with what to do:

- **`debug start` pauses at the first statement** (`reason: "start of the run"`), even with
  breakpoints set. `debug continue` goes on to the first breakpoint. Narrate after that move, not
  on the start.
- **`eval` does not read the pause.** It evaluates against the recorded run's finished state at
  module scope, so a paused function's names answer `ReferenceError: x is not defined`. Read the
  frame from the stop's `locals` (or `debug state`), and do arithmetic on those values yourself.
  For an evaluation in the paused frame, use the VS Code debugger (`tracelight eval --live`).
- **`debug pause` on a program that is already paused** waits 10 seconds and answers `the page
  did not answer`. Pause only a running program; `debug state` says which it is.
- **A move longer than 10 seconds** (a server waiting for a request) answers `the page did not
  answer` while the program goes on. `debug state` reads it later.
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

- `GET /api/state`: the `state` reply above.
- `POST /api/command` with `content-type: application/json` and one command as JSON:
  `{"action": "step", "kind": "over", "say": "..."}`, `{"action": "goto", "step": 42}`,
  `{"action": "line", "line": 19}`, `{"action": "say", "text": "...", "line": 13}`,
  `{"action": "eval", "expression": "..."}`, `{"action": "var", "name": "total"}`,
  `{"action": "why", "name": "total", "step": 13}`, `{"action": "watch", "exp": "...", "remove": true}`,
  `{"action": "breakpoint", "line": 11, "on": true, "condition": "i > 2"}`,
  `{"action": "debug", "op": "step", "kind": "into"}`, and `start`, `stop`, `clear`, `run`, `story`,
  `profile` with no other field. 200 with `{result}`, 409 with `{result: null, error}`.
- `GET /api/profile`: the last profile's `.cpuprofile` as a download, 404 before one ran.

The bridge listens on 127.0.0.1 only and answers 403 to a request whose `Host` is not
`127.0.0.1`, `localhost` or `[::1]` on its port, or whose `Origin` is another site; a POST that is
not `application/json` gets 415. The page can read only files a run instrumented and the HTTP
recording the run wrote.

An agent that works inside the browser gets the same commands as WebMCP tools when the browser
offers `navigator.modelContext` (the header then shows a WebMCP chip): `tracelight_state`,
`tracelight_goto`, `tracelight_step`, `tracelight_line`, `tracelight_say`, `tracelight_run`,
`tracelight_eval`, `tracelight_var`, `tracelight_why`, `tracelight_watch`, `tracelight_breakpoint`,
`tracelight_story`, `tracelight_profile`, `tracelight_debug`. A browser-automation agent can also
call `window.tracelight`, the page's host object, directly.

## Layouts

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
- `break` sets breakpoints in the main file only.

## Stop it

Ctrl+C in its terminal, or `kill` the PID you kept; kill the headless browser too. Leave it
running only when the person is still using it, and tell them the URL and port.
