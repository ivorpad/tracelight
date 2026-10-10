# Agents

Tracelight is a VS Code extension for JavaScript and TypeScript (Node 22.18+): live values,
coverage, a recording Time Machine, a debugger (launch type `tracelight`), a browser page, the
`tracelight` CLI and `tracelight mcp`. User docs: `README.md`.

## Layout

- `src/` the extension (entry `src/extension.ts`); `webview/` the panel it shows (Preact).
- `web/` the browser page and its bridge server (`docs/WEB.md`).
- `node/` the runtime, CLI and MCP server (`node/bin/tracelight.mjs`, `node/src/`), shipped as
  TypeScript source and copied to `dist/node` by the build (`docs/RUNTIME.md`).
- `skills/tracelight/` the agent skill. `test/` unit (vitest), e2e (VS Code) and fixtures;
  `node/test/` the runtime's tests (node:test).
- `docs/PROTOCOL.md` is the wire contract between the extension, the browser bridge and the
  runtime. Change it together with both sides.

## Build and test

```sh
npm ci && npm ci --prefix node
node esbuild.mjs            # dist/ (extension, webview, web page, runtime in dist/node)
npm test                    # tsc + vitest + node/ tests
npm run test:e2e            # VS Code end to end (.vscode-test.mjs)
test/code-server/run.sh WORKSPACE test/e2e/tracelight.test.js ivor.tracelight tracelight.vsix   # e2e without a VS Code download
npx vsce package            # vsix; bundles oxc-parser's platform binary, so build on the target platform
```

## Using Tracelight on a program

To understand, debug or explain what a JS/TS program did, use Tracelight instead of reading the
source: `skills/tracelight/SKILL.md`, with a mode as its first argument (`debug`, `explain`,
`show`). The command reference is `skills/tracelight/references/tracelight-cli.md`. Run the CLI
from the checkout as `node node/bin/tracelight.mjs ...`, for example
`node node/bin/tracelight.mjs run FILE --save run.json`, then `story run.json --file FILE`.
