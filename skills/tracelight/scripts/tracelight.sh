#!/bin/sh
# The tracelight CLI. In a checkout (skills/tracelight/scripts -> ../../../node/bin) it runs that
# source with node; a copy the extension installed has no checkout next to it, so it runs the
# `tracelight` on PATH or in ~/.local/bin, else the newest installed extension's dist/node/bin.
# Works through a symlinked install. `$TRACELIGHT_NODE` picks the node binary that runs the CLI.
here=$(cd "$(dirname "$(realpath "$0")")" && pwd)
node=${TRACELIGHT_NODE:-node}
# Node 22.15-22.17 strip TypeScript only behind the flag; later versions accept it and do it anyway.
flags="--experimental-strip-types --disable-warning=ExperimentalWarning"
bin="$here/../../../node/bin/tracelight.mjs"
# shellcheck disable=SC2086
if [ -f "$bin" ]; then exec "$node" $flags "$bin" "$@"; fi
if command -v tracelight >/dev/null 2>&1; then exec tracelight "$@"; fi
if [ -x "$HOME/.local/bin/tracelight" ]; then exec "$HOME/.local/bin/tracelight" "$@"; fi
for dir in "$HOME/.vscode/extensions" "$HOME/.vscode-insiders/extensions" "$HOME/.cursor/extensions" "$HOME/.vscode-server/extensions"; do
  ext=$(ls -d "$dir"/ivor.tracelight-* 2>/dev/null | sort -V | tail -n 1)
  [ -n "$ext" ] || continue
  bin="$ext/dist/node/bin/tracelight.mjs"
  # shellcheck disable=SC2086
  if [ -f "$bin" ]; then exec "$node" $flags "$bin" "$@"; fi
done
echo "tracelight.sh: no checkout next to this skill, no tracelight on PATH or in ~/.local/bin, and no ivor.tracelight extension with dist/node/bin. Install the Tracelight extension in VS Code and turn on tracelight.agentAccess." >&2
exit 127
