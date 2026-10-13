# Example: learning an agent harness

An optional example for one kind of codebase: an LLM agent harness such as Pi, where a loop sends
context to a model, runs the tools the model asks for and feeds the results back. Read it when the
learner asks about a harness. Other codebases need none of these checkpoints. The general method
is [explain.md](explain.md), and [learning-patterns.md](learning-patterns.md) works the five
investigations on a plain service.

## Finding the code and a caller

An installed CLI such as `pi` does not live in the Tracelight checkout, and an empty search there
says nothing about a globally installed package. Locate the executable (`command -v pi`), resolve
its symlink or read its launcher, and follow that package's dependencies to the implementation.
Fall back to the package manager's global root only when the launcher does not lead there.

Without a runnable caller, write a small SDK driver in a scratch directory outside both projects.
Explain the inputs and tools it supplies, and step into the installed library rather than copying
its code into the driver. The library sits in `node_modules`, so its stops need library code
instrumented: `--library-code` on `tracelight debug`, or the Library code setting on the page
before `debug start`.

```sh
tracelight debug driver.ts --at acceptInput --at prepareContext --at dispatchTool --library-code
tracelight continue --live --session driver.ts
tracelight step --live --session driver.ts --into
```

For a model run the learner asked for, use the configured provider and the exact model named. A
mocked provider shows what the harness does with a reply, not what that model did.

## Stops chosen by the question

Start with the control loop and its actual continuation condition, then turn each responsibility
the learner asked about into executable stops across the driver and the library:

| the learner asks | where to stop |
|---|---|
| what reaches the model? | the provider request boundary: model, context, tool declarations |
| who runs the tool? | dispatch: the requested name and arguments, the harness's lookup and validation, then the tool's own implementation |
| why another turn? | where the tool result enters the context, and the loop condition |
| how does steering work? | the configured message producer, queue insertion, queue consumption, and the next request that contains the message |
| how are tool calls batched? | selection, argument validation, scheduling, invocation and result collection |

A compact map, input → context and model request → tool dispatch → tool result → next turn or
exit, names destinations, not chapters. If the learner asks who executes tools, go to dispatch and
then into the tool.

## What each stop can establish

At input conversion, show the incoming value and the message it became. At the request boundary,
show the model, the context and the tool declarations. After the provider answers, read the actual
response before attributing a decision to the model. At dispatch, separate what the model requested
from what the harness decided. Then resume to the tool result, and to the next request or the exit.

Demonstrate a feature only with an example that exercises it. A steering lesson has to enqueue and
consume a real steering message, and ordering or interruption is described only from the observed
run: do not claim that steering messages get a special role or priority without finding it in this
implementation. An undefined hook is an absent hook, not an active permission check. Persistence,
permission hooks, sandboxing and guardrails need a configured example of their own when this caller
does not set them, since an extension point is not an enabled policy. Say which responsibilities the
current example exercises and which would need another.

A prompt that asks for a tool once does not prove the harness enforces a call budget. Find the
enforcement, or report it absent from the path you inspected. A scratchpad experiment that changes
one copied tool argument can show whether the tool enforces what it advertises. Label each mocked
dependency ([scratchpad.md](scratchpad.md)).
