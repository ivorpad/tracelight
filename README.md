# Tracelight

Tracelight runs a JavaScript or TypeScript file inside VS Code and shows what happened in it: the
value each line produced, next to the line; which lines ran; and a recording of the whole run that
you can step through backwards and forwards. A debugger pauses the real program when you need it
live. A CLI, an MCP server, a browser page and a Claude Code plugin read the same runs, so an agent
can follow what you see or drive it for you.

It is inspired by [Quokka.js](https://quokkajs.com/). Tracelight was developed inside the Pyokka
repository (the same tool for Python) and became its own project on 2026-10-11. The two share no
code, command, setting or directory. A `.py` file gets a pointer to Pyokka and nothing else.

## Install

Tracelight is not on the Marketplace. Build the vsix from this checkout and install it:

```sh
npm ci
npm ci --prefix node      # the runtime's own dependencies (oxc-parser carries a platform binary)
npm run package           # writes tracelight-<version>.vsix
code --install-extension tracelight-0.3.0.vsix
```

Two things catch people out. Installing a vsix whose version is already installed changes nothing
unless you add `--force`. And installing never restarts an extension host that is already running:
the window keeps the old code until **Developer: Reload Window**, so a fix you just installed looks
absent. The status bar item's tooltip shows the build stamp of the code that is running.

You need VS Code 1.93 or newer and Node.js 22.18 or newer, from `tracelight.nodePath` or `node` on
PATH. The runtime ships inside the extension, so nothing is installed into your project. A vsix
carries one platform's oxc-parser binary: build it on the platform that installs it. The extension
activates when a JavaScript or TypeScript file opens.

## First run

1. Open a `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts` or `.tsx` file and press `Cmd+K Q`
   (`Ctrl+K Q`). The file runs on Node and every line that produced a value shows it.
2. Edit and save. In the default run mode, `onSave`, each save runs the file again.
3. Put the cursor on a line and press `Shift+F5`. The Time Machine opens the recorded run there;
   `F10`, `F11` and `Shift+F11` step over, into and out, and `Ctrl` with the same keys steps back.
4. Click the gutter to set a breakpoint and run **Tracelight: Debug Current File**. The program runs
   for real and pauses on that line, with the frame's variables in VS Code's debug views.

`examples/` has `demo.ts` and two small JavaScript projects (`examples/js/invoices`,
`examples/js/rrf`) to try it on.

## What it does

**Live values.** A value appears after each line as the file runs. `// ?` after an expression logs
it, `console.log` lands next to its own line, and Auto Log (`tracelight.autoLog`) shows a value on
every line. Hovering an expression shows its value from the finished run (`tracelight.valuePeek`).
Outside `auto` mode that runs nothing again, and a hover only evaluates code without side effects,
so it never calls one of your functions. Snaps (`/*{{ ... }}*/`) run a snippet inside the file and
print beneath it.

**Coverage** in the gutter: covered, partly covered, not run, and the line an error came from.

**Time Machine.** The run is recorded step by step. `Shift+F5` starts the Time Machine on the
current line and stops it again. Besides stepping, `F5` and `Ctrl+F5` run forward or back to the
cursor's line and `F8` and `Ctrl+F8` to a breakpoint. The panel shows the timeline, the call stack
and watch expressions at the current step, and the editor shows values as of that step
(`tracelight.timeMachine.inlineValues`).

**Reading a run.** Code Story shows the run as one document, one block per pass through a scope.
Why This Value traces where a value came from. Variable History lists every change of a variable
(it needs `tracelight.timeMachine.recordLocals` for locals). There is also the Execution Diagram,
the Exceptions view and the Walkthrough, plus a Tour of the run that a model can narrate
(`tracelight.explain.command`, else `claude`, else `codex`).

**Debugger.** The runtime's own pause, not Node's inspector: the program runs at full speed and
stops at gutter breakpoints, conditional and function breakpoints, and exceptions, with the frame
live for evaluation. **Debug Current File (Recording)** also records the run, so the Time Machine,
the Code Story and `why` open over every pause. Breakpoints pause inside `worker_threads` code
too, and a worker's steps, values and coverage land in the same trace as the main thread's.

**HTTP.** The HTTP view lists the requests a run made (`http`/`https`, `fetch`, `XMLHttpRequest`).
`tracelight.http` set to `record` writes them to `.tracelight/replay/`, and `replay` answers later
runs from that file without the network.

**Profile** runs the file once under V8's profiler and shows a table of functions by self and total
time.

**Packages.** A missing package gets a quick fix that installs it into the project with its package
manager, or for this file only.

**Secrets** are masked in every value Tracelight shows, by where the value came from rather than by
what it looks like: secret-named environment variables anywhere, and strings stored under secret
names (`tracelight.secrets.mask`, `tracelight.secrets.names`).

**Library code** stays out of the recording unless you opt in with
`tracelight.timeMachine.libraryCode`. Node's own modules are never instrumented.

## Keys

| macOS | Windows, Linux | Command | When |
|---|---|---|---|
| `Cmd+K Q` | `Ctrl+K Q` | Start on Current File | a JS/TS editor |
| `Cmd+K S` | `Ctrl+K E` | Stop Current | a session is running |
| `Cmd+K V` | `Ctrl+K V` | Show Value | the editor runs Tracelight |
| `Cmd+K X` | `Ctrl+K X` | Copy Value | the editor runs Tracelight |
| `Cmd+K I` | `Ctrl+K I` | Install Missing Package only for this file | the editor runs Tracelight |
| `Cmd+K L` | `Ctrl+K L` | New File | a JS/TS editor |
| `Cmd+K J` | `Ctrl+K J` | New JavaScript File | a JS/TS editor |
| `Esc`, `Esc Esc` | same | clear the line's value, clear every value in the file | the editor runs Tracelight |
| `Shift+F5` | same | start the Time Machine on the current line, or stop it | not debugging |
| `F11`, `F10`, `Shift+F11` | same | step into, over, out | the Time Machine is open |
| `Ctrl+F11`, `Ctrl+F10`, `Ctrl+Shift+F11` | same | step back into, over, out | the Time Machine is open |
| `F5`, `Ctrl+F5` | same | run forward, back to the cursor's line | the Time Machine is open (`F5`: no breakpoint in the file) |
| `F8`, `Ctrl+F8` | same | run forward, back to a breakpoint | the Time Machine is open |
| `F5` | same | Re-execute the file | Tracelight runs it, the Time Machine is closed, no breakpoint in the file |

Every `Cmd+K` / `Ctrl+K` chord also has a `Ctrl+Alt+P` form (`Ctrl+Alt+P Q`, `Ctrl+Alt+P V`, ...).
Stop Current is `Ctrl+Alt+P S` on macOS and `Ctrl+Alt+P E` elsewhere. When the file has a
breakpoint, `F5` is VS Code's own Start Debugging. Every command is in the Command Palette with
"(Tracelight)" after its name.

## Debugging

A launch configuration of type `tracelight` debugs a file. This one is all you need:

```json
{
  "type": "tracelight",
  "request": "launch",
  "name": "Tracelight: orders.js",
  "program": "${workspaceFolder}/orders.js"
}
```

| Attribute | Default | |
|---|---|---|
| `program` | `${file}` | the JavaScript or TypeScript file to run on Node |
| `args` | `[]` | `process.argv.slice(2)` |
| `cwd` | `${workspaceFolder}` | the working directory |
| `env` | `{}` | variables added to the program's environment |
| `stopOnEntry` | `false` | pause before the first statement instead of running to the first breakpoint |
| `breakOnException` | `uncaught` | `off`, `uncaught` (an exception nobody caught) or `raised` (every raise in your code) |
| `libraryCode` | `false` | step into packages under `node_modules` (never Node's own modules) |
| `record` | `false` | also record the run, so the Time Machine, the Code Story and `why` open at every pause (slower) |
| `node` | `tracelight.nodePath`, then `node` on PATH | the node binary (22.18 or newer) |

Without a launch configuration, **Debug Current File** and **Debug Current File (Recording)** start
the active file. The Debug Console shows what the program prints.

## Settings

The ones you are most likely to change come first in each group. The defaults are in brackets.

**Running**

| Setting | |
|---|---|
| `tracelight.nodePath` [empty] | the Node that runs your files, `node` on PATH when empty |
| `tracelight.runMode` [`onSave`] | `onSave` runs on save, `onDemand` only on Re-execute, `auto` on every edit (and for hovers, watches and Show Value), `smart` runs scratch files on every edit and files inside a project (`package.json`, `tsconfig.json`, `jsconfig.json`, `deno.json` or a lock file) on save |
| `tracelight.delay` [0] | milliseconds after the last edit before an automatic run |
| `tracelight.runTimeout` [30000] | kill a run after this many milliseconds (0 waits forever) |
| `tracelight.args` [`[]`], `tracelight.env` [`{}`] | `process.argv.slice(2)` and environment variables for the run |
| `tracelight.plugins` [`[]`] | modules exposing `before(config)` / `beforeEach(config)` |
| `tracelight.installPackageCommand` [empty] | e.g. `pnpm add {packageName}`. Empty uses npm, or the package manager of the project's lockfile |
| `tracelight.untrustedWorkspaceBehavior` [`Prompt to allow`] | `Prompt to allow`, `Never allow` or `Always allow` running code in an untrusted workspace |
| `tracelight.automaticRestart` [false] | start again on open when Tracelight was running as the file closed |
| `tracelight.automaticStartRegex` [empty], `tracelight.smartStart` [`[]`] | start on open by path regex, or by rules such as `{"pattern": "**/*.ts", "startMode": "always"}` |

**Values**

| Setting | |
|---|---|
| `tracelight.autoLog` [false] | a value on every line |
| `tracelight.valuePeek` [true] | evaluate and show values when hovering expressions |
| `tracelight.showValueOnSelection` [false], `tracelight.showValueOnMultilineSelection` [false] | show the value of a selected expression |
| `tracelight.showSingleInlineValue` [true] | keep only the last value you showed inline |
| `tracelight.resolveGetters` [false] | call getters while serializing values (this runs code) |
| `tracelight.logLimit` [100], `tracelight.maxConsoleMessages` [1000] | values kept per expression or print site, and per run |
| `tracelight.maxValueChars` [unset] | characters a recorded value keeps: unset is 120 for a local and 200 for a logged value, 0 keeps the whole value |
| `tracelight.secrets.mask` [true], `tracelight.secrets.names` [`[]`] | mask secrets, and extra words that make a name secret |

**Time Machine**

| Setting | |
|---|---|
| `tracelight.timeMachine.recordLocals` [false] | record every changed local at every step, for Variable History and `why` |
| `tracelight.timeMachine.inlineValues` [`dimOthers`] | `dimOthers` (earlier steps dimmed), `currentStep` (only this step, as Quokka does) or `all` |
| `tracelight.timeMachine.autoLog` [true] | Auto Log while the Time Machine is open |
| `tracelight.timeMachine.libraryCode` [false], `tracelight.timeMachine.libraryPackages` [`[]`] | instrument packages so Step Into enters them, optionally only the named ones |
| `tracelight.timeMachine.exclude` [`[]`] | package names or path globs to leave out of the recording |
| `tracelight.maxTraceSteps` [999999] | steps recorded per run. Past it the program runs on unrecorded |
| `tracelight.codeAutoPlayDelay` [1000] | milliseconds between steps of Auto Play |

**HTTP, explanations and the Execution Diagram**

| Setting | |
|---|---|
| `tracelight.http` [`off`] | `record` writes the run's HTTP to `.tracelight/replay/`, `replay` answers from it |
| `tracelight.httpObserve` [true] | list every run's requests in the HTTP view |
| `tracelight.explain.command` [empty] | the command that narrates, reading the prompt on stdin. Empty tries `claude`, then `codex` |
| `tracelight.story.values` [`all`] | the values the Code Story shows: `all`, `asOf` the Time Machine step, or only the current `step` |
| `tracelight.story.walkthrough` [false] | list the walkthrough at the top of the Code Story |
| `tracelight.diagram.build` [`onOpen`] | build the diagram when it opens (`onOpen`) or after every run (`onRun`) |
| `tracelight.diagram.detail` [`scopes`], `tracelight.diagram.dataEdges` [false], `tracelight.diagram.phases` [true] | how much the diagram draws at first, data edges between statements, and phases inside a scope |

**Agents, snaps and appearance**

| Setting | |
|---|---|
| `tracelight.agentAccess` [false] | let local agents read this window's runs and drive it (see below) |
| `tracelight.snapsAutoDiscovery` [true], `tracelight.snapsAutoRunConfirmOnOpen` [true], `tracelight.snapsAutoRunConfirmOnEdit` [true] | find snaps as you open and edit, and ask before running them |
| `tracelight.showOutputOnStart` [true] | bring the panel up when a session starts |
| `tracelight.fontSize` [13], `tracelight.colors` | the panel's font size, and the gutter colors (a restart applies them) |
| `tracelight.lightTheme.*`, `tracelight.darkTheme.*` | six overrides for how log, system and error values render inline |
| `tracelight.suppressGlyphMarginNotifications` [true], `tracelight.showStartViewOnFeatureRelease` [true] | gutter notifications, and the start view after a feature release |

## For agents

### Agent access

`tracelight.agentAccess` is off by default, and only this extension reads it: turning on a
similar setting of another extension does nothing here. With it on, the window publishes each session as a descriptor and
a socket under `~/.tracelight/sessions` (`$TRACELIGHT_HOME` moves the folder), and the extension
writes `~/.local/bin/tracelight`, a script that runs the CLI of the installed version. Turning it
on takes effect without a reload for the sessions that are already open. While it is off, a
`tracelight debug` from a terminal makes the window ask before it runs anything.

### CLI

From a checkout, `node node/bin/tracelight.mjs` is the same CLI. `tracelight version` prints its
version and the Node it runs on.

```sh
tracelight run app.ts --save run.json        # record a run
tracelight story run.json --file app.ts      # the map: one step number per line that ran
tracelight step run.json 12 --into           # the Time Machine at step 12, then into the call
tracelight why run.json 40 total             # where the value of total at step 40 came from

tracelight debug app.ts --at main            # start the debugger in VS Code, print the first stop
tracelight state --live                      # where the open session is, without moving anything
tracelight step --live --over                # step the paused program over one statement
tracelight eval --live 'amount + tax'        # evaluate in the paused frame
tracelight continue --live                   # run to the next breakpoint or the end
```

`--live` drives the open VS Code session instead of a saved run, and `--session NAME` picks one
when several are open. `step --live` moves whatever is open, the Time Machine included, so
`state --live` is the way to look without moving anything. `tracelight debug` with no `--at` and no
breakpoint pauses at the first statement. `--at` is repeatable, and each one is set before the
program starts.

The verbs, by what they are for:

- Recording and serving: `run`, `serve`, `instrument`, `bindings`, `cache`, `mcp`, `version`.
- Mapping a run: `story`, `steps`, `find`, `walkthrough`, `graph`, `exceptions`, `http`, `diff`,
  `tour`, `coverage`, `state`.
- Moving and reading values: `step`, `context`, `values`, `var`, `why`, `origin`, `eval`,
  `expand`, `release`, `watch`.
- The live debugger: `debug`, `continue`, `pause`, `stop`, `restart`, `break`, `watches`, `locals`,
  `exec` (run a statement in the paused frame), `record` (start recording at this pause) and
  `shell` (one command per stdin line, for a long session of stops).
- Explaining: `history` (the data of a code-history page), `narrate`.

Every verb takes `--help`. The full reference, with recorded examples, is
`skills/tracelight/references/tracelight-cli.md`.

### MCP

`tracelight mcp` is the CLI as an MCP server on stdio, with six tools:

| Tool | What it covers |
|---|---|
| `tracelight_run` | record a run of a `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`, `.jsx` or `.tsx` file |
| `tracelight_map` | `state`, `walkthrough`, `story`, `steps`, `find`, `graph`, `exceptions`, `http`, `tour`, `diff` |
| `tracelight_step` | `context` at a step, or `step` with a move (`into`, `over`, `out`, `back`, ...) |
| `tracelight_value` | `var`, `why`, `origin`, `values`, `eval`, `expand`, `release` |
| `tracelight_coverage` | the lines that ran and did not, per file |
| `tracelight_debug` | the live debugger: `start`, `continue`, `pause`, `stop`, `restart`, `break`, `watches`, `locals`, `exec`, `record` |

For Claude Code: `claude mcp add tracelight -- tracelight mcp`, or with the checkout's path,
`claude mcp add tracelight -- node /path/to/tracelight/node/bin/tracelight.mjs mcp`. Saved runs
need nothing else. The live tools need agent access. The arguments of each tool are in
`skills/tracelight/references/mcp.md`.

### Skill

`skills/tracelight` is one skill with three modes: `debug` pauses a program and steps it, `explain`
walks a person through a run in their editor, and `show` builds a tour or a code-history page whose
every value `tracelight history` generated from the run. `AGENTS.md` tells an agent where to start.

### Claude Code band

The band (`claude-plugin/tracelight-band`) shows the Time Machine of your window above the Claude
Code prompt: the code around the step, its values, the stack, a short explanation and the bugs found
in the run. Install it from this checkout:

```sh
claude plugin marketplace add /path/to/this/checkout     # the marketplace is called tracelight
claude plugin install tracelight-band@tracelight --scope user
```

Once the repository is published as `ivorpad/tracelight`, `claude plugin marketplace add
ivorpad/tracelight` does the same from GitHub. Restart Claude Code after installing or updating it,
because a running session keeps the plugin code it loaded at start.

`/tl` alone lists the keys. `/tl n`, `b`, `i` and `o` step next, back, into and out, `w` shows where
a value came from, `f` plans a fix, `a` applies it and `u` undoes it, `x` lists the bugs, `e`
explains, `r` records again and `p` switches the prose on or off. `/tracelight-band` shows or hides
the band.

## In a browser

```sh
npm run build
node dist/web/server.js app.ts --open        # or: npm run tracelight-web -- app.ts --open
```

The page at http://127.0.0.1:4777/ is the panel next to a Monaco code pane, with the Time Machine
and the debugger. It runs the file again when it changes on disk and runs edits typed in the page
without saving them. An agent drives it with the same server:

```sh
node dist/web/server.js ctl break 23 on
node dist/web/server.js ctl debug start --say "Runs to the breakpoint on line 23."
node dist/web/server.js ctl debug step over --say "priceFor returned the price."
node dist/web/server.js ctl eval "total + price"        # in the paused frame
node dist/web/server.js ctl state
```

`debug start` goes to the first breakpoint and pauses at the first statement only when none is
set. `--say` puts the explanation in a bubble under the new line. The bridge sends each command to
every open tab of the page, so keep one tab per bridge. The page's code runs in the browser, which
means that after `npm run build` you restart the bridge and reload the tab. [docs/WEB.md](docs/WEB.md)
has every option, the HTTP API, the WebMCP tools and the security model (127.0.0.1 only, same-origin
checks).

## Troubleshooting

**`tracelight state --live` finds no session.** Check `tracelight.agentAccess`, then reload the
window if Tracelight was installed or updated since it opened. `ls ~/.tracelight/sessions` shows
what the windows published. Don't print the descriptors themselves, because they hold the
session's token.

**`tracelight debug` times out the first time.** VS Code asks whether Tracelight may open its URI
and waits. Click Open and the session starts anyway, so the next command is `tracelight state
--live`, not a second `debug`. Adding `ivor.tracelight` to `extensions.confirmedUriHandlerExtensionIds`
stops the question. The URI goes to the focused window, which needs the folder open with
Tracelight active.

**A file records 0 steps.** If its path goes through a symlink, the runtime runs it without
instrumenting it. On macOS `/tmp` and `/var/folders` are symlinks, so open the file by its real
path. This is a known bug ([docs/HANDOFF.md](docs/HANDOFF.md)).

**The band shows an old title or follows the wrong CLI.** Claude Code keeps the plugin code it
loaded when the session started. Restart it.

**The browser page acts twice, or answers like old code.** Close the extra tabs and reload the one
you keep after every rebuild.

## Development

```sh
npm ci && npm ci --prefix node                  # once; node/ has its own lockfile
npm run build                                   # dist/: extension, panel, browser page, runtime
npm run typecheck
TMPDIR=$(realpath "$TMPDIR") npx vitest run     # the extension's and the page's unit tests
TMPDIR=$(realpath "$TMPDIR") npm run test:node  # the runtime's node:test suite
npm run test:e2e                                # a real VS Code: run and F5-debug a .js and a .ts file
claude plugin validate --strict claude-plugin/tracelight-band
claude plugin test claude-plugin/tracelight-band
```

`npm test` runs the typecheck, vitest and the runtime tests in a row. On macOS give it the real
`TMPDIR` as above, or most runtime tests hit the symlink bug. Four runtime tests fail on macOS with
Node 24 (named in [docs/HANDOFF.md](docs/HANDOFF.md)), so `npm test` stops at the runtime step
until they are fixed. Run the typecheck and vitest on their own to see their result.

After cloning, run `git config core.hooksPath .githooks` once. The commit-msg hook checks the
`Bump:` trailer (`major`, `minor`, `patch` or a synonym; none means patch). The version lives in
`package.json` and `node/package.json`, and `scripts/version.py` writes both. `scripts/check.sh`
runs every check, and `scripts/release.sh` bumps, checks, builds, installs, tags and creates the
GitHub release.

| Folder | |
|---|---|
| `src/` | the extension |
| `webview/` | the panel |
| `node/` | the runtime, its CLI and the MCP server, a package of its own |
| `web/` | the browser page and its bridge |
| `skills/tracelight/` | the skill and the CLI reference |
| `claude-plugin/tracelight-band/` | the Claude Code band |
| `test/unit`, `test/e2e`, `node/test` | vitest, vscode-test, node:test |

[docs/HANDOFF.md](docs/HANDOFF.md) has the decisions, the commands and the quirks.
[docs/LEARNINGS.md](docs/LEARNINGS.md) is what went wrong and the rule each time taught.
[docs/RUNTIME.md](docs/RUNTIME.md) is the runtime's layout, [docs/PROTOCOL.md](docs/PROTOCOL.md)
the wire protocol between the extension and the runtime, [docs/WEB.md](docs/WEB.md) the browser
page and [docs/TOUR.md](docs/TOUR.md) the tour format. [docs/PARITY.md](docs/PARITY.md) is history:
the feature checklist Tracelight was built against before the split.

## License

MIT
