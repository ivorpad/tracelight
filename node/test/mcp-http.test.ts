/** `tracelight mcp --http`: Streamable HTTP and legacy SSE, the guards, the lock, and the tools added with it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project } from './helpers.ts';
import { McpHttpServer, parseHttpArgs } from '../src/mcp/http.ts';
import { callTool, exclusiveCall, isExclusive, wordsHistory, wordsLearn, wordsMap, wordsNarrate, wordsPin } from '../src/mcp/server.ts';
import { pageCommand, pageSucceeded, scratchCommand } from '../src/mcp/page.ts';

type Msg = Record<string, any>;

async function start(opts: Partial<ConstructorParameters<typeof McpHttpServer>[0]> = {}) {
  const server = new McpHttpServer({ port: 0, host: '127.0.0.1', log: () => {}, ...opts });
  const port = await server.listen();
  const url = `http://127.0.0.1:${port}`;
  let session: string | null = null;
  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const init = async () => {
    const res = await post({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    session = res.headers.get('mcp-session-id');
    return res;
  };
  return { server, url, post, init, get session() { return session; } };
}

/** the JSON-RPC messages of an SSE body */
function frames(text: string): Msg[] {
  return text.split('\n\n').filter((f) => f.startsWith('event: message\n')).map((f) => JSON.parse(f.slice(f.indexOf('data: ') + 6)));
}

