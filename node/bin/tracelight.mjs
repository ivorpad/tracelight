#!/usr/bin/env node
// Runs the TypeScript sources directly (Node >= 22.18 strips types by default).
import { main } from '../src/cli.ts';

// `... | head`: a closed stdout ends the command quietly
for (const s of [process.stdout, process.stderr]) s.on('error', (e) => (e.code === 'EPIPE' ? process.exit(process.exitCode ?? 0) : undefined));

process.exitCode = await main(process.argv.slice(2));
