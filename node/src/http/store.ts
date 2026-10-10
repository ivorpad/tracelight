/**
 * The HTTP recording file: where it lives, how a request is keyed, how
 * bytes and headers are stored (docs/PROTOCOL.md, "HTTP record and replay"); the header names the
 * `node` version that wrote it.
 *
 * Bodies are stored decoded (`content-encoding` undone: gzip, deflate, br, and zstd where this
 * Node has it), credentials and secret-named headers are dropped, and every stored text goes
 * through the secret filter.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { STATUS_CODES } from 'node:http';
import { secrets } from '../secrets.ts';
import { NAME } from '../protocol.ts';

export const FILE_VERSION = 1;
export const DROP_REQUEST_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie']);
export const DROP_RESPONSE_HEADERS = new Set(['set-cookie', 'content-length', 'transfer-encoding']);

export type Stored = string | { base64: string } | null;

export interface RequestEntry {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Stored;
}

export interface ResponseEntry {
  status: number;
  reason: string;
  headers: Record<string, string>;
  body: Stored;
  streamed: boolean;
  chunks: Stored[] | null;
}

export interface Entry {
  n: number;
  key: string;
  client: string;
  request: RequestEntry;
  response: ResponseEntry;
  elapsedMs: number;
}

// -- paths ------------------------------------------------------------------------------------

/**
 * `<root>/.tracelight/replay`, or `<root>/.tracelight-replay` when `.tracelight` is the
 * Quokka-style config file: the directory the Tracelight extension offers to add to .gitignore.
 */
export function recordingDir(workspaceRoot: string): string {
  return dirFor(workspaceRoot, NAME);
}

function dirFor(workspaceRoot: string, name: string): string {
  const dot = path.join(workspaceRoot, `.${name}`);
  try {
    if (fs.statSync(dot).isFile()) return path.join(workspaceRoot, `.${name}-replay`);
  } catch {
    /* absent */
  }
  return path.join(dot, 'replay');
}

function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** One file per source file, named after its real path: edits keep it, a move starts a new one. */
export function recordingPath(workspaceRoot: string, filePath: string): string {
  const digest = createHash('sha256').update(realpath(filePath), 'utf8').digest('hex').slice(0, 16);
  return path.join(recordingDir(workspaceRoot), `${digest}.jsonl`);
}

/** The workspace root first, then the file's directory and each of its ancestors. */
export function findRecording(workspaceRoot: string, filePath: string): string | null {
  const roots = [path.resolve(workspaceRoot)];
  for (let d = path.dirname(path.resolve(filePath)); ; d = path.dirname(d)) {
    roots.push(d);
    if (path.dirname(d) === d) break;
  }
  for (const root of new Set(roots)) {
    const p = recordingPath(root, filePath);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}

function lines(file: string): unknown[] {
  const out: unknown[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* a damaged line */
    }
  }
  return out;
}

/** The exchanges in request order (they land in completion order); the header and damaged lines skipped. */
export function loadRecording(file: string): Entry[] {
  return (lines(file).filter((o: any) => o && typeof o === 'object' && 'key' in o && 'n' in o) as Entry[]).sort((a, b) => (a.n ?? 0) - (b.n ?? 0));
}

export function recordingInfo(file: string): { exists: boolean; recordedAt: string | null; entries: number | null } {
  let objs: unknown[];
  try {
    objs = lines(file);
  } catch {
    return { exists: false, recordedAt: null, entries: null };
  }
  let recordedAt: string | null = null;
  let entries = 0;
  for (const o of objs as any[]) {
    if (!o || typeof o !== 'object') continue;
    if ('n' in o) entries++;
    else if (o.tracelight === 'http' && recordedAt === null) recordedAt = o.recorded ?? null;
  }
  return { exists: true, recordedAt, entries };
}

export function declaredLength(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(String(value).trim());
  return Number.isInteger(n) ? n : null;
}

// -- keys -------------------------------------------------------------------------------------

/** Python's `json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && Number.isInteger(v)) return String(v);
    if (typeof v === 'number') return pyFloat(v);
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const keys = Object.keys(v as object).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(',')}}`;
}

/** A float as Python's repr writes it (`1.0`, `1e+20`), so a JSON body keys the same in both runtimes. */
function pyFloat(n: number): string {
  if (!Number.isFinite(n)) return n > 0 ? 'Infinity' : n < 0 ? '-Infinity' : 'NaN';
  const s = String(n);
  if (/e/.test(s)) return s.replace(/e([+-])(\d)$/, 'e$10$2');
  return s.includes('.') ? s : `${s}.0`;
}

/** Canonical JSON when it parses, else text with whitespace runs collapsed, else the raw bytes. */
export function normaliseBody(body: Uint8Array | null | undefined): Buffer {
  if (!body || !body.length) return Buffer.alloc(0);
  const buf = Buffer.from(body);
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (!Buffer.from(text, 'utf8').equals(buf)) return buf; // not UTF-8
  try {
    // one difference from Python remains: a whole-number float (`1.0`) parses to 1 here, so such a
    // body keys differently in the two runtimes
    return Buffer.from(canonical(JSON.parse(text)), 'utf8');
  } catch {
    return Buffer.from(text.split(/\s+/).filter(Boolean).join(' '), 'utf8');
  }
}

