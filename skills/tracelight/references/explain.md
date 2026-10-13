# explain: understand code through exploration

“Understand how the Pi harness works” means inspect the code, make a plan in memory, propose
useful breakpoints, and start a session paused at the first useful stop. From there the user
can direct jumps by voice or chat, step manually with explanations from pause events, or ask
for a guided walkthrough. Teaching is optional; learning does not require a lecture or a tour
of every line. This mode does not replace `ask`, `debug`, or `show`.

Choose live execution or an existing recording from the user's request. For unfamiliar code,
prepare from source before running. Live exploration needs no preliminary recording. Use the
debugger controls from [debug.md](debug.md) with the learning workflow here.

## Inspect, plan, choose stops, then run

Locate the target using SKILL.md's discovery order: conversation and existing session, exact
file or caller imports, then installed executable/package. Do not search the Tracelight
checkout repeatedly for a target that lives in an installed library or scratch directory.

Inspect the relevant source, entry point, callers, imports and existing tests. Follow just
enough of the path to understand its responsibilities and how to reach them. Reading source
is allowed for this preparation. It tells you where to look; observed execution establishes
what happened. Do not execute the program, consume an old recording, or fabricate step numbers
to prepare live exploration. If a session is already paused, read its current state and plan from
there instead of restarting without a reason.

Make a short exploration plan in memory before launching or advancing. Do not save a plan file
unless requested. Keep track of:

- The question the learner wants to answer, and what they already understand.
- The concrete input and path through the program that will expose the answer.
- The useful boundaries, each named by the question it answers, the executable stop that
  reveals it, and the arguments or results to inspect there.
- Any useful scratchpad experiment: one changed input or rule, its expected distinction,
  and the external calls that require labelled mocks.

Show a compact plan and proposed breakpoints: function or file:line, the question each stop
answers, and the values to inspect. Then set them and start paused at the first useful stop.
The proposal makes the route visible; it is not an approval gate unless the user requests one.
Treat the stops as destinations the user can choose, not chapters they must complete.
Revise the plan when a branch, an unexpected value or the user's question changes what matters.
Finish when the learning questions have evidence, not when every source line has been visited.

The initial response must lead to a usable session. Do not end with “I'll make a plan”, a
generic architecture summary, or “where would you like to zoom in?” before doing the setup.
When the request is broad, choose a representative path and first stop yourself. Show the
short plan and proposed stops, launch or reuse the session, and verify its actual paused
location and visible source before handing back. If setup fails, report the specific blocker
and next action instead of claiming readiness. Planning alone is the deliverable only when
the user explicitly asks to stop at a plan.

Choose a small set of executable breakpoints across the relevant files before running.
Include imported library code when it owns the behavior. Prefer function names where supported;
otherwise inspect the current source around each line. A statement after a transformation
exposes its result, while the call boundary exposes its inputs. A branch that never executes
cannot be a reliable stop. Preserve existing breakpoints and track those you add.

Use the real entry point or test. If an installed library needs a caller, use a small SDK
driver outside the project and explain its supplied inputs and tools. Step into the installed
library rather than copying its implementation into that driver. For a requested model run,
use the configured provider and exact requested model. A mocked provider cannot demonstrate
what that real model did.

## Jump to the question, step within an operation

Translate questions into destinations: “what reaches the model?” means the provider boundary;
“who runs the tool?” means dispatch and execution; “why another turn?” means result insertion
and the loop condition. Set breakpoints across caller and library files. Skip intermediate
stops that no longer answer the question, removing only breakpoints you added. Do not insist
on explaining earlier concepts before reaching the requested destination.

Distinguish opening source, resuming live execution and reviewing history. Resume executes all
intervening code, including real API calls; it does not skip those effects. If the destination
has already passed, inspect available history or source and say which it is. Do not silently
restart or present a historical value as the current live state.

Set destination breakpoints, then use Continue / Resume to travel between stages. The command
is `continue`, not `resume`. Resume runs real code until a breakpoint, exception or exit; it
does not promise to reach the next item in the plan. Check its actual result. Use Step Into,
Over or Out locally when an operation itself needs examination.

