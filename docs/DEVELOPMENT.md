# Development


```sh
npm ci && npm ci --prefix node                    # once; node/ has its own lockfile
npm run build                                     # dist/: extension, panel, page, runtime (dist/node)
npm test                                          # typecheck + vitest + the runtime's node:test suite
npm run test:e2e                                  # vscode-test with .vscode-test.mjs
npm run test:web-smoke                            # after build: the browser page in headless Chrome (scratchpad typing, reload on rebuild, import.meta.main pause), then driven over `tracelight mcp --http`
npm run package                                   # production build and the vsix, at the current version
scripts/check.sh                                  # typecheck, vitest, runtime tests, build, the band
scripts/release.sh                                # bump + check + build + install + tag + GitHub release
claude plugin validate --strict claude-plugin/tracelight-band
claude plugin test claude-plugin/tracelight-band  # the band's tests, against captured CLI JSON
node node/bin/tracelight.mjs run FILE --save run.json   # then story / step / context / why ...
tracelight state --live --session FILE            # needs a window with tracelight.agentAccess on
```

The band is a Claude Code function-hooks plugin. The validator follows `$` only into functions
declared in the same file and reads `update`/`read` only of atoms declared there, so every
function that takes `$`, and the atoms, live in `hooks/register.tsx`; the other modules are pure
(parse, narration, fix, plans, keys, views).

## Versions and releases

Two files carry the version: `package.json`, which decides it, and `node/package.json`, which
`tracelight version`, the runner's `ready` and the MCP server's `serverInfo` report.
`scripts/version.py` writes both. The level comes from a `Bump:` trailer (`major`, `minor`,
`patch` and their synonyms) on the commits since the last `vX.Y.Z` tag; `.githooks/commit-msg`
rejects a value that is not a level, after a one-time `git config core.hooksPath .githooks`.

`.claude/hooks/bump-version.sh` (a `PreToolUse(Bash)` hook) bumps before a Claude Code Bash
command whose text contains `vsce package`, `--install-extension` or `esbuild.mjs --production`,
so the vsix carries the new number. It reads the command text only: `npm run package` does not
trigger it, and installing an existing vsix from Claude Code does, moving the repository's version
without changing the file being installed. `scripts/release.sh`
bumps, checks, cuts `## Unreleased` in `CHANGELOG.md`, builds, installs, tags and creates the
GitHub release with the vsix attached. The repository is `ivorpad/tracelight`.

## Quirks

- Entry files, roots, imported unsaved buffers and debugger paths are canonicalized with Node's
  `realpathSync`. No `TMPDIR` workaround is needed for symlinked projects.
- The VSIX is per platform: oxc-parser and esbuild carry native binaries. `npm run package`
  labels its target and filename. `.github/workflows/qa.yml` builds separate platform artifacts;
  a local package only validates the local platform.
- Installing never restarts a running extension host; the status-bar tooltip shows the build
  stamp, and the Tracelight output channel logs every run's reason.
- The e2e launcher forces workspace trust off; trust needs a dev host with a short fresh
  `--user-data-dir`.
- Per-user state (session descriptors and sockets, `last-debug.json`, recent files, the library
  cache) lives under `$TRACELIGHT_HOME`, `~/.tracelight` when unset; `tracelightHome()` in
  `src/util/paths.ts` and `node/src/home.ts` are the resolvers. `.vscode-test.mjs` uses a fresh
  `/tmp/tl-e2e-*` per run, so e2e never sees the user's windows. Keep such paths short: a session
  socket path is capped at 104 bytes on macOS.
- Instrumented library files are cached in `$TRACELIGHT_HOME/cache/`; `TRACELIGHT_CACHE_DIR`
  moves it, empty disables it.
- The extension runs the runtime from `dist/node`, also in a dev host: after a runtime edit run
  `npm run build` again; the next run picks it up, no reload.
- Panel components render to HTML in vitest with `preact-render-to-string`
  (`test/unit/webview/chrome.test.tsx`); the e2e suite cannot see inside the webview.
- Where `npm` is wrapped by `npq`, a non-interactive `npm install` may wait on stdin and install
  nothing; run `./node_modules/.bin/*` directly.
- Worktree dependencies are local development setup, never installation prerequisites. Use
  `npm ci` and `npm ci --prefix node` in a fresh checkout. The e2e launcher supplies a short,
  isolated user-data directory; `TRACELIGHT_TEST_CODE` can point to an existing test executable.
- A headless-Chrome screenshot of a code-history page needs `--virtual-time-budget=3000`. The page
  is coloured by Shiki in the renderer, so it fetches nothing.

