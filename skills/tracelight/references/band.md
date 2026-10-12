# The band (Claude Code only)

The Tracelight band is a Claude Code plugin (`tracelight-band`) that draws, above the person's
prompt, what the Time Machine or a debug pause of their VS Code window shows: the code around the
current step, its values, the call stack, a two-sentence explanation and the bugs found in the
run. It reads the same `--live` session your commands drive. Other agents have no band; this file
is only for Claude Code (`printenv CLAUDECODE` prints `1`).

## Is it there

The model's side is one tool, `band` (`mcp__tracelight-band__band`). When it is not in your tool
list, the band is not installed. Say once that these two commands add it, and carry on with the CLI:

```
claude plugin marketplace add ivorpad/tracelight
claude plugin install tracelight-band@tracelight
```

From a Tracelight checkout the marketplace is the checkout's folder
(`claude plugin marketplace add /path/to/tracelight`). A Claude Code session loads plugins when it
starts, so a new install shows after a restart (`claude --continue` brings the conversation back).

## The tool

`{"action": ACTION, "step": N, "session": NAME}`, where only `action` is required:

| action | what it does |
|---|---|
| `"show"` | shows the band; call it when you start stepping through a run with the person |
| `"hide"` | hides it; call it when the work moves on (planning, editing other code) |
| `"step"` | moves the Time Machine to `step` |
| `"explain"` | the explain view: code, values, stack and prose at the current step |
| `"bugs"` | the bugs view: the findings in the run, one at a time |
| `"origin"` | on a step with a bug: runs `tracelight origin` on that step, draws the chain under the bug (newest step first, the root marked `▶`, each step a button that moves the Time Machine there) and returns the same chain to you |
| `"fix"` | writes a fix plan for the bug on the current step, aimed at the root of the origin chain |

Pass `--session NAME` on every `--live` command: the band follows the session the last command
named. Give the tool the same `session` when several are live.

Fix the root `origin` names, not the line that threw, and check a link marked `inferred` with
`step --into` before a fix rests on it.

**Fix plans.** `"fix"` writes `<program dir>/.tracelight/findings/<file>-<finding>-<where>.md`: the
commands that reproduce the bug, the diff, and a check on a patched copy. It marks the plan
`status: fixed` once a fresh run no longer shows the finding. The plan is a local file for the
person and stays out of commits (`.tracelight/findings/` is gitignored in Tracelight's own
repository; say so in a project that does not ignore it). Give the person the plan's path.
Applying the fix is the person's choice: point them to `/tl a` to write the planned edit to the
file (it records the run again) and `/tl u` to put the original back, and leave the source file
as it is yourself.

## The person's keys

Tell the person the keys once, the first time you show the band. They type `/tl` and a key; a
band button does the same.

| key | does |
|---|---|
| `/tl n` | next: step over |
| `/tl b` | back |
| `/tl i` | into |
| `/tl o` | out |
| `/tl 123` | go to step 123 |
| `/tl w` | where from: the origin chain of the bug on this step |
| `/tl f` | plan a fix (in the fix box: try again) |
| `/tl a` | apply the planned fix |
| `/tl u` | undo it |
| `/tl d` | dismiss the plan |
| `/tl x` | the bugs view |
| `/tl j`, `/tl k` | next and previous bug |
| `/tl g` | go to the bug's step |
| `/tl e` | back to the explain view |
| `/tl r` | record again (a stale run); rescan (the bugs view); record from here (at a debug pause with nothing recorded) |
| `/tl p` | prose on or off |
| `/tl` | the keys, as one line |

`/tracelight-band` shows or hides the band and refreshes it.

## At a debug pause

At a plain `tracelight debug FILE --at NAME` pause, show the band too. It reads the pause from the
debugger: the place, the code, the frame's variables with their shape, the call stack, an uncaught
exception as `⚠ TypeError: Cannot read properties of undefined (reading 'rate')`, and the prose,
marked `paused · no recording`. `/tl n`, `i` and `o` step the program; `/tl b`, step numbers,
`x`, `w`, `f`, `j`, `k` and `g` answer in one line that they need a recording.

`/tl r` there records from the paused line: it stops the plain run and starts `tracelight debug
FILE --record-from FILE:LINE`, which runs the program again from the top and pauses the first time
it reaches that line. Tell the person the program runs again before they press it. With
`tracelight debug FILE --record` from the start, the band shows the Time Machine at every pause:
the step, the recorded values, bugs, where from and fix plans.

## While explaining

In `explain`, call `{"action": "show"}` before the first stop. The band then shows each stop's
line, values and stack above the person's prompt, and they can move on their own with `/tl n`,
`/tl b`, `/tl i`, `/tl o`; read where they went with `context --live`. Call `{"action": "hide"}`
when the walk ends.
