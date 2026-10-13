import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Socket } from 'node:net';
import { callTool } from '../src/mcp/server.ts';

test('MCP logpoints, breakpoint clearing and selective locals reach only the selected live bridge', async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'tl-mcp-debug-'));
  const socket = join(dir, 'bridge.sock'), selector = join(dir, 'debug-session.json');
  const file = join(dir, 'main.mjs');
  writeFileSync(file, 'throw new Error("control tools must never launch this file");\n');
  const source = readFileSync(file, 'utf8');
  const prior = process.env.TRACELIGHT_SESSIONS_DIR;
  process.env.TRACELIGHT_SESSIONS_DIR = dir;
  const clients = new Set<Socket>(), requests: Record<string, any>[] = [];
  const variables = [{ name: 'total', type: 'number', text: '7' }, { name: 'payload', type: 'object', text: '{private: 1}' }, { name: 'ignored', type: 'string', text: 'NEVER_REQUESTED_VALUE' }];
  let breakpoints: Record<string, any>[] = [];
  const server = createServer(client => {
    clients.add(client); client.on('close', () => clients.delete(client));
    let buffer = '', authenticated = false;
    client.setEncoding('utf8');
    client.on('data', data => {
      buffer += data;
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (!authenticated) { assert.equal(request.token, 'test-token'); authenticated = true; continue; }
        requests.push(request);
        let reply: Record<string, any>;
        if (request.type === 'break') {
          if (Array.isArray(request.set)) breakpoints = [...request.set];
          if (Array.isArray(request.add)) breakpoints.push(...request.add);
          reply = { breakpoints, exceptions: 'uncaught' };
        } else if (request.type === 'locals') {
          const selected = variables.filter(value => !request.names || request.names.includes(value.name));
          reply = { locals: request.namesOnly ? selected.map(({ name, type }) => ({ name, type })) : selected };
        } else reply = { error: `unexpected request ${request.type}` };
        client.write(JSON.stringify({ id: request.id, ok: !reply.error, ...reply }) + '\n');
      }
    });
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  writeFileSync(selector, JSON.stringify({ file, workspace: dir, pid: process.pid, kind: 'debug', socket, token: 'test-token' }));
  const descriptor = readFileSync(selector, 'utf8');
  try {
    const logpoint = await callTool('tracelight_debug', { action: 'break', session: selector, json: true,
      add: [`${file}:1`], when: 'total > 3', log_message: 'total={total}' });
    assert.equal(logpoint.isError, false, logpoint.content[0].text);
    const logReply = JSON.parse(logpoint.content[0].text);
    assert.equal(logReply.breakpoints[0].condition, 'total > 3');
    assert.equal(logReply.breakpoints[0].logMessage, 'total={total}');
    assert.deepEqual(requests.at(-1)!.add, [{ file, line: 1, condition: 'total > 3', logMessage: 'total={total}' }]);

    const names = await callTool('tracelight_debug', { action: 'locals', session: selector, json: true,
      frame: 2, names_only: true, names: ['total', 'payload'] });
    assert.equal(names.isError, false, names.content[0].text);
    const namesReply = JSON.parse(names.content[0].text);
    assert.deepEqual(namesReply.locals, [{ name: 'total', type: 'number' }, { name: 'payload', type: 'object' }]);
    assert.deepEqual(requests.at(-1)!.names, ['total', 'payload']);
    assert.equal(requests.at(-1)!.namesOnly, true);
    assert.equal(requests.at(-1)!.frameId, 2);
    assert.equal(requests.at(-1)!.valueBag, true);
    assert.doesNotMatch(names.content[0].text, /NEVER_REQUESTED_VALUE|private|"text"/);

    const targeted = await callTool('tracelight_debug', { action: 'locals', session: selector, json: true, names: ['total'] });
    assert.equal(targeted.isError, false, targeted.content[0].text);
    assert.deepEqual(JSON.parse(targeted.content[0].text).locals, [{ name: 'total', type: 'number', text: '7' }]);
    assert.deepEqual(requests.at(-1)!.names, ['total']);
    assert.equal(requests.at(-1)!.namesOnly, undefined);
    assert.doesNotMatch(targeted.content[0].text, /NEVER_REQUESTED_VALUE|payload/);

    const clear = await callTool('tracelight_debug', { action: 'break', session: selector, json: true, clear: true });
    assert.equal(clear.isError, false, clear.content[0].text);
    assert.deepEqual(JSON.parse(clear.content[0].text).breakpoints, []);
    assert.deepEqual(requests.at(-1)!.set, []);
    assert.deepEqual(requests.map(request => request.type), ['break', 'locals', 'locals', 'break'], 'no launch, execution, step or evaluation requests');

    const count = requests.length;
    for (const args of [{ names_only: 'yes' }, { names: [] }, { names: [''] }, { names: [1] }, { names: Array(101).fill('total') }]) {
      const bad = await callTool('tracelight_debug', { action: 'locals', session: selector, ...args });
      assert.equal(bad.isError, true);
      assert.match(bad.content[0].text, /names/);
    }
    assert.equal(requests.length, count, 'invalid selective reads fail before contacting the bridge');
    assert.equal(readFileSync(file, 'utf8'), source);
    assert.equal(readFileSync(selector, 'utf8'), descriptor);
  } finally {
    for (const client of clients) client.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (prior === undefined) delete process.env.TRACELIGHT_SESSIONS_DIR; else process.env.TRACELIGHT_SESSIONS_DIR = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});
