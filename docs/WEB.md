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
or any other editor updates the page. Typing in the page's code pane runs the edited buffer
without saving it, Quokka-style; Ctrl/Cmd+S writes it to disk.

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
| `--runtime "CMD ARGS"` | any command that speaks the protocol on stdio, started in the file's directory (`TRACELIGHT_RUNTIME`); the only way to run a file of another language |
| `--open` | open the page in the default browser |
| `--no-watch` | do not re-run on save |
| `--verbose` | log the runtime's spawn, stderr and exits |

## Side by side with VS Code

Run the bridge on the file, then in VS Code run **Simple Browser: Show** with
`http://127.0.0.1:4777/?layout=panel`. `?layout=panel` drops the code pane, since VS Code's editor
is next to it; `?layout=code` shows the code pane alone. The layout button in the header cycles
through the three. A window narrower than 760px stacks the code over the panel.

## Agents: step through code while explaining

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
node dist/web/server.js ctl debug start    # the live debugger: continue | step [into|over|out] | pause | stop | state
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

## Learning layout

Aprender wraps long source lines to the code pane's width. Values below the pause show a disclosure
arrow only when there is detail to open. Opening a container shows its properties once, with child
containers collapsed; simple scalars remain visible in full. Empty strings in a tree appear as `""`.
A runtime truncation marker still describes the runtime's preview, not a complete captured value.

Notes keep the requested file and line. Replacing the same note ID updates that location and text.
A note written at a different run, step or frame is labelled `contexto anterior`; a note deliberately
placed on another line says `fuera de la pausa actual`. Neither label removes the explanation.
Notes and value rows measure their rendered height after wrapping. Resizing preserves open child
values and keyboard focus within the current pause. A new pause resets expansions to avoid showing
a tree fetched from a previous frame.
