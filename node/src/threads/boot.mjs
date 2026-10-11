// The preload a recorded worker starts with (threads/hub.ts). Plain JavaScript, so the worker does
// not start TypeScript's type stripper for the runtime: the main thread hands over the runtime's
// modules already stripped, and a load hook serves them. Then threads/worker.ts (synchronously,
// so an `eval: true` worker can `require` this file too).
import { createRequire, registerHooks } from 'node:module';
import wt from 'node:worker_threads';

const setup = wt.workerData && typeof wt.workerData === 'object' ? wt.workerData.__tracelight_thread__ : undefined;
if (setup && Array.isArray(setup.runtime) && !globalThis.__tracelight_boot__) {
  globalThis.__tracelight_boot__ = true;
  const stripped = new Map(setup.runtime);
  registerHooks({
    load(url, context, nextLoad) {
      const source = stripped.get(url);
      return source === undefined ? nextLoad(url, context) : { format: 'module', source, shortCircuit: true };
    },
  });
}
createRequire(import.meta.url)('./worker.ts');
