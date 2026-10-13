/** `tracelight mcp` as a subprocess: a whole session over JSON-RPC on stdin/stdout. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

test('each tool turns its arguments into the words of one agent command', () => {
  assert.deepEqual(wordsStep({ run: 'r.json', step: 4, move: 'into' }), ['step', '--into', '--', 'r.json', '4']);
  assert.deepEqual(wordsStep({ run: 'r.json', line: 'a.ts:3' }), ['context', '--line=a.ts:3', '--', 'r.json']);
  assert.deepEqual(wordsValue({ action: 'why', run: 'r.json', step: 9, name: 'total' }), ['why', '--', 'r.json', '9', 'total']);
  assert.deepEqual(wordsDebug({ action: 'start', file: 'a.ts', at: ['main'], args: ['x'] }), ['debug', '--live', '--at=main', '--', 'a.ts', '--args', 'x']);
  assert.deepEqual(wordsDebug({ action: 'break', add: ['a.ts:7'], when: 'count > 1', log_message: 'count={count}', clear: true }), ['break', '--live', '--when=count > 1', '--log-message=count={count}', '--clear', '--', 'a.ts:7']);
  assert.deepEqual(wordsDebug({ action: 'locals', frame: 2, names_only: true, names: ['total', 'payload'] }), ['locals', '--live', '--frame=2', '--names-only', '--name=total', '--name=payload']);
  assert.deepEqual(wordsDebug({ action: 'locals', names_only: false }), ['locals', '--live']);
  assert.throws(() => wordsDebug({ action: 'locals', names_only: 'true' }), /names_only must be a boolean/);
  assert.throws(() => wordsDebug({ action: 'locals', names: [] }), /names must contain/);
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
    assert.deepEqual(list.result.tools.map((t: any) => t.name), ['tracelight_run', 'tracelight_map', 'tracelight_step', 'tracelight_value', 'tracelight_coverage', 'tracelight_debug', 'tracelight_investigate', 'tracelight_verify', 'tracelight_session', 'tracelight_seek', 'tracelight_save_investigation', 'tracelight_open_investigation']);
    assert.match(list.result.tools[1].description, /- walkthrough: \S/, 'action help comes from the verbs');
    for (const name of ['tracelight_investigate', 'tracelight_verify']) {
      const tool = list.result.tools.find((t: any) => t.name === name);
      assert.equal(tool.annotations.readOnlyHint, true);
      assert.equal(tool.annotations.openWorldHint, false);
      assert.equal(tool.inputSchema.additionalProperties, false);
      const limit = tool.inputSchema.properties.limit;
      assert.equal(limit.type, 'integer');
      assert.equal(limit.minimum, 1);
      assert.equal(limit.maximum, 100);
      assert.equal(limit.default, 20);
    }
    const investigate = list.result.tools.find((t: any) => t.name === 'tracelight_investigate');
    const verify = list.result.tools.find((t: any) => t.name === 'tracelight_verify');
    assert.deepEqual(investigate.inputSchema.required, ['run']);
    assert.deepEqual(verify.inputSchema.required, ['before', 'after', 'expect']);
    assert.equal(verify.inputSchema.properties.expect.minItems, 1);
    assert.equal(verify.inputSchema.properties.expect.maxItems, 50);
    assert.equal(verify.inputSchema.properties.ignore.maxItems, 50);

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

test('a Tracelight run is answered in-process', async () => {
  const dir = project({ 'main.mjs': 'function sq(n) {\n  return n * n;\n}\nlet total = 0;\nfor (const x of [1, 2, 3]) total += sq(x);\nconsole.log(total);\n' });
  const { callTool, nativeFor } = await import('../src/mcp/server.ts');
  const run = await callTool('tracelight_run', { file: join(dir, 'main.mjs') });
  assert.equal(run.isError, false, run.content[0].text);
  const file = join(dir, '.tracelight', 'runs', 'main.json');
  assert.ok(nativeFor(['story', '--', file]));
  assert.ok(!nativeFor(['no-such-verb', '--', file]));
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
});

test('a Python file or run is refused with the way to Pyokka', async () => {
  const dir = project({ 'main.py': 'total = 1\n' });
  const { callTool } = await import('../src/mcp/server.ts');
  const run = await callTool('tracelight_run', { file: join(dir, 'main.py') });
  assert.equal(run.isError, true);
  assert.match(run.content[0].text, /it is Python/);
  assert.match(run.content[0].text, /pyokka mcp/);
  mkdirSync(join(dir, 'runs'), { recursive: true });
  const pyRun = join(dir, 'runs', 'py.json');
  writeFileSync(pyRun, JSON.stringify({ meta: { language: 'python' }, events: [] }));
  const story = await callTool('tracelight_map', { action: 'story', run: pyRun });
  assert.equal(story.isError, true);
  assert.match(story.content[0].text, /not a recording of a JavaScript or TypeScript run/);
});

/** Successful evidence tools return the same bounded document in both MCP representations. */
function evidence(result: any, limit = 20): any {
  assert.equal(result.isError, false, result.content?.[0]?.text);
  assert.equal(result.content[0].type, 'text');
  const doc = JSON.parse(result.content[0].text);
  assert.deepEqual(result.structuredContent, doc);
  assert.equal(doc.response.limit, limit);
  assert.equal(doc.response.maxBytes, 32768);
  assert.ok(Array.isArray(doc.response.omissions));
  for (const omission of doc.response.omissions) {
    assert.equal(typeof omission.path, 'string');
    assert.ok(typeof omission.reason === 'string' && omission.reason.length > 0);
  }
  assert.ok(Buffer.byteLength(result.content[0].text, 'utf8') <= 32768, 'evidence stays within its byte budget');
  return doc;
}

