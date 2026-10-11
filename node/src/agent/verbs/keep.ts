/**
 * The verbs that reach the runner `run --keep` left alive (`meta.keep.socket`):
 * `eval`, `expand` and `release`, a request over the keeper's socket, the reply redacted.
 */
import { registerVerb } from '../commands.ts';
import { renderEval, renderExpand, renderRelease } from '../render.ts';
import { AgentError } from '../source.ts';

registerVerb({
  name: 'eval',
  help: 'evaluate a pure expression against the finished run: names, properties, operators and calls that cannot change it, never a function of the program (needs --keep)',
  configure(p) {
    p.addArgument('expression');
    p.addArgument('--frame', { type: 'int', default: null, metavar: 'N', help: 'with --live at a pause: which frame to evaluate in, innermost 0' });
  },
  run: (source, args) => (args.frame ? source.eval(args.expression, { frame: args.frame }) : source.eval(args.expression)),
  render: renderEval,
});

registerVerb({
  name: 'expand',
  help: 'expand a value node of the finished run (needs --keep)',
  configure(p) {
    p.addArgument('value_id', { metavar: 'VALUE_ID' });
    p.addArgument('--path', { action: 'append', default: [], metavar: 'SEGMENT', help: 'queryPath segment (repeatable)' });
  },
  run: (source, args) => source.expand(args.value_id, [...(args.path ?? [])]),
  render: renderExpand,
});

registerVerb({
  name: 'release',
  help: 'shut down the runner kept by `run --keep`',
  run(source) {
    if (typeof source.release !== 'function') throw new AgentError('release shuts down the runner a saved run kept', 'it takes a run.json saved with --keep');
    return source.release();
  },
  render: renderRelease,
});
