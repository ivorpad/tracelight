/**
 * The `kind: "debug"` bridge socket driving a JavaScript program end to end, without the editor:
 * a real `DebugSession` on Tracelight (`node/bin/tracelight.mjs serve`, `record: false`), the real
 * `DebugSocketServer`, and the `tracelight` CLI talking to it as an agent would. VS Code itself
 * is faked; the e2e suite covers the same socket for Python in a real window.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(__dirname, '../..');
const ENTRY = path.join(ROOT, 'node/bin/tracelight.mjs');
const haveRuntime = fs.existsSync(path.join(ROOT, 'node/node_modules/oxc-parser'));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-dbgjs-'));
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-dbgjs-ws-'));
const FILE = path.join(DIR, 'app.mjs');
const SOURCE = [
  'function add(a, b) {',
  '  const s = a + b;',
  '  return s;',
  '}',
  'let total = 0;',
  'for (let i = 0; i < 3; i++) {',
  '  total = add(total, i);',
  '}',
  "console.log('total', total);",
  '',
].join('\n');
process.env.TRACELIGHT_HOME = HOME;
process.env.TRACELIGHT_SESSIONS_DIR = '';
// the unbundled extension source keeps Tracelight's names (the Tracelight build renames them), so the
// CLI is pointed at the directory it writes: what `TRACELIGHT_HOME` is to the Tracelight build
process.env.TRACELIGHT_SESSIONS_DIR = path.join(HOME, 'sessions');

const gutter: { path: string; line: number }[] = [];

vi.mock('vscode', () => ({
  Uri: { file: (p: string) => ({ fsPath: p, scheme: 'file' }) },
  workspace: {
    getWorkspaceFolder: () => undefined,
    workspaceFolders: [{ uri: { fsPath: DIR } }],
    textDocuments: [],
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
    getConfiguration: () => ({ get: (_k: string, d: unknown) => d }),
  },
  window: { activeTextEditor: undefined },
}));
vi.mock('../../src/util/context', () => ({ setContext: () => undefined }));
vi.mock('../../src/debug/debugContext', () => ({ updateDebugContext: () => undefined }));
vi.mock('../../src/debug/dapAdapter', () => ({ startDebugSession: async () => undefined }));
vi.mock('../../src/runtime/interpreter', () => ({
  resolveInterpreter: async () => {
    throw new Error('a JS launch must not look for Python');
  },
  resolveNode: async () => ({ path: process.execPath, version: process.versions.node.split('.').map(Number), source: 'PATH', isVenv: false, language: 'javascript' }),
}));
vi.mock('../../src/features/debugBreakpoints', () => ({ currentSourceBreakpoints: () => gutter, currentFunctionBreakpoints: () => [] }));
vi.mock('../../src/util/log', () => ({ log: { info: () => undefined, warn: () => undefined, error: (...a: unknown[]) => console.error('LOGERR', ...a) } }));
vi.mock('../../src/config/settings', () => ({
  resolveSessionConfig: () => ({ run: { timeoutMs: 30_000, recordLocals: true, autoLog: true }, env: {} }),
  setting: (k: string, fallback: unknown) => (k === 'agentAccess' ? true : fallback),
}));

const { DebugSessionManager } = await import('../../src/debug/debugSessionManager');
const { DebugSocketServer } = await import('../../src/agent/bridgeDebugSocket');
const { parseLaunch } = await import('../../src/debug/debugSessionState');

type Msg = Record<string, any>;

/** the agent's side: `tracelight VERB ... --live --session app.mjs` */
function cli(args: string[], timeoutMs = 60_000): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY, ...args], { cwd: DIR, env: { ...process.env, TRACELIGHT_HOME: HOME } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c) => (stderr += c));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`tracelight ${args.join(' ')} timed out: ${stdout} ${stderr}`));
    }, timeoutMs);
    child.on('exit', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}
const live = (...args: string[]) => cli([...args, '--live', '--session', 'app.mjs', '--json']);
async function json(...args: string[]): Promise<Msg> {
  const r = await live(...args);
  expect(r.status, `${args.join(' ')}: ${r.stdout} ${r.stderr}`).toBe(0);
  return JSON.parse(r.stdout);
}

