#!/usr/bin/env node
/**
 * `tracelight mcp --http` driving the browser page in a real headless Chrome, every step over MCP's
 * Streamable HTTP transport: initialize, then `tracelight_page` open, a breakpoint, a live debug
 * pause, `wait_pause`, a narration bubble, a scratchpad experiment, and close. Run after
 * `npm run build` (the page is dist/web); the MCP server is this checkout's node/ runtime.
 *
 *   node test/web-smoke/mcp.mjs          # CHROMIUM=/path/to/chrome to choose the browser
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
if (!existsSync(join(repo, 'dist/web/server.js'))) throw new Error('run `npm run build` first');
const chrome = process.env.CHROMIUM ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
if (!chrome) throw new Error('no Chrome found; set CHROMIUM');

const work = mkdtempSync(join(tmpdir(), 'tl-mcp-smoke-'));
const file = join(work, 'main.ts');
writeFileSync(file, 'export function add(a: number, b: number): number {\n  return a + b;\n}\nconst total = add(2, 3);\nconsole.log(total);\n');
const mcpPort = 4900 + Math.floor(Math.random() * 45);
const pagePort = mcpPort + 50;
const env = { ...process.env, TRACELIGHT_HOME: join(work, 'home') };
const children = [];
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const url = `http://127.0.0.1:${mcpPort}/mcp`;
let session;
let nextId = 1;

/** one JSON-RPC request; an SSE reply is read frame by frame until the response with this id */
async function rpc(method, params, extra = {}) {
  const id = nextId++;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session, 'mcp-protocol-version': '2025-11-25' } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params, ...extra }),
  });
  if (method === 'initialize') session = res.headers.get('mcp-session-id');
  const type = res.headers.get('content-type') ?? '';
  const text = await res.text();
  if (!type.startsWith('text/event-stream')) return JSON.parse(text);
  const frames = text.split('\n\n').filter(f => f.includes('data: ')).map(f => JSON.parse(f.slice(f.indexOf('data: ') + 6)));
  return frames.find(f => f.id === id);
}
const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;
const page = (args) => call('tracelight_page', { port: pagePort, ...args });
const scratch = (args) => call('tracelight_scratchpad', { port: pagePort, ...args });

try {
  children.push(spawn(process.execPath, [join(repo, 'node/bin/tracelight.mjs'), 'mcp', '--http', '--port', String(mcpPort)], { env, stdio: 'ignore' }));
  for (let i = 0; i < 40; i++) {
    try { await fetch(`http://127.0.0.1:${mcpPort}/`); break; } catch { await sleep(150); }
  }
  const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
  check(Boolean(session) && init.result?.serverInfo?.name === 'tracelight', `initialize mints a session (${session})`);
  const tools = (await rpc('tools/list', {})).result.tools.map(t => t.name);
  check(['tracelight_page', 'tracelight_scratchpad', 'tracelight_history'].every(n => tools.includes(n)), `tools/list has the page tools (${tools.length} tools)`);

  const opened = await page({ action: 'open', file });
  check(!opened.isError && opened.structuredContent?.url === `http://127.0.0.1:${pagePort}/`, `open serves the page (${opened.content[0].text.split('\n')[0]})`);
  children.push(spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${join(work, 'chrome')}`, `http://127.0.0.1:${pagePort}/`], { stdio: 'ignore' }));

  let state;
  for (let i = 0; i < 40; i++) {
    state = await page({ action: 'state' });
    if (!state.isError || state.structuredContent?.pages === 1) break;
    await sleep(250);
  }
  check(state.structuredContent?.pages === 1, `the tab connected (${state.structuredContent?.pages} page)`);

  const brk = await page({ action: 'breakpoint', line: 2, on: true });
  check(!brk.isError, `breakpoint at line 2 (${brk.content[0].text.slice(0, 120).replace(/\s+/g, ' ')})`);
  await page({ action: 'debug', op: 'start' });
  let paused = null;
  for (let i = 0; i < 30 && !paused; i++) {
    const s = await page({ action: 'debug', op: 'state' });
    const r = s.structuredContent?.result;
    if (r?.paused) paused = r;
    else await sleep(300);
  }
  check(Boolean(paused), `debug start paused at the breakpoint (${JSON.stringify(paused?.location ?? paused?.state?.location ?? null)})`);

  const cursor = await page({ action: 'wait_pause' });
  const at = cursor.structuredContent?.result?.cursor;
  check(Number.isInteger(at), `wait_pause without after reads the cursor (${at})`);
  const t0 = Date.now();
  const waited = await page({ action: 'wait_pause', after: at, timeout_ms: 1500 });
  check(waited.structuredContent?.result?.changed === false && Date.now() - t0 >= 1400, `wait_pause times out unchanged after 1.5 s (${Date.now() - t0} ms)`);

  const said = await page({ action: 'say', text: 'a + b is 5 here', line: 2 });
  check(!said.isError, 'say shows a narration bubble');
  const stopped = await page({ action: 'debug', op: 'stop' });
  check(!stopped.isError, 'debug stop');

  const experiment = await scratch({ op: 'create', title: 'add', code: 'const n: number = a + b;\nconsole.log(n);\nexport {};\n', inputs: { a: 2, b: 3 }, auto_run: false });
  check(experiment.structuredContent?.result?.ready === true, `scratchpad create is ready (${JSON.stringify(experiment.structuredContent?.result?.diagnostics ?? experiment.content[0].text.slice(0, 200))})`);
  const ran = await scratch({ op: 'run' });
  check(!ran.isError && JSON.stringify(ran.structuredContent?.result?.result?.output) === '[[5]]', `scratchpad run binds inputs (${JSON.stringify(ran.structuredContent?.result?.result?.output)})`);

  const closed = await page({ action: 'close' });
  check(!closed.isError, 'close stops the page this server started');
  await sleep(500);
  const gone = await page({ action: 'state' });
  check(gone.isError && /no Tracelight page/.test(gone.content[0].text), 'after close nothing serves the port');
  const ended = await fetch(url, { method: 'DELETE', headers: { 'mcp-session-id': session } });
  check(ended.status === 204, 'DELETE ends the session');
} catch (error) {
  check(false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  for (const child of children) child.kill('SIGKILL');
  await sleep(300);
  rmSync(work, { recursive: true, force: true });
}
process.exit(failures.length ? 1 : 0);
