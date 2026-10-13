# Tracelight as an MCP server

`tracelight mcp` serves the CLI's commands over stdin and stdout to any MCP client. Use it where
an agent has MCP tools but no shell, or where tool calls are easier to allow than shell commands.
It speaks JSON-RPC 2.0, one message per line (protocol versions 2025-11-25, 2025-06-18,
2025-03-26 and 2024-11-05), and answers `initialize` with a short method in `instructions`.

```
claude mcp add tracelight -- tracelight mcp            # Claude Code
codex mcp add tracelight -- tracelight mcp             # Codex
```

From a checkout without `tracelight` on the PATH, run the checkout's entry with `node`:

```json
{"mcpServers": {"tracelight": {"command": "node", "args": ["<repo>/node/bin/tracelight.mjs", "mcp"]}}}
```

Codex's `~/.codex/config.toml`: `[mcp_servers.tracelight]` with `command = "tracelight"`,
`args = ["mcp"]`. The commands run inside the server's process, so it needs Node 22.18 or newer
like the CLI.

## The twelve tools

The six CLI-backed tools return the command's own text, exactly what `tracelight VERB ...` prints.
A command's `error:` and its hint come back as `isError` with the same two lines, so the method in
`SKILL.md` and [tracelight-cli.md](tracelight-cli.md) applies unchanged: record, map with the walkthrough,
step into, ask why.

`tracelight_map`, `tracelight_step`, `tracelight_value` and `tracelight_coverage` take the source as
`run` (a `run.json` path), or `live: true` for the open VS Code session (setting
`tracelight.agentAccess`) with `session` when several are live. `json` (`true`) returns the
`--json` shape instead of the text.
`tracelight_debug` is always live.

`tracelight_investigate` and `tracelight_verify` accept saved runs only. Both return
`structuredContent` and matching JSON text, with bounded detail and explicit omissions. They do
not execute the program, write files or control a live session. Invalid arguments or unreadable
recordings return `isError: true`; a completed verification that fails a check returns
`isError: false`.

Their `response` metadata reports `limit`, `maxBytes` (32,768) and `omissions`, whose entries name
the affected `path` and `reason`. Detail caps preserve every verification check; shortened text
is marked. Full verification checks are preserved; if they cannot fit the budget, the tool returns
an error asking for fewer expectations. Recording notes identify local-value caps, recording that
began mid-run and unfinished runs. Workflows use recorded source copies when available, so an
edit does not replace the code being explained. Missing copies of changed source are disclosed.
The answer includes the saved path as `run`, or `before` and `after`.

### `tracelight_run`

`run FILE --save`. Arguments: `file` (`.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts` or
`.tsx`; a `.py` file is refused with a pointer to Pyokka), `save`, `args` (the program's
`process.argv.slice(2)`), `no_locals`, `http` (`off`, `record`, `replay`), `timeout_ms` (default
30,000), `max_steps` (default 999,999).

`save` defaults to `.tracelight/runs/<name>.json` next to the file, which is inside the user's
project: pass `save` with a path in your scratch directory instead. The answer is the runtime, the
step count and exit code, any uncaught error, the run's path and the next call:

```
node 24.19.0 (/usr/local/bin/node), tracelight 0.3.0
71 steps, exit 0
run: /private/tmp/s/inv.json
next: tracelight_map {"action": "walkthrough", "run": "/private/tmp/s/inv.json"}
```

### `tracelight_map`

`action` picks the command: `state`, `walkthrough`, `story`, `steps`, `find`, `graph`,
`exceptions`, `http`, `tour`, `diff`. Then that command's options:

