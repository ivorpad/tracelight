/**
 * `graph`: the execution graph over saved JavaScript runs (statement nodes, decisions, calls,
 * callbacks, data edges, `--all`, `--expand`, `--scope`, `--no-statements`, the cap, the text,
 * dot and `--json` forms, a live source), the JS cases of Pyokka's python/tests/test_graph.py.
 * Pyokka parses a JavaScript run's sources as Python, so there is no differential test here; the
 * shared fixtures (`test/unit/fixtures/execution-graph*.json`, Python runs) are conformance checks
 * for what does not depend on parsing the source: the module, function and package nodes, their
 * calls, spans and rows, the cap's placeholder, the scope map and the statement-free call edges.
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { project } from './helpers.ts';
import { dispatchVerb, getVerb, renderVerb, type Io } from '../src/agent/commands.ts';
import { graph, renderGraph } from '../src/agent/graph.ts';
import { renderDot } from '../src/agent/graph_dot.ts';
import { notAStatement } from '../src/agent/graph_statements.ts';
import { SavedRun, callSource } from '../src/agent/source.ts';
import '../src/agent/verbs.ts';

type Msg = Record<string, any>;

const BIN = resolve(import.meta.dirname, '../bin/tracelight.mjs');
const FIXTURES = resolve(import.meta.dirname, '../../test/unit/fixtures');

/** the statement-node program (the JS twin of test/unit/fixtures/graph/main.py) */
const EVENTS = `// a script-shaped program: what the statement nodes and their names must handle
import os from 'node:os';

class Event {
  constructor(name, date, participants) {
    this.name = name;
    this.date = date;
    this.participants = participants;
  }
}

function parseEvent(text, year = 2026) {
  const [name, date, people] = text.split('|');
  const participants = people.split(',');
  const event = new Event(
    name,
    \`\${date} \${year}\`,
    participants,
  );
  return event;
}

function shout(word) {
  if (!word) {
    throw new Error('empty');
  }
  return word.toUpperCase();
}

const text = 'fair|Sep 16|alice,bob'; // the '|' separates the fields
const event = parseEvent(text, 2026);
let count = 0;
for (const person of event.participants) {
  count += 1;
  console.log(\`Participant: \${person}\`);
}
const label = shout(event.name);
let summary;
if (count > 1) {
  summary = \`\${label} with \${count} people on \${event.date}\`;
} else {
  summary = label;
}
console.log(summary);
try {
  shout('');
} catch (e) {
  console.log('caught');
}
switch (count) {
  case 2:
    summary = 'two';
    break;
  default:
    summary = 'many';
}
let k = 0;
while (k < 2) {
  k++;
}
`;

/** the walkthrough-shaped program: a helper module, a class, a library calling back, a raise */
const HELPER = `export function double(x) {
  const y = x * 2;
  return y;
}

export function fail(n) {
  if (n > 100) {
    return n;
  }
  throw new RangeError(\`too small: \${n}\`);
}
`;
const LIBQ = `function helper(x) {
  return x * 2;
}

export function run(cb) {
  const y = helper(1);
  return cb(y) + y;
}
`;
const MAIN = `import { double, fail } from './helper.mjs';
import { run } from 'libq';

class Counter {
  constructor(start) {
    this.value = start;
  }
  bump(by) {
    this.value += by;
    return this.value;
  }
}

function greet(name) {
  const msg = 'hello ' + name;
  return msg;
}

let total = 0;
for (const i of [0, 1, 2]) {
  total += double(i);
}
const c = new Counter(10);
c.bump(5);
const seen = run((n) => n * 2);
console.log(greet('bob'), total);
try {
  fail(total);
} catch (e) {
  console.log('caught', e.message);
}
`;

let dir = '';
let events = '';
let walk = '';

function save(main: string, out: string, ...extra: string[]): string {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', BIN, 'run', join(dir, main), '--save', join(dir, out), ...extra], { stdio: 'pipe', cwd: dir, encoding: 'utf8' });
  assert.match(r.stderr, /^saved /m, r.stderr);
  return join(dir, out);
}

before(() => {
  dir = project({
    'events.mjs': EVENTS,
    'main.mjs': MAIN,
    'helper.mjs': HELPER,
    'node_modules/libq/package.json': '{"name": "libq", "version": "1.0.0", "main": "index.js", "type": "module"}\n',
    'node_modules/libq/index.js': LIBQ,
  });
  events = save('events.mjs', 'events.json');
  walk = save('main.mjs', 'main.json', '--library-code');
});

