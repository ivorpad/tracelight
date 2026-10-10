import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installHttp } from '../src/http/record.ts';
import * as store from '../src/http/store.ts';

function server(): Promise<{ url: string; hits: () => number; close: () => void }> {
  let hits = 0;
  const s = http.createServer((req, res) => {
    hits++;
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.setHeader('set-cookie', 'session=secret');
      res.end(JSON.stringify({ path: req.url, method: req.method, body, n: hits }));
    });
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => {
    const port = (s.address() as any).port;
    r({ url: `http://127.0.0.1:${port}`, hits: () => hits, close: () => s.close() });
  }));
}

function getHttp(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

test('store keys ignore JSON key order and whitespace', () => {
  const a = store.requestKey('POST', 'http://x/a?b=1', Buffer.from('{"b": 1, "a": [1, 2]}'));
  const b = store.requestKey('post', 'http://x/a?b=1', Buffer.from('{"a":[1,2],"b":1}'));
  assert.equal(a, b);
  assert.notEqual(a, store.requestKey('POST', 'http://x/a?b=2', Buffer.from('{"a":[1,2],"b":1}')));
});

test('record then replay, fetch and http, offline replay and misses', async () => {
  const srv = await server();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-http-'));
  const file = path.join(root, 'main.js');
  fs.writeFileSync(file, '');
  const events: any[] = [];
  const emit = (e: any) => events.push(e);

  const rec = installHttp({ mode: 'record', file, workspaceRoot: root, emit, position: () => ({ rid: 3, step: 7 }) });
  const r1 = await (await fetch(`${srv.url}/a`, { method: 'POST', body: '{"x": 1}' })).json();
  const r2 = JSON.parse(await getHttp(`${srv.url}/b`));
  const done = rec.finish();
  assert.equal(r1.body, '{"x": 1}');
  assert.equal(r2.path, '/b');
  const rows = events.filter((e) => e.type === 'http.exchange');
  assert.deepEqual(rows.map((r) => [r.client, r.source, r.status, r.rid, r.step]), [['fetch', 'recorded', 200, 3, 7], ['http', 'recorded', 200, 3, 7]]);
  assert.equal((done.http as any).recorded, 2);
  const saved = fs.readFileSync(rec.file, 'utf8');
  assert.ok(!saved.includes('session=secret'), 'set-cookie is dropped');
  assert.equal(srv.hits(), 2);
  srv.close();

  events.length = 0;
  const rep = installHttp({ mode: 'replay', file, workspaceRoot: root, emit });
  const again = await (await fetch(`${srv.url}/a`, { method: 'POST', body: '{"x":1}' })).json();
  const again2 = JSON.parse(await getHttp(`${srv.url}/b`));
  assert.deepEqual(again, r1);
  assert.deepEqual(again2, r2);
  await assert.rejects(fetch(`${srv.url}/missing`));
  await assert.rejects(fetch(`${srv.url}/missing`));
  const fin = rep.finish();
  assert.equal(fin.replayed, true);
  assert.equal((fin.http as any).served, 2);
  assert.equal((fin.http as any).misses, 1);
  assert.equal(events.filter((e) => e.type === 'runner.error').length, 1, 'one error per missed key');
  assert.deepEqual(events.filter((e) => e.type === 'http.exchange').map((e) => e.source), ['replayed', 'replayed', 'miss', 'miss']);
});

test('off observes without changing responses', async () => {
  const srv = await server();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-http-'));
  const events: any[] = [];
  const s = installHttp({ mode: 'off', file: path.join(root, 'm.js'), workspaceRoot: root, emit: (e) => events.push(e) });
  const r = await (await fetch(`${srv.url}/z`)).json();
  s.finish();
  srv.close();
  assert.equal(r.path, '/z');
  assert.deepEqual(events.map((e) => [e.type, e.source]), [['http.exchange', 'live']]);
  assert.ok(!fs.existsSync(s.file));
});

test('a run records then replays through the runner', async () => {
  const { project } = await import('./helpers.ts');
  const { buildRequest, runOnce } = await import('../src/cli.ts');
  const srv = await server();
  const src = `const r = await fetch('${srv.url}/q');\nconst data = await r.json();\nconsole.log(data.path, data.n);\n`;
  const dir = project({ 'main.mjs': src });
  const go = async (mode: string) => {
    const req = buildRequest(path.join(dir, 'main.mjs'), src, {}, `h-${mode}`);
    req.config.http = mode;
    req.config.timeoutMs = 10000;
    return runOnce(req);
  };
  const a = await go('record');
  srv.close();
  const b = await go('replay');
  const row = (r: any) => r.events.find((e: any) => e.type === 'http.exchange');
  assert.equal(row(a).source, 'recorded');
  assert.ok(row(a).rid >= 0 && row(a).step >= 0, 'attributed to the statement');
  assert.equal(row(b).source, 'replayed');
  assert.deepEqual(b.events.filter((e: any) => e.type === 'log').map((e: any) => e.text), a.events.filter((e: any) => e.type === 'log').map((e: any) => e.text));
  assert.equal(a.finished.http.recorded, 1);
  assert.equal(b.finished.replayed, true);
  assert.equal(b.finished.http.served, 1);
});

test('httpObserve false with http off loads no HTTP plugin', async () => {
  const { project } = await import('./helpers.ts');
  const { buildRequest, runOnce } = await import('../src/cli.ts');
  const srv = await server();
  const src = `const r = await fetch('${srv.url}/q');\nconsole.log(r.status);\n`;
  const dir = project({ 'main.mjs': src });
  const go = async (config: Record<string, unknown>) => {
    const req = buildRequest(path.join(dir, 'main.mjs'), src, {}, `o-${Math.random()}`);
    Object.assign(req.config, { timeoutMs: 10000 }, config);
    return runOnce(req);
  };
  const quiet = await go({ httpObserve: false });
  const seen = await go({});
  srv.close();
  assert.equal(quiet.events.filter((e: any) => e.type === 'http.exchange').length, 0);
  assert.equal(quiet.finished.http, undefined);
  assert.equal(seen.events.filter((e: any) => e.type === 'http.exchange').length, 1);
  assert.equal(seen.finished.http.mode, 'off');
});
