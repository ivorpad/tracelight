# Scratchpad lessons: rebuild the behaviour in small experiments

A scratchpad lesson reconstructs what the code does through executable experiments, each chosen
because it exposes the next gap in the learner's model. It does not reveal the original function
ten lines at a time. The learner is done when they can take an input they have not seen, predict
what happens and say why, not when the teacher has narrated every line.

Use it for the mechanics of a transformation: what state persists between calls, which event
changes it, what a delimiter, decoder or accumulator retains. Questions about which
implementation runs, who injects a dependency or when an async handler fires need the real run
first ([learning-patterns.md](learning-patterns.md)). A toy cannot show wiring. Both routes end
at the same place, the original code paused or recorded, where each reconstructed idea is mapped
onto its real symbol ([Map back to the original](#map-back-to-the-original)).

## Plan from the missing model

Read the original first: its observable behaviour, the state that outlives one call, the events
that change that state, and what can safely wait. Then separate two kinds of knowledge:

- API knowledge: what `TextDecoder.decode()` accepts and returns.
- Execution knowledge: why the decoder must outlive one iteration, what is unfinished after this
  call, and which part of the program owns that unfinished work.

A learner who has the first can still lack the second. Knowing an API's name does not let the
lesson skip a lifetime or ownership question. Order the stages by the gap each one exposes, not
by the order of the source. A stream parser's implementation may start with an async generator
and a reader. Its lesson can start with one string and a newline.

Keep the plan in memory, like explain's stops: one line per stage with its question, its
controlled input, and the observation that would distinguish a right model from a wrong one.

## One stage

| part | for the "why a loop?" stage |
|---|---|
| question | Why is extracting one line per arrival insufficient? |
| current assumption | One extraction per arrival is enough. |
| controlled input | `"alpha\nbeta\nga"` |
| prediction | Which lines come out, and what remains? |
| experiment | Run the current version, then the repeated-extraction version. |
| evidence | Boundary, emitted line and remainder at each iteration. |
| model update | Drain every complete line, retain the unfinished suffix. |
| transfer check | Predict `"alpha\n\nbeta\n"`. |

A stage makes an executable claim. A paragraph next to a code block is not a stage.

Each stage also declares its relation to the original: what is unchanged, what was extracted,
what a fixture supplies, and what behaviour is postponed. Replacing a network source with scripted
byte chunks is fine for framing, and says nothing about cancellation, failure or backpressure.
Keep the original's names where practical so the learner does not translate vocabularies at the
end.

## Predictions without a quiz

Before running a stage, state its prediction question once, with the code and input visible
and the result not yet run. Run when the learner answers or says run. "Just run it" or "skip the
predictions" settles it for the rest of the lesson. Never withhold a result waiting for an answer,
and never grade. A wrong prediction is information:

- Find the earliest unsupported assumption behind it and isolate that in a smaller experiment.
  Do not restart at syntax.
- A correct prediction with a sound reason means move faster, merge stages or skip one.
- An unfamiliar API gets a side experiment (its input, output, the option in play, any state it
  keeps), then the lesson returns to the main example. A familiar one gets no glossary, only
  the consequential question: "why is this instance created here rather than inside the loop?"

Track understanding per concept (state lifetime, delimiter handling, decoder state, suspension,
ownership), not a beginner/expert switch. Someone can be fluent in async iteration and unsure
about UTF-8.

## Running the stages

Start the page with the original as its file (`tracelight web FILE --no-run`) so imports
resolve from the original's directory. A lesson needs no live pause. Create each stage as its
own named scratchpad, titled by its question, with the complete code and the controlled input
in `inputs`, then run it:

```json
{ "op": "create", "title": "B · why pending must outlive feed", "code": "…", "inputs": { "chunks": ["al", "pha\nbe", "ta\n"] }, "autoRun": false }
```

```json
{ "op": "run" }
```

CLI: `ctl scratchpad create --title TITLE --data FILE`, then `ctl scratchpad run`. `experiment`
is for a function copied at a live pause and refuses without one. Earlier stages stay in
**Saved scratchpads**, so the active view holds the current question while the previous ones
stay one `load` away. Change only the input within a stage (`update` with `inputs`, then `run`),
and start a new stage when the code changes. Scratchpads share no state, so each stage's `code`
carries every definition it uses, including those from earlier stages. A name in `inputs` is
bound as a constant unless the code declares it, typed `any`, so callbacks over it need
parameter types (`(line: string) =>`) or the editor reports implicit `any`. A stage created with
`autoRun: false` is shown unrun, so the learner sees its editor diagnostics before any result.
Every scratchpad control reply carries `diagnostics` the TypeScript worker computed for exactly
that code, and `ready`. Ask the prediction only when the reply says `ready: true`. Otherwise fix
the code and send it again. Preparation and repair rules are the same as for
any experiment ([scratchpad.md](scratchpad.md#prepare-before-teaching)): verify the completed
result and its errors before asking the prediction about the next one.

Log what answers the stage's question, not everything. Framing wants previous pending text,
incoming piece, boundary, emitted line and remaining text. Async control flow wants read
requested, suspended, read completed, resumed and output emitted. Print strings with
`JSON.stringify` so `""` reads as an empty string and `\n` stays visible.

Keep observed values apart from explanatory pictures. "The decoder retains an unfinished UTF-8
sequence" is a model of its behaviour, not an inspected private field. Say so.

## Worked example: fragmented text into lines

The target behaviour: arrivals `"al"`, `"pha\nbe"`, `"ta\n"` produce lines `"alpha"`, `"beta"`.
None of the full implementation is shown until the last stage.

**A. One boundary in one value.** No stream, decoder or loop. `inputs` is `{ "text": "alpha\n" }`.

```ts
const boundary = text.indexOf("\n");
const line = text.slice(0, boundary);
const rest = text.slice(boundary + 1);
console.log(JSON.stringify({ boundary, line, rest })); // {"boundary":5,"line":"alpha","rest":""}
```

Change only the input to `{ "text": "alpha\nbe" }` and ask what `line` and `rest` will hold. `"be"` shows that
emitting a line and keeping the remainder are separate operations. Model: a delimiter splits the
text into what can be emitted and what must be kept.

**B. Make persistence necessary.** The first arrival is `"al"`. Nothing can be emitted, so what
must still exist when the next piece arrives? This version extracts at most one line per call:

```ts
let pending = "";

function feed(chunk: string): string[] {
  pending += chunk;
  const boundary = pending.indexOf("\n");
  if (boundary === -1) return [];
  const line = pending.slice(0, boundary);
  pending = pending.slice(boundary + 1);
  return [line];
}

for (const chunk of chunks) {
  const before = pending;
  const lines = feed(chunk);
  console.log(JSON.stringify({ chunk, before, lines, after: pending }));
}
```

```text
{"chunk":"al","before":"","lines":[],"after":"al"}
{"chunk":"pha\nbe","before":"al","lines":["alpha"],"after":"be"}
{"chunk":"ta\n","before":"be","lines":["beta"],"after":""}
```

The trace shows the link between calls: the second call processes `"pha\nbe"` together with what
the first left behind. Counterfactual: what changes if `let pending = ""` moves inside `feed`?
That checks state lifetime, not string concatenation.

**C. Make repetition necessary.** Reset and feed `"alpha\nbeta\nga"`. Stage B emits `"alpha"` and
keeps `"beta\nga"`. Is all of that unfinished? Replace everything after `pending += chunk` with:

```ts
const lines: string[] = [];
let boundary = pending.indexOf("\n");
while (boundary !== -1) {
  lines.push(pending.slice(0, boundary));
  pending = pending.slice(boundary + 1);
  boundary = pending.indexOf("\n");
}
return lines;
```

| text before the check | boundary | emitted | retained |
|---|---:|---|---|
| `"alpha\nbeta\nga"` | 5 | `"alpha"` | `"beta\nga"` |
| `"beta\nga"` | 4 | `"beta"` | `"ga"` |
| `"ga"` | -1 | none | `"ga"` |

The invariant: after `feed` returns, `pending` contains no `\n`. It explains both the loop and its
stop. Transfer check: `"alpha\n\nbeta\n"` also emits `""`, a valid empty line, not a reason to stop.
Model: an arrival makes as much progress as the data allows, and arrival boundaries do not decide
output boundaries.

**D. Completion is a separate event.** `pending` holds `"ga"` and no more input will come. What
decides whether to emit, reject or discard it? This lab's rule: a nonempty tail is a line when
input ends normally.

```ts
function finish(): string[] {
  const lines = pending === "" ? [] : [pending];
  pending = "";
  return lines;
}
```

`finish()` returns `["ga"]`. The rule belongs to the parser's contract, not to the stream API, and
a failed input is not normal completion: it needs its own specified behaviour.

**E. Bytes only when they cause a new problem.** `"café\n"` split inside `é`:

```ts
const pieces = [new Uint8Array([0x63, 0x61, 0x66, 0xc3]), new Uint8Array([0xa9, 0x0a])];
const decoder = new TextDecoder();
console.log(JSON.stringify(decoder.decode(pieces[0], { stream: true }))); // "caf"
console.log(JSON.stringify(decoder.decode(pieces[1], { stream: true }))); // "é\n"
console.log(JSON.stringify(decoder.decode()));                            // ""
```

Ask first whether each piece can be decoded as complete text on its own. Then explain only what
this experiment needs: `{ stream: true }` keeps decoding state for the next call, and the final
`decode()` ends the session. Two kinds of incompleteness now exist:

| unfinished work | owner |
|---|---|
| an incomplete UTF-8 sequence | the decoder |
| decoded text with no line boundary yet | `pending` |

The decoder can produce `"caf"` before finishing `é`, and the framer keeps `"caf"` because it has
seen no newline. Counterfactual: a new decoder per piece tests the decoder's lifetime separately
from the buffer's.

**F. Asynchronous arrival last.** Now the real source. Explain the interface the original
actually uses: Node's `Readable` and the Web `ReadableStream` both support `for await` but are not
interchangeable APIs.

```ts
async function consume(source: AsyncIterable<Uint8Array>) {
  const decoder = new TextDecoder();
  for await (const bytes of source) console.log(feed(decoder.decode(bytes, { stream: true })));
  console.log(feed(decoder.decode()));
  console.log(finish());
}

await consume(ReadableStream.from(pieces)); // scripted arrivals stand in for the real source
```

With stage C's `feed`, stage D's `finish` and stage E's `pieces` in the same code, this logs
`[]`, `["café"]`, `[]` and `[]`. A bridge older than the native-process scratchpad (the 0.5.0
extension's, for one) reports `ReadableStream is not defined`. There, an
`async function*` that yields each piece gives the same output.

The learner knows most of this already. The new question is temporal: while waiting for the next
arrival, which state stays available when execution resumes? Order: bytes arrive, the decoder
produces text, the framer extracts lines, the consumer receives them. On normal completion:
finish decoding, feed the final text, apply the tail rule. Say what the toy still lacks: its
framing state lives at scratchpad scope, so it is not per stream, and it sets no resource limits
or cancellation behaviour. Those become further stages only if the original code needs them.

The model the learner leaves with: each arrival adds information, decoding resolves complete
encoded text, framing resolves complete lines, each stage keeps its own unfinished work, and
normal completion settles what remains according to the contract.

## Map back to the original

End in the original code, paused at its real entry or recorded
([explain.md](explain.md#from-a-first-question-to-a-paused-session)), and connect each idea to a
symbol or branch there: "this variable is what we called `pending`", "this loop is
drain-until-no-delimiter", "this branch handles normal completion", "this scope gives each stream
its own state". A scratchpad stage shows what the reconstruction computes. That the original does
the same rests on its own pause, step or recording, and a mismatch found there is a finding, not
something to smooth over.

Keep three claims apart: what the code does (a run establishes it), what its contract requires
(tests and requirements), and why the author chose the design (neither, unless someone wrote it
down). Do not invent the third because it makes a better story.

## Check the model

Finish with tasks the learner does, not more narration:

- Predict: given chunk boundaries they have not seen, name the emitted lines and the retained
  state before running.
- Explain: what breaks if the persistent state is recreated per iteration, or if the drain loop
  becomes a single extraction.
- Transfer: find each mechanism in the original and make a small behavioural change with a test.

Run their predictions in the scratchpad. "I followed the explanation" is not the same result as
an unfamiliar execution they predicted correctly.
