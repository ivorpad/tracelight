/**
 * `diff`: what an edit changed, two runs compared statement by statement.
 * Opens its own pair: two saved runs, or one saved run (the before) and `--live` (the open VS Code
 * session as the after).
 */
import { getVerb, openSource, registerVerb } from '../commands.ts';
import { diffCommand, openPair, renderDiff } from '../diff.ts';

registerVerb({
  name: 'diff',
  help: "what an edit changed: two runs compared statement by statement (values, branches, loops, calls, prints, raises), with each side's step numbers",
  common: 'none',
  configure(p) {
    p.addArgument('runs', { metavar: 'RUN', nargs: '*', help: 'the before and the after run.json; with --live only the before, and the open VS Code session is the after' });
    p.addArgument('--json', { action: 'store_true', help: 'print the raw JSON shape' });
    p.addArgument('--live', { action: 'store_true', help: 'the open VS Code session is the after (setting tracelight.agentAccess)' });
    p.addArgument('--session', { metavar: 'NAME|PATH', help: "with --live: the session's file name or descriptor path, when more than one is open" });
    p.addArgument('--limit', { type: 'int', default: 40, metavar: 'K', help: 'at most this many statements (default 40)' });
    p.addArgument('--ignore', { action: 'append', default: [], metavar: 'NAME', help: 'ignore value or log facts with this exact name (repeatable); decisions and errors remain compared' });
    p.setDefaults({ run: null });
  },
  // the live session is opened the way `walkthrough --live` opens it
  open: (args) => openPair(args, (file) => openSource(getVerb('walkthrough')!, { command: 'walkthrough', run: null, live: true, session: args.session ?? null, file, line: null, json: !!args.json })) as any,
  run: (source, args) => diffCommand(args, source),
  render: (result) => renderDiff(result),
});
