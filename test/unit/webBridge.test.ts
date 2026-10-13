import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BridgeServer, LOG_PATH, ctlExitCode, languageFor, parseCtl, pickConfig, pickWatches, runConfig, runtimeCommand, sameOrigin, splitCommand } from '../../web/server';
import { ServerViews } from '../../web/serverViews';
import { applyEvent, emptyRun } from '../../web/runState';
import { packSteps } from '../../src/timeMachine/traceModel';
import type { RunEvent } from '../../src/shared/protocol';
import { decodeFrames, encodeFrame } from '../../web/ws';
import type { BridgeToPage } from '../../web/bridgeProtocol';
import * as pathShim from '../../web/pathShim';
import { runtimeLabelText } from '../../web/pageHost';

const fake = path.join(__dirname, 'fixtures', 'fakeRunner.cjs');

describe('CLI teaching operation exit status', () => {
  it('rejects transport and structured failures without requiring a failed HTTP status', () => {
    const command = parseCtl(['state']);
    expect(ctlExitCode(command, false, { result: {} })).toBe(1);
    expect(ctlExitCode(command, true, { result: null, error: 'duplicate pages' })).toBe(1);
    expect(ctlExitCode(command, true, null)).toBe(1);
  });

  it('requires a rendered position for moves, including nested step replies', () => {
    for (const words of [['position', 'live'], ['goto', '2'], ['step', 'into'], ['debug', 'step', 'into']]) {
      const command = parseCtl(words);
      expect(ctlExitCode(command, true, { result: {} })).toBe(1);
      const position = { ready: false, blockers: ['wrong source'] };
      expect(ctlExitCode(command, true, { result: command.action === 'position' ? position : { position } })).toBe(1);
    }
    expect(ctlExitCode(parseCtl(['step', 'into']), true, { result: { state: { position: { ready: true } } } })).toBe(0);
    expect(ctlExitCode(parseCtl(['position', 'live']), true, { result: { ready: true } })).toBe(0);
  });

  it('allows informational state reads and normal live completion, but not an unstarted run', () => {
    expect(ctlExitCode(parseCtl(['debug', 'state']), true, { result: { position: { ready: false } } })).toBe(0);
    const command = parseCtl(['debug', 'continue']);
    expect(ctlExitCode(command, true, { result: { runId: 'run-1', running: false, paused: false, position: { ready: false } } })).toBe(0);
    expect(ctlExitCode(command, true, { result: { running: false } })).toBe(1);
  });

  it('rejects every unsuccessful scratch execution while permitting successful output', () => {
    const good = { status: 'completed', liveExecutionChanged: false, result: { values: [], output: [] } };
    for (const op of ['experiment', 'run'] as const) {
      const command = { action: 'scratchpad' as const, op };
      expect(ctlExitCode(command, true, { result: good })).toBe(0);
      for (const patch of [
        { status: 'needsPreparation' }, { status: 'running' }, { error: 'invalid JSON' },
        { liveExecutionChanged: true }, { result: null },
        { result: { error: 'normalizePromptInput is not a function' } },
        { result: { missingMocks: ['receiver'] } },
        { result: { applicationErrors: [{ path: '$.error', value: 'tool failed' }] } },
      ]) expect(ctlExitCode(command, true, { result: { ...good, ...patch } })).toBe(1);
    }
  });
});

