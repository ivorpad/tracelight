# debug: pause a running program and look

The user wants real pauses in their editor: start the program, stop where the question is, step,
read the frame, maybe change a value, continue. Answer in chat with the stops you saw (file, line,
the values that matter). The answer lives in chat; offer the page in one line when the finding is
worth keeping, and build it with [show.md](show.md).

The full contract (the three start routes, `exec`, servers, limits, what a stop leaves out) is
[live-debugger.md](live-debugger.md). This file is the workflow.

## Start

```
tracelight debug FILE [--at NAME | --at FILE:LINE] [--args ...] [--stop-on-entry] [--library-code]
                      [--record | --record-from NAME | --record-from FILE:LINE]
tracelight debug server.ts --cwd . --env PORT=8765 [--node PATH]
tracelight debug test/ranking.test.ts --at fusedOrder
```

A file implies `--live`. The reply is the first stop: the breakpoint `--at` named, the first
gutter breakpoint, or the first statement when nothing is set. The window comes to the front at
that stop, and the paused function's lines show their values in the editor, read from the frame.

There is no module launch for Node: `--module` is refused with a hint. Give the entry file, the
one `package.json`'s `main`, `bin` or `start` script points at. `--node PATH` (or
`$TRACELIGHT_NODE`, else the window's `tracelight.nodePath`) picks the Node that runs the program.

**Start with `tracelight debug`.** `state --live`, `break --live` and `continue --live` drive a
session that exists. `debug ... --at` creates the session and the breakpoint in one command. Once
you have run `tracelight debug` from a directory, those verbs start it again by themselves after
the program exits, and their first output line says so; tell the user, because the program ran
again.

Add `--record` when the user wants to watch the program's history in the editor (every line's
values, the Time Machine, `why`), and the program is small enough to record: every statement is
kept, so a request that runs a million steps is slow to record. Without it the editor shows the
paused function's values only. `tracelight debug FILE --record` from a terminal opens the file in
an editor and attaches at the first pause. See "History while debugging" below.

When the question is about one function of a long run, use `--record-from NAME` (or
`FILE:LINE`) instead of `--record`. The program runs at the debugger's speed up to that pause and
records from there on, so the Time Machine, `why --live`, `var --live` and `history --live` cover
everything that runs after it. The stop line ends with `recording starts here, step 0`. A `why`
chain that reaches a value made earlier ends with `made before #0, where the recording started`:
read that value from the stop's `locals:` instead. At an earlier pause of the same run (another
`--at`, a step), `tracelight record --live` starts the recording right there.

Pick a breakpoint the run will reach:

- Prefer `--at FUNCTION` (the entry of the function the question is about) over a line number.
  A method is `--at Ranker.rank`; an arrow function assigned to a `const` is found by that name.
- With a line, read the source around it first. A `throw`, an error branch, a `catch` body or
  an early `return` does not run on the success path. Break on the function's first line or the
  first statement of the path you expect to run.
- If the user named a line, use it, and say so if it sits on a path the run may not take.

Reach the code through an existing test or the program's own entry point.

**Following a pipeline: one `--at` per stage.** `--at` repeats, and every one is set before the
program starts, so `tracelight debug app.ts --at load --at clean --at score` stops at the first
stage that runs, and each `continue --live` goes to the next breakpoint, in whatever file it is,
until the program finishes. This is the classic debugger loop: break, look, resume to the next
one. Add a stage while paused with `break --live --at NAME` or `break --live FILE:LINE`; the run
picks it up at once. Name stages by function where you can, since a function name survives edits
that move lines.

**Tests: debug the test file itself.** A `node:test` file is a program: `tracelight debug
test/ranking.test.ts --at fusedOrder` runs its tests and pauses in the code under test. A runner
that runs tests in worker processes or its own module graph (Vitest, Jest, Mocha with `--parallel`)
runs your code where the debugger does not reach, so its breakpoints never resolve. That is the
likely cause, not a proven one. Reach the code through a `node:test` file or the entry point
instead.

## Ready means paused where you meant

Three things can each succeed or fail on their own: the launch, the breakpoint, the program. A
launch whose breakpoint never runs finishes without pausing, the program exits 0, tests pass, and
`stop` reports `0 steps`. None of that means the debugger worked. Before you say it is ready, read
the first stop's `paused at FILE:LINE` and check it is the file and function you asked for. If it
is somewhere else, or there was no stop, say so, and fix the launch before going on.

