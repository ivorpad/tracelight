/**
 * `narrate`: ask a model for one sentence of gloss per walkthrough moment and store it in the
 * saved run (never automatic). The work is `narrate.ts`; `walkthrough`
 * shows the glosses afterwards (`meta.walkthroughGloss`).
 */
import { basename } from 'node:path';
import { NAME } from '../../protocol.ts';
import { registerVerb } from '../commands.ts';
import { narrateSaved } from '../narrate.ts';
import type { Args } from '../render.ts';
import { AgentError, SavedRun, type RunSource } from '../source.ts';

type Msg = Record<string, any>;

export function renderNarrate(result: Msg, _source: RunSource, _args: Args): string[] {
  if (result.prompt !== null && result.prompt !== undefined) return [result.prompt];
  if (result.error) return [`narration failed: ${result.error}`, `the walkthrough keeps gloss: null; ${result.hint || ''}`];
  return [`${result.glossed} of ${result.moments} moments glossed by ${result.backend}, written to ${result.path}`, `\`${NAME} walkthrough ${basename(String(result.path))}\` shows them`];
}

registerVerb({
  name: 'narrate',
  help: 'ask a model for one sentence of gloss per walkthrough moment and store it in the saved run (never automatic)',
  configure(p) {
    p.addArgument('--command', { dest: 'model_command', metavar: 'CMD', default: null, help: 'the model command (prompt on stdin, answer on stdout); default: claude -p, else codex exec' });
    p.addArgument('--dry-run', { action: 'store_true', help: 'print the prompt instead of running the command' });
  },
  run(source, args) {
    if (!(source instanceof SavedRun)) throw new AgentError('narrate writes the glosses into a saved run', `save one with \`${NAME} run FILE --save run.json\`; the panel's Narrate button does the same for a live session`);
    return narrateSaved(source, { command: args.model_command ?? null, dryRun: !!args.dry_run });
  },
  render: renderNarrate,
});