describe('web bridge helpers', () => {
  it('splits a runtime command line, keeping quoted parts whole', () => {
    expect(splitCommand('node "/a b/runtime.js" serve')).toEqual(['node', '/a b/runtime.js', 'serve']);
    expect(splitCommand("deno run 'x y.ts'")).toEqual(['deno', 'run', 'x y.ts']);
  });

  it('runs any other command as given', () => {
    const js = runtimeCommand({ runtime: 'node /r/runtime.js serve', distDir: '/nowhere', file: '/w/a.ts' });
    expect(js).toEqual({ command: 'node', args: ['/r/runtime.js', 'serve'], cwd: '/w', env: {} });
  });

  it('runs the JS runtime for --runtime js from the build, else the checkout, and says what is missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkw-'));
    const dist = path.join(root, 'dist');
    fs.mkdirSync(path.join(root, 'node', 'bin'), { recursive: true });
    expect(() => runtimeCommand({ runtime: 'js', distDir: dist, file: '/w/a.ts' })).toThrow(/tracelight\.mjs/);
    fs.writeFileSync(path.join(root, 'node', 'bin', 'tracelight.mjs'), '');
    expect(runtimeCommand({ runtime: 'js', distDir: dist, file: '/w/a.ts' })).toEqual({ command: process.execPath, args: [path.join(root, 'node', 'bin', 'tracelight.mjs'), 'serve'], cwd: '/w', env: {} });
    expect(runtimeCommand({ runtime: 'bun', distDir: dist, file: '/w/a.ts' }).env).toEqual({ TRACELIGHT_NODE: 'bun' });
    expect(runtimeCommand({ runtime: 'node', distDir: dist, file: '/w/a.ts' }).env).toEqual({ TRACELIGHT_NODE: process.execPath });
    // the build's copy wins once it exists
    fs.mkdirSync(path.join(dist, 'node', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dist, 'node', 'bin', 'tracelight.mjs'), '');
    expect(runtimeCommand({ runtime: 'js', distDir: dist, file: '/w/a.ts' }).args[0]).toBe(path.join(dist, 'node', 'bin', 'tracelight.mjs'));
  });

  it('labels the runtime by its own language', () => {
    expect(runtimeLabelText(null)).toBe('starting…');
    expect(runtimeLabelText({ pythonVersion: '3.13.1 (main)', capabilities: [] })).toBe('Python 3.13.1');
    expect(runtimeLabelText({ pythonVersion: '22.22.0', language: 'javascript', nodeVersion: '22.22.0', capabilities: [] })).toBe('Node 22.22.0');
  });

  it('names the Monaco language from the extension', () => {
    expect(languageFor('/a/b.py')).toBe('python');
    expect(languageFor('/a/b.mjs')).toBe('javascript');
    expect(languageFor('/a/b.tsx')).toBe('typescript');
    expect(languageFor('/a/b.rb')).toBe('plaintext');
  });

  it('accepts only its own Host and Origin', () => {
    expect(sameOrigin({ host: '127.0.0.1:4777' }, 4777)).toBe(true);
    expect(sameOrigin({ host: 'localhost:4777', origin: 'http://127.0.0.1:4777' }, 4777)).toBe(true);
    expect(sameOrigin({ host: '127.0.0.1:4777', origin: 'https://evil.example' }, 4777)).toBe(false);
    expect(sameOrigin({ host: 'evil.example:4777' }, 4777)).toBe(false); // DNS rebinding
    expect(sameOrigin({ host: '127.0.0.1:4777', origin: 'http://127.0.0.1:9999' }, 4777)).toBe(false);
    expect(sameOrigin({ host: '127.0.0.1:4777', origin: 'null' }, 4777)).toBe(false);
  });

  it('keeps only the run settings a page may change', () => {
    expect(pickConfig({ autoLog: true, timeoutMs: -1, http: 'nope' as never, maskSecrets: false, ...({ plugins: ['x'] } as object) })).toEqual({ autoLog: true, maskSecrets: false });
    const c = runConfig({ maskSecrets: false, timeoutMs: 0 });
    expect(c.recordLocals).toBe(true);
    expect(c.secrets).toEqual({ mask: false, names: [] });
    expect(c.timeoutMs).toBe(0);
  });

  it('parses ctl commands', () => {
    expect(parseCtl(['say', 'now', '--expect-source', 'live', '--expect-run', 'd-2', '--expect-step', '4', '--expect-frame', '0', '--expect-file', '/w/a.ts'])).toMatchObject({ action: 'say', expect: { source: 'live', runId: 'd-2', step: 4, frame: 0, file: '/w/a.ts' } });
    expect(parseCtl(['say', 'before navigation', '--expect-step', 'null'])).toMatchObject({ expect: { step: null } });
    expect(() => parseCtl(['say', 'x', '--expect-step', '-1'])).toThrow('nonnegative');
    expect(parseCtl(['goto', '12', '--say', 'here'])).toEqual({ action: 'goto', step: 12, say: 'here' });
    expect(parseCtl(['step', 'backOver'])).toEqual({ action: 'step', kind: 'backOver' });
    expect(parseCtl(['say', 'two', 'words', '--line', '4'])).toEqual({ action: 'say', text: 'two words', line: 4 });
    expect(parseCtl(['eval', 'len(xs)'])).toEqual({ action: 'eval', expression: 'len(xs)' });
    expect(() => parseCtl(['goto', 'x'])).toThrow(/whole number/);
    expect(() => parseCtl(['step', 'sideways'])).toThrow(/unknown step kind/);
    expect(() => parseCtl(['dance'])).toThrow(/unknown command/);
    expect(parseCtl(['var', 'total'])).toEqual({ action: 'var', name: 'total' });
    expect(parseCtl(['why', 'total', '--step', '7'])).toEqual({ action: 'why', name: 'total', step: 7 });
    expect(parseCtl(['watch', 'a', '+', 'b'])).toEqual({ action: 'watch', exp: 'a + b' });
    expect(parseCtl(['watch', 'a', '--remove'])).toEqual({ action: 'watch', exp: 'a', remove: true });
    expect(parseCtl(['break', '12', 'off'])).toEqual({ action: 'breakpoint', line: 12, on: false });
    expect(parseCtl(['break', '12', '--if', 'i > 2'])).toEqual({ action: 'breakpoint', line: 12, condition: 'i > 2' });
    expect(parseCtl(['debug', 'step', 'into', '--say', 'in we go'])).toEqual({ action: 'debug', op: 'step', kind: 'into', say: 'in we go' });
    expect(parseCtl(['debug', 'step'])).toEqual({ action: 'debug', op: 'step', kind: 'over' });
    expect(parseCtl(['step', 'next'])).toEqual({ action: 'step', kind: 'next' });
    expect(parseCtl(['peek', 'jobs'])).toEqual({ action: 'peek', name: 'jobs' });
    expect(parseCtl(['peek', '--hide'])).toEqual({ action: 'peek', name: '' });
    expect(parseCtl(['debug', 'restart'])).toEqual({ action: 'debug', op: 'restart' });
    expect(parseCtl(['debug', 'start'])).toEqual({ action: 'debug', op: 'start' });
    expect(() => parseCtl(['debug', 'fly'])).toThrow(/unknown debug op/);
    expect(parseCtl(['story'])).toEqual({ action: 'story' });
    expect(parseCtl(['profile'])).toEqual({ action: 'profile' });
    expect(parseCtl(['inspect', 'open', 'queue'])).toEqual({ action: 'inspect', name: 'queue', open: true });
    expect(parseCtl(['inspect', 'close', 'queue'])).toEqual({ action: 'inspect', name: 'queue', open: false });
    expect(parseCtl(['inspect', 'open', 'message', 'config', 'emit'])).toEqual({ action: 'inspect', name: 'message', names: ['message', 'config', 'emit'], open: true });
    expect(() => parseCtl(['inspect', 'toggle', 'queue'])).toThrow('open|close NAME');
  });

  it('keeps only well-formed watch requests from a page', () => {
    expect(pickWatches([{ id: 'w1', exp: 'x', range: [1, 2, 3, 4] }, { id: 2, exp: 'y' }, null, 'z'])).toEqual([{ id: 'w1', exp: 'x' }]);
    expect(pickWatches('nope')).toEqual([]);
  });

  it('round-trips WebSocket frames, masked and of every length class', () => {
    for (const size of [0, 5, 125, 126, 70_000]) {
      const payload = Buffer.alloc(size, 'a');
      const { frames, rest } = decodeFrames(encodeFrame(0x1, payload));
      expect(rest.length).toBe(0);
      expect(frames[0]!.payload.equals(payload)).toBe(true);
    }
    // a masked client frame split across two chunks
    const mask = Buffer.from([1, 2, 3, 4]);
    const text = Buffer.from('hello');
    const masked = Buffer.from(text.map((b, i) => b ^ mask[i & 3]!));
    const frame = Buffer.concat([Buffer.from([0x81, 0x80 | text.length]), mask, masked]);
    expect(decodeFrames(frame.subarray(0, 4)).frames).toEqual([]);
    expect(decodeFrames(frame).frames[0]!.payload.toString()).toBe('hello');
  });

  it('shims the node:path calls the walkthrough builders make', () => {
    expect(pathShim.resolve('/a/b', '../c', './d')).toBe('/a/c/d');
    expect(pathShim.basename('/a/b/__init__.py')).toBe('__init__.py');
    expect(pathShim.dirname('/a/b/c.py')).toBe('/a/b');
    expect(pathShim.dirname('/c.py')).toBe('/');
  });
});

