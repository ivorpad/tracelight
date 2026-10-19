# Learnings

What went wrong while Tracelight became its own project and was first driven for real, how it
showed, and the rule each time taught. The build and test quirks themselves are in
[DEVELOPMENT.md](DEVELOPMENT.md#quirks); this file is the reasoning behind a few of them.

## A build-time rename leaks (2026-10-11)

Tracelight was first built from Pyokka's sources, with a script that renamed `pyokka` to
`tracelight` at bundle time and `IS_TRACELIGHT` branches in shared code. Every check passed and the
product still leaked: `tracelight mcp` listed its six tools as `pyokka_*`, CLI help and session
directories carried the other name, and the Claude Code band followed both CLIs under one title.
Each leak sat somewhere the rename never looked, such as a tool table or a regex.

**Rule:** a second product gets its own repository and a one-time rename of the source. A name
written in the source can be grepped and tested. A name produced by a build step can only be
checked in the artifact, and nobody greps the artifact.

## A search that prints nothing proves nothing (2026-10-12)

The independence check (no Pyokka paths in this repository) came back clean, and
`src/session/moments.ts` still named `python/pyokka_runtime/agent/moments.py` on line 4. In the
Claude Code shell, `grep` is a wrapper function (`type grep` says so), and it silently skips any
file it thinks is binary. `moments.ts` had three raw NUL bytes, separators inside template-literal
keys, so `file` called it `data` and the wrapper never read it. The comment turned up only because
`dist/web/app.js.map` carried the file's source. `/usr/bin/grep -rn` reports the same file as
`Binary file ./src/session/moments.ts matches`.

**Rule:** write separators as escapes (`\u0000`), never as raw control bytes; the file is plain
text now. Run any check whose answer is "no matches" with `/usr/bin/grep` or `grep -a`, and before
trusting an empty result, know that the tool read every file.

## On disk is not running (2026-10-12)

Three times the new code was on disk while something kept running the old code:

- **VS Code.** After the new vsix was installed, the window kept running the code it had loaded
  before the split, and no Tracelight session ever appeared. Installing never restarts an extension
  host. Reinstalling 0.3.0 over 0.3.0 also needed `--force`. Developer: Reload Window fixed both.
- **Claude Code.** The band above the prompt still said "pyokka" while it showed a Tracelight debug
  session. The session had loaded the pre-split band at start, and that band followed both CLIs
  under Pyokka's title. `tracelight-band` had never been installed. It needed
  `claude plugin marketplace add` on this checkout, `claude plugin install tracelight-band@tracelight`,
  and a restart.
- **The browser page.** `web/agent.ts` and `web/debugHost.ts` run in the browser, bundled into
  `dist/web/app.js`. A restarted bridge serves the new bundle, but a tab opened earlier keeps the
  old one and reconnects by itself (`web/link.ts`). The bridge also hands every agent command to
  every open tab and takes the first answer (`agent()` in `web/server.ts`), so a stale tab can
  answer for the fixed one.

**Rule:** after an install or a build, restart whatever holds the old code (reload the window,
restart Claude Code, reload the tab) before judging the fix. To check a page fix without someone's
open tab answering, run a second bridge on another port (`--port 4778`) with a fresh page, for
example headless Chrome, and drive that one.

## Agent access belongs to one extension (2026-10-12)

`tracelight state --live` found nothing for an `orders.js` that was open in VS Code. The user
settings turned agent access on only for the other extension. `tracelight.agentAccess` was unset,
so `~/.tracelight` did not even exist. After `"tracelight.agentAccess": true` and a reload,
`tracelight debug orders.js` with three `--at` breakpoints started the session in the window
through its URI and stopped at line 5.

**Rule:** when an agent cannot see a session, check this extension's own setting first, then
`ls ~/.tracelight/sessions`. Don't print the descriptors there, because they hold the session's
token.

## Two surfaces, one function (2026-10-12)

The browser page's debugger and VS Code's disagreed in two places, and in both the page had its own
copy of a rule VS Code already kept in one function.

With breakpoints on lines 5, 23 and 11, the page's `debug start` paused at "start of the run" on
line 18. VS Code and `tracelight debug` decide with `entryPause` (`src/session/debugState.ts`):
pause before the first statement only when asked, or when no breakpoint can hit. The page's
`DebugHost.start` defaulted to `stopOnEntry = true`. Its agent waiter also waited for a pause that a
run ending without one never sent, so `debug start` took the full 10 seconds to answer.

At the line 11 pause, the page's `eval amount + tax` answered `ReferenceError: amount is not
defined`. The page sent `eval` to the finished recording, at the top level of the file, while its
own watch expressions already used the paused frame. `tracelight eval --live` at the same line in
VS Code printed `20.630000000000003`.

**Rule:** a behavior that two surfaces share is one function that both call, and a command name
means the same thing everywhere. The page now calls `entryPause` and evaluates in the paused frame.
`test/unit/webPageHost.test.ts` pins both, along with the prompt answer.

## Narrate after you know where you stopped (2026-10-12)

The page's `debug start --say "First stop: priceFor for coffee..."` put that bubble on line 18,
because the move stopped somewhere other than where the text assumed. `--say` attaches to wherever
the move ends.

**Rule:** when you are not sure where a move stops, move, read the stop from the answer, then
`say TEXT --line N`. Attach `--say` to a move only on a path you have already seen.

## The independence check missed words that weren't names (2026-10-12)

The check looked for Pyokka's identifiers, so it missed Python text that never mentions Pyokka:

- the `smart` run mode's description in `package.json` named `pyproject.toml` and
  `requirements.txt`, while `src/config/project.ts` checks `package.json`, `tsconfig.json` and lock
  files;
- `docs/WEB.md` showed `ctl eval "len(points)"`;
- `test/unit/walkthrough.test.ts` said to regenerate its fixtures "from the Python side with
  `TRACELIGHT_WRITE_FIXTURES=1`", and nothing in this repository reads that variable.

**Rule:** a check for another project's leftovers also looks for its language: the manifest test
now rejects `python`, `pyproject` and `requirements.txt` as well as `pyokka`. A fixture names the
command in this repository that rewrites it. When that command is gone, the fixture says it is
frozen. The walkthrough and band fixtures are in that state ([RUNTIME.md](RUNTIME.md)).

## The bump hook reads command text (2026-10-12)

`.claude/hooks/bump-version.sh` bumps the version before a Claude Code Bash command whose text
contains `vsce package`, `--install-extension` or `esbuild.mjs --production`. HANDOFF said
`npm run package` triggers it. It does not, since the hook never sees the commands npm runs. The
reverse surprise is worse: installing an existing vsix from a Claude Code Bash call matches, so it
moves `package.json` and `node/package.json` while the file being installed keeps the old number.

**Rule:** package with `npm run package` when the version must stay put. Keep those three strings
out of Bash commands that aren't builds, and edit files that contain them, such as the README, with
an editor rather than `echo`.

## macOS and Node 24 (2026-10-11)

Two problems were already there before the split, and they explained most of the red. A file
reached through a symlinked path records 0 steps, and `os.tmpdir()` on macOS is one, so the runtime
tests need `TMPDIR=$(realpath "$TMPDIR")`. Separately, four runtime tests fail on macOS with
Node 24 because they pin the platform's output instead of Tracelight's: one runs `/bin/true`, which
macOS keeps at `/usr/bin/true`, two get the thread name `WorkerThread` where they expect
`Worker 2`, and one expects how `util.inspect` printed a pending Promise before Node 24. Both problems are written up
in [DEVELOPMENT.md](DEVELOPMENT.md#quirks).

**Rule:** compare against `main` before calling a failure new. A test asserts what Tracelight
produces, not how Node formats it.
