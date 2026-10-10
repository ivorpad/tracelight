import * as esbuild from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
const stamp = JSON.stringify(new Date().toISOString().replace('T', ' ').slice(0, 19) + (production ? '' : ' dev'));

const common = { bundle: true, sourcemap: !production, minify: production, logLevel: 'info' };

const extension = {
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  // stamped into the activation log and the status bar tooltip so a stale extension host is obvious
  define: { __TRACELIGHT_BUILD__: stamp },
};

const webview = {
  ...common,
  entryPoints: {
    panel: 'webview/main.tsx',
    'editor.worker': 'monaco-editor/esm/vs/editor/editor.worker.js',
  },
  outdir: 'dist/webview',
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  loader: { '.ttf': 'file', '.css': 'css' },
  jsx: 'automatic',
  jsxImportSource: 'preact',
  define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
};

// Tracelight in a browser (docs/WEB.md): the bridge server and the page around the same panel
const webServer = {
  ...common,
  entryPoints: ['web/server.ts'],
  outfile: 'dist/web/server.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
};

const webPage = {
  ...webview,
  entryPoints: { app: 'web/main.tsx' },
  outdir: 'dist/web',
  // the walkthrough and exceptions builders call node:path on the runtime's paths
  plugins: [{ name: 'path-shim', setup: (b) => b.onResolve({ filter: /^node:path$/ }, () => ({ path: new URL('web/pathShim.ts', import.meta.url).pathname })) }],
};

/** the runtime (`node/`), shipped as source (Node strips its types) with its dependencies (oxc-parser carries a platform binary, so a vsix is per platform) */
function copyNodeRuntime(to) {
  if (!existsSync('node/node_modules')) {
    console.warn('node/node_modules is missing: run `npm ci --prefix node` so the runtime ships');
    return;
  }
  rmSync(to, { recursive: true, force: true });
  for (const d of ['src', 'bin']) cpSync(`node/${d}`, `${to}/${d}`, { recursive: true });
  cpSync('node/package.json', `${to}/package.json`);
  cpSync('node/node_modules', `${to}/node_modules`, { recursive: true, dereference: true });
}

mkdirSync('dist', { recursive: true });
copyNodeRuntime('dist/node');
// codicons for the panel: node_modules is not packaged, so ship the font and stylesheet in dist
mkdirSync('dist/webview/codicons', { recursive: true });
for (const f of ['codicon.css', 'codicon.ttf']) cpSync(`node_modules/@vscode/codicons/dist/${f}`, `dist/webview/codicons/${f}`);
// the Narrate Tour prompt, shared with the skill (skills/ is not packaged)
mkdirSync('dist/prompts', { recursive: true });
cpSync('skills/tracelight/references/tour-prompt.md', 'dist/prompts/tour-prompt.md');
mkdirSync('dist/web', { recursive: true });
cpSync('web/index.html', 'dist/web/index.html');
cpSync('media/logo.png', 'dist/web/logo.png');

const builds = [extension, webview, webServer, webPage];
if (watch) {
  const ctxs = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(ctxs.map((c) => c.watch()));
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
