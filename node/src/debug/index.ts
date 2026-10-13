/**
 * Starting a debug run's debugger: the main half (`Debugger`, published as `globalThis.__tk_dbg`
 * for the worker to call) and the worker half (`agent.ts`), connected before the program's first
 * statement so a stop on entry is never missed.
 *
 *     const dbg = await startDebugger(host, request, { ctlFd: 3, eventFd: 4, lock });
 *     // the hooks call dbg.debugger.onStep / onLeave / fileAdded while dbg.debugger.armed
 *     dbg.finished();            // the program ended: requests are served against the finished run
 *
 * The worker owns `ctlFd` from here on; `onExit` is called when the runner sends `exit` (or closes
 * the descriptor), after a paused program has been let go.
 */
import * as inspector from 'node:inspector';
import { createServer } from 'node:net';
import { MessageChannel, Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Debugger, type BreakpointSpec, type DebugHost } from './debugger.ts';
import { newLock } from './wire.ts';
import type { AgentData } from './agent.ts';
import { relayWorkers } from './threads.ts';

export { Debugger } from './debugger.ts';
export type { DebugHost, BreakpointSpec, ScopeEntry } from './debugger.ts';
export type { DebugFile } from './breakpoints.ts';

/** The runtime's own source directory: frames under it are never the program's. */
export const RUNTIME_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))) + path.sep;

export interface DebugRequestConfig {
  debug?: boolean;
  stopOnEntry?: boolean;
  breakOnException?: string;
  /** false: the Debugger, nothing recorded */
  record?: boolean;
  recordFrom?: unknown;
}

/** `config.recordFrom` of a debug run that records (`record` not false): `"pause"`, a breakpoint spec, or null */
export function recordFromOf(config: DebugRequestConfig | undefined): 'pause' | BreakpointSpec | null {
  if (!config?.debug || config.record === false) return null;
  const v = config.recordFrom;
  if (v === 'pause') return 'pause';
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.function === 'string' && o.function.trim()) return { function: o.function, ...(typeof o.path === 'string' ? { path: o.path } : {}) };
    if (typeof o.path === 'string' && Number(o.line) > 0) return { path: o.path, line: Number(o.line) };
  }
  return null;
}

export interface DebugChannel {
  ctlFd?: number;
  eventFd: number;
  lock?: SharedArrayBuffer;
  runtimeRoots?: string[];
  probe?: string;
  /** worker pauses: their step in the merged trace (threads/hub.ts `pauseCell`) */
  pause?: SharedArrayBuffer;
  onExit?: () => void;
}

export interface DebugSession {
  debugger: Debugger;
  worker: Worker;
  lock: SharedArrayBuffer;
  /** the program has ended */
  finished(): void;
  /** hand a request to the worker (when the core reads the control channel itself) */
  request(req: Record<string, unknown>): void;
  close(): Promise<void>;
}

export interface DebugRequest {
  config?: DebugRequestConfig;
  breakpoints?: BreakpointSpec[];
  watch?: { id?: string; exp?: string }[];
  traceContext?: { step?: number; prefetch?: number };
}

/** Does this run request need the debugger: a live one, or only the Time Machine's watch window? */
export function wantsDebugger(request: DebugRequest): 'live' | 'watch' | null {
  if (request.config?.debug || (Array.isArray(request.breakpoints) && request.breakpoints.length)) return 'live';
  if (Array.isArray(request.watch) && request.watch.length && request.traceContext && typeof request.traceContext.step === 'number') return 'watch';
  return null;
}

export async function startDebugger(host: DebugHost, request: DebugRequest, channel: DebugChannel): Promise<DebugSession> {
  const live = wantsDebugger(request) === 'live';
  const dbg = new Debugger(host, {
    debug: live,
    stopOnEntry: request.config?.stopOnEntry,
    breakOnException: live ? request.config?.breakOnException : 'off',
    breakpoints: request.breakpoints,
    watch: request.watch,
    traceContext: request.traceContext,
    recordFrom: live ? recordFromOf(request.config) : null,
  });
  (globalThis as any).__tk_dbg = dbg;
  const lock = channel.lock ?? newLock();
  const workerData: AgentData = {
    ...(process.versions.bun ? { inspectorUrl: await bunInspectorUrl() } : {}),
    ctlFd: channel.ctlFd,
    eventFd: channel.eventFd,
    lock,
    runtimeRoots: [RUNTIME_ROOT, ...(channel.runtimeRoots ?? [])],
    probe: channel.probe,
    pause: channel.pause,
  };
  // a live debugger also stops in the program's worker threads (threads.ts)
  const threadPorts = live ? new MessageChannel() : null;
  if (threadPorts) workerData.threads = threadPorts.port2;
  const worker = new Worker(new URL('./agent.ts', import.meta.url), { workerData, stdout: false, stderr: false, transferList: threadPorts ? [threadPorts.port2] : [] });
  await new Promise<void>((resolve, reject) => {
    const onMessage = (msg: any) => {
      if (msg?.type === 'ready') {
        worker.off('message', onMessage);
        resolve();
      } else if (msg?.type === 'failed') reject(new Error(`the debugger could not start: ${msg.message}`));
    };
    worker.on('message', onMessage);
    worker.once('error', reject);
  });
  const unrelay = threadPorts ? relayWorkers(threadPorts.port1) : () => {};
  worker.on('message', (msg: any) => {
    if (msg?.type === 'exit') channel.onExit?.();
  });
  worker.unref(); // the program's own work decides when it is done; the child stays alive after it by its own means
  return {
    debugger: dbg,
    worker,
    lock,
    finished() {
      dbg.markFinished();
      worker.postMessage({ type: 'finished' });
    },
    request(req) {
      worker.postMessage({ type: 'request', req });
    },
    async close() {
      unrelay();
      await worker.terminate();
    },
  };
}

async function bunInspectorUrl(): Promise<string> {
  if (!inspector.url()) {
    // Bun's inspector.open(0) uses its default port rather than an ephemeral port.
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    inspector.open(port, '127.0.0.1');
  }
  // Bun publishes the URL asynchronously after open(), unlike Node.
  const deadline = Date.now() + 10000;
  do {
    const url = inspector.url();
    if (url) return url;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new Error('Bun did not open its native inspector within 10 seconds');
}
