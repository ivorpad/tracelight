/** `exceptions` and `http`: the run's exceptions report and HTTP table (Pyokka's `pyokka exceptions`, `pyokka http`). */
import { registerVerb } from '../commands.ts';
import { exceptions, renderExceptions } from '../exceptions.ts';
import { httpTable, renderHttp } from '../http.ts';
import { callSource, registerSavedMethod } from '../source.ts';

registerSavedMethod('exceptions', (run) => exceptions(run));
registerSavedMethod('http', (run) =>
  httpTable(run.httpEvents, run.finished.http ?? null, {
    locate: (rid) => {
      const loc = run.locate(rid);
      return loc ? { file: loc.path, line: Number(loc.range[0]), col: Number(loc.range[1]), fileId: loc.fileId } : null;
    },
    runId: run.meta.runId ?? null,
  }),
);

registerVerb({
  name: 'exceptions',
  help: 'every exception the run raised: where, where it was caught, how often; broad handlers flagged',
  run: (source) => callSource(source, 'exceptions'),
  render: (result, source) => renderExceptions(result, source),
});

registerVerb({
  name: 'http',
  help: 'every HTTP request of the run: method, status, the statement that made it (file:line, step), size, time, live / recorded / replayed / miss',
  run: (source) => callSource(source, 'http'),
  render: (result, source) => renderHttp(result, source),
});
