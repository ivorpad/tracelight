# explain: understand code by watching it run

Someone wants to understand code they did not write: how checkout works, which implementation
answers a call, why a value is what it is, what happens after a request returns. Answer from the
program's own execution, reached through its real entry point or one of its tests, and stop where
the answer is visible. Reading source chooses the stops. The run establishes what happened. Live
exploration needs no recording first, guided teaching is optional, and quizzes or prediction
questions happen only when the learner asks for them. This mode does not replace `ask`, `debug`
or `show`.

The controls live in the surface references: [debug.md](debug.md) and
[live-debugger.md](live-debugger.md) for VS Code, [browser.md](browser.md) for the page,
[scratchpad.md](scratchpad.md) for copied-function experiments and [ask.md](ask.md) for reading a
recording. [learning-patterns.md](learning-patterns.md) works five investigations (actual
implementation, value provenance, decision and state ownership, async handoff, contrast) on a
small service. Use the one the current question needs.
[example-agent-harness.md](example-agent-harness.md) is an optional example for LLM agent
harnesses.

## From a first question to a paused session

Choose live execution or an existing recording from the request. Locate the target with
SKILL.md's discovery order, then read the entry point, its callers and imports and any existing
tests, far enough to know which input reaches the code in question and where the answer becomes
visible. Reading source is preparation. Do not execute the program, read an old recording or
invent step numbers to prepare live exploration. If a session is already paused, plan from its
state instead of restarting it.

Keep a short plan in memory (a plan file only on request): the question and what the learner
already understands, the input and path that expose the answer, and a few stops, each named by the
question it answers and the values to read there. A planned scratchpad experiment names its one
changed input and the external calls that need labelled mocks. Show the plan compactly as proposed
breakpoints, then set them and start paused at the first useful one. The proposal makes the route
visible and is not an approval gate unless the learner asks for one. The stops are destinations
the learner can pick, not chapters to complete. Revise the plan when a branch, an unexpected value
or a new question changes what matters, and finish when the questions have evidence, not when
every line has been visited.

The first reply leads to a usable pause. A broad request ("explain checkout") still gets a concrete
path you choose: a representative input through the real entry, not an architecture summary or
"where would you like to start?". Show the short plan, launch or reuse the session, and check the
actual paused location and visible source before handing back. If setup fails, name the blocker
and the next action instead of claiming readiness. A plan alone is the deliverable only when the
learner asked to stop at a plan.

Use the real entry point or test. `examples/js/checkout` starts from `main.ts --country de`, and
its `checkout.test.ts` is a program too: `tracelight debug checkout.test.ts --at placeOrder` pauses
in `placeOrder` under the test's own cart. An installed library with no runnable caller gets a
small driver in a scratch directory outside the project. Explain the inputs the driver supplies,
and step into the installed library rather than copying it into the driver.

Pick executable stops across the relevant files before running, including imported library code
when it owns the behaviour. Prefer function names where the surface supports them, and read the
current source around a line before using it. The call line exposes a call's inputs. The line
after a transformation exposes its result. A branch that never executes cannot be a reliable
stop. Keep the breakpoints that were there before you, and track the ones you add.

## Starting the session

In VS Code, repeated `--at` sets the stops before launch, and `continue` travels between them:

```sh
cd examples/js/checkout
tracelight debug main.ts --at gatewayFor --at placeOrder --args --country de
tracelight continue --live --session main.ts
tracelight step --live --session main.ts --into
```

On the browser page, use WebMCP when the browser offers it, otherwise `ctl`. Start the bridge with
watching enabled (the default) and without the startup run, open the returned URL, then set
breakpoints and start the debugger:

```sh
CHECKOUT_COUNTRY=de tracelight web main.ts --port 4790 --no-run
tracelight web ctl --port 4790 break 44 on
tracelight web ctl --port 4790 debug start
tracelight web ctl --port 4790 break 46 on --file "$PWD/checkout.ts"
tracelight web ctl --port 4790 debug continue
```

With watching on, a save from VS Code or another agent refreshes the page's source. While the
page's debugger has a run, paused or running, that save executes nothing: the paused program keeps
the code it loaded. Between debug runs a save runs the file under the page's run mode (Automatic
and On Save run it, On Demand does not). `--no-watch` is optional. Pass it when the person wants
saves never to run the file, for example a program whose side effects they do not want repeated.
Run, `debug start` and `debug restart` always execute, and so do edits in the page's own code pane
under Automatic (typing) or On Save (Ctrl/Cmd+S), even while paused.

A browser breakpoint in an imported file needs the page to know that file. Stop first in the entry
file and add the imported stop once the import has loaded (above, `checkout.ts` after the pause at
`main.ts:44`). Do not run to completion to discover it. Library code needs the page's Library code
setting before `debug start`; a setting changed during a debug run applies to the next one. An
older bridge that rejects `--no-run` cannot promise exploration without a startup run: use a
supported build, an existing paused session or VS Code, and do not fall back to automatic execution
silently. The page records the same execution as it pauses, for Code history. That is not a
separate recording beforehand. If the learner forbids all recording, use plain VS Code debugging.

