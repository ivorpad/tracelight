/** `tracelight web`: where it finds the browser page's bridge, the port it names, and its errors before the bridge runs. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { project } from './helpers.ts';
import { DEFAULT_PORT, findServer, portOf, serverCandidates } from '../src/web.ts';

const BIN = resolve(import.meta.dirname, '../bin/tracelight.mjs');
const tl = (...args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', BIN, ...args], { encoding: 'utf8' });

test('an installed extension: dist/web beside dist/node', () => {
  const ext = project({ 'dist/web/server.js': '', 'dist/node/src/web.ts': '' });
  assert.equal(findServer(join(ext, 'dist/node/src')), join(ext, 'dist/web/server.js'));
});

test('a checkout: its dist/web after npm run build, and the hint to build before it', () => {
  const repo = project({ 'web/server.ts': '', 'node/src/web.ts': '' });
  assert.deepEqual(serverCandidates(join(repo, 'node/src')), [join(repo, 'web/server.js'), join(repo, 'dist/web/server.js')]);
  assert.throws(() => findServer(join(repo, 'node/src')), /not built in this checkout: run `npm run build`/);
  mkdirSync(join(repo, 'dist/web'), { recursive: true });
  writeFileSync(join(repo, 'dist/web/server.js'), '');
  assert.equal(findServer(join(repo, 'node/src')), join(repo, 'dist/web/server.js'));
});

test('an install without the page says so', () => {
  const ext = project({ 'dist/node/src/web.ts': '' });
  assert.throws(() => findServer(join(ext, 'dist/node/src')), /has no browser page/);
});

test('the port: --port, else TRACELIGHT_PORT, else 4777', () => {
  assert.equal(portOf(['ctl', '--port', '4790', 'state'], {}), 4790);
  assert.equal(portOf(['ctl', 'state'], { TRACELIGHT_PORT: '4791' }), 4791);
  assert.equal(portOf(['ctl', 'state'], {}), DEFAULT_PORT);
});

const built = existsSync(resolve(import.meta.dirname, '../../dist/web/server.js'));

test('ctl with nothing served on the port: exit 2 and what to start', { skip: !built && 'the browser page is not built (npm run build)' }, () => {
  const r = tl('web', 'ctl', '--port', '1', 'state');
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /no Tracelight page is served on 127\.0\.0\.1:1: start one with `tracelight web FILE`/);
});

test('-h names the bridge it runs and prints its usage', { skip: !built && 'the browser page is not built (npm run build)' }, () => {
  const r = tl('web', '-h');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /tracelight web is the browser page's bridge, .*server\.js/);
  assert.match(r.stdout, /ctl \[--port N\] state/);
});