| argument | for | CLI flag |
|---|---|---|
| `file` | `walkthrough`, `story` | `--file` |
| `scope` | `walkthrough`, `story`, `graph` | `--scope` |
| `line` | `story` (blocks that ran this line), `steps` (every step on it) | `--line FILE:LINE` |
| `from` | `walkthrough` (first step of the window), `steps` (first step) | `--from` |
| `to` | `walkthrough` (last step of the window) | `--to` |
| `count` | `steps` (how many, default 40) | `--count` |
| `all` | `walkthrough`, `graph` (one entry per library call) | `--all` |
| `text` | `find` (required) | the search text |
| `limit` | `find`, `story`, `diff` | `--limit` |
| `goal` | `tour` (a variable's last value, NAME, or a line's last pass, FILE:LINE) | `--goal` |
| `budget` | `tour` (default 40,000 tokens) | `--budget` |
| `before` | `diff` (required): the run.json from before the edit | first RUN |
| `after` | `diff`: the run.json from after, or `live: true` for the open session | second RUN |

### `tracelight_step`

The Time Machine. Without `move` or `to` it is `context` at `step` (or at the first step of
`line`); with them it is `step`.

| argument | what |
|---|---|
| `step` | the step to read or move from; with `live`, omit it for the current step |
| `move` | `into`, `over`, `out`, `back`, `back-over`, `back-out` |
| `to` | jump to this step |
| `line` | without `step`: the context at the first step on this FILE:LINE |
| `count` | live at a debug pause: take this many steps in a row (1 to 1000) |
| `whole_block` | the whole block and every value (`--scope`: lifts the 60-line and 20-value caps) |

### `tracelight_value`

`action` picks the command: `var`, `why`, `origin`, `values`, `eval`, `expand`, `release`.

| argument | for | what |
|---|---|---|
| `name` | `var` (required), `why`, `origin` | a name or property path (`total`, `this.balance`); for `origin`, the expression to follow, omitted to take the value the exception is about |
| `step` | `why`, `origin` (required on a saved run) | the step whose statement made the value; the failing statement's step |
| `depth` | `why` (default 5, at most 8), `origin` (default 20, at most 60) | `--depth` |
| `line` | `values` (required) | every value logged on this FILE:LINE, by hit |
| `expression` | `eval` (required) | a pure expression (names, properties, subscripts, non-mutating calls); needs `live`, or a run the CLI saved with `--keep` (`tracelight_run` keeps no runner) |
| `frame` | `eval`, live at a pause | which frame, innermost 0 |
| `value_id` | `expand` (required) | `valueBag.data.id` from `eval` with `json: true` |
| `path` | `expand` | the query path segments, a list |
| `file`, `scope`, `limit` | `var` | only changes in this file, inside this function, at most this many (default 200) |

### `tracelight_coverage`

`coverage`: per file the lines that ran, never ran or ran in part. `file` also lists that file
line by line with hit counts.

### `tracelight_debug`

The live debugger in VS Code (the window opens on `start`). Every action that runs the program
returns the next stop the way `tracelight_step` prints one. `action` picks the command: `start`
(`tracelight debug`), `continue`, `pause`, `stop`, `restart`, `break`, `watches`, `locals`, `exec`,
`record`.

| argument | for | what |
|---|---|---|
| `file` | `start` | the file to debug; omit it to debug the open session's file |
| `args`, `cwd`, `env`, `node` | `start` | the program's arguments (a list), working directory, environment (an object), Node binary |
| `at` | `start`, `break` | a list of FILE:LINE or function names (`rrf`, `Ranker.rank`) to stop at |
| `record`, `record_from` | `start` | also record the run; or run to this NAME or FILE:LINE and record from there |
| `library_code` | `start` | step into and pause inside `node_modules` too |
| `stop_on_entry` | `start`, `restart` | pause before the first statement |
| `no_focus` | `start` | leave the VS Code window where it is at the first stop |
| `until`, `to` | `continue` | run until an expression is true; run to a FILE:LINE |
| `no_wait` | `continue`, `pause` | answer at once instead of waiting for the stop |
| `add` | `break` (FILE:LINE list), `watches` (expressions) | what to add |
| `when` | `break` | only pause when this expression is true at the added line |
| `log_message` | `break` with `add` | logpoint template with `{expression}` substitutions; `when` optionally limits when it logs |
| `remove` | `break` (FILE:LINE or function names), `watches` (watch ids) | what to remove |
| `clear` | `break` | clear all breakpoints before applying any `add` entries in this call |
| `on_exception` | `break` | `off`, `uncaught`, `raised` |
| `break_when` | `watches` | `change` or `true`: the added watches pause the run |
| `frame` | `locals`, `exec` | which frame of the pause, innermost 0 |
| `names_only` | `locals` | return binding names without serializing values, expanding objects or calling getters |
| `names` | `locals` | optional list of binding names whose values to read in the requested frame |
| `source` | `exec` (required) | the statement to run in the paused frame; it changes the program's state |

