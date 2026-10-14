---
name: tracelight
description: >-
  See what JavaScript or TypeScript code does with the `tracelight` CLI, the user's VS Code window and the browser page, in one of four modes given as the first argument. `ask` answers a question about code from a recording of it running, in chat: how it works, why a value is what it is, what it swallowed, what an edit changed, where the time goes. `debug` pauses a running Node program at a function or line, steps it and reads the frame, in VS Code or in the browser page. `explain` helps a person understand code interactively: inspect source, plan in memory, propose breakpoints and start a session, then jump by question or explain manual steps, with guided teaching when requested. `show` hands over a page where every value comes from a command: a tour of the whole run, or a code-history page around chosen steps. Use when asked to ask about, learn, debug, step, break, pause, explain, teach, walk through, review a change in, or "show me" what a JavaScript or TypeScript program did.
argument-hint: ask | debug | explain | show [what to look at]
disable-model-invocation: true
---

# Tracelight

Tracelight shows what JavaScript or TypeScript code does by running it: a recording of every
statement and value, or a debugger paused in the running program, shown in the user's VS Code
window, on a browser page, or in a saved run only you read. The four modes share a few habits.

Every claim rests on some kind of evidence: source you read, a live pause (the values before the
highlighted statement), a value after a step, a recorded step of a named run, a scratchpad or
mocked result, a prediction, or nothing at all (a value the runtime did not capture, a branch that
did not run). Each supports different claims, listed in
[explain.md](references/explain.md#at-a-stop-what-this-location-establishes). Say which one you
have when it matters, never present one as another, and say when two disagree.

A move the person asks for (continue, step into, restart, "show me") happens in the same turn,
and the explanation comes after it, from what the move returned. Never imply a move that did not
happen, and never advance execution while the person is stepping. Continue, a restart and a new
run execute real code, side effects included. On the browser page, explain only after the
navigation's returned `position` reports `ready: true`, repairing its `blockers` first. A recorded
selection and the live pause are separate, and focusing a recording does not rewind the program
([browser.md](references/browser.md#confirm-the-visible-position)).

Always start browser sessions with file watching enabled. It is the default: saves from VS Code
or another agent refresh the page, and while the page's debugger has a run they execute nothing.
`--no-watch` is optional, for a person who wants saves never to run the file. `--no-run` skips the
startup run.

Hearing a person's manual steps depends on the host. A `tracelight_wait_pause` wait lasts at most
25 seconds and ends with your turn, so it cannot wake an idle chat. Say that instead of looping on
waits ([explain.md](references/explain.md#when-the-learner-steps-by-hand)). A scratchpad
experiment is yours to prepare and repair before you teach from it, in one `experiment` call with
labelled mocks, and its result shows what copied code computes, not how the application wires it
([scratchpad.md](references/scratchpad.md#prepare-before-teaching)). Ask the person no quiz or
prediction questions unless they ask for them.

## Pick the mode

The first word after the skill name is the mode: `/tracelight ask why is Ben's total NaN`,
`$tracelight explain demo.ts`. Load that mode's file and follow it; it says what to deliver.
Read no other reference up front. The job's first command and its `tracelight VERB --help` carry
the flags (`tracelight debug FILE --at NAME` pauses a live program, `--node bun` for Bun); open
the CLI, debugger or browser reference when a command fails or its help does not answer.

| mode | for | what you hand back | read |
|---|---|---|---|
| `ask` | a question about what code does or did, answered from a recording | a short answer in chat with `file:line` and `#step`, the page offered in one line | [references/ask.md](references/ask.md) |
| `debug` | pause a running program, step it, read or set the frame, check a breakpoint | the stops you saw, in chat, then clean up | [references/debug.md](references/debug.md) |
| `explain` | understand code interactively in the editor or browser, with optional guided teaching | a plan, proposed breakpoints and a live session; jump by question or explain as the user steps | [references/explain.md](references/explain.md) |
| `show` | evidence someone will read, keep or send on | a tour or a code-history page, plus a short finding in chat | [references/show.md](references/show.md) |

With no mode, choose by intent and context. A question answered in chat ("why is", "what changed",
"did my fix work", "why is it slow") is `ask`. "Step", "break", "pause", "run to", "does it stop
in" is `debug`. "Help me understand how checkout works", "let me jump around and learn", "walk
me through", or "explain as I step" asks for interactive learning through `explain`. A standalone
factual question can stay in `ask`; do not route interactive learning into a prerequisite
recording. "Show me", "make me a page", "something I can send" is `show`. Honor an explicit mode.

Learning does not require a guided lesson. In `explain`, inspect relevant source, make a short
plan in memory, propose the breakpoints with the question each answers, then start the session
at the first useful stop. Do not wait for plan approval unless requested. Voice or chat can
direct jumps, and the person can step by hand while you explain the pauses the host lets you hear.
Guided teaching is optional. A debugging request does not imply a lesson. In `debug`, inspect source to
choose a stop that tests a hypothesis. Neither needs a preliminary recording. Source inspection
guides the next observation; claims about what executed still need runtime evidence.

Jobs that are not modes, and where each lives:

| the job | mode | read |
|---|---|---|
| understand a module interactively, jump to what matters, or explain manual steps | `explain` | [references/explain.md](references/explain.md) |
| which implementation ran, where a value came from, who decides, an async handoff, a real-path contrast | `explain`, `ask` | [references/learning-patterns.md](references/learning-patterns.md) |
| learn an LLM agent harness such as Pi (an optional example) | `explain` | [references/example-agent-harness.md](references/example-agent-harness.md) |
| understand a module from a recorded run, answered in chat | `ask` | [ask.md, "Learning code"](references/ask.md#learning-code) |
| what a program swallowed, where a bad value came from, what never ran | `ask` | [ask.md, "Hidden failures"](references/ask.md#hidden-failures) |
| what an edit changed, whether a fix took | `ask` | [ask.md, "Review an edit"](references/ask.md#review-an-edit) |
| rerun code that calls an API without the network | any | [ask.md, "Offline"](references/ask.md#offline-record-and-replay-http) |
| where the time goes | `ask` | [ask.md, "Where the time goes"](references/ask.md#where-the-time-goes) |
| teach with narration bubbles in a browser, or debug without touching VS Code | `explain`, `debug` | [references/browser.md](references/browser.md) |
| experiment with a function and copied paused inputs in the browser scratchpad | `explain`, `debug` | [references/scratchpad.md](references/scratchpad.md) |

## The three surfaces and the two products

**Run-all** records an execution: every statement, value and branch, in order. You navigate the
recording; nothing re-executes and nothing can be changed. It answers questions about what
already happened.

**The Debugger** runs a program and pauses at a breakpoint or an exception. You step, read the
frame and continue. It answers what the program does next, including real input and API calls.
Plain VS Code debugging records nothing; `--record` also captures that execution. The browser's
debugger captures the same execution as it pauses for Code history. Neither requires a prior
run. Reviewing history does not rewind the live program. See `references/debug.md`, "History
while debugging", for the available forms.

They reach you on three surfaces; a saved run is a recording only, the other two have both:

| surface | how | for |
|---|---|---|
| a saved run | `tracelight run FILE --save run.json`, then every verb takes `run.json` | you, alone: nothing on anyone's screen moves |
| the VS Code window | `--live` (setting `tracelight.agentAccess`), `tracelight debug FILE` | the person at their editor: `step` moves their Time Machine, the debugger pauses their window |
| the browser page | `tracelight web FILE`, then `tracelight web ctl ...` | a person in a browser tab, narration bubbles under lines, or the debugger without VS Code |

Every command takes `--json` for the raw shape; the text form is for you. Every verb, flag, JSON
shape and variable, with an example of each: [references/tracelight-cli.md](references/tracelight-cli.md).
The debugger's full contract: [references/live-debugger.md](references/live-debugger.md). The page:
[references/browser.md](references/browser.md). Without a shell, the same commands are MCP tools:
[references/mcp.md](references/mcp.md).

## Before the first command: find the runtime and the editor

### Find the target without a search detour

Separate the code the user wants to understand from the Tracelight runtime used to inspect it.
Being in the Tracelight repository does not mean the target library or scratch driver lives there.
Choose the mode from the request before reading its reference; interactive learning starts with
`explain.md`, not `ask.md`. Load other references only for the controls needed next. Reuse loaded
instructions within the session.

Follow the strongest available lead, stopping discovery when the target is established:

1. Reuse paths, package names, browser URLs and session identifiers already supplied in this
   conversation. Check that a named file exists; read a known session's state once for its entry
   file, source paths and pause. Do not rediscover an open target through repository searches.
2. For a named file without a path, use a scoped filename search (`rg --files -g '*checkout*'`)
   in the likely project or known scratch directory. For a library, follow the caller's imports
   and package metadata. For an installed CLI, locate its executable (`command -v NAME`), resolve
   its symlink or inspect its launcher, then follow that package's dependencies to the implementation.
   Use the matching package manager's installation root only if the launcher does not resolve it.
3. Expand scope only after a concrete miss, and record what that miss ruled out. An empty search
   of the Tracelight checkout says nothing about a globally installed package. Do not cycle
   through spelling variants, list the whole home directory, or scan unrelated package stores.
   If no concrete lead remains, ask for the missing location instead of guessing more roots.

Batch independent path checks and small metadata reads. Keep resolved entry, package and runtime
paths in working memory. Once the caller and owning implementation are found, inspect enough to
propose stops and launch; further source discovery can follow the user's questions. Screen
inspection is for relevant visible state through the permitted UI tools, not a filesystem locator.

### Resolve the control runtime once

Reuse a verified runtime or connected browser control surface within this session. A working
WebMCP session does not require CLI or editor-launcher discovery. For a new CLI session, resolve
the runtime on this machine. Extension folders carry a version
(`ivor.tracelight-0.3.0`), so a path saved in a note or another session goes stale on the next
update and fails as `Cannot find module`. Look in this order:

1. `tracelight` on PATH (`command -v tracelight`), else `~/.local/bin/tracelight` by its full
   path. The extension writes that script while `tracelight.agentAccess` is on. A stock macOS PATH
   does not include `~/.local/bin`, so call it by that full path; the user's shell profile stays
   as it is.
2. `scripts/tracelight.sh` next to this file does the same search, and inside a Tracelight checkout
   runs the checkout's own `node/bin/tracelight.mjs` with `node`.
3. The installed extension ships the runtime under `dist/node`. Look in the editor's extensions
   directory (`~/.vscode/extensions`, `~/.vscode-insiders/extensions`, `~/.cursor/extensions`,
   `~/.vscode-server/extensions`, or `%USERPROFILE%\.vscode\extensions` on Windows) for
   `ivor.tracelight-*`, take the highest version, and run `dist/node/bin/tracelight.mjs` with `node`.

The CLI needs Node 22.18 or newer, since it runs its own TypeScript sources (`node --version`;
`$TRACELIGHT_CLI_NODE` picks the one the `~/.local/bin` script uses). The program it runs needs
Node 22.15 or newer, or native Bun selected with `run --node bun` / `web --runtime bun`.
`run --node PATH` and `$TRACELIGHT_NODE` select a specific program executable. Verify a newly
resolved CLI once: `tracelight debug -h` prints that verb's usage and exits 0 (bare `tracelight -h` prints
the verb list and a first command per job, and exits 2). If none of the three gives that, stop
there and tell the user which step failed.

`tracelight web` is newer than the CLI: a runtime without it answers `usage: tracelight serve |
...` with no `web` in the list, or says it has no browser page. From a Tracelight checkout,
`npm run build` once and use `node <checkout>/dist/web/server.js` with the same arguments.

The debugger may also need the editor's launcher. A cold `tracelight debug` opens a URI through
`code` on PATH, or through `$TRACELIGHT_CODE` when that is set (the `~/.local/bin` script sets it
to the editor that wrote it). If `code` is missing, the CLI says ``cannot find the `code`
command``. Find the launcher this editor ships (VS Code on macOS keeps it at
`<app>/Contents/Resources/app/bin/code`; Cursor's is `cursor`; on Linux it is usually on PATH
already), and set `TRACELIGHT_CODE` for this shell. Or ask the user to run "Shell Command: Install
'code' command in PATH". Commands you leave behind use `~`, `$HOME` and globs, so they work for
any user and any version.

## Sessions

**Saved run.** `tracelight run FILE --save run.json` executes the file once; every command then
takes `run.json` first. `FILE` is `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`, `.jsx` or `.tsx`;
TypeScript runs as it is, with no build step and no `tsconfig` change. Read what `run` prints
before anything else: the program's own output, each logged line prefixed with the `file:line`
that printed it, an `error:` line for an uncaught exception, then `saved run.json: N steps, N
files, exit N`. A value ending in `…(+N chars)` was cut; when you need all of it, rerun with
`--max-value-chars 0` and read it with `--json`. Every verb over a run cut by `--max-steps` starts
with a `note: truncated recording` line: rerun with the `--exclude` it names (or a higher
`--max-steps`) before you read the run, and pass the note on when your answer depends on what came
after the cap.

**`0 steps` means nothing was recorded**, and the cause is one of three. The runner failed: read
its error first. `EPERM` or `Operation not permitted` means your own sandbox blocked the child
process or its socket; ask to run the command outside the sandbox, and leave the program and its
config as they are. Or the file was reached through a symlinked path: on macOS `/var` and `/tmp`
are symlinks, so a program under `$TMPDIR` or `/tmp` runs but is never instrumented; run it from
its real path (`realpath`, `/private/var/...`). Or the run was `--mode profile`, which records no
steps on purpose and prints `profiled, no steps recorded`.

**A debug session is made, not found.** In `debug` mode the first command is `tracelight debug
FILE --at NAME`: it starts the session in the user's VS Code window and prints the first stop.
Make it your first command: nothing is running until it starts the session, so a `--live` command
sent before it answers `no live session`. Every `--live` command after the first stop drives that
session.

**A recording session (`ask`, `show`, or a lesson using a recording) is the user's.** It exists only when the user
started Tracelight on the file in VS Code ("Start on Current File", or a smart-start rule); having
the file open is not enough, and `tracelight.agentAccess` only lets you reach a session, it starts
none. Check with `state --live`, which moves nothing. On `no live session`, move on at once: record
it yourself with `tracelight run FILE --save run.json` and use `run.json` instead of `--live`, or
ask the user to start Tracelight on the file if they want the editor to follow along.
This recording fallback does not apply to live learning or debugging. Start or reuse the
debugger for those; a new browser exploration uses `web FILE --no-run` before setting
breakpoints and issuing `web ctl debug start`.

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
On the browser page the same split holds: `ctl state` reads, `ctl goto`, `step` and `line` move the
page the person is watching.

**Under a sandbox (Codex).** The CLI reaches VS Code through `$TRACELIGHT_HOME/sessions/*.sock`, and
the page through `127.0.0.1`. If a command fails with `Operation not permitted` or `stopped
answering` right after connecting, your sandbox blocked the socket or the runner: ask to run that
command outside the sandbox. It is not a missing session.

## In Claude Code: the band

When `printenv CLAUDECODE` prints `1` and the `band` tool (`mcp__tracelight-band__band`) is in your
tool list, the Tracelight band can show the person what the Time Machine or a debug pause shows,
above their prompt. Call it with `{"action": "show"}` when you start stepping with them and
`{"action": "hide"}` when the work moves on, and pass `--session NAME` on every `--live` command.
What else it does (where a bad value came from, fix plans, the `/tl` keys to tell the person):
[references/band.md](references/band.md). Without the tool, say once how to install it (band.md)
and carry on with the CLI. Other agents skip this section.

## Stay out of the user's project

Use what the project already has: an existing test file, the entry point, or a module the user
named. For an installed library with no runnable example, a small SDK caller may live in a
scratch directory outside the project. Explain that caller and use the real installed library. Leave their repository exactly as you found it: its files, its
config (`package.json`, `tsconfig.json`, `.babelrc`, `vitest.config.ts`), its lockfiles
(`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`), its `node_modules`, its
directories and its `.git`. Install nothing into it. If the code needs a database or an external
service to run and no test covers that path, say so and ask the user how they want to reach it.
`run.json`, `history.json`, prose and pages go in a scratch directory outside the repository
(its real path, see `0 steps` above).

Three things write next to the program, and you say so when you use them: `--http record` writes
`.tracelight/replay/<hash>.jsonl` (response bodies included), the MCP tool `tracelight_run` saves
to `.tracelight/runs/<name>.json` unless you give `save`, and the band's fix plans go to
`.tracelight/findings/`. None of them belongs in a commit.

## Staleness and secrets

`stale: helper.ts changed since the run` printed first, or `"stale": true` in JSON, means the
file on disk (saved run) or the editor buffer (live) no longer matches what ran, so line numbers
and values may be off. Save again; live, a save re-runs and re-anchors by itself. `tracelight
history` refuses outright on a stale run.

Every value, error message and eval result that leaves the runtime is redacted (`sk-…`, `AKIA…`,
`ghp_…`, bearer tokens, JWTs, and the value of any key named like `apiKey`, `api_key`, `secret`,
`token`, `password`), and so is the value of any secret-looking environment variable. A recording
still holds the program's data: keep `run.json`, replay files and pages out of chat, commits and
issues, and do not read or print the project's `.env`.

## Finish clean

Before you write the final answer, and while the session is still running: remove the breakpoints
you added (`break --live --remove F:L` for a line, `--remove NAME` for one `--at NAME` set),
confirm with `break --live --list`, then `stop --live` unless the user wants the pause kept, and
check `state --live`. Removing needs a session to reach the window: once the program has exited,
its breakpoints stay until the next launch. Breakpoints that were there before you belong to the
user; leave them. Release a kept runner with `tracelight release run.json`.

Every process you started for the task is yours to end: a `tracelight web` bridge (its startup line
prints its pid), the headless browser holding a page, a server you launched yourself. Note each PID
and port when it starts. When the task is done, stop them (`kill PID`; a bridge closes its runners
on the way out), or ask the person whether to keep them running, naming each port and PID. Never
end a task with a running process the person has not been told about, and reuse a bridge you
already started for a file instead of starting another on a new port. If you were interrupted
before this, say which of it is still undone.
