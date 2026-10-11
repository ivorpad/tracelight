/** `story`: the Code Story, the lines that ran, in order, one block per scope. */
import { parseLine, registerVerb } from '../commands.ts';
import { renderStory } from '../render.ts';

registerVerb({
  name: 'story',
  help: 'the Code Story: the lines that ran, in order, one block per scope',
  configure(p) {
    const g = p.group();
    p.addArgument('--file', { metavar: 'F', help: 'only blocks in this file (path suffix or basename)' }, g);
    p.addArgument('--scope', { metavar: 'NAME', help: 'only blocks of this function' }, g);
    p.addArgument('--line', { metavar: 'F:L', help: 'only blocks that ran this line' }, g);
    p.addArgument('--limit', { type: 'int', default: 150, metavar: 'LINES', help: 'text: stop after this many lines (default 150)' });
  },
  run: (source, args) => source.story({ file: args.file, scope: args.scope, line: args.line ? parseLine(args.line) : null, limit: Math.max(1, args.limit) }),
  render: renderStory,
});
