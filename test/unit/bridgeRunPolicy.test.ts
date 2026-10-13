/**
 * What executes the program while the browser's live debugger has a run. A save in any editor
 * and a settings change refresh what the page shows; neither may start a second execution beside
 * the paused one. Run, Open and startup still execute, and saves re-run again once the debug run ends.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BridgeServer } from '../../web/server';
import { blocksBridgeRun } from '../../web/runPolicy';
import type { BridgeToPage } from '../../web/bridgeProtocol';

const fake = path.join(__dirname, 'fixtures', 'fakeRunner.cjs');

describe('blocksBridgeRun', () => {
  it('holds back only the runs nobody asked for, and only while a debug run is active', () => {
    for (const reason of ['disk', 'settings']) {
      expect(blocksBridgeRun(true, reason), reason).toBe(true);
      expect(blocksBridgeRun(false, reason), reason).toBe(false);
    }
    for (const reason of ['page', 'open', 'start']) expect(blocksBridgeRun(true, reason), reason).toBe(false);
  });
});

type Page = { ws: WebSocket; messages: BridgeToPage[]; next: (pred: (m: BridgeToPage) => boolean, what?: string) => Promise<BridgeToPage> };

function connect(port: number): Promise<Page> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages: BridgeToPage[] = [];
    const waiters: [(m: BridgeToPage) => boolean, (m: BridgeToPage) => void][] = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as BridgeToPage;
      messages.push(m);
      for (const w of [...waiters]) if (w[0](m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w[1](m);
      }
    };
    const next = (pred: (m: BridgeToPage) => boolean, what = 'message') => new Promise<BridgeToPage>((res, rej) => {
      const hit = messages.find(pred);
      if (hit) return res(hit);
      const timer = setTimeout(() => rej(new Error(`no ${what}; last: ${JSON.stringify(messages.slice(-3)).slice(0, 600)}`)), 15_000);
      waiters.push([pred, (m) => { clearTimeout(timer); res(m); }]);
    });
    ws.onopen = () => resolve({ ws, messages, next });
    ws.onerror = () => reject(new Error('websocket failed'));
  });
}

/** Messages are handled in order, so a reply to `recent` means every earlier message was. */
async function settle(page: Page): Promise<void> {
  const before = page.messages.length;
  page.ws.send(JSON.stringify({ type: 'recent' }));
  await page.next((m) => m.type === 'recent' && page.messages.indexOf(m) >= before, 'recent');
}

const runsBegun = (page: Page) => page.messages.filter((m): m is Extract<BridgeToPage, { type: 'run.begin' }> => m.type === 'run.begin');

