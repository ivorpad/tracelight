/**
 * `tracelight mcp --http`: the same tools as `tracelight mcp` over MCP's Streamable HTTP transport
 * (protocol 2025-03-26 and later), plus the older HTTP+SSE transport (2024-11-05) for clients that
 * only speak that. Stdlib `node:http`, no SDK; every message goes through `handle` in server.ts.
 *
 * - `POST /mcp` takes one JSON-RPC message or a batch. Notifications and responses alone get 202.
 *   Requests are answered on an SSE stream when the client accepts `text/event-stream` (a
 *   `tools/call` carrying `_meta.progressToken` gets `notifications/progress` while it runs), else
 *   as one JSON body. `initialize` mints the `Mcp-Session-Id` every later request must carry:
 *   missing is 400, unknown or ended is 404, so the client initializes again.
 * - `GET /mcp` opens the session's server-to-client stream; Tracelight sends nothing on it but
 *   keepalive comments. `DELETE /mcp` ends the session.
 * - `GET /sse` opens a legacy stream whose first event names `/messages?sessionId=…`; requests
 *   POSTed there get 202 and their replies arrive on the stream.
 *
 * The tools run programs (`tracelight_run`, `exec`, live `eval`), so the server binds loopback by
 * default, refuses a browser Origin or Host header that is not loopback (DNS rebinding), and will
 * not bind another interface without a bearer token. Calls that drive a live debugger or the
 * browser page run one at a time (`exclusiveCall`); reads of saved runs run side by side.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { NAME, RUNTIME_VERSION } from '../protocol.ts';
import { exclusiveCall, handle, PROTOCOL_VERSIONS } from './server.ts';
import { closePages } from './page.ts';

type Msg = Record<string, any>;

export const DEFAULT_MCP_PORT = 4787;
const MAX_BODY = 4 * 1024 * 1024;
const KEEPALIVE_MS = 15_000;
const PROGRESS_MS = 5_000;
/** a session nobody has used for this long is forgotten; its client gets 404 and initializes again */
const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;

export interface HttpOptions {
  port: number;
  host: string;
  /** `Authorization: Bearer TOKEN` on every request; required to bind a non-loopback host */
  token?: string;
  log?: (line: string) => void;
  /** how often a call with a progress token reports, in ms (default 5,000) */
  progressMs?: number;
  /** exit once this file changes (the extension rewrote its `tracelight` command), for launchd or systemd to start the new version */
  restartOnChange?: string;
}

interface Session {
  id: string;
  protocolVersion: string;
  lastSeen: number;
  /** open SSE responses: `GET /mcp` streams, or the legacy `/sse` stream */
  streams: Set<ServerResponse>;
  legacy: boolean;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLoopback(host: string): boolean {
  const h = host.toLowerCase();
  return LOOPBACK.has(h) || /^127(\.\d{1,3}){3}$/.test(h) || h.endsWith('.localhost');
}

/** the hostname of a Host header (`127.0.0.1:4787`, `[::1]:4787`) */
function hostName(header: string): string {
  if (header.startsWith('[')) return header.slice(0, header.indexOf(']') + 1);
  const i = header.lastIndexOf(':');
  return i > 0 && header.indexOf(':') === i ? header.slice(0, i) : header;
}

function rpcError(id: unknown, code: number, message: string): Msg {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendStatus(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, headers);
  res.end();
}

function openStream(res: ServerResponse, headers: Record<string, string> = {}): () => void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...headers });
  res.flushHeaders();
  const timer = setInterval(() => { if (!res.writableEnded) res.write(': keepalive\n\n'); }, KEEPALIVE_MS);
  timer.unref();
  const stop = (): void => clearInterval(timer);
  res.on('close', stop);
  return stop;
}

let eventId = 0;
function writeEvent(res: ServerResponse, data: unknown, event = 'message'): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\nid: ${++eventId}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** what the client takes: SSE, JSON, or neither (406). A missing Accept header takes either. */
function accepts(req: IncomingMessage): { sse: boolean; json: boolean } {
  const accept = String(req.headers.accept ?? '').toLowerCase();
  if (!accept) return { sse: false, json: true };
  const any = accept.includes('*/*');
  return { sse: accept.includes('text/event-stream'), json: any || accept.includes('application/json') };
}

const isRequest = (m: unknown): m is Msg => !!m && typeof m === 'object' && !Array.isArray(m) && typeof (m as Msg).method === 'string' && 'id' in (m as Msg);

