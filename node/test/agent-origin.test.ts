/**
 * `tracelight origin`: the chain from a failing statement back to where its bad value was made.
 * Each program is saved with `run --save` and
 * read back as a `SavedRun`; the errors are V8's (`Cannot read properties of undefined`, `… is not
 * a function`) and a missing key or index gives `undefined` one step before the failure.
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { origin } from '../src/agent/origin/index.ts';
import { needFromError } from '../src/agent/origin/need.ts';
import { SavedRun } from '../src/agent/source.ts';

const BIN = resolve(import.meta.dirname, '../bin/tracelight.mjs');
type Msg = Record<string, any>;

const PROGRAMS: Record<string, string> = {
  // a function that falls off its end for one currency: undefined from a return
  'nonetype.mjs': `const RATES = { EUR: 1.1, GBP: 1.3 };

function getRate(currency) {
  if (currency in RATES) {
    return RATES[currency];
  }
}

function convert(amount, currency) {
  const rate = getRate(currency);
  return amount * rate.toFixed(2);
}

const totals = [];
for (const [amount, cur] of [[10, 'EUR'], [20, 'GBP'], [5, 'JPY']]) {
  totals.push(convert(amount, cur));
}
console.log(totals);
`,
  // a settings line with a typo: the Map reaches address() without 'port'
  'mapkey.mjs': `function loadSettings(lines) {
  const settings = new Map();
  for (const line of lines) {
    const [key, value] = line.split('=');
    settings.set(key.trim(), value.trim());
  }
  return settings;
}

function address(settings) {
  return settings.get('host') + ':' + settings.get('port').padStart(5);
}

const settings = loadSettings(['host = db.local', 'prot = 5432']);
console.log(address(settings));
`,
  // the same typo on a plain object, set in place (its identity does not change, so no change is recorded)
  'objkey.mjs': `function makeConfig(env) {
  const config = { host: 'db.local' };
  config.prot = env.PORT;
  return config;
}

function url(config) {
  return config.host + ':' + config.port.trim();
}

const config = makeConfig({ PORT: '5432' });
console.log(url(config));
`,
  // the last row has two fields: fields[2] is undefined
  'index.mjs': `function parseLine(line) {
  return line.split(',');
}

function thirdField(fields) {
  return fields[2].toUpperCase();
}

const ROWS = ['a,b,c', 'd,e,f', 'g,h'];
for (const row of ROWS) {
  const fields = parseLine(row);
  console.log(thirdField(fields));
}
`,
  // a price kept as text by parsePrice, carried in an object pushed into an array, read in a reduce callback
  'invoices.mjs': `const ORDERS_CSV = \`customer,tier,sku,qty,unit_price
Ana,gold,KB-01,2,49.90
Ana,gold,MS-07,1,19.90
Ben,silver,MON-27,1,"1,299.00"
Ben,silver,CBL-02,3,7.50
Caro,,KB-01,1,49.90
\`;

const DISCOUNTS = { gold: 0.15, silver: 0.1 };

function parsePrice(raw) {
  const text = raw.replaceAll('"', '');
  // numbers only: "49.90" -> 49.9; anything else is kept as text for the audit log
  return /^\\d+(\\.\\d+)?$/.test(text) ? Number(text) : text;
}

function parseOrders(csvText) {
  const [header, ...rows] = csvText.trim().split('\\n');
  const orders = {};
  for (const row of rows) {
    const [customer, tier, sku, qty, price] = row.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    orders[customer] ??= { tier: tier || null, items: [] };
    orders[customer].items.push({ sku, qty: Number(qty), unitPrice: parsePrice(price) });
  }
  return orders;
}

function subtotal(items) {
  return items.reduce((sum, item) => sum + item.qty * item.unitPrice.toFixed(2), 0);
}

function invoiceTotal(order) {
  const rate = DISCOUNTS[order.tier] ?? 0;
  return subtotal(order.items) * (1 - rate);
}

const orders = parseOrders(ORDERS_CSV);
const totals = Object.entries(orders).map(([name, order]) => invoiceTotal(order));
console.log(totals);
`,
  // forEach gives undefined: the call's own result
  'foreach.mjs': `function best(scores, n) {
  const ranked = scores.forEach((s) => s * 2);
  return ranked.slice(0, n);
}
console.log(best([70, 88, 97], 2));
`,
  // null carried in an array element, out through find() and an object literal, into another call
  'container.mjs': `function lookup(table, id) {
  return table.find((row) => row.id === id);
}

function makeRows() {
  const rows = [];
  rows.push({ id: 1, user: { name: 'ann' } });
  rows.push({ id: 2, user: null });
  return rows;
}

function greet(row) {
  return 'hi ' + row.user.name;
}

const rows = makeRows();
const pair = { first: lookup(rows, 1), second: lookup(rows, 2) };
console.log(greet(pair.first));
console.log(greet(pair.second));
`,
  // a constructor given a number where the others got arrays
  'boxes.mjs': `class Box {
  constructor(items) {
    this.items = items;
  }
}
function count(box) {
  let n = 0;
  for (const x of box.items) n += x;
  return n;
}
const boxes = [new Box([1, 2]), new Box(3)];
for (const b of boxes) console.log(count(b));
`,
};

let dir = '';
const runs: Record<string, SavedRun> = {};
const paths: Record<string, string> = {};

function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) => {
    execFile(process.execPath, ['--disable-warning=ExperimentalWarning', BIN, ...args], { cwd: dir, encoding: 'utf8' }, (error, out, err) => done({ code: error ? Number(error.code ?? 1) : 0, out, err }));
  });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agent-origin-'));
  const jobs: Promise<unknown>[] = [];
  for (const [name, src] of Object.entries(PROGRAMS)) {
    writeFileSync(join(dir, name), src);
    const saved = join(dir, name.replace('.mjs', '.json'));
    paths[name] = saved;
    jobs.push(cli(['run', join(dir, name), '--save', saved]));
  }
  jobs.push(cli(['run', join(dir, 'nonetype.mjs'), '--save', join(dir, 'nolocals.json'), '--no-locals']));
  await Promise.all(jobs);
  for (const [name, saved] of Object.entries(paths)) runs[name] = new SavedRun(saved);
  paths['nolocals'] = join(dir, 'nolocals.json');
});

function errorStep(run: SavedRun): number {
  assert.equal(run.errors.length, 1, JSON.stringify(run.errors));
  return Number(run.errors[0]!.step);
}

function rootLink(result: Msg): Msg {
  const roots = result.links.filter((l: Msg) => l.root);
  assert.equal(roots.length, 1, JSON.stringify(result.links, null, 1));
  return roots[0];
}

// -- undefined from a function that falls off its end ----------------------------------------------------------

test('undefined made by a function return: the root is the call that fell off its end', () => {
  const run = runs['nonetype.mjs']!;
  const result = origin(run, errorStep(run));
  assert.equal(result.error.type, 'TypeError');
  assert.equal(result.error.caught, false);
  assert.deepEqual(result.value, { expr: 'rate', text: 'undefined', type: 'undefined', chosen: 'the undefined whose .toFixed was read' });
  assert.equal(result.need, 'a value that is not undefined');
  assert.deepEqual(result.links.map((l: Msg) => [l.line, l.how]), [[11, 'read'], [10, 'assigned'], [4, 'return']]);
  const root = rootLink(result);
  assert.equal(root.how, 'return');
  assert.equal(root.function, 'getRate');
  assert.equal(root.text, 'undefined');
  assert.equal(result.root.evidence, 'siblings');
  assert.equal(result.root.reason, 'getRate returned undefined here; its other 2 calls returned a number');
  assert.match(result.end, /getRate fell off its end/);
});

// -- a missing key: a Map and a plain object ----------------------------------------------------------------------

test('a key missing from a Map: the root is the change in place that left it out', () => {
  const run = runs['mapkey.mjs']!;
  const result = origin(run, errorStep(run));
  assert.equal(result.value.expr, 'settings');
  assert.equal(result.value.chosen, "the Map without key 'port'");
  assert.equal(result.need, "a Map with key 'port'");
  assert.deepEqual(result.links.map((l: Msg) => l.how), ['read', 'argument', 'assigned', 'return', 'assigned', 'literal']);
  const root = rootLink(result);
  assert.equal(root.line, 5);
  assert.equal(root.function, 'loadSettings');
  assert.match(root.note, /changed in place; 1 earlier change in place not shown/);
  assert.equal(result.root.reason, "the Map has no key 'port' from here on; it has 'prot'");
  assert.equal(result.end, 'a literal in the source');
});

test('a key missing from an object set in place: the unrecorded change is the root', () => {
  const run = runs['objkey.mjs']!;
  const result = origin(run, errorStep(run));
  assert.equal(result.need, "an object with key 'port'");
  assert.deepEqual(result.links.map((l: Msg) => [l.line, l.how]), [[8, 'read'], [12, 'argument'], [11, 'assigned'], [4, 'return'], [3, 'assigned'], [2, 'literal']]);
  const root = rootLink(result);
  assert.equal(root.statement, 'config.prot = env.PORT;');
  assert.equal(result.root.reason, "the object has no key 'port' from here on; it has 'prot'");
});

// -- an index past the end ----------------------------------------------------------------------------------------

test('an index past the end: the root is the call that returned the short array', () => {
  const run = runs['index.mjs']!;
  const result = origin(run, errorStep(run));
  assert.equal(result.value.expr, 'fields');
  assert.equal(result.need, 'an array longer than 2');
  const root = rootLink(result);
  assert.deepEqual([root.line, root.function, root.how], [2, 'parseLine', 'return']);
  assert.equal(result.root.reason, 'parseLine returned an array of length 2 here; its other 2 calls returned an array of length 3');
  const last = result.links[result.links.length - 1];
  assert.equal(last.how, 'literal');
  assert.equal(last.line, 9);
});

// -- invoices: a string where a number was needed, across calls, a container and a return ------------------------

test('invoices: the callback element, the argument chain, the pushed object and the return', () => {
  const run = runs['invoices.mjs']!;
  const step = errorStep(run);
  const result = origin(run, step);
  assert.equal(result.error.message, 'item.unitPrice.toFixed is not a function');
  assert.deepEqual(result.value, { expr: 'items[0].unitPrice', text: "'1,299.00'", type: 'string', chosen: 'the string whose .toFixed is not a function' });
  assert.equal(result.need, 'a value that is not a string');
  const shape = result.links.map((l: Msg) => [l.line, l.how, l.certainty]);
  assert.deepEqual(shape.slice(0, 2), [[29, 'read', 'recorded'], [34, 'argument', 'recorded']]);
  const element = result.links.find((l: Msg) => l.how === 'element' && l.line === 23);
  assert.ok(element, JSON.stringify(shape));
  assert.equal(element.expr, 'parsePrice(price)');
  assert.equal(element.certainty, 'inferred');
  assert.match(element.note, /no object identity/);
  const root = rootLink(result);
  assert.deepEqual([root.line, root.function, root.how], [14, 'parsePrice', 'return']);
  assert.equal(result.root.evidence, 'siblings');
  assert.equal(result.root.reason, 'parsePrice returned a string here; its other 4 calls returned a number');
  const price = result.links.find((l: Msg) => l.how === 'argument' && l.line === 23);
  assert.equal(price.text, '\'"1,299.00"\''); // price, before the quotes were stripped
  const last = result.links[result.links.length - 1];
  assert.deepEqual([last.line, last.how, last.certainty], [4, 'literal', 'text match']);
  assert.equal(result.end, 'a literal in the source');
});

test('invoices: text output', async () => {
  const run = runs['invoices.mjs']!;
  const r = await cli(['origin', paths['invoices.mjs']!, String(errorStep(run))]);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split('\n');
  assert.match(lines[0]!, /^TypeError at #\d+ invoices\.mjs:29 subtotal: item\.unitPrice\.toFixed is not a function$/);
  assert.ok(r.out.includes("the value: items[0].unitPrice = '1,299.00', where the statement needs a value that is not a string"), r.out);
  const rootLine = lines.find((l) => l.startsWith('▶'))!;
  assert.match(rootLine, /^▶ #\d+ invoices\.mjs:14 parsePrice .*◀ root$/);
  assert.match(r.out, /root: #\d+ invoices\.mjs:14 parsePrice: parsePrice returned a string here; its other 4 calls returned a number/);
  assert.ok(r.out.includes('chain ends: a literal in the source'));
  assert.ok(r.out.includes('inferred: picked by value'));
});

test('invoices: the JSON shape', async () => {
  const r = await cli(['origin', paths['invoices.mjs']!, String(errorStep(runs['invoices.mjs']!)), '--json']);
  assert.equal(r.code, 0, r.err);
  const doc = JSON.parse(r.out);
  for (const k of ['step', 'file', 'line', 'function', 'statement', 'error', 'value', 'need', 'links', 'root', 'end', 'truncated', 'recordedLocals', 'stale', 'staleFiles']) assert.ok(k in doc, k);
  for (const link of doc.links) {
    for (const k of ['step', 'file', 'line', 'function', 'expr', 'how', 'certainty']) assert.ok(k in link, k);
    assert.ok(['read', 'argument', 'element', 'return', 'assigned', 'literal'].includes(link.how), link.how);
    assert.ok(['recorded', 'inferred', 'text match'].includes(link.certainty), link.certainty);
    assert.ok(!('_sib' in link) && !('scopeReturned' in link));
  }
});

test('--depth cuts the chain', () => {
  const run = runs['invoices.mjs']!;
  const result = origin(run, errorStep(run), '', 3);
  assert.equal(result.links.length, 3);
  assert.equal(result.truncated, true);
  assert.match(result.end, /raise --depth/);
});

test('a named expression whose container was filled in place has no known root', () => {
  const run = runs['invoices.mjs']!;
  const step = run.errors[0]!.step - 8; // subtotal's statement on Ana's order, no exception there
  const result = origin(run, step, 'items');
  assert.equal(result.value.expr, 'items');
  assert.ok(!('need' in result));
  assert.equal(result.root, null);
  assert.ok('rootUnknown' in result);
  assert.match(result.end, /filled in place/);
});

test('no exception and no EXPR lists the reads; a named value is followed', () => {
  const run = runs['invoices.mjs']!;
  const assign = run.trace.count - 1 - [...Array(run.trace.count).keys()].reverse().findIndex((i) => run.trace.location(i)?.[1][0] === 33);
  const result = origin(run, assign);
  assert.equal(result.links.length, 0);
  assert.match(result.end, /give EXPR/);
  assert.deepEqual(result.reads.map((r: Msg) => r.name), ['DISCOUNTS', 'order']);
  const named = origin(run, assign, 'order.tier');
  assert.equal(named.value.expr, 'order.tier');
  assert.equal(named.links[0].how, 'read');
});

test('without locals it says so', async () => {
  const run = new SavedRun(paths['nolocals']!);
  const result = origin(run, errorStep(run));
  assert.equal(result.recordedLocals, false);
  assert.equal(result.links.length, 0);
  assert.match(result.hint, /--record-locals/);
  const r = await cli(['origin', paths['nolocals']!, String(errorStep(run))]);
  assert.equal(r.code, 0);
  assert.match(r.out, /recorded no locals/);
});

// -- undefined from a builtin, null through containers, a constructor argument ---------------------------------------

test('undefined from forEach ends at the call', () => {
  const run = runs['foreach.mjs']!;
  const result = origin(run, errorStep(run));
  assert.equal(result.value.expr, 'ranked');
  assert.deepEqual(result.links.map((l: Msg) => [l.line, l.how]), [[3, 'read'], [2, 'assigned']]);
  assert.equal(rootLink(result).line, 2);
  assert.match(result.end, /the undefined is the call's own result/);
});

test('null carried through an object literal across calls: the root is the call that returned it', () => {
  const run = runs['container.mjs']!;
  const result = origin(run, errorStep(run));
  assert.deepEqual(result.value, { expr: 'row.user', text: 'null', type: 'null', chosen: 'the null whose .name was read' });
  assert.equal(result.links[1].expr, 'pair.second.user');
  const root = rootLink(result);
  assert.deepEqual([root.function, root.how], ['lookup', 'return']);
  assert.equal(result.root.reason, 'lookup returned null here; its other 1 calls returned an object');
});

test('a value followed into a constructor: the call that passed a different type is the root', () => {
  const run = runs['boxes.mjs']!;
  const last = run.trace.count - 1;
  const result = origin(run, last, 'box.items');
  assert.equal(result.value.text, '3');
  const element = result.links.find((l: Msg) => l.how === 'element');
  assert.equal(element.function, 'constructor');
  const root = rootLink(result);
  assert.equal(root.how, 'argument');
  assert.equal(result.root.reason, 'this call passed a number here; its other 1 calls passed an array');
});

// -- the pieces ---------------------------------------------------------------------------------------------------

test('needFromError reads V8 messages', () => {
  let n = needFromError('TypeError', "Cannot read properties of undefined (reading 'price')")!;
  assert.deepEqual([n.kind, n.bad, n.attr], ['type', 'undefined', 'price']);
  n = needFromError('TypeError', "Cannot set properties of null (setting 'x')")!;
  assert.deepEqual([n.bad, n.attr], ['null', 'x']);
  n = needFromError('TypeError', 'item.price.toFixed is not a function')!;
  assert.deepEqual([n.fitsType, n.expr, n.describe()], ['function', 'item.price.toFixed', 'a function']);
  n = needFromError('TypeError', 'undefined is not iterable (cannot read property Symbol(Symbol.iterator))')!;
  assert.deepEqual([n.bad, n.fitsType], ['undefined', 'iterable']);
  n = needFromError('TypeError', 'rows is not iterable')!;
  assert.deepEqual([n.expr, n.describe()], ['rows', 'an iterable']);
  assert.equal(n.fits('[ 1 ]'), true);
  assert.equal(n.fits('3'), false);
  n = needFromError('TypeError', "Cannot destructure property 'a' of 'opts' as it is undefined.")!;
  assert.deepEqual([n.bad, n.expr], ['undefined', 'opts']);
  assert.equal(needFromError('RangeError', 'Invalid array length'), null);
  assert.equal(needFromError('TypeError', 'Cannot mix BigInt and other types, use explicit conversions'), null);
});