interface Out {
  code: number;
  out: string;
  err: string;
}

async function cli(...argv: string[]): Promise<Out> {
  let out = '';
  let err = '';
  const io: Io = { out: (t) => void (out += t), err: (t) => void (err += t) };
  const code = await dispatchVerb(argv[0]!, argv.slice(1), io);
  return { code, out, err };
}

const byLabel = (doc: Msg, label: string, kind?: string): Msg => doc.nodes.find((n: Msg) => n.label === label && (kind === undefined || n.kind === kind));

/** `[from label, to label, kind, count or data label]` per edge, in order */
function labelledEdges(doc: Msg): (string | number)[][] {
  const ids = new Map(doc.nodes.map((n: Msg) => [n.id, n.label]));
  return doc.edges.map((e: Msg) => [ids.get(e.from), ids.get(e.to), e.kind, e.kind === 'data' ? e.label : e.count]);
}

// -- statement nodes ----------------------------------------------------------------------------------------

test('statement nodes of the events program', () => {
  const doc = graph(new SavedRun(events));
  assert.deepEqual(doc.nodes.filter((n: Msg) => n.kind === 'function').map((n: Msg) => n.label), ['parseEvent', 'Event.constructor', 'shout']);
  assert.equal(byLabel(doc, 'shout').calls, 2);
  const main = byLabel(doc, '<module>');
  const stmts = new Map<string, Msg>(doc.nodes.filter((n: Msg) => n.kind === 'statement').map((n: Msg) => [n.label, n]));
  assert.deepEqual(
    doc.nodes.filter((n: Msg) => n.kind === 'statement' && n.parent === main.id).map((n: Msg) => n.label),
    ["const text = 'fair|Sep 16|alice,bob';", 'const event = parseEvent(text, 2026);', 'let count = 0;', 'count += 1;', 'console.log(`Participant: ${person}`);', 'const label = shout(event.name);', 'let summary;', 'summary = `${label} with ${count} people on ${event.date}`;', 'console.log(summary);', "shout('');", "console.log('caught');", "summary = 'two';", 'let k = 0;', 'k++;'],
  );
  const text = stmts.get("const text = 'fair|Sep 16|alice,bob';")!;
  assert.deepEqual([text.targets, text.reads, text.hits, text.line], [['text'], [], 1, 30]); // the `//` comment is gone
  assert.deepEqual(Object.keys(text), ['id', 'kind', 'parent', 'label', 'file', 'line', 'fileId', 'text', 'targets', 'reads', 'firstStep', 'hits', 'rows']);
  assert.deepEqual([stmts.get('const event = parseEvent(text, 2026);')!.targets, stmts.get('const event = parseEvent(text, 2026);')!.reads], [['event'], ['parseEvent', 'text']]);
  const count = stmts.get('count += 1;')!;
  assert.deepEqual([count.targets, count.reads, count.hits], [['count'], ['count'], 2]);
  const p = stmts.get('console.log(`Participant: ${person}`);')!;
  assert.deepEqual([p.targets, p.reads, p.hits], [[], ['console', 'person'], 2]);
  assert.deepEqual(p.rows, [{ kind: 'print', name: 'stdout', text: 'Participant: alice', step: p.firstStep }]);
  assert.deepEqual(stmts.get('let summary;')!.targets, ['summary']);
  assert.deepEqual([stmts.get('k++;')!.targets, stmts.get('k++;')!.reads], [['k'], ['k']]);
  // imports, headers, class and function declarations, `break` and the comment make no node
  assert.ok(![...stmts.keys()].some((l) => /^(import|class|function|if|for|while|switch|try|break|\/\/)/.test(l)));
  // under parseEvent and shout
  const pe = byLabel(doc, 'parseEvent');
  const underPe = doc.nodes.filter((n: Msg) => n.kind === 'statement' && n.parent === pe.id);
  assert.deepEqual(underPe.map((n: Msg) => n.label), ["const [name, date, people] = text.split('|');", "const participants = people.split(',');", 'const event = new Event( name, `${date} ${year}`, participa…', 'return event;']);
  assert.deepEqual([underPe[0].targets, underPe[0].reads], [['name', 'date', 'people'], ['text']]);
  assert.equal(underPe[2].text, 'const event = new Event( name, `${date} ${year}`, participants, );');
  assert.deepEqual(underPe[2].reads, ['Event', 'name', 'date', 'year', 'participants']);
  const sh = byLabel(doc, 'shout');
  const thrown = doc.nodes.find((n: Msg) => n.kind === 'statement' && n.parent === sh.id && n.label.startsWith('throw'));
  assert.deepEqual(thrown.rows, [{ kind: 'raised', name: 'Error', text: 'empty', step: thrown.firstStep }]);
  assert.deepEqual(sh.rows.map((r: Msg) => r.kind), ['in', 'out']); // the handled raise sits on the statement
  // decisions, in JavaScript's words
  const dec = new Map<string, Msg>(doc.nodes.filter((n: Msg) => n.kind === 'decision').map((n: Msg) => [n.label, n]));
  const loop = dec.get('for (const person of event.participants)')!;
  assert.deepEqual([loop.hits, loop.parent, loop.text, 'taken' in loop, loop.notRun], [2, main.id, 'for (const person of event.participants) ran 2 times', false, []]);
  assert.deepEqual([dec.get('if (count > 1)')!.taken, dec.get('if (count > 1)')!.notRun], ['true', [42]]);
  assert.deepEqual([dec.get('if (!word)')!.hits, dec.get('if (!word)')!.taken, dec.get('if (!word)')!.notRun, dec.get('if (!word)')!.parent], [2, 'false', [], sh.id]);
  assert.deepEqual([dec.get('switch (count)')!.taken, dec.get('switch (count)')!.notRun], ['case 2', [55]]);
  assert.equal(dec.get('while (k < 2)')!.hits, 2);
  assert.deepEqual(Object.keys(dec.get('if (count > 1)')!), ['id', 'kind', 'parent', 'label', 'file', 'line', 'fileId', 'text', 'taken', 'firstStep', 'hits', 'notRun', 'rows']);
  // call edges leave from the statements; data edges
  const edges = labelledEdges(doc);
  assert.deepEqual(edges.filter((e) => e[2] === 'call'), [
    ['const event = parseEvent(text, 2026);', 'parseEvent', 'call', 1],
    ['const event = new Event( name, `${date} ${year}`, participa…', 'Event.constructor', 'call', 1],
    ['const label = shout(event.name);', 'shout', 'call', 1],
    ["shout('');", 'shout', 'call', 1],
  ]);
  const data = edges.filter((e) => e[2] === 'data').map((e) => `${e[0]} ⇢ ${e[1]}: ${e[3]}`);
  for (const want of [
    "const text = 'fair|Sep 16|alice,bob'; ⇢ const event = parseEvent(text, 2026);: text",
    "parseEvent ⇢ const [name, date, people] = text.split('|');: text",
    "const [name, date, people] = text.split('|'); ⇢ const participants = people.split(',');: people",
    'parseEvent ⇢ const event = new Event( name, `${date} ${year}`, participa…: year',
    'Event.constructor ⇢ this.name = name;: name',
    'let count = 0; ⇢ count += 1;: count',
    'for (const person of event.participants) ⇢ console.log(`Participant: ${person}`);: person',
    'const event = parseEvent(text, 2026); ⇢ for (const person of event.participants): event',
    'shout ⇢ if (!word): word',
    'count += 1; ⇢ if (count > 1): count',
    'summary = `${label} with ${count} people on ${event.date}`; ⇢ console.log(summary);: summary',
    'let k = 0; ⇢ while (k < 2): k',
    'count += 1; ⇢ switch (count): count',
  ])
    assert.ok(data.includes(want), want);
  const e = doc.edges.find((x: Msg) => x.kind === 'data' && x.to === count.id);
  assert.deepEqual(e, { id: e.id, from: stmts.get('let count = 0;')!.id, to: count.id, kind: 'data', label: 'count', firstStep: count.firstStep });
  // moments: prints and the handled error map to their statements
  assert.deepEqual(doc.moments.filter((m: Msg) => m.kind === 'error').map((m: Msg) => m.nodeId), [thrown.id]);
  assert.equal(doc.moments.filter((m: Msg) => m.kind === 'print' && m.nodeId === p.id).length, 2);
  assert.equal(doc.moments[0].nodeId, main.id);
  assert.equal(doc.moments.at(-1).kind, 'end');
  assert.deepEqual([doc.capped, doc.truncated], [false, false]);
  assert.deepEqual(doc.nodes.map((n: Msg) => n.id), doc.nodes.map((_: Msg, i: number) => `n${i}`));
  assert.deepEqual(Object.keys(doc), ['count', 'nodes', 'edges', 'moments', 'scopes', 'capped', 'truncated']);
  // a function node comes before the statement that called it on the same step
  assert.equal(doc.nodes.indexOf(pe) + 1, doc.nodes.indexOf(stmts.get('const event = parseEvent(text, 2026);')));
});