## At a stop: what this location establishes

Check the pause before explaining it: the returned location, stack and locals, and on the page the
confirmed visible position (`position.ready: true`, [browser.md](browser.md#confirm-the-visible-position)).
Then say what this stop establishes about the learner's question, usually in one to three sentences
with the program's own names and values. Not every line, and not the whole frame. Connect the
behaviour to its consequence: who owns this state, what is validated, what decides, what makes the
next turn happen. Paused at `checkout.ts:46` with `total = 153.47`, then inside
`InvoiceGateway.charge` after Step Into, the point is that placing an order never chooses how it
is paid. Whoever built the service did, at `main.ts:35`.

Every claim rests on one kind of evidence, and each kind supports different claims:

| evidence | it shows | it does not show |
|---|---|---|
| source you read | what the code can do, and wiring that a constructor call or registration spells out | that it ran, or with which values |
| a live pause | the values before the highlighted statement, in this run | that statement's result: step, then read it |
| a value after a step | what that statement did this time | what other inputs would do |
| a recorded step | what happened at that step of that recording | the live program now, or another run's step numbers |
| a scratchpad or mocked run | what the copied code computes from those inputs and labelled fixtures | that the application calls it that way, injects those dependencies or uses its result |
| a prediction | what you expect from the source, said as "I expect" | anything, until a run shows it |
| an unavailable or capped value | that the runtime did not capture it (`unavailable`, `…(+N chars)`) | the missing part |
| a branch that did not run | that this run took the other arm | how the other arm behaves |

Say which kind a claim rests on when it matters, and especially when two disagree. One input
observed once is not a guarantee: say "for `--country de`", not "always". To show a mutation, read
its input, execute the statement and compare. A loop needs one representative pass, and another
only when something new happens. Do not claim hit counts or unseen branches from one live pause.

On the page, value overlays follow the learner's request. A request to use them throughout the
exploration covers the relevant stops without asking again. A request for one inspection does not
open cards after every later step, and plain step requests need none. At a call boundary, open
the actual captured arguments together in one call (`tracelight_inspect({names: ["cart"], open: true})`
or `ctl inspect open cart`), show the result after the operation, expand the fields being taught
and leave unrelated metadata collapsed. Never evaluate code to manufacture a missing preview, and
keep unavailable and capped markers. A control reply does not prove the editor rendered the
source, highlight or card, so confirm what is visible before teaching from it.

## Moving: who moves, and what a move costs

The learner may step themselves (F10, F11 in the editor or the page) or ask you to move. Never
advance execution while they are stepping. When they name a destination, go there at once: "jump
to where the receipt is sent" means a breakpoint in `sendReceipt` and Continue, not first finishing
the explanation of tax. Skip stops that no longer answer the question, removing only the ones you
added, and do not insist on earlier concepts before reaching the destination. A named destination
may take several control calls; reach it without narrating routine guards. An explicit "step"
still means one step. Before stepping over a loop or compound guard, check whether that would also
run the call being inspected, since a destination breakpoint is often clearer.

When a guided walkthrough was requested, keep moving along its route with a short explanation at
each relevant transition. "Stop", "wait" or a question about the current state suspends movement.
A named destination redirects the route, and concepts the learner has understood stay settled.
Without a walkthrough, answer at the destination and leave the pause for inspection or a new
direction. Do not continue through the rest of the plan on your own.

The command is `continue`, not `resume`. It runs everything up to the next breakpoint, exception
or exit for real, API calls and writes included, and stops at whatever comes first, so read where
it stopped. Step Into, Over and Out examine one operation. A destination that has already passed is
reachable only in history (a recording, or the page's Code history) or by running again. Say which
one you are showing, and never present a recorded value as the live state. A live session cannot
step backwards, and reviewing history changes the view, not the program.

A restart, `debug restart` or a second `debug start` executes the program again with its side
effects. The checkout appends one line to `$CHECKOUT_OUTBOX` per receipt, so every extra run leaves
another line. Do not restart to repair a stale display. In VS Code, `continue`, `break` and
`restart --live` relaunch a program that has exited, and `--no-start` makes them refuse instead
([live-debugger.md](live-debugger.md)). A timeout is not permission to repeat a control command:
read the state first, since the program may still be running or already paused.

## When the learner steps by hand

Explaining manual steps needs the agent to hear the pauses, and hosts differ in what they can hear.
On the browser page, get a cursor with `tracelight_wait_pause({})` when the page connects, before
`debug start` or handing over the controls. `tracelight_wait_pause({after: cursor, timeoutMs: 25000})`
then returns the next pause with its source and captured values, or `changed: false` after at most
25 seconds. Explain from that reply directly. A wait runs inside your turn and cannot wake an idle
chat.

So when the learner is about to step ("I'll press F10 now"), arm one wait in that turn and explain
the pause it returns. When it times out, or when the learner will step at their own pace, end the
turn and say how it works: the page shows every stop, and you explain the latest pause when they
send any message. Do not chain waits to look attentive, and do not claim to follow steps you cannot
hear. A host subscription that really wakes this chat on a pause can replace that, once you have
checked that it targets this session. In VS Code the CLI has no pause listener; read the new stop
with `tracelight state --live` when the learner says they stepped.

## Edits while a lesson is paused

A save while the program is paused changes the source under the pause, not the running code. The
page shows the new text and blocks the position ("Visible source is stale, edited, unavailable or
differs from the run source"). Say that the pause belongs to the code that was loaded, and do not
explain it from the new lines. Re-read the changed lines and move your breakpoints before the next
run. Running the edit is a deliberate step (`debug restart`, Run, or a save once the debug run has
ended), and it repeats the side effects. In VS Code, a save while the debugger has a run does not
start another run either.

## Contrast: a second real run, then the scratchpad

"What changes for a US customer?" is answered best by the same entry and cart with one changed
condition: `--country us` next to `--country de`, read for the first divergence that matters, not
the input itself ([learning-patterns.md](learning-patterns.md#contrast)). Both sides went through
the real wiring.

The scratchpad answers a narrower question while the live program stays paused: what the copied
function computes from copied inputs and labelled mocks. It repeats no side effects, and it shows
arithmetic, not wiring. A copied `placeOrder` with a mocked gateway does not show that `main.ts`
injects `InvoiceGateway`, that `gatewayFor` picks it, or what the receipt handler does with the
result. Label its results as scratchpad results and name the mocks. Prepare and run it with one
`tracelight_scratchpad({op: "experiment", code, inputs, mocks, mockLabels, autoRun: false})` call
(or `ctl scratchpad experiment --data FILE`), with a baseline first and one change at a time. Check
application error fields as well as runtime errors, then close or restore it and confirm the live
pause did not move. [scratchpad.md](scratchpad.md#prepare-before-teaching) has the preparation and
repair steps, which are yours to do before teaching from it.

## Keep the control loop short

When the learner says continue, step into, restart or show me, perform that operation in the same
turn and explain after its evidence arrives. Acknowledgements, plans and claims that setup is ready
do not satisfy the request, and never imply that an unperformed action happened. A request for a
function's internals means entering it and stopping at the relevant branch, arguments and result,
not stopping at its caller or its return. Name a blocker once and repair it when you can. Check the
runtime and page actually serving the learner, because a build in another worktree does not update
this session.

A move already returns source, stack and locals (on the page with each local's `valueBag`), so
explain from that reply and do not ask for the same state again. Pull the relevant bindings out of
a large reply instead of dumping objects or evaluating one property at a time. Batch independent
reads and set breakpoints before launch, and keep runtime-dependent moves sequential.

Voice and chat drive the same session. "Jump to where the receipt is sent" directs a move, and
"what is this value?" asks about the current pause. A change of input channel does not repeat
setup. "Say it out loud" changes delivery, not the pending task: state the plan briefly and keep
setting up in the same turn. Keep spoken explanations short enough to leave room for the next
question.

## Exploring a recording

Use this route when the learner chose a recording. It is not preparation for live exploration. Map
the exact recording with `story RUN --file FILE`, `graph RUN --no-statements` or `walkthrough RUN
--scope NAME`, then pick the steps that answer the questions. Keep each run's identity and step
numbers together, and never carry step numbers over from another run, even of the same file:
inputs, asynchronous ordering and model replies may differ.

```sh
tracelight story run.json --file main.ts
tracelight step run.json 37 --into
tracelight why run.json 37 total
```

`var RUN NAME` and `values RUN --line F:L` compare loop passes without visiting each one. For an
object mutated in place, a `(same object)` binding is not a snapshot after the mutation: read the
statement's captured reads and a later captured result, and say when that evidence is absent. On
the page, `goto` and recording `step` move only through the selected recording, and `debug
continue` and `debug step` move the live program. History navigation never resumes it. Reading a
recording is covered in [ask.md](ask.md), page commands in [browser.md](browser.md).

## Finish

Briefly connect the observed stops back to the learner's questions and name what is still
unresolved. Before stopping a session, remove only the breakpoints you added. Leave the pause,
page or scratchpad open when the learner wants to keep using it, and say what remains active,
with the port and PID of each process you started. Stop the rest: a bridge or headless browser
left behind keeps serving long after the lesson is over.
Follow SKILL.md's cleanup when the exploration ends, not at every handoff in the conversation.
Keep recordings and copied private data out of commits. When the learner points out a failure of
this workflow and asks for a skill correction, fix the general rule and apply it to the current
exploration without a long maintenance detour.
