---
name: tracelight
description: See what JavaScript or TypeScript code does with the `tracelight` CLI and the user's VS Code window, in one of three modes given as the first argument. `debug` pauses a running Node program at a function or line, steps it and reads the frame. `explain` walks a person through a run in their editor, one line per message. `show` investigates a recording or a pause and delivers a page where every value comes from a command: a tour of the whole run, or a code-history page around chosen steps. Use when asked to debug, step, break, pause, explain, walk through, or "show me" what a JavaScript or TypeScript program did, why a value is what it is, or what a package in node_modules did with an argument.
argument-hint: debug | explain | show [what to look at]
disable-model-invocation: true
---

# Tracelight

## Pick the mode

The first word after the skill name is the mode: `/tracelight debug createDesign`,
`$tracelight explain demo.ts`. Load that mode's file and follow it; it says what to deliver.

| mode | for | what you hand back | read |
|---|---|---|---|
| `debug` | pause a running program, step it, read or set the frame, check a breakpoint | the stops you saw, in chat, then clean up | [references/debug.md](references/debug.md) |
| `explain` | teach a person a file while they watch their editor | one line and a few sentences per message, their turn after each | [references/explain.md](references/explain.md) |
| `show` | answer how or why with evidence someone will read or keep | a tour or a code-history page, plus a short finding in chat | [references/show.md](references/show.md) |

With no mode, pick by the verb the user used. "Step", "break", "pause", "run to", "does it stop
in" is `debug`. "Walk me through", "teach me", "explain as we go" with the user at the editor is
`explain`. "Show me", "why is", "how does", "what did the package do" is `show`. A request to see
stepping gets real pauses in the editor, through `debug`. If two fit, ask which.

## The two products

**Run-all** records an execution: every statement, value and branch, in order. You navigate the
recording; nothing re-executes and nothing can be changed. It answers questions about what
already happened.

**The Debugger** runs a program at full speed and pauses at a breakpoint or an exception. You
step, read the frame, run a statement in it, continue. Nothing is recorded, and when the program
exits the session is gone. It answers what the program does next, and it is the one when the bug
needs a real port, real input or a real API. `--record` does both at one pause. A debug session
without `--record` has no history at all, even after it finishes; `references/debug.md`, "History
while debugging", says what to use instead.

Every command takes `--json` for the raw shape; the text form is for you. The flags, JSON shapes
and an example of each verb: [references/tracelight-cli.md](references/tracelight-cli.md). Without
a shell, the same commands are MCP tools: [references/mcp.md](references/mcp.md).

## Before the first command: find the runtime and the editor

Find the runtime fresh on this machine, each session. Extension folders carry a version
(`ivor.tracelight-0.1.3`), so a path saved in a note or another session goes stale on the next update
and fails as `Cannot find module`. Look in this order:

1. `tracelight` on PATH (`command -v tracelight`), else `~/.local/bin/tracelight` by its full
   path. A stock macOS PATH does not include `~/.local/bin`, so call it by that full path; the
   user's shell profile stays as it is.
2. `scripts/tracelight.sh` next to this file does the same search, and inside a Tracelight checkout
   runs the checkout's own `node/bin/` entry with `node`.
3. The installed extension ships the runtime under `dist/node`. Look in the editor's extensions
   directory (`~/.vscode/extensions`, `~/.vscode-insiders/extensions`, `~/.cursor/extensions`,
   `~/.vscode-server/extensions`, or `%USERPROFILE%\.vscode\extensions` on Windows) for
   `ivor.tracelight-*`, take the highest version, and run the `.mjs` file in its `dist/node/bin` with
   `node`.

The CLI needs Node 22.15 or newer, since it runs its own TypeScript sources: `node --version`.
Verify before going on: `tracelight -h` (or `node <ext>/dist/node/bin/<entry>.mjs -h`) must print
the usage line with `debug` and `history` among the verbs. If none of the three gives that, stop
there and tell the user which step failed.

The debugger may also need the editor's launcher. A cold `tracelight debug` opens a URI through
`code` on PATH, or through `$TRACELIGHT_CODE` when that is set. If `code` is missing, the CLI says
``cannot find the `code` command``. Find the launcher this editor ships (VS Code on macOS keeps it at
`<app>/Contents/Resources/app/bin/code`; Cursor's is `cursor`; on Linux it is usually on PATH
already), and set `TRACELIGHT_CODE` for this shell. Or ask the user to run "Shell Command:
Install 'code' command in PATH". Commands you leave behind use `~`, `$HOME` and globs, so they
work for any user and any version.

## Sessions

