/**
 * `step`: move from step N and show the context at the new step (Pyokka's `pyokka step`).
 * Over a saved run the moves are the Time Machine's; `--count` is a live-only move at a debug pause.
 */
import { AgentError } from '../source.ts';
import { isLive, registerVerb } from '../commands.ts';
import { renderStop } from '../render.ts';

export const MOVE_FLAGS: [string, string][] = [['--into', 'into'], ['--over', 'over'], ['--out', 'out'], ['--back', 'back'], ['--back-over', 'backOver'], ['--back-out', 'backOut']];

/** `step`'s direction from its flags */
export function moveKind(args: Record<string, any>): string | null {
  return MOVE_FLAGS.find(([flag]) => args[flag.slice(2).replace(/-/g, '_')])?.[1] ?? null;
}

registerVerb({
  name: 'step',
  help: 'move from step N and show the context at the new step (live at a debug pause: --into/--over/--out run the program to the next stop)',
  configure(p) {
    p.addArgument('step', { type: 'int', nargs: '?', metavar: 'N', help: 'the step to move from (omit with --live: the current step; the first --into starts the Time Machine)' });
    const g = p.group(true);
    for (const [flag] of MOVE_FLAGS) p.addArgument(flag, { action: 'store_true' }, g);
    p.addArgument('--to', { type: 'int', metavar: 'M', help: 'jump to step M' }, g);
    p.addArgument('--count', { type: 'int', default: null, metavar: 'N', help: 'live at a pause: take N steps in a row and print the last stop (1..1000); a breakpoint or an exception on the way wins and is reported' });
    p.addArgument('--scope', { action: 'store_true', help: 'the whole block and every value (lifts the 60-line / 20-value caps)' });
  },
  run(source, args) {
    const kind = moveKind(args);
    if ((args.step === null || args.step === undefined) && !isLive(args)) throw new AgentError('step needs N, the step to move from', 'e.g. `step run.json 12 --into`; with --live the current step is implied');
    // `--count N` is a live-only move: a saved run is navigated one step at a time
    const extra = args.count && isLive(args) ? { count: args.count } : {};
    return source.step(args.step ?? null, { kind, to: args.to ?? null, scope: !!args.scope, ...extra });
  },
  render: renderStop,
});