test('statements off is the graph without them', async () => {
  const doc = graph(new SavedRun(events), { statements: false });
  assert.deepEqual(
    doc.nodes.map((n: Msg) => `${n.kind} ${n.label}`),
    ['module <module>', 'function parseEvent', 'function Event.constructor', 'decision for (const person of event.participants)', 'function shout', 'decision if (!word)', 'decision if (count > 1)', 'decision switch (count)', 'decision while (k < 2)'],
  );
  assert.deepEqual(labelledEdges(doc), [['<module>', 'parseEvent', 'call', 1], ['parseEvent', 'Event.constructor', 'call', 1], ['<module>', 'shout', 'call', 2]]);
  assert.deepEqual(byLabel(doc, 'shout').rows.map((r: Msg) => r.kind), ['in', 'out', 'raised']); // the handled raise is back on the function
  const ids = new Set(doc.nodes.map((n: Msg) => n.id));
  assert.ok(doc.moments.every((m: Msg) => ids.has(m.nodeId)));
  const r = await cli('graph', events, '--no-statements', '--json');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), JSON.parse(JSON.stringify(doc)));
  const t = await cli('graph', events, '--no-statements');
  assert.equal(t.out.split('\n')[0], '9 nodes, 3 edges over ' + doc.count + ' steps');
});

