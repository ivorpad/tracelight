/**
 * A small HTTP service over the RRF demo, for debugging a server with Tracelight. Node's own
 * `node:http`, no packages. Run it under the debugger from examples/js/rrf:
 *
 *     tracelight debug api/server.ts --at rank
 *     curl -s localhost:8765/rank -H 'content-type: application/json' \
 *          -d '{"rankings": {"bm25": ["A", "C", "B", "D"], "vector": ["C", "E", "A", "B"]}}'
 *
 * The request pauses in `rank`. `step --live --into` at the `rrf(...)` line lands in
 * api/ranking.ts. `GET /documents/zzz` throws a `NotFound` that `handle` catches, so it pauses
 * only after `break --live --on-exception raised`. `node api/server.ts --once` serves one
 * request to itself and exits, which is how `tracelight run` records it.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fusedOrder, rrf } from './ranking.ts';

const DOCUMENTS: Record<string, string> = {
  A: 'Button component with primary and secondary variants',
  B: 'Form input component with validation',
  C: 'Primary button used for important actions',
  D: 'Navigation menu and sidebar',
  E: 'CTA component for submitting forms',
};

interface RankRequest {
  rankings: Record<string, string[]>;
  k?: number;
}

class NotFound extends Error {}

function rank(request: RankRequest): { k: number; items: object[] } {
  const k = request.k ?? 60;
  const scores = rrf(request.rankings, k);
  const ordered = fusedOrder(scores);
  const items = [];
  for (const [index, [documentId, score]] of ordered.entries()) {
    items.push({ position: index + 1, id: documentId, score: Number(score.toFixed(6)), text: DOCUMENTS[documentId] });
  }
  const payload = { k, items };
  return payload;
}

function documentById(documentId: string): { id: string; text: string } {
  const text = DOCUMENTS[documentId];
  if (text === undefined) {
    throw new NotFound(`no document '${documentId}'`);
  }
  return { id: documentId, text };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || '{}');
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let status = 200;
  let payload: unknown;
  try {
    if (req.method === 'GET' && req.url === '/health') {
      payload = { ok: true };
    } else if (req.method === 'POST' && req.url === '/rank') {
      payload = rank((await readJson(req)) as RankRequest);
    } else if (req.method === 'GET' && req.url?.startsWith('/documents/')) {
      payload = documentById(req.url.slice('/documents/'.length));
    } else {
      throw new NotFound(`no route ${req.method} ${req.url}`);
    }
  } catch (error) {
    status = error instanceof NotFound ? 404 : 400;
    payload = { detail: (error as Error).message };
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const port = Number(process.env.PORT ?? 8765);
const server = createServer((req, res) => void handle(req, res));

if (process.argv.includes('--once')) {
  // one request to itself, then exit: a recording of the request path without a client
  server.listen(0, '127.0.0.1', async () => {
    const { port: own } = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${own}/rank`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rankings: { bm25: ['A', 'C', 'B', 'D'], vector: ['C', 'E', 'A', 'B'] } }),
    });
    console.log(response.status, await response.text());
    server.close();
  });
} else {
  server.listen(port, '127.0.0.1', () => console.log(`listening on http://127.0.0.1:${port}`));
}
