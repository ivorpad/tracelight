/** `coverage`: which statements ran, per file; `--file F` lists that file line by line with hit counts (Pyokka's `pyokka coverage`). */
import { registerVerb } from '../commands.ts';
import { coverageReport, renderCoverage } from '../coverage.ts';

registerVerb({
  name: 'coverage',
  help: 'which statements ran: per file the lines that ran, the ones that never did and the partial ones; --file F lists that file line by line with hit counts',
  configure(p) {
    p.addArgument('--file', { metavar: 'F', help: 'also list this file line by line: hits, and which lines did not run (path suffix or basename)' });
  },
  run: (source, args) => coverageReport(source, { file: args.file ?? null }),
  render: (result) => renderCoverage(result),
});
