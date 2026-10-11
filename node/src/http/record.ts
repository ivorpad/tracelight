/**
 * HTTP observe, record and replay for a run, as Pyokka's http_record plugin, on
 * @mswjs/interceptors: one place that sees `http` / `https` requests (ClientRequest, which axios,
 * got, node-fetch and most SDKs use), `fetch` (undici) and XMLHttpRequest.
 *
 * `off` observes: one `http.exchange` row per request, the program's response untouched. `record`
 * lets every request through and appends each exchange to the recording (the first one replaces
 * the previous file). `replay` answers every request from the recording and never touches the
 * network; a request with no recorded answer is a miss: one `runner.error` per key, a `miss` row
 * per attempt, and a connection error in the program.
 *
 *     const http = installHttp({ mode, file, workspaceRoot, emit, position });   // before the program
 *     ...
 *     Object.assign(runFinished, http.finish());                                // {http, replayed?}
 */
import { ClientRequestInterceptor } from '@mswjs/interceptors/ClientRequest';
import { FetchInterceptor } from '@mswjs/interceptors/fetch';
import { XMLHttpRequestInterceptor } from '@mswjs/interceptors/XMLHttpRequest';
import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.ts';

export type HttpMode = 'off' | 'record' | 'replay';

export interface HttpOptions {
  mode: HttpMode;
  /** the program's main file: the recording is named after it */
  file: string;
  workspaceRoot: string;
  emit(event: Record<string, unknown>): void;
  /** the user statement running now: `{rid, step}`, `rid: -1` when there is none */
  position?(): { rid: number; step: number };
}

export interface HttpSession {
  readonly mode: HttpMode;
  readonly file: string;
  /** `run.finished` fields: `http` and, for replay, `replayed` */
  finish(): Record<string, unknown>;
}

interface Pending {
  n: number;
  client: string;
  started: number;
  rid: number;
  step: number;
  key: string;
  body: Buffer | null;
  method: string;
  url: string;
  headers: [string, string][];
}

const CLIENTS: [new () => any, string][] = [
  [ClientRequestInterceptor, 'http'],
  [FetchInterceptor, 'fetch'],
  [XMLHttpRequestInterceptor, 'xhr'],
];

export function missError(method: string, url: string): Error {
  const err = new Error(`tracelight replay: no recorded response for ${method} ${store.publicUrl(url)}`);
  (err as any).code = 'ECONNREFUSED';
  return err;
}

