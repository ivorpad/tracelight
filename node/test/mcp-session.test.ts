import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Socket } from 'node:net';
import { sessionState } from '../src/mcp/session.ts';
import { encodeSteps } from '../src/protocol.ts';

test('saved state uses recorded source and actual completion, without a live pause', async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'tl-session-'));
  const file = join(dir, 'main.js'), run = join(dir, 'run.json');
  try {
    writeFileSync(file, 'const value = 999;\n');
    const doc = { meta: { file, files: [{ path: file, source: 'const value = 1;\n' }] }, events: [
      { type: 'file.instrumented', fileId: 1, path: file, rangeBase: 0, ranges: [[1, 0, 1, 16]], statements: [0], functions: [] },
      { type: 'trace', steps: encodeSteps(Int32Array.from([0, 0, 0, 0])), scopes: [{ scopeId: 0, parent: -1, name: '<module>', first: 0, last: 0, fileId: 1 }] },
    ] };
    writeFileSync(run, JSON.stringify(doc));
    const state = await sessionState({ run });
    assert.equal(state.mode, 'recorded');
    assert.equal(state.finished, false);
    assert.equal(state.livePause, null);
    assert.equal(state.visibleEditor, null);
    assert.equal(state.capabilities.liveControl, false);
    assert.match(JSON.stringify(state.context), /const value = 1/);
    assert.doesNotMatch(JSON.stringify(state.context), /999/);
    await assert.rejects(sessionState({ run, step: 3 }), /past the recorded/);
    doc.meta.files = [];
    writeFileSync(run, JSON.stringify(doc));
    const missing = await sessionState({ run });
    assert.doesNotMatch(JSON.stringify(missing.context), /999/);
    assert.ok(missing.notes.some((note: string) => /snapshots are missing/.test(note)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('discovery sanitizes descriptors and live state distinguishes history from a real pause', async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'tl-session-'));
  const socket = join(dir, 'bridge.sock'), selector = join(dir, 's.json');
  const prior = process.env.TRACELIGHT_SESSIONS_DIR;
  process.env.TRACELIGHT_SESSIONS_DIR = dir;
  const clients = new Set<Socket>(), requests: any[] = [];
  let state: any = { kind: 'run', runId: 'r1', running: true, nav: { active: true, step: 2, count: 9 },
    location: { file: '/project/main.js', line: 3 }, debug: { active: true, frontier: 8, paused: { step: 8, file: '/project/worker.js', line: 5, reason: 'breakpoint' } } };
  const server = createServer(client => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    let buffer = '', authenticated = false;
    client.setEncoding('utf8');
    client.on('data', text => {
      buffer += text;
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (!authenticated) { assert.equal(msg.token, 'private-token'); authenticated = true; continue; }
        requests.push(msg);
        client.write(JSON.stringify({ id: msg.id, ok: true, ...state }) + '\n');
      }
    });
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  try {
    writeFileSync(selector, JSON.stringify({ file: '/project/main.js', workspace: '/project', pid: process.pid, kind: 'run', socket, token: 'private-token' }));
    const discovered = await sessionState();
    assert.equal(discovered.mode, 'list');
    assert.equal(discovered.sessions[0].session, selector);
    assert.doesNotMatch(JSON.stringify(discovered), /private-token|bridge\.sock|"token"|"socket"/);
    assert.equal(requests.length, 0);
    const live = await sessionState({ live: true, session: selector });
    assert.equal(live.livePause.step, 8);
    assert.equal(live.recordedSelection.step, 2);
    assert.equal(live.frontier, 8);
    assert.equal(live.visibleEditor, null);
    assert.ok(live.allowedActions.includes('continue'));
    assert.deepEqual(requests.map(request => request.type), ['state']);
    state = { kind: 'debug', running: true, debug: { active: true, paused: null } };
    const running = await sessionState({ session: selector });
    assert.equal(running.livePause, null);
    assert.equal(running.capabilities.readRecording, false);
    assert.ok(running.allowedActions.includes('pause'));
    assert.ok(!running.allowedActions.includes('continue'));
    assert.ok(!running.allowedActions.includes('context'));
    assert.doesNotMatch(JSON.stringify(running), /private-token|bridge\.sock|"token"|"socket"/);
    state = { kind: 'run', running: true, nav: { active: false, count: 0 }, debug: { active: true, paused: { step: 10, file: '/project/main.js', line: 3 } } };
    const beforeRecording = await sessionState({ session: selector });
    assert.equal(beforeRecording.capabilities.readContext, false);
    assert.ok(!beforeRecording.allowedActions.includes('context'));
    assert.ok(beforeRecording.allowedActions.includes('locals'));
    writeFileSync(join(dir, 'second.json'), JSON.stringify({ file: '/project/other.js', pid: process.pid, socket, token: 'private-token' }));
    await assert.rejects(sessionState({ live: true }), /live sessions/);
    assert.deepEqual(requests.map(request => request.type), ['state', 'state', 'state']);
  } finally {
    for (const client of clients) client.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (prior === undefined) delete process.env.TRACELIGHT_SESSIONS_DIR; else process.env.TRACELIGHT_SESSIONS_DIR = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid source combinations and non-recorded steps are refused', async () => {
  for (const args of [{ run: 'r.json', live: true }, { run: 'r.json', session: 's' }, { step: 0 }, { run: 'r.json', step: -1 }, { run: 'r.json', step: 1.5 }, { live: 'yes' }, { run: '' }, { unexpected: true }]) {
    await assert.rejects(sessionState(args as any));
  }
});
