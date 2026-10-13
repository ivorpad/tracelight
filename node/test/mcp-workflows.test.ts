import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { project } from './helpers.ts';
import { recordRun } from '../src/cli.ts';
import { callTool } from '../src/mcp/server.ts';
import { SavedRun } from '../src/agent/source.ts';

let dir: string, file: string, run: string, counter: string, outputLine: number;
before(async () => {
  dir = project({ 'count.txt': '0' });
  counter = join(dir, 'count.txt'); file = join(dir, 'main.mjs'); run = join(dir, 'run.json');
  const source = `import { readFileSync, writeFileSync } from 'node:fs';
const counter = ${JSON.stringify(counter)};
writeFileSync(counter, String(Number(readFileSync(counter, 'utf8')) + 1));
let total = 0;
for (const round of [1, 2]) {
  total = Number('not a number');
  console.log(total);
  total = 4;
}
console.log(total);
`;
  writeFileSync(file, source);
  outputLine = source.split('\n').findIndex(line => line.trim() === 'console.log(total);') + 1;
  await recordRun({ file, save: run, json: true, autoLog: false, recordLocals: true, timeoutMs: 10000, argv: [] });
  assert.equal(readFileSync(counter, 'utf8'), '1');
});
after(() => rmSync(dir, { recursive: true, force: true }));

function files(): Record<string, string> {
  return Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => { const path = join(entry.parentPath, entry.name); return [path, readFileSync(path).toString('base64')]; }));
}
async function answer(name: string, args: Record<string, any>) {
  const result = await callTool(name, args);
  assert.equal(result.isError, false, result.content[0].text);
  const payload = JSON.parse(result.content[0].text);
  assert.deepEqual(payload, result.structuredContent, `${name} text and structured evidence must agree`);
  assert.ok(Buffer.byteLength(result.content[0].text, 'utf8') <= 32768);
  assert.equal(payload.response.maxBytes, 32768);
  return payload;
}

test('recorded session exposes an explicit selection independent of a live pause', async () => {
  const original = files();
  const discovered = await answer('tracelight_session', {});
  assert.equal(discovered.mode, 'list');
  assert.equal(discovered.visibleEditor, null);
  assert.ok(Array.isArray(discovered.sessions));
  for (const descriptor of discovered.sessions) {
    for (const secret of ['token', 'socket', 'port', 'auth', 'controlToken']) assert.equal(descriptor[secret], undefined);
  }
  const step = new SavedRun(run).trace.count - 1;
  const result = await answer('tracelight_session', { run, step });
  assert.equal(result.mode, 'recorded');
  assert.equal(result.run, run);
  assert.equal(result.running, false);
  assert.equal(result.finished, true);
  assert.equal(result.livePause, null);
  assert.equal(result.visibleEditor, null);
  assert.equal(result.recordedSelection.active, true);
  assert.equal(result.recordedSelection.step, step);
  assert.equal(result.context.step, step);
  assert.equal(result.capabilities.liveControl, false);
  assert.equal(result.capabilities.recordedNavigation, true);
  assert.deepEqual(files(), original);
});

test('value seek first and last land on the observed NaN, and line seek returns recorded destinations', async () => {
  const original = files();
  const first = await answer('tracelight_seek', { run, value: 'total', equals: 'NaN', occurrence: 'first' });
  const last = await answer('tracelight_seek', { run, value: 'total', equals: 'NaN', occurrence: 'last' });
  for (const result of [first, last]) {
    assert.equal(result.found, true);
    assert.equal(result.evidence.text, 'NaN');
    assert.equal(result.evidence.name, 'total');
    assert.equal(result.step, result.selection.observedStep);
    assert.ok(result.selection.observedStep > result.selection.changeStep, 'the stop after the writer sees its changed value');
    assert.equal(result.context.step, result.step);
    assert.ok(result.context.values.some((value: any) => value.context === 'total' && value.text === 'NaN'), JSON.stringify(result.context.values));
    assert.deepEqual(result.next, { tool: 'tracelight_step', arguments: { run, step: result.step } });
  }
  assert.ok(first.matches >= 2);
  assert.ok(last.step > first.step);
  const lineFirst = await answer('tracelight_seek', { run, file, line: outputLine, occurrence: 'first' });
  const lineLast = await answer('tracelight_seek', { run, file, line: outputLine, occurrence: 'last' });
  assert.equal(lineFirst.found, true);
  assert.equal(lineLast.found, true);
  assert.equal(lineFirst.context.location.line, outputLine);
  assert.equal(lineLast.context.location.line, outputLine);
  assert.ok(lineLast.step > lineFirst.step);
  assert.deepEqual(files(), original);
});

test('missing seek match is a structured answer with incomplete-recording caveats', async () => {
  const doc = JSON.parse(readFileSync(run, 'utf8'));
  Object.assign(doc.events.findLast((event: any) => event.type === 'trace' && !event.partial), { truncated: true, cap: 2, stepsRun: 100 });
  const incomplete = join(dir, 'incomplete.json');
  writeFileSync(incomplete, JSON.stringify(doc));
  const original = files();
  const value = await answer('tracelight_seek', { run: incomplete, value: 'total', equals: '999' });
  assert.equal(value.found, false);
  assert.equal(value.matches, 0);
  assert.equal(value.context, undefined);
  assert.ok(value.notes.some((note: string) => /incomplete.*does not prove/.test(note)));
  const line = await answer('tracelight_seek', { run, file, line: 999 });
  assert.equal(line.found, false);
  assert.equal(line.matches, 0);
  assert.deepEqual(files(), original);
});