test('what is not a statement node', () => {
  const lines = ['if (x) {', 'for (const a of b) {', 'class A extends B {', 'export function f() {', "import x from 'y';", "export { a } from './a.mjs';", 'break;', 'continue outer;', "'use strict';", 'outer: for (;;) {', 'x = 1; // done', "'a'.repeat(2);", 'export const y = 2;', 'if (k > 5) continue;', 'interface P { x: number }', 'debugger;'];
  const whole = (i: number) => [i + 1, 0, i + 1, lines[i]!.length];
  const header = (i: number, end: number) => [i + 1, 0, i + 1, end];
  assert.equal(notAStatement(lines, header(0, 6)), true);
  assert.equal(notAStatement(lines, header(1, 18)), true);
  assert.equal(notAStatement(lines, header(2, 17)), true);
  assert.equal(notAStatement(lines, header(3, 19)), true);
  for (const i of [4, 5, 6, 7, 8, 9, 14, 15]) assert.equal(notAStatement(lines, whole(i)), true, lines[i]);
  for (const i of [10, 11, 12]) assert.equal(notAStatement(lines, whole(i)), false, lines[i]);
  assert.equal(notAStatement(lines, header(13, 10)), true); // `if (k > 5)`, its body on the same line
  assert.equal(notAStatement(lines, [14, 11, 14, 20]), true); // `continue;`
});

// -- the library program ---------------------------------------------------------------------------------------

