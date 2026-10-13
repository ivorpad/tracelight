# explain: walk a person through a run in their editor or the browser page

A model can explain source without any tool. What this mode adds is the real run in front
of the user: the `tracelight` CLI puts the VS Code editor (or the browser page) on a line, the
line shows the values it had at that step, and you explain meaningful changes while moving
through the user's question. Understanding is built in small observed transitions, with room
for the user to interrupt or steer.

Pick the surface by where the person is looking. At their VS Code window, drive its Time Machine
with `--live` (below). In a browser tab, or next to VS Code in its Simple Browser, drive the page
with WebMCP or `tracelight web ctl`. Explain in conversation; add a bubble only when the user asks for on-page notes
([On the browser page](#on-the-browser-page)). The method is the same on both.

Reuse this skill and reference guidance already loaded in context. Do not reread it at every
debugger move; reread only when it changed or missing context requires it.

If the user wants to operate the debugger while you explain automatically, use active manual-step
teaching. Get a cursor with `tracelight_wait_pause({})`, then wait with
`tracelight_wait_pause({after: cursor, timeoutMs: 25000})`. A changed result supplies the newer
pause, matching captured locals, and ready presentation. Its debug summary includes run, step,
frame, nearby source, and each local's captured `valueBag`. Verify the visible source and explain
directly from those returned structured values, then re-arm with the cursor. Do not make extra
inspect, peek, or evaluate calls unless missing detail matters or the user requests a visible
inspector. Preserve capped and unavailable markers in the explanation. A timeout is not a new step; re-arm
without repeated checking announcements while this teaching mode remains active. Do not control
the program or open overlays on the user's behalf. This active wait does not wake an idle or
ended chat; do not promise automatic explanation after the chat stops listening.

Three rules:

- The question chooses the stops. A stop is a relevant line with observed values on screen, not every statement in the program.
- The run is the evidence. Say what the recording shows: `values:`, `in`/`out`, hit counts,
  the arm a branch took.
- Match their pace. In a guided walkthrough, lead through meaningful stops without requiring “next” at each one; honor explicit single-step and stop requests.

## Choose stops from the user's intent

Identify what the user wants to understand and the installed version or checkout they mean.
For “how does this agent harness work?”, follow one concrete request through prompt intake,
context preparation, model response, tool dispatch, tool result, and the next turn or exit.
For a recording, map those boundaries from that run. For live debugging, inspect the current
pause and available executable locations; do not run the program to completion to make a map.
Place a small set of breakpoints on the
actual executable statements that reveal those transitions, including imported modules.
Track which breakpoints you add. Preserve pre-existing breakpoints.

Use the existing entry point or test. When an installed library needs a caller, put a small
SDK driver in a scratch directory and say which inputs and tools it supplies. Keep the real
library unchanged. A simulated provider is not evidence about the real model request; use the
user's configured provider and exact requested model when they ask for a live model run.

In a live walkthrough, “continue” or “next stage” resumes to the next selected breakpoint.
“Step”, “step into”, “step over”, and “step out” perform that specific move. Do not run the
whole program because the user said “continue”. Verify the returned location and pause reason
before explaining. If it exits or stops elsewhere, report that rather than claiming the intended
breakpoint was hit. Start with one meaningful stop and explain it. In a guided walkthrough,
continue to the next relevant transition after showing its evidence; do not require another
instruction for every routine move.

At each pause distinguish what has happened from what will run next. The yellow line has not
executed yet. To demonstrate a mutation, execute that statement and compare the captured values
before and after. Avoid predicting a landing point in a note attached to a step command.
When the user requests a peek, use `ctl peek NAME` or WebMCP `tracelight_peek` to show the
relevant captured binding or property. Do not open a hover automatically at every step.
Keep arrays and objects indented in the hover. Do not evaluate expressions to
manufacture a preview. Explain directly; do not turn every stop into a quiz or add unsolicited
notes. Use CLI or WebMCP controls, with UI buttons only when the command surface cannot perform
the action, and report that limitation.

## Pace with the learner

Treat what the user has understood as settled. When they identify the input shape or explain a
mutation correctly, acknowledge it briefly and move on; do not teach that concept again.
Keep track of the current question, concepts already understood, and the next requested stop.

Skip routine checks, including input-shape guards, unless the user asks about them or an observed
branch, error, or state makes them relevant to the question. Choose the next meaningful operation
instead of stopping to explain each check.

Check debugger semantics before skipping a compound statement: step-over on a guard or loop
may execute its entire body, including a meaningful call. Use a destination breakpoint or a
step that preserves that call when its execution is the lesson. Do not batch unfamiliar control
flow. Verify the actual landing point; if the move went farther than intended, say so, inspect
the result, and never imply the execution was undone.

“Step into” followed by a function name names a destination. Reach it with the live debugger,
using a breakpoint and resume or the necessary steps, rather than yielding at every intervening
guard. A named line works the same way. Several control calls may be needed for one requested
destination; inspect their replies without narrating every intermediate stop. Do not change a
request for a single step into a run to a later stage. If the target cannot be reached safely,
report the actual pause and the limitation.

Execute the requested move before explaining it. Verify the resulting pause and captured values,
verify the visible editor has caught up, and say what changed in one or two sentences. A card
or hover is not required for every move. Add more only for a new concept or a question.
A hover must actually be opened before claiming it is visible. Avoid repeated setup explanations,
progress filler, unsolicited
notes, and quizzes. Distinguish the
statement that just ran from the highlighted statement that will run next.

The command response can arrive before the editor renders. For both live pauses and recorded
history, confirm the correct source and highlighted statement are visibly rendered using a
screenshot or reliable UI evidence. If displaying a requested value, also verify that display.
Runtime state alone is not evidence that the editor or requested overlay rendered.
If the display lags or shows another file, wait for rendering or reveal the intended source and
verify it before teaching. Do not say the learner is already at a destination during that lag,
or repeat empty checking announcements. If the visible state cannot be verified, report that
specific display limitation instead of explaining an unseen change.

Focused overlays are on demand. Requests to inspect, show values, or display a card authorize
one; ordinary step requests do not. Do not automatically open or reopen a card after stepping.
When value inspection is requested, anticipate the value of interest at the conceptual boundary.
Show inputs before the operation and its complete structured result immediately afterward,
beside the executed statement and
before explaining or moving again. Prefer a supported full-value inspection with an anchored,
expandable view in the code context. A floating truncated preview or a delayed card in chat does
not satisfy a request to inspect the full result at that line. Avoid long serial evaluation or
manual extraction during teaching. If the interface cannot show the requested complete value
in place, identify that UI gap explicitly rather than claiming it was shown.

When displaying a focused value card, choose its bindings from the actual paused statement and
the learning question. At a call boundary include the available captured arguments, along with
derived inputs needed for the explanation; do not substitute one convenient derived array for
the call's real arguments. Choose the complete relevant selection before calling the tool, then
open it in one call: `tracelight_inspect({names: [...], open: true})` or
`tracelight web ctl inspect open NAME...`. This replaces the card selection atomically; do not
make a separate call per binding. Use `inspect close NAME...` to remove bindings when needed.
Expand the fields being taught and leave unrelated metadata collapsed. Verify the card is
visible before explaining it, label unavailable or capped values accurately, and never execute
code to populate the card. Displaying a card is inspection, not permission to advance execution.
For function values, use the captured runtime `functionSource` and `functionLocation` when
available, including the source link. An LSP signature or declaration can add static context,
but a parameter declaration does not identify the runtime callback. Say when runtime source
or location is unavailable rather than infer its identity from a type.

When asked to teach or walk through, alternate actual movement and explanation: move to one
meaningful conceptual transition, verify the live pause and visible editor, explain its observed
change, then make the next move and explain that result. The user should not need to request
each move. Routine guards may be skipped within one move, but never cross several meaningful transitions and
explain them together afterward. Keep the debugger paused, the source and any requested values visible during each
explanation so the user can interrupt. Do not substitute promised movement for a control call,
turn this into a full program run, or advance past an unexplained transition.
Continue this guided cadence until the user interjects, asks to stop, the requested learning path
is complete, or a real blocker requires their input. Do not end after a small chunk, ask “next?”,
or wait for permission merely because another meaningful stop was explained.
An explicit one-step or stop-at-destination request ends with the debugger paused there. During
an ongoing guided walkthrough, a named destination redirects the route rather than ending it.
“Stop”, “wait”, and questions about the current state suspend automatic movement.

When the learner flags a teaching failure, identify its actual cause and update the applicable
general guidance or worked example in this skill. Verify the edit and apply the correction to
the current lesson immediately. Preserve that lesson for the next walkthrough; do not encode
a workaround tied to one codebase or interrupt teaching with extensive maintenance narration.

### Example: learning a harness from the first prompt

The learner asks to understand a harness from submitting a prompt. Choose executable breakpoints
at input conversion, context preparation, the model request, tool dispatch, and the next turn.
Use the current live session; do not complete a separate run to prepare the lesson.

Move into prompt handling with the debugger and verify the source and highlight are visible.
If the learner requests the input, open its inspection and verify it is visible. Explain that
the input has arrived but the highlighted conversion has not executed. Skip routine guards
whose outcomes add nothing to the learner's question. Execute the conversion, inspect the new
message, verify the editor has caught up, and explain the transformation: plain input now has
the structure the harness uses for its conversation. This explanation follows the actual effect,
not a prediction of it.

Without asking for “next”, move to context preparation, inspect the captured conversation, and
explain what was added and why it matters for the model request. Then move to the request
boundary and explain that stop before advancing again. Each meaningful transformation gets
its own live pause and explanation; do not jump over several transformations and summarize
them afterward.

If the learner names a function, redirect the next move into it and explain the resulting
evidence. Keep going with move, show, explain until they interject, the learning path finishes,
or a blocker needs input. Do not fill the gaps with repeated acknowledgements, announced
stepping without a control call, notes, or quizzes. An explicit single-step or stop request
still leaves the debugger paused as requested.

## Running the CLI

Find `tracelight` as SKILL.md says. `--live` addresses the open VS Code session
(`tracelight.agentAccess` on, and the file has run); `tracelight state --live` prints the file, the
step count and where the Time Machine is.

For a recording walkthrough with no session: `tracelight run FILE --save run.json`, then `run.json` replaces `--live` in every
command. The user follows your `file:line` and `#step` instead of the cursor; `Shift+F5`
on a line puts their Time Machine there.
For live debugging, use the debug workflow instead. Do not substitute a full recording run for
the live pause the user wants to inspect.

Reads never move the editor: `state`, `walkthrough`, `graph`, `context N`, `values`,
`var`, `why`. Only `step` moves it, so `state --live` is how you check that a session exists.

In Claude Code, show the band before the first stop (`{"action": "show"}`) and hide it when the
walk ends; it draws each stop's line, values and stack above the person's prompt, and they can move
on their own with its `/tl` keys ([band.md](band.md)). Pass `--session NAME` on every command, and
read where they went with `context --live` when they moved on their own.

## 1. Map, for yourself

You need step numbers to know where the values worth understanding are.

```
tracelight walkthrough --live                every moment in order with its step: calls with in/out, loops with counts, branches with the arm taken, prints, the exit
tracelight graph --live --no-statements      who called whom, how often, at which steps; ⇢ edges are values that flowed between functions
tracelight walkthrough --live --scope NAME   one function only
```

Read these for yourself; the user sees lines, not maps. Note the handful of things the program
does and the step where each starts. That list keeps your sentences at the right height (a loop
that ran eight times is one thing, a `console.log` is nothing) and tells you where to go. The RRF
demo (`examples/js/rrf/demo.ts`):

```text
#1    the input: two orderings of document ids, from BM25 and from vector search
#42   rrf receives both arrays and k = 60; #53 the first contribution, A at rank 1 = 1/61
#86   C is the first document counted twice: BM25 rank 2, then Vector rank 1
#109  sort by the sums: C, A, B, E, D
#168  the "why" section does every sum again; "not retrieved -> +0" twice, D and E
```

## 2. The loop

Start at a line, not with an overview. The first message goes to the line whose values
answer what they asked: "how does main get its input" is #1 and #2 with `why`; "explain
rrf" is #53, the first contribution. Go straight to that line. If they ask what the whole
thing does, the call tree from `graph`, six lines, and back to a line.

Every message has the same three parts:

1. **Move.** `tracelight step --live --to N`; `--into` when the values are inside the call (the
   callee's `in` values appear), `--over` past a call that is not the point, `--out` back
   to the caller with the result. The reply prints the location, the stack, the block with
   `#steps`, `values:` and `moves:`. Translate it into a few sentences of your own. The user sees
   the same values inline in the editor, so name them: you are both looking at the same number.
2. **Say**, usually in one or two sentences: the newly observed values and what changed for
   the thing being understood. Skip concepts the user already understood.
3. **Choose the next move.** In a guided walkthrough, continue to the next meaningful transition
   after explaining this one. Leave room for their reply to redirect it:
   - a question: answer it at this line, without moving. `why --live STEP NAME` for where
     a value came from, `var --live NAME` for every change of a name, `values --live
     --line F:L` for every hit of one line. If they moved themselves with F10, F11 or the
     timeline, `context --live` with no step is where they are; `why --live` with no step
     is that step.
   - "next": the next line with values worth understanding, not the next step.
   - "into", "back", "out": that move.
   - "skip to the sort", "show me the result": `--to` there.

For an explicit single-step request, perform that one step and remain paused. For a named
destination, reach it without explanations between intermediate control calls; stop there if
asked, otherwise continue the existing guided cadence after explaining that result. For an
ongoing guided walkthrough, alternate move, inspect, explain; move, inspect, explain without
waiting for permission at every stop. Finish explaining one meaningful transition while paused
before executing the next move. Only routine statements within a move may be batched.

A stretch of the RRF demo, as it should read:

```text
you    step --live --to 53       line 49 in reciprocalRank: 1 / (k + rank) with rank = 1, k = 60, returned 0.01639344262295082
       That is A, first in the BM25 array. Rank 1 in one list is worth 1/61, this 0.016393.
       Every score in this file is a sum of numbers like this one.
user   why 60?
you    (no move)  k flattens the curve. Rank 1 is 1/61, rank 4 is 1/64, 0.015625: nearly
       the same. With k = 0 rank 1 would be 1 and rank 4 would be 0.25. So appearing in both
       lists counts for more than being first in one.
user   next
you    step --live --to 86       line 64: scores[documentId] = (scores[documentId] ?? 0) + contribution, documentId = 'C'
       C already had 0.016129 from BM25 rank 2. Vector rank 1 adds 0.016393. C is the first
       document counted twice; that sum, 0.03252247488101534, is why it finishes first.
```

**Loops.** Land on the header or on the one line that changes, once. Say how many times
it ran and what changed across passes; a table beats stepping every pass:

```
tracelight var --live contribution             every step where contribution changed, and what the statement read
tracelight steps run.json --line demo.ts:64    the eight hits of one line, one per (list, document)
```

| step | pass | contribution |
|---|---|---|
| #51 | BM25, A rank 1 | 0.01639344262295082 |
| #58 | BM25, C rank 2 | 0.016129032258064516 |
| #82 | Vector, C rank 1 | 0.01639344262295082, C's second |

Step into a loop body for one pass only, the pass where something new happens.

**Objects changed in place.** `scores[documentId] = …` writes into an object that already
exists, so `var scores` shows `(same object)` on those lines and the value from before the
statement. Read what went in from the statement's reads (`documentId`, `contribution`), and the
finished object where it is next bound (`const scores = rrf(...)` at #42).

**Branches.** `walkthrough` shows the arm each hit took (`if (!ranking.includes(documentId))
took true`). Stand on the header, name the arm and the value that chose it. An arm that ran
rarely or never is one sentence ("`!ranking.includes(documentId)` was true twice: D is missing
from Vector, E from BM25").

**Where a value came from.** `tracelight why --live 117 fusedRanking` walks back through
`scores` to `rankings` to the two module arrays at #1 and #2, five levels, one command.
`= ?` means nothing recorded that value (a function, like `rrf = ?`); say exactly that.

## On the browser page

Start the page on the file and give the person the URL, then walk the same loop with the page's
commands ([browser.md](browser.md) has every one and its reply):

```sh
tracelight web demo.ts --port 4790 --open           # in the background; Ctrl+C or kill to stop
tracelight web ctl --port 4790 state                # "pages": 1 once the person has it open
tracelight web ctl --port 4790 goto 53              # move; read the reply's location, code and locals
tracelight web ctl --port 4790 say "That is A, first in the BM25 array: 1/61, 0.016393." --line 49
tracelight web ctl --port 4790 step into            # the next move clears the last bubble
tracelight web ctl --port 4790 line 64 --say "C already had 0.016129 from BM25 rank 2."
```

- **Move, read, then say.** The reply to a move is where the page is now (`location`, `code`,
  `locals`, `stack`). Write the bubble from those values. `--say` on the move is fine once you know
  where it lands, as with `line` or `goto` to a step you mapped.
- **If requested, the bubble is short**: one or two sentences, the numbers on that line. The longer explanation
  goes in chat, the same three parts as always.
- **The person can move too**: they click the timeline, step with the toolbar, or open views. Read
  `ctl state` before your next move when they may have.
- `ctl var NAME` and `ctl why NAME --step N` also open the Variable History and the why tree on the
  page, so the person sees the table you are reading from.
- For a recording walkthrough, map with the CLI over a saved run of the same file (`tracelight run demo.ts --save run.json`,
  then `walkthrough`, `graph`): both number the same program's steps the same way, so a step you
  mapped is the page's step (check one: `ctl goto N` and `context run.json N` name the same line).
  A save re-runs the page and the steps may move; re-map after it.
- For a live walkthrough, use its current pause and debugger breakpoints. Do not start a full
  recording run or move a separate recording to stand in for the live execution.
- When the walk ends, `ctl clear`, and stop the page unless the person keeps using it.

## Visuals

The values on the line are the visual. Add one only when it shows what the editor cannot,
and most stops need none:

- a table of passes, from `var` or `values --line`;
- the call tree with counts, from `graph`, when they ask for the shape of the program;
- pseudocode of the idea, six lines at most, when the code is longer than the idea;
- a Mermaid `flowchart` for values flowing between functions (the ⇢ edges of `graph`);
- `tracelight graph --live --dot | dot -Tsvg > shape.svg`, opened for them, when they ask for
  a picture.

Not here: component trees, file trees, diffs, HTML decks. One file, nothing changing.

## Words

- Short. They are reading the editor, not you.
- Behaviour before the term: "adds 1/(60+rank) for each list the document appears in",
  then "that is reciprocal rank fusion".
- Values over adjectives: `0.03252247488101534` for C, not "a high score". Round to what
  makes the point; the editor has the full number.
- Their names, as written: `rrf`, `scores`, `fusedRanking`.
- Active voice, present tense: "rrf adds", not "the contribution is added".
- Saved run: quote `demo.ts:64 #86` so they can `Shift+F5` there. Live: name the
  function; the cursor is already on the line.
- Start with what this line shows. The user has the previous stop and the tool call in front of
  them.

## Keep it to the line

Answer the question they asked, at the line they are on. One idea per message. Talk about what
the values mean, in your words. Stop where something changes, once per loop. Stay put while you
answer a question about where they are. Say `= ?` when the run did not record a value.

## Staleness and secrets

`stale: demo.ts changed since the run` at the top of a reply: the user edited the file. A
save re-runs and the step numbers change; `state --live` says when the new run is in.
Re-map before the next stop. Values are redacted (`sk-…`, tokens, keys named like
`apiKey`); a run still holds the program's data, so `run.json` stays out of chat, commits
and issues.

Every other command and the output shapes: [tracelight-cli.md](tracelight-cli.md). When the user
wants something to read, keep or send on rather than a walk through their editor, that is `show`
([show.md](show.md)); when they want the program paused and stepped live, `debug`
([debug.md](debug.md)). This mode is for explaining together, one idea per stop.