In VS Code, repeated `--at` sets the stops before launch:

```sh
tracelight debug app.ts --at acceptInput --at prepareContext --at dispatchTool --library-code
tracelight continue --live --session app.ts
tracelight step --live --session app.ts --into
```

In the browser, use WebMCP when available, otherwise `ctl`. A new page for live exploration opens
without executing the program:

```sh
tracelight web app.ts --port 4790 --no-run --no-watch
tracelight web ctl --port 4790 state
tracelight web ctl --port 4790 break 22 on
tracelight web ctl --port 4790 break 140 on --file /absolute/path/to/known/library.js
tracelight web ctl --port 4790 debug start
tracelight web ctl --port 4790 debug continue
```

Open the returned URL before issuing page commands. An imported file must be known to the
page before a browser breakpoint can target it. If it is not yet known, start at an earlier
caller stop, enable library instrumentation if needed, and add the imported stop when its
source becomes available. Do not run to completion to discover it. See [browser.md](browser.md)
for supported controls and [debug.md](debug.md) for launches that do not pause as intended.

`--no-run` skips the initial execution; `--no-watch` also prevents disk saves from launching
one. Neither disables an explicit Run or scratchpad execution. An older bridge that rejects
`--no-run` cannot promise fresh browser exploration without an initial run: use a supported build,
an existing paused session, or VS Code. Do not silently fall back to automatic execution.
The browser records the same execution as it pauses for Code history. That is not a separate
pre-recording. If the user forbids all recording, use plain VS Code debugging instead.

A named destination such as “step into dispatchTool” may need several control calls. Reach it
without narrating routine guards along the way. An explicit single-step request still means
one step. Before stepping over a loop or compound guard, check whether that would also execute
the call being inspected; a destination breakpoint is often clearer.

## At each useful stop

Move to one meaningful transition, read the returned location and captured values, confirm the
visible source and highlighted statement, then explain the new evidence while still paused.
The highlighted live statement has not executed yet. To demonstrate a mutation, inspect its
input, execute the statement, and compare the observed result. Label a prediction as a prediction.

Say what changed and why it matters for the learner's question, usually in one or two sentences.
Connect the concrete behavior to its engineering consequence: who owns this state, what is
validated, what controls execution, or what makes the next turn happen. Do not infer a guarantee
from one successful input. Distinguish source-based expectations, live observations and scratch
experiments. Use the program's names and show values before introducing terminology.

For exploration, answer the current question at the requested destination and leave the pause
available for inspection or a new direction. Reach that destination without requiring “next”
at every intermediate breakpoint. Do not automatically continue through the rest of the map.

When a guided walkthrough is requested, continue its route with a short explanation at each
relevant transition. “Stop”, “wait”, or a question about the current state suspends movement.
A named destination redirects the route. Treat concepts the learner has understood as settled.
Do not ask the learner questions or give quizzes unless they explicitly request them.

Loops need one representative pass and another only when something new happens. A branch needs
the deciding value and the path observed. Do not claim total hit counts or unseen branches from
one live pause. A live session cannot step backwards in execution; reviewing captured history
changes the view, not the program's state.

## Show values and use the scratchpad

Use overlays when requested. A request to use overlays throughout the exploration authorizes them
at relevant stops without asking again. A request for one inspection does not authorize opening
cards after every later step. Ordinary step requests alone need no overlay.

At a call boundary, select the actual captured arguments and relevant derived inputs together:
`tracelight_inspect({names: ["input", "options"], open: true})`, or
`tracelight web ctl inspect open input options`. This replaces the card selection in one call.
After the operation, show its captured result before moving on. Expand the fields being inspected
and leave unrelated metadata collapsed. A card clears when the pause changes. `peek NAME`
opens a hover when a hover is what the user requested. Never evaluate code to manufacture a
missing preview. Preserve unavailable and capped markers; say when the UI cannot show the full
value requested.

