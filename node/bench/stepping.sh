#!/bin/sh
# Bundle bench/stepping.ts with the host's TraceModel and run it over saved runs: bench/stepping.sh RUN.json...
set -e
here=$(cd "$(dirname "$0")" && pwd)
out=$(mktemp -d)/stepping.mjs
"$here/../../node_modules/.bin/esbuild" "$here/stepping.ts" --bundle --platform=node --format=esm --outfile="$out" --log-level=warning
node "$out" "$@"
