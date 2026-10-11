/**
 * `tracelight tour`: chapters, candidates, value shaping, the budget, and `--prose` (the validator
 * and the merge), as Pyokka's python/tests/test_tour.py and test_tour_prose.py, over a small
 * multi-file JavaScript/TypeScript program. The source-parsing parts (statements, calls, what a
 * call reaches) are the oxc port's own; Python's reading of the same run parses the sources as
 * Python, so only the data-only parts are compared with it.
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { project } from './helpers.ts';
import { dispatchVerb, type Io } from '../src/agent/commands.ts';
import { SavedRun } from '../src/agent/source.ts';
import '../src/agent/verbs.ts';
import { FileInfo, bindsCall, classifyCall, isDefinition, isForward, moduleRoots, ownCalls } from '../src/agent/tour/astinfo.ts';
import { buildTour, stableKey } from '../src/agent/tour/build.ts';
import { TourRun } from '../src/agent/tour/model.ts';
import { ProseRejected, applyProse, checkProse, normNumber } from '../src/agent/tour/prose.ts';
import { renderTour } from '../src/agent/tour/text.ts';
import { NOISE, evidence, shape, tokens } from '../src/agent/tour/values.ts';

type Msg = Record<string, any>;

const BIN = resolve(import.meta.dirname, '../bin/tracelight.mjs');
const FIXTURE = resolve(import.meta.dirname, '../../test/unit/fixtures/tour-rrf.json');
const PY = resolve(import.meta.dirname, '../../python');
const havePython = spawnSync('python3', ['-c', 'import sys; assert sys.version_info >= (3, 12)']).status === 0;

const TEXT_TS = `// Splits text into lowercase words.
export function words(text: string): string[] {
  return text.toLowerCase().split(/\\W+/).filter((w) => w.length > 2);
}

export interface Doc {
  id: string;
  text: string;
}

export function makeDoc(id: string, text: string): Doc {
  const doc: Doc = { id, text };
  return doc;
}
`;
const INDEX = `import { words } from './text.ts';

export class Index {
  constructor() {
    this.postings = new Map();
  }
  add(doc) {
    const ws = words(doc.text);
    for (const w of ws) {
      if (!this.postings.has(w)) {
        this.postings.set(w, []);
      }
      this.postings.get(w).push(doc.id);
    }
    return ws.length;
  }
  search(query) {
    const hits = new Map();
    for (const w of words(query)) {
      for (const id of this.postings.get(w) ?? []) {
        hits.set(id, (hits.get(id) ?? 0) + 1);
      }
    }
    return [...hits.entries()].sort((a, b) => b[1] - a[1]);
  }
}
`;
const APP = `import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeDoc } from './text.ts';
import { Index } from './index.mjs';

const TOPICS = ['button', 'form', 'table', 'modal', 'tooltip', 'menu', 'card', 'badge'];

function loadDocs(n) {
  const docs = [];
  for (let i = 0; i < n; i++) {
    const topic = TOPICS[i % TOPICS.length];
    docs.push(makeDoc(\`D\${i}\`, \`The \${topic} component number \${i} with primary variants and keyboard support\`));
  }
  return docs;
}

function buildIndex(docs) {
  const index = new Index();
  let total = 0;
  for (const doc of docs) {
    total += index.add(doc);
  }
  console.log(\`indexed \${docs.length} docs, \${total} words\`);
  return index;
}

function report(results) {
  const lines = results.slice(0, 3).map(([id, n]) => \`\${id}:\${n}\`);
  const path = join(tmpdir(), 'tour-report.txt');
  writeFileSync(path, lines.join('\\n'));
  const echoed = execFileSync(process.execPath, ['-e', 'process.stdout.write("ok")']).toString();
  return \`\${lines.join(' ')} (\${echoed})\`;
}

function main() {
  const docs = loadDocs(24);
  const index = buildIndex(docs);
  const results = index.search('primary button component');
  const summary = report(results);
  console.log(\`top: \${summary}\`);
}

main();
`;
// a run under 60 walkthrough moments: one chapter of the walkthrough's moments
const SMALL = `import { makeDoc } from './text.ts';

function check(rows) {
  if (rows.length === 0) {
    throw new Error('no rows');
  }
  return rows[0];
}

console.log('RANKING');
const rows = [makeDoc('A', 'primary button'), makeDoc('B', 'form input')];
const best = check(rows);
try {
  check([]);
} catch (e) {
  console.log('caught', e.message);
}
console.log(\`best \${best.id}\`);
`;

let dir = '';
let bigPath = '';
let smallPath = '';
let big: SavedRun;
let small: SavedRun;
const tours = new Map<string, Msg>();

function save(main: string, out: string): string {
  const path = join(dir, out);
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', BIN, 'run', join(dir, main), '--save', path], { cwd: dir, encoding: 'utf8' });
  assert.match(r.stderr, /^saved /m, r.stderr);
  return path;
}

function tour(name: 'big' | 'small'): Msg {
  if (!tours.has(name)) tours.set(name, buildTour(name === 'big' ? big : small));
  return tours.get(name)!;
}

async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const io: Io = { out: (t) => void (out += t), err: (t) => void (err += t) };
  const code = await dispatchVerb(argv[0]!, argv.slice(1), io);
  return { code, out, err };
}

before(() => {
  dir = project({ 'app.mjs': APP, 'index.mjs': INDEX, 'text.ts': TEXT_TS, 'small.mjs': SMALL });
  bigPath = save('app.mjs', 'app.json');
  smallPath = save('small.mjs', 'small.json');
  big = new SavedRun(bigPath);
  small = new SavedRun(smallPath);
});

// -- astinfo: the oxc port of Python's `ast` facts --------------------------------------------------------------

test('FileInfo: statements by line, imports, definitions, statement text', () => {
  const info = new FileInfo(APP.split('\n'), 'app.mjs');
  assert.ok(info.ok);
  assert.deepEqual(info.imports.get('writeFileSync'), { module: 'node:fs', name: 'writeFileSync' });
  assert.deepEqual(info.imports.get('Index'), { module: './index.mjs', name: 'Index' });
  for (const d of ['loadDocs', 'buildIndex', 'report', 'main']) assert.ok(info.defs.has(d), d);
  assert.equal(info.statementText(14), 'docs.push(makeDoc(`D${i}`, `The ${topic} component number ${i} with primary variants and keyboard support`));');
  assert.equal(info.statementText(12), 'for (let i = 0; i < n; i++) {'); // a compound statement: its header only
  assert.equal(info.statementText(10), 'function loadDocs(n) {');
  const ts = new FileInfo(TEXT_TS.split('\n'), 'text.ts');
  assert.ok(ts.ok && ts.defs.has('words') && ts.defs.has('makeDoc'));
  assert.equal(ts.statementText(12), 'const doc: Doc = { id, text };'); // the TypeScript source, not the lowered JavaScript
  const cls = new FileInfo(INDEX.split('\n'), 'index.mjs');
  assert.ok(cls.defs.has('Index') && cls.defs.has('add') && cls.defs.has('search'));
  assert.ok(isDefinition(cls.at(7, 2), cls.statementText(7, 2))); // `add(doc) {`, a method header
  assert.ok(!new FileInfo(['def f(x):', '    return x'], 'x.py').ok); // not JavaScript: no facts
});

test('own calls, what they reach, binding and forwarding', () => {
  const info = new FileInfo(APP.split('\n'), 'app.mjs');
  const roots = moduleRoots([join(dir, 'app.mjs'), join(dir, 'index.mjs')]);
  const defs = new Set(['loadDocs', 'buildIndex', 'report', 'main', 'add', 'search', 'makeDoc', 'words']);
  const kinds = (line: number) => ownCalls(info.at(line)).map((c) => classifyCall(c, info, roots, defs, null));
  assert.deepEqual(kinds(32), [['io-write', 'writeFileSync'], ['builtin', 'lines.join']]);
  assert.deepEqual(kinds(33)[0], ['subprocess', 'execFileSync']);
  assert.deepEqual(kinds(31), [['stdlib', 'join'], ['stdlib', 'tmpdir']]);
  assert.deepEqual(kinds(20), [['user', 'Index']]);
  assert.deepEqual(kinds(25), [['builtin', 'console.log']]);
  assert.deepEqual(kinds(12), []); // a `for` header calls nothing of its own
  assert.deepEqual(kinds(14).map((k) => k[0]), ['builtin', 'user']);
  assert.ok(bindsCall(info.at(39)) && bindsCall(info.at(23)) && !bindsCall(info.at(25)) && !bindsCall(info.at(8)));
  const fwd = new FileInfo(['async function f(g, x) {', '  return g(x);', '}', 'async function h(g) {', '  await g();', '  return 1;', '}', 'function k(y) { return y; }'], 'f.mjs');
  assert.ok(isForward(fwd.at(2)) && isForward(fwd.at(5)) && !isForward(fwd.at(6)));
  assert.ok(isForward(fwd.byPos.get('8:16'))); // `return y`, a name handed on
  const lib = new FileInfo(["import _ from 'lodash';", "const out = _.sortBy([3, 1], (x) => x);", 'const s = items.custom();'], 'l.mjs');
  assert.deepEqual(classifyCall(ownCalls(lib.at(2))[0], lib, roots, defs, null), ['lib', '_.sortBy']);
  assert.deepEqual(classifyCall(ownCalls(lib.at(3))[0], lib, roots, defs, null), ['lib', 'items.custom']);
  assert.deepEqual(classifyCall(ownCalls(lib.at(3))[0], lib, roots, defs, 'Thing.custom'), ['user', 'items.custom']); // it entered a recorded frame
});

// -- the tour ------------------------------------------------------------------------------------------------------

test('a small run is its walkthrough in one chapter', () => {
  const doc = tour('small');
  assert.equal(doc.small, true);
  assert.deepEqual(doc.chapters.map((c: Msg) => [c.id, c.kind]), [['c1', 'walkthrough']]);
  const kinds = new Set(doc.candidates.flatMap((c: Msg) => c.signals.map((s: Msg) => s.signal.split(':')[0])));
  assert.ok(kinds.has('walkthrough') && kinds.has('spine'));
  assert.ok(doc.candidates.some((c: Msg) => c.signals.some((s: Msg) => s.signal === 'exception:handled')));
  assert.equal(doc.goal.kind, 'output');
  assert.equal(doc.goal.text, 'best A');
  assert.equal(tour('big').small, false);
});

test('chapters are the calls main makes, the short last one folded in', () => {
  const doc = tour('big');
  assert.deepEqual(
    doc.chapters.map((c: Msg) => [c.title, c.kind]),
    [
      ['loadDocs', 'call'],
      ['buildIndex', 'call'],
      ['Index.search', 'call'],
    ],
  );
  assert.deepEqual(doc.chapters[2].opens, ['Index.search', 'report']);
  assert.equal(doc.chapters[0].steps[0], 0);
  assert.equal(doc.chapters[2].steps[1], doc.run.steps - 1);
  for (let k = 1; k < doc.chapters.length; k++) assert.equal(doc.chapters[k].steps[0], doc.chapters[k - 1].steps[1] + 1); // no gaps
  assert.ok(Math.abs(doc.chapters.reduce((s: number, c: Msg) => s + c.share, 0) - 1) < 0.001);
  assert.equal(doc.chapters.reduce((s: number, c: Msg) => s + c.candidates, 0), doc.candidates.length);
});

test('the JSON keeps the Python tour shape: key names and order', () => {
  const py = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const doc = tour('big');
  assert.deepEqual(Object.keys(doc), Object.keys(py));
  assert.deepEqual(Object.keys(doc.run), Object.keys(py.run));
  assert.deepEqual(Object.keys(doc.goal), Object.keys(py.goal));
  assert.deepEqual(Object.keys(doc.budget), Object.keys(py.budget));
  assert.deepEqual(Object.keys(doc.timing), Object.keys(py.timing));
  assert.deepEqual(Object.keys(doc.chapters[0]), Object.keys(py.chapters[0]));
  const optional = (k: string) => k !== 'setup' && k !== 'repeat';
  for (const c of doc.candidates) assert.deepEqual(Object.keys(c).filter(optional), Object.keys(py.candidates[0]));
  const pyValue = py.candidates.flatMap((c: Msg) => c.values).find((v: Msg) => !v.truncated && !v.cut && !v.sameAs);
  const value = doc.candidates.flatMap((c: Msg) => c.values).find((v: Msg) => !v.cut && !v.sameAs && !v.like);
  assert.deepEqual(Object.keys(value), Object.keys(pyValue));
  assert.equal(doc.tour, 1);
  assert.equal(doc.budget.found, doc.budget.kept + doc.budget.dropped);
});

test('candidate shape and stable ids', () => {
  const doc = tour('big');
  const c = doc.candidates.find((x: Msg) => x.statement === 'const summary = report(results);')!;
  assert.ok(c, 'the line that keeps report()');
  assert.equal(c.id, `s${c.step}-${c.key}`);
  assert.match(c.key, /^[0-9a-f]{6}$/);
  assert.equal(c.key, createHash('sha1').update(`app.mjs:${c.line}\nconst summary = report(results);`).digest('hex').slice(0, 6));
  assert.equal(c.file, 'app.mjs');
  assert.equal(c.function, 'main');
  assert.ok(c.signals.some((s: Msg) => s.signal === 'spine:why'));
  assert.deepEqual(c.values[0], { id: `${c.id}.v1`, role: 'set', name: 'summary', length: 22, text: "'D0:3 D8:3 D16:3 (ok)'" });
  const t = new TourRun(big);
  const passes: number[] = [];
  for (let i = 0; i < t.n; i++) if (t.line[i] === 8 && t.function(i) === 'Index.add') passes.push(i);
  assert.ok(passes.length > 1);
  assert.equal(new Set(passes.map((i) => stableKey(t, i))).size, 1); // the key names the statement, not the pass
  assert.ok(doc.candidates.filter((x: Msg) => x.statement === 'const ws = words(doc.text);').length <= 4); // novelty: at most four argument sets per line
});

test('io signals come from the statements: a file write and a child process', () => {
  const doc = tour('big');
  const io = new Set(doc.candidates.flatMap((c: Msg) => c.signals.map((s: Msg) => s.signal)).filter((s: string) => s.startsWith('io:')));
  assert.ok(io.has('io:file-write') && io.has('io:subprocess'), [...io].join(' '));
  assert.match(doc.run.io.fileWrites, /source/);
  assert.equal(doc.run.http, 0);
  assert.ok(doc.candidates.some((c: Msg) => c.signals.some((s: Msg) => s.signal === 'exception:rare-arm'))); // `if (!this.postings.has(w))` took true in under 20% of passes
});

test('values leave out this, functions and literals the statement spells out', () => {
  for (const name of ['big', 'small'] as const) {
    for (const c of tour(name).candidates) {
      for (const v of c.values) {
        assert.ok(!['this', 'self', 'cls'].includes(v.name), JSON.stringify(v));
        assert.ok(!NOISE.test(v.text ?? ''), JSON.stringify(v));
      }
    }
  }
  const banner = tour('small').candidates.find((c: Msg) => c.statement === "console.log('RANKING');");
  assert.ok(!banner || banner.values.length === 0); // its output is the statement's own literal
  const goal = tour('big').candidates.find((c: Msg) => c.step === tour('big').goal.step)!;
  assert.deepEqual(goal.values.map((v: Msg) => [v.role, v.text]), [['printed', 'top: D0:3 D8:3 D16:3 (ok)']]); // console.log's own range is inside the statement's
  assert.ok(NOISE.test('[Function: words]') && NOISE.test('[class Index]') && NOISE.test('[AsyncFunction: main]') && !NOISE.test("'[Function: x]'"));
});

test('shape: repeats, near repeats and evidence', () => {
  const longA = 'intro. ' + 'The model uses 8 attention heads with d_k = 64 per head. ' + 'x'.repeat(600);
  const grown = '[' + Array.from({ length: 8 }, (_, i) => `'turn ${i}: ${'a'.repeat(40)}'`).join(', ') + ']';
  const grown2 = grown.slice(0, -1) + ", 'turn 8: the new tool result'" + ']';
  const cands: Msg[] = [
    { id: 's1-aaaaaa', step: 1, _values: [{ role: 'set', name: 'page', text: longA }, { role: 'set', name: 'messages', text: grown }] },
    { id: 's5-bbbbbb', step: 5, _values: [{ role: 'set', name: 'copy', text: longA }, { role: 'set', name: 'messages', text: grown2 }] },
  ];
  shape(cands, tokens('The base Transformer uses 8 attention heads, with d_k = 64 per head.'));
  const [first, second] = [cands[0]!.values, cands[1]!.values];
  assert.ok(first[0].cut && first[0].text.length === 300 && first[0].length === longA.length);
  assert.deepEqual(second[0], { id: 's5-bbbbbb.v1', role: 'set', name: 'copy', length: longA.length, sameAs: 's1-aaaaaa.v1' });
  const near = second[1];
  assert.equal(near.like, 's1-aaaaaa.v2');
  assert.equal(grown2.slice(near.from, near.to), near.text);
  assert.ok(near.text.includes('turn 8'));
  const text = 'x'.repeat(500) + '. The model uses 8 attention heads with d_k = 64 per head. More text follows here.';
  const ev = evidence(text, tokens('8 heads, d_k = 64'), 2, 250);
  const e0 = ev[0]!;
  assert.ok(text.slice(e0.from, e0.to) === e0.text && e0.text.includes('8 attention heads'));
  // offsets count code points, as Python's
  const astral = '😀'.repeat(10) + '. The model uses 8 attention heads with d_k = 64 per head.';
  const ev2 = evidence(astral, tokens('8 heads, d_k = 64'));
  assert.equal(ev2[0]!.from, 12);
});

test('goal by name and by line, and the errors', () => {
  const byName = buildTour(big, { goal: 'summary' });
  assert.equal(byName.goal.kind, 'name');
  assert.equal(byName.goal.text, "'D0:3 D8:3 D16:3 (ok)'");
  assert.deepEqual(Object.keys(byName.goal), ['kind', 'name', 'step', 'text']);
  const byLine = buildTour(big, { goal: 'app.mjs:30' });
  assert.equal(byLine.goal.kind, 'line');
  assert.deepEqual(Object.keys(byLine.goal), ['kind', 'step', 'text', 'line']);
  assert.ok(byLine.candidates.some((c: Msg) => c.signals.some((s: Msg) => s.signal === 'spine:goal')));
  assert.throws(() => buildTour(big, { goal: 'no_such_name' }), /no recorded value of no_such_name/);
  assert.throws(() => buildTour(big, { goal: 'app.mjs:1' }), /no step on app.mjs:1/);
});

test('a tight budget keeps the best of every chapter', () => {
  const doc = buildTour(big, { budget: 1000 });
  assert.ok(doc.budget.dropped > 0);
  const found = tour('big').chapters;
  for (const ch of doc.chapters) assert.ok(ch.candidates >= Math.min(3, found.find((c: Msg) => c.id === ch.id).candidates), JSON.stringify(ch));
});

test('text form: the run, the goal, chapters, then one line per candidate', () => {
  const lines = renderTour(tour('big')).split('\n');
  assert.match(lines[0]!, /^tour {2}app\.mjs {2}1,\d{3} steps {2}exit 0 {2}0 HTTP \(0 model calls\) {2}\d+ of \d+ candidates, ~[\d,]+ tokens \(budget 40,000\)$/);
  assert.match(lines[1]!, /^goal: the program's output at #\d+: top: D0:3/);
  assert.ok(lines.includes('chapters'));
  assert.ok(lines.some((l) => /^ {2}c2 {3}#\d+-\d+ +\d+\.\d% {2}buildIndex {2}\d+ candidates$/.test(l)));
  assert.ok(lines.some((l) => / {2}c3 .*Index\.search {2}\+ report {2}/.test(l)));
  const rows = lines.filter((l) => l.startsWith('  s'));
  assert.ok(rows.length && rows.every((r) => / #\d+ /.test(r) && /\.(mjs|ts):\d+/.test(r)));
  assert.equal(renderTour(tour('big'), 'out.json').split('\n').pop(), 'wrote out.json');
  assert.ok(renderTour(tour('small')).includes("small run: the walkthrough's moments are the candidates, one chapter"));
});

test('cli: --json, --budget, --out', async () => {
  let r = await cli('tour', bigPath, '--json', '--budget', '20000');
  assert.equal(r.code, 0, r.err);
  const doc = JSON.parse(r.out);
  assert.equal(doc.tour, 1);
  assert.equal(doc.budget.tokens, 20000);
  assert.ok(doc.candidates.length);
  r = await cli('tour', bigPath, '--budget', '10');
  assert.equal(r.code, 2);
  assert.equal(r.err, 'error: --budget 10 is too small for a tour\ngive at least 1000 tokens; the default is 40000\n');
  const out = join(dir, 'tour.json');
  r = await cli('tour', bigPath, '--out', out);
  assert.equal(r.code, 0);
  assert.ok(r.out.trimEnd().endsWith(`wrote ${out}`));
  const written = JSON.parse(readFileSync(out, 'utf8'));
  assert.ok(!('prose' in written));
  assert.deepEqual(written.candidates.map((c: Msg) => c.id), doc.candidates.map((c: Msg) => c.id));
  r = await cli('tour', bigPath, '--prose', join(dir, 'missing.prose.json'));
  assert.equal(r.code, 2);
  assert.match(r.err, /^error: cannot read the prose file .*missing\.prose\.json: .*\na JSON object: \{"intro"/);
});

test('cli: --prose end to end on the JavaScript run', async () => {
  const doc = tour('big');
  const byStatement = (s: string) => doc.candidates.find((c: Msg) => c.statement === s)!.id;
  const index = byStatement('const index = buildIndex(docs);');
  const summary = byStatement('const summary = report(results);');
  const prose = {
    intro: 'The script indexes the docs, searches them and writes a report.',
    chapters: { c2: { title: 'Building the index', text: 'Every doc goes in.' }, c3: { title: 'Searching', text: 'One query ranks the docs.' } },
    pick: [summary, index],
    stops: {
      [index]: { title: 'The index', text: '`buildIndex` returns the postings.', quote: { field: 'v1', from: 0, to: 5 } },
      [summary]: { title: 'The summary', text: "It reads 'D0:3 D8:3 D16:3 (ok)'." },
    },
  };
  const path = join(dir, 'tour.prose.json');
  writeFileSync(path, JSON.stringify(prose));
  const out = join(dir, 'merged.json');
  let r = await cli('tour', bigPath, '--prose', path, '--out', out);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.startsWith('prose accepted: 2 stops, 2 chapter texts, 1 warning\nwarning: pick: 2 stops; the prompt asks for 6 to 10\n'), r.out);
  assert.ok(r.out.trimEnd().endsWith(`wrote ${out}`));
  assert.match(r.out, /\n {2}1\. s\d+-[0-9a-f]{6} {2}#\d+ {2}app\.mjs:39 {2}The index {2}\[quote index 0-5\]\n/);
  const merged = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(merged.pick, [index, summary]); // run order
  const q = merged.candidates.find((c: Msg) => c.id === index).prose.quote;
  assert.equal(q.text, 'Index');
  assert.equal(q.recordingCut, true); // the recording cut the Map's text; the quote is inside what it kept
  assert.deepEqual(merged.chapters[1].prose, { title: 'Building the index', text: 'Every doc goes in.' });
  assert.equal(merged.chapters[1].title, 'buildIndex');

  const bad = structuredClone(prose);
  bad.stops[summary]!.text = 'Rank 9999 is worth 0.0164.';
  writeFileSync(path, JSON.stringify(bad));
  r = await cli('tour', bigPath, '--prose', path, '--json');
  assert.equal(r.code, 2);
  const j = JSON.parse(r.out);
  assert.equal(j.ok, false);
  assert.equal(j.error, 'the prose has 2 problems');
  assert.deepEqual(j.violations, [`${summary}.text: number 9999 is not in this stop's values, statement or quote`, `${summary}.text: number 0.0164 is not in this stop's values, statement or quote`]);
});

test('the data-only parts agree with Pyokka reading the same run', { skip: !havePython && 'python3 >= 3.12 not found' }, () => {
  const r = spawnSync('python3', ['-m', 'pyokka_runtime', 'tour', bigPath, '--json'], { cwd: PY, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const py = JSON.parse(r.stdout);
  const doc = tour('big');
  assert.deepEqual(doc.run, py.run);
  assert.equal(doc.goal.step, py.goal.step);
  assert.equal(doc.goal.text, py.goal.text);
  assert.deepEqual(doc.budget.tokens, py.budget.tokens);
});

// -- --prose on a hand-made tour (test_tour_prose.py) ------------------------------------------------------------

const PROMPT_TEXT = 'You are a careful assistant. '.repeat(40) + 'The base model uses 8 heads with d_k = 64 per head. ' + 'Filler text. '.repeat(20);
const REPLY = "{'answer': 'The base Transformer uses 8 attention heads', 'tokens': 1234567, 'cost': 0.50}";

function handTour(): Msg {
  return {
    tour: 1,
    run: { file: 'ask.mjs', steps: 12345, exitCode: 0, http: 2, llm: 1 },
    goal: { kind: 'output', step: 300, text: '8 heads' },
    small: false,
    chapters: [
      { id: 'c1', title: 'loadRows', opens: ['loadRows'], kind: 'call', steps: [0, 99], share: 0.01, http: 0, llm: 0, candidates: 1 },
      { id: 'c2', title: 'askModel', opens: ['askModel'], kind: 'call', steps: [100, 12344], share: 0.99, http: 2, llm: 1, candidates: 2 },
    ],
    candidates: [
      { id: 's5-aaaaaa', key: 'aaaaaa', step: 5, chapter: 'c1', file: 'ask.mjs', line: 3, function: 'loadRows', statement: 'const rows = readRows(path, { limit: 500 });', values: [{ id: 's5-aaaaaa.v1', role: 'set', name: 'rows', length: 15, text: "[ 'a', 'b', 'c' ]" }] },
      {
        id: 's200-bbbbbb', key: 'bbbbbb', step: 200, chapter: 'c2', file: 'ask.mjs', line: 9, function: 'askModel', statement: 'const reply = await client.chat(prompt);',
        values: [
          { id: 's200-bbbbbb.v1', role: 'in', name: 'prompt', length: PROMPT_TEXT.length, text: PROMPT_TEXT.slice(0, 300), cut: true },
          { id: 's200-bbbbbb.v2', role: 'set', name: 'reply', length: REPLY.length, text: REPLY },
        ],
      },
      {
        id: 's300-cccccc', key: 'cccccc', step: 300, chapter: 'c2', file: 'ask.mjs', line: 12, function: 'main', statement: 'console.log(answer);',
        values: [
          { id: 's300-cccccc.v1', role: 'set', name: 'copy', length: REPLY.length, sameAs: 's200-bbbbbb.v2' },
          { id: 's300-cccccc.v2', role: 'set', name: 'cutReply', length: 30, text: "'The base Trans…(+4,000 chars)" },
        ],
      },
    ],
  };
}

const FULL: Record<string, string> = { 's5-aaaaaa.v1': "[ 'a', 'b', 'c' ]", 's200-bbbbbb.v1': PROMPT_TEXT, 's200-bbbbbb.v2': REPLY, 's300-cccccc.v1': REPLY, 's300-cccccc.v2': "'The base Trans…(+4,000 chars)" };

function prose(over: Msg = {}): Msg {
  return {
    intro: 'The script reads rows, asks a model once over 12,345 steps, and prints the answer.',
    chapters: { c1: { title: 'Reading the rows', text: 'Up to 500 rows come in.' }, c2: { title: 'Asking the model', text: 'One model call answers the question.' } },
    pick: ['s200-bbbbbb', 's5-aaaaaa', 's300-cccccc'],
    stops: {
      's5-aaaaaa': { title: 'Three rows', text: '`readRows` returns the rows the question is about.' },
      's200-bbbbbb': {
        title: 'The model answers',
        text: "The reply says 'The base Transformer uses 8 attention heads' and used 1,234,567 tokens at 0.5.",
        quote: { field: 'v1', from: PROMPT_TEXT.indexOf('The base model'), to: PROMPT_TEXT.indexOf('Filler') },
      },
      's300-cccccc': { title: 'The answer printed', text: '`console.log` shows the reply, `client.chat` made it.' },
    },
    ...over,
  };
}

const violations = (p: Msg) => checkProse(handTour(), p, FULL)[0];

test('prose: merges picks in run order with the quote cut from the full value', () => {
  const merged = applyProse(handTour(), prose(), FULL);
  assert.deepEqual(merged.pick, ['s5-aaaaaa', 's200-bbbbbb', 's300-cccccc']);
  const by = new Map<string, Msg>(merged.candidates.map((c: Msg) => [c.id, c]));
  const q = by.get('s200-bbbbbb')!.prose.quote;
  assert.equal(q.text, 'The base model uses 8 heads with d_k = 64 per head. ');
  assert.equal(q.field, 's200-bbbbbb.v1');
  assert.equal(q.name, 'prompt');
  assert.equal(q.length, PROMPT_TEXT.length);
  assert.ok(!('recordingCut' in q));
  assert.equal(by.get('s5-aaaaaa')!.prose.order, 1);
  assert.equal(by.get('s300-cccccc')!.prose.order, 3);
  assert.deepEqual(merged.chapters[1].prose, { title: 'Asking the model', text: 'One model call answers the question.' });
  assert.ok(merged.intro.startsWith('The script'));
  assert.equal(merged.prose.stops, 3);
  assert.equal(merged.chapters[0].title, 'loadRows'); // the rule's title stays; prose rides alongside
  assert.deepEqual(Object.keys(merged).slice(-3), ['intro', 'pick', 'prose']);
});

test('prose: thousands separators and trailing zeros compare equal', () => {
  assert.equal(normNumber('1,234,567'), '1234567');
  assert.equal(normNumber('0.50'), '0.5');
  assert.equal(normNumber('10.0'), '10');
  assert.deepEqual(violations(prose()), []);
});

test('prose: unknown ids and unpicked text', () => {
  const p = prose({ chapters: { c9: { title: 'Nope' } }, pick: ['s5-aaaaaa', 's1-zzzzzz', 's5-aaaaaa'] });
  p.stops['s7-nothere'] = { title: 'x', text: 'y' };
  const v = violations(p);
  for (const x of ['chapters: unknown chapter id c9', 'pick: unknown stop id s1-zzzzzz', 'pick: s5-aaaaaa listed twice', 'stops: unknown stop id s7-nothere', 'stops: s200-bbbbbb has text but is not in pick']) assert.ok(v.includes(x), x);
});

test('prose: a picked stop needs title and text, and fields are closed', () => {
  const p = prose({ extra: 1 });
  delete p.stops['s5-aaaaaa'];
  p.stops['s300-cccccc'] = { title: '', text: 'ok', score: 3 };
  const v = violations(p);
  assert.ok(v.includes('stops: s5-aaaaaa is picked but has no title and text'));
  assert.ok(v.includes('s300-cccccc.title: missing or empty'));
  assert.ok(v.some((x) => x.includes('s300-cccccc: unknown field "score"')));
  assert.ok(v.includes('unknown field "extra"; the prose has intro, chapters, pick, stops'));
});

test('prose: a quote on a field the stop lacks, or out of range', () => {
  const p = prose();
  p.stops['s5-aaaaaa'].quote = { field: 'v4', from: 0, to: 3 };
  p.stops['s200-bbbbbb'].quote = { field: 's200-bbbbbb.v2', from: 10, to: 9999 };
  const v = violations(p);
  assert.ok(v.some((x) => x.startsWith("s5-aaaaaa.quote: field 'v4' is not a value of this stop; it has v1 (rows)")), v.join('\n'));
  assert.ok(v.some((x) => x.startsWith(`s200-bbbbbb.quote: range 10-9999 is outside s200-bbbbbb.v2, which is ${REPLY.length} characters long`)));
  p.stops['s200-bbbbbb'].quote = { field: 'v2', from: 3, to: 2.5 };
  assert.ok(violations(p).includes('s200-bbbbbb.quote: from and to must be whole numbers with from < to, got 3 and 2.5'));
});

test("prose: a quote past the recording's own cut is refused, inside it is marked", () => {
  const p = prose();
  p.stops['s300-cccccc'].quote = { field: 'cutReply', from: 1, to: 25 };
  assert.ok(violations(p).some((x) => x.includes('runs past character 15, where the recording cut s300-cccccc.v2')));
  p.stops['s300-cccccc'].quote = { value: 'v2', from: 1, to: 9 }; // `value` is accepted for `field`
  const merged = applyProse(handTour(), p, FULL);
  const q = merged.candidates.find((c: Msg) => c.id === 's300-cccccc').prose.quote;
  assert.equal(q.text, 'The base');
  assert.equal(q.recordingCut, true);
  assert.equal(q.length, 15);
});

test("prose: a number not in the stop's values", () => {
  const p = prose({ intro: 'A run of 99,999 steps.' });
  p.stops['s5-aaaaaa'].text = 'Reads 3 rows of 37 percent.';
  p.chapters.c2.text = 'It spent 14 calls.';
  const v = violations(p);
  assert.ok(v.includes("s5-aaaaaa.text: number 3 is not in this stop's values, statement or quote"));
  assert.ok(v.includes("s5-aaaaaa.text: number 37 is not in this stop's values, statement or quote"));
  assert.ok(v.some((x) => x.startsWith('c2.text: number 14 is not in')));
  assert.ok(v.some((x) => x.startsWith('intro: number 99,999 is not in')));
});

test('prose: numbers from the statement, the chapter range, and names with digits pass', () => {
  const p = prose();
  p.stops['s5-aaaaaa'].text = '`readRows` stops at 500; ids like s3 and gpt-4o are names.';
  p.chapters.c2.text = 'Steps 100 to 12,344 make 2 HTTP requests, 1 to a model.';
  const v = violations(p);
  assert.deepEqual(v.filter((x) => x.startsWith('s5-aaaaaa') || x.startsWith('c2')), []);
});

test('prose: a sameAs value counts with its whole text', () => {
  const p = prose();
  p.stops['s300-cccccc'].text = "It prints 'The base Transformer uses 8 attention heads' again.";
  assert.deepEqual(violations(p), []);
});

test('prose: backticked names must occur in the tour', () => {
  const p = prose();
  p.stops['s5-aaaaaa'].text = '`loadEverything()` and `client.chat` and `rows`.';
  assert.deepEqual(violations(p), ["s5-aaaaaa.text: `loadEverything()` does not occur in the tour's statements, functions or values"]);
});

test("prose: single-quoted strings must be in that stop's values", () => {
  const p = prose();
  p.stops['s5-aaaaaa'].text = "The rows are 'alpha rows', not the model's reply.";
  assert.deepEqual(violations(p), ["s5-aaaaaa.text: 'alpha rows' is not in this stop's values"]);
});

test('prose: counts outside the prompt are warnings', () => {
  const [, w] = checkProse(handTour(), prose(), FULL);
  assert.ok(w.some((x) => x.includes('pick: 3 stops; the prompt asks for 6 to 10')));
});

test('prose: a rejection carries the list in JSON', () => {
  try {
    applyProse(handTour(), prose({ chapters: { c9: { title: 'x' } } }), FULL);
    assert.fail('not rejected');
  } catch (e) {
    assert.ok(e instanceof ProseRejected);
    const j = e.toJson();
    assert.deepEqual(Object.keys(j), ['ok', 'error', 'hint', 'violations']);
    assert.equal(j.ok, false);
    assert.equal(j.error, 'the prose has 1 problem');
    assert.deepEqual(j.violations, ['chapters: unknown chapter id c9']);
    assert.ok(e.message.includes('- chapters: unknown chapter id c9'));
  }
  assert.deepEqual(checkProse(handTour(), [1], FULL)[0], ['the prose must be a JSON object: {"intro", "chapters", "pick", "stops"}']);
});