test('the default graph of the library program', () => {
  const doc = graph(new SavedRun(walk));
  const main = byLabel(doc, '<module>');
  assert.deepEqual([main.id, main.calls, main.spans, main.line, main.function], ['n0', 1, [[0, doc.count - 1]], 1, '<module>']);
  assert.deepEqual(Object.keys(main), ['id', 'kind', 'label', 'file', 'line', 'fileId', 'function', 'calls', 'firstStep', 'spans', 'rows']);
  const helper = byLabel(doc, 'helper.mjs');
  assert.deepEqual([helper.kind, helper.calls], ['module', 1]);
  const double = byLabel(doc, 'double');
  assert.deepEqual([double.calls, double.line, double.spans.length], [3, 1, 3]);
  assert.deepEqual(double.rows.map((r: Msg) => [r.kind, r.name, r.text]), [['in', 'x', '0'], ['out', 'return', '0']]);
  const fail = byLabel(doc, 'fail');
  assert.deepEqual(fail.rows.map((r: Msg) => [r.kind, r.name, r.text]), [['in', 'n', '6'], ['raised', 'RangeError', 'too small: 6']]);
  const lib = byLabel(doc, 'libq');
  assert.deepEqual([lib.kind, lib.package, lib.calls, lib.nested], ['package', 'libq', 1, 2]);
  assert.deepEqual(Object.keys(lib), ['id', 'kind', 'label', 'package', 'calls', 'firstStep', 'spans', 'rows', 'nested']);
  assert.ok(!('package' in byLabel(doc, '<arrow>')));
  const edges = labelledEdges(doc);
  // an ES module's imports run before its first statement: the import comes from the importer, not from itself
  assert.deepEqual(edges[0], ['<module>', 'helper.mjs', 'call', 1]);
  for (const want of [
    ['total += double(i);', 'double', 'call', 3],
    ['const c = new Counter(10);', 'Counter.constructor', 'call', 1],
    ['c.bump(5);', 'Counter.bump', 'call', 1],
    ['const seen = run((n) => n * 2);', 'libq', 'call', 1],
    ['libq', '<arrow>', 'tool', 1],
    ["console.log(greet('bob'), total);", 'greet', 'call', 1],
    ['fail(total);', 'fail', 'call', 1],
    ['double', 'double', 'data', 'x'],
    ['let total = 0;', 'total += double(i);', 'data', 'total'],
    ['for (const i of [0, 1, 2])', 'total += double(i);', 'data', 'i'],
    ['Counter.bump', 'this.value += by;', 'data', 'by'],
  ])
    assert.ok(edges.some((e) => JSON.stringify(e) === JSON.stringify(want)), JSON.stringify(want));
  const d = doc.edges.find((e: Msg) => e.to === double.id && e.kind === 'call');
  assert.deepEqual(Object.keys(d), ['id', 'from', 'to', 'kind', 'count', 'firstStep', 'steps', 'momentIds']);
  assert.equal(d.steps.length, 3);
  assert.deepEqual(doc.moments.find((m: Msg) => m.id === d.momentIds[0]), { id: d.momentIds[0], kind: 'call', step: d.steps[0], nodeId: double.id, edgeId: d.id });
  const run = new SavedRun(walk);
  assert.deepEqual(new Set(Object.keys(doc.scopes)), new Set(run.trace.scopes.map((s) => String(s.scopeId))));
  assert.equal(doc.scopes['0'], 'n0');
  assert.deepEqual(doc.edges.map((e: Msg) => e.id), doc.edges.map((_: Msg, i: number) => `e${i}`));
});

test('--all and --expand unroll the library', () => {
  const run = new SavedRun(walk);
  const every = graph(run, { allScopes: true });
  const labels = every.nodes.map((n: Msg) => n.label);
  assert.ok(!labels.includes('libq') && labels.includes('run') && labels.includes('helper') && !every.nodes.some((n: Msg) => n.kind === 'package'));
  const runNode = byLabel(every, 'run');
  assert.deepEqual([runNode.package, runNode.file.endsWith(join('libq', 'index.js')), 'nested' in runNode], ['libq', true, false]);
  assert.deepEqual(Object.keys(runNode), ['id', 'kind', 'label', 'file', 'line', 'fileId', 'function', 'package', 'calls', 'firstStep', 'spans', 'rows']);
  const edges = labelledEdges(every).map((e) => JSON.stringify(e));
  assert.ok(edges.includes(JSON.stringify(['run', 'helper', 'call', 1])) && edges.includes(JSON.stringify(['run', '<arrow>', 'tool', 1])) && edges.includes(JSON.stringify(['const seen = run((n) => n * 2);', 'run', 'call', 1])));
  assert.ok(!every.nodes.some((n: Msg) => n.kind === 'statement' && n.parent === runNode.id)); // library functions get no statements
  assert.deepEqual(graph(run, { expand: ['libq'] }), every);
  const other = graph(run, { expand: ['nothing'] }); // `all` moments, the package folded back
  assert.deepEqual(other.nodes.map((n: Msg) => n.label), graph(run).nodes.map((n: Msg) => n.label));
  assert.equal(byLabel(other, 'libq').calls, 1);
});

test('--scope windows the graph', () => {
  const doc = graph(new SavedRun(walk), { scope: 'fail' });
  assert.deepEqual(doc.nodes.map((n: Msg) => `${n.kind} ${n.label}`), ['module <module>', 'function fail', 'decision if (n > 100)', 'statement throw new RangeError(`too small: ${n}`);']);
  assert.deepEqual(labelledEdges(doc), [['<module>', 'fail', 'call', 1], ['fail', 'if (n > 100)', 'data', 'n'], ['fail', 'throw new RangeError(`too small: ${n}`);', 'data', 'n']]);
  assert.deepEqual(doc.moments.filter((m: Msg) => m.kind === 'error').map((m: Msg) => m.nodeId), ['n3']);
});

