import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { encodeSteps } from '../src/protocol.ts';
import { openInvestigation, saveInvestigation } from '../src/agent/investigation.ts';

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tracelight-investigation-')));
  const file = join(dir, 'main.mjs'), run = join(dir, 'run.json'), artifact = join(dir, 'question.json');
  const source = 'const total = 7; // RECORDED\nconsole.log(total);\n';
  writeFileSync(file, source);
  const doc = { meta: { runId: 'recorded-id', file, language: 'javascript', workspaceRoot: dir,
    files: [{ path: file, source, sha256: createHash('sha256').update(source).digest('hex') }] }, events: [
    { type: 'file.instrumented', fileId: 1, path: file, rangeBase: 0, ranges: [[1, 0, 1, 16], [2, 0, 2, 19]], statements: [0, 1], functions: [] },
    { type: 'trace', steps: encodeSteps(Int32Array.from([0, 0, 0, 0, 1, 0, 0, 0])), scopes: [{ scopeId: 0, parent: -1, name: '<module>', rid: 0, first: 0, last: 1 }] },
    { type: 'locals', entries: [{ step: 1, scopeId: 0, changes: [{ name: 'total', text: '7' }] }] },
    { type: 'run.finished', exitCode: 0 },
  ] };
  writeFileSync(run, JSON.stringify(doc));
  return { dir, file, run, artifact, doc, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('saves a private artifact and resumes named recorded contexts after source edits', () => {
  const f = fixture();
  try {
    const originalRun = readFileSync(f.run, 'utf8');
    const saved = saveInvestigation({ path: f.artifact, run: f.run, question: 'Where does total come from?', checkpoints: [{ name: 'assignment', step: 0 }, { name: 'output', step: 1 }] });
    assert.equal(saved.run, f.run);
    assert.equal(saved.identity.runId, 'recorded-id');
    assert.equal(saved.identity.steps, 2);
    assert.equal(saved.recording.completed, true);
    assert.equal(saved.recording.exitCode, 0);
    if (process.platform !== 'win32') assert.equal(statSync(f.artifact).mode & 0o777, 0o600);
    const artifact = JSON.parse(readFileSync(f.artifact, 'utf8'));
    assert.equal(artifact.run, relative(f.dir, f.run));
    assert.equal(artifact.version, 1);
    assert.equal(artifact.meta, undefined);
    writeFileSync(f.file, 'throw new Error("must never execute this EDITED file");\n');
    const opened = openInvestigation(f.artifact);
    assert.equal(opened.question, saved.question);
    assert.deepEqual(opened.checkpoints.map(c => c.name), ['assignment', 'output']);
    const context = opened.checkpoints.map(c => c.context.block.lines.map((line: any) => line.text).join('\n')).join('\n');
    assert.match(context, /RECORDED/);
    assert.doesNotMatch(context, /EDITED/);
    assert.equal(readFileSync(f.run, 'utf8'), originalRun);
    assert.match(readFileSync(f.file, 'utf8'), /must never execute/);
  } finally { f.cleanup(); }
});

test('refuses overwrite and changed recording identity without altering either file', () => {
  const f = fixture();
  try {
    const options = { path: f.artifact, run: f.run, question: 'Why seven?', checkpoints: [{ name: 'start', step: 0 }] };
    saveInvestigation(options);
    const artifact = readFileSync(f.artifact, 'utf8');
    assert.throws(() => saveInvestigation({ ...options, question: 'overwrite?' }), /Cannot save investigation.*EEXIST/);
    assert.equal(readFileSync(f.artifact, 'utf8'), artifact);
    writeFileSync(f.run, readFileSync(f.run, 'utf8') + '\n');
    const changed = readFileSync(f.run, 'utf8');
    assert.throws(() => openInvestigation(f.artifact), /recording changed.*SHA256/);
    assert.equal(readFileSync(f.run, 'utf8'), changed);
    assert.equal(readFileSync(f.artifact, 'utf8'), artifact);
  } finally { f.cleanup(); }
});

test('resolves artifact-relative recording after moving the saved pair', () => {
  const f = fixture();
  try {
    saveInvestigation({ path: f.artifact, run: f.run, question: 'Why?', checkpoints: [{ name: 'saved stop', step: 1 }] });
    const moved = join(f.dir, 'moved'); mkdirSync(moved);
    renameSync(f.run, join(moved, 'run.json')); renameSync(f.artifact, join(moved, 'question.json'));
    const result = openInvestigation(join(moved, 'question.json'));
    assert.equal(result.run, join(moved, 'run.json'));
    assert.match(JSON.stringify(result.checkpoints[0]!.context), /RECORDED/);
  } finally { f.cleanup(); }
});

test('canonicalizes symlinked recording and refuses an existing artifact symlink', () => {
  const f = fixture();
  try {
    const alias = join(f.dir, 'alias.json'); symlinkSync(f.run, alias);
    const options = { path: f.artifact, run: alias, question: 'Why?', checkpoints: [{ name: 'start', step: 0 }] };
    assert.equal(saveInvestigation(options).run, f.run);
    const link = join(f.dir, 'artifact-link.json'); symlinkSync(f.artifact, link);
    assert.throws(() => saveInvestigation({ ...options, path: link }), /EEXIST/);
  } finally { f.cleanup(); }
});

test('keeps recording references correct through a symlinked artifact directory', () => {
  const f = fixture();
  try {
    const alias = join(f.dir, 'directory-link'); symlinkSync(f.dir, alias, 'dir');
    const artifact = join(alias, 'linked-question.json');
    const saved = saveInvestigation({ path: artifact, run: f.run, question: 'Why?', checkpoints: [{ name: 'start', step: 0 }] });
    assert.equal(saved.path, join(f.dir, 'linked-question.json'));
    assert.equal(openInvestigation(artifact).run, f.run);
    assert.equal(JSON.parse(readFileSync(artifact, 'utf8')).run, 'run.json');
  } finally { f.cleanup(); }
});

test('rejects invalid checkpoints and bounded inputs before writing', () => {
  const f = fixture();
  try {
    const options = { path: f.artifact, run: f.run, question: 'Why?', checkpoints: [{ name: 'start', step: 0 }] };
    for (const checkpoints of [[{ name: 'bad', step: 2 }], [{ name: 'bad', step: -1 }], [{ name: 'bad', step: 0.5 }], [{ name: 'x', step: 0 }, { name: ' x ', step: 1 }], [{ name: '', step: 0 }], Array.from({ length: 21 }, (_, step) => ({ name: `s${step}`, step }))]) {
      assert.throws(() => saveInvestigation({ ...options, checkpoints }));
    }
    assert.throws(() => saveInvestigation({ ...options, question: 'x'.repeat(4097) }), /question.*4096/);
    assert.throws(() => saveInvestigation({ ...options, checkpoints: [{ name: 'x'.repeat(257), step: 0 }] }), /name.*256/);
    assert.throws(() => readFileSync(f.artifact), /ENOENT/);
  } finally { f.cleanup(); }
});

test('validates artifact version/schema and reports unavailable recorded source explicitly', () => {
  const f = fixture();
  try {
    f.doc.meta.files = [];
    writeFileSync(f.run, JSON.stringify(f.doc));
    const saved = saveInvestigation({ path: f.artifact, run: f.run, question: 'Why?', checkpoints: [{ name: 'start', step: 0 }] });
    assert.deepEqual(saved.checkpoints[0]!.context.block.lines, []);
    assert.ok(saved.notes.some(note => /no recorded copy.*unavailable/.test(note)));
    const artifact = JSON.parse(readFileSync(f.artifact, 'utf8'));
    for (const invalid of [{ ...artifact, version: 2 }, { ...artifact, sha256: 'invalid' }, { ...artifact, checkpoints: [{ name: 'past end', step: 99 }] }]) {
      writeFileSync(f.artifact, JSON.stringify(invalid));
      assert.throws(() => openInvestigation(f.artifact));
    }
  } finally { f.cleanup(); }
});
