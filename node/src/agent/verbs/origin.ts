/**
 * `origin`: where a bad value was made: the chain of steps from the failing statement back across
 * calls and containers, its root marked (Pyokka's `pyokka origin`). The walk is `origin/`.
 */
import { pyRepr } from '../argparse.ts';
import { isLive, registerVerb } from '../commands.ts';
import { origin } from '../origin/index.ts';
import { renderOrigin } from '../origin/text.ts';
import { ORIGIN_DEPTH, ORIGIN_MAX_DEPTH } from '../origin/walk.ts';
import { AgentError, callSource, registerSavedMethod, type SavedRun } from '../source.ts';

const NEEDS_STEP = 'origin needs STEP, the step of the failing statement';
const NEEDS_STEP_HINT = 'e.g. `origin run.json 64`; `exceptions run.json` lists the steps where exceptions were raised';

registerSavedMethod('origin', (run: SavedRun, step: number | null, expr = '', opts: { depth?: number } = {}) => {
  if (step === null || step === undefined) throw new AgentError(NEEDS_STEP, NEEDS_STEP_HINT);
  const out = origin(run, run.checkStep(step), expr, opts.depth ?? ORIGIN_DEPTH);
  out.stale = run.staleFiles().length > 0;
  out.staleFiles = run.staleFiles();
  return out;
});

registerVerb({
  name: 'origin',
  help: 'where a bad value was made: the chain of steps from the failing statement back across calls and containers, its root marked',
  configure(p) {
    p.addArgument('step', { nargs: '?', metavar: 'STEP', help: "the step of the failing statement, e.g. an exception's step (omit with --live: the Time Machine's step)" });
    p.addArgument('name', { nargs: '?', metavar: 'EXPR', help: 'the value to follow: a name or a property path of one (items[0].price); omit it to take the value the exception at STEP is about' });
    p.addArgument('--depth', { type: 'int', default: ORIGIN_DEPTH, metavar: 'N', help: `at most this many links (default ${ORIGIN_DEPTH}, at most ${ORIGIN_MAX_DEPTH})` });
    p.setDefaults({ _words: ['step', 'name'] });
  },
  run(source, args) {
    if ((args.step === null || args.step === undefined) && !isLive(args)) throw new AgentError(NEEDS_STEP, NEEDS_STEP_HINT);
    if (args.step !== null && args.step !== undefined && !/^\d+$/.test(String(args.step).replace(/^-+/, ''))) throw new AgentError(`STEP must be a step number, got ${pyRepr(String(args.step))}`, 'e.g. `origin run.json 64 items`: the step first, then the expression');
    const depth = Math.max(2, Math.min(ORIGIN_MAX_DEPTH, Math.trunc(args.depth)));
    return callSource(source, 'origin', args.step !== null && args.step !== undefined ? parseInt(String(args.step), 10) : null, String(args.name ?? '').trim(), { depth });
  },
  render: renderOrigin,
});
