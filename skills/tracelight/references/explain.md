# explain: walk a person through a run in their editor or the browser page

A model can explain source without any tool. What this mode adds is the real run in front
of the user: the `tracelight` CLI puts the VS Code editor (or the browser page) on a line, the
line shows the values it had at that step, you say what those values mean, the user asks or says
next, and you move again. Understanding is built in many small passes, together, never delivered
in one.

Pick the surface by where the person is looking. At their VS Code window, drive its Time Machine
with `--live` (below). In a browser tab, or next to VS Code in its Simple Browser, drive the page
with `tracelight web ctl` and put each explanation in a bubble under the line
([On the browser page](#on-the-browser-page)). The method is the same on both.

Three rules:

- The line is the unit. A stop is one line with its values on screen. You talk about those
  values, not about the file.
- The run is the evidence. Say what the recording shows: `values:`, `in`/`out`, hit counts,
  the arm a branch took.
- Their turn after every stop. One move per message, then stop and let them steer.

## Running the CLI

Find `tracelight` as SKILL.md says. `--live` addresses the open VS Code session
(`tracelight.agentAccess` on, and the file has run); `tracelight state --live` prints the file, the
step count and where the Time Machine is.

No session: `tracelight run FILE --save run.json`, then `run.json` replaces `--live` in every
command. The user follows your `file:line` and `#step` instead of the cursor; `Shift+F5`
on a line puts their Time Machine there.

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
2. **Say**, in two to five sentences: what the values on this line are; what they mean for
   the thing being understood; what this line hands to the next one.
3. **Stop.** Their reply decides the move:
   - a question: answer it at this line, without moving. `why --live STEP NAME` for where
     a value came from, `var --live NAME` for every change of a name, `values --live
     --line F:L` for every hit of one line. If they moved themselves with F10, F11 or the
     timeline, `context --live` with no step is where they are; `why --live` with no step
     is that step.
   - "next": the next line with values worth understanding, not the next step.
   - "into", "back", "out": that move.
   - "skip to the sort", "show me the result": `--to` there.

One move per message. Two `step`s in one message flash past, and text between tool calls
may go unread.

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
- **The bubble is short**: one or two sentences, the numbers on that line. The longer explanation
  goes in chat, the same three parts as always.
- **The person can move too**: they click the timeline, step with the toolbar, or open views. Read
  `ctl state` before your next move when they may have.
- `ctl var NAME` and `ctl why NAME --step N` also open the Variable History and the why tree on the
  page, so the person sees the table you are reading from.
- Map with the CLI over a saved run of the same file (`tracelight run demo.ts --save run.json`,
  then `walkthrough`, `graph`): both number the same program's steps the same way, so a step you
  mapped is the page's step (check one: `ctl goto N` and `context run.json N` name the same line).
  A save re-runs the page and the steps may move; re-map after it.
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
