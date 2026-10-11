/**
 * `history`: the data behind a code-history page: the source each
 * checkpoint needs, the values as of it, and the command that reproduces them. The document is
 * `codehistory.ts`; this module is the arguments and the text form (`render_history`).
 */
import { checkpointAction, writeHistory } from '../codehistory.ts';
import { isLive, registerVerb } from '../commands.ts';
import type { Args } from '../render.ts';
import type { RunSource } from '../source.ts';

type Msg = Record<string, any>;

export function renderHistory(result: Msg, _source: RunSource, _args: Args): string[] {
  const out: string[] = (result.warnings ?? []).map((w: string) => `warning: ${w}`);
  out.push(...(result.truncated ?? []).map((t: string) => `left out: ${t} (--limit raises it)`));
  const prosed = Math.trunc(Number(result.prosed || 0));
  const added = result.added;
  const how = added === null || added === undefined || added === result.checkpoints ? 'wrote' : `added ${added} to`;
  out.push(`${how} ${result.path}: ${result.checkpoints} checkpoints over ${(result.files ?? []).join(', ') || 'no file'}${prosed ? `, ${prosed} with prose` : ''}`);
  const path = String(result.path);
  const stem = path.replace(/(?<=[^/.][^/]*)\.[^./]*$/, '');
  out.push(`fill the prose, then render: node skills/tracelight/scripts/render-code-history.cjs ${path} ${stem}.html`);
  return out;
}

registerVerb({
  name: 'history',
  help: 'the data behind a code-history page: the source each checkpoint needs, the values as of it, and the command that reproduces them',
  configure(p) {
    p.addArgument('--at', { action: checkpointAction, dest: 'checkpoints', metavar: 'STEP|FILE:LINE', help: 'a checkpoint at this step, or at the first step on this line (repeatable)' });
    p.addArgument('--var', { action: checkpointAction, dest: 'checkpoints', metavar: 'NAME', help: 'a checkpoint per recorded change of NAME, in step order (repeatable)' });
    p.addArgument('--why', { action: checkpointAction, dest: 'checkpoints', nargs: 2, metavar: ['STEP', 'NAME'], help: 'a checkpoint for the provenance chain of NAME after STEP (repeatable)' });
    p.addArgument('--pause', { action: checkpointAction, dest: 'checkpoints', nargs: 0, help: "with --live: a checkpoint from the debug session's current pause, read without moving it" });
    p.addArgument('--out', { required: true, metavar: 'PATH', help: 'where the data JSON goes' });
    p.addArgument('--prose', { metavar: 'PATH', help: 'a JSON file whose prose fields are merged in; it may not set a generated field' });
    p.addArgument('--pad', { type: 'int', default: 2, metavar: 'N', help: 'source lines of dim context above and below each block (default 2)' });
    p.addArgument('--limit', { type: 'int', default: 20, metavar: 'K', help: 'most checkpoints one --var may produce (default 20)' });
    p.addArgument('--lang', { default: 'en', metavar: 'L', help: "the page's language: its lang attribute and the words the page draws, en or es (default en)" });
    p.addArgument('--scope', { action: 'store_true', help: 'lift the 60-line block cap on every checkpoint' });
    p.addArgument('--append', { action: 'store_true', help: 'add these checkpoints to the page at --out instead of replacing it, for a second live pause' });
    p.addArgument('--value-chars', { type: 'int', default: null, metavar: 'N', help: 'characters of one value on a card (default: what the run kept, its --max-value-chars, 200 when it does not say; 0 shows every value whole)' });
  },
  run: (source, args) => writeHistory(source, args, isLive(args) ? `--live${args.session ? ` --session ${args.session}` : ''}` : String(args.run)),
  render: renderHistory,
});
