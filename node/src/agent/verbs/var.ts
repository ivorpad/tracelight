/**
 * `var`: every recorded change of a variable, with the statement that made it and what it read.
 * The statements that assign a name come from the JavaScript AST
 * (`bindings.ts`), so a run without recorded locals still lists every assignment that ran.
 */
import { registerVerb } from '../commands.ts';
import { renderVar } from '../render.ts';

registerVerb({
  name: 'var',
  help: 'every recorded change of a variable: step, file:line, function, the new value, what the statement read',
  configure(p) {
    p.addArgument('name', { metavar: 'NAME', help: 'a name or property path (total, this.balance, r.output.date); paths under it match too' });
    p.addArgument('--file', { metavar: 'F', help: 'only changes in this file (path suffix or basename)' });
    p.addArgument('--scope', { metavar: 'NAME', help: 'only changes inside this function' });
    p.addArgument('--limit', { type: 'int', default: 200, metavar: 'K', help: 'at most this many changes (default 200)' });
  },
  run: (source, args) => source.var(args.name, { file: args.file, scope: args.scope, limit: Math.max(1, args.limit) }),
  render: renderVar,
});
