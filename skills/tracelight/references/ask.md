# ask: answer a question about code from a recording

The user asks what code does or did: "how does the ranking work", "why is `contribution`
0.015873 on some passes", "what does `new OpenAI(...)` do with the key", "Cy's invoice never shows
up", "did my change break anything", "why is this slow". A model can guess from the source. This
mode runs the code and answers from what the run did, so every claim points at a step.

Deliver in chat:

- **The answer first**, in a sentence or two, then the evidence: `file:line` and `#step` for each
  value you cite, so the user can `Shift+F5` there or run `tracelight context run.json N`.
- **What the run showed, apart from what you infer.** A run covers one input. Say which paths it
  took and which it never reached (`coverage`), and mark an inference as one.
- **The page in one line** when the finding is worth keeping ("I can make this a code-history
  page"); build it with [show.md](show.md) only when asked.

Contents: [The method](#the-method) · [What to run](#what-to-run) ·
[Learning code](#learning-code) · [Hidden failures](#hidden-failures) ·
[Review an edit](#review-an-edit) · [Offline](#offline-record-and-replay-http) ·
[Where the time goes](#where-the-time-goes) · [Answering](#answering)

## The method

Record once, map, land on the steps that answer, follow the values back. Every command's flags and
output: [tracelight-cli.md](tracelight-cli.md).

```sh
tracelight run app.ts --save run.json          # 1. record; read what it prints
tracelight walkthrough run.json                # 2. map: calls with in/out, branches, loops, prints, errors, each with #step
tracelight step run.json 42 --into             # 3. land: the callee with its arguments
tracelight why run.json 117 fusedRanking       # 4. follow: where the value came from, five levels back
```

| the question | the command |
|---|---|
| "what does this program do" | `walkthrough RUN`, then `graph RUN --no-statements` for who calls whom |
| "what does `rrf` do with its input" | `walkthrough RUN --scope rrf`, then `step RUN N --into` at its call |
| "where is this value made" / "why is it 0.0159" | `find RUN 0.0159` for the step, then `why RUN STEP NAME` |
| "how does `total` change" | `var RUN total` (every change, with what the statement read) |
| "what happens on each pass of this loop" | `values RUN --line F:L`, or `steps RUN --line F:L` for the step numbers |
| "what is X at the end" | `run --keep`, then `eval RUN 'X'` (pure reads only), `release RUN` after |
| "which lines ran" | `story RUN --file F`, `coverage RUN --file F` |
| "what did the package do with my argument" | `run --library-code`, then `step RUN N --into` on the call |
| "what did the API answer" | `http RUN`, then `context RUN N` on the request's step |

Read the maps yourself; they exist to give you step numbers. The user wants the few steps that
answer, in your words.

## What to run

Run the code the way it really runs: the entry point (`package.json`'s `main`, `bin` or `start`
names it), an existing test file (a `node:test` file is a program), or the command the user
named, with its arguments after `--` (`tracelight run api/server.ts --save run.json -- --once`).
Reach a module through its real caller rather than in isolation, since the caller decides the
input. When nothing in the project calls it, a short driver in your scratch directory that imports
it by absolute path is the next best, and the answer says so.

- **A package's internals.** `--library-code` instruments `node_modules` too (never Node's own
  `node:` modules). Slower and bigger, so add it when the question is about a package.
- **A big run.** A run past `--max-steps` (default 999,999) prints a WARNING naming the files that
  spent the steps, and every verb then starts with `note: truncated recording ... rerun with
  --exclude X`. Do that before reading it. `--only GLOB` records just the files the question is
  about; `--exclude` wins over `--only`.
- **Long values.** A local keeps 120 characters and a logged value 200; `…(+N chars)` marks a cut.
  `--max-value-chars 0` keeps whole values (up to 1,000,000 characters).
- **The final state.** `--keep` leaves the runner alive, so `eval` and `expand` read the finished
  values (`eval` refuses a call to the program's own functions, since reading must change nothing).
  `release RUN` ends it.
- **Code that needs a server, a database or a credential.** If no test covers that path, say so
  and ask how the user wants to reach it. For HTTP, see [Offline](#offline-record-and-replay-http).
- **A timeout.** A run stops after 30 s (`--timeout MS`). A server that never exits needs a flag
  that serves once, a test that calls it, or the debugger ([debug.md](debug.md)).

The open VS Code session (`--live`) answers the same verbs when the user already started
Tracelight on the file and wants the editor to follow; `state --live` says whether there is one.

## Learning code

When the user is learning a file or module, build the explanation from the run's shape outward,
in this order:

1. `graph RUN --no-statements`: the modules, functions and packages, who called whom and how often,
   with `⇢` where a value made by one function went into another. That is the outline.
2. `walkthrough RUN --scope NAME` for each function that matters: its calls with `in` and `out`,
   the arms its branches took, its loops with counts.
3. `tour RUN`: chapters of the run with the steps worth a stop and the signals that picked them
   (`spine`, `io`, `crossing`, `exception`, `narrative`). On a long run, read its text form as a
   reading guide even when you are not building a tour page.
4. `step RUN N --into` and `why RUN N NAME` on the two or three steps that carry the idea.

Teach behaviour before terms ("adds 1/(60+rank) for every list the document is in", then "that is
reciprocal rank fusion"), with the recorded numbers, not adjectives. To teach while the person
watches, line by line, switch to [explain.md](explain.md).

## Hidden failures

A program that "runs fine" and does the wrong thing usually swallowed an error or carried a bad
value a long way. Look in this order:

1. **`exceptions RUN`**: one row per exception type, throw site and handler, uncaught first.
   `broad handler` marks a `catch` that takes every error; one that logs nothing and rethrows
   nothing is where work disappears. `caught outside stepped code` means Node, a package or a
   promise's `.catch()` swallowed it. Rejections raised in instrumented async functions and
   consumed by `Promise.allSettled` or `.catch()` are retained in the finished exceptions report.
   An unawaited rejection that terminates Node remains uncaught. Uninstrumented throw sites can
   still be unknown; read the walkthrough's `out raised` lines and rejected values as well.
2. **`origin RUN STEP [EXPR]`** on the exception's step: the chain from the failing statement back
   to where the bad value took its form, newest first, the root marked `▶`. Without `EXPR` it takes
   the value the exception is about when it can tell; when it cannot, it lists what the statement
   read and says `give EXPR` (a name or a property path, `order.tier`). Each link says how it
   joins (`read`, `argument`, `return`, `assigned`, `element`, `literal`) and how sure it is: no
   word is recorded, `inferred` was picked by value among candidates, `text match` only by text.
   Check an `inferred` link with `step RUN N --into` before an answer rests on it.
3. **A wrong value with no exception** (`NaN`, `undefined`, an empty list): `find RUN NaN` gives
   the steps that hold it, then `why RUN STEP NAME` walks back through the statements that made it.
   `= ?` in a chain is a value nothing recorded; `· ... not stepped` is a call whose body left no
   steps (a built-in, a package without `--library-code`).
4. **What never ran**: `coverage RUN` per file (`notRun` lines, `partial` lines where a branch arm
   or a short-circuit never ran), `coverage RUN --file F` line by line with hit counts. A test that
   passes without reaching a branch proves nothing about it.
5. **Requests that failed quietly**: `http RUN` (status, the statement that made the request, and
   `miss` for a replay that had no recorded answer).

Name the root, not the line that threw. The fix goes where the value took its form.

## Review an edit

"What did my change do" and "did the fix work" are a comparison of two runs.

**Before the edit**, record the program as it is, then edit, then record again:

```sh
tracelight run shop.ts --save "$S/before.json"
# edit shop.ts
tracelight run shop.ts --save "$S/after.json"
tracelight diff "$S/before.json" "$S/after.json"
```

**When the edit is already made** (uncommitted), record the after where it is and the before from
the last commit, exported into your scratch directory so the repository is untouched:

```sh
S=$(realpath "$SCRATCH")                       # a real path: a symlinked one records 0 steps
mkdir -p "$S/before" && git -C "$REPO" archive HEAD src | tar -x -C "$S/before"
ln -s "$REPO/node_modules" "$S/before/node_modules"   # only if the program imports packages
tracelight run "$S/before/src/shop.ts" --save "$S/before.json"
tracelight run "$REPO/src/shop.ts" --save "$S/after.json"
tracelight diff "$S/before.json" "$S/after.json"
```

`diff` pairs the two main files whatever their paths, and the other files by their path relative
to the main file's directory, then by name. With a recording session open on the file in VS Code,
`diff before.json --live` takes the session's re-run as the after (values need
`tracelight.timeMachine.recordLocals` on in that window).

Reading it: `statements: 15 same, 1 edited, 0 added, 0 removed` is the matching, the first listed
statement is where the runs part, and each fact is `before → after` with `a#N` and `b#N`, the step
on each side, so `tracelight step before.json 7 --into` opens either one. A timestamp or a random
id differs on every run by nature; read past it.

**A fix took** when the after run shows the intended change at the root and nothing you did not
mean: the exception is gone from `exceptions`, `origin` no longer reaches the old root, the facts
`diff` lists are the ones the fix should change, and `coverage --file` shows the new branch ran.
Say which of these you checked.

## Offline: record and replay HTTP

Code that calls an API can be re-run without the network, the latency or the tokens:

```sh
tracelight run agent.ts --save "$S/run.json" --http record   # once, with the network and the credentials
tracelight run agent.ts --save "$S/run.json" --http replay   # every later run: answered from the recording
tracelight http "$S/run.json"                                 # each request: live, recorded, replayed or miss
```

`--http record` writes every exchange (`fetch`, `node:http`/`https`, `undici`, `XMLHttpRequest`)
to `.tracelight/replay/<hash>.jsonl` next to the file, bodies included. That is a file in the
user's project holding real responses: tell the user, and keep it out of commits. A replay `miss`
is a request the recording does not have (a changed URL, body or order): record again. URLs print
with query values stripped.

In VS Code the same switch is the setting `tracelight.http` (`off`, `record`, `replay`). A debug
session observes HTTP only while it records, so `tracelight debug` without `--record` sends real
requests.

## Where the time goes

```sh
tracelight run app.ts --mode profile           # profile: /…/app.ts.cpuprofile, then: profiled, no steps recorded
```

One run under V8's profiler, with Tracelight's own frames removed so no user function carries
the runtime's time. It records no steps, so the run verbs have nothing to read; the result is the
`.cpuprofile`, which Chrome DevTools (Performance, Load profile) and VS Code open. For a table you
can read yourself, the browser page's bridge folds it into the hottest functions, and it needs no
browser open:

```sh
tracelight web app.ts --port 4790 --no-watch > "$S/web.log" 2>&1 & pid=$!   # the bridge, in the background
until curl -s -o /dev/null http://127.0.0.1:4790/; do sleep 0.2; done
tracelight web ctl --port 4790 profile   # {path, totalMs, rows: [{name, file, line, selfMs, totalMs}]}, top 20 by self time
kill $pid
```

Run those four lines as one shell command, so `$pid` is still there for the `kill`. A recording
also carries the run's length (`run ends with exit code 0 after 208 ms`, the last walkthrough
moment), not a time per step. Profile and recording are separate runs: never read time
off a recorded run, which runs slower by design.

## Answering

- Lead with the answer, then two to five pieces of evidence, each `file:line #step` with the value.
- Quote values as the run printed them (`0.03252247488101534`, `'1,299.00'`), rounded only when
  the point is the size.
- Say what the run did not cover, and what you inferred rather than saw.
- Quote no run file, replay file or page into chat beyond the values the answer needs.
- Leave the source as it is unless the user asked for a fix. A fix you propose goes at the root
  `origin` named, and `diff` checks it.
