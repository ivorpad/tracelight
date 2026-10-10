/** `context`: the context slice at step N, or at the first step of `--line F:L`. */
import { AgentError } from '../source.ts';
import { isLive, parseLine, registerVerb } from '../commands.ts';
import { renderContext } from '../render.ts';

registerVerb({
  name: 'context',
  help: 'the context slice at step N (or at the first step of --line F:L)',
  configure(p) {
    p.addArgument('step', { type: 'int', nargs: '?', metavar: 'N' });
    p.addArgument('--line', { metavar: 'F:L' });
    p.addArgument('--scope', { action: 'store_true', help: 'lift the 60-line / 20-value caps' });
  },
  run(source, args) {
    if ((args.step === null || args.step === undefined) && !args.line && !isLive(args)) throw new AgentError('context needs a step number or --line FILE:LINE', 'e.g. `context 12` or `context --line agent.ts:16`; with --live the current step is implied');
    const [file, line] = args.line ? parseLine(args.line) : [null, null];
    return source.context({ step: args.step ?? null, file, line, scope: !!args.scope });
  },
  render: renderContext,
});