/** A finished one-statement run of `x = 1` in /w/main.py, folded as the bridge folds it. */
function finishedRun() {
  const run = emptyRun('w-1', 'x = 1\n');
  const events: RunEvent[] = [
    { runId: 'w-1', seq: 1, type: 'file.instrumented', fileId: 1, path: '/w/main.py', rangeBase: 0, ranges: [[1, 0, 1, 5], [1, 0, 1, 5]], statements: [1], functions: [], magic: [] },
    { runId: 'w-1', seq: 2, type: 'trace', steps: Buffer.from(packSteps([[1, 0, 0]]).buffer).toString('base64'), scopes: [{ scopeId: 0, rid: 0, name: '<module>', parent: -1, depth: 0, first: 0, last: 0 }], truncated: false },
    { runId: 'w-1', seq: 3, type: 'locals', entries: [{ step: 0, scopeId: 0, changes: [{ name: 'x', text: '1' }] }] },
    { runId: 'w-1', seq: 4, type: 'run.finished', exitCode: 0, durationMs: 1, timedOut: false, stopped: false, stepCount: 1, logCount: 0 },
  ] as RunEvent[];
  for (const ev of events) expect(applyEvent(run, ev)).toBe(true);
  return run;
}

describe('ServerViews', () => {
  it('narrates the walkthrough with one model call and answers the glosses', async () => {
    const run = finishedRun();
    const sent: unknown[] = [];
    let prompt = '';
    const views = new ServerViews({ distDir: path.join(__dirname, '..', '..', 'dist'), ask: async (p) => ((prompt = p), JSON.stringify({ m0: 'the module starts' })) }, () => ({ run, mainPath: '/w/main.py' }), (m) => sent.push(m));
    expect(views.canNarrate()).toBe(true);
    await views.narrate();
    expect(prompt.length).toBeGreaterThan(0);
    expect(sent).toEqual([{ type: 'narration', narration: { runId: 'w-1', narrating: true } }, { type: 'narration', narration: { runId: 'w-1', narrating: false, glosses: { m0: 'the module starts' } } }]);
    expect(views.replay('w-1')).toEqual([sent[1]]);
    views.reset();
    expect(views.replay('w-1')).toEqual([]);
  });

  it('runs the tour command over the run saved as a run.json', async () => {
    const run = finishedRun();
    const sent: { type: string; tour?: { status: string; doc?: unknown; error?: string } }[] = [];
    let saved: { meta: { file: string }; events: { type: string }[] } | undefined;
    const tourCli = async (_o: unknown, argv: string[]) => {
      saved = JSON.parse(fs.readFileSync(argv[1]!, 'utf8'));
      return { tour: 1, run: { file: '/w/main.py', steps: 1, exitCode: 0, durationMs: 1, http: 0, llm: 0 }, goal: { kind: 'end', step: 0, text: '' }, small: true, budget: { tokens: 0, estimate: 0, found: 0, kept: 0, dropped: 0 }, chapters: [], candidates: [] };
    };
    const views = new ServerViews({ distDir: '/nowhere', tourCli: tourCli as never }, () => ({ run, mainPath: '/w/main.py' }), (m) => sent.push(m as never));
    await views.computeTour();
    expect(saved?.meta.file).toBe('/w/main.py');
    expect(saved?.events.map((e) => e.type)).toEqual(['file.instrumented', 'locals', 'trace', 'run.finished']);
    expect(sent.map((m) => m.tour?.status)).toEqual(['computing', 'ready']);
    views.dispose();
  });
});

