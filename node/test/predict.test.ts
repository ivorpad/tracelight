import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameVerdict, predict, regionsOf } from '../src/debug/predict.ts';

const SRC = [
  'function f() {', //                                       0
  '  try { g(); } catch (e) {}', //                          1
  '  g();', //                                               2
  '}', //                                                    3
  'async function h() { try { await g(); } catch {} g(); }', // 4
  'function w() {try{ g(); }catch(_tk_e_){throw _tk_e_}}', //  5
].join('\n');

test('a frame inside a try with a catch catches; the instrumenter\'s wrapper does not', () => {
  const r = regionsOf(SRC);
  assert.equal(frameVerdict(r, 1, 8), 'catches');
  assert.equal(frameVerdict(r, 2, 2), 'passes');
  assert.equal(frameVerdict(r, 4, 33), 'catches');
  assert.equal(frameVerdict(r, 4, 50), 'deferred');
  assert.equal(frameVerdict(r, 5, 19), 'passes');
});

test('the walk: program frames, then Node\'s loader is uncaught; a library or a microtask is unknown', () => {
  const r = regionsOf(SRC);
  const user = (line0: number, col: number) => ({ url: '/p/main.js', line0, col, regions: r, library: false });
  const node = (url: string) => ({ url, line0: 0, col: 0, regions: null, library: false });
  assert.equal(predict([user(2, 2), node('node:internal/modules/cjs/loader')]), 'uncaught');
  assert.equal(predict([user(2, 2), user(1, 8)]), 'caught');
  assert.equal(predict([user(2, 2), { url: '/p/node_modules/x/i.js', line0: 0, col: 0, regions: null, library: true }]), 'unknown');
  assert.equal(predict([user(2, 2), node('node:internal/process/task_queues')]), 'unknown');
  assert.equal(predict([user(2, 2), node('node:internal/timers')]), 'uncaught');
});
