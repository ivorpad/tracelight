/** `find`: search values, errors, output and the lines that ran. */
import { registerVerb } from '../commands.ts';
import { renderFind } from '../render.ts';

registerVerb({
  name: 'find',
  help: 'search values, errors, output and the lines that ran',
  configure(p) {
    p.addArgument('text');
    p.addArgument('--limit', { type: 'int', default: 50 });
  },
  run: (source, args) => source.find(args.text, args.limit),
  render: renderFind,
});