describe.skipIf(!haveRuntime || process.platform === 'win32')('the debug socket on a JavaScript program', () => {
  let manager: InstanceType<typeof DebugSessionManager>;
  let server: InstanceType<typeof DebugSocketServer>;
  let ds: any;

  beforeAll(async () => {
    fs.writeFileSync(FILE, SOURCE);
    gutter.push({ path: FILE, line: 2 });
    manager = new DebugSessionManager(path.join(ROOT, 'python'));
    server = new DebugSocketServer(manager, { runDescriptors: () => [] });
    ds = await manager.start(parseLaunch({ program: FILE, cwd: DIR }));
    const paused = ds.debug.paused ?? (await ds.waitForPause(30_000));
    expect(paused).not.toBe('finished');
  }, 60_000);

  afterAll(() => {
    server?.dispose();
    manager?.dispose();
  });

  it('writes a debug descriptor whose launch runs on Node', async () => {
    const at = server.descriptorFor(ds);
    expect(at).toBeDefined();
    for (let i = 0; i < 50 && !fs.existsSync(at!); i++) await new Promise((r) => setTimeout(r, 50));
    const d = JSON.parse(fs.readFileSync(at!, 'utf8'));
    expect(d.kind).toBe('debug');
    expect(d.file).toBe(FILE);
    expect(d.launch.node).toBe(process.execPath);
    expect(d.launch.python).toBeNull();
  });

  it('answers the stop over the socket: context, locals, eval, with no recording behind it', async () => {
    const stop = await json('context');
    expect(stop.paused.line).toBe(2);
    expect(stop.paused.reason).toBe('breakpoint');
    expect(stop.stack[0].function).toBe('add');
    expect(stop.values).toEqual([]);
    expect(stop.count).toBeUndefined();
    const locals = await json('locals');
    expect(JSON.stringify(locals)).toContain('"a"');
    const ev = await json('eval', 'a + b');
    expect(JSON.stringify(ev)).toContain('0');
  }, 120_000);

  it('`debug FILE` finds the live debug session and prints its pause (route a)', async () => {
    const r = await cli(['debug', FILE, '--json']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).paused.line).toBe(2);
  }, 60_000);

  it('refuses what needs a recording, naming --record', async () => {
    const r = await live('story');
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/--record/);
  }, 60_000);

  it('streams resumed and paused events to a watching client while the CLI steps', async () => {
    const d = JSON.parse(fs.readFileSync(server.descriptorFor(ds)!, 'utf8'));
    const events: Msg[] = [];
    const socket = net.connect(d.socket);
    await new Promise<void>((r) => socket.once('connect', () => r()));
    let buf = '';
    socket.setEncoding('utf8').on('data', (c: string) => {
      buf += c;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) events.push(JSON.parse(line));
      }
    });
    socket.write(JSON.stringify({ token: d.token }) + '\n');
    socket.write(JSON.stringify({ id: 1, type: 'watch' }) + '\n');
    for (let i = 0; i < 50 && !events.some((e) => e.id === 1); i++) await new Promise((r) => setTimeout(r, 50));
    const stepped = await json('continue');
    expect(stepped.paused.line).toBe(2);
    for (let i = 0; i < 100 && !events.some((e) => e.event === 'paused'); i++) await new Promise((r) => setTimeout(r, 50));
    expect(events.some((e) => e.event === 'resumed')).toBe(true);
    expect(events.find((e) => e.event === 'paused')?.paused?.line ?? events.find((e) => e.event === 'paused')?.line).toBe(2);
    socket.destroy();
  }, 120_000);

  it('stops the program over the socket and removes the descriptor', async () => {
    const at = server.descriptorFor(ds)!;
    const r = await live('stop');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    for (let i = 0; i < 100 && fs.existsSync(at); i++) await new Promise((r2) => setTimeout(r2, 50));
    expect(fs.existsSync(at)).toBe(false);
    expect(manager.all()).toHaveLength(0);
  }, 60_000);
});