describe('BridgeServer while the live debugger has a run', () => {
  let server: BridgeServer | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('refreshes source and keeps settings for later, starting no run until the debug run ends', async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tl-policy-')));
    const file = path.join(dir, 'scratch.py');
    fs.writeFileSync(file, 'print("ok")\n');
    server = new BridgeServer({ file, port: 0, host: '127.0.0.1', runtime: `"${process.execPath}" "${fake}"`, watch: true, initialRun: false, open: false, distDir: dir, stateDir: dir });
    await server.start();
    const page = await connect(Number(new URL(server.url).port));
    await page.next((m) => m.type === 'hello');
    page.ws.send(JSON.stringify({ type: 'debug.start', breakpoints: [], exceptions: 'uncaught' }));
    const begin = (await page.next((m) => m.type === 'debug.begin')) as Extract<BridgeToPage, { type: 'debug.begin' }>;
    await page.next((m) => m.type === 'debug.event' && m.event.type === 'debug.paused', 'debug.paused');

    // a save from VS Code or another agent: the page gets the new text, nothing executes
    fs.writeFileSync(file, 'print("edited while paused")\n');
    await page.next((m) => m.type === 'file' && m.file.content.includes('edited while paused'), 'refreshed source');
    // a setting changed in the page: kept for the next run, nothing executes now
    page.ws.send(JSON.stringify({ type: 'config', patch: { autoLog: true } }));
    await settle(page);
    expect(runsBegun(page)).toEqual([]);

    // the debug run ends; saves re-run again, and the next run carries the setting
    page.ws.send(JSON.stringify({ type: 'debug.request', id: 1, body: { type: 'debug', runId: begin.runId, action: 'continue' } }));
    await page.next((m) => m.type === 'debug.end', 'debug.end');
    fs.writeFileSync(file, 'print("saved after debugging")\n');
    const disk = (await page.next((m) => m.type === 'run.begin', 'disk run')) as Extract<BridgeToPage, { type: 'run.begin' }>;
    expect(disk).toMatchObject({ reason: 'disk', content: 'print("saved after debugging")\n' });
    const started = (await page.next((m) => m.type === 'event' && m.event.type === 'run.started' && m.event.runId === disk.runId, 'run.started')) as Extract<BridgeToPage, { type: 'event' }>;
    expect(started.event).toMatchObject({ autoLog: true });
    page.ws.close();
  });

  it('runs explicit requests while paused', async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tl-policy-')));
    const file = path.join(dir, 'scratch.py');
    fs.writeFileSync(file, 'print("ok")\n');
    server = new BridgeServer({ file, port: 0, host: '127.0.0.1', runtime: `"${process.execPath}" "${fake}"`, watch: true, initialRun: false, open: false, distDir: dir, stateDir: dir });
    await server.start();
    const page = await connect(Number(new URL(server.url).port));
    await page.next((m) => m.type === 'hello');
    page.ws.send(JSON.stringify({ type: 'debug.start', breakpoints: [], exceptions: 'uncaught' }));
    await page.next((m) => m.type === 'debug.event' && m.event.type === 'debug.paused', 'debug.paused');
    // the Run button, `ctl run` and `tracelight_run` send this; the person asked for an execution
    page.ws.send(JSON.stringify({ type: 'run' }));
    expect(await page.next((m) => m.type === 'run.begin', 'explicit run')).toMatchObject({ reason: 'page' });
    page.ws.close();
  });

  it('with the real runtime: a save during a paused lesson repeats no side effect', async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tl-policy-node-')));
    const file = path.join(dir, 'main.ts');
    const effects = path.join(dir, 'side-effects.log');
    const source = [
      "import { appendFileSync } from 'node:fs';",
      "appendFileSync(new URL('./side-effects.log', import.meta.url), 'executed\\n');",
      'function work(n: number): number {',
      '  const doubled = n * 2;',
      '  return doubled;',
      '}',
      'console.log(work(21));',
      '',
    ].join('\n');
    fs.writeFileSync(file, source);
    const executions = () => (fs.existsSync(effects) ? fs.readFileSync(effects, 'utf8').split('\n').filter(Boolean).length : 0);
    // no dist here: the bridge falls back to the checkout's runtime, as nativeRuntime.test.ts does
    server = new BridgeServer({ file, runtime: 'node', port: 0, host: '127.0.0.1', watch: true, initialRun: false, open: false, distDir: path.resolve(__dirname, '../../unbuilt-test'), stateDir: dir });
    await server.start();
    const page = await connect(Number(new URL(server.url).port));
    await page.next((m) => m.type === 'hello');
    page.ws.send(JSON.stringify({ type: 'debug.start', breakpoints: [{ path: file, line: 4 }], exceptions: 'uncaught', stopOnEntry: false }));
    const begin = (await page.next((m) => m.type === 'debug.begin')) as Extract<BridgeToPage, { type: 'debug.begin' }>;
    const paused = (await page.next((m) => m.type === 'debug.event' && m.event.type === 'debug.paused', 'pause at line 4')) as Extract<BridgeToPage, { type: 'debug.event' }>;
    expect(paused.event).toMatchObject({ line: 4 });
    expect(executions()).toBe(1);

    fs.writeFileSync(file, source.replace('n * 2', 'n * 3'));
    await page.next((m) => m.type === 'file' && m.file.content.includes('n * 3'), 'refreshed source');
    await settle(page);
    // give a run that should not exist the time to reach the program's first statement
    await new Promise((r) => setTimeout(r, 1500));
    expect(runsBegun(page)).toEqual([]);
    expect(executions()).toBe(1);

    // the paused program still runs the code it started with
    page.ws.send(JSON.stringify({ type: 'debug.request', id: 2, body: { type: 'debug', runId: begin.runId, action: 'continue' } }));
    await page.next((m) => m.type === 'debug.end', 'debug.end');
    expect(page.messages.some((m) => m.type === 'debug.event' && m.event.type === 'log' && m.event.text === '42')).toBe(true);
    expect(executions()).toBe(1);
    page.ws.close();
  }, 30_000);
});