**Breakpoints outlive the launch.** Gutter breakpoints belong to the VS Code window, so one added
by `--at`, `break --live` or an earlier session is still there next time, and the run stops at it
first. After the first stop, run `break --live --list` and compare it with what you asked for.
Keep a list of the breakpoints you added; those are the ones you remove at the end, with
`break --live --remove F:L` for a line and `--remove NAME` for the function breakpoint `--at NAME`
made. Remove them before `stop --live`: with no session the CLI cannot reach the window.

**The window answers only with `tracelight.agentAccess` on.** With it off, VS Code asks the user to
allow agent access, and **Allow** starts the launch; tell them to look for the question. The first
URI also needs a click.
`tracelight debug` tries an existing debug session, then a recording session on the file, then
`vscode://ivor.tracelight/debug`. That last one makes VS Code ask the user to allow it, and the CLI
can time out after 20 s while the question is still on screen. That is not a failure: the next
command is `tracelight state --live`, not a second `tracelight debug`.

The URI goes to the **focused** window, and a window with a different project open accepts it and
instruments nothing: the program runs, no breakpoint resolves, `stop --live` says `0 steps`.
Check `workspace` in `$TRACELIGHT_HOME/sessions/*.json` before blaming anything else.

## When it did not pause

Change one thing at a time, and try only a few. In order: check the session's `workspace`, check
the breakpoint line runs, launch the entry file rather than a runner that spawns workers, try
`--stop-on-entry` to see whether anything is instrumented at all. Make one of these changes before
each re-run, and note the result. If all four fail, stop and tell the user what you tried and what
each showed.

## At a pause

Every stop already carries the frame (`locals:`) and what the program printed (`output:`), so
`locals --live` right after a stop is a wasted round trip. One command per sentence the human
said: "step over twice and tell me what `total` is" is `step --live --over --count 2`, and the
answer is in that stop's `locals:`. Values print as Node prints them: `undefined`, `null`,
`[ 'A', 'C' ]`, `{ k: 60 }`, and `this` is in the frame like any other name.

**`exec --live 'rank = 3'` writes to the paused frame, and the program sees it.** Every stop after
that says `(values modified from the console)` and a bug report built on it is worth less. Say what
you changed. A `const` cannot be reassigned there any more than in the program.

## History while debugging

A plain `tracelight debug` records nothing, ever: not while it runs and not after it finishes.
When the program exits the session is gone and there is no history to look at. So `why`, `var`,
`story`, `walkthrough`, `graph`, `exceptions`, `http`, `values` and `step --back` answer `<verb>
needs a recording`, and waiting for the program to finish does not change that. Pick by what the
user wants, and say which you used:

| the user wants | run |
|---|---|
| history and live pauses together (Time Machine, `why --live`, `var --live`, `step --live --back`) | `tracelight debug FILE --record ...`: slower |
| the same, from one function on, in a run that is long before it | `tracelight debug FILE --record-from NAME`: debugger speed up to NAME, recording from its first call on |
| a code-history page of what they saw while debugging | `tracelight history --live --pause --out h.json` at each pause, `--append` for the next; each card is a live pause with the frame's values and no `why` chain |
| the whole run's history, no pausing | `tracelight run FILE --save run.json`, then `why`, `var`, `walkthrough`, `history` on it (see [show.md](show.md)) |
| only what is in scope now | answer from the stop's `locals:` and the values shown in the editor |

Under a test runner that spawns workers, neither recording reaches the code: use a `node:test`
file or the entry point, or the page of live pauses, and tell the user that history is the part
that is missing.

In Claude Code, show the band after the first stop (`{"action": "show"}`) and pass `--session
NAME` on every `--live` command. At a plain pause it shows the frame, marked `paused · no
recording`, and its `/tl r` key records from the paused line by running the program again from
the top; with `--record` it shows the Time Machine, bugs, where a value came from and fix plans.
Which keys to tell the person, and what each does at a pause: [band.md](band.md).

A long session of stops is cheaper through `tracelight shell --live`: one command per stdin line,
the same words without `--live`, one connection instead of a new Node process per command.

