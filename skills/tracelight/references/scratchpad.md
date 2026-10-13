# Scratchpad

Use the browser scratchpad to experiment with a function and copied inputs while the live
program stays paused. It opens beside the source in a right side panel. Edits run in a separate
worker; they do not step, evaluate in, or mutate the live debugger's frame.

## Open the current function

Start from an existing live pause. Reuse its returned source, frame and captured values;
do not read the implementation again merely to open the scratchpad.

```sh
tracelight web ctl --port 4817 scratchpad open
tracelight web ctl --port 4817 scratchpad open --line 368
tracelight web ctl --port 4817 scratchpad close
```

WebMCP `tracelight_scratchpad` takes `{"open":true}` and an optional `line`.
`{"open":false}` closes it. Discover the page's actual tool name before calling it.
Neither command advances the live run. These controls open or close the pane; editing code,
inputs and mocks uses the editor UI, not additional scratchpad tool arguments.

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

Opening again currently makes a fresh copy. Preserve an edited experiment before reopening,
adding another function or reloading the page.

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

The initial copy supplies `emit: null` when an `emit` binding exists. That is a mock, not the
original callback. Choose fixtures that answer the learner's question and label their results
as mocked. Do not present a fixture as an observed response from a real service.

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
