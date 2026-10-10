# Changelog

## 0.1.0

First standalone release. Tracelight is split from Pyokka, the Python extension it was built
alongside, into its own repository and extension (`ivor.tracelight`) for JavaScript and
TypeScript only; all Python support is removed.

- Live values, `// ?` comments, logpoints, Auto Log and coverage for `.js`, `.mjs`, `.cjs`,
  `.ts`, `.mts`, `.cts`, `.jsx` and `.tsx` files on Node 22.18 or newer.
- Time Machine: a recording of every statement, stepping forwards and backwards, watches,
  Variable History, Why This Value, Code Story, Execution Diagram, tours and narration.
- Debugger: launch type `tracelight`, with or without recording, including worker threads.
- HTTP view with record and replay of `http`/`https`, `fetch` and XHR.
- Profile and Snaps modes; secret masking.
- The browser page (`node dist/web/server.js FILE`), the `tracelight` CLI (installed to
  `~/.local/bin` when `tracelight.agentAccess` is on), `tracelight mcp`, and the agent skill in
  `skills/tracelight/`.