## Without VS Code: the browser page's debugger

When the person watches a browser rather than their editor, or VS Code is not the place to pause
(another person's window, a machine without it), the browser page has a debugger of its own. It
runs the file for real on a second runtime, records that same execution, and shows each stop
with its stack and variables. Code history follows the pause, with explicit review of earlier
recorded events. [browser.md](browser.md) has the commands and their replies.

```sh
tracelight web app.ts --port 4790 --open          # in the background; the person opens the page
tracelight web ctl --port 4790 break 32 on
tracelight web ctl --port 4790 debug start        # runs to the breakpoint: the stop, with the frame's locals
tracelight web ctl --port 4790 eval "order.tier"  # in the paused frame
tracelight web ctl --port 4790 debug step into
tracelight web ctl --port 4790 debug continue     # the next breakpoint, or the end
tracelight web ctl --port 4790 debug stop
```

It starts like the VS Code debugger (to the first breakpoint, or the first statement when none
is set), and `ctl eval` at a pause runs in the paused frame. It differs in what it lacks: no
`exec`, break-when watch or function breakpoint, and a pause request on a program that
is already paused waits 10 seconds. Breakpoints are lines of the main file. Finish clean there too:
`break LINE off` for each line you set, `debug stop`, and stop the page if nobody uses it.

## What the human says, and what you run

| the human says | the command |
|---|---|
| "start the debugger at `rrf`" | `tracelight debug demo.ts --at rrf` |
| "break at line 64" | `tracelight debug demo.ts --at demo.ts:64` |
| "stop at each stage of the pipeline" | `tracelight debug app.ts --at load --at clean --at score`, then `continue --live` per stage |
| "add a breakpoint in the other file" | `tracelight break --live other.ts:12` (or `--at fn`), then `continue --live` |
| "resume to the next breakpoint" | `tracelight continue --live` |
| "remove that breakpoint" | `tracelight break --live --remove other.ts:12` / `--remove fn` |
| "debug this test" | `tracelight debug test/ranking.test.ts --at fusedOrder` |
| "start the server under the debugger" | `tracelight debug api/server.ts --env PORT=8765` (no `--watch`, no `nodemon`) |
| "run to line 64" | `tracelight continue --live --to demo.ts:64` |
| "step over until `rank === 3`" | `tracelight continue --live --until 'rank === 3'` |
| "step into that" / "step out" | `tracelight step --live --into` / `--out` |
| "what is in scope" | read `locals:` off the stop you already have |
| "set `rank` to 3 and carry on" | `tracelight exec --live 'rank = 3'` then `tracelight continue --live` |
| "break when `payload` is undefined" | `tracelight watches --live --add 'payload === undefined' --break-when true` |
| "stop on every exception" | `tracelight break --live --on-exception raised` |
| "where did this bad value come from" | on a recording, `tracelight origin --live STEP` (or `origin run.json STEP`) with the exception's step from `exceptions`; fix the line marked root, not the line that threw |
| "let it run, do not wait" | `tracelight continue --live --no-wait` |
| "start over" / "stop" | `tracelight restart --live` / `tracelight stop --live` |
| "debug it in the browser" | `tracelight web FILE --open`, then `tracelight web ctl break LINE on` and `debug start`, `debug continue` |

## After an edit

When the fix is a code change, compare runs with `tracelight diff`. Save a run before the edit
(`tracelight run FILE --save before.json`), edit, then save `after.json` the same way and run
`tracelight diff before.json after.json`. With a recording session open on the file (Run-all, or
`tracelight debug FILE --record`), `tracelight diff before.json --live` takes its re-run as the
after. It lists the statements that did something different (values, branch arms, calls, throws)
with each side's step numbers, so `tracelight step before.json N --into` opens either side.
Report the facts that show the fix took and anything else that changed with it. The flags and
the matching rule: [tracelight-cli.md](tracelight-cli.md#comparing-two-runs-after-an-edit).

## Done

Finish clean (SKILL.md): remove your breakpoints, `stop --live` unless the user wants the pause,
confirm with `break --live --list` and `state --live`. Then report: where it paused, the values
that answer the question, what you changed with `exec` if anything, and what is still open.
