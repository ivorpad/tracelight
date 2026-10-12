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

## The tools

A result is the command's own text, exactly what `tracelight VERB ...` prints. A command's
`error:` and its hint come back as `isError` with the same two lines, so the method in `SKILL.md`
and [tracelight-cli.md](tracelight-cli.md) applies unchanged: record, map with the walkthrough,
step into, ask why.

Every tool except `tracelight_run` takes the source the same way: `run` (a `run.json` path), or
`live: true` for the open VS Code session (setting `tracelight.agentAccess`) with `session` when
several are live. `json` (`true`) returns the `--json` shape instead of the text.
`tracelight_debug` is always live.

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
| `remove` | `break` (FILE:LINE or function names), `watches` (watch ids) | what to remove |
| `on_exception` | `break` | `off`, `uncaught`, `raised` |
| `break_when` | `watches` | `change` or `true`: the added watches pause the run |
| `frame` | `locals`, `exec` | which frame of the pause, innermost 0 |
| `source` | `exec` (required) | the statement to run in the paused frame; it changes the program's state |

## What the tools leave out

The MCP tools cover the commands an investigation needs. These are CLI only: `history` (the
code-history page), `tour --prose` and `tour --out` (a tour page), `graph --expand`,
`--no-statements` and `--dot`, `narrate`, `shell`, `watch`, `web` (the browser page), and `run`'s
`--library-code`, `--exclude`, `--only`, `--max-value-chars`, `--keep`, `--mode` and `--auto-log`.
When the work needs one of them and there is a shell, use the CLI; without one, say which part is
missing.
