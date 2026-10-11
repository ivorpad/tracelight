/** The agent's leaf modules: value texts, names, decisions, the why sentence, recording notes, argparse. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Entries, UNKNOWN, parse, pathText, project, textOf, typeOf } from '../src/agent/reprs.ts';
import { loopNames, namesOf } from '../src/agent/names.ts';
import { enclosingFunction, fileMap } from '../src/agent/decisions.ts';
import { conclusion } from '../src/agent/why_text.ts';
import { annotateCut, commas, cutLine } from '../src/agent/recording.ts';
import { armText, flat, pyText, slug } from '../src/agent/checkpoint.ts';
import { AgentError, displayPath } from '../src/agent/source.ts';
import { ArgError, ArgumentParser, HelpRequested } from '../src/agent/argparse.ts';

test('reprs: util.inspect texts parse to values', () => {
  const v = parse("{ a: 1, b: [ 1, 2 ], c: 'x' }") as Entries;
  assert.ok(v instanceof Entries);
  assert.deepEqual([...v.entries], [['a', 1], ['b', [1, 2]], ['c', 'x']]);
  assert.equal(project(parse('{ items: [ { price: 3 } ] }'), ['items', 0, 'price']), 3);
  assert.equal(project(parse('{ a: 1 }'), ['b']), undefined); // a whole object without the key: undefined, as in JavaScript
  assert.equal(parse('{ a: [Object] }') instanceof Entries, true);
  assert.equal(project(parse('{ a: [Object] }'), ['a']), UNKNOWN);
});

test('reprs: a cut text keeps its complete elements, the shortened one unknown', () => {
  assert.deepEqual(parse('[ 1, 2, 3, 4…(+12 chars)'), [1, 2, 3, UNKNOWN]);
  assert.deepEqual(parse("[ 'a', 'b'…(+9 chars)"), ['a', 'b', UNKNOWN]);
  assert.deepEqual(parse('[ 1, [ 2, 3…(+3 chars)'), [1, UNKNOWN]);
  const obj = parse('{ a: 1, b: 2, c: 3…(+5 chars)') as Entries;
  assert.equal(project(obj, ['a']), 1);
  assert.equal(project(obj, ['c']), UNKNOWN);
  assert.equal(parse("'abc…(+9 chars)"), UNKNOWN);
});

test('reprs: JavaScript type names', () => {
  const texts = ["'x'", '3', '[ 1 ]', 'Map(1) { 1 => 2 }', 'undefined', 'null', '{ a: 1 }', '2024-01-01T00:00:00.000Z', '[Function: f]', 'Account { x: 1 }'];
  assert.deepEqual(texts.map(typeOf), ['string', 'number', 'Array', 'Map', 'undefined', 'null', 'Object', 'Date', 'function', 'Account']);
  assert.equal(pathText('items', [0, 'price']), 'items[0].price');
  assert.equal(textOf({ a: [1, { b: 2 }] }), '{ a: [ 1, { b: 2 } ] }');
});

test('names: targets and reads of JavaScript statements', () => {
  assert.deepEqual(namesOf(['const total = price * qty; // tax']), [['total'], ['price', 'qty']]);
  assert.deepEqual(namesOf(['x += y']), [['x'], ['x', 'y']]);
  assert.deepEqual(namesOf(['const { a, b } = obj']), [['a', 'b'], ['obj']]);
  assert.deepEqual(namesOf(['log(`hi ${name}`, "s")']), [[], ['log', 'name']]);
  assert.deepEqual(namesOf(['const o = { key: v, n: 10_000 };']), [['o'], ['v']]);
  assert.deepEqual(loopNames('const x of xs'), [['x'], ['xs']]);
  assert.deepEqual(loopNames('let i = 0; i < n; i++'), [[], ['n']]);
});

test('decisions: if / else if, switch, loops, returns and qualified names from the AST', () => {
  const src = 'class A {\n  m(x) {\n    if (x > 1) {\n      return 1;\n    } else if (x) {\n      return 2;\n    }\n    switch (x) {\n      case 1:\n        break;\n      default:\n        x = 0;\n    }\n  }\n}\nfor (const v of [1]) {}\nwhile (false) {}\nconst f = (y: number) => y;\n';
  const fm = fileMap(src, 'a.ts');
  assert.deepEqual(fm.decisions.get(3), { kind: 'if', label: 'if', line: 3, col: 4, text: '(x > 1)', body: [4, 4], bodyAt: [4, 6, 4, 14], orelse: [5, 7] });
  assert.deepEqual(fm.decisions.get(5), { kind: 'if', label: 'else if', line: 5, col: 11, text: '(x)', body: [6, 6], bodyAt: [6, 6, 6, 14], orelse: [0, 0] });
  assert.deepEqual(fm.decisions.get(8), { kind: 'match', keyword: 'switch', line: 8, col: 4, text: '(x)', arms: [{ text: '1', body: [10, 10], default: false }, { text: 'default', body: [12, 12], default: true }] });
  assert.deepEqual(fm.loops.get(16), { kind: 'for', line: 16, col: 0, text: '(const v of [1])', end: 16 });
  assert.deepEqual(fm.loops.get(17), { kind: 'while', line: 17, col: 0, text: '(false)', end: 17 });
  assert.deepEqual([...fm.returns], [4, 6]);
  assert.deepEqual(Object.fromEntries(fm.qualnames), { 2: 'A.m', 18: 'f' });
  assert.deepEqual(enclosingFunction(fm, 4), { name: 'A.m', line: 2, end: 14 });
  assert.equal(enclosingFunction(fm, 16), null);
  assert.equal(fileMap('if (', 'bad.js').decisions.size, 0);
});

test('why: the closing sentence for JavaScript statements', () => {
  const at = { step: 3, file: '/w/a.js', line: 2 };
  assert.equal(
    conclusion({ root: { name: 'label', step: 7, file: '/w/main.ts', line: 8, text: "'rich'", statement: "let label = acct.balance > 50 ? 'rich' : 'poor';", reads: [] } }),
    "label is 'rich' at #7 (main.ts:8). The if arm ran: acct.balance > 50 was true.",
  );
  assert.equal(
    conclusion({ root: { name: 'y', ...at, text: '4', statement: 'const y = x;', reads: [{ name: 'x', text: '4', step: 1, file: 'a.js', line: 1 }] } }),
    'y is 4 at #3 (a.js:2). It copies x, which has been 4 since #1 (a.js:1).',
  );
  assert.equal(
    conclusion({ root: { name: 'v', ...at, text: 'undefined', statement: 'const v = d[k];', reads: [{ name: 'd', text: '{ a: 1, b: 2 }', step: 1 }] } }),
    'v is undefined at #3 (a.js:2). d[k] is undefined: the key is not in d (2 keys).',
  );
  assert.equal(
    conclusion({ root: { name: 'r', ...at, text: '6', statement: 'const r = f(a, b);', calls: [{ name: 'f', result: '6', inputs: [{ name: 'b', text: 'undefined' }] }] } }),
    'r is 6 at #3 (a.js:2). f(a, b) returned 6 with b = undefined.',
  );
  assert.equal(conclusion({ root: { name: 'r', step: null } }), '');
});

test('recording and checkpoint helpers keep Python’s texts', () => {
  assert.equal(cutLine('abcdefghij', 5), 'ab…(+8 chars)');
  assert.equal(commas(1234567), '1,234,567');
  assert.deepEqual(annotateCut({ text: "'aaaa…(+1,234 chars)" }), { text: "'aaaa…(+1,234 chars)", truncated: true, length: 1239 });
  assert.deepEqual([pyText(null), pyText(true), pyText(false), pyText(3)], ['None', 'True', 'False', '3']);
  assert.equal(slug('Hello World!'), 'Hello-World');
  assert.equal(flat('a\nb   c'), 'a b   c');
  assert.equal(armText(['case 1', 'case 2']), 'case 1 x1, 2 x1');
});

test('display paths: packages by name, the workspace relative', () => {
  assert.equal(displayPath('/w/node_modules/lodash/x.js', '/w'), 'lodash/x.js');
  assert.equal(displayPath('/w/src/a.ts', '/w'), 'src/a.ts');
  assert.equal(displayPath('/other/a.ts', '/w'), '/other/a.ts');
  assert.deepEqual(new AgentError('m', 'h').toJson(), { ok: false, error: 'm', hint: 'h' });
});

test('argparse: groups, types, abbreviations, usage wrapping and help', () => {
  const p = new ArgumentParser('tool');
  p.addArgument('run', { nargs: '?', metavar: 'RUN' });
  p.addArgument('--count', { type: 'int', default: 40, metavar: 'K' });
  const g = p.group(true);
  p.addArgument('--into', { action: 'store_true' }, g);
  p.addArgument('--over', { action: 'store_true' }, g);
  assert.deepEqual(p.parse(['r.json', '--cou', '3', '--into']), { run: 'r.json', count: 3, into: true, over: false });
  assert.equal(p.usage(), 'usage: tool [-h] [--count K] (--into | --over) [RUN]');
  assert.throws(() => p.parse(['--into', '--over']), (e: any) => e instanceof ArgError && e.message === 'argument --over: not allowed with argument --into');
  assert.throws(() => p.parse([]), (e: any) => e instanceof ArgError && /one of the arguments --into --over is required/.test(e.message));
  assert.throws(() => p.parse(['--into', '--count', 'x']), (e: any) => e instanceof ArgError && e.message === "argument --count: invalid int value: 'x'");
  assert.throws(() => p.parse(['-h']), (e: any) => e instanceof HelpRequested && /^usage: tool .*\n\npositional arguments:\n {2}RUN\n\noptions:\n {2}-h, --help/s.test(e.message));
});
