/** `walkthrough`: what happened, in order, one moment per line (Pyokka's `pyokka walkthrough`). */
import { callSource, registerSavedMethod, type RunSource } from '../source.ts';
import { registerVerb } from '../commands.ts';
import { oneLine, type Args } from '../render.ts';
import { walkthrough } from '../walkthrough.ts';

type Msg = Record<string, any>;

export const WALK_LINE = 100;
export const WALK_VALUES = 8;

registerSavedMethod('walkthrough', (run, opts: Msg = {}) => walkthrough(run, opts));

/** a line of at most `limit` characters, its leading indent kept */
export function walkLine(text: string, limit = WALK_LINE): string {
  const indent = text.length - text.replace(/^ +/, '').length;
  return ' '.repeat(indent) + oneLine(text, limit - indent);
}

export function renderWalkthrough(result: Msg, _source: RunSource, _args: Args): string[] {
  let head = `${result.total} moments over ${result.count} steps`;
  if (result.shown < result.total) head += ` (showing ${result.shown})`;
  const out = [head];
  if (!result.moments.length) {
    out.push('nothing ran; `state` says what the run is');
    return out;
  }
  for (const m of result.moments) {
    out.push(walkLine(`#${m.step}  ${m.text}`));
    if (m.gloss) out.push(walkLine(`      ${m.gloss}`));
    const values = (m.values ?? []).filter((v: Msg) => v.role !== 'value'); // a value moment's sentence already says `name = text`
    for (const v of values.slice(0, WALK_VALUES)) out.push(walkLine(`      ${v.role} ${v.name} = ${v.text}`));
    if (values.length > WALK_VALUES) out.push(`      … ${values.length - WALK_VALUES} more (--json lists them)`);
    if (m.more) out.push(`      ≡ ${m.more} more ${m.kind === 'call' || m.kind === 'tool' ? 'calls' : 'values'} like this`);
  }
  if (result.truncated) out.push(`… ${result.total - result.shown} more moments; narrow with --from N --to M, --scope NAME or --file F`);
  return out;
}

registerVerb({
  name: 'walkthrough',
  help: 'what happened, in order: one moment per line with the step number and the values that mattered',
  configure(p) {
    p.addArgument('--file', { metavar: 'F', help: 'only moments in this file (path suffix or basename)' });
    p.addArgument('--scope', { metavar: 'NAME', help: 'only moments inside calls of this function' });
    p.addArgument('--from', { dest: 'start', type: 'int', default: null, metavar: 'N', help: 'first step of the window (with --to: no cap)' });
    p.addArgument('--to', { dest: 'end', type: 'int', default: null, metavar: 'M', help: 'last step of the window' });
    p.addArgument('--all', { action: 'store_true', help: 'one moment per library call instead of one per user-code call site' });
  },
  run: (source, args) => callSource(source, 'walkthrough', { file: args.file ?? null, scope: args.scope ?? null, start: args.start ?? null, end: args.end ?? null, allScopes: !!args.all }),
  render: renderWalkthrough,
});
