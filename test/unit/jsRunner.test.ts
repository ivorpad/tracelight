/**
 * The extension's RunnerClient against Tracelight (`node/bin/tracelight.mjs serve`): the same client the
 * panel uses for Python drives a JavaScript run, so a session needs nothing but the command.
 */
import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RunnerClient } from '../../src/runtime/runnerClient';
import type { RunEvent } from '../../src/shared/protocol';
import { debugRunRequest, parseLaunch } from '../../src/debug/debugSessionState';

const ROOT = path.resolve(__dirname, '../..');
const ENTRY = path.join(ROOT, 'node/bin/tracelight.mjs');
const haveRuntime = fs.existsSync(path.join(ROOT, 'node/node_modules/oxc-parser'));

describe.skipIf(!haveRuntime)('RunnerClient on Tracelight', () => {
  const client = new RunnerClient({ command: process.execPath, args: [ENTRY, 'serve'], cwd: ROOT });
  afterAll(() => client.dispose());

  it('handshakes, runs a TypeScript file, streams events and expands a value', async () => {
    const ready = await client.start();
    expect(ready.capabilities).toContain('expand');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracelight-client-'));
    const file = path.join(dir, 'main.ts');
    const content = 'type U = { name: string; tags: string[] };\nconst u: U = { name: "ada", tags: ["x", "y"] }; // ?\nconsole.log(u.name);\n';
    fs.writeFileSync(file, content);
    const events: RunEvent[] = [];
    const finished = new Promise<RunEvent>((resolve) =>
      client.on('event', (ev) => {
        if (ev.runId !== 'r-ts-1') return;
        events.push(ev);
        if (ev.type === 'run.finished') resolve(ev);
      }),
    );
    await client.run({ runId: 'r-ts-1', file: { path: file, displayName: 'main.ts', content }, workspaceRoot: dir, cwd: dir, argv: [], env: {}, config: { timeoutMs: 10000 } } as never);
    const fin = (await finished) as Extract<RunEvent, { type: 'run.finished' }>;
    expect(fin.exitCode).toBe(0);
    const logs = events.filter((e) => e.type === 'log') as Extract<RunEvent, { type: 'log' }>[];
    expect(logs.map((l) => l.text)).toEqual(["{ name: 'ada', tags: [ 'x', 'y' ] }", 'ada']);
    const bag = logs[0]!.valueBag!;
    const tags = bag.data.props!.find((p) => p.name === 'tags')!;
    const node = await client.expand('r-ts-1', tags.id, tags.queryPath ?? []);
    expect(node.props!.map((p) => p.value)).toEqual(['x', 'y']);
    const statements = await client.bindings(content);
    expect(statements.find((s) => s.line === 2)!.assigns).toEqual(['u']);
    const src = await client.source('r-ts-1', 1);
    expect(src).toContain('__tk.v(');
  }, 30_000);
});

describe.skipIf(!haveRuntime)('the Debugger (record: false) on Pyokka JS', () => {
  const client = new RunnerClient({ command: process.execPath, args: [ENTRY, 'serve'], cwd: ROOT });
  afterAll(() => client.dispose());

  it('advertises record, pauses at a breakpoint with frame locals, and runs to the end', async () => {
    const ready = await client.start();
    expect(ready.capabilities).toContain('record');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracelight-debug-'));
    const file = path.join(dir, 'app.ts');
    fs.writeFileSync(file, 'function add(a: number, b: number): number {\n  const sum = a + b;\n  return sum;\n}\nconsole.log(add(2, 3));\n');
    const events: RunEvent[] = [];
    let onEvent: (ev: RunEvent) => void = () => undefined;
    client.on('event', (ev) => {
      if (ev.runId !== 'd-1') return;
      events.push(ev);
      onEvent(ev);
    });
    const next = (type: string) => new Promise<RunEvent>((resolve) => {
      const hit = events.find((e) => e.type === type);
      if (hit) return resolve(hit);
      onEvent = (ev) => ev.type === type && resolve(ev);
    });
    const launch = parseLaunch({ program: file, cwd: dir });
    const req = debugRunRequest({ runId: 'd-1', launch, workspaceRoot: dir, base: { run: { timeoutMs: 10000 } as never, env: {} }, stopOnEntry: false, exceptions: 'uncaught', breakpoints: [{ path: file, line: 3 }] as never });
    expect(req.config.record).toBe(false);
    await client.run(req);
    const paused = (await next('debug.paused')) as Extract<RunEvent, { type: 'debug.paused' }>;
    expect(paused.line).toBe(3);
    const locals = (await client.debug('d-1', { action: 'locals' } as never)) as { locals?: { name: string; text: string }[] };
    expect(locals.locals?.find((l) => l.name === 'sum')?.text).toBe('5');
    await client.debug('d-1', { action: 'continue' } as never);
    const fin = (await next('run.finished')) as Extract<RunEvent, { type: 'run.finished' }>;
    expect(fin.exitCode).toBe(0);
    // nothing was recorded: no trace of steps
    expect(events.some((e) => e.type === 'trace' && !(e as { partial?: boolean }).partial && (e as { steps?: string }).steps)).toBe(false);
  }, 30_000);
});

describe.skipIf(!haveRuntime)('shadow values on Pyokka JS', () => {
  const client = new RunnerClient({ command: process.execPath, args: [ENTRY, 'serve'], cwd: ROOT });
  afterAll(() => client.dispose());

  it('answers what an edited statement would show from the finished run', async () => {
    await client.start();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracelight-shadow-'));
    const file = path.join(dir, 'main.ts');
    const content = 'const xs: number[] = [1, 2, 3];\nconst total = xs.length;\n';
    fs.writeFileSync(file, content);
    const done = new Promise<void>((resolve) => client.on('event', (ev) => ev.runId === 's-1' && ev.type === 'run.finished' && resolve()));
    await client.run({ runId: 's-1', file: { path: file, displayName: 'main.ts', content }, workspaceRoot: dir, cwd: dir, argv: [], env: {}, config: { timeoutMs: 10000 } } as never);
    await done;
    const r = await client.shadow('s-1', 'const total = xs.length * 10;');
    expect(r.text).toBe('30');
  }, 30_000);
});
