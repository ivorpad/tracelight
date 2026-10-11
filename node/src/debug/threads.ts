/**
 * The program's worker threads, main half: a same-thread `node:inspector` session holding the
 * `NodeWorker` domain, relayed to the debugger worker over a `MessagePort`.
 *
 * The debugger worker's own session (`connectToMainThread`) is told about the workers that exist
 * when it enables `NodeWorker`, never about one started later, so the domain lives here, on the
 * thread that starts them. Workers start held (`waitForDebuggerOnStart`) until the debugger worker
 * has set their breakpoints and lets them run. The relay needs this thread's event loop: while
 * the main thread is held at a pause, worker messages wait, which is why a worker's pause is
 * only ever served while the main thread runs (agent.ts).
 *
 *     port -> {op: 'send', sessionId, message}
 *     port <- {op: 'attached', sessionId, workerInfo, waitingForDebugger} | {op: 'detached', sessionId}
 *           | {op: 'message', sessionId, message}
 */
import { Session } from 'node:inspector';
import type { MessagePort } from 'node:worker_threads';

export function relayWorkers(port: MessagePort): () => void {
  const session = new Session();
  session.connect();
  session.on('NodeWorker.attachedToWorker', ({ params }) => port.postMessage({ op: 'attached', ...params }));
  session.on('NodeWorker.detachedFromWorker', ({ params }) => port.postMessage({ op: 'detached', sessionId: params.sessionId }));
  session.on('NodeWorker.receivedMessageFromWorker', ({ params }) => port.postMessage({ op: 'message', sessionId: params.sessionId, message: params.message }));
  port.on('message', (m: any) => {
    if (m?.op === 'send') session.post('NodeWorker.sendMessageToWorker', { sessionId: m.sessionId, message: m.message }, () => {});
  });
  port.unref();
  session.post('NodeWorker.enable', { waitForDebuggerOnStart: true }, () => {});
  return () => {
    try {
      session.disconnect();
    } catch {
      /* already gone */
    }
    port.close();
  };
}
