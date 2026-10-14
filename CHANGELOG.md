# Changelog

## Unreleased

- `tracelight web` prints its pid at startup and says to stop the bridge, or ask about keeping it,
  when the task that started it is done. The skill makes that part of finishing a task for every
  process an agent started (bridges, headless browsers, servers), naming each port and PID.
- The skill's `explain` mode is a shorter core method plus five worked investigations
  (`references/learning-patterns.md`) on a new multi-file example, `examples/js/checkout`: the
  implementation behind an interface call, a value's provenance, the branch that decides, an
  async handoff and a real-path contrast. The Pi harness guidance moved to an optional example.
  Manual-step listening is described as the bounded, in-turn wait it is, and scratchpad results
  are labelled as complementing a second real run. `node/test/learning-scenarios.test.ts` runs the
  patterns' routes; the skill evals no longer reward a recording or a page for live learning.
- MCP now exposes saved-run investigations, explicit fix checks, session positions, recorded
  destinations and reopenable investigation checkpoints with recording identity checks.
- Conditional breakpoints and expression watches report evaluation failures without changing
  program state. Conditional logpoints can share a location with stopping breakpoints, including
  worker threads. Agents can list binding names and types or request selected values.
- Recorded investigations use captured source and distinguish the statement that changed a value
  from the step where its new value was observed. Runtime pipe errors reject pending requests.

- Browser source refreshes after disk changes even when automatic execution is disabled
  (`--no-watch`, On Demand). While the page's debugger has a run, a save or a settings change
  refreshes the page without starting a second execution beside the paused one, as VS Code
  already did; Run, Restart and saves after the debug run still execute. The skill always starts
  browser sessions with watching enabled, including debug and learning; `--no-watch` is optional.

- VS Code On Save sessions rerun when the entry file or an open imported file reloads after
  another editor or agent changes it on disk, including files outside the workspace. Unsaved
  edits and On Demand still wait for a run.
- Browser navigation confirms the rendered source and highlight after presentation, reports live
  and recorded positions separately, and refuses ambiguous control across multiple pages.
- Scratchpad experiments prepare formatted code, copied inputs, receivers and labelled fixtures
  in one call, execute once, and return completed values, output and runtime/application errors.
  Named scratchpads persist with autosaved versions, a saved list and reopenable history.
- Learning instructions require pause listening when a browser connects, source-position checks
  before narration, and repair of incomplete scratch experiments before teaching.
- Scratchpad bootstrap is passed as data, fixing the escaping error that prevented startup.
  Encoding, URL, cloning and performance APIs are available before dependencies initialize.
  Copied functions, arrows and explicit imports avoid captured-name collisions; external calls
  still require mocks.
- Variable recording detects alias writes and same-size object mutations. Finished exception
  reports retain errors absorbed by promise combinators. Symlinked projects and worker
  breakpoints use canonical paths without machine-specific setup.
- Added Investigate a Value, Learn from This Run, Pin Run as Baseline and Verify Fix commands.
  Matching CLI workflows expose the same evidence, ignore selected comparison values and export
  regression tests for explicit expectations. Incomplete recordings cannot verify a fix.
- `tracelight launch` records a project's normal command and inherited Node children, including
  selected Node tests. Each process/thread produces a separate recording and the launch index
  preserves its exit status. `run --cwd` supports project working directories.
- Packages carry their actual platform target; the QA workflow builds separate native packages.

- `tracelight web FILE` serves the browser page from the installed extension, and `tracelight web
  ctl ...` drives it, so an agent needs no checkout: the vsix now ships `dist/web`. It names the
  bridge it runs (`tracelight web -h`), says to pass `--port` when 4777 is taken, and says what to
  start when nothing is served on the port.
- `tracelight run FILE --mode profile` prints `profile: PATH.cpuprofile` and `profiled, no steps
  recorded`; the path was only in `--json`, and `0 steps` read like a failed run.
- The skill has a fourth mode, `ask`: a question about code answered in chat from a recording
  (learning a module, hidden failures, reviewing an edit, offline HTTP, profiles). Its references
  cover every verb and flag, the browser page (`references/browser.md`) and the band
  (`references/band.md`), and `node/test/skill.test.ts` fails when a verb, flag, MCP argument,
  `ctl` command, band key or `TRACELIGHT_` variable has no line in the skill.
- Codex, like Claude Code, starts the skill only when the user asks (`$tracelight`, `/tracelight`):
  `skills/tracelight/agents/openai.yaml` sets `allow_implicit_invocation: false` next to
  `SKILL.md`'s `disable-model-invocation: true`.