test('explicit save is the only write; open preserves recorded source and rejects recording hash changes', async () => {
  const source = readFileSync(file, 'utf8');
  const recording = readFileSync(run, 'utf8');
  const artifact = join(dir, 'saved-investigation.json');
  const destination = await answer('tracelight_seek', { run, value: 'total', equals: 'NaN' });
  const original = files();
  const saved = await answer('tracelight_save_investigation', { path: artifact, run, question: 'Why is total NaN?', checkpoints: [{ name: 'first bad value', step: destination.step }] });
  assert.equal(saved.run, run);
  assert.equal(saved.path, artifact);
  assert.equal(saved.question, 'Why is total NaN?');
  assert.equal(saved.checkpoints[0].step, destination.step);
  if (process.platform !== 'win32') assert.equal(statSync(artifact).mode & 0o777, 0o600);
  const afterSave = files();
  const withoutArtifact = { ...afterSave }; delete withoutArtifact[artifact];
  assert.deepEqual(withoutArtifact, original, 'save only creates the requested artifact');
  const existing = await callTool('tracelight_save_investigation', { path: artifact, run, question: 'overwrite?', checkpoints: [{ name: 'start', step: 0 }] });
  assert.equal(existing.isError, true);
  assert.match(existing.content[0].text, /EEXIST/);
  assert.deepEqual(files(), afterSave);
  try {
    writeFileSync(file, 'throw new Error("EDITED source must not run");\n');
    const edited = files();
    const opened = await answer('tracelight_open_investigation', { path: artifact });
    assert.equal(opened.question, saved.question);
    assert.equal(opened.sha256, saved.sha256);
    assert.equal(opened.checkpoints[0].name, 'first bad value');
    const context = opened.checkpoints[0].context.block.lines.map((line: any) => line.text).join('\n');
    assert.match(context, /Number\('not a number'\)/);
    assert.doesNotMatch(context, /EDITED/);
    assert.deepEqual(files(), edited, 'open never writes or reruns');
    writeFileSync(run, recording + '\n');
    const changed = files();
    const rejected = await callTool('tracelight_open_investigation', { path: artifact });
    assert.equal(rejected.isError, true);
    assert.equal(rejected.structuredContent, undefined);
    assert.match(rejected.content[0].text, /recording changed.*SHA256/);
    assert.deepEqual(files(), changed);
  } finally { writeFileSync(file, source); writeFileSync(run, recording); }
  assert.equal(readFileSync(counter, 'utf8'), '1');
});

test('workflow arguments reject ambiguous sources, invalid selectors and implicit execution or writes', async () => {
  const original = files();
  const artifact = join(dir, 'must-not-exist.json');
  const invalid: [string, Record<string, any>, RegExp][] = [
    ['tracelight_session', { run, rerun: true }, /unsupported.*rerun/],
    ['tracelight_session', { run, live: true }, /saved run or a live session/],
    ['tracelight_session', { step: 0 }, /step selects saved-run/],
    ['tracelight_session', { run, step: -1 }, /step/],
    ['tracelight_session', { run, step: 999999 }, /past the recorded/],
    ['tracelight_seek', { run, value: 'total' }, /choose value and equals/],
    ['tracelight_seek', { run, value: 'total', equals: 'NaN', file, line: 1 }, /choose value and equals/],
    ['tracelight_seek', { run, value: 'total', equals: 'NaN', occurrence: 'middle' }, /occurrence/],
    ['tracelight_seek', { run, file, line: 0 }, /line/],
    ['tracelight_seek', { run, value: 'total', equals: 'NaN', out: artifact }, /unsupported.*out/],
    ['tracelight_seek', { run, value: 'total', equals: 'NaN', live: true }, /unsupported.*live/],
    ['tracelight_open_investigation', { path: artifact, rerun: true }, /unsupported.*rerun/],
    ['tracelight_open_investigation', {}, /path.*required/],
    ['tracelight_save_investigation', { path: artifact, run, question: 'Why?', checkpoints: [] }, /invalid item count/],
    ['tracelight_save_investigation', { path: artifact, run, question: 'Why?', checkpoints: [{ name: 'bad', step: 999999 }] }, /past the recorded/],
    ['tracelight_save_investigation', { path: artifact, run, question: 'Why?', checkpoints: [{ name: 'bad', step: 0, exec: 'total = 9' }] }, /unsupported.*exec/],
  ];
  for (const [name, args, pattern] of invalid) {
    const result = await callTool(name, args);
    assert.equal(result.isError, true, `${name} accepted ${JSON.stringify(args)}`);
    assert.match(result.content[0].text, pattern);
    assert.equal(result.structuredContent, undefined);
  }
  assert.deepEqual(files(), original);
  assert.equal(readFileSync(counter, 'utf8'), '1');
});