/** One message through `handle`, holding the exclusive lock for calls that drive something live. */
async function answer(msg: Msg, progress?: (elapsed: number) => void, every = PROGRESS_MS): Promise<Msg | null> {
  const run = (): Promise<Msg | null> => handle(msg);
  if (msg?.method !== 'tools/call' || typeof msg.params?.name !== 'string') return run();
  let timer: NodeJS.Timeout | undefined;
  if (progress) {
    const started = Date.now();
    timer = setInterval(() => progress(Math.round((Date.now() - started) / 100) / 10), every);
    timer.unref();
  }
  try {
    return await exclusiveCall(msg.params.name, msg.params.arguments ?? {}, run);
  } finally {
    if (timer) clearInterval(timer);
  }
}

export class McpHttpServer {
  readonly sessions = new Map<string, Session>();
  private servers: Server[] = [];
  private sweeper?: NodeJS.Timeout;
  private log: (line: string) => void;
  private opts: HttpOptions;

  constructor(opts: HttpOptions) {
    this.opts = opts;
    this.log = opts.log ?? ((line) => process.stderr.write(line + '\n'));
  }

  /** Listen; resolves with the bound port (0 asks the system for one). */
  async listen(): Promise<number> {
    const { host, token } = this.opts;
    if (!isLoopback(host) && !token) throw new Error(`refusing to serve the MCP tools on ${host} without --token: they run programs on this machine. Bind 127.0.0.1, or pass --token T and send \`Authorization: Bearer T\``);
    // 127.0.0.1 also takes ::1, since a client given `localhost` may try IPv6 first
    const hosts = host === '127.0.0.1' ? ['127.0.0.1', '::1'] : [host];
    let port = this.opts.port;
    for (const h of hosts) {
      const server = createServer((req, res) => void this.onRequest(req, res));
      try {
        port = await new Promise<number>((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, h, () => resolve((server.address() as { port: number }).port));
        });
        this.servers.push(server);
      } catch (e) {
        if (!this.servers.length) throw e;
        // the second loopback address is optional: an IPv4-only machine has no ::1
      }
    }
    this.sweeper = setInterval(() => this.sweep(), 10 * 60 * 1000);
    this.sweeper.unref();
    return port;
  }

  async close(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    for (const s of this.sessions.values()) for (const r of s.streams) r.end();
    this.sessions.clear();
    await Promise.all(this.servers.map((s) => new Promise<void>((resolve) => { s.closeAllConnections?.(); s.close(() => resolve()); })));
    this.servers = [];
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) if (!s.streams.size && now - s.lastSeen > SESSION_IDLE_MS) this.sessions.delete(id);
  }

  /** 401 / 403 before anything else, or null when the request may go on */
  private refuse(req: IncomingMessage): [number, string] | null {
    const { token } = this.opts;
    if (token) {
      if (req.headers.authorization !== `Bearer ${token}`) return [401, 'missing or wrong bearer token'];
      return null;
    }
    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
      let name: string;
      try { name = new URL(origin).hostname; } catch { return [403, 'Forbidden: unreadable Origin header']; }
      if (!isLoopback(name)) return [403, `Forbidden: Origin ${origin} is not a loopback address`];
    } else if (origin === 'null') return [403, 'Forbidden: opaque Origin'];
    const host = req.headers.host;
    if (host && !isLoopback(hostName(host))) return [403, `Forbidden: Host ${host} is not a loopback address`];
    return null;
  }

  /** requests being answered now; a restart waits for none */
  active = 0;

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.active++;
    res.once('close', () => this.active--);
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const refused = this.refuse(req);
      if (refused) {
        const [status, message] = refused;
        return sendJson(res, status, rpcError(null, -32000, message), status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {});
      }
      if (url.pathname === '/mcp') {
        if (req.method === 'POST') return await this.post(req, res);
        if (req.method === 'GET') return this.getStream(req, res);
        if (req.method === 'DELETE') return this.remove(req, res);
        return sendJson(res, 405, rpcError(null, -32000, 'use POST, GET or DELETE on /mcp'), { Allow: 'POST, GET, DELETE' });
      }
      if (url.pathname === '/sse' && req.method === 'GET') return this.legacyStream(res);
      if (url.pathname === '/messages' && req.method === 'POST') return await this.legacyPost(req, res, url);
      if (url.pathname === '/' && req.method === 'GET') {
        return sendJson(res, 200, { name: NAME, version: RUNTIME_VERSION, transport: 'streamable-http', endpoint: '/mcp', legacySse: '/sse', protocolVersions: PROTOCOL_VERSIONS });
      }
      return sendJson(res, 404, rpcError(null, -32000, `no ${url.pathname} here: the MCP endpoint is /mcp`));
    } catch (e) {
      this.log(`${NAME} mcp: ${(e as Error).stack ?? e}`);
      if (!res.headersSent) sendJson(res, (e as { status?: number }).status ?? 500, rpcError(null, -32603, (e as Error).message));
      else res.end();
    }
  }

  /** the request's session, or the error already sent */
  private session(req: IncomingMessage, res: ServerResponse): Session | null {
    const id = req.headers['mcp-session-id'];
    if (typeof id !== 'string' || !id) {
      sendJson(res, 400, rpcError(null, -32000, 'Bad Request: no Mcp-Session-Id header; send initialize first'));
      return null;
    }
    const s = this.sessions.get(id);
    if (!s || s.legacy) {
      sendJson(res, 404, rpcError(null, -32001, 'Session not found: initialize again'));
      return null;
    }
    s.lastSeen = Date.now();
    return s;
  }

  private async post(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const type = String(req.headers['content-type'] ?? '');
    if (!type.toLowerCase().startsWith('application/json')) return sendJson(res, 415, rpcError(null, -32000, 'send Content-Type: application/json'));
    const accept = accepts(req);
    if (!accept.sse && !accept.json) return sendJson(res, 406, rpcError(null, -32000, 'Not Acceptable: accept application/json and text/event-stream'));
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      if ((e as { status?: number }).status === 413) return sendJson(res, 413, rpcError(null, -32000, `body over ${MAX_BODY} bytes`));
      return sendJson(res, 400, rpcError(null, -32700, `parse error: ${(e as Error).message}`));
    }
    const batch = Array.isArray(body);
    const messages = (batch ? body : [body]) as Msg[];
    if (!messages.length) return sendJson(res, 400, rpcError(null, -32600, 'empty batch'));
    const init = messages.find((m) => m?.method === 'initialize');
    let session: Session | null;
    const headers: Record<string, string> = {};
    if (init) {
      if (messages.length > 1) return sendJson(res, 400, rpcError(init.id, -32600, 'initialize must be sent alone'));
      session = null;
    } else {
      const version = req.headers['mcp-protocol-version'];
      if (typeof version === 'string' && !PROTOCOL_VERSIONS.includes(version)) {
        return sendJson(res, 400, rpcError(null, -32000, `Bad Request: unsupported MCP-Protocol-Version ${version}; this server speaks ${PROTOCOL_VERSIONS.join(', ')}`));
      }
      session = this.session(req, res);
      if (!session) return;
      headers['Mcp-Session-Id'] = session.id;
    }
    const requests = messages.filter(isRequest);
    if (!requests.length) {
      for (const m of messages) await handle(m); // notifications: initialized, cancelled; responses
      return sendStatus(res, 202, headers);
    }
    if (init) {
      const reply = await handle(init);
      if (reply?.result) {
        const id = randomUUID();
        this.sessions.set(id, { id, protocolVersion: reply.result.protocolVersion, lastSeen: Date.now(), streams: new Set(), legacy: false });
        headers['Mcp-Session-Id'] = id;
      }
      if (accept.sse && !accept.json) {
        openStream(res, headers);
        writeEvent(res, reply);
        return void res.end();
      }
      return sendJson(res, 200, reply, headers);
    }
    // JSON when the client takes it and nothing streams; SSE when it asked for progress or takes only SSE
    const wantsProgress = requests.some((m) => m.params?._meta?.progressToken !== undefined);
    if (accept.sse && (wantsProgress || !accept.json || requests.some((m) => m.method === 'tools/call'))) {
      const stop = openStream(res, headers);
      await Promise.all(messages.map(async (m) => {
        const token = m?.params?._meta?.progressToken;
        const reply = await answer(m, token === undefined ? undefined : (elapsed) => writeEvent(res, {
          jsonrpc: '2.0', method: 'notifications/progress',
          params: { progressToken: token, progress: elapsed, message: `${m.params?.name ?? m.method} running, ${elapsed} s` },
        }), this.opts.progressMs);
        if (reply) writeEvent(res, reply);
      }));
      stop();
      return void res.end();
    }
    const replies = (await Promise.all(messages.map((m) => answer(m)))).filter((r): r is Msg => r !== null);
    return sendJson(res, 200, batch ? replies : replies[0], headers);
  }

  private getStream(req: IncomingMessage, res: ServerResponse): void {
    if (!accepts(req).sse) return sendJson(res, 406, rpcError(null, -32000, 'Not Acceptable: GET /mcp is an event stream; accept text/event-stream'));
    const session = this.session(req, res);
    if (!session) return;
    openStream(res, { 'Mcp-Session-Id': session.id });
    session.streams.add(res);
    res.on('close', () => session.streams.delete(res));
  }

  private remove(req: IncomingMessage, res: ServerResponse): void {
    const session = this.session(req, res);
    if (!session) return;
    for (const r of session.streams) r.end();
    this.sessions.delete(session.id);
    sendStatus(res, 204);
  }

  // -- the HTTP+SSE transport of protocol 2024-11-05 ----------------------------------------------

  private legacyStream(res: ServerResponse): void {
    const id = randomUUID();
    const session: Session = { id, protocolVersion: '2024-11-05', lastSeen: Date.now(), streams: new Set([res]), legacy: true };
    this.sessions.set(id, session);
    openStream(res);
    writeEvent(res, `/messages?sessionId=${id}`, 'endpoint');
    res.on('close', () => this.sessions.delete(id));
  }

  private async legacyPost(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const session = this.sessions.get(url.searchParams.get('sessionId') ?? '');
    if (!session?.legacy) return sendJson(res, 404, rpcError(null, -32001, 'no such SSE session: open GET /sse again'));
    session.lastSeen = Date.now();
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      return sendJson(res, 400, rpcError(null, -32700, `parse error: ${(e as Error).message}`));
    }
    sendStatus(res, 202);
    const stream = [...session.streams][0];
    const messages = (Array.isArray(body) ? body : [body]) as Msg[];
    const replies = (await Promise.all(messages.map((m) => answer(m)))).filter((r): r is Msg => r !== null);
    if (stream && replies.length) writeEvent(stream, Array.isArray(body) ? replies : replies[0]);
  }
}

