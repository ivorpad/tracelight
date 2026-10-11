# Tracelight as an MCP server

`tracelight mcp` serves the CLI's commands over stdin/stdout to any MCP client. Use it where an
agent has MCP tools but no shell, or where tool calls are easier to allow than shell commands.
It speaks JSON-RPC 2.0, one message per line.

```
claude mcp add tracelight -- tracelight mcp            # Claude Code
codex mcp add tracelight -- tracelight mcp             # Codex
```

From a checkout without `tracelight` on the PATH, run the checkout's entry with `node`:

```json
{"mcpServers": {"tracelight": {"command": "node", "args": ["<repo>/node/bin/<entry>.mjs", "mcp"]}}}
```

Codex's `~/.codex/config.toml`: `[mcp_servers.tracelight]` with `command = "tracelight"`,
`args = ["mcp"]`.

## The tools

The tools keep the names and arguments of Tracelight's own server, so an agent that knows one knows
the other.

| Tool | Command | Arguments |
|---|---|---|
| `tracelight_run` | `run FILE --save` | `file` (`.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`, `.jsx`, `.tsx`), `save` (default `.tracelight/runs/<name>.json` next to the file), `args`, `no_locals`, `http`, `timeout_ms`, `max_steps` |
| `tracelight_map` | `state`, `walkthrough`, `story`, `steps`, `find`, `graph`, `exceptions`, `http`, `tour`, `diff` | `action`, `run` or `live`, then the command's options (`file`, `scope`, `line`, `from`, `to`, `all`, `text`, `limit`, `goal`, `budget`, `before`, `after`) |
| `tracelight_step` | `context` at a step, or `step` with a `move` (`into`, `over`, `out`, `back`, `back-over`, `back-out`) or `to` | `run`, `step`, `move`, `to`, `line`, `count`, `whole_block` |
| `tracelight_value` | `var`, `why`, `origin`, `values`, `eval`, `expand`, `release` | `action`, `run`, `name`, `step`, `line`, `expression`, `frame`, `value_id`, `path`, `depth` |
| `tracelight_coverage` | `coverage` | `run`, `file` |
| `tracelight_debug` | the live debugger: `start`, `continue`, `pause`, `stop`, `restart`, `break`, `watches`, `locals`, `exec`, `record` | `action`, `file`, `at`, `args`, `cwd`, `env`, `record`, `record_from`, `library_code`, `stop_on_entry`, `until`, `to`, `no_wait`, `add`, `remove`, `when`, `on_exception`, `break_when`, `frame`, `source` (VS Code with `tracelight.agentAccess`) |

The tools over a run take `json: true` for the `--json` shape and `live: true` (plus `session`) for
the open VS Code session instead of `run`; `tracelight_debug` is always live. `tracelight_run` answers
with the runtime, the step count, the exit code, the run's path and the next call to make. A
result is the command's own text; a command's `error:` and its hint come back as `isError`, so the
method in `SKILL.md` and `tracelight-cli.md` applies unchanged: record, map with the walkthrough,
step into, ask why.
