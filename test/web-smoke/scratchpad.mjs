#!/usr/bin/env node
/**
 * The browser page in a real headless Chrome, for what vitest cannot load: Monaco's TypeScript
 * worker and a tab outliving a bridge restart. Run after `npm run build`:
 *
 *   npm run test:web-smoke          # CHROMIUM=/path/to/chrome to choose the browser
 *   TRACELIGHT_DIST=~/.vscode/extensions/ivor.tracelight-X/dist npm run test:web-smoke   # an installed build
 *
 * Checks that a scratchpad created unrun knows its `inputs` names, that `ready` reflects real
 * TypeScript errors rather than markers not yet computed, and that a tab reloads itself when the
 * bridge comes back on a rebuilt page bundle. Also that a live debug run of an entry guarded by
 * `if (import.meta.main)` pauses inside the guard instead of exiting.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dist = process.env.TRACELIGHT_DIST ? resolve(process.env.TRACELIGHT_DIST) : join(repo, 'dist');
const server = join(dist, 'web/server.js');
const app = join(dist, 'web/app.js');
if (!existsSync(server) || !existsSync(app)) throw new Error('run `npm run build` first');
const chrome = process.env.CHROMIUM ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
if (!chrome) throw new Error('no Chrome found; set CHROMIUM');

const work = mkdtempSync(join(tmpdir(), 'tl-web-smoke-'));
const file = join(work, 'main.ts');
writeFileSync(file, 'export const answer = 42;\nif (import.meta.main) {\n  const inside = answer + 1;\n  console.log(inside);\n}\n');
const port = 4900 + Math.floor(Math.random() * 90);
const env = { ...process.env, TRACELIGHT_HOME: join(work, 'home') };
const children = [];
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function bridge() {
  const child = spawn(process.execPath, [server, file, '--port', String(port), '--no-run', '--no-watch'], { cwd: work, env, stdio: 'ignore' });
  children.push(child);
  return child;
}
function ctl(...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [server, 'ctl', '--port', String(port), ...args], { env });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('exit', () => { try { resolve(JSON.parse(out)); } catch { reject(new Error(`ctl ${args.join(' ')}: ${out}`)); } });
  });
}
async function command(body, attempts = 40) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'scratchpad', ...body }) });
      const reply = await res.json();
      if (reply.error) throw new Error(reply.error);
      return reply.result;
    } catch (error) {
      if (i >= attempts) throw error;
      await sleep(500);
    }
  }
}

try {
  let bridgeProcess = bridge();
  await sleep(1000);
  children.push(spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${join(work, 'chrome')}`, `http://127.0.0.1:${port}/`], { stdio: 'ignore' }));

  const environment = await fetch(`http://127.0.0.1:${port}/api/scratchpad/environment`, { headers: { origin: `http://127.0.0.1:${port}` } });
  const declared = await environment.json();
  check(environment.ok && declared.libraries?.some(l => l.path.startsWith('node_modules/@types/node/')), `runtime declarations ship with the build (${environment.status} ${declared.error ?? ''})`);

  const clean = await command({ op: 'create', title: 'inputs', code: 'const n: number = buffer.length;\nconsole.log(n);\nexport {};\n', inputs: { buffer: 'abc' }, autoRun: false });
  check(clean.ready === true && clean.diagnostics.length === 0, `unrun scratchpad with inputs is ready (${JSON.stringify(clean.diagnostics)})`);
  check(clean.status !== 'completed', 'create with autoRun false did not run');

  const broken = await command({ op: 'create', title: 'broken', code: 'const n: number = missingName;\nexport {};\n', autoRun: false });
  check(broken.ready === false && broken.diagnostics.some(d => /missingName/.test(d.message)), 'a real TypeScript error makes ready false in the create reply itself');

  const run = await command({ op: 'load', id: clean.id }).then(() => command({ op: 'run' }));
  check(run.status === 'completed' && JSON.stringify(run.result?.output) === '[[3]]', `run binds inputs (${JSON.stringify(run.result?.output)})`);

  await ctl('break', '4', 'on');
  await ctl('debug', 'start');
  let paused;
  for (let i = 0; i < 20 && !paused; i++) {
    const state = await ctl('debug', 'state');
    const at = state.result?.location ?? state.result?.state?.location;
    if (state.result?.paused) paused = at ?? true;
    else await sleep(500);
  }
  check(Boolean(paused), `debug run paused inside if (import.meta.main) (${JSON.stringify(paused)})`);
  await ctl('debug', 'stop');

  const open = await command({ op: 'state' });
  check(open.open === true, 'pane open before the bridge restart');
  bridgeProcess.kill();
  await new Promise(r => bridgeProcess.once('exit', r));
  const now = new Date();
  utimesSync(app, now, new Date(now.getTime() + 1000));
  bridgeProcess = bridge();
  await sleep(8000);
  const after = await command({ op: 'state' });
  check(after.open === false, 'tab reloaded on the rebuilt bundle (pane reset)');
} catch (error) {
  check(false, error instanceof Error ? error.message : String(error));
} finally {
  for (const child of children) child.kill('SIGKILL');
  await sleep(300);
  rmSync(work, { recursive: true, force: true });
}
process.exit(failures.length ? 1 : 0);