`locals` reads the requested frame's lexical scopes; there is no `scope: local|global|all`
selector. Names-only still enumerates engine binding descriptors internally, including primitives,
but does not serialize their values. A logpoint logs at the breakpoint site without stopping
there; its expressions are explicit live evaluation. API logpoints belong to the runtime's
breakpoint list and appear in its reply, rather than the editor gutter. Remove them by FILE:LINE
or use `clear: true`; clearing also removes the user's editor breakpoints, so prefer removing
only the entries you added.

Expression watches already cover two useful questions. To stop when an expression becomes true:

```json
{"action":"watches","session":"/path/to/session.json","add":["total < 0"],"break_when":"true"}
```

Use `break_when: "change"` to pause when the expression's result changes. To continue until a
condition is true, use `{"action":"continue","session":"/path/to/session.json","until":"total < 0"}`.
These controls execute the live program; they are distinct from searching a finished recording.

### `tracelight_session`

With no arguments, list published sessions without connecting. Select a saved run or an existing
live session to read state. `livePause` and `recordedSelection` are independent; `capabilities`
and `allowedActions` describe the available controls. `visibleEditor` is null because the socket
cannot confirm what the user sees. Discovery omits authentication tokens and socket paths.

| Argument | What |
|---|---|
| `run` | saved recording path; cannot be combined with `live: true` or `session` |
| `live` | read an existing live session; ambiguous selection requires `session` |
| `session` | descriptor path or session name; selects an existing live session |
| `step` | saved-run context step, nonnegative integer; defaults to 0 when steps exist |

```json
{"run":"/private/tmp/s/run.json","step":12}
```

No session-state call launches, resumes or moves the debugger.

### `tracelight_seek`

Find a recorded destination using either `value` with `equals`, or `file` with `line`.
`equals` is exact recorded text, not an expression to evaluate. The reply carries the evidence,
context and a `tracelight_step` follow-up. It does not move a live session. A missing match in an
incomplete recording does not prove the event never occurred.

| Argument | What |
|---|---|
| `run` | required saved recording path |
| `value` | variable/property name for value search |
| `equals` | exact recorded value text; required with `value`, including an empty string when that is the recorded text |
| `file` | recorded file path or suffix for line search |
| `line` | positive integer; required with `file` |
| `occurrence` | `first` (default) or `last` matching recorded event |

```json
{"run":"/private/tmp/s/run.json","value":"total","equals":"NaN","occurrence":"first"}
```

### `tracelight_save_investigation`

Save a question and named checkpoints to a new private JSON artifact. The existing recording is
referenced by relative path and SHA256; the artifact does not copy the recording. Keep both files.
Every checkpoint is validated before writing, and an existing artifact is never overwritten.

| Argument | What |
|---|---|
| `path` | required new artifact path in an existing directory |
| `run` | required saved recording path |
| `question` | required question text, at most 4,096 characters; stored as metadata |
| `checkpoints` | required list of 1 to 20 objects with unique `name` (at most 256 characters) and nonnegative recorded `step` |

```json
{"path":"/private/tmp/s/investigation.json","run":"/private/tmp/s/run.json","question":"Where did total become NaN?","checkpoints":[{"name":"first bad value","step":12}]}
```

### `tracelight_open_investigation`

`path` is the required investigation artifact path. The tool checks the recording hash before
returning the stored question and checkpoint contexts. Changed or missing recordings are errors;
source comes from recorded snapshots. Opening never resumes live execution.

```json
{"path":"/private/tmp/s/investigation.json"}
```

