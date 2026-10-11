import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sessionsDir, tracelightHome } from '../src/home.ts';

test('Tracelight keeps its home and the Tracelight extension\'s sessions under it', () => {
  assert.equal(tracelightHome({}), join(homedir(), '.tracelight'));
  assert.equal(tracelightHome({ TRACELIGHT_HOME: '~/tl' }), join(homedir(), 'tl'));
  assert.equal(tracelightHome({ TRACELIGHT_HOME: '' }), join(homedir(), '.tracelight'));
  assert.equal(sessionsDir({}), join(homedir(), '.tracelight', 'sessions'));
  assert.equal(sessionsDir({ TRACELIGHT_HOME: '/tl' }), '/tl/sessions');
  assert.equal(sessionsDir({ TRACELIGHT_HOME: '/tl', TRACELIGHT_SESSIONS_DIR: '/t' }), '/t');
  // Pyokka's directories belong to the Python extension now
  assert.equal(sessionsDir({ PYOKKA_HOME: '/x', PYOKKA_SESSIONS_DIR: '/p' }), join(homedir(), '.tracelight', 'sessions'));
});
