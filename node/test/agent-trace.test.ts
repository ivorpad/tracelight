/** The agent's Time Machine model and redaction against the fixtures the extension's tests pin too. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Trace, type Location } from '../src/agent/trace.ts';
import { REDACTED, redact, redactValue } from '../src/agent/redact.ts';

const FIXTURES = resolve(import.meta.dirname, '../../test/unit/fixtures');
const CASES = JSON.parse(readFileSync(resolve(FIXTURES, 'trace-moves.json'), 'utf8'));

// the fixture's convention: every rid is a one-line statement on line `rid` of file 1
const at = (rid: number): Location => [1, [rid, 0, rid, 10]];

for (const name of Object.keys(CASES).sort()) {
  test(`trace moves match the TypeScript model: ${name}`, () => {
    const c = CASES[name];
    const trace = new Trace(Int32Array.from(c.quads), c.scopes, at);
    assert.equal(trace.count, c.count);
    for (const m of c.moves) {
      const i = m.step;
      const got = {
        step: i,
        into: trace.stepInto(i),
        back: trace.stepBackInto(i),
        over: trace.stepOver(i),
        backOver: trace.stepBackOver(i),
        out: trace.stepOut(i),
        backOut: trace.stepBackOut(i),
        canStep: trace.canStep(i),
        echo: trace.echoSteps(i),
        stack: trace.callStack(i).map((f) => ({ step: f.step, scopeId: f.scopeId })),
      };
      assert.deepEqual(got, m, `step ${i} of ${name}`);
      const want: Record<string, number | null> = {};
      for (const k of ['into', 'over', 'out', 'back', 'backOver', 'backOut']) want[k] = m[k] >= 0 ? m[k] : null;
      assert.deepEqual(trace.moves(i), want);
    }
    for (const s of c.startStep) assert.equal(trace.startStep(s.fileId, s.line), s.step, `startStep ${name} line ${s.line}`);
  });
}

test('blocks are one per frame for recursion', () => {
  const c = CASES.recursion;
  const trace = new Trace(Int32Array.from(c.quads), c.scopes, at);
  assert.deepEqual(trace.blocks(), [[0, 0, 0], [1, 1, 2], [2, 3, 4], [3, 5, 5], [0, 6, 6]]);
  assert.deepEqual(trace.blockAt(4), [2, 3, 4]);
  assert.equal(trace.blockAt(99), null);
  assert.deepEqual(trace.stepsOnLine(1, 2), [1, 3, 5]);
});

const module0 = (last: number) => [{ scopeId: 0, rid: 0, name: '<module>', parent: -1, depth: 0, first: 0, last }];

test('blocks split a loop into one block per turn', () => {
  const quads = [[1, 0, 0, 0], [2, 0, 0, 0], [1, 0, 0, 0], [2, 0, 0, 0], [1, 0, 0, 0], [3, 0, 0, 0]];
  const trace = Trace.fromQuads(quads, module0(5), at);
  assert.deepEqual(trace.blocks(), [[0, 0, 1], [0, 2, 3], [0, 4, 5]]);
  assert.deepEqual(trace.blockAt(3), [0, 2, 3]);
});

test('blocks keep steps that share a line together', () => {
  const quads = [[5, 0, 0, 0], [5, 0, 0, 0], [5, 0, 0, 0], [6, 0, 0, 0], [5, 0, 0, 0]];
  assert.deepEqual(Trace.fromQuads(quads, module0(4), at).blocks(), [[0, 0, 3], [0, 4, 4]]);
});

test('blocks ignore steps in another file', () => {
  const resolver = (rid: number): Location => (rid === 9 ? [2, [1, 0, 1, 5]] : at(rid));
  const quads = [[1, 0, 0, 0], [9, 0, 0, 0], [2, 0, 0, 0]];
  assert.deepEqual(Trace.fromQuads(quads, module0(2), resolver).blocks(), [[0, 0, 2]]);
});

test('redaction matches the shared fixture', () => {
  const fixture = JSON.parse(readFileSync(resolve(FIXTURES, 'redact.json'), 'utf8'));
  // the fixture spells Slack's prefix `<xox>` so scanners leave it alone
  for (const [input, want] of fixture.cases as [string, string][]) assert.equal(redact(input.replaceAll('<xox>', 'xox')), want.replaceAll('<xox>', 'xox'), input);
});

test('redactValue redacts text fields only, walking objects and arrays', () => {
  const v = redactValue({ text: 'key sk-abcdefghijklmnopqrstuvwxyz012345', path: 'AKIAIOSFODNN7EXAMPLE', list: [{ value: 'AKIAIOSFODNN7EXAMPLE' }, null] });
  assert.deepEqual(v, { text: `key ${REDACTED}`, path: 'AKIAIOSFODNN7EXAMPLE', list: [{ value: REDACTED }, null] });
});