- Tracelight is its own repository, split on 2026-10-11 from Pyokka (`ivorpad/pyokka`, branch
  `tracelight-extension` at d2f28e8, PR #17), where it was built as a second extension from
  Pyokka's sources. Nothing here builds, ships or calls Pyokka: no Python runtime, no
  `--tracelight` build flag, no generated manifest. The sources name every command, setting,
  view, context key, `~/.tracelight` path, `TRACELIGHT_*` variable and the
  `vscode://ivor.tracelight/debug` URI themselves, where the build used to rename Pyokka's.
- `tracelight mcp` answers every tool in its own process. The tools are `tracelight_run`,
  `tracelight_map`, `tracelight_step`, `tracelight_value`, `tracelight_coverage` and
  `tracelight_debug` (they were `pyokka_*`). A `.py` file or a Python run gets an error that points
  at Pyokka instead of being handed to the `pyokka` CLI, `tracelight_debug` takes `node` where it
  took `python`, and `serverInfo` reports the package version.
- `tracelight debug` has no `--module`, and a launch configuration with `"module"` is refused:
  Node has no module launch. The `python` launch key is gone; `node` names the binary.
- The browser page runs the runtime for JS/TS files and `--runtime "CMD ARGS"` for anything else;
  `--python` and `TRACELIGHT_PYTHON` are gone.
- The Claude Code band is `tracelight-band`: its keys are `/tl` (they were `/pk`) and its tool
  `mcp__tracelight-band__band`.
- HTTP recordings carry `tracelight: "http"` in their header on both sides. The previous build
  wrote `pyokka` and read `tracelight`, so a recording's date never showed. A `.pyokka/replay/`
  left from before the split is no longer read.
- Clear Library Cache clears the one runtime cache (`~/.tracelight/cache`, `KEY.json` and `KEY.js`).
- Session settings come from VS Code, `~/.tracelight/config.json`, `package.json` `"tracelight"`
  and `.tracelight`; `pyproject.toml` is no longer read. The workspace's `.env` is read directly
  instead of through the Python extension's `python.envFile`.
- The snippets file starts with JavaScript snippets, and the untrusted-workspace prompt says the
  file runs on Node.js.
- Fixed: the browser page's debugger paused at the first statement on every start, even with
  breakpoints set. It now goes to the first breakpoint and stops at the first statement only when
  no breakpoint can hit, the rule VS Code and `tracelight debug` follow (`entryPause`). Restart
  follows the same rule.
- Fixed: the page's `eval` (`ctl eval`, `tracelight_eval`) ignored a debugger pause and evaluated
  at the top level of the finished run, so a paused function's variables were "not defined". At a
  pause it now runs in the paused frame and returns the runtime's own error when it fails.
- Fixed: an agent's `debug start` on the page waited 10 seconds when the run ended without pausing;
  it answers when the run ends.
- `src/session/moments.ts` had three raw NUL bytes as key separators, which made `grep` and `file`
  treat it as binary. They are `\u0000` escapes now, the same strings at runtime.

Carried over from Pyokka's Unreleased section, where Tracelight was developed:

- Tracelight is a VS Code extension for JavaScript and TypeScript (id `ivor.tracelight`), with the
  panel, Time Machine, Code Story and Debugger. Its commands, settings, keybindings, debug type
  (`"type": "tracelight"`), home (`~/.tracelight`) and CLI script (`~/.local/bin/tracelight`) are
  its own.
- Fixed: a JavaScript or TypeScript run never left "running" in VS Code. The runtime did not send
  `run.started`, which the extension waits for before it shows a run.
- The Debug Console shows what the program prints during a debug session.
- `tracelight debug FILE` opens `vscode://ivor.tracelight/debug`, and the CLI reads the extension's
  sessions from `$TRACELIGHT_HOME/sessions`. HTTP recordings go to `.tracelight/replay/`.
- `tracelight mcp`: the CLI as an MCP server on stdin/stdout, stdlib JSON-RPC, six tools whose
  answers are the commands' own text.
- `tracelight coverage RUN|--live [--file F]`: per file the statement lines that ran, did not run,
  ran in part or raised; `--file` lists one file line by line with its hits.
- Tracelight in a browser (`docs/WEB.md`): `node dist/web/server.js FILE` serves the panel beside
  a Monaco code pane at http://127.0.0.1:4777/, re-runs the file when it is saved, and runs edits
  typed in the page. `?layout=panel` is the panel alone, for VS Code's Simple Browser next to the
  editor. An agent steps the Time Machine and explains lines in a bubble with
  `node dist/web/server.js ctl step over --say "..."`, the HTTP API behind it, or WebMCP tools.
- The browser page has every view of the panel: Time Machine watches, Variable History and Why, the
  Execution Diagram, HTTP record/replay, Narrate and the Tour (through `claude`, `codex` or
  `TRACELIGHT_EXPLAIN_COMMAND`), the live Debugger with gutter breakpoints, the Code Story in the
  code pane, Profile as a table of the hottest functions (the `.cpuprofile` at `/api/profile`), Show
  Instrumented File, Show Logs, the run modes and View Recent Files. Agents get `ctl var`, `why`,
  `watch`, `break`, `debug`, `story` and `profile`, and the matching WebMCP tools.
- Runs record inside `worker_threads`, including `eval: true` workers and workers that workers
  start: a worker's steps, scopes, locals, `// ?` logs and coverage land in the same trace as the
  main thread's, merged in a causally valid order (every message sent before it is received), with
  no cost per statement. Each worker scope carries `thread: {name, ident}`, and a value a worker
  logged expands, from the live worker or from a snapshot taken when it exits. `workers: false` in
  the run config runs workers as they are.
- The trace of a run with workers streams while they run instead of arriving at the end, and the
  debugger records workers too: a pause anywhere lands on the right step of the merged trace, and
  line and function breakpoints and step into / over / out work inside worker code.
- An error raised by a loop header after its body ran (a `for-of` item that fails to destructure, a
  throwing iterator) names a new step on the header, and a module block in Code Story no longer
  starts at a function's closing brace.
- In the editor: Value Peek hovers, snaps (`/*{{ … }}*/`, output as `//» `), quick install of a
  missing npm package with the project's package manager, the Start button, New
  JavaScript/TypeScript File, snippets, Select Node.js, Clear Library Cache, JS value syntax in the
  panel (`null`, `true`), `≈` values on edited lines, the Code Story coloured as TypeScript, a
  TypeScript demo on the start view, and the Tour, built by the runtime's own `tour` verb.
