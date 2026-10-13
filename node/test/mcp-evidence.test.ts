import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundedEvidence } from '../src/mcp/evidence.ts';

const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

test('limits nested history explicitly without mutating input or changing certainty', () => {
  const original = { kind: 'investigation', step: 0, run: '/run.json', history: { changes: [
    { step: 0, name: 'value', text: 'one', certainty: 'observed', complete: false },
    { step: 1, name: 'value', text: 'two', certainty: 'inferred', complete: true },
    { step: 2, name: 'value', text: 'three', certainty: 'unknown', complete: false },
  ] }, nested: { rows: [{ children: [1, 2, 3] }, {}, {}] } };
  const before = structuredClone(original);
  const result = boundedEvidence(original, 2);
  assert.deepEqual(original, before);
  assert.equal(result.step, 0);
  assert.equal(result.history.changes.length, 2);
  assert.equal(result.history.changes[0].complete, false);
  assert.equal(result.history.changes[1].certainty, 'inferred');
  assert.equal(result.nested.rows[0].children.length, 2);
  assert.ok(result.response.omissions.some((o: any) => o.path === 'history.changes' && o.original === 3 && o.omitted === 1));
  result.history.changes[0].text = 'changed';
  assert.deepEqual(original, before);
});

test('retains every verification check including a final failure under limit two', () => {
  const checks = Array.from({ length: 10 }, (_, i) => ({ name: `v${i}`, expected: '1', actual: i === 9 ? null : '1', passed: i !== 9, certainty: 'observed' }));
  const input = { kind: 'verification', verified: false, before: '/before.json', after: '/after.json', checks, statements: Array.from({ length: 10 }, (_, step) => ({ step })) };
  const result = boundedEvidence(input, 2);
  assert.equal(result.verified, false);
  assert.equal(result.before, input.before);
  assert.equal(result.after, input.after);
  assert.deepEqual(result.checks, checks);
  assert.equal(result.checks.at(-1)!.passed, false);
  assert.equal(result.checks.at(-1)!.actual, null);
  assert.equal(result.statements.length, 2);
  result.checks[0]!.passed = false;
  assert.equal(input.checks[0]!.passed, true);
});

test('noisy nested Unicode evidence fits UTF8 budget and reports string and list omissions', () => {
  const input = { kind: 'investigation', step: 9, history: { changes: Array.from({ length: 80 }, (_, step) => ({ step, text: '🧑🏽‍💻漢字'.repeat(5000), certainty: 'observed', known: false })) },
    detail: Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`section${i}`, { lines: ['🚀'.repeat(5000), 'x'.repeat(5000)], text: 'λ'.repeat(10000) }])) };
  const original = JSON.stringify(input);
  const result = boundedEvidence(input, 20);
  assert.ok(size(result) <= 32768, String(size(result)));
  assert.equal(result.kind, 'investigation');
  assert.equal(result.step, 9);
  assert.equal(JSON.stringify(input), original);
  assert.ok(result.response.omissions.some((o: any) => o.path === 'history.changes'));
  assert.ok(result.response.omissions.some((o: any) => o.reason === 'string-limit'));
  assert.ok(result.response.omissions.some((o: any) => o.reason === 'notice-limit' && o.omitted > 0));
  assert.equal(result.response.limit, 20);
  assert.equal(result.response.maxBytes, 32768);
});

test('whole-section omission is explicit and mandatory identities are never shortened', () => {
  const result = boundedEvidence({ kind: 'investigation', run: '/r.json', detail: { file: '/'.repeat(40000), certainty: 'observed', known: false } }, 2);
  assert.ok(size(result) <= 32768);
  assert.equal(result.run, '/r.json');
  assert.ok(result.response.omissions.some((o: any) => o.path === 'detail' && o.reason === 'section-byte-budget'));
  assert.throws(() => boundedEvidence({ verified: false, checks: [{ name: 'x', passed: false, actual: '🧪'.repeat(10000) }] }), /Mandatory evidence.*verification checks.*32768/);
});

test('validates limits and keeps small evidence unchanged apart from response metadata', () => {
  const input = { verified: false, checks: [], notes: ['Only this input.'], value: null, zero: 0 };
  assert.deepEqual(boundedEvidence(input), { ...input, response: { limit: 20, maxBytes: 32768, omissions: [] } });
  for (const limit of [0, 101, 1.5, NaN]) assert.throws(() => boundedEvidence(input, limit), /integer from 1 to 100/);
});

test('keeps completeness warnings, recording metadata and origin labels beside shortened text', () => {
  const input = { kind: 'investigation', notes: ['Recording is truncated.', 'Unobserved properties are unknown.'],
    meta: { file: '/input.ts', complete: false }, recording: { truncated: true },
    origin: { links: [{ name: 'total', file: '/input.ts', step: 3, how: 'assignment', certainty: 'inferred', text: '🧪'.repeat(2000) }] } };
  const result = boundedEvidence(input, 1);
  assert.deepEqual(result.notes, input.notes);
  assert.deepEqual(result.meta, input.meta);
  assert.deepEqual(result.recording, input.recording);
  assert.equal(result.origin.links[0].how, 'assignment');
  assert.equal(result.origin.links[0].certainty, 'inferred');
  assert.match(result.origin.links[0].text, /\[truncated\]$/);
  assert.ok(size(result) <= 32768);
});
