import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildRequest } from '../src/cli.ts';
import { KeepLink, socketPath, spawnKeeper } from '../src/keep.ts';
import { project } from './helpers.ts';

test('the keeper: a run through it, expand afterwards from a new connection, shutdown removes the socket', async () => {
  const dir = project({ 'main.js': 'const o = { a: { b: [1, 2] } };\no // ?\n' });
  const sock = socketPath();
  const pid = await spawnKeeper(sock, 60);
  assert.ok(pid > 0);
  const link = await KeepLink.open(sock);
  const req = buildRequest(join(dir, 'main.js'), 'const o = { a: { b: [1, 2] } };\no // ?\n', {}, 'k1');
  const { events, finished } = await link.run(req);
  link.close();
  assert.equal(finished.exitCode, 0);
  const log = events.find((e) => e.type === 'log')!;
  const again = await KeepLink.open(sock);
  const reply = await again.request({ type: 'expand', runId: 'k1', valueId: log.valueBag.data.id, queryPath: [] });
  assert.equal(reply.type, 'value');
  assert.equal(reply.node.props[0].name, 'a');
  again.sock.write(JSON.stringify({ type: 'shutdown' }) + '\n');
  again.close();
  for (let i = 0; i < 100 && existsSync(sock); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(existsSync(sock), false);
});