Verify the source, highlight and requested overlay are visibly rendered. A control reply with
runtime state alone does not prove that the editor rendered it. Use reliable UI evidence or a
screenshot, not repeated state polling. If rendering lags, resolve that before explaining
an unseen destination. Function inspection's captured `functionSource` and `functionLocation`
identify the runtime callback when present; a static signature does not establish that identity.

Use the scratchpad to answer a specific “what changes if” question while the live program stays
paused. Prepare and run it with ONE `tracelight_scratchpad({op: "experiment", code, inputs, mocks, mockLabels, autoRun: false})`
call or `ctl scratchpad experiment --data FILE`. Confirm the
copied function and input provenance. Establish the baseline, change one input or rule, run the
copy, and compare the visible result. Keep all other inputs fixed. External fixtures are mocks,
not live provider evidence. Check application error fields as well as scratch runtime errors.
Close the experiment or restore its copy, confirm the live pause is unchanged, and return to the
exploration. Follow [scratchpad.md](scratchpad.md) for editing, dependencies and unavailable values.

When opening a scratchpad, prepare the experiment automatically before teaching from it.
Use the complete experiment operation, never separate open → update → run calls that expose
an incomplete copy. Resolve receiver `this`, required methods/helpers/callbacks, JSON/syntax,
fixtures and unavailable/capped bindings. Use real pure implementations when recoverable and
label external mocks; narrow faithfully when necessary. Inspect preparation and execution,
repair and rerun until code, copied-input provenance, completed visible output and runtime/application
errors support the lesson, or state the concrete limit. Verify actual text and visible Monaco
indentation. Never wait for the learner to report a failure or narrate an unexecuted result.
Keep the live pause unchanged and distinguish scratch results from live evidence. Follow
[the preparation gate](scratchpad.md#hard-gate-prepare-before-teaching).

## Keep the control loop short

Apply the [HARD visible-position gate](browser.md#hard-gate-confirm-visible-position) after each
navigation. Require the returned `position.ready: true`; repair `blockers` before explaining.
Use `debug step` for live execution. To revisit a past moment, declare that it is recorded and
focus its recorded source; keep the unchanged live pause separate. Never use live locals to
explain a recorded step or infer the screen position from the recording's `nav.step`.

Reuse loaded instructions, source context, browser handles and the selected session. A move
already returns source, stack and locals, including structured `valueBag` data in the browser.
Explain from that response. Do not immediately ask for the same locals or state again.
Extract the relevant bindings from a large reply rather than dumping entire objects or running
one evaluation per property. Make an extra read only for missing evidence that matters.

Batch independent preparation reads and set breakpoints before launch. Keep runtime-dependent
moves sequential. A requested jump may pass several concepts without explaining them; inspect
each control result to avoid passing the destination. UI verification should answer one question: is the source,
highlight or requested value now visible? Once confirmed, use it.

A timeout is not permission to replay a control command. Read the current state first: the
program may still be running or may already have paused. A restart executes real code again
and can repeat model requests or other effects. Do not restart to repair a stale overlay.

## Voice, chat and manual steps

Use the same session for GPT voice mode and messages in Claude Code or Codex. “Jump to tool
dispatch” directs a move; “what is this value?” asks for an explanation at the current pause.
Do not require a typed command, repeat setup on an input-channel change, or force a teaching
sequence. Keep voice explanations short enough to leave room for the next question.

“Say it out loud” changes delivery, not the pending task. Briefly state the concrete plan and
continue setup or navigation in the same turn. Avoid acknowledgment loops such as “Okay, I'll
say it out loud” followed by another promise. A request to make the plan calls for the plan
itself, followed by the already-requested session setup; it does not cancel that setup.

## HARD rule: listen before manual stepping

Every agent, including Codex and Claude Code, must establish pause-event listening before
handing controls to a user who will step during interactive learning, on any host or surface.
Browser startup and attachment automatically establish listening as soon as the page connects,
including `--no-run` sessions. Obtain the cursor and arm the first wait before `debug start`
or offering manual controls. No separate request or manual-stepping mode is required.
Keep listening through pauses, resumes and debugger restarts on the same page; reconnecting
requires a fresh cursor and wait before continuing.
Use a verified connected host pause-event subscription if available; verify that it targets
this session and genuinely wakes this chat while idle before relying on it across turns.
Otherwise get a cursor with `tracelight_wait_pause({})` and arm
`tracelight_wait_pause({after: cursor, timeoutMs: 25000})` before handing over controls.

Keep the bounded wait loop active. On `changed: true`, use the returned cursor to identify the
new pause, verify its matching visible source, and explain it once from its captured values.
The debug summary includes run, step, frame, nearby source, and each local's `valueBag`.
Retain capped and unavailable markers. Re-arm with the returned cursor after explaining;
on timeout, re-arm without explaining a step or repeated checking announcements. Timeouts
are not steps. Never advance execution or open overlays on the user's behalf. Make extra
inspect, peek, or evaluate calls only for relevant missing detail or a requested inspector.

An active wait ends with the turn and cannot wake an idle or ended chat. Never end the turn
or claim to be following manual steps while relying only on that wait. Without a genuine
idle-chat wake subscription, state that limit explicitly and keep the active listener running
until the user ends manual-step teaching or redirects work. If no event listener is available,
disclose that blocker before handing over controls. Never silently substitute "tell me after
you step" for the required listener.


## Exploring a recording

Use this route when the learner chose a recording. It is not preparation for live exploration.
Map the exact recording with `story RUN --file FILE`, `graph RUN --no-statements`, or
`walkthrough RUN --scope NAME`, then choose steps that answer the learning questions. Keep
its run identity and step numbers together. Never transplant step numbers from another run,
even of the same file: inputs, asynchronous ordering and model replies may differ.

```sh
tracelight story run.json --file demo.ts
tracelight step run.json 42 --into
tracelight why run.json 117 fusedRanking
```

`var RUN NAME` and `values RUN --line F:L` compare loop passes without visiting each one.
For objects mutated in place, a `(same object)` binding is not an after-mutation snapshot;
inspect the statement's captured reads and a later captured result. Say when evidence is absent.
Use `goto` or recording `step` on the browser page only for that selected recording. Use
`debug continue` and `debug step` for the live program. History navigation never resumes it.
See [ask.md](ask.md) for reading a recording and [browser.md](browser.md) for page commands.

## Example: learning an agent harness

Inspect the small caller and the installed library's prompt handling and loop. Plan questions
in memory: how input becomes messages, what context reaches the provider, how a returned tool
call becomes an executable operation, how its result re-enters context, and what ends the turn.
Pick executable breakpoints at those boundaries across both files before launching. Propose the
compact map: input → context/model request → tool dispatch → tool result → next turn/exit.
Then start the session. These are destinations, not compulsory lesson chapters. If the user
asks who executes tools, jump to dispatch and then the actual tool implementation.

At input conversion, show the incoming value and the resulting message. At the request boundary,
show the model, context and tool declarations. After the real provider responds, inspect its
actual response before attributing any decision to it. At tool dispatch, distinguish the model's
requested name and arguments from the harness's lookup, validation and execution decisions.
Resume to the tool result, then to the next request or exit, explaining each observed handoff.

For a scratch experiment, change one copied argument to see whether the tool actually enforces
its advertised behavior. Label any mocked dependencies. A prompt asking for a tool once is not
proof that the harness enforces a call budget; find that enforcement or identify it as absent
in the inspected path. Keep conclusions scoped to what the source and run establish.

## Finish

Briefly connect the observed stops back to the learning questions and name anything still
unresolved. Remove only the breakpoints you added before stopping a session. Leave the pause,
page or scratchpad open when the learner wants to keep using it, and state what remains active.
Follow SKILL.md's cleanup rules when exploration ends, not at every conversational handoff.

After an edit, old locations and captured values may no longer match the source. Re-inspect
changed lines and adjust the plan and breakpoints before the next execution. Do not trigger a
new run just to refresh the display. Keep recordings and copied private data out of commits.
When the learner identifies a learning-workflow failure and asks for a skill correction, fix the general
rule and apply it to the current exploration without a long maintenance detour.
