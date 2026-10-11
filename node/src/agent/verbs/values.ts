/** `values`: every value logged on a line, by hit (Pyokka's `pyokka values`). */
import { parseLine, registerVerb } from '../commands.ts';
import { renderValues } from '../render.ts';

registerVerb({
  name: 'values',
  help: 'every value logged on a line, by hit',
  configure(p) {
    p.addArgument('--line', { required: true, metavar: 'F:L' });
  },
  run(source, args) {
    const [file, line] = parseLine(args.line);
    return source.values(file, line);
  },
  render: renderValues,
});
