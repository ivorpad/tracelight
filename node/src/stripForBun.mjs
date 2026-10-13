// Prepare source with Node's whitespace-preserving stripper; the program executes in Bun.
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';
process.stdout.write(stripTypeScriptTypes(readFileSync(0, 'utf8'), {mode:'strip'}));
