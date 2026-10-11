# Tracelight

A JavaScript and TypeScript playground in your editor: live values next to your code, coverage,
and a time-travel debugger with an interactive timeline. Open a `.js`, `.mjs`, `.ts` or `.tsx`
file and press `Cmd+K Q` (`Ctrl+K Q`) to run it; values appear on every line as it runs.

- **Live values and coverage** inline, re-run on save (or as you type, or on demand).
- **Time Machine**: step forwards and backwards through the run that already happened.
- **Debugger**: F5 with a `tracelight` launch configuration stops at breakpoints and exceptions
  in the running program, with the frame live for evaluation.
- **Code Story, Why This Value, Execution Diagram, HTTP record/replay, Profile, Tour.**
- **Agents**: the `tracelight` CLI and `tracelight mcp` read runs and drive the open window
  (setting `tracelight.agentAccess`).

Needs Node.js 22.18 or newer (`tracelight.nodePath`, else `node` on PATH). Tracelight installs
next to Pyokka (the same features for Python) without sharing a command, a setting or a key.

Built from the [pyokka-dev](https://github.com/ivorpad/pyokka-dev) repository:
`node esbuild.mjs --tracelight`, then `npx vsce package` in `tracelight/`.
