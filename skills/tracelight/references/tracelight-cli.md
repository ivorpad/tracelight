# The `tracelight` CLI over a recording

Every verb takes `RUN` (a `run.json`) or `--live` (an open VS Code session with
`tracelight.agentAccess` on). Every verb takes `--json` for the raw shape; the text form is the one
to read. Errors go to stderr as `error: <what>` plus a line saying what to do next, exit 2; with
`--json` the same thing arrives as `{"ok": false, "error", "hint"}` on stdout. The verbs, flags,
text and JSON shapes are the same as the `tracelight` CLI's for Python, so a page or a script built on
one reads the other.

Contents: [Recording a run](#recording-a-run) · [Mapping](#mapping-a-run-you-do-not-know) ·
[Stepping](#stepping) · [Following a value](#following-a-value) ·
[Comparing two runs](#comparing-two-runs-after-an-edit) ·
[Reports](#reports-exceptions-http-coverage-graph) · [Tours](#tours-of-a-large-run) ·
[The page](#the-page) · [Shapes](#the-shapes-worth-knowing) · [Live only](#live-only) ·
[Environment](#environment)

## Recording a run

```
tracelight run FILE [--save RUN.JSON] [--library-code] [--keep] [--no-locals]
                    [--http off|record|replay] [--timeout MS] [--auto-log]
                    [--max-steps N] [--exclude GLOB]... [--only GLOB]... [--max-value-chars N]
                    [-- ARGS]
```

`FILE` is `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`, `.jsx` or `.tsx`. TypeScript runs as it is:
types are stripped, and `enum`, `namespace`, parameter properties and JSX are lowered, so there is
no build step and the line numbers are the source's. A file's module format comes from its
extension, then `package.json`'s `type`, then its syntax, as Node decides it. `--save` is what
writes the recording; without it the command prints the event stream. `-- ARGS` reach the program
as `process.argv.slice(2)`.

- `--library-code` instruments packages in `node_modules` too, never Node's built-in `node:`
  modules. Without it `--into` on a package call steps over it. Ask for it when the question is
  what a package did with an argument; it is slower and the run is bigger.
- `--keep` leaves the runner alive so `eval` and `expand` can reach the finished values.
  `tracelight release run.json` shuts it down.
- `--no-locals` skips recording locals at every step, which is what `var`, `why` and `origin`
  read. Leave it on unless the run is enormous.
- `--http record` writes every HTTP exchange (`fetch`, `node:http`, `undici`) to
  `.tracelight/replay/<hash>.jsonl` next to the file; `--http replay` answers later runs from it, so a
  program that calls an API runs again with no network and no tokens and returns the same values.
- `--timeout MS` stops the program after that long (default 30,000).

```sh
tracelight run demo.ts --save run.json
# demo.ts:79  ======================================================================
# demo.ts:80  RECIPROCAL RANK FUSION
# …
# saved run.json: 266 steps, 1 files, exit 0
```

What the program prints comes first, each line prefixed with the `file:line` that printed it; an
uncaught exception prints as `error: TypeError: … (file:line)`, and the last line is the count.
The program runs under the `node` that runs the CLI (Node 22.15 or newer); run the CLI through
another `node` when the program needs one.

**What the recording leaves out is printed.**

- `--max-steps N` (default 999,999) caps the recorded steps. Every verb over a run past it starts
  with one line, and `--json` gets `recording: {truncated, cap, kept, stepsRun, spentBy, exclude}`:

  ```sh
  tracelight run main.ts --save run.json --max-steps 50
  # saved run.json: 407 steps, 2 files, exit 0
  tracelight walkthrough run.json
  # note: truncated recording: steps 0-49 of 407 kept (step cap 50); most steps in lib/heavy.ts 405 · main.ts 3; rerun with --exclude lib/heavy.ts
  ```

  When a run says truncated, rerun it with the `--exclude` it names before reading it: the steps
  after the cap, often the part you were asked about, are not in the recording.
- `--exclude GLOB` (repeatable) leaves code out: a package name or glob (`lodash` also covers
  `lodash/fp`, `@scope/*`), a path glob relative to the file's directory, where a directory covers
  what is under it (`lib/heavy`, `src/*.ts`), or a bare file or directory name, with or without
  its extension. Excluded
  code runs at full speed and records no steps, values or coverage; calls into it show as calls
  whose body left no steps. `--only GLOB` (repeatable) records just the matching files, packages
  included without `--library-code`; the program file is always recorded and `--exclude` wins over
  `--only`.
- `--max-value-chars N` is how much of one value a recording keeps (default 120 characters for a
  local, 200 for a logged value; `0` keeps the whole value up to a ceiling of 1,000,000
  characters, which bounds what one value costs in memory and in `run.json`). A cut value ends in
  `…(+N chars)`, N being what the full value had beyond the shown text, or `…(cut)` when its length
  is unknown. The verbs' own line cuts add up the same way, and `--json` gives the whole recorded
  text with `truncated: true, length: N`. When a value you need ends in `…(+N chars)`, rerun with
  `--max-value-chars 0` and read it with `--json`:

  ```sh
  tracelight var run.json prompt           # const prompt = 'x'.repeat(10000)
  #   #0 long.ts:1  <module>  prompt = 'xxxxxxxxx...xxxxxxxxx'…(+9,883 chars)
  tracelight run long.ts --save run.json --max-value-chars 0
  tracelight var run.json prompt --json    # changes[0].text is the whole value, 10,002 characters with its quotes
  ```

## Mapping a run you do not know

Read these for yourself. They exist to give you step numbers.

**`walkthrough RUN [--file F | --scope NAME | --from N --to M] [--all]`** is the fastest map:
the module start, every call with its arguments and result, every branch with the arm it took,
loops with their counts, `console.log` output, exceptions with where they were handled, and the
exit. Library calls are merged to one line per call site; `--all` unrolls each. 400 moments at
most.

```sh
tracelight walkthrough run.json
# #42  call to rrf from main
#       in rankings = { BM25: [ 'A', 'C', 'B', 'D' ], Vector: [ 'C', 'E', 'A', 'B' ] }
#       in k = 60
#       out return = { A: 0.032266458495966696, C: 0.03252247488101534, B: 0.031498015…(+48 chars)
# #45  for (const [rankingName, ranking] of Object.entries(rankings)) ran 2 times
# #51  call 1 of 8 to reciprocalRank from rrf
#       in rank = 1
#       in k = 60
#       out return = 0.01639344262295082
# #245  if (!ranking.includes(documentId)) took true
```

JSON: `{count, total, moments: [{kind, step, location, text, values, count?, callee?, entryStep?, endStep?, callerScopeId?, gloss}]}`.
`kind` is `start`, `call`, `tool`, `decision`, `print`, `value`, `error` or `end`. A `tool` is a
function of the program called back by a library (a route handler, an event listener, a
LangChain tool): its `step` is its own entry and `callerScopeId` the function that was running
when it was called, not the statement at the top of the program that started the library. A
call's `entryStep` to `endStep` covers the steps of everything it called, so `return f(x)` ends
after `f` ran. `values` entries have `role` of `in`, `out`, `took` or `value`. A call's `out` is
what the function returned (`return = …`), recorded at every exit: a `return` inside `try`,
`catch` or `finally`, `return await …`, an async function's resolved value. A call that left by
an exception has `out raised = TypeError: …` instead. A function that ran off the end of its body
has no `out`; it returned `undefined`.

**`graph RUN [--all | --expand PKG] [--scope NAME] [--no-statements] [--dot]`** is the shape:
one line per node (module, function, package, decision, statement) with hit counts and what each
produced, then one line per edge (`n4 → n7  ×8  #51 #58 #65 …`, and `⇢` where a value one
function produced went into another). `--dot` gives Graphviz.

```sh
tracelight graph run.json --no-statements
# n4 rrf demo.ts:52  ×1  in rankings = { BM25: [ 'A', 'C', 'B', 'D' ], Vector: [ 'C', 'E', 'A', 'B' ]…
#    n6 for (const [index, documentId] of ranking.entries()) ran 4 times  ×8
# n7 reciprocalRank demo.ts:48  ×16  in rank = 1 · in k = 60 · out 0.01639344262295082
# n4 → n7  ×8  #51 #58 #65 #72 #82 #89 …
```

JSON: `{nodes: [{id, kind, parent, label, file, line, text, hits, firstStep, taken?, notRun?}], edges, moments, scopes}`.

**`story RUN [--file F | --scope NAME | --line F:L] [--limit LINES]`** lists the lines that ran,
in order, one block per scope, with the step each first ran at and `…` where it skipped. Stops
after 150 lines.

**`find RUN TEXT [--limit K]`** searches values, locals, errors, output and source lines by
content. The way to locate something when you do not know where it is.

```sh
tracelight find run.json 0.0325
# 6 hits for '0.0325'
#   #124 demo.ts:106  1. C RRF=0.032522
#   #109 demo.ts:97  scores = { A: 0.032266458495966696, C: 0.03252247488101534, … }
```

**`steps RUN [--from N --count K | --line F:L]`** lists step numbers with `file:line` and
function. `--line` is how you count a loop's hits.

## Stepping

**`context RUN N [--scope]`** or **`context RUN --line F:L`** is everything at one step:

```sh
tracelight context run.json 53
# step 53/266  demo.ts:49  reciprocalRank
# stack: reciprocalRank demo.ts:49 #53 ← rrf demo.ts:60 #51 ← main demo.ts:95 #42 ← <module> demo.ts:144 #3
# block reciprocalRank  demo.ts  steps 52–53  returned 0.01639344262295082
#  48  function reciprocalRank(rank: number, k: number = 60): number {   #52
# >49    return 1 / (k + rank);   #53
# values:
#   #53 demo.ts:49  rank = 1
#   #53 demo.ts:49  k = 60
# moves: into 54 · over 54 · out 54 · back 52 · back-over 52 · back-out 51
```

Blocks are capped at 60 lines and 20 values; `--scope` lifts both once you know you want the
whole function. The `block` line ends with `returned VALUE` (or `raised Type`) when the function
left in that block, and a `calls:` line lists the calls the current statement made with what each
returned (`calls: rrf #43 → { A: 0.0322… }`), so `return f(x)` shows both values without stepping
in.

**`step RUN N --into|--over|--out|--back|--back-over|--back-out|--to M [--scope]`** moves and
prints the new step in the same shape. `--into` from a call line lands in the callee with its
arguments in `values`. `--over` and `--out` follow the call chain, so `--over` on an
`await Promise.all([...])` skips every step of the awaited calls. Live, `step` moves the user's
editor, so use it to go somewhere and the reads to look.

**`values RUN --line F:L`** is every value logged on a line, by hit: the way to see a loop's
passes without stepping each one. A line whose values are only locals has none logged unless the
run had `--auto-log`; `var` reads those.

**`eval RUN EXPR`** reads a name, property, subscript or pure call (`Math`, `JSON`,
non-mutating methods of `String`, `Array`, `Object`, `Map` and `Set`) from the finished state. It
refuses a function of the program's own, because reading must not change anything. Needs `--keep`
or `--live`.

```sh
tracelight run demo.ts --save run.json --keep
tracelight eval run.json "DOCUMENTS['C'].text.toUpperCase()"
# DOCUMENTS['C'].text.toUpperCase() = 'PRIMARY BUTTON USED FOR IMPORTANT ACTIONS'
tracelight eval run.json 'reciprocalRank(1)'
# error: cannot call `reciprocalRank` here: a hover or a watch runs only code without side effects (…)
tracelight release run.json
```

**`expand RUN VALUE_ID [--path SEGMENT ...]`** opens a value node from `eval --json`'s
`valueBag.data.id`.

## Following a value

**`var RUN NAME [--file F] [--scope NAME] [--limit K]`** lists every step where a name changed,
the new value, and after `←` the names the statement read with their values at that moment.
`NAME` can be a property path (`this.balance`, `res.data.items`), and paths under it match too.

```sh
tracelight var run.json contribution
# 16 changes of contribution
#   #51 demo.ts:60  rrf  contribution = 0.01639344262295082   ← reciprocalRank = ?, rank = 1, k = 60
```

`(same object)` after a value means the statement ran and the recorder saw the same object
afterwards. For a number or a string that means it did not change. For an array, an object, a
`Map` or a `Set` it means the object was not replaced, and a write inside it (`scores[id] = …`,
`totals.push(x)`) is not visible to the recorder, so the value shown is the one from before the
statement: read it as "the container is the same one", not as "nothing happened". `assigned here
(value not recorded)` means only the source knows it assigns; turn on locals. `= ?` after a
function's name in `←` is the function itself, which is not recorded as a value.

JSON: `{name, total, truncated, recordedLocals, changes: [{step, file, line, function, name, source, text, reads: [{name, text, step?}]}]}`.

**`why RUN STEP [NAME] [--depth N]`** walks backwards: the statement that made the value, the
names it read with their values (each expanded in turn), the calls it made with their arguments
and results, five levels down. `why RUN STEP` alone explains the statement.

```sh
tracelight why run.json 117 fusedRanking
# fusedRanking = [ [ 'C', 0.03252247488101534 ], [ 'A', 0.032266458495966696 ], …   #109 demo.ts:97 main   const fusedRanking = Object.entries(scores).sort((a, b) => b[1] - a[1]);
#   ← scores = { A: 0.032266458495966696, C: 0.03252247488101534, … }   #42 demo.ts:95 main   const scores = rrf(rankings, 60);
#     ← rankings = { BM25: [ 'A', 'C', 'B', 'D' ], Vector: [ 'C', 'E', 'A', 'B' ] }   #40 demo.ts:88 main
#       ← bm25Ranking = [ 'A', 'C', 'B', 'D' ]   #1 demo.ts:28 <module>
#     ↳ rrf #43–#108 demo.ts:52   in rankings = {…}, k = 60   out { A: 0.032266458495966696, … }
#   · Object.entries(scores).sort((a, b) => b[1] - a[1])   not stepped
```

`= ?` is a name nothing recorded. `· ... not stepped` is a call whose body left no steps (a
built-in, a package without `--library-code`).
JSON: `{name, step, depth, nodes, root: {name, text, step, file, line, function, statement, reads: [...], calls: [{name, entryStep, returnStep, inputs}], opaque}}`, nested.

**`origin RUN STEP [EXPR] [--depth N]`** follows one bad value back to where it was made, across
calls and containers, as one chain. Use it on an exception's step (`exceptions RUN` lists them)
when `why` stops at a parameter. Without `EXPR` it takes the value the exception is about when it
can tell (the `undefined` a `TypeError` read a property of, the odd-typed operand); when it cannot,
it lists the statement's reads and says `give EXPR`. At a step with no exception, give `EXPR` (a
name or a property path of one, `items[0].price`, `order.tier`). `--depth` caps the links
(default 20, at most 60).

```sh
tracelight origin run.json 70 order.tier
# TypeError at #70 invoices.ts:32 invoiceTotal: Cannot read properties of undefined (reading 'rate') (caught)
#   const discount = DISCOUNTS[order.tier].rate;
# the value: order.tier = 'bronze'
# where from, newest first:
#   #70 invoices.ts:32 invoiceTotal   order.tier = 'bronze'   (read: the failing statement reads it)
#   #68 invoices.ts:39 main           order.tier   (argument: order of invoiceTotal)
#   #38 invoices.ts:20 parseOrders    tier   (element, inferred: put under key 'tier' here; …)
# ▶ #37 invoices.ts:19 parseOrders    const [name, tier, sku, qty, price] = cells;   (assigned)   ◀ root
#   #31 invoices.ts:18 parseOrders    const cells = row.match(…).map(…)   → [ 'Cy', 'bronze', 'USB-C', '3', '9.99' ]   (assigned, inferred: …)
#   #0 invoices.ts:4 <module>         Cy,bronze,USB-C,3,9.99`;   (literal, text match: …)
# root: #37 invoices.ts:19 parseOrders: the value is 'bronze' from here to the failure
```

Each link says how it joins the one before: `read`, `argument` (the call site's argument for a
parameter), `return` (the callee's return statement), `assigned`, `element` (the statement that
put the value into a container, or a loop variable) or `literal`. Read the certainty next to it:
no word means `recorded` (the link is structural and the value is in the recording); `inferred`
means it was picked by value among candidates, because the recording keeps a value's text, not
its identity; `text match` means only the text says so. Check an `inferred` link with
`step RUN N --into` before you build a fix on it.

The root (`▶`) is where the value took the form that failed. When the same function or statement
gave a value that fits on its other runs, the reason says so and names the count; otherwise the
root is the earliest link that already carries the failing value. Fix the root, not the line that
threw. `root: not known` means the chain stopped before any statement that made the value (an
array filled in place by `push` is the usual case); `chain ends:` says where and why. A run saved
with `--no-locals` has no chain: save it again without it.

JSON: `{step, file, line, function, statement, error?: {type, message, caught}, value?: {expr, text, type, chosen}, need?, links: [{step, file, fileId, line, function, scopeId, expr, how, certainty, text?, type?, note?, statement?, inputs?, root?}], root: {index, step, reason, evidence: "siblings"|"first"} | null, rootUnknown?, end, truncated, recordedLocals, reads?, hint?}`.
`links` runs newest first; `root.index` points into it.

## Comparing two runs after an edit

**`diff BEFORE.json AFTER.json [--limit K]`** or **`diff BEFORE.json --live`** answers "what did my
edit change": every statement that did something different, with the values it assigned, the arm
a branch took, how often a loop ran, the calls it made with their arguments, what it printed and
what it threw. Record the before, edit, then record the after (or let the open session re-run,
and pass `--live` for it).

```sh
tracelight run shop.ts --save before.json
# edit shop.ts
tracelight run shop.ts --save after.json
tracelight diff before.json after.json
# a  before.json  shop.ts  25 steps  exit 0
# b  after.json  shop.ts  26 steps  exit 1
# statements: 15 same, 1 edited, 0 added, 0 removed (matched by file, function and text)
# exit code 0 → 1
# 9 statements did something different; the first at shop.ts:4 (a#7  b#7)
# shop.ts:4  price  edited
#   - const total = qty * unit;
#   + const total = qty * unit + 50;
#   total = 60 → 110   a#7  b#7
# shop.ts:5  price  if (total > LIMIT) {
#   took false → true   a#8  b#8
# shop.ts:21  <module>  totals.push(price(qty, unit));
#   price(qty=2, unit=30) returned 60 → 99   a#9  b#9
# shop.ts:23  <module>  console.log(totals.reduce((a, b) => a + b, 0));
#   printed 160 → 234   a#16  b#16
# shop.ts:24  <module>  audit(totals);
#   call audit(totals=[ 60, 100 ]) → audit(totals=[ 99, 135 ]) raised Error: audit failed: 2 orders   a#19  b#19
# shop.ts:14  audit  throw new Error(`audit failed: ${over.length} orders`);
#   raised Error: audit failed: 2 orders uncaught   only in b   b#25
```

`a#N` is step N of the first run and `b#N` of the second, so `tracelight step before.json 7
--into` and `tracelight why after.json 7 total` pick up from either side (with `--live`, `b#N` is
a step of the session). Statements print in the order the after run reached them, the first one
being where the runs part.

How statements are matched: each file is parsed, and the two versions are aligned statement by
statement on the enclosing function plus the statement's text with comments and whitespace
removed. A statement that kept its text pairs with itself wherever it moved, and the line shows
as `20→25`. Inside a block that changed, statements pair by position within the same function
(`edited`, with `-` and `+` lines: the lines of the statement that changed, after its first line
as context when the change is further down, and a long line from shortly before its first
differing character); the rest are `added` or `removed in a`. Hits pair the nth against the nth
when both runs ran the statement as often; otherwise they are aligned by value and the extra ones
say `only in a` or `only in b`. Five hits per name per statement, then `… N more`.

Assigned values and call arguments come from recorded locals. A VS Code session records them
only with `tracelight.timeMachine.recordLocals` on (Record Variable Changes in the panel), and
`tracelight run` records them unless `--no-locals`. When one side has none, `diff` compares the
rest, prints calls as `audit(…)`, and says so on a `note:` line; turn locals on and re-run to
compare values too.

A value that differs on every run by nature (a timestamp from `Date.now()`, a random id) shows as
a change; read past it. A container changed in place (`totals.push(x)`) shows on the statement
where the recorder next saw it, as in `var`. A call's return value is compared when the
walkthrough recorded it on both sides. Files in `node_modules` are not compared.

A saved run keeps a redacted copy of the user's files, so the before still has the text that
ran after the file was edited.

JSON: `{a: {run, file, count, exitCode}, b, matching: {same, edited, added, removed}, notes,
firstDifference: {file, lineA, lineB, stepA, stepB}, total, shown, statements: [{file, fileA,
fileB, lineA, lineB, function, textA, textB, sourceA?, sourceB?, status, stepA, stepB, facts: [{kind, name, a: {text,
step} | null, b}]}]}`. `kind` is `value`, `branch`, `loop`, `call`, `return`, `print`, `log`,
`error` or `decision`; a capped group is `{kind, name, more}`. `textA`/`textB` are a statement's
first line (` …` when it goes on); an `edited` one also has `sourceA`/`sourceB`, all its lines.

## Reports: exceptions, HTTP, coverage, graph

**`exceptions RUN`** answers "what did this program swallow": one row per exception type, throw
site and handler, uncaught first. `broad handler` marks a `catch` clause, which in JavaScript
catches every error whatever its type; one that logs nothing and rethrows nothing is the place to
look when a program runs to the end and did nothing. `caught outside stepped code` means Node, a
package or a promise's `.catch()` swallowed it.

```sh
tracelight exceptions run.json
# 1 exception over 71 steps: 0 uncaught, 1 caught, 1 by a broad handler
# #70  caught TypeError: Cannot read properties of undefined (reading 'rate')
#       raised invoices.ts:32 invoiceTotal · caught invoices.ts:40 main broad handler
```

**`http RUN`** is every HTTP request: method, status, the statement that made it, size, time,
and whether it was live, recorded, replayed or a miss. URLs print with query values stripped;
bodies stay in the recording file.

```sh
tracelight http run.json
# 1 request · 41 B · 16 ms · recorded to 4f2e….jsonl (2026-10-10 13:35Z)
# #1  GET  200  rank  fetcher.ts:11  41 B  16 ms  recorded  http://127.0.0.1:36059/rank?k&token
```

**`coverage RUN [--file F]`** is which statements ran: per file the lines that ran, the ones
that never did and the partial ones (a branch arm or a short-circuit that never ran); `--file`
lists one file line by line with its hit counts.

```sh
tracelight coverage run.json --file invoices.ts
# 23 of 23 statement lines ran (100.0%) in 1 project file
# invoices.ts  23 of 23 ran (100.0%)
#
# invoices.ts, line by line (hits; not run, partial and raised marked):
#    11     ×4  function parsePrice(text: string): number {
#    12     ×3    return text.includes(',') ? (text as unknown as number) : Number(text);
```

JSON: `{files: [{file, path, fileId, lines, ran, percent, notRun, notRunSpans, partial, raised, library}], total: {files, lines, ran, percent, libraryFiles}}`.

## Tours of a large run

**`tour RUN [--goal NAME|FILE:LINE] [--budget TOKENS]`** (or `--live`) splits a run into chapters
and lists, per chapter, the steps worth a stop with the signals that proposed each one and the
values the program held there. It is what you pick a tour from: read the chapters, then the
candidates, then step or `why` into the ones that matter. Every value comes from the recording.

```sh
tracelight tour run.json
# tour  demo.ts  266 steps  exit 0  0 HTTP (0 model calls)  33 of 33 candidates, ~4,259 tokens (budget 40,000)
# goal: the program's output at #265: TOTAL : 0.016129
# chapters
#   c3   #40-50   4.1%  rrf  3 candidates
#   c4   #51-108  21.8%  reciprocalRank  3 candidates
#   c5   #109-175  25.2%  main  13 candidates
# candidates (id  #step  file:line  signals  statement  value)
#   s42-110aab  #42  demo.ts:95  narrative:binds,spine:why  const scores = rrf(rankings, 60);  → scores = { A: 0.032266458495966696, C: 0.03252247488101534, B: 0.0314980158730…
#   s245-ba6d95  #245  demo.ts:127  exception:rare-arm  if (!ranking.includes(documentId)) {  → branch = if (!ranking.includes(documentId)) took true
```

- Chapters: the calls the top-level frame makes; inside a call holding over 25% of the run, a
  phase per project function its orchestrator calls (never cut while concurrent tasks run);
  phases under 2% merge unless they make an HTTP call.
- Signals (`group:kind`): `spine` (`why` back from the output, or from `--goal`), `crossing`
  (callbacks a package made into the project, calls into packages), `io` (HTTP requests and
  where their response lands; file writes and child processes from the statement's source),
  `exception` (a throw, or an arm that ran rarely), `narrative` (what an orchestrating function
  keeps; long texts going into a call), `evidence` (values sharing the most words with the
  output), `chapter`.
- A line that runs again is a candidate again only with new call arguments (HTTP always).
- A long value is cut at 300 characters with `evidence` windows (sentences sharing words with
  the goal, with offsets); a repeated value is `sameAs` an earlier value id; a value that grew
  (a message array) shows only the window that differs (`like`, `from`, `to`).
- `--budget` (default 40,000 tokens, at 4 characters a token) drops the lowest scored
  candidates, an equal share per chapter; setup (config objects, validation, option plumbing)
  goes first.
- A run whose walkthrough has under 60 moments is one chapter whose candidates are the
  walkthrough's moments.
- `--goal NAME` explains a variable's last value; `--goal FILE:LINE` a line's last pass.

`id` is `s<step>-<key>`, `key` a hash of file, line and statement text, so it names the same
statement in a re-recorded run. JSON: `docs/TOUR.md` in the repository is the schema
(`{tour, run, goal, small, budget, chapters: [{id, title, opens, kind, steps, share, http, llm,
candidates}], candidates: [{id, key, step, chapter, file, line, function, scopeId, signals:
[{signal, reason}], statement, score, values: [{id, role, name, length, text?, cut?, evidence?,
sameAs?, like?, from?, to?}]}]}`).

**`tour RUN --prose tour.prose.json [--out tour.json]`** checks prose written from the tour
(by a model with [tour-prompt.md](tour-prompt.md), or by you) against the run and merges it.
Give it the same `--goal` and `--budget` as the tour the prose was written from. `--out` writes
the tour as compact JSON, with or without `--prose`.

```sh
tracelight tour run.json --out tour.json                                 # the input for the prose
tracelight tour run.json --prose tour.prose.json --out tour.merged.json  # check and merge
# prose accepted: 8 stops, 4 chapter texts, 1 warning
# warning: c3 holds a picked stop but has no title; the page uses the function that opens it
# c4  #51-108  Scoring each rank
#   3. s51-cd1dc2  #51  demo.ts:60  The top rank is worth 0.01639344262295082
```

A rejection exits 2 and lists every problem, one per line (`--json`: `{ok: false, error, hint,
violations: [...]}`): unknown chapter or stop ids, a picked stop with no text, a quote on a field
the stop lacks or out of range, a number that is not in that stop's recorded values, statement
or quote (`1,024` matches `1024`, `0.50` matches `0.5`), a backticked name that is not in the
tour, a 'single-quoted' string that is not in the stop's values. The merged tour adds `intro`,
`pick`, `prose: {stops, chapters, warnings}`, `chapters[].prose: {title, text}` and, on picked
candidates, `prose: {title, text, order, quote?: {field, name, from, to, text, length,
recordingCut?}}`, where `quote.text` is cut by Tracelight from the recorded value.
`node <skill>/scripts/render-tour.cjs tour.merged.json tour.html` renders it.

## The page

**`history RUN --at STEP|FILE:LINE --var NAME --why STEP NAME [--pause] --out PATH`** writes the
data behind the code-history page. Also `--prose PATH`, `--pad N` (default 2), `--limit K`
(default 20 checkpoints per `--var`), `--lang L` (`en` or `es`: the page's buttons, legend and
chips), `--scope`, and `--append` to add these checkpoints to the page already at `--out` rather
than replacing it, which is how a page follows a live program through more than one pause. A
value on a card is as long as the run kept it (its `--max-value-chars`; 200 characters when the
run does not say, which a live session does not); `--value-chars N` cuts shorter, `0` shows every
value whole.

```sh
tracelight history run.json --at 1 --at demo.ts:64 --var contribution --why 117 fusedRanking --out history.json
# wrote history.json: 19 checkpoints over demo.ts
```

Selectors appear on the page in the order you wrote them. See
[code-history.md](code-history.md) for the contract and the renderer.

## The shapes worth knowing

**The context slice**, which `context`, `step` and every debug stop share:

```
{step, count, location: {file, line, col, function, fileId}, stale, staleFiles,
 stack: [{file, line, function, step}],
 block: {file, function, scopeId, firstStep, lastStep, lines: [{line, text, step, current?}], totalLines, capped, returned?, raised?},
 calls: [{function, scopeId, step, returned?, raised?}],
 values: [{line, file, context, text, step, hit, kind, runtimeKey}],
 coverage: {notRun}, moves: {into, over, out, back, backOver, backOut}, errors, flags}
```

`block.lines` holds only the lines that ran, so a gap between line numbers is a gap in coverage.
`values[].context` is the name; a value with no `context` is a logged expression.

**`state`**: `{runId, running, finished, stale, staleFiles, nav: {active, step, count}, file, displayName, exitCode, keep}`,
plus `debug: {active, paused, frontier}` and `others` on a live session.

**The saved run**: `{meta, events}`. `meta` has `runtimeVersion`, `language` (`javascript`),
`node`, `executable`, `file`, `workspaceRoot`, `argv`, `config`, `started`, `durationMs`,
`exitCode`, `stepCount` (the statements the program ran, recorded or not), `recording` when the
step cap cut it, and `files: [{fileId, path, sha256}]`. Read `events` through the verbs, which is
what they are for.

## Live only

**`state --live`** is how you find out what exists. It never moves anything.

**`watch --live`** prints one line per stop while the user steps in VS Code, until Ctrl-C:
`paused at file:line (reason)`, `resumed`, `output`, `finished: exit N`. Also `stopped` (the
user closed the Time Machine) and `rerun` (the file was saved and ran again, so earlier step
numbers are void; re-read `state` and re-map).

**`shell --live`** reads one command per stdin line, the same words without `--live`, over one
connection: a fraction of a millisecond a command instead of the time a new Node process spends
starting. Every live command works there except `watch`. `exit` or end of input closes it.

**`record --live`** at a pause of a `tracelight debug FILE --record-from NAME` run that has not
reached NAME yet records from that pause on and prints it again as step 0. On a run that records
already it says `already recording` and prints the current stop.

Live has no `story`, `find` or `steps --line`: those need the whole trace and the bridge serves
one step at a time. The error names the saved-run command instead. `diff BEFORE.json --live`
works, with the session as the after; in `shell --live` it is `diff BEFORE.json`.

**`narrate RUN [--command CMD] [--dry-run]`** asks a model for one sentence per walkthrough moment
and stores it in the saved run (default command `claude -p`, else `codex exec`; `--dry-run` prints
the prompt). Never automatic, and the result is a gloss, not an observation.

**`cache [--clear]`** is the instrumented-package cache (`~/.tracelight/cache`).

**`mcp`** serves these commands as MCP tools on stdin/stdout: [mcp.md](mcp.md).

## Environment

- `TRACELIGHT_HOME` is the extension's per-user directory, `~/.tracelight` when unset or empty (a leading
  `~` is expanded). It holds `sessions/` (one descriptor and socket per live window session) and
  `last-debug.json` (the launch `break`, `continue` and `restart` start again). The CLI finds a
  window's sessions when both see the same value, so set it in the shell the same way it is set
  for VS Code. `TRACELIGHT_SESSIONS_DIR` (or the extension's `TRACELIGHT_SESSIONS_DIR`) moves only
  `sessions/` (`last-debug.json` then sits beside it).
- `TRACELIGHT_HOME` is Tracelight's own directory, `~/.tracelight` when unset or empty. It holds
  the library cache (`cache/`; `TRACELIGHT_CACHE_DIR` moves it, an empty value turns it off). The
  sessions stay under `TRACELIGHT_HOME` because the VS Code extension writes them there.
- `TRACELIGHT_CODE` is the `code` binary `tracelight debug` opens the window with, and
  `TRACELIGHT_NO_FOCUS=1` leaves window focus alone.
- `TRACELIGHT_NODE` is the `node` a debug launch runs the program with (`--node` wins; the
  window's `tracelight.nodePath` is the default).
- `TRACELIGHT_CACHE_DIR` moves the package cache (empty turns it off), and `TRACELIGHT_KEEP_DIR`
  is where a `--keep` runner puts its socket (the temp directory by default).
