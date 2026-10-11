import { defineConfig } from '@vscode/test-cli';
import { mkdtempSync } from 'node:fs';

// A fresh TRACELIGHT_HOME per run: sessions, the relaunch memory, recent files and the library
// cache of the test window never meet the user's ~/.tracelight or another e2e run. Short and under
// /tmp so the session sockets inside it stay well under the 104-byte sun_path limit of macOS.
// Build first (`npm run build`, with `npm ci --prefix node` once).
//
// Note: @vscode/test-electron always passes --disable-workspace-trust, so the untrusted-workspace
// gate (tracelight.untrustedWorkspaceBehavior) cannot be exercised here.
export default defineConfig({
  files: ['test/e2e/tracelight.test.js', 'test/e2e/library-cache.test.js'],
  workspaceFolder: './examples',
  mocha: { ui: 'bdd', timeout: 180_000 },
  launchArgs: ['--disable-workspace-trust'],
  env: { TRACELIGHT_E2E: '1', TRACELIGHT_HOME: mkdtempSync('/tmp/tl-e2e-') },
});
