import * as esbuild from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tracelightSources, toTracelight } from './scripts/brand.mjs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
// `--tracelight` builds the Tracelight extension (JavaScript / TypeScript) into tracelight/ from the
// same sources, renamed (src/brand.ts, scripts/brand.mjs); without it, Pyokka (Python) into dist/
const tracelight = process.argv.includes('--tracelight');
const ROOT = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const OUT = tracelight ? 'tracelight/dist' : 'dist';
const brand = tracelight ? { plugins: [tracelightSources(ROOT)], define: { __BRAND__: '"tracelight"' } } : { plugins: [], define: { __BRAND__: '"pyokka"' } };
const stamp = JSON.stringify(new Date().toISOString().replace('T', ' ').slice(0, 19) + (production ? '' : ' dev'));

const common = { bundle: true, sourcemap: !production, minify: production, logLevel: 'info' };

const extension = {
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: `${OUT}/extension.js`,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  plugins: brand.plugins,
  // stamped into the activation log and the status bar tooltip so a stale extension host is obvious
  define: { ...brand.define, __PYOKKA_BUILD__: stamp, __TRACELIGHT_BUILD__: stamp },
};

const webview = {
  ...common,
  entryPoints: {
    panel: 'webview/main.tsx',
    'editor.worker': 'monaco-editor/esm/vs/editor/editor.worker.js',
  },
  outdir: `${OUT}/webview`,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  loader: { '.ttf': 'file', '.css': 'css' },
  jsx: 'automatic',
  jsxImportSource: 'preact',
  plugins: brand.plugins,
  define: { ...brand.define, 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
};

// Pyokka in a browser (docs/WEB.md): the bridge server and the page around the same panel
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
  define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
  plugins: [{ name: 'path-shim', setup: (b) => b.onResolve({ filter: /^node:path$/ }, () => ({ path: new URL('web/pathShim.ts', import.meta.url).pathname })) }],
};

/** the Tracelight runtime (`node/`), shipped as source (Node strips its types) with its two dependencies (oxc-parser carries a platform binary, so a vsix is per platform) */
function copyNodeRuntime(to) {
  if (!existsSync('node/node_modules')) {
    console.warn('node/node_modules is missing: run `npm ci --prefix node` so the Tracelight runtime ships');
    return;
  }
  for (const d of ['src', 'bin']) cpSync(`node/${d}`, `${to}/${d}`, { recursive: true });
  cpSync('node/package.json', `${to}/package.json`);
  cpSync('node/node_modules', `${to}/node_modules`, { recursive: true });
}

/** codicons for the panel: node_modules is not packaged, so ship the font and stylesheet in dist */
function copyCodicons(out) {
  mkdirSync(`${out}/webview/codicons`, { recursive: true });
  for (const f of ['codicon.css', 'codicon.ttf']) cpSync(`node_modules/@vscode/codicons/dist/${f}`, `${out}/webview/codicons/${f}`);
}

/** the Narrate Tour prompt, shared with the skill (skills/ is not packaged) */
function copyTourPrompt(skill, out) {
  const prompt = `skills/${skill}/references/tour-prompt.md`;
  if (!existsSync(prompt)) return;
  mkdirSync(`${out}/prompts`, { recursive: true });
  cpSync(prompt, `${out}/prompts/tour-prompt.md`);
}

if (tracelight) {
  // tracelight/ holds what the manifest points at: renamed grammars, the JS snippets, the icons
  rmSync('tracelight/dist', { recursive: true, force: true });
  mkdirSync('tracelight/dist', { recursive: true });
  copyNodeRuntime('tracelight/dist/node');
  copyTourPrompt('tracelight', 'tracelight/dist');
  copyCodicons('tracelight/dist');
  mkdirSync('tracelight/syntaxes', { recursive: true });
  for (const f of readdirSync('syntaxes')) {
    if (/pyokka-(story|snap)\.tmLanguage/.test(f)) continue; // the Python ones
    writeFileSync(`tracelight/syntaxes/${toTracelight(f)}`, toTracelight(readFileSync(`syntaxes/${f}`, 'utf8')));
  }
  mkdirSync('tracelight/snippets', { recursive: true });
  cpSync('snippets/tracelight.code-snippets', 'tracelight/snippets/tracelight.code-snippets');
  cpSync('media', 'tracelight/media', { recursive: true, filter: (p) => !/\.(mp4|gif|mov)$/.test(p) });
  // Tracelight's own icons under the names the manifest shares with Pyokka's
  cpSync('media/tracelight-logo.png', 'tracelight/media/logo.png');
  cpSync('media/tracelight-logo-outline.svg', 'tracelight/media/logo-outline.svg');
  cpSync('media/tracelight-logo.svg', 'tracelight/media/logo.svg');
  cpSync('LICENSE', 'tracelight/LICENSE');
  // the start view's demo
  mkdirSync('tracelight/examples', { recursive: true });
  cpSync('examples/demo.ts', 'tracelight/examples/demo.ts');
} else {
  mkdirSync('dist', { recursive: true });
  // the Python runtime ships verbatim inside the extension
  cpSync('python/pyokka_runtime', 'dist/python/pyokka_runtime', { recursive: true, filter: (p) => !p.includes('__pycache__') });
  // JavaScript / TypeScript is the Tracelight extension's now (`--tracelight`); drop a runtime an older build left
  rmSync('dist/node', { recursive: true, force: true });
  copyTourPrompt('pyokka', 'dist');
  copyCodicons('dist');
  mkdirSync('dist/web', { recursive: true });
  cpSync('web/index.html', 'dist/web/index.html');
  cpSync('media/logo.png', 'dist/web/logo.png');
}

const builds = tracelight ? [extension, webview] : [extension, webview, webServer, webPage];
if (watch) {
  const ctxs = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(ctxs.map((c) => c.watch()));
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