export function installHttp(opts: HttpOptions): HttpSession {
  const mode = opts.mode;
  let file: string;
  const replay = new Map<string, store.Entry[]>();
  const cursor = new Map<string, number>();
  if (mode === 'record') file = store.recordingPath(opts.workspaceRoot, opts.file);
  else {
    const found = store.findRecording(opts.workspaceRoot, opts.file);
    file = found ?? store.recordingPath(opts.workspaceRoot, opts.file);
    if (found && mode === 'replay') {
      try {
        for (const e of store.loadRecording(found)) {
          const list = replay.get(String(e.key)) ?? [];
          list.push(e);
          replay.set(String(e.key), list);
        }
      } catch (e) {
        opts.emit({ type: 'runner.error', message: `http replay: cannot read ${found}: ${(e as Error).message}` });
      }
    }
  }
  let n = 0;
  let requests = 0;
  let recorded = 0;
  let served = 0;
  const missed = new Set<string>();
  let headerWritten = false;
  let finished = false;
  const pending = new Map<string, Pending>();
  const position = () => {
    try {
      return opts.position?.() ?? { rid: -1, step: -1 };
    } catch {
      return { rid: -1, step: -1 };
    }
  };

  const row = (p: Pending, status: number | null, reason: string | null, bytes: number | null, ms: number, source: string, recordedMs?: number) => {
    const event: Record<string, unknown> = { type: 'http.exchange', n: p.n, client: p.client, method: p.method, url: store.publicUrl(p.url), status, reason, bytes, ms };
    if (recordedMs !== undefined) event.recordedMs = recordedMs;
    Object.assign(event, { source, rid: p.rid, step: p.step });
    requests++;
    opts.emit(event);
  };

  const write = (entry: store.Entry): boolean => {
    const line = JSON.stringify(entry) + '\n';
    try {
      if (!headerWritten) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(store.header(opts.file)) + '\n' + line);
        headerWritten = true;
      } else fs.appendFileSync(file, line);
      recorded++;
      return true;
    } catch (e) {
      opts.emit({ type: 'runner.error', message: `http record: cannot write ${file}: ${(e as Error).message}` });
      return false;
    }
  };

  const interceptors = CLIENTS.map(([Ctor, client]) => {
    const it = new Ctor();
    it.on('request', async ({ request, requestId, controller }: any) => {
      if (finished) return;
      const started = performance.now();
      const { rid, step } = position();
      const body = request.body ? Buffer.from(await request.clone().arrayBuffer()) : null;
      const p: Pending = {
        n: ++n, client, started, rid, step, body, method: request.method, url: request.url,
        key: store.requestKey(request.method, request.url, body), headers: [...request.headers.entries()],
      };
      if (mode !== 'replay') {
        pending.set(requestId, p);
        return; // through to the network
      }
      const entries = replay.get(p.key);
      if (!entries?.length) {
        if (!missed.has(p.key)) {
          missed.add(p.key);
          opts.emit({ type: 'runner.error', message: `no recorded response for ${p.method} ${store.publicUrl(p.url)}; run once in record mode (${file})` });
        }
        row(p, null, null, null, Math.round(performance.now() - started), 'miss');
        controller.errorWith(missError(p.method, p.url));
        return;
      }
      const i = cursor.get(p.key) ?? 0;
      cursor.set(p.key, i + 1);
      served++;
      const entry = entries[Math.min(i, entries.length - 1)]!;
      const resp = entry.response;
      const chunks = store.entryChunks(resp);
      const status = Number(resp.status) || 200;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          for (const chunk of chunks) c.enqueue(new Uint8Array(chunk));
          c.close();
        },
      });
      const nullBody = status === 204 || status === 205 || status === 304 || p.method === 'HEAD';
      controller.respondWith(new Response(nullBody ? null : stream, { status, statusText: store.reasonPhrase(status, resp.reason), headers: resp.headers }));
      row(p, status, store.reasonPhrase(status, resp.reason), chunks.reduce((a, c) => a + c.length, 0), Math.round(performance.now() - started), 'replayed', entry.elapsedMs);
    });
    it.on('response', async ({ response, requestId, responseType }: any) => {
      const p = pending.get(requestId);
      if (!p || responseType === 'mock') return;
      pending.delete(requestId);
      const status = response.status;
      const reason = store.reasonPhrase(status, response.statusText);
      if (mode === 'off') {
        row(p, status, reason, store.declaredLength(response.headers.get('content-length')), Math.round(performance.now() - p.started), 'live');
        return;
      }
      const chunks: Buffer[] = [];
      try {
        const reader = response.clone().body?.getReader();
        if (reader) for (let r = await reader.read(); !r.done; r = await reader.read()) chunks.push(Buffer.from(r.value));
      } catch {
        /* the program cancelled the body: what arrived is kept */
      }
      const ms = Math.round(performance.now() - p.started);
      const prepared = store.prepareResponse(response.headers.entries(), chunks, p.client === 'fetch');
      const entry: store.Entry = {
        n: p.n, key: p.key, client: p.client,
        request: store.requestEntry(p.method, p.url, p.headers, p.body),
        response: store.responseEntry(status, reason, prepared.headers, prepared.chunks),
        elapsedMs: ms,
      };
      const ok = write(entry);
      row(p, status, reason, chunks.reduce((a, c) => a + c.length, 0), ms, ok ? 'recorded' : 'live');
    });
    it.apply();
    return it;
  });

  return {
    mode,
    file,
    finish() {
      if (!finished) {
        finished = true;
        for (const it of interceptors) it.dispose();
      }
      const http: Record<string, unknown> = { mode, requests, recorded, served, misses: missed.size, file, ...store.recordingInfo(file) };
      return mode === 'replay' ? { http, replayed: true } : { http };
    },
  };
}
