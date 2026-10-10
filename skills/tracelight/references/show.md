# show: investigate, then hand over a tour or a code-history page

The user wants to understand how or why, with evidence they can read, keep or send on: "show me
how rrf works", "why is `contribution` 0.0159", "what did `new OpenAI(...)` do with the key". You
investigate a recording (or a live pause) and deliver a page, plus a short finding in chat. For
a quick question or a check, answer in chat and offer the page in one line instead.

Pick the page by the question:

| the question | the page | built by |
|---|---|---|
| how a run works, what a file does, a run too long to read ("show me how the agent answers") | a **tour**: chapters of the run, a few stops in each, every value from the recording | `tracelight tour` + prose + `render-tour.cjs` ([Build a tour](#build-a-tour)) |
| why one value is what it is, a variable's changes, a live pause, steps you picked by hand | a **code-history page**: source on the left, checkpoints on the right | `tracelight history` + prose + `render-code-history.cjs` ([Build a code-history page](#build-a-code-history-page)) |

## Investigate

Record once, map, then two or three stops. Map with `walkthrough`, `graph` and `find`, which fit
on a screen, and let the CLI read `run.json` for you.

```sh
tracelight run demo.ts --save run.json [--library-code] [--keep] [--http record]
tracelight walkthrough run.json               # every moment in order with its step number
tracelight why run.json 117 fusedRanking      # why a value is what it is, five levels back
```

`--library-code` also steps packages in `node_modules`, never Node's own `node:` modules, which is
what you need to see what a package did with an argument. `--keep` leaves the process alive so
`eval` and `expand` can read the final values.

When a verb starts with `note: truncated recording`, rerun with the `--exclude` it names (or a
higher `--max-steps`) before mapping: a page built from a truncated run stops at the cap. A value
that ends in `…(+N chars)` on a checkpoint was cut by the recording; rerun with
`--max-value-chars 0` when the page has to show it whole (a prompt, a model reply).

| verb | what it answers |
|---|---|
| `walkthrough RUN` | what happened, in order, one moment per line with its step number |
| `graph RUN` | the shape of the program: who called whom, how often, which branches |
| `story RUN --file F` | the lines that ran, in order, with the step each first ran at |
| `find RUN TEXT` | where a value, message, logged string or source line is |
| `steps RUN --line F:L` | the step numbers on one line |
| `context RUN N` | everything at one step: block, values, stack, moves |
| `step RUN N --into/--over/--out/--back` | move the cursor and show the new step |
| `values RUN --line F:L` | every value logged on one line, by hit, for a loop |
| `var RUN NAME` | every recorded change of a name, with what the statement read |
| `why RUN STEP NAME` | why a value is what it is, five levels back |
| `origin RUN STEP` | where the bad value behind an exception was made |
| `eval RUN EXPR` | a pure expression over the finished run (needs `--keep` or `--live`) |
| `exceptions RUN` | every exception, where it was thrown and caught, broad handlers flagged |
| `http RUN` | every HTTP request, with the statement that made it |
| `coverage RUN` | which statements ran, never ran, or ran in part |
| `diff BEFORE AFTER` | what an edit changed: values, branches, calls, throws, with both runs' steps |
| `state RUN` | file, step count, exit code, staleness, the sessions that exist |
| `tour RUN --out P` | chapters and candidate stops of the whole run: the data behind a tour |
| `history RUN --at ... --out P` | the data behind the code-history page |

| the human says | the command |
|---|---|
| "show me how rrf works" | `tracelight run demo.ts --save run.json`, then a tour |
| "explain what this file does" | `tracelight tour run.json`, then a tour page |
| "why is `contribution` 0.0159" | `tracelight why run.json <step> contribution` |
| "where does `scores` change" | `tracelight var run.json scores` |
| "what did my change do" | `tracelight diff before.json after.json`, then `why` on either side's step |
| "what did `new OpenAI(...)` do with the key" | `tracelight run agent.ts --save run.json --library-code`, then `step --into` |
| "what did the model answer" | `tracelight http run.json`, then `context` on that step |
| "what did this program swallow" | `tracelight exceptions run.json` |
| "show me where it is stopped" | `tracelight history --live --pause --out history.json` |

**Async code reads in run order.** A step is a statement in the order it ran, so an `await`
shows the caller's later statements only after the awaited work's own steps. `step --over` on an
`await Promise.all([...])` skips every step of the awaited calls; `walkthrough` names each call
with its `in` and `out`, so read it before stepping through promises.

**Live, a move starts from the window's step, not from where your last command left it.**
`step --live --into` moves from the session's current Time Machine step, and the human moves that
too. The tell is a landing the previous stop's `moves:` line did not offer. Pin the origin when the
sequence matters: `step --live 18 --into` jumps to 18 first. Only `--json` echoes the `from`.

When the evidence is a pause in a running program, get it with [debug.md](debug.md) and put the
pause on the page with `history --live --pause`.

## Build a tour

**Every value comes from the run.** `tracelight tour` picks the candidate stops and their values;
the prose picks among them and says what they mean; `tour --prose` checks every number, name and
quoted string in the prose against the recording before it merges. Your job is the prose.

```sh
tracelight tour run.json --out tour.json          # chapters and candidates; read its text form too
# write tour.prose.json from tour.json, following <skill>/references/tour-prompt.md
tracelight tour run.json --prose tour.prose.json --out tour.merged.json
node <skill>/scripts/render-tour.cjs tour.merged.json tour.html [--title "How rrf ranks"]
```

1. Read `tour.json` (or the text form, `tracelight tour run.json`): the chapters, then the
   candidates with their signals and values. Step or `why` into a candidate when its values
   leave the point unclear.
2. Write `tour.prose.json` by following [tour-prompt.md](tour-prompt.md) as if it were addressed
   to you: the same picks, lengths, number rules and JSON shape. To have a model write it
   instead, send that file's text, a blank line, and the compact `tour.json` as one prompt (for
   example `claude -p --output-format json --tools ""` with the prompt on stdin), and save the
   JSON object it replies with.
3. Run `tour --prose` with the same `--goal` and `--budget` you built the tour with. Exit 0
   prints the accepted stops and any warnings. Exit 2 lists each problem on its own line, naming
   the stop or chapter and the field. Fix every listed line once, by rewording or by dropping
   the claim (a model gets its previous reply and the list, as the prompt's "Retry" section
   says), and run it again. When the second check still fails, tell the user which lines failed.
4. Render. The renderer needs only Node. The page has no scripts and reads at phone width in
   light and dark.

Quote a long value by range (`"quote": {"field": "v2", "from": 706, "to": 770}`): Tracelight cuts
the slice from the recorded value, and the page shows it under the text, marked when the
recording had cut that value. The tour's own values are cut at 300 characters, so take the offsets
from an `evidence` window or from the visible text. When a value the tour needs ends in
`…(+N chars)`, rerun with `--max-value-chars 0`.

The contract (`tour.json`, `tour.prose.json`, the merged tour, every check):
`docs/TOUR.md` in the repository; the flags: [tracelight-cli.md](tracelight-cli.md#tours-of-a-large-run).

## Build a code-history page

Make this page around steps you picked by hand: a `why` chain, the changes of one variable, a
live pause, or three or four checkpoints that answer one question. **Every value comes from the
run.** `tracelight history` generates them from the run and prints, on every checkpoint, the
command that reproduces it. Your job is the prose.

```sh
tracelight history run.json --at 1 --at demo.ts:64 --var contribution --why 117 fusedRanking \
  --out history.json
# write prose.json, keyed by the checkpoint ids it printed, then:
tracelight history run.json <same selectors> --out history.json --prose prose.json
node <skill>/scripts/render-code-history.cjs history.json history.html  # <skill> = the directory SKILL.md is in
```

`--at STEP` or `--at FILE:LINE` is one checkpoint. `--var NAME` is one per recorded change of a
name. `--why STEP NAME` is the provenance chain. `--live --pause` turns the current debug pause into
a checkpoint without moving it; for several pauses, run it at each with `--append` and the same
`--out`, and the same `--session`. Checkpoints appear in the order you wrote the flags.

The prose file fills `heading`, `summary`, `subtitle`, and `title`, `text`, `note` per checkpoint.
It may not set anything the run produced; the command fails if it tries. Render as soon as the last
checkpoint is written. The renderer needs only Node: Handlebars and Shiki (with the JavaScript,
TypeScript and TSX grammars) ship with this skill.

The data contract, the four evidence kinds, how to render and check the page:
[code-history.md](code-history.md).

## Evidence

A reader has to tell what kind of claim each card makes:

- **recorded step**: the program executed this statement and the recording holds its values.
- **live pause**: the program is stopped here now; nothing behind it was recorded, so no chain.
- **static source**: nobody ran this. Source the explanation needs, with no values.
- **gloss**: a sentence a model wrote, from `narrate`. Not an observation.

Repeated inspections at one pause are one pause. A value is shown as of a step; a later value is a
later checkpoint, not a correction. A branch that went both ways says so (`took false x2, true
x1`). Label an inference as one. A source snippet on its own proves nothing ran. If you used
`exec --live`, the page says so.

## What a recording cannot do

- Change the program's state. A saved run is a replay: no breakpoints, no continue, and `eval` only
  reads. Writing a value at a pause is `exec --live`, in [debug.md](debug.md).
- Read values deeper than what was captured. Without `--keep`, a saved run holds the text of the
  logged values. `eval` runs pure calls (`rows.length`, `Math.max(...xs)`, `JSON.stringify(x)`)
  but never a function of the program's own.
- See package code that was not instrumented. Without `--library-code`, `--into` on a call into
  `node_modules` steps over it. Node's built-in modules are never stepped.

## Done

Give the user the page's path and a short conclusion in chat: the finding, what remains uncertain,
and for a paused handoff the file, line, frame and the next manual action. For a tour, also say
how many checks the prose took and any warning `tour --prose` printed. A render that failed is
a blocker to name, not a page to claim exists. Finish clean (SKILL.md) if you used the debugger.