export function parseHttpArgs(args: string[], env: NodeJS.ProcessEnv = process.env): HttpOptions {
  const opts: HttpOptions = { port: Number(env.TRACELIGHT_MCP_PORT ?? DEFAULT_MCP_PORT), host: '127.0.0.1', token: env.TRACELIGHT_MCP_TOKEN || undefined };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const value = (): string => {
      const v = args[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--http') continue;
    else if (a === '--port') opts.port = Number(value());
    else if (a === '--host') opts.host = value();
    else if (a === '--token') opts.token = value();
    else if (a === '--restart-on-change') opts.restartOnChange = value();
    else throw new Error(`unknown option ${a}: ${NAME} mcp [--http [--port N] [--host H] [--token T] [--restart-on-change PATH]]`);
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) throw new Error(`--port must be 0 to 65535, got ${opts.port}`);
  return opts;
}

/** `tracelight mcp --http`: serve until SIGINT or SIGTERM. */
export async function serveHttp(args: string[]): Promise<number> {
  const opts = parseHttpArgs(args);
  const server = new McpHttpServer(opts);
  let port: number;
  try {
    port = await server.listen();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new Error(`port ${opts.port} is taken, most likely by another \`${NAME} mcp --http\`: pass --port N, or set TRACELIGHT_MCP_PORT`);
    throw e;
  }
  const shown = opts.host.includes(':') ? `[${opts.host}]` : opts.host;
  process.stderr.write(`${NAME} mcp: Streamable HTTP on http://${shown}:${port}/mcp (legacy SSE: /sse)${opts.token ? ', bearer token required' : ''}\n`);
  return new Promise<number>((resolve) => {
    const end = (): void => {
      closePages();
      void server.close().then(() => resolve(0));
    };
    process.once('SIGINT', end);
    process.once('SIGTERM', end);
    if (opts.restartOnChange) watchForUpdate(opts.restartOnChange, server, end);
  });
}

/** what a file holds now, or null when it is gone */
function snapshot(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

/**
 * `--restart-on-change PATH`: every 15 s, compare PATH with what it held at start. Once it differs
 * (an extension update rewrote the `tracelight` command, or removed the runtime it named), wait
 * until no request is being answered, at most 60 s, and end; the service manager starts the new one.
 */
export function watchForUpdate(path: string, server: McpHttpServer, end: () => void, everyMs = 15_000): NodeJS.Timeout {
  const first = snapshot(path);
  let changedAt = 0;
  const timer = setInterval(() => {
    if (!changedAt && snapshot(path) === first) return;
    changedAt ||= Date.now();
    if (server.active > 0 && Date.now() - changedAt < 60_000) return;
    clearInterval(timer);
    process.stderr.write(`${NAME} mcp: ${path} changed; exiting for the service to start the new version\n`);
    end();
  }, everyMs);
  timer.unref();
  return timer;
}