/** sha256 of `METHOD\nURL\n<body>`; headers carry credentials and dates, so they are not part of it. */
export function requestKey(method: string, url: string, body: Uint8Array | null | undefined): string {
  const h = createHash('sha256');
  h.update(`${method.toUpperCase()}\n${url}\n`, 'utf8');
  h.update(normaliseBody(body));
  return h.digest('hex');
}

// -- stored fields ----------------------------------------------------------------------------

export function storeBytes(data: Uint8Array | null | undefined): Stored {
  if (!data || !data.length) return null;
  const buf = Buffer.from(data);
  const text = buf.toString('utf8');
  if (Buffer.from(text, 'utf8').equals(buf)) return secrets.scrub(text);
  return { base64: buf.toString('base64') };
}

export function loadBytes(value: Stored | undefined): Buffer {
  if (value === null || value === undefined) return Buffer.alloc(0);
  if (typeof value === 'object') return Buffer.from(value.base64 ?? '', 'base64');
  return Buffer.from(String(value), 'utf8');
}

/** Lower-cased names, repeated names joined with commas, credential and secret-named headers dropped. */
export function storedHeaders(items: Iterable<[string, string]>, drop: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawName, value] of items) {
    const name = String(rawName).toLowerCase();
    if (drop.has(name) || isSecretHeader(name)) continue;
    out[name] = name in out ? `${out[name]}, ${value}` : String(value);
  }
  return out;
}

/** The "Secrets" name rule, whether or not masking is on: a key never goes to disk. */
function isSecretHeader(name: string): boolean {
  const was = secrets.mask;
  secrets.mask = true;
  try {
    return secrets.isSecretName(name.replace(/-/g, '_'));
  } finally {
    secrets.mask = was;
  }
}

function scrubbed(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, secrets.scrub(v)]));
}

export function requestEntry(method: string, url: string, headers: Iterable<[string, string]>, body: Uint8Array | null): RequestEntry {
  return { method, url: secrets.scrub(url), headers: scrubbed(storedHeaders(headers, DROP_REQUEST_HEADERS)), body: storeBytes(body) };
}

export function responseEntry(status: number, reason: string, headers: Record<string, string>, chunks: Uint8Array[]): ResponseEntry {
  const streamed = chunks.length > 1;
  return {
    status, reason, headers: scrubbed(headers),
    body: streamed ? null : storeBytes(Buffer.concat(chunks)),
    streamed,
    chunks: streamed ? chunks.map(storeBytes) : null,
  };
}

export function entryChunks(response: ResponseEntry): Buffer[] {
  if (response.streamed && response.chunks) return response.chunks.map(loadBytes);
  const body = loadBytes(response.body);
  return body.length ? [body] : [];
}

export function reasonPhrase(status: number, reason: string | null | undefined): string {
  return reason ? String(reason) : (STATUS_CODES[status] ?? '');
}

// -- content decoding -------------------------------------------------------------------------

function inflate(buf: Buffer): Buffer {
  try {
    return zlib.inflateSync(buf);
  } catch {
    return zlib.inflateRawSync(buf); // some servers send raw deflate
  }
}

/** The body with `content-encoding` undone; null when it cannot be (stacked or unknown encodings, damaged data). */
export function decodeBody(body: Buffer, encoding: string): Buffer | null {
  const names = encoding.split(',').map((e) => e.trim().toLowerCase()).filter((e) => e && e !== 'identity');
  if (!names.length) return body;
  if (names.length > 1) return null;
  try {
    switch (names[0]) {
      case 'gzip':
      case 'x-gzip':
        return zlib.gunzipSync(body);
      case 'deflate':
        return inflate(body);
      case 'br':
        return zlib.brotliDecompressSync(body);
      case 'zstd':
        return typeof (zlib as any).zstdDecompressSync === 'function' ? (zlib as any).zstdDecompressSync(body) : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Stored-form headers and chunks of a response. `decoded`: the client already undid the encoding
 * (fetch does); otherwise the body is decoded here, and kept as received, header and all, when it
 * cannot be. A decoded streamed body is stored as one chunk per network chunk only when it was not
 * compressed (a compressed stream's chunk boundaries are the compressor's, not the server's events).
 */
export function prepareResponse(headers: Iterable<[string, string]>, chunks: Buffer[], decoded: boolean): { headers: Record<string, string>; chunks: Buffer[] } {
  const stored = storedHeaders(headers, DROP_RESPONSE_HEADERS);
  const encoding = stored['content-encoding'];
  if (!encoding) return { headers: stored, chunks };
  if (decoded) {
    delete stored['content-encoding'];
    return { headers: stored, chunks };
  }
  const body = decodeBody(Buffer.concat(chunks), encoding);
  if (body === null) return { headers: stored, chunks };
  delete stored['content-encoding'];
  return { headers: stored, chunks: body.length ? [body] : [] };
}

export function header(file: string): Record<string, unknown> {
  return { tracelight: 'http', version: FILE_VERSION, file, recorded: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), node: process.versions.node };
}

/** The URL of a row: query values stripped (the names stay), no fragment. */
export function publicUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (!u.search && !u.hash) return url;
  const names = u.search.replace(/^\?/, '').split('&').filter(Boolean).map((p) => p.split('=')[0]);
  return `${u.protocol}//${u.host}${u.pathname}${names.length ? `?${names.join('&')}` : ''}`;
}