describe('BridgeServer', () => {
  let server: BridgeServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function start(initialRun = true, node?: string): Promise<{ url: string; port: number; file: string }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkw-'));
    const file = path.join(dir, 'scratch.py');
    fs.writeFileSync(file, 'print("ok")\n');
    server = new BridgeServer({ file, port: 0, host: '127.0.0.1', runtime: `"${process.execPath}" "${fake}"`, watch: false, node, initialRun, open: false, distDir: dir, stateDir: dir });
    await server.start();
    const port = Number(new URL(server.url).port);
    return { url: server.url, port, file };
  }

  function connect(port: number): Promise<{ ws: WebSocket; messages: BridgeToPage[]; next: (pred: (m: BridgeToPage) => boolean) => Promise<BridgeToPage> }> {
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
      const next = (pred: (m: BridgeToPage) => boolean) =>
        new Promise<BridgeToPage>((res) => {
          const hit = messages.find(pred);
          if (hit) res(hit);
          else waiters.push([pred, res]);
        });
      ws.onopen = () => resolve({ ws, messages, next });
      ws.onerror = () => reject(new Error('websocket failed'));
    });
  }

  it('propagates the selected program executable to recording, live debug and profiling', async () => {
    const { port } = await start(false, process.execPath);
    const page = await connect(port);
    await page.next(m => m.type === 'hello');
    await server!.run('selected-executable');
    const recorded = await page.next(m => m.type === 'event' && m.event.type === 'run.started') as Extract<BridgeToPage, { type: 'event' }>;
    expect(recorded.event).toMatchObject({ programNode: process.execPath });
    await server!.startDebug([], 'off');
    const debug = await page.next(m => m.type === 'debug.event' && m.event.type === 'run.started') as Extract<BridgeToPage, { type: 'debug.event' }>;
    expect(debug.event).toMatchObject({ programNode: process.execPath });
    await server!.stopDebug();
    const profile = await server!.profile();
    expect(profile.error).toBeUndefined();
    // The fake protocol peer writes the received executable into its profile URL.
    expect(profile.summary?.rows[0]?.file).toContain(process.execPath);
    page.ws.close();
  });

  it('opens without executing and can start the debugger before any recording', async () => {
    const { port, file } = await start(false);
    const page = await connect(port);
    expect(await page.next(m => m.type === 'hello')).toMatchObject({ file: { path: file } });
    page.ws.send(JSON.stringify({ type: 'debug.start', breakpoints: [{ path: file, line: 2 }], exceptions: 'uncaught' }));
    const begin = await page.next(m => m.type === 'debug.begin') as Extract<BridgeToPage, { type: 'debug.begin' }>;
    await page.next(m => m.type === 'debug.event' && m.event.type === 'debug.paused');
    expect(page.messages.some(m => m.type === 'run.begin' || m.type === 'event')).toBe(false);
    page.ws.send(JSON.stringify({ type: 'debug.request', id: 1, body: { type: 'debug', runId: begin.runId, action: 'continue' } }));
    await page.next(m => m.type === 'debug.end');
    page.ws.send(JSON.stringify({ type: 'run' }));
    expect(await page.next(m => m.type === 'run.begin')).toMatchObject({ runId: 'w-1', reason: 'page' });
    await page.next(m => m.type === 'event' && m.event.type === 'run.finished');
    page.ws.close();
  });

  it('refuses ambiguous multi-page state and commands without broadcasting a step', async () => {
    const { port, url } = await start(false);
    const first = await connect(port);
    const second = await connect(port);
    await first.next(m => m.type === 'hello');
    await second.next(m => m.type === 'hello');
    const command = await fetch(new URL('/api/command', url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'debug', op: 'step' }) });
    expect(command.status).toBe(409);
    expect(await command.json()).toMatchObject({ result: null, error: expect.stringContaining('2 pages are connected') });
    const state = await fetch(new URL('/api/state', url));
    expect(state.status).toBe(409);
    expect(await state.json()).toMatchObject({ pages: 2, state: null, error: expect.stringContaining('2 pages') });
    expect(first.messages.some(m => m.type === 'agent')).toBe(false);
    expect(second.messages.some(m => m.type === 'agent')).toBe(false);
    first.ws.close(); second.ws.close();
  });

  it('relays a run of any runtime to the page, replies to requests, and refuses other origins', async () => {
    const { port, file } = await start();
    const page = await connect(port);
    const hello = await page.next((m) => m.type === 'hello');
    expect(hello).toMatchObject({ type: 'hello', file: { path: file, language: 'python', content: 'print("ok")\n' } });
    const log = await page.next((m) => m.type === 'event' && m.event.type === 'log');
    expect(log).toMatchObject({ event: { text: 'ok', runId: 'w-1' } });
    await page.next((m) => m.type === 'event' && m.event.type === 'run.finished');

    // a host request is relayed with the page's own id; an error reply comes back as data
    page.ws.send(JSON.stringify({ type: 'request', id: 7, body: { type: 'expand', runId: 'w-1', valueId: 'v1', queryPath: [] } }));
    const reply = await page.next((m) => m.type === 'reply' && m.id === 7);
    expect(reply).toMatchObject({ reply: { type: 'error', message: 'no such value' } });

    // a page that connects late gets the run so far
    const late = await connect(port);
    await late.next((m) => m.type === 'event' && m.event.type === 'run.finished');
    expect(late.messages.map((m) => m.type).slice(0, 2)).toEqual(['hello', 'run.begin']);

    // an edit from the page runs the buffer, unsaved
    page.ws.send(JSON.stringify({ type: 'run', content: 'print("edited")\n' }));
    const begin = await page.next((m) => m.type === 'run.begin' && m.runId === 'w-2');
    expect(begin).toMatchObject({ content: 'print("edited")\n', reason: 'page' });
    expect(fs.readFileSync(file, 'utf8')).toBe('print("ok")\n');

    // a page cannot read a file the run did not instrument
    page.ws.send(JSON.stringify({ type: 'file.read', path: '/etc/passwd' }));

    // another site's page is refused the socket and the API
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    const post = await fetch(`http://127.0.0.1:${port}/api/command`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"action":"run"}' });
    expect(post.status).toBe(415);
    expect(page.messages.some((m) => m.type === 'file' && m.file.path === '/etc/passwd')).toBe(false);
    page.ws.close();
    late.ws.close();
  });

  it('runs the live debugger on a runtime of its own and keeps the watches for later runs', async () => {
    const { port } = await start();
    const page = await connect(port);
    await page.next((m) => m.type === 'event' && m.event.type === 'run.finished');
    page.ws.send(JSON.stringify({ type: 'debug.start', breakpoints: [{ path: '/x.py', line: 2 }], exceptions: 'uncaught' }));
    const begin = (await page.next((m) => m.type === 'debug.begin')) as Extract<BridgeToPage, { type: 'debug.begin' }>;
    await page.next((m) => m.type === 'debug.event' && m.event.type === 'debug.paused');
    page.ws.send(JSON.stringify({ type: 'debug.request', id: 7, body: { type: 'debug', runId: begin.runId, action: 'continue' } }));
    const reply = (await page.next((m) => m.type === 'reply' && m.id === 7)) as Extract<BridgeToPage, { type: 'reply' }>;
    expect(reply.reply.type).toBe('debug.result');
    await page.next((m) => m.type === 'debug.end');
    // a run with watches answers them, and the next run (a save, a settings change) keeps them
    page.ws.send(JSON.stringify({ type: 'run', watch: [{ id: 'w1', exp: 'x' }], traceContext: { step: 3, prefetch: 10 } }));
    const w = (await page.next((m) => m.type === 'event' && m.event.type === 'watch')) as Extract<BridgeToPage, { type: 'event' }>;
    expect(w.event).toMatchObject({ watchId: 'w1', step: 3 });
    page.ws.close();
  });

  it('refuses ambiguous pages, overlapping requests, and disconnected stale state', async () => {
    const { port } = await start();
    const one = await connect(port);
    const two = await connect(port);
    expect(await server!.agent({ action: 'say', text: 'must not broadcast' })).toMatchObject({ error: expect.stringContaining('pages are connected') });
    expect(one.messages.some(m => m.type === 'agent')).toBe(false);
    expect(two.messages.some(m => m.type === 'agent')).toBe(false);
    const closed = new Promise<void>(resolve => { two.ws.onclose = () => resolve(); });
    two.ws.close(); await closed;
    const pending = server!.agent({ action: 'debug', op: 'step' });
    await one.next(m => m.type === 'agent');
    expect(await server!.agent({ action: 'clear' })).toMatchObject({ error: expect.stringContaining('pending') });
    one.ws.close();
    expect(await pending).toMatchObject({ error: expect.stringContaining('disconnected') });
    const state = await fetch(`http://127.0.0.1:${port}/api/state`);
    expect(state.status).toBe(409);
    expect(await state.json()).toMatchObject({ state: null, error: expect.stringContaining('connected page') });
  });

  it('hands an agent command to the open page and returns its answer' , async () => {
    const { port } = await start();
    const none = await fetch(`http://127.0.0.1:${port}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'goto', step: 3 }) });
    expect(none.status).toBe(409);
    expect(((await none.json()) as { error: string }).error).toMatch(/no page is open/);

    const page = await connect(port);
    page.ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as BridgeToPage;
      if (m.type === 'agent') page.ws.send(JSON.stringify({ type: 'agent.result', id: m.id, result: { did: m.command } }));
    };
    const res = await fetch(`http://127.0.0.1:${port}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'goto', step: 3 }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { did: { action: 'goto', step: 3 } } });
    page.ws.close();
  });

  it('profiles on a runtime of its own, serves the logs, and switches to a recent file', async () => {
    const { port, file } = await start();
    const page = await connect(port);
    await page.next((m) => m.type === 'event' && m.event.type === 'run.finished');
    page.ws.send(JSON.stringify({ type: 'profile' }));
    const prof = (await page.next((m) => m.type === 'profile')) as Extract<BridgeToPage, { type: 'profile' }>;
    expect(prof.profile.summary).toEqual({ totalMs: 2, rows: [{ name: 'add', file, line: 1, selfMs: 2, totalMs: 2.5, calls: 4 }] });
    const dl = await fetch(`http://127.0.0.1:${port}/api/profile`);
    expect(dl.status).toBe(200);
    expect(((await dl.json()) as { nodes: unknown[] }).nodes).toHaveLength(2);
    // the recorded run stayed the one on screen
    expect(page.messages.filter((m) => m.type === 'run.begin')).toHaveLength(1);

    page.ws.send(JSON.stringify({ type: 'file.read', path: LOG_PATH }));
    const logs = (await page.next((m) => m.type === 'file' && m.file.path === LOG_PATH)) as Extract<BridgeToPage, { type: 'file' }>;
    expect(logs.file.content).toMatch(/run w-1 of scratch\.py \(start\)/);

    // Open: only files of the runtime's language under the start file's directory
    const other = path.join(path.dirname(file), 'sub', 'other.py');
    fs.mkdirSync(path.dirname(other));
    fs.writeFileSync(other, 'print(2)\n');
    page.ws.send(JSON.stringify({ type: 'open', path: '/etc/hosts' }));
    expect(await page.next((m) => m.type === 'runner.error')).toMatchObject({ message: expect.stringMatching(/cannot open/) });
    page.ws.send(JSON.stringify({ type: 'open', path: other }));
    await page.next((m) => m.type === 'hello' && m.file.path === other);
    await page.next((m) => m.type === 'run.begin' && m.reason === 'open');
    page.ws.send(JSON.stringify({ type: 'recent' }));
    const recent = (await page.next((m) => m.type === 'recent')) as Extract<BridgeToPage, { type: 'recent' }>;
    expect(recent.files.map((f) => f.path)).toEqual([other, file]);
    expect(JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'recent.json'), 'utf8'))).toHaveLength(2);
    page.ws.close();
  });
});