**Saved run.** `tracelight run FILE --save run.json` executes the file once; every command then
takes `run.json` first. `FILE` is `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`, `.jsx` or `.tsx`;
TypeScript runs as it is, with no build step and no `tsconfig` change. A run that reports
`0 steps` did not run the program: the runner failed. Read its error first. `EPERM` or
`Operation not permitted` means your own sandbox blocked the child process or its socket; ask to
run the command outside the sandbox, and leave the program and its config as they are.

Read what `run` prints before anything else: the program's own output, each line prefixed with
the `file:line` that printed it, an `error:` line for an uncaught exception, then `saved run.json:
N steps, N files, exit N`. The program runs under the `node` that runs the CLI; when it needs
another (an `.nvmrc`, an `engines` field), call the CLI through that `node`. A value ending in
`…(+N chars)` was cut; when you need all of it, rerun with `--max-value-chars 0` and read it with
`--json`. Every verb over a run cut by `--max-steps` starts with a `note: truncated recording`
line: rerun with the `--exclude` it names (or a higher `--max-steps`) before you read the run, and
pass the note on to the user when your answer depends on what came after the cap.

**A debug session is made, not found.** In `debug` mode the first command is `tracelight debug
FILE --at NAME`: it starts the session in the user's VS Code window and prints the first stop.
Make it your first command: nothing is running until it starts the session, so a `--live` command
sent before it answers `no live session`. Every `--live` command after the first stop drives that
session.

**A recording session (`show`, `explain`) is the user's.** It exists only when the user started
Tracelight on the file in VS Code ("Start on Current File", or a smart-start rule); having the file open
is not enough, and `tracelight.agentAccess` only lets you reach a session, it starts none. Check with
`state --live`, which moves nothing. On `no live session`, move on at once: record it yourself with
`tracelight run FILE --save run.json` and use `run.json` instead of `--live`, or ask the user to
start Tracelight on the file if they want the editor to follow along.

The CLI finds a live session by the file the command names, by the current directory's workspace,
or by `--session demo.ts`; when two windows show the same file, `--session
$TRACELIGHT_HOME/sessions/<pid>-<n>.json` picks one and the error lists them (`TRACELIGHT_HOME` is the
extension's directory, `~/.tracelight` unless set; give the CLI the same value as the window). A file
can have a recording session and a debug session at once, and the CLI routes by verb.

**Keep the session you chose.** Once more than one exists, commands that read the past may refuse
to pick (`history --live` does). Note the session name off the first stop or `state --live` and
pass `--session NAME` on every `--live` command from then on.

**Look with reads, move with `step`.** `step` moves the user's editor, so use it only to go
somewhere. To find out where a recording session is, use the reads, which move nothing: `state`,
`context`, `values`, `var`, `why`, `origin`, `walkthrough`, `graph`, `http`, `exceptions`, `history`.

**Under a sandbox (Codex).** The CLI reaches VS Code through `$TRACELIGHT_HOME/sessions/*.sock`. If a
command fails with `Operation not permitted` or `stopped answering` right after connecting, your
sandbox blocked the socket or the runner: ask to run that command outside the sandbox. It is not a
missing session.

## Stay out of the user's project

Tracelight needs no harness. Use what the project already has: an existing test file, the entry
point, a module the user named. Leave their repository exactly as you found it: its files, its
config (`package.json`, `tsconfig.json`, `.babelrc`, `vitest.config.ts`), its lockfiles
(`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`), its `node_modules` and its
directories. Install nothing into it. If the code needs a database or an external service to run
and no test covers that path, say so and ask the user how they want to reach it. `run.json`,
`history.json`, prose and pages go in a scratch directory outside the repository.

## Staleness and secrets

`stale: helper.ts changed since the run` printed first, or `"stale": true` in JSON, means the
file on disk (saved run) or the editor buffer (live) no longer matches what ran, so line numbers
and values may be off. Save again; live, a save re-runs and re-anchors by itself. `tracelight
history` refuses outright on a stale run.

Every value, error message and eval result that leaves the runtime is redacted (`sk-…`, `AKIA…`,
`ghp_…`, bearer tokens, JWTs, and the value of any key named like `apiKey`, `api_key`, `secret`,
`token`, `password`), and so is the value of any secret-looking environment variable. A recording
still holds the program's data: keep `run.json` and pages out of chat, commits and issues, and do
not read or print the project's `.env`.

## Finish clean

Before you write the final answer, and while the session is still running: remove the breakpoints
you added (`break --live --remove F:L` for a line, `--remove NAME` for one `--at NAME` set),
confirm with `break --live --list`, then `stop --live` unless the user wants the pause kept, and
check `state --live`. Removing needs a session to reach the window: once the program has exited,
its breakpoints stay until the next launch. Breakpoints that were there before you belong to the
user; leave them. Release a kept runner with `tracelight release run.json`. If you were
interrupted before this, say which of it is still undone.