These tools use explicit value, location and checkpoint arguments. They do not parse arbitrary
natural-language destinations. Use the question to guide evidence selection, then pass concrete
selectors to the tools.

## Mapping live controls to DebugMCP

| DebugMCP operation | Tracelight MCP |
|---|---|
| start with file and working directory | `tracelight_debug` action `start`, `file`, `cwd`; `args`, `env`, `node` are also available |
| start a named test or launch configuration | no `testName` or `configurationName` selector |
| stop, continue, pause, restart | same actions on `tracelight_debug` |
| step over, into, out | `tracelight_step` with `live: true` and `move` |
| conditional breakpoint | `tracelight_debug` action `break`, `add`, `when` |
| logpoint | action `break`, `add`, `log_message`, optional `when` |
| remove, clear, list breakpoints | action `break` with `remove` or `clear: true`; omit changes to list |
| list variable names | action `locals`, `names_only: true`, optional `frame` |
| read named variable values | action `locals`, `names`, optional `frame` |
| local/global/all scope selection | frame lexical scopes only; no equivalent selector |
| evaluate expression | `tracelight_value` action `eval`, `expression`, optional `frame`, `live: true` |
| debug status, optionally waiting for a pause (`waitForPauseSeconds`) | `tracelight_map` action `state` with `live: true` reads it without waiting; `continue` and `pause` wait for their own stop unless `no_wait`; no tool waits for a pause the person causes by stepping in VS Code (the page's WebMCP `tracelight_wait_pause` does, for up to 25 seconds) |

This maps the operations and their limits; it does not establish interchangeable sessions or
tested DebugMCP compatibility. Tracelight adds recorded provenance, reverse history and saved
investigations around those controls.

### `tracelight_investigate`

Read a saved recording for a bounded bundle of value history, context, `why`, `origin`,
exceptions and coverage. Missing or capped evidence stays explicit.
Automatic selection distinguishes the statement that changed a local (`selection.changeStep`)
from the step where its new value was observed (`selection.observedStep`). Context and origin
use that observation; `why` explains the writing statement. An explicit `at` keeps the requested
step, whose locals describe its pre-execution state.
Without `value`, history is null. Context requires a resolved step; `why` and `origin` require
both a value and a resolved step.

| Argument | What |
|---|---|
| `run` | required saved `run.json` path |
| `value` | optional variable or property path, such as `total` or `state.total` |
| `at` | optional step, a nonnegative integer |
| `limit` | detail limit, 1 to 100; default 20 |

```json
{"run":"/private/tmp/s/before.json","value":"total","at":40,"limit":20}
```

### `tracelight_verify`

Compare existing before/after recordings and check explicit expected values in the after run.
The tool does not create the after run. A passing result supports the supplied expectations for
that execution; omitted evidence and untested behavior remain outside the claim.

| Argument | What |
|---|---|
| `before`, `after` | required saved `run.json` paths |
| `expect` | required nonempty list of `NAME=TEXT` expectations, at most 50 and 8,192 UTF-8 bytes as JSON |
| `ignore` | optional list of value/log names to ignore in the comparison, at most 50; expectation checks still apply |
| `limit` | detail limit, 1 to 100; default 20 |

```json
{"before":"/private/tmp/s/before.json","after":"/private/tmp/s/after.json","expect":["total=10"],"limit":20}
```

Judge these tools by correct diagnoses and supported verification claims, then reruns, tool calls,
response bytes and recording overhead. Fewer calls alone is insufficient if relevant evidence is
missing. A same-model comparison on the same cases is needed before claiming better results than
DebugMCP.

## What the tools leave out

The MCP tools cover the commands an investigation needs. These are CLI only: `history` (the
code-history page), `tour --prose` and `tour --out` (a tour page), `graph --expand`,
`--no-statements` and `--dot`, `narrate`, `shell`, `watch`, `web` (the browser page), and `run`'s
`--library-code`, `--exclude`, `--only`, `--max-value-chars`, `--keep`, `--mode` and `--auto-log`.
When the work needs one of them and there is a shell, use the CLI; without one, say which part is
missing.
