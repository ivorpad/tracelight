/**
 * `tour RUN|--live [--goal NAME|FILE:LINE] [--budget TOKENS] [--prose PATH] [--out PATH] [--json]`:
 * chapters and candidate stops of a run, the input a guided tour is picked and narrated from.
 * `--prose` checks a narration against the run and
 * merges it; a rejection lists every problem (`--json`: `violations`) and exits 2.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { NAME } from '../../protocol.ts';
import { registerVerb, type Args } from '../commands.ts';
import { AgentError, SavedRun, type RunSource } from '../source.ts';
import { DEFAULT_BUDGET, buildTour } from '../tour/build.ts';
import { applyProse } from '../tour/prose.ts';
import { renderTour } from '../tour/text.ts';

type Msg = Record<string, any>;

export const PROSE_EXAMPLE = '{"intro": "...", "chapters": {"c1": {"title": "...", "text": "..."}}, "pick": ["s12-ab12cd"], "stops": {"s12-ab12cd": {"title": "...", "text": "..."}}}';

export async function runTour(args: Args, source: RunSource): Promise<Msg> {
  if (args.budget !== null && args.budget !== undefined && args.budget < 1000) throw new AgentError(`--budget ${args.budget} is too small for a tour`, `give at least 1000 tokens; the default is ${DEFAULT_BUDGET}`);
  let run: SavedRun;
  if (source instanceof SavedRun) run = source;
  else {
    if (typeof source.recording !== 'function') throw new AgentError('tour needs a saved run or a live session', `\`${NAME} tour run.json\`, or \`${NAME} tour --live\``);
    const doc = await source.recording();
    run = new SavedRun(String(doc?.meta?.file || 'live-session.json'), doc);
  }
  const full: Record<string, string> = {};
  let tour = buildTour(run, { goal: String(args.goal ?? '').trim() || null, budget: args.budget || DEFAULT_BUDGET, full });
  if (args.prose) {
    let prose: unknown;
    try {
      prose = JSON.parse(readFileSync(String(args.prose), 'utf8'));
    } catch (e) {
      throw new AgentError(`cannot read the prose file ${args.prose}: ${(e as Error).message}`, 'a JSON object: ' + PROSE_EXAMPLE);
    }
    tour = applyProse(tour, prose, full);
  }
  if (args.out) {
    try {
      writeFileSync(String(args.out), JSON.stringify(tour), 'utf8');
    } catch (e) {
      throw new AgentError(`cannot write ${args.out}: ${(e as Error).message}`);
    }
  }
  return tour;
}

registerVerb({
  name: 'tour',
  help: 'chapters and candidate stops of a run, every value from the recording: the input a tour is picked and narrated from (docs/TOUR.md)',
  configure(p) {
    p.addArgument('--goal', { metavar: 'NAME|FILE:LINE', help: "explain this value instead of the program's output: a variable (its last recorded value) or a line (its last pass)" });
    p.addArgument('--budget', { type: 'int', default: DEFAULT_BUDGET, metavar: 'TOKENS', help: `keep the JSON under about this many tokens, at 4 characters a token (default ${DEFAULT_BUDGET})` });
    p.addArgument('--prose', { metavar: 'PATH', help: 'tour.prose.json (picks, titles, text, quotes by range): check it against the run and merge it; a rejection lists every problem and exits 2. Give the same --goal and --budget as the tour the prose was written from' });
    p.addArgument('--out', { metavar: 'PATH', help: 'write the tour, merged with --prose when given, to this file as compact JSON' });
  },
  run: (source, args) => runTour(args, source),
  render: (result, _source, args) => renderTour(result, args.out ?? null).split('\n'),
});