it('parses complete scratch controls and atomic JSON updates', () => {
  for (const op of ['state', 'run', 'restore', 'close']) expect(parseCtl(['scratchpad', op])).toEqual({ action: 'scratchpad', op });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-scratch-ctl-'));
  try {
    const file = path.join(dir, 'edit.json');
    fs.writeFileSync(file, JSON.stringify({ code: 'const result = x;', inputs: { x: 2 }, mocks: {}, autoRun: false, action: 'debug', op: 'start' }));
    expect(parseCtl(['scratchpad', 'update', '--data', file])).toEqual({ action: 'scratchpad', op: 'update', code: 'const result = x;', inputs: { x: 2 }, mocks: {}, autoRun: false });
    expect(parseCtl(['scratchpad', 'experiment', '--data', file])).toEqual({ action: 'scratchpad', op: 'experiment', code: 'const result = x;', inputs: { x: 2 }, mocks: {}, autoRun: false });
  expect(parseCtl(['scratchpad', 'history', '--id', 'saved-1', '--version', '2'])).toEqual({ action: 'scratchpad', op: 'history', id: 'saved-1', version: 2 });
  expect(parseCtl(['scratchpad', 'create', '--title', 'Filter calls'])).toEqual({ action: 'scratchpad', op: 'create', title: 'Filter calls' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
