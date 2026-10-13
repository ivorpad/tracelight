#!/usr/bin/env node
// Runs the TypeScript sources directly (Node >= 22.18 strips types by default).
// Check before loading Node-only tracing modules, so Bun gets a runtime-selection error.
if (process.versions.bun) {
  process.stderr.write('Tracelight CLI and protocol server run on Node. Select native Bun for the program with run --node bun or web --runtime bun.\n');
  process.exit(1);
}
const { main } = await import('../src/cli.ts');

// `... | head`: a closed stdout ends the command quietly
for (const s of [process.stdout, process.stderr]) s.on('error', (e) => (e.code === 'EPIPE' ? process.exit(process.exitCode ?? 0) : undefined));

process.exitCode = await main(process.argv.slice(2));
