// Prepare source with Node's whitespace-preserving stripper; the program executes in Bun.
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';
try {
  process.stdout.write(stripTypeScriptTypes(readFileSync(0, 'utf8'), {mode:'strip'}));
} catch (error) {
  process.stdout.write(JSON.stringify({message:error.message, code:error.code}));
  process.exitCode = 1;
}