function filesIn(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => {
      const file = join(entry.parentPath, entry.name);
      return [file, readFileSync(file).toString('base64')];
    }));
}

test('saved-run evidence tools over stdio investigate and verify without executing or writing', async () => {
  const dir = project({ 'count.txt': '0' });
  const counter = join(dir, 'count.txt');
  const file = join(dir, 'main.mjs');
  writeFileSync(file, `import { readFileSync, writeFileSync } from 'node:fs';
const counter = ${JSON.stringify(counter)};
writeFileSync(counter, String(Number(readFileSync(counter, 'utf8')) + 1));
function add(a, b) { return a + b; }
let total = 0;
for (const i of [1, 2, 3, 4, 5, 6, 7, 8]) total = add(total, i);
console.log(total);
`);
  const s = session();
  try {
    const recorded = await s.call('tools/call', { name: 'tracelight_run', arguments: { file } });
    assert.equal(recorded.result.isError, false, text(recorded));
    const run = join(dir, '.tracelight', 'runs', 'main.json');
    assert.equal(readFileSync(counter, 'utf8'), '1');
    const original = filesIn(dir);

    const investigation = evidence((await s.call('tools/call', { name: 'tracelight_investigate', arguments: { run, value: 'total' } })).result);
    assert.equal(investigation.run, run);
    for (const key of ['history', 'context', 'why', 'origin', 'exceptions', 'coverage']) assert.ok(investigation[key], key);
    assert.equal(investigation.history.changes.at(-1).text, '36');
    const at = investigation.step;
    assert.ok(Number.isInteger(at) && at >= 0);
    const selected = evidence((await s.call('tools/call', { name: 'tracelight_investigate', arguments: { run, value: 'total', at } })).result);
    assert.equal(selected.step, at);
    const start = evidence((await s.call('tools/call', { name: 'tracelight_investigate', arguments: { run, at: 0, limit: 100 } })).result, 100);
    assert.equal(start.step, 0);

    const passing = evidence((await s.call('tools/call', { name: 'tracelight_verify', arguments: { before: run, after: run, expect: ['total=36'], ignore: ['counter'] } })).result);
    assert.equal(passing.before, run);
    assert.equal(passing.after, run);
    assert.equal(passing.verified, true);
    assert.equal(passing.checks[0].actual, '36');
    const mismatch = evidence((await s.call('tools/call', { name: 'tracelight_verify', arguments: { before: run, after: run, expect: ['total=37'] } })).result);
    assert.equal(mismatch.verified, false);
    assert.equal(mismatch.checks[0].passed, false);

    const limited = evidence((await s.call('tools/call', { name: 'tracelight_investigate', arguments: { run, value: 'total', limit: 2 } })).result, 2);
    assert.ok(limited.history.changes.length <= 2);
    assert.ok(limited.response.omissions.some((o: any) => o.path.includes('history.changes')), 'history reductions are explicit');
    const manyChecks = Array.from({ length: 5 }, () => 'total=36');
    const small = evidence((await s.call('tools/call', { name: 'tracelight_verify', arguments: { before: run, after: run, expect: manyChecks, limit: 2 } })).result, 2);
    assert.equal(small.checks.length, manyChecks.length, 'detail limits do not hide verification decisions');
    assert.equal(small.verified, true);

    assert.equal(readFileSync(counter, 'utf8'), '1', 'saved-run tools never rerun the target');
    assert.deepEqual(filesIn(dir), original, 'evidence calls do not create or modify files');

    const capped = JSON.parse(readFileSync(run, 'utf8'));
    const trace = capped.events.findLast((e: any) => e.type === 'trace' && !e.partial);
    Object.assign(trace, { truncated: true, cap: 1, stepsRun: trace.stepsRun ?? capped.meta.stepCount });
    const cut = join(dir, 'cut.json');
    writeFileSync(cut, JSON.stringify(capped));
    const cappedFiles = filesIn(dir);
    const incomplete = evidence((await s.call('tools/call', { name: 'tracelight_verify', arguments: { before: run, after: cut, expect: ['total=36'] } })).result);
    assert.equal(incomplete.verified, false);
    assert.equal(incomplete.checks[0].actual, '36');
    assert.equal(incomplete.checks[0].passed, false);
    assert.match(incomplete.checks[0].reason, /complete recording/i);
    assert.deepEqual(filesIn(dir), cappedFiles);

    const { callTool } = await import('../src/mcp/server.ts');
    const invalid: [string, Record<string, any>, RegExp][] = [
      ['tracelight_investigate', {}, /run/i],
      ['tracelight_investigate', { run, limit: 0 }, /limit/i],
      ['tracelight_investigate', { run, limit: 101 }, /limit/i],
      ['tracelight_investigate', { run, limit: 1.5 }, /limit/i],
      ['tracelight_investigate', { run, limit: '2' }, /limit/i],
      ['tracelight_investigate', { run, at: -1 }, /at/i],
      ['tracelight_investigate', { run, at: 1.5 }, /at/i],
      ['tracelight_investigate', { run, live: true }, /live/i],
      ['tracelight_investigate', { run, session: 'editor' }, /session/i],
      ['tracelight_investigate', { run, rerun: true }, /rerun/i],
      ['tracelight_verify', { before: run, after: run }, /expect/i],
      ['tracelight_verify', { before: run, after: run, expect: [] }, /expect/i],
      ['tracelight_verify', { before: run, after: run, expect: ['total'] }, /expect|NAME=TEXT/i],
      ['tracelight_verify', { before: run, after: run, expect: ['=36'] }, /expect|NAME=TEXT/i],
      ['tracelight_verify', { before: run, after: run, expect: 'total=36' }, /expect/i],
      ['tracelight_verify', { before: run, after: run, expect: Array(51).fill('total=36') }, /expect/i],
      ['tracelight_verify', { before: run, after: run, expect: ['total=36'], ignore: Array(51).fill('counter') }, /ignore/i],
      ['tracelight_verify', { before: run, after: run, expect: ['total=36'], ignore: [1] }, /ignore/i],
      ['tracelight_verify', { before: run, after: run, expect: ['total=36'], limit: 0 }, /limit/i],
      ['tracelight_verify', { before: run, after: run, expect: ['total=36'], limit: 101 }, /limit/i],
      ['tracelight_verify', { before: run, after: run, expect: ['total=36'], rerun: true }, /rerun/i],
      ['tracelight_verify', { before: run, after: run, expect: ['total=36'], test_out: join(dir, 'unexpected.test.mjs') }, /test_out/i],
      ['tracelight_verify', { before: run, after: run, expect: ['total=36'], out: join(dir, 'unexpected.json') }, /out/i],
      ['tracelight_verify', { before: run, after: run, expect: ['total=36'], live: true }, /live/i],
    ];
    for (const [name, args, message] of invalid) {
      const rejected = await callTool(name, args);
      assert.equal(rejected.isError, true, `${name} accepted ${JSON.stringify(args)}`);
      assert.match(rejected.content[0].text, message);
    }
    assert.equal(readFileSync(counter, 'utf8'), '1');
    assert.deepEqual(filesIn(dir), cappedFiles, 'invalid requests also do not write or rerun');
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
