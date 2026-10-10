import { defineConfig } from '@vscode/test-cli';
import { mkdtempSync } from 'node:fs';

// A fresh TRACELIGHT_HOME per run: sessions, the relaunch memory, recent files and the library
// cache of the test window never meet the user's ~/.tracelight or another e2e run. Short and under
// /tmp so the session sockets inside it stay well under the 104-byte sun_path limit of macOS.
const TRACELIGHT_HOME = mkdtempSync('/tmp/tl-e2e-');

export default defineConfig({
  files: ['test/e2e/tracelight.test.js'],
  workspaceFolder: './examples',
  mocha: { ui: 'bdd', timeout: 180_000 },
  launchArgs: ['--disable-workspace-trust'],
  env: { TRACELIGHT_E2E: '1', TRACELIGHT_HOME },
});
