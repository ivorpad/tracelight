# Scratchpad

Use the browser scratchpad to experiment with a function and copied inputs while the live
program stays paused. It opens beside the source in a right side panel. Edits run in a separate
worker; they do not step, evaluate in, or mutate the live debugger's frame.

Give the experiment one question. Establish a baseline with the copied inputs, change one input
or rule, then compare the visible result with the baseline. Label mock fixtures and keep the
other inputs fixed. Check application error fields before drawing a conclusion. Close or restore
the copy and verify that the live pause is unchanged before resuming the lesson or investigation.

A scratchpad result shows what the copied code computes from copied inputs and labelled mocks.
It does not show that the application calls the function that way, injects those dependencies or
handles its result like that. A second real run of the entry point with one changed condition
does ([learning-patterns.md](learning-patterns.md#contrast)), so use the scratchpad next to it,
not instead of it, and label its results as scratchpad results.

## Open the current function

Start from an existing live pause. Reuse its returned source, frame and captured values;
do not read the implementation again merely to open the scratchpad.

```sh
tracelight web ctl --port 4817 scratchpad open
tracelight web ctl --port 4817 scratchpad open --line 368
tracelight web ctl --port 4817 scratchpad close
```

WebMCP `tracelight_scratchpad` controls the complete visible experiment. For agent preparation,
use ONE `op: "experiment"` call containing the complete code, inputs, receiver/dependencies
in code or bindings, explicit mocks/labels and `autoRun` policy. It copies pause provenance,
formats the code, publishes only the complete package and awaits one execution. It does not
auto-run the initial copied function. CLI: `ctl scratchpad experiment --data FILE`.
Do not prepare a lesson through separate open → update → run calls.

Discover the page's
actual tool name, then use `op: "open"`, `"state"`, `"update"`, `"run"`, `"restore"` or `"close"`.
The old `open: true|false` remains supported. `update` atomically replaces any supplied `code`,
`inputs`, `mocks` and `autoRun`. Supply `mockLabels` with a descriptive label for every mock key.
Inputs and mocks are whole JSON objects, not patches. Omitted fields keep their current values.

```json
{
  "op": "experiment",
  "code": "const result = message.content.filter(item => item.type === 'toolCall');",
  "autoRun": false
}
```

The experiment reply awaits the worker; read its `status`, `result.values`, `result.output`,
`result.error`, `result.applicationErrors`, `result.missingMocks` and `result.caps`. `state` also
returns the editor code, inputs/mocks and their raw text (including invalid manual JSON), fixture
labels, revision and captured provenance. `provenance.capturedInputs` preserves the original
unavailable/cap markers when the editable inputs are replaced. `liveExecutionChanged` is false.
A newer edit cancels the old request and clears its results. `state` does not await an automatic
run; inspect it again after the scheduled/running state, or use `run` for a completed answer.

The bridge accepts the same typed command at `/api/command`. CLI equivalents are
`ctl scratchpad state|run|restore` and `ctl scratchpad update --data /absolute/experiment.json`.
The data file holds the same update fields. `open` accepts `--line`. All controls use the real
Monaco models and the same worker as manual Run. No scratch operation advances live execution.

Prepare the experiment yourself. Local helpers and imports resolve automatically. Try the
smallest expression that answers the question before rerunning a full loop. An unrelated
unavailable callback does not need a fixture when the experiment never accesses it. For a
missing dependency, recover its real pure implementation when available. For an external
boundary, use the returned exact `missingMocks` path and an explicit labelled fixture, then
rerun the complete experiment. Do not ask the learner to fill the mock editor. Never guess uncaptured
inputs or describe a provider/model fixture as a real response. Check runtime errors and
application error fields, confirm visible values, then explain one concrete input-to-result
transition. Do not quiz the learner unless they ask.

The **Scratchpad** header button opens the pane. **Add function** copies the function at the
main code cursor, and the main editor context menu also offers **Add function to scratchpad**.
Opening copies the containing function, adds a call with its parameter names and stores the
selected frame's captured bindings in **Inputs · copied at pause**. Check that those bindings
belong to the function being explored, particularly when browsing a different source file.
Copied JavaScript parameters receive `any` annotations; these are not inferred runtime types.

```ts
async function example(message: any) {
  const calls = message.content.filter((item: any) => item.type === "toolCall");
  return calls;
}

const result = await example(message);
console.log(result);
console.log(1);
export {};
```

`export {}` makes the editor treat the copy as a module, allowing top-level `await`.
The runtime handles it separately from the executable function body.

## Prepare before teaching

Every agent owns preparation and repair without waiting for the learner. Inspect source and
captured-input provenance before sending the complete experiment in one call. Resolve a class
method's receiver `this`, required methods/helpers/callbacks, syntax and input/mock JSON,
incomplete fixtures, unavailable or capped bindings, runtime exceptions and application errors.
A copied method is not a captured instance. Use real pure implementations for recoverable helpers
and receiver methods. Reconstruct state only from captured data, never guessed closures or fields.
Use explicit labelled mocks only at external boundaries. If dependencies cannot be recovered or
obscure the concept, narrow to a faithful pure experiment and state what was omitted. Do not
silently change its meaning. Keep the live program paused.

Never invent missing captured values or silently mock real provider behavior. If an external
call needs a fixture, label the substitution and its output; do not present fixture results
as live evidence. Retain unavailable and capped markers. When necessary inputs are unavailable,
state that limit and narrow the experiment instead of guessing them.

After preparation or an edit, verify the actual code, the function and pause the copied inputs
came from, readable indentation in both actual text and Monaco, completed visible output and
runtime/application error fields before teaching. Repair and rerun until the result supports
the lesson, or state the concrete remaining limit. Never narrate an unexecuted result or leave
a known error for the learner to discover. A worker success alone does not establish application success.
Confirm that the live pause has not moved. Do not ask the learner questions or give quizzes
unless they explicitly request them.

Receiver-dependent bare copies report `status: "needsPreparation"` and
`preparation.requiresReceiver: true`; automatic execution waits for replacement. Explicit Run
still runs the current copy. A copied `Agent.prompt` using `this.normalizePromptInput` needs
the real pure normalizer and a prepared receiver. A labelled dispatch fixture may capture the
normalized messages without a model request; it proves the transformation, not provider behavior.
Supply that whole prepared experiment in one call and verify its executed result.

## Edit and inspect

| Control | Behavior |
|---|---|
| TypeScript editor | Edit the copied function or replace it with an expression or experiment. |
| Inputs · copied at pause | Edit syntax-highlighted JSON copies of captured bindings. |
| Mocks · external calls | Edit JSON fixtures for unavailable functions or HTTP calls. |
| Auto run | Code, input and mock edits schedule a run after a 150 ms debounce. A newer edit supersedes the previous response. |
| Run | Execute the current copy explicitly, including with Auto run off. |
| Restore copy | Restore the original copied code, inputs and initial mocks. |
| Close | Hide the pane and cancel its pending request without advancing live execution. |

Each creation persists as a separate named scratchpad. Opening a function again creates a new
entry; earlier experiments remain in **Saved scratchpads**. **New scratchpad** starts an empty
experiment without needing a live pause. The header Scratchpad button opens the library/current
copy, including when no debugger is running.

Autosave is always on. Creation, debounced edits to code/inputs/mocks/name, completed runs,
restores and close write snapshots to the server's `~/.tracelight/scratchpads` directory
(`$TRACELIGHT_HOME/scratchpads` when configured). The library survives reloads, bridge restarts
and port changes. **Save checkpoint** adds an explicit snapshot; it is not required for saving.
The UI reports **Autosaving**, **Autosaved · vN** or a save error. Do not claim a save succeeded
when `saveError` is non-null or `saving` is true. Wait for the saved indication before reloading.

WebMCP operations, on the same `tracelight_scratchpad` tool:

- `create` accepts a `title`, optional source `file` (defaults to the main file), `code`, `inputs`,
  `mocks`, `mockLabels`, `autoRun`. Supplied inputs have no invented live-pause provenance.
- `list` returns `scratchpads` summaries with stable `id`, title, file, saved version and status.
- `save` checkpoints the current copy, optionally renaming it with `title`.
- `history` takes an `id` (defaults to current). It returns saved version summaries. Include
  `version` to read that full snapshot as `entry`, without changing the visible editor.
- `load` takes `id` and optional `version`. It reopens the saved code, JSON, labels, provenance,
  original Restore copy baseline and actual previous results. Loading never executes the copy.
  Edit it or use `run` to continue experimenting. New saves append to history; old versions stay.

The state includes `id`, `title`, `savedVersion` (latest save), `loadedVersion` (the displayed
historical snapshot, null after an edit), `saving` and `saveError`. **Scratchpad history** and
**Saved scratchpads** expose the same versions in the visible pane. The tool's history is a
history of scratch experiments, not the live debugger's recording.

CLI examples: `ctl scratchpad list`, `create --data experiment.json`,
`save --title "Filter tool calls"`, `history --id ID [--version N]`, and
`load --id ID [--version N]`. List and history can also be read through the bridge when no page
is open. Concurrent pages must load the newest version after a save conflict; a stale writer
cannot overwrite a newer save. Rerunning uses dependencies currently on disk, not a frozen
copy of every imported module. A saved result remains evidence of its original scratch run.

Captured variable declarations appear as inline values and expandable value trees below the
editor. Hover a variable in the scratch editor to see its captured scratch value with JSON
syntax highlighting. These values come from the scratch run, not the live frame. Editing
clears old results while the replacement run is pending. Assignment-only changes are not
currently instrumented; do not promise a value history for every mutation or expression.

`console.log(1)` produces a plain `1`. `console.log(result)` produces an expandable object in
the console. Multiple arguments belong to one log entry. The UI must not expose the internal
array of log entries as nested arrays around scalar output.

Before teaching from a result, confirm that the value or console entry is visible and the
run completed. A returned object can contain an application error even when the scratchpad
itself reports no error. Inspect relevant error fields before calling the experiment successful.

## Dependencies and mocks

Referenced declarations and imports resolve relative to the original source file. Edited
declarations override the originals. The dependency collector includes required local helpers
without running unrelated statements from the original module. Imported modules can execute
their initialization inside the scratch worker. Node built-in imports are rejected.
This is not a complete Node or browser environment.

Captured functions are unavailable data until explicitly mocked. A fixture key is the dotted
path of the copied function. The fixture supplies its return value; it is not executable code.
For example, a copied tool implementation and event callback can use:

```json
{
  "emit": null,
  "currentContext.tools.0.execute": {
    "content": [{ "type": "text", "text": "Mocked lookup" }],
    "details": { "mocked": true }
  }
}
```

The initial copy supplies no synthetic fixtures. Choose fixtures that answer the learner's
question and label their results as mocked. Do not present a fixture as an observed response from a real service.

For `fetch("https://example.test/job")`, provide:

```json
{
  "http:https://example.test/job": { "id": "email", "seconds": 2 }
}
```

The mock response supports `json()` and `text()`, with `ok: true` and `status: 200`.
It does not issue an HTTP request. Missing fixtures fail explicitly. Full Request/Response,
headers, status customization and arbitrary network clients are not implemented by this fixture.

## Runtime limits and failures

The bootstrap supplies `TextEncoder`, `TextDecoder`, `URL`, `URLSearchParams`, `structuredClone`
and `performance.now()`/`timeOrigin`, alongside the VM's JavaScript built-ins. These APIs are
available before imported dependencies initialize. Cloning handles common collections, typed
buffers and cycles, but does not implement every platform object's cloning or transfer semantics.
Do not claim that all browser or Node APIs are available.

Copied values have capture limits. Functions, missing fields, capped strings and incomplete
arrays retain explicit unavailable markers. Never replace those markers with guessed data.
JSON edits cannot reconstruct closures or class instances. Method copies can still need an
explicit receiver or other uncaptured context.

The worker has a 64 MB heap limit, synchronous execution timeouts and a three-second overall
limit. Results cap captured declarations at 200 and console entries at 100. Function bodies
and input edits auto-run, so keep expensive experiments small. The 150 ms debounce is not a
promise that compilation and execution finish within 150 ms.

On failure, read the displayed error first. Results captured before the failure may remain
available, but a failed call has no completed `result`. A missing standard API is a runtime gap;
a missing mock needs a fixture. A compiler-service failure is neither. Fix and verify the cause
instead of hiding the error, inventing output or advancing the live program.

## Verify a scratchpad change

Use the browser to check the right side panel, copied function and input provenance, edits with
Auto run on and off, Run, Restore copy, close, nested expansion, result hover and both scalar
and object console output. Exercise the actual copied function with explicit external fixtures.
Check that the live pause has not moved. Unit tests alone do not establish that editor input,
hover rendering or panel interaction works in the loaded server build.

See [browser.md](browser.md) for page controls and [debug.md](debug.md) for live execution.
