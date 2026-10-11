/** `steps`: list steps, number, file:line, function. */
import { parseLine, registerVerb } from '../commands.ts';
import { renderSteps } from '../render.ts';

registerVerb({
  name: 'steps',
  help: 'list steps: number, file:line, function',
  configure(p) {
    p.addArgument('--from', { dest: 'start', type: 'int', default: 0, metavar: 'N' });
    p.addArgument('--count', { type: 'int', default: 40, metavar: 'K' });
    p.addArgument('--line', { metavar: 'F:L', help: 'every step on this line' });
  },
  run: (source, args) => source.steps({ start: args.start, count: args.count, line: args.line ? parseLine(args.line) : null }),
  render: renderSteps,
});
