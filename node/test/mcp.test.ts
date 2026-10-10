/** `tracelight mcp` as a subprocess: a whole session over JSON-RPC on stdin/stdout. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { project } from './helpers.ts';
import { wordsDebug, wordsStep, wordsValue } from '../src/mcp/server.ts';

const BIN = resolve(import.meta.dirname, '../bin/tracelight.mjs');

function session() {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', BIN, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines: string[] = [];
  const waiting: ((l: string) => void)[] = [];
  createInterface({ input: child.stdout }).on('line', (l) => {
    const w = waiting.shift();
    if (w) w(l);
    else lines.push(l);
  });
  let id = 0;
  const next = () => new Promise<string>((r) => (lines.length ? r(lines.shift()!) : waiting.push(r)));
  return {
    async call(method: string, params?: unknown): Promise<any> {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n');
      const reply = JSON.parse(await next());
      assert.equal(reply.id, id);
      return reply;
    },
    async raw(text: string): Promise<any> {
      child.stdin.write(text + '\n');
      return JSON.parse(await next());
    },
    notify(method: string) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
    },
    close: () => child.stdin.end(),
  };
}

const text = (r: any) => r.result.content[0].text as string;

test('a call becomes the words of the agent command', () => {
  assert.deepEqual(wordsStep({ run: 'r.json', step: 4, move: 'into' }), ['step', '--into', '--', 'r.json', '4']);
  assert.deepEqual(wordsStep({ run: 'r.json', line: 'a.ts:3' }), ['context', '--line=a.ts:3', '--', 'r.json']);
  assert.deepEqual(wordsValue({ action: 'why', run: 'r.json', step: 9, name: 'total' }), ['why', '--', 'r.json', '9', 'total']);
  assert.deepEqual(wordsDebug({ action: 'start', file: 'a.ts', at: ['main'], args: ['x'] }), ['debug', '--live', '--at=main', '--', 'a.ts', '--args', 'x']);
  assert.throws(() => wordsStep({ run: 'r.json', move: 'sideways', step: 1 }), /unknown move/);
});

test('a session: initialize, tools/list, run, map, step, value, errors', async () => {
  const dir = project({ 'main.mjs': 'function sq(n) {\n  return n * n;\n}\nlet total = 0;\nfor (const x of [1, 2, 3]) total += sq(x);\nconsole.log(total);\n' });
  const s = session();
  try {
    const init = await s.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'tracelight');
    s.notify('notifications/initialized');
    const list = await s.call('tools/list');
    assert.deepEqual(list.result.tools.map((t: any) => t.name), ['tracelight_run', 'tracelight_map', 'tracelight_step', 'tracelight_value', 'tracelight_coverage', 'tracelight_debug']);
    assert.match(list.result.tools[1].description, /- walkthrough: \S/, 'action help comes from the agent commands');

    const run = await s.call('tools/call', { name: 'tracelight_run', arguments: { file: join(dir, 'main.mjs') } });
    assert.equal(run.result.isError, false, text(run));
    const saved = join(dir, '.tracelight', 'runs', 'main.json');
    assert.match(text(run), new RegExp(`run: ${saved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.ok(existsSync(saved));

    const story = await s.call('tools/call', { name: 'tracelight_map', arguments: { action: 'story', run: saved } });
    assert.equal(story.result.isError, false, text(story));
    assert.match(text(story), /sq/);
    const step = await s.call('tools/call', { name: 'tracelight_step', arguments: { run: saved, step: 1 } });
    assert.equal(step.result.isError, false, text(step));
    const v = await s.call('tools/call', { name: 'tracelight_value', arguments: { action: 'var', run: saved, name: 'total' } });
    assert.equal(v.result.isError, false, text(v));
    assert.match(text(v), /14/);

    const bad = await s.call('tools/call', { name: 'tracelight_step', arguments: { run: saved } });
    assert.equal(bad.result.isError, true);
    assert.match(text(bad), /give `step` or `line`/);
    const missing = await s.call('tools/call', { name: 'tracelight_run', arguments: { file: join(dir, 'nope.ts') } });
    assert.equal(missing.result.isError, true);
    assert.equal((await s.call('tools/call', { name: 'nope', arguments: {} })).error.code, -32602);
    assert.equal((await s.call('bogus')).error.code, -32601);
    assert.equal((await s.raw('{not json')).error.code, -32700);
  } finally {
    s.close();
  }
});

test('every tool answers in-process, and a command this runtime lacks is an error', async () => {
  const dir = project({ 'main.mjs': 'function sq(n) {\n  return n * n;\n}\nlet total = 0;\nfor (const x of [1, 2, 3]) total += sq(x);\nconsole.log(total);\n' });
  const { callTool } = await import('../src/mcp/server.ts');
  const run = await callTool('tracelight_run', { file: join(dir, 'main.mjs') });
  assert.equal(run.isError, false, run.content[0].text);
  const file = join(dir, '.tracelight', 'runs', 'main.json');
  const story = await callTool('tracelight_map', { action: 'story', run: file });
  assert.equal(story.isError, false, story.content[0].text);
  assert.match(story.content[0].text, /sq/);
  const step = await callTool('tracelight_step', { run: file, step: 1 });
  assert.equal(step.isError, false, step.content[0].text);
  const v = await callTool('tracelight_value', { action: 'var', run: file, name: 'total' });
  assert.equal(v.isError, false, v.content[0].text);
  assert.match(v.content[0].text, /14/);
  const bad = await callTool('tracelight_step', { run: file, step: 99999 });
  assert.equal(bad.isError, true);
  const py = await callTool('tracelight_run', { file: join(dir, 'main.mjs').replace(/\.mjs$/, '.py') });
  assert.equal(py.isError, true);
});