test('initialize mints a session; requests need it; DELETE ends it', async () => {
  const t = await start();
  try {
    const init = await t.init();
    assert.equal(init.status, 200);
    assert.match(t.session!, /^[0-9a-f-]{36}$/);
    const reply = await init.json() as Msg;
    assert.equal(reply.result.protocolVersion, '2025-11-25');
    assert.equal((await t.post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    const list = await t.post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { accept: 'application/json' });
    assert.equal(list.headers.get('content-type'), 'application/json');
    const names = ((await list.json()) as Msg).result.tools.map((x: Msg) => x.name);
    for (const n of ['tracelight_run', 'tracelight_page', 'tracelight_scratchpad', 'tracelight_history', 'tracelight_learn', 'tracelight_pin', 'tracelight_narrate']) assert.ok(names.includes(n), n);
    const batch = await t.post([{ jsonrpc: '2.0', id: 2, method: 'ping' }, { jsonrpc: '2.0', id: 3, method: 'ping' }], { accept: 'application/json' });
    assert.deepEqual(((await batch.json()) as Msg[]).map((r) => r.id), [2, 3]);

    const without = await fetch(`${t.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' }) });
    assert.equal(without.status, 400);
    assert.equal((await t.post({ jsonrpc: '2.0', id: 5, method: 'ping' }, { 'mcp-session-id': 'not-a-session' })).status, 404);
    assert.equal((await t.post({ jsonrpc: '2.0', id: 6, method: 'ping' }, { 'mcp-protocol-version': '1999-01-01' })).status, 400);
    assert.equal((await t.post({ jsonrpc: '2.0', id: 7, method: 'ping' }, { 'mcp-protocol-version': '2025-06-18' })).status, 200);
    assert.equal((await t.post({ jsonrpc: '2.0', id: 8, method: 'ping' }, { accept: 'text/html' })).status, 406);
    assert.equal((await t.post({ jsonrpc: '2.0', id: 9, method: 'ping' }, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await t.post('{not json')).status, 400);

    const del = await fetch(`${t.url}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': t.session! } });
    assert.equal(del.status, 204);
    assert.equal((await t.post({ jsonrpc: '2.0', id: 10, method: 'ping' })).status, 404);
  } finally {
    await t.server.close();
  }
});

test('a tools/call answers on an SSE stream, with progress while it runs, and records a real run', async () => {
  const t = await start({ progressMs: 50 });
  const root = project({ 'slow.mjs': 'const end = Date.now() + 400;\nlet n = 0;\nwhile (Date.now() < end) n++;\nconsole.log(n > 0);\n' });
  try {
    await t.init();
    const save = join(root, 'slow.json');
    const res = await t.post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tracelight_run', arguments: { file: join(root, 'slow.mjs'), save, max_steps: 2000 }, _meta: { progressToken: 'tok' } } });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    assert.equal(res.headers.get('mcp-session-id'), t.session);
    const got = frames(await res.text());
    const progress = got.filter((f) => f.method === 'notifications/progress');
    assert.ok(progress.length >= 1, JSON.stringify(got).slice(0, 400));
    assert.ok(progress.every((p) => p.params.progressToken === 'tok'));
    assert.deepEqual(progress.map((p) => p.params.progress), [...progress.map((p) => p.params.progress)].sort((a, b) => a - b));
    const answer = got.at(-1)!;
    assert.equal(answer.id, 1);
    assert.equal(answer.result.isError, false, answer.result.content[0].text);
    assert.match(answer.result.content[0].text, /exit 0/);
    assert.ok(existsSync(save));
  } finally {
    await t.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('GET /mcp opens the session stream; the legacy /sse transport answers on its stream', async () => {
  const t = await start();
  try {
    await t.init();
    const ctl = new AbortController();
    const stream = await fetch(`${t.url}/mcp`, { headers: { accept: 'text/event-stream', 'mcp-session-id': t.session! }, signal: ctl.signal });
    assert.equal(stream.status, 200);
    assert.equal(stream.headers.get('content-type'), 'text/event-stream');
    ctl.abort();

    const legacy = new AbortController();
    const sse = await fetch(`${t.url}/sse`, { headers: { accept: 'text/event-stream' }, signal: legacy.signal });
    const reader = sse.body!.getReader();
    let text = '';
    const until = async (re: RegExp) => {
      while (!re.test(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
    };
    await until(/event: endpoint\nid: \d+\ndata: (\S+)\n\n/);
    const endpoint = /data: (\S+)\n/.exec(text)![1]!;
    assert.match(endpoint, /^\/messages\?sessionId=/);
    const posted = await fetch(t.url + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) });
    assert.equal(posted.status, 202);
    await until(/"id":7/);
    const reply = frames(text).find((f) => f.id === 7)!;
    assert.equal(reply.result.protocolVersion, '2024-11-05');
    legacy.abort();
    assert.equal((await fetch(`${t.url}/messages?sessionId=nope`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
  } finally {
    await t.server.close();
  }
});

test('a foreign Origin or Host is refused; a token is required off loopback and checked when set', async () => {
  const t = await start();
  try {
    await t.init();
    assert.equal((await t.post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await t.post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'http://localhost:3000' })).status, 200);
  } finally {
    await t.server.close();
  }
  await assert.rejects(new McpHttpServer({ port: 0, host: '0.0.0.0', log: () => {} }).listen(), /without --token/);
  const secured = await start({ token: 's3cret' });
  try {
    const res = await secured.post({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('www-authenticate'), 'Bearer');
    assert.equal((await secured.post({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }, { authorization: 'Bearer s3cret' })).status, 200);
  } finally {
    await secured.server.close();
  }
  assert.deepEqual(parseHttpArgs(['--http', '--port', '0', '--host', '::1'], {}), { port: 0, host: '::1', token: undefined });
  assert.equal(parseHttpArgs([], { TRACELIGHT_MCP_PORT: '5000', TRACELIGHT_MCP_TOKEN: 't' }).token, 't');
  assert.throws(() => parseHttpArgs(['--bogus'], {}), /unknown option/);
});

test('calls that drive something live run one at a time; saved-run reads and pause do not wait', async () => {
  assert.equal(isExclusive('tracelight_debug', { action: 'continue' }), true);
  assert.equal(isExclusive('tracelight_debug', { action: 'pause' }), false);
  assert.equal(isExclusive('tracelight_debug', { action: 'status' }), false);
  assert.equal(isExclusive('tracelight_step', { live: true, move: 'over' }), true);
  assert.equal(isExclusive('tracelight_step', { run: 'r.json', step: 1 }), false);
  assert.equal(isExclusive('tracelight_page', { action: 'wait_pause' }), false);
  assert.equal(isExclusive('tracelight_page', { action: 'goto' }), true);
  const order: string[] = [];
  const slow = (name: string, ms: number) => () => new Promise<string>((r) => setTimeout(() => { order.push(name); r(name); }, ms));
  await Promise.all([
    exclusiveCall('tracelight_debug', { action: 'continue' }, slow('continue', 120)),
    exclusiveCall('tracelight_step', { live: true, move: 'over' }, slow('step', 10)),
    exclusiveCall('tracelight_debug', { action: 'pause' }, slow('pause', 30)),
    exclusiveCall('tracelight_map', { action: 'state', run: 'x.json' }, slow('read', 20)),
  ]);
  assert.deepEqual(order, ['read', 'pause', 'continue', 'step']);
  // a failed exclusive call does not block the next one
  await assert.rejects(exclusiveCall('tracelight_debug', { action: 'continue' }, () => Promise.reject(new Error('boom'))));
  assert.equal(await exclusiveCall('tracelight_debug', { action: 'locals' }, () => Promise.resolve('after')), 'after');
});

test('the added tools turn their arguments into the words of their commands', () => {
  assert.deepEqual(wordsHistory({ run: 'r.json', out: 'h.json', var: ['total'], at: ['12', 'app.ts:4'], why: [{ step: 40, name: 'total' }], pad: 3, value_chars: 0, append: true }),
    ['history', '--out=h.json', '--at=12', '--at=app.ts:4', '--var=total', '--why', '40', 'total', '--pad=3', '--value-chars=0', '--append', '--', 'r.json']);
  assert.deepEqual(wordsHistory({ live: true, out: 'h.json', pause: true }), ['history', '--live', '--out=h.json', '--pause', '--']);
  assert.throws(() => wordsHistory({ run: 'r.json', out: 'h.json' }), /at least one checkpoint/);
  assert.throws(() => wordsHistory({ run: 'r.json', var: ['x'] }), /needs `out`/);
  assert.deepEqual(wordsLearn({ run: 'r.json', at: 5, prediction: 'NaN', reveal: true }), ['learn', '--at=5', '--prediction=NaN', '--reveal', '--', 'r.json']);
  assert.deepEqual(wordsPin({ run: 'r.json', out: 'b.json' }), ['pin', '--out=b.json', '--', 'r.json']);
  assert.deepEqual(wordsNarrate({ run: 'r.json', dry_run: true, command: 'cat' }), ['narrate', '--command=cat', '--dry-run', '--', 'r.json']);
  assert.deepEqual(wordsMap({ action: 'graph', run: 'r.json', expand: ['lodash'], no_statements: true, dot: true }), ['graph', '--expand=lodash', '--no-statements', '--dot', '--', 'r.json']);
  assert.deepEqual(wordsMap({ action: 'tour', run: 'r.json', prose: 'p.json', out: 't.json' }), ['tour', '--prose=p.json', '--out=t.json', '--', 'r.json']);
});

test('page actions become the bridge commands `tracelight web ctl` sends, and replies are judged like its exit code', () => {
  assert.deepEqual(pageCommand({ action: 'goto', step: 4, say: 'here' }), { action: 'goto', step: 4, say: 'here' });
  assert.deepEqual(pageCommand({ action: 'step', kind: 'backOver' }), { action: 'step', kind: 'backOver' });
  assert.deepEqual(pageCommand({ action: 'debug', op: 'step' }), { action: 'debug', op: 'step', kind: 'over' });
  assert.deepEqual(pageCommand({ action: 'breakpoint', line: 3, on: false, condition: 'n > 2' }), { action: 'breakpoint', line: 3, on: false, condition: 'n > 2' });
  assert.deepEqual(pageCommand({ action: 'say', text: 'hi', note_id: 'n1', note_kind: 'prediction' }), { action: 'say', text: 'hi', noteId: 'n1', kind: 'prediction' });
  assert.deepEqual(pageCommand({ action: 'inspect', names: ['a', 'b'], visible: false }), { action: 'inspect', name: 'a', names: ['a', 'b'], open: false });
  assert.deepEqual(pageCommand({ action: 'watch', expression: 'n * 2', remove: true }), { action: 'watch', exp: 'n * 2', remove: true });
  assert.deepEqual(pageCommand({ action: 'wait_pause', after: 3, timeout_ms: 1000 }), { action: 'waitPause', after: 3, timeoutMs: 1000 });
  assert.deepEqual(pageCommand({ action: 'state', expect: { step: 2 } }), { action: 'state', expect: { step: 2 } });
  assert.throws(() => pageCommand({ action: 'wait_pause', timeout_ms: 30000 }), /at most 25000/);
  assert.throws(() => pageCommand({ action: 'goto' }), /needs `step`/);
  assert.throws(() => pageCommand({ action: 'fly' }), /unknown page action/);
  assert.deepEqual(scratchCommand({ op: 'experiment', code: 'x', inputs: { a: 1 }, mock_labels: { f: 'fixture' }, auto_run: false }), { action: 'scratchpad', op: 'experiment', code: 'x', inputs: { a: 1 }, mockLabels: { f: 'fixture' }, autoRun: false });
  assert.throws(() => scratchCommand({ op: 'load' }), /needs `id`/);
  assert.throws(() => scratchCommand({ op: 'run', inputs: [1] }), /JSON object/);

  assert.equal(pageSucceeded({ action: 'say', text: 'x' }, true, { result: {} }), true);
  assert.equal(pageSucceeded({ action: 'say', text: 'x' }, false, { result: null, error: 'no page is open' }), false);
  assert.equal(pageSucceeded({ action: 'goto', step: 1 }, true, { result: { position: { ready: false } } }), false);
  assert.equal(pageSucceeded({ action: 'goto', step: 1 }, true, { result: { position: { ready: true } } }), true);
  assert.equal(pageSucceeded({ action: 'debug', op: 'continue' }, true, { result: { runId: 'r', running: false, paused: false } }), true);
  const done = { status: 'completed', liveExecutionChanged: false, result: { values: [] } };
  assert.equal(pageSucceeded({ action: 'scratchpad', op: 'run' }, true, { result: done }), true);
  assert.equal(pageSucceeded({ action: 'scratchpad', op: 'run' }, true, { result: { ...done, result: { missingMocks: ['fetch'] } } }), false);
});

test('page and scratchpad calls to a port with no page say how to start one', async () => {
  const r = await callTool('tracelight_page', { action: 'say', text: 'x', port: 1 });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /no Tracelight page is served on 127\.0\.0\.1:1\n.*"action": "open"/);
  const close = await callTool('tracelight_page', { action: 'close', port: 1 });
  assert.match(close.content[0].text, /did not start the page on port 1/);
});

// -- tracelight_debug status: a fake VS Code bridge --------------------------------------------------

test('debug status waits for a pause the person causes, and gives up after wait_seconds', async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'tl-mcp-status-'));
  const socket = join(dir, 'bridge.sock'), selector = join(dir, 'debug-session.json');
  const file = join(dir, 'main.mjs');
  writeFileSync(file, 'console.log(1);\n');
  const prior = process.env.TRACELIGHT_SESSIONS_DIR;
  process.env.TRACELIGHT_SESSIONS_DIR = dir;
  let paused = false;
  let pauseAfterWatch: number | null = 300;
  const watchers = new Set<Socket>();
  const server = createServer((client) => {
    let buffer = '', authenticated = false;
    client.setEncoding('utf8');
    client.on('close', () => watchers.delete(client));
    client.on('data', (data) => {
      buffer += data;
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const req = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (!authenticated) { authenticated = true; continue; }
        let reply: Msg;
        if (req.type === 'state') reply = { kind: 'debug', running: !paused, paused, file, displayName: 'main.mjs', debug: { active: true, paused: paused ? { step: 3 } : null } };
        else if (req.type === 'watch') {
          watchers.add(client);
          reply = {};
          if (pauseAfterWatch !== null) setTimeout(() => { paused = true; for (const w of watchers) w.write(JSON.stringify({ event: 'paused', step: 3 }) + '\n'); }, pauseAfterWatch);
        } else if (req.type === 'unwatch') { watchers.delete(client); continue; }
        else reply = { error: `unexpected ${req.type}` };
        client.write(JSON.stringify({ id: req.id, ok: !reply.error, ...reply }) + '\n');
      }
    });
  });
  await new Promise<void>((r) => server.listen(socket, r));
  writeFileSync(selector, JSON.stringify({ file, workspace: dir, pid: process.pid, kind: 'debug', socket, token: 't' }));
  try {
    const t0 = Date.now();
    const waited = await callTool('tracelight_debug', { action: 'status', session: selector, json: true, wait_seconds: 10 });
    assert.equal(waited.isError, false, waited.content[0].text);
    assert.equal(JSON.parse(waited.content[0].text).paused, true);
    assert.ok(Date.now() - t0 < 5000, `returned at the pause, not the timeout (${Date.now() - t0} ms)`);

    // already paused: no wait at all
    pauseAfterWatch = null;
    const t1 = Date.now();
    const now = await callTool('tracelight_debug', { action: 'status', session: selector, json: true, wait_seconds: 10 });
    assert.equal(JSON.parse(now.content[0].text).paused, true);
    assert.ok(Date.now() - t1 < 2000);

    paused = false;
    const t2 = Date.now();
    const timedOut = await callTool('tracelight_debug', { action: 'status', session: selector, json: true, wait_seconds: 1 });
    assert.equal(JSON.parse(timedOut.content[0].text).paused, false);
    assert.ok(Date.now() - t2 >= 950, `${Date.now() - t2} ms`);
    const bad = await callTool('tracelight_debug', { action: 'status', session: selector, wait_seconds: 601 });
    assert.match(bad.content[0].text, /0 to 600/);
  } finally {
    server.close();
    if (prior === undefined) delete process.env.TRACELIGHT_SESSIONS_DIR;
    else process.env.TRACELIGHT_SESSIONS_DIR = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});
