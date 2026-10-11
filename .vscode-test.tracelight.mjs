import { defineConfig } from '@vscode/test-cli';
import { mkdtempSync } from 'node:fs';

// Tracelight on its own and next to Pyokka: build both first
// (`node esbuild.mjs && node esbuild.mjs --tracelight`). Fresh homes per run, short and under /tmp
// so session sockets stay under the 104-byte sun_path limit of macOS.
export default defineConfig({
  files: ['test/e2e/tracelight.test.js', 'test/e2e/side-by-side.test.js'],
  extensionDevelopmentPath: ['./tracelight', '.'],
  workspaceFolder: './examples',
  mocha: { ui: 'bdd', timeout: 180_000 },
  launchArgs: ['--disable-workspace-trust'],
  env: { PYOKKA_E2E: '1', TRACELIGHT_E2E: '1', PYOKKA_HOME: mkdtempSync('/tmp/pk-e2e-'), TRACELIGHT_HOME: mkdtempSync('/tmp/tl-e2e-') },
});
