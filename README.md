# Tracelight

A JavaScript and TypeScript playground in VS Code. Open a `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`,
`.mts`, `.cts` or `.tsx` file and press `Cmd+K Q` (`Ctrl+K Q`): the file runs on Node, and every
line shows the value it produced. Coverage marks the gutter, the Time Machine steps backwards and
forwards through the run that already happened, and the Debugger pauses the program while it runs.
A CLI, an MCP server, a browser page and a Claude Code plugin read the same runs.

Inspired by [Quokka.js](https://quokkajs.com/). Tracelight began inside the Pyokka repository
(Pyokka is the same tool for Python) and became its own project on 2026-10-11; the two share no
code, command, setting or directory.

## Install

Tracelight is not on the Marketplace yet. Build the vsix and install it:

```sh
npm ci
npm ci --prefix node      # the runtime's dependencies (oxc-parser carries a platform binary)
npm run package           # writes tracelight-<version>.vsix
code --install-extension tracelight-0.3.0.vsix
```

It needs VS Code 1.93 or newer and Node.js 22.18 or newer, from `tracelight.nodePath` or `node`
on PATH. The runtime ships inside the extension, so nothing is installed into your project. A vsix
carries one platform's oxc-parser binary: build it on the platform that installs it.

## What it does

- **Live values.** A value appears next to each line as the file runs. `// ?` after an expression
  logs it, `console.log` lands next to its line, and Auto Log (`tracelight.autoLog`) shows a value
  on every line. Snaps (`/*{{ ... }}*/`) run a snippet inside the file and print beneath it.
- **Coverage** in the gutter: covered, partly covered, not run, and the line an error came from.
- **Time Machine.** `Shift+F5` on a line starts it there. `F10`, `F11` and `Shift+F11` step over,
  into and out; `Ctrl+F10`, `Ctrl+F11` and `Ctrl+Shift+F11` step back. The panel shows the
  timeline, the call stack and watch expressions at the current step.
- **Debugger.** `F5` with a `tracelight` launch configuration (or none, for the active file) runs
  the program at full speed and pauses at gutter breakpoints, conditional and function breakpoints
  and exceptions, with the frame live for evaluation. "Debug Current File (Recording)" also records
  the run, so the Time Machine opens over every pause.
- **Reading a run.** Code Story (the run as one document, one block per call), Why This Value (where
  a value came from), Variable History, the Execution Diagram, Exceptions, the Walkthrough, and a
  Tour of the run that a model can narrate (`tracelight.explain.command`, else `claude`, else `codex`).
- **HTTP.** The HTTP view lists the requests a run made (`http`/`https`, `fetch`, `XMLHttpRequest`).
  `tracelight.http` set to `record` writes them to `.tracelight/replay/`; `replay` answers later runs
  from that file without the network.
- **Profile**: one run under V8's profiler, as a table of functions by self and total time.
- **Packages**: a missing package gets a quick fix that installs it with the project's package
  manager, or for this file only.
- **`worker_threads`**: a worker's steps, values and coverage land in the same trace as the main
  thread's, and breakpoints pause inside worker code.

| Setting | Default | |
|---|---|---|
| `tracelight.nodePath` | `node` on PATH | the Node that runs your files (22.18+) |
| `tracelight.runMode` | `onSave` | `auto` runs as you type, `onSave` on save, `onDemand` only when asked |
| `tracelight.autoLog` | off | a value on every line |
| `tracelight.timeMachine.recordLocals` | off | record every changed local, for Variable History and `why` |
| `tracelight.timeMachine.libraryCode` | off | instrument `node_modules` too, so Step Into enters packages |
| `tracelight.http` | `off` | `record` or `replay` the run's HTTP |
| `tracelight.explain.command` | empty | the command that narrates (reads the prompt on stdin) |
| `tracelight.agentAccess` | off | let local agents read this window's runs and drive it |
| `tracelight.untrustedWorkspaceBehavior` | ask | whether Tracelight runs code in an untrusted workspace |

## For agents

With `tracelight.agentAccess` on, the extension writes `~/.local/bin/tracelight`, a script that runs
the CLI of the installed version. From a checkout, `node node/bin/tracelight.mjs` is the same CLI.

```sh
tracelight run app.ts --save run.json        # record a run
tracelight story run.json --file app.ts      # the map: one step number per line that ran
tracelight step run.json 12 --into           # the Time Machine at step 12, then into the call
tracelight why run.json 40 total             # where the value of total at step 40 came from
tracelight debug app.ts --at main            # start the debugger in VS Code, print the first stop
tracelight state --live                      # the open window's session, without moving anything
```

`tracelight mcp` serves the same commands to MCP clients as six tools: `tracelight_run`,
`tracelight_map`, `tracelight_step`, `tracelight_value`, `tracelight_coverage` and
`tracelight_debug`. For Claude Code: `claude mcp add tracelight -- tracelight mcp`.

`skills/tracelight` is a skill with three modes: `debug` pauses a program and steps it, `explain`
walks a person through a run in their editor, `show` builds a tour or a code-history page from a
run. The command reference is `skills/tracelight/references/tracelight-cli.md`.

The Tracelight band (`claude-plugin/tracelight-band`) shows the Time Machine of the window above
the Claude Code prompt: the code around the step, its values, the stack, a short explanation and the
bugs found in the run. `/tl n` steps, `/tl w` shows where a value came from, `/tl f` writes a fix
plan, and `/tl` alone lists the keys.

```
/plugin install tracelight-band --marketplace ivorpad/tracelight
```

From a checkout: `claude plugin marketplace add /path/to/this/repo`, then
`claude plugin install tracelight-band@tracelight`.

## In a browser

`npm run build`, then `node dist/web/server.js app.ts --open` serves the panel next to a code pane
at http://127.0.0.1:4777/. It re-runs the file when it is saved, runs edits typed in the page, and
has the Time Machine and the Debugger. An agent drives it with
`node dist/web/server.js ctl step over --say "..."`. See [docs/WEB.md](docs/WEB.md).

## Development

```sh
npm ci && npm ci --prefix node
npm run build                 # dist/: extension, panel, browser page, runtime
npm test                      # typecheck, the extension's unit tests, the runtime's tests
npm run test:e2e              # a real VS Code: run and F5-debug a .js and a .ts file
claude plugin test claude-plugin/tracelight-band
```

[docs/HANDOFF.md](docs/HANDOFF.md) has the build and test quirks, [docs/RUNTIME.md](docs/RUNTIME.md)
the runtime's layout, [docs/PROTOCOL.md](docs/PROTOCOL.md) the wire protocol between the extension
and the runtime, [docs/TOUR.md](docs/TOUR.md) the tour format.

## License

MIT