test('the cap keeps the most called functions and folds the rest', () => {
  const doc = graph(new SavedRun(walk), { cap: 5 });
  assert.equal(doc.capped, true);
  // modules and the package always stay; then double (3 calls) and the first function with a decision
  const kept = doc.nodes.filter((n: Msg) => n.kind !== 'decision' && n.kind !== 'statement').map((n: Msg) => n.label);
  assert.deepEqual(kept, ['<module>', 'helper.mjs', 'double', '4 more functions', 'libq', 'fail']);
  const more = byLabel(doc, '4 more functions');
  assert.deepEqual([more.kind, more.more, more.calls, more.spans, more.file.endsWith('main.mjs')], ['package', 4, 4, [], true]);
  assert.deepEqual(Object.keys(more), ['id', 'kind', 'label', 'file', 'fileId', 'calls', 'firstStep', 'spans', 'rows', 'more']);
  assert.ok(!doc.nodes.some((n: Msg) => n.label === 'this.value += by;')); // statements of dropped functions go with them
  assert.ok(Object.values(doc.scopes).includes(more.id));
  assert.equal(graph(new SavedRun(walk), { cap: 10 }).capped, false);
});

// -- text, dot, json, live ---------------------------------------------------------------------------------------

test('the text form', async () => {
  const r = await cli('graph', walk);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trimEnd().split('\n');
  const doc = graph(new SavedRun(walk));
  assert.equal(lines[0], `${doc.nodes.length} nodes, ${doc.edges.length} edges over ${doc.count} steps`);
  assert.equal(lines[1], 'n0 <module> main.mjs:1  ×1');
  assert.ok(lines.includes('   n2 let total = 0;  ×1'));
  assert.ok(lines.includes('   n3 for (const i of [0, 1, 2]) ran 3 times  ×3'));
  const d = byLabel(doc, 'double');
  assert.ok(lines.includes(`${d.id} double helper.mjs:1  ×3  in x = 0 · out 0`));
  assert.equal(lines[lines.indexOf(`${d.id} double helper.mjs:1  ×3  in x = 0 · out 0`) + 1], `   ${byLabel(doc, 'const y = x * 2;').id} const y = x * 2;  ×3`);
  const lib = byLabel(doc, 'libq');
  assert.ok(lines.includes(`${lib.id} libq  ×1  2 nested  out 6`));
  const fail = byLabel(doc, 'fail');
  const failLine = `${fail.id} fail helper.mjs:6  ×1  in n = 6 · raised RangeError: too small: 6`;
  assert.equal(lines[lines.indexOf(failLine) + 1], `   ${byLabel(doc, 'if (n > 100)').id} if (n > 100) took false  ×1  not run: 8`);
  assert.ok(lines.includes(`${byLabel(doc, 'total += double(i);').id} → ${d.id}  ×3  ${doc.edges.find((e: Msg) => e.to === d.id && e.kind === 'call').steps.map((s: number) => '#' + s).join(' ')}`));
  assert.ok(lines.some((l) => / → .*  tool ×1  #\d+$/.test(l)));
  assert.ok(lines.includes(`${d.id} ⇢ ${d.id}  x`));
  assert.equal(lines.length, 1 + doc.nodes.length + doc.edges.length);
  assert.ok(lines.every((l) => [...l].length <= 100));
  const s = await cli('graph', walk, '--scope', 'fail');
  assert.equal(s.out.split('\n')[0], `4 nodes, 3 edges over ${doc.count} steps`);
});

test('a long line and a cut value keep their marks', () => {
  const doc = {
    count: 3,
    nodes: [
      { id: 'n0', kind: 'module', label: '<module>', file: '/w/a.mjs', line: 1, calls: 1, rows: [{ kind: 'out', name: 'big', text: 'x'.repeat(50) + '…(+1,000 chars)', step: 1 }] },
      { id: 'n1', kind: 'statement', parent: 'n0', label: 'y'.repeat(120), hits: 1, rows: [] },
    ],
    edges: [],
  };
  const lines = renderGraph(doc, { displayPath: (p: string) => p.split('/').pop() } as any, {});
  assert.equal(lines[1], `n0 <module> a.mjs:1  ×1  out big = ${'x'.repeat(20)}…(+1,030 chars)`);
  assert.equal(lines[2], '   n1 ' + 'y'.repeat(93) + '…');
  assert.equal(lines[0], '2 nodes, 0 edges over 3 steps');
});

test('the dot form', async () => {
  const doc = graph(new SavedRun(walk));
  const dot = renderDot(doc);
  assert.ok(dot.startsWith('digraph run {') && dot.endsWith('}'));
  const id = (label: string) => byLabel(doc, label).id;
  assert.ok(dot.includes(`  ${id('if (n > 100)')} [shape=diamond, label="if (n > 100) took false\\nnot run: 8"];`));
  assert.ok(dot.includes(`  ${id('double')} [shape=record, label="{double ×3\\nhelper.mjs:1|in x = 0\\lout 0\\l}"];`));
  assert.ok(dot.includes(`  ${id('libq')} [shape=folder, label="libq ×1\\n2 nested"];`));
  assert.ok(dot.includes('  n0 [shape=record, label="{\\<module\\> ×1\\nmain.mjs:1}"];'));
  assert.ok(dot.includes(`  ${id('let total = 0;')} [shape=box, fontname="Courier", label="let total = 0;"];`));
  assert.ok(dot.includes(`  ${id('throw new RangeError(`too small: ${n}`);')} [shape=box, fontname="Courier", label="throw new RangeError(\`too small: \${n}\`);\\nraised RangeError: too small: 6"];`));
  assert.ok(dot.includes(`  n0 -> ${id('let total = 0;')} [style=dotted, arrowhead=none];`));
  assert.ok(dot.includes(`  ${id('libq')} -> ${id('<arrow>')} [label="tool ×1"];`) && dot.includes(`  ${id('total += double(i);')} -> ${id('double')} [label="×3"];`));
  assert.ok(dot.includes(`  ${id('double')} -> ${id('double')} [style=dashed, label="x"];`));
  const r = await cli('graph', walk, '--dot');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, dot + '\n');
});

test('--json, --all, --expand on the command line', async () => {
  const json = async (...a: string[]) => {
    const r = await cli('graph', walk, ...a, '--json');
    assert.equal(r.code, 0, r.err);
    return JSON.parse(r.out);
  };
  assert.deepEqual(await json(), JSON.parse(JSON.stringify(graph(new SavedRun(walk)))));
  const every = await json('--all');
  assert.ok(every.nodes.some((n: Msg) => n.label === 'run'));
  assert.deepEqual(await json('--expand', 'libq', '--expand', 'other'), every);
  assert.equal((await json('--scope', 'fail')).nodes.length, 4);
  const p = getVerb('graph')!;
  assert.match(renderVerb(p, { count: 0, nodes: [], edges: [] }, { displayPath: String } as any, {}), /^0 nodes, 0 edges over 0 steps\n$/);
  const bad = await cli('graph', walk, '--expand');
  assert.equal(bad.code, 2);
  assert.match(bad.err, /argument --expand: expected one argument/);
});

test('a stale run: the stale lines lead the text and are comments in the dot', async () => {
  const d = project({ 's.mjs': 'const x = 1;\nconsole.log(x);\n' });
  const out = join(d, 's.json');
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', BIN, 'run', join(d, 's.mjs'), '--save', out], { stdio: 'pipe', cwd: d, encoding: 'utf8' });
  assert.match(r.stderr, /^saved /m);
  appendFileSync(join(d, 's.mjs'), '// edited\n');
  const text = await cli('graph', out);
  assert.match(text.out, /^stale: .*s\.mjs changed since the run\n\d+ nodes/);
  const dot = await cli('graph', out, '--dot');
  assert.match(dot.out, /^\/\/ stale: .*s\.mjs changed since the run\ndigraph run \{\n/);
});

test('a live source answers graph itself', async () => {
  const calls: Msg[] = [];
  const reply = {
    count: 40,
    nodes: [
      { id: 'n0', kind: 'module', label: '<module>', file: '/ws/proj/demo.mjs', line: 1, fileId: 1, function: '<module>', calls: 1, firstStep: 0, spans: [[0, 39]], rows: [{ kind: 'raised', name: 'Error', text: 'Kaboom', step: 39 }] },
      { id: 'n1', kind: 'function', label: 'Point.constructor', file: '/ws/proj/demo.mjs', line: 41, fileId: 1, function: 'Point.constructor', calls: 4, firstStep: 9, spans: [[10, 12]], rows: [{ kind: 'in', name: 'x', text: '5', step: 10 }] },
      { id: 'n2', kind: 'statement', parent: 'n0', label: 'console.log(cfg);', file: '/ws/proj/demo.mjs', line: 11, fileId: 1, text: 'console.log(cfg);', targets: [], reads: ['console', 'cfg'], firstStep: 2, hits: 1, rows: [{ kind: 'print', name: 'stdout', text: "{ awesome: true }", step: 2 }] },
    ],
    edges: [{ id: 'e0', from: 'n0', to: 'n1', kind: 'call', count: 4, firstStep: 9, steps: [9], momentIds: ['m3'] }],
    moments: [],
    scopes: { '0': 'n0' },
    capped: false,
    truncated: false,
  };
  const live: Msg = { graph: (opts: Msg) => (calls.push(opts), reply), displayPath: (p: string) => p.replace('/ws/proj/', ''), staleFiles: () => [], close() {} };
  assert.equal(await callSource(live as any, 'graph', { allScopes: true, scope: null, expand: ['openai'], statements: true }), reply);
  assert.deepEqual(calls, [{ allScopes: true, scope: null, expand: ['openai'], statements: true }]);
  const verb = getVerb('graph')!;
  const args = { dot: false, all: false, scope: 'Point.constructor', expand: [], statements: true };
  assert.deepEqual(await verb.run!(live as any, args), reply);
  assert.deepEqual(calls[1], { allScopes: false, scope: 'Point.constructor', expand: [], statements: true });
  assert.equal(renderVerb(verb, reply, live as any, { ...args }), "3 nodes, 1 edge over 40 steps\nn0 <module> demo.mjs:1  ×1  raised Error: Kaboom\n   n2 console.log(cfg);  ×1  print stdout = { awesome: true }\nn1 Point.constructor demo.mjs:41  ×4  in x = 5\nn0 → n1  ×4  #9\n");
  const dot = renderVerb(verb, reply, live as any, { ...args, dot: true });
  assert.ok(dot.startsWith('digraph run {') && dot.includes('n0 -> n1 [label="×4"]') && dot.includes('  n2 [shape=box, fontname="Courier", label="console.log(cfg);\\nprint stdout = { awesome: true }"];'));
});

// -- conformance with the shared fixtures (Python runs: only what does not parse the source) ---------------------

/** a module, function or package node without what parsing the source decides (its qualname, where an error moment lands) */
function dataNode(n: Msg): Msg {
  const { id: _id, label: _label, function: _fn, ...rest } = n;
  return { ...rest, label: n.kind === 'function' ? undefined : n.label, rows: n.rows.filter((r: Msg) => r.kind !== 'raised') };
}

function identity(doc: Msg): Map<string, string> {
  return new Map(doc.nodes.map((n: Msg) => [n.id, `${n.kind}:${n.fileId ?? ''}:${n.line ?? ''}:${n.package ?? ''}:${n.more ?? ''}`]));
}

for (const [runFile, fixture, key, opts] of [
  ['walkthrough-run.json', 'execution-graph.json', 'default', {}],
  ['walkthrough-run.json', 'execution-graph.json', 'all', { allScopes: true }],
  ['walkthrough-run.json', 'execution-graph.json', 'cap', { cap: 6 }],
  ['walkthrough-run.json', 'execution-graph.json', 'scope', { scope: 'fail' }],
  ['graph-run.json', 'execution-graph-statements.json', 'default', {}],
  ['graph-run.json', 'execution-graph-statements.json', 'functions', { statements: false }],
] as [string, string, string, Msg][]) {
  test(`conformance: ${fixture} ${key}`, () => {
    const expected = JSON.parse(readFileSync(join(FIXTURES, fixture), 'utf8'))[key];
    const doc = graph(new SavedRun(join(FIXTURES, runFile)), opts);
    const calls = (d: Msg) => d.nodes.filter((n: Msg) => n.kind !== 'decision' && n.kind !== 'statement');
    // the same functions (Pyokka's qualnames come from parsing Python: `Counter.__init__` is `__init__` here), calls, spans, rows
    assert.deepEqual(calls(doc).map(dataNode), calls(expected).map(dataNode));
    assert.deepEqual([doc.count, doc.capped], [expected.count, expected.capped]);
    const ours = identity(doc);
    const theirs = identity(expected);
    const scopes = (d: Msg, ids: Map<string, string>) => Object.fromEntries(Object.entries(d.scopes).map(([s, id]) => [s, ids.get(id as string)]));
    assert.deepEqual(scopes(doc, ours), scopes(expected, theirs));
    if (key === 'functions') {
      // no statements: the call and tool edges are pure data (their moment ids count the decisions Python found)
      const callEdges = (d: Msg, ids: Map<string, string>) => d.edges.filter((e: Msg) => e.kind !== 'data').map((e: Msg) => [ids.get(e.from), ids.get(e.to), e.kind, e.count, e.firstStep, e.steps]);
      assert.deepEqual(callEdges(doc, ours), callEdges(expected, theirs));
    }
  });
}
