/** `graph`: the execution graph (Pyokka's `pyokka graph`): nodes, call/tool/data edges; `--dot` for Graphviz. */
import { registerVerb } from '../commands.ts';
import { graph, renderGraph } from '../graph.ts';
import { renderDot } from '../graph_dot.ts';
import type { Args } from '../render.ts';
import { callSource, registerSavedMethod, type RunSource } from '../source.ts';

type Msg = Record<string, any>;

registerSavedMethod('graph', (run, opts: Msg = {}) => graph(run, { allScopes: !!opts.allScopes, scope: opts.scope ?? null, expand: opts.expand ?? null, statements: opts.statements ?? true }));

/** the text form, or with `--dot` the digraph with the stale lines as `//` comments above it */
export function renderGraphVerb(result: Msg, source: RunSource, args: Args): string[] {
  const stale: string[] = args._stale ?? [];
  if (args.dot) return [...stale.map((l) => '// ' + l), ...renderDot(result).split('\n')];
  return [...stale, ...renderGraph(result, source, args)];
}

registerVerb({
  name: 'graph',
  help: 'the execution graph: modules, functions, packages, decisions and statements as nodes; calls, callbacks and data flow as edges',
  configure(p) {
    p.addArgument('--all', { action: 'store_true', help: 'one node per library function instead of one per package' });
    p.addArgument('--scope', { metavar: 'NAME', help: 'only the moments inside calls of this function' });
    p.addArgument('--expand', { action: 'append', default: [], metavar: 'PKG', help: 'unroll this package into its functions (repeatable)' });
    p.addArgument('--no-statements', { dest: 'statements', action: 'store_false', help: 'no statement nodes: only modules, functions, packages and decisions' });
    p.addArgument('--dot', { action: 'store_true', help: 'print a Graphviz digraph instead of the text form' });
  },
  run: (source, args) => callSource(source, 'graph', { allScopes: !!args.all, scope: args.scope ?? null, expand: [...(args.expand ?? [])], statements: args.statements }),
  render: renderGraphVerb,
  ownStale: true,
});
