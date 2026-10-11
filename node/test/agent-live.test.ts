/**
 * `--live` and the Debugger's verbs over a fake bridge socket: discovery, the token handshake,
 * every verb's request and text, `watch`, `shell`, the relaunch memory, `break --remove`, and the
 * cold start's URI and routes.
 */
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { NAME, ENV } from '../src/protocol.ts';
import { dispatchVerb, type Io } from '../src/agent/commands.ts';
import '../src/agent/verbs.ts';
import { LiveRun, OLD_EXTENSION, watchLine } from '../src/agent/live.ts';
import { descriptorKind, listSessions, pickSession, preferKind, substitutionNote } from '../src/agent/sessions.ts';
import * as debugStartMod from '../src/agent/debug_start.ts';
import { commandLine, memoryPath, recall, remember } from '../src/agent/relaunch.ts';
import { removeItem } from '../src/agent/verbs/debugger.ts';
import { shellInput, shlexSplit } from '../src/agent/verbs/shell.ts';
import { execError, renderDebugExec, renderDebugState, renderDebugStop } from '../src/agent/render_debug.ts';
import { AgentError } from '../src/agent/source.ts';
import { REDACTED } from '../src/agent/redact.ts';

type Msg = Record<string, any>;

const WORKSPACE = '/ws/proj';
const FILE = WORKSPACE + '/demo.py';
const DEAD_PID = 4_194_303;

function sliceAt(step: number, over: Msg = {}): Msg {
  return {
    step,
    count: 40,
    location: { file: FILE, line: 11, col: 0, function: '<module>', fileId: 1 },
    stale: false,
    stack: [{ file: FILE, line: 11, function: '<module>', step }],
    block: { file: FILE, function: '<module>', scopeId: 0, lines: [{ line: 9, text: "config = {'is_awesome': True}", step: 2 }, { line: 11, text: 'print(config)', step, current: true }] },
    values: [{ line: 11, context: null, text: "{'is_awesome': True, 'api_key': 'sk-abcdefghijklmnopqrstuvwxyz'}", step, hit: 1, runtimeKey: '7' }],
    coverage: { notRun: [32] },
    moves: { into: step + 1, over: step + 1, out: 39, back: step - 1, backOver: step - 1, backOut: null },
    errors: [{ file: FILE, line: 95, type: 'ValueError', message: 'Kaboom', step: 39 }],
    ...over,
  };
}

function pausedAt(step: number, reason: string, line = 11, extra: Msg = {}): Msg {
  return { step, rid: 7, fileId: 1, file: FILE, line, scopeId: 0, depth: 0, reason, stack: [{ scopeId: 0, name: '<module>', rid: 0, depth: 0 }], ...extra };
}

const LOCALS = [{ name: 'total', text: '3' }, { name: 'payload', text: 'None' }];
const OUTPUT = { text: 'start\nloading 1\nloading 2\n', truncated: false };

/** a bridge on a Unix socket; replies are canned per request type, as the Python fake's */
class FakeBridge {
  dir = mkdtempSync(join(tmpdir(), 'fb'));
  socketPath = join(this.dir, 'b.sock');
  requests: Msg[] = [];
  tokens: unknown[] = [];
  stale = false;
  nav: Msg = { active: false, step: null, count: 40 };
  debug: Msg | null = null;
  output: Msg = { ...OUTPUT };
  breakpoints: Msg[] = [];
  exceptions = 'uncaught';
  watches: Msg[] = [];
  finishNext = false;
  canned: Record<string, Msg> = {};
  server: Server;
  conns = new Set<Socket>();

  token: string;
  events: Msg[];

  constructor(token = 't0ken', events: Msg[] = []) {
    this.token = token;
    this.events = events;
    this.server = createServer((c) => this.client(c));
  }

  listen(): Promise<this> {
    return new Promise((res) => this.server.listen(this.socketPath, () => res(this)));
  }

  descriptor(o: { pid?: number; file?: string; workspace?: string; started?: string; token?: string } = {}): Msg {
    const file = o.file ?? FILE;
    return { socket: this.socketPath, token: o.token ?? this.token, pid: o.pid ?? process.pid, workspace: o.workspace ?? WORKSPACE, file, displayName: basename(file), runtimeVersion: '0.0.1', started: o.started ?? '2026-09-10T10:00:00Z' };
  }

  async close(): Promise<void> {
    for (const c of this.conns) c.destroy();
    await new Promise((res) => this.server.close(res));
    rmSync(this.dir, { recursive: true, force: true });
  }

  private client(conn: Socket): void {
    this.conns.add(conn);
    conn.on('close', () => this.conns.delete(conn));
    conn.on('error', () => {});
    let buf = '';
    let first = true;
    conn.setEncoding('utf8');
    conn.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (first) {
          first = false;
          this.tokens.push(msg.token);
          if (msg.token !== this.token) {
            conn.destroy();
            return;
          }
          continue;
        }
        this.requests.push(msg);
        const reply = this.reply(msg);
        conn.write(JSON.stringify({ id: msg.id, ...reply }) + '\n');
        if (msg.type === 'watch') {
          for (const ev of this.events) conn.write(JSON.stringify(ev) + '\n');
          conn.end();
          return;
        }
      }
    });
  }

  private paused(): Msg | null {
    return this.debug && this.debug.active ? this.debug.paused : null;
  }

  stop(step: number, reason: string, extra: Msg = {}, line = 11): Msg {
    const info = pausedAt(step, reason, line, extra);
    this.debug = { active: true, paused: info, frontier: step, exceptions: this.exceptions };
    this.nav = { active: true, step, count: 40 };
    return { ok: true, ...sliceAt(step, { stale: this.stale }), paused: info, locals: LOCALS.map((v) => ({ ...v })), output: { ...this.output } };
  }

  private start(req: Msg): Msg {
    if (!req.stopOnEntry && this.breakpoints.length) {
      const bp = this.breakpoints[0]!;
      return this.stop(3, 'breakpoint', { breakpoint: { ...bp } }, bp.line);
    }
    return this.stop(0, 'start');
  }

  private finish(): Msg {
    this.debug = { active: false, paused: null, frontier: null };
    return { ok: true, finished: { exitCode: 0, stepCount: 40, durationMs: 12.5 } };
  }

  private bp(spec: Msg): Msg {
    const out: Msg = { file: spec.file, line: spec.line };
    if (spec.condition) out.condition = spec.condition;
    if (spec.file === 'demo.py') Object.assign(out, { rid: 70 + Number(spec.line), fileId: 1, resolvedLine: spec.line });
    return out;
  }

  reply(req: Msg): Msg {
    const t = req.type;
    if (t in this.canned) return { ok: true, ...this.canned[t] };
    if (t === 'state') {
      const out: Msg = { ok: true, runId: 'r1', running: false, finished: true, stale: this.stale, nav: { ...this.nav }, displayName: 'demo.py', file: FILE };
      if (this.nav.active) out.location = { file: FILE, line: 11, col: 0, function: '<module>', fileId: 1 };
      if (this.debug !== null) out.debug = { ...this.debug };
      return out;
    }
    if (t === 'debug' || t === 'restart') return this.start(req);
    if (t === 'stop') {
      if (!(this.debug && this.debug.active)) return { ok: true, stopped: false, hint: 'no debug run is in flight; `debug --live` starts one' };
      this.debug = null;
      return { ok: true, stopped: true, runId: 'r-1', finished: { exitCode: null, stepCount: 12, durationMs: 40 } };
    }
    if (t === 'continue' || t === 'pause') {
      if (this.paused() === null && !(this.debug && this.debug.active)) return { ok: false, error: 'no debug run in progress', hint: '`tracelight debug --live` starts one' };
      if (t === 'pause') return this.stop(7, 'pause');
      if (this.finishNext) return this.finish();
      if (this.breakpoints.length) {
        const bp = this.breakpoints[0]!;
        return this.stop(12, 'breakpoint', { breakpoint: { ...bp } }, bp.line);
      }
      return this.stop(12, 'pause');
    }
    if (t === 'break') {
      for (const b of req.add ?? []) this.breakpoints.push(this.bp(b));
      for (const r of req.remove ?? []) this.breakpoints = this.breakpoints.filter((b) => !(b.file === r.file && b.line === r.line));
      if (req.exceptions) this.exceptions = req.exceptions;
      return { ok: true, breakpoints: this.breakpoints.map((b) => ({ ...b })), exceptions: this.exceptions };
    }
    if (t === 'watches') {
      for (const w of req.add ?? []) {
        if (w.breakWhen) this.watches.push({ id: `w${1 + this.watches.filter((x) => x.breakWhen).length}`, exp: w.exp, breakWhen: w.breakWhen });
        else this.watches.push({ id: `w-fake-${this.watches.length}`, exp: w.exp, kind: 'display', text: '3' });
      }
      for (const id of req.remove ?? []) this.watches = this.watches.filter((w) => w.id !== id);
      return { ok: true, watches: this.watches.map((w) => ({ ...w })) };
    }
    if (t === 'locals') {
      if (this.paused() === null) return { ok: false, error: 'the program is not paused', hint: '`tracelight debug --live` starts it paused; `break` and `pause` stop it' };
      const out: Msg[] = LOCALS.map((v) => ({ ...v }));
      if (req.valueBag) for (const v of out) v.valueBag = { data: { id: `v:${v.name}`, type: 'any', value: v.text } };
      return { ok: true, locals: out };
    }
    if (t === 'step') {
      if (this.paused() !== null && ['into', 'over', 'out'].includes(req.kind) && req.to === undefined) {
        if (this.finishNext) return this.finish();
        return this.stop(Number(this.debug!.frontier) + 1, 'step', { kind: req.kind });
      }
      if (req.to !== undefined) {
        if (req.to > 39) return { ok: false, error: `step ${req.to} is out of range`, hint: 'steps are 0..39' };
        this.nav = { active: true, step: req.to, count: 40 };
      } else {
        const cur = this.nav.active ? this.nav.step : 0;
        this.nav = { active: true, step: cur + 1, count: 40 };
      }
      return { ok: true, ...sliceAt(this.nav.step, { stale: this.stale }) };
    }
    if (t === 'context') {
      const paused = this.paused();
      if (paused !== null && req.line === undefined && (req.step === undefined || req.step === this.debug!.frontier)) {
        return { ok: true, ...sliceAt(this.debug!.frontier, { stale: this.stale }), paused, locals: LOCALS.map((v) => ({ ...v })), output: { ...this.output } };
      }
      const step = req.step ?? (req.line !== undefined ? 5 : this.nav.step || 0);
      return { ok: true, ...sliceAt(step, { stale: this.stale }) };
    }
    if (t === 'values') {
      if (req.file === 'nope.py') return { ok: false, error: 'file not part of the run: nope.py', hint: 'files of the run: ' + FILE };
      return { ok: true, values: [{ line: req.line, text: '3', context: 'x', step: 4, hit: 1, runtimeKey: '1' }, { line: req.line, text: '4', context: 'x', step: 8, hit: 2, runtimeKey: '1' }] };
    }
    if (t === 'var') {
      if (!req.name) return { ok: false, error: 'var needs name', hint: 'send {name}' };
      return {
        ok: true, name: req.name, total: 2, truncated: false, recordedLocals: true, changes: [
          { step: 14, file: null, fileId: 1, line: 85, function: '<module>', scopeId: 0, name: req.name, text: 'Rectangle(50, 20)', source: 'locals', reads: [{ name: 'Rectangle', text: "<class 'Rectangle'>", step: 3 }] },
          { step: 20, file: FILE, fileId: 1, line: 90, function: '<module>', scopeId: 0, name: req.name + '.area()', text: '1000', source: 'value', logId: 'l-9' },
        ],
      };
    }
    if (t === 'eval') {
      if (String(req.expression).includes('(')) return { ok: false, error: `not evaluable: ${req.expression}`, hint: 'calls and unknown names are refused' };
      return { ok: true, text: 'True', valueBag: { data: { id: 'v:1', type: 'bool', value: 'True' } } };
    }
    if (t === 'expand') return { ok: true, node: { id: req.valueId, type: 'dict', value: '{...}', props: [{ name: 'is_awesome', value: 'True' }] } };
    if (t === 'watch' || t === 'unwatch' || t === 'select') return { ok: true };
    return { ok: false, error: `unknown request '${t}'`, hint: 'type is one of state, step, context' };
  }
}

let sessions = '';
let work = '';
let bridge: FakeBridge;
let bridges: FakeBridge[] = [];

function writeDescriptor(suffix: string, descriptor: Msg): string {
  const path = join(sessions, `${process.pid}-${suffix}.json`);
  writeFileSync(path, JSON.stringify(descriptor));
  return path;
}

async function newBridge(token?: string, events: Msg[] = []): Promise<FakeBridge> {
  const b = await new FakeBridge(token, events).listen();
  bridges.push(b);
  return b;
}

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-live-'));
  sessions = join(root, 'home', 'sessions');
  mkdirSync(sessions, { recursive: true });
  work = join(root, 'work');
  mkdirSync(join(work, 'pkg'), { recursive: true });
  writeFileSync(join(work, 'demo.py'), 'x = 1\n');
  process.env.TRACELIGHT_SESSIONS_DIR = sessions;
  process.env[`${ENV}NO_FOCUS`] = '1';
  process.chdir(work);
  bridge = await newBridge();
  writeDescriptor('1', bridge.descriptor());
});

afterEach(async () => {
  for (const b of bridges) await b.close();
  bridges = [];
  debugStartMod.debugStart.openDebugSession = realOpen;
});

const realOpen = debugStartMod.debugStart.openDebugSession;

interface Out {
  code: number;
  out: string;
  err: string;
}

async function cli(...argv: string[]): Promise<Out> {
  let out = '';
  let err = '';
  const io: Io = { out: (t) => void (out += t), err: (t) => void (err += t) };
  const code = await dispatchVerb(argv[0]!, argv.slice(1), io);
  return { code, out, err };
}

async function json(...argv: string[]): Promise<Msg> {
  const r = await cli(...argv, '--json');
  assert.equal(r.code, 0, r.out + r.err);
  return JSON.parse(r.out);
}

const last = () => bridge.requests[bridge.requests.length - 1];

// -- discovery ---------------------------------------------------------------------------------------

test('no session says what to do', async () => {
  rmSync(join(sessions, `${process.pid}-1.json`));
  const r = await cli('state', '--live');
  assert.equal(r.code, 2);
  assert.match(r.err, /error: no live session/);
  assert.match(r.err, /tracelight\.agentAccess/);
  assert.match(r.err, /saved run/);
  const j = await cli('context', '--live', '--line', 'demo.py:11', '--json');
  assert.equal(JSON.parse(j.out).error, 'no live session');
});

test('discovery skips dead pids and unreadable files', () => {
  writeFileSync(join(sessions, '1-dead.json'), JSON.stringify(bridge.descriptor({ pid: DEAD_PID, file: '/ws/other/a.py' })));
  writeFileSync(join(sessions, '2-garbage.json'), '{not json');
  writeFileSync(join(sessions, '3-partial.json'), JSON.stringify({ socket: bridge.socketPath }));
  writeFileSync(join(sessions, '4-other.sock'), '');
  const found = listSessions();
  assert.deepEqual(found.map((d) => d.file), [FILE]);
  assert.equal(found[0]!.descriptor, join(sessions, `${process.pid}-1.json`));
  assert.deepEqual(listSessions('/nonexistent/dir'), []);
});

test('picking a session', async () => {
  const other = { ...bridge.descriptor({ file: '/ws/other/tool.py', workspace: '/ws/other', started: '2026-09-10T11:00:00Z' }), descriptor: '/x/2.json' };
  const mine = { ...bridge.descriptor(), descriptor: '/x/1.json' };
  const both = [other, mine];
  assert.equal(pickSession(both, { session: 'demo.py' }), mine);
  assert.equal(pickSession(both, { session: 'tool.py' }), other);
  assert.equal(pickSession(both, { session: '/x/1.json' }), mine);
  assert.equal(pickSession(both, { fileHint: 'proj/demo.py' }), mine);
  assert.equal(pickSession(both, { cwd: '/ws/other/sub' }), other);
  assert.equal(pickSession(both, { fileHint: 'helper.py', cwd: '/ws/other/sub' }), other);
  assert.equal(pickSession([mine], { cwd: '/elsewhere' }), mine);
  assert.throws(() => pickSession(both, { cwd: '/elsewhere' }), (e: AgentError) => /2 live sessions; say which/.test(e.message) && /--session NAME/.test(e.hint!) && /demo\.py \(pid/.test(e.hint!));
  assert.throws(() => pickSession(both, { session: 'nope.py' }), (e: AgentError) => /no live session for nope\.py/.test(e.message) && /tool\.py/.test(e.hint!));
  assert.throws(() => pickSession([mine, { ...mine, descriptor: '/x/3.json' }], { session: 'demo.py' }), (e: AgentError) => /2 live sessions match demo\.py/.test(e.message) && e.hint!.includes('/x/3.json'));
  writeDescriptor('2', bridge.descriptor({ file: '/ws/other/tool.py', workspace: '/ws/other' }));
  const v = await cli('values', '--live', '--line', 'tool.py:3');
  assert.equal(v.code, 0);
  assert.ok(v.out.startsWith('2 values on tool.py:3\n'), v.out);
  assert.equal((await cli('state', '--live')).code, 2);
  assert.match((await json('state', '--live', '--session', 'tool.py')).live.descriptor, /-2\.json$/);
  assert.match((await json('state', '--session', 'demo.py')).live.descriptor, /-1\.json$/);
});

test('the debug verbs prefer a debug descriptor, the recording verbs a run one', () => {
  const run = writeDescriptor('r', { ...bridge.descriptor(), kind: 'run' });
  const dbg = writeDescriptor('d', { ...bridge.descriptor(), kind: 'debug' });
  rmSync(join(sessions, `${process.pid}-1.json`));
  const listed = listSessions();
  for (const verb of ['debug', 'continue', 'pause', 'stop', 'restart', 'break', 'watches', 'locals', 'exec', 'state', 'context', 'eval', 'shell']) assert.equal(pickSession(listed, { prefer: preferKind(verb), cwd: WORKSPACE }).descriptor, dbg, verb);
  for (const verb of ['why', 'var', 'walkthrough', 'values', 'story', 'find', 'steps']) assert.equal(pickSession(listed, { prefer: preferKind(verb), cwd: WORKSPACE }).descriptor, run, verb);
  assert.equal(pickSession(listed, { prefer: preferKind('step', 'over'), cwd: WORKSPACE }).descriptor, dbg);
  assert.equal(pickSession(listed, { prefer: preferKind('step', 'back'), cwd: WORKSPACE }).descriptor, run);
  assert.equal(substitutionNote(pickSession(listed, { session: run, prefer: 'debug' })), null);
  rmSync(dbg);
  const sub = pickSession(listSessions(), { prefer: 'debug', cwd: WORKSPACE });
  assert.equal(sub.descriptor, run);
  assert.equal(substitutionNote(sub), `no debug session here: this is the run session on demo.py. \`${NAME} debug FILE\` starts one.`);
  assert.equal(descriptorKind({}), 'run');
});

// -- handshake ---------------------------------------------------------------------------------------

test('token handshake and rejection', async () => {
  const doc = await json('state', '--live');
  assert.deepEqual(bridge.tokens, ['t0ken']);
  assert.deepEqual(bridge.requests.map((r) => r.type), ['state']);
  assert.equal(doc.runId, 'r1');
  assert.deepEqual(doc.nav, { active: false, step: null, count: 40 });
  assert.deepEqual(doc.live, { pid: process.pid, descriptor: join(sessions, `${process.pid}-1.json`), workspace: WORKSPACE });
  writeDescriptor('1', bridge.descriptor({ token: 'wrong' }));
  const r = await cli('state', '--live');
  assert.equal(r.code, 2);
  assert.equal(bridge.tokens[bridge.tokens.length - 1], 'wrong');
  assert.match(r.err, /stopped answering/);
  assert.match(r.err, /bad token/);
});

test('a dead socket', async () => {
  writeDescriptor('1', { ...bridge.descriptor(), socket: join(bridge.dir, 'gone.sock') });
  const r = await cli('state', '--live');
  assert.equal(r.code, 2);
  assert.match(r.err, /cannot connect to the live session demo\.py/);
});

// -- the run verbs over the bridge ----------------------------------------------------------------------

test('state text', async () => {
  assert.equal((await cli('state', '--live')).out, `demo.py: 40 steps, live in VS Code (pid ${process.pid})\nTime Machine inactive: \`step --live --into\` starts it at the first step, \`step --live --to N\` jumps\n`);
  bridge.nav = { active: true, step: 7, count: 40 };
  bridge.stale = true;
  assert.equal((await cli('state', '--live')).out, `stale: demo.py changed since the run\ndemo.py: 40 steps, live in VS Code (pid ${process.pid}), stale\nTime Machine at step 7/40  demo.py:11  <module>\n`);
});

test('step moves and renders the slice', async () => {
  let doc = await json('step', '--live', '--into');
  assert.deepEqual(last(), { id: 1, type: 'step', kind: 'into' });
  assert.equal(doc.step, 1);
  assert.ok(!('from' in doc));
  assert.equal(doc.block.firstStep, 1);
  assert.equal(doc.values[0].file, FILE);
  doc = await json('step', '--live', '5', '--over', '--scope');
  assert.deepEqual(bridge.requests.slice(-2).map((r) => [r.type, r.to, r.kind, r.scope]), [['step', 5, undefined, undefined], ['step', undefined, 'over', true]]);
  assert.deepEqual([doc.from, doc.step], [5, 6]);
  doc = await json('step', '--live', '--to', '9');
  assert.deepEqual(last(), { id: 1, type: 'step', to: 9 });
  const r = await cli('step', '--live', '--into');
  const lines = r.out.split('\n');
  assert.ok(lines[0]!.startsWith('step 10/40  demo.py:11  <module>'), r.out);
  assert.equal(lines[1], 'block <module>  demo.py  from step 2');
  assert.ok(r.out.includes(`  #10 demo.py:11  {'is_awesome': True, 'api_key': '${REDACTED}'}`), r.out);
  assert.ok(!r.out.includes('sk-abc'));
  assert.ok(r.out.includes('moves: into 11 · over 11 · out 39 · back 9 · back-over 9 · back-out —'));
  const bad = await cli('step', '--live', '--to', '400');
  assert.equal(bad.err, 'error: step 400 is out of range\nsteps are 0..39\n');
  assert.match((await cli('step', '--live', 'run.json', '--into')).err, /--live reads the open VS Code session, not run\.json/);
});

test('an older extension is named, not its unknown request', () => {
  assert.equal(OLD_EXTENSION.exec('unknown request "recording"')![1], 'recording');
  assert.equal(OLD_EXTENSION.exec('step 400 is out of range'), null);
});

test('context, values, eval, expand, var', async () => {
  assert.equal((await json('context', '--live', '--line', 'demo.py:11')).step, 5);
  assert.deepEqual(last(), { id: 1, type: 'context', file: 'demo.py', line: 11 });
  await json('context', '--live', '12', '--scope');
  assert.deepEqual(last(), { id: 1, type: 'context', step: 12, scope: true });
  assert.deepEqual(await cli('values', '--live', '--line', 'demo.py:7'), { code: 0, out: '2 values on demo.py:7\n  #4 hit 1  x = 3\n  #8 hit 2  x = 4\n', err: '' });
  assert.match((await cli('values', '--live', '--line', 'nope.py:1')).err, /not part of the run/);
  assert.equal((await cli('eval', '--live', "config['is_awesome']")).out, "config['is_awesome'] = True\n");
  assert.deepEqual(last(), { id: 1, type: 'eval', expression: "config['is_awesome']" });
  assert.equal((await cli('expand', '--live', 'v:1', '--path', 'is_awesome')).out, 'dict {...}\n  is_awesome: True\n');
  assert.deepEqual(last(), { id: 1, type: 'expand', valueId: 'v:1', queryPath: ['is_awesome'] });
  const v = await json('var', '--live', 'rect1', '--file', 'demo.py', '--scope', '<module>', '--limit', '5');
  assert.deepEqual(last(), { id: 1, type: 'var', name: 'rect1', limit: 5, file: 'demo.py', scope: '<module>' });
  assert.equal(v.changes[0].file, FILE);
});

test('steps are built from context requests; story and find are refused with the saved-run command', async () => {
  const r = await cli('steps', '--live', '--from', '38', '--count', '5');
  assert.deepEqual(bridge.requests.map((q) => [q.type, q.step]), [['state', undefined], ['context', 38], ['context', 39]]);
  assert.equal(r.out, 'steps 38.. of 40\n#38     demo.py:11  <module>  depth 0\n#39     demo.py:11  <module>  depth 0\n');
  assert.match((await cli('steps', '--live', '--line', 'demo.py:11')).err, /steps --line needs the trace.*\n.*context --live --line demo\.py:11/);
  bridge.requests = [];
  const s = await cli('story', '--live', '--file', 'demo.py');
  assert.equal(s.code, 2);
  assert.ok(s.err.includes(`\`${NAME} run demo.py --save run.json\``) && s.err.includes('story run.json --file demo.py'), s.err);
  assert.ok((await cli('find', '--live', 'Kaboom')).err.includes("find run.json 'Kaboom'"));
  assert.match((await cli('release', '--live')).err, /kept runner/);
  assert.deepEqual(bridge.requests, []);
});

test('a stale reply is reported first', async () => {
  bridge.stale = true;
  assert.ok((await cli('context', '--live', '--line', 'demo.py:11')).out.startsWith('stale: demo.py changed since the run\nstep 5/40'));
});

// -- watch -------------------------------------------------------------------------------------------

test('watch prints one line per event until the bridge closes', async () => {
  const where = (line: number) => ({ file: FILE, line, col: 0, function: '<module>', fileId: 1 });
  const b = await newBridge('t0ken', [
    { event: 'step', step: 12, location: where(85), values: [{ line: 85, context: 'rect1', text: '<Rectangle 50x20>', step: 12 }, { line: 85, context: 'token', text: 'sk-abcdefghijklmnopqrstuvwxyz', step: 12 }] },
    { event: 'paused', step: 12, location: where(12), reason: 'breakpoint', breakpoint: { file: 'demo.py', line: 12, condition: 'x > 1' }, values: [{ line: 12, context: 'x', text: '2' }] },
    { event: 'paused', step: 31, location: where(31), reason: 'breakpoint', breakpoint: { condition: 'nope > 1' }, conditionError: "NameError: name 'nope' is not defined" },
    { event: 'paused', step: 32, location: where(6), reason: 'exception', exception: { type: 'ValueError', message: 'too big: 3', uncaught: true } },
    { event: 'paused', step: 30, location: where(30), reason: 'watch', watch: { id: 'w1', exp: 'payload is None', text: 'True' } },
    { event: 'resumed' },
    { event: 'rerun', runId: 'r2' },
    { event: 'finished', exitCode: 0 },
  ]);
  writeDescriptor('1', b.descriptor());
  const r = await cli('watch', '--live');
  assert.equal(r.code, 0);
  assert.deepEqual(r.out.split('\n'), [
    `step 12  demo.py:85  <module>   values: rect1 = <Rectangle 50x20>, token = ${REDACTED}`,
    'paused at demo.py:12 (breakpoint if x > 1)   values: x = 2',
    "paused at demo.py:31 (breakpoint if nope > 1, condition failed: NameError: name 'nope' is not defined)",
    'paused at demo.py:6 (uncaught ValueError: too big: 3)',
    'paused at demo.py:30 (watch payload is None: True)',
    'resumed',
    'rerun',
    'finished: exit 0',
    '',
  ]);
  assert.equal(watchLine({ event: 'output', text: 'a\nb\n' }, { displayPath: (p: string) => p }, (t) => String(t)), 'output: a b');
});

// -- debugging -----------------------------------------------------------------------------------------

test('debug starts paused and prints the stop; stop and restart', async () => {
  assert.deepEqual(await cli('stop', '--live'), { code: 0, out: 'nothing to stop: no debug run is in flight; `debug --live` starts one\n', err: '' });
  const r = await cli('debug', '--live');
  assert.deepEqual(last(), { id: 1, type: 'debug' });
  assert.ok(r.out.startsWith('paused at demo.py:11 (start)\nstep 0/40  demo.py:11  <module>\nblock <module>  demo.py  from step 0\n'), r.out);
  assert.ok(r.out.includes('\nlocals:\n  total = 3\n  payload = None\noutput (last 3 lines):\n  start\n  loading 1\n  loading 2\nnot run: 32\n'), r.out);
  const doc = await json('debug', '--live', '--stop-on-entry');
  assert.deepEqual(last(), { id: 1, type: 'debug', stopOnEntry: true });
  assert.equal(doc.paused.reason, 'start');
  assert.equal(doc.block.firstStep, 0);
  await json('break', '--live', 'demo.py:11');
  const re = await cli('restart', '--live');
  assert.deepEqual(last(), { id: 1, type: 'restart' });
  assert.ok(re.out.startsWith('paused at demo.py:11 (breakpoint)\nstep 3/40'), re.out);
  assert.equal((await cli('stop', '--live')).out, 'stopped: exit None, 12 steps\n');
  const plain = await cli('debug');
  assert.equal(plain.err, 'error: debug drives the open VS Code session, not a saved run\ndebugging needs a live session (`--live`)\n');
});

test('break adds, lists and removes; --on-exception', async () => {
  const r = await cli('break', '--live', 'demo.py:11', 'helper.py:3', '--when', 'x > 1');
  assert.deepEqual(last(), { id: 1, type: 'break', add: [{ file: 'demo.py', line: 11, condition: 'x > 1' }, { file: 'helper.py', line: 3, condition: 'x > 1' }] });
  assert.equal(r.out, '2 breakpoints\n  demo.py:11  if x > 1  -> resolved line 11\n  helper.py:3  if x > 1  (not resolved yet)\nexceptions: uncaught\n');
  await cli('break', '--live');
  assert.deepEqual(last(), { id: 1, type: 'break', list: true });
  assert.equal((await cli('break', '--live', '--remove', 'helper.py:3')).out, '1 breakpoint\n  demo.py:11  if x > 1  -> resolved line 11\nexceptions: uncaught\n');
  assert.deepEqual(last(), { id: 1, type: 'break', remove: [{ file: 'helper.py', line: 3 }] });
  assert.deepEqual((await json('break', '--live', '--remove', 'demo.py:11')).breakpoints, []);
  assert.match((await cli('break', '--live', '--list')).out, /^no breakpoints;/);
  assert.match((await cli('break', '--live', '--when', 'x > 1')).err, /--when needs a FILE:LINE/);
  assert.match((await cli('break', '--live', 'demo.py')).err, /break wants FILE:LINE.*\n.*`break --live agent\.ts:16`/);
  await cli('break', '--live', '--at', 'rrf', '--at', 'Ranker.rank');
  assert.deepEqual(bridge.requests.slice(-2), [{ id: 1, type: 'break', at: 'Ranker.rank' }, { id: 2, type: 'break', at: 'rrf' }]);
  assert.equal((await cli('break', '--live', '--on-exception', 'raised')).out, 'no breakpoints; `break --live FILE:LINE [--when EXPR]` adds one\nexceptions: raised\n');
  assert.deepEqual(last(), { id: 1, type: 'break', exceptions: 'raised' });
  bridge.debug = { active: true, paused: pausedAt(6, 'exception', 6, { exception: { type: 'ValueError', message: 'too big: 3', uncaught: true } }), frontier: 6 };
  assert.equal((await cli('state', '--live')).out.trimEnd().split('\n').pop(), 'debug: paused at demo.py:6 (uncaught ValueError: too big: 3)');
});

test('break --remove takes a line or the name --at set', () => {
  assert.deepEqual(removeItem('demo.py:82'), { file: 'demo.py', line: 82 });
  assert.deepEqual(removeItem('rrf'), { function: 'rrf' });
  assert.deepEqual(removeItem('Ranker.rank'), { function: 'Ranker.rank' });
  assert.throws(() => removeItem('not a name'), (e: AgentError) => e.message.includes('FILE:LINE or a function name'));
});

test('continue prints the next stop, then finished; the substituted session is named on failure', async () => {
  const none = await cli('continue', '--live');
  assert.equal(none.code, 2);
  assert.ok(none.err.includes('no debug run in progress'));
  assert.ok(none.err.includes(`no debug session here: this is the run session on demo.py. \`${NAME} debug FILE\` starts one.`), none.err);
  await json('debug', '--live');
  await json('break', '--live', 'demo.py:11');
  const r = await cli('continue', '--live');
  assert.deepEqual(last(), { id: 1, type: 'continue' });
  assert.ok(r.out.startsWith('paused at demo.py:11 (breakpoint)\nstep 12/40  demo.py:11  <module>\n'), r.out);
  await cli('continue', '--live', '--no-wait', '--to', 'demo.py:20');
  assert.deepEqual(last(), { id: 1, type: 'continue', noWait: true, to: { file: 'demo.py', line: 20 } });
  await cli('continue', '--live', '--until', 'x > 3');
  assert.deepEqual(last(), { id: 1, type: 'continue', until: 'x > 3' });
  bridge.finishNext = true;
  assert.deepEqual(await cli('continue', '--live'), { code: 0, out: 'finished: exit 0, 40 steps\n', err: '' });
});

test('pause, locals, watches, exec, step at the frontier', async () => {
  assert.match((await cli('locals', '--live')).err, /not paused/);
  await json('debug', '--live');
  assert.ok((await cli('pause', '--live')).out.startsWith('paused at demo.py:11 (pause)\nstep 7/40'));
  assert.deepEqual(await cli('locals', '--live'), { code: 0, out: 'total = 3\npayload = None\n', err: '' });
  assert.deepEqual(last(), { id: 1, type: 'locals' });
  assert.equal((await json('locals', '--live', '--frame', '2')).locals[0].valueBag.data.id, 'v:total');
  assert.deepEqual(last(), { id: 1, type: 'locals', valueBag: true, frameId: 2 });
  assert.equal((await cli('watches', '--live', '--add', 'payload is None', '--break-when', 'true')).out, '1 watch\n  w1  payload is None  break when true\n');
  assert.deepEqual(last(), { id: 1, type: 'watches', add: [{ exp: 'payload is None', breakWhen: 'true' }] });
  assert.equal((await cli('watches', '--live', '--add', 'total')).out, '2 watches\n  w1  payload is None  break when true\n  w-fake-1  total  = 3\n');
  assert.deepEqual((await json('watches', '--live', '--remove', 'w1', '--remove', 'w-fake-1')).watches, []);
  assert.match((await cli('watches', '--live', '--list')).out, /^no watches;/);
  const step = await cli('step', '--live', '--over');
  assert.deepEqual(last(), { id: 1, type: 'step', kind: 'over' });
  assert.ok(step.out.startsWith('paused at demo.py:11 (step over)\nstep 8/40'), step.out);
  bridge.canned.exec = { text: '', modified: true, exception: { type: 'ZeroDivisionError', message: 'division by zero' } };
  const ex = await cli('exec', '--live', '1/0');
  assert.deepEqual(bridge.requests.slice(-2).map((q) => q.type), ['exec', 'state']);
  assert.deepEqual(ex, { code: 0, out: 'still paused at demo.py:11\n', err: 'ZeroDivisionError: division by zero\n' });
  bridge.canned.exec = { text: '3', modified: true };
  assert.equal((await cli('exec', '--live', 'x = 3', '--frame', '1')).out, "3\nvalues modified from the console: they are no longer the program's own\n");
  assert.deepEqual(last(), { id: 1, type: 'exec', source: 'x = 3', frameId: 1 });
  bridge.finishNext = true;
  assert.equal((await cli('step', '--live', '--into')).out, 'finished: exit 0, 40 steps\n');
});

// -- shell -----------------------------------------------------------------------------------------------

async function shell(lines: string, ...args: string[]): Promise<Out> {
  shellInput.lines = async function* () {
    for (const l of lines.split('\n')) yield l;
  };
  return cli('shell', ...args);
}

test('the shell answers line by line over one connection', async () => {
  const r = await shell('state\n\n# a comment\ndebug --stop-on-entry\nlocals\nbogus --x\nwatch\nstop\nexit\nstate\n', '--live', '--session', 'demo.py');
  assert.equal(r.code, 0);
  assert.deepEqual(bridge.tokens, ['t0ken']);
  assert.deepEqual(bridge.requests.map((q) => q.type), ['state', 'debug', 'locals', 'stop']);
  assert.deepEqual(bridge.requests[1], { id: 2, type: 'debug', stopOnEntry: true });
  const results = r.out.split('\n\n');
  assert.equal(results.length, 5);
  assert.equal(results[2], 'total = 3\npayload = None');
  assert.equal(results[3], 'stopped: exit None, 12 steps');
  const errors = r.err.split('\n');
  assert.ok(errors[0]!.startsWith("error: argument command: invalid choice: 'bogus'"), errors[0]!);
  assert.ok(errors[1]!.startsWith('one command per line'));
  assert.equal(errors[2], 'error: watch streams every stop until Ctrl-C, so it would block the shell');
  assert.equal(errors[3], `run \`${NAME} watch --live\` in another terminal`);
});

test('the shell with --json prints one line per result and implies --live', async () => {
  const r = await shell('state\ndebug --stop-on-entry\nlocals\ncontext run.json\nexit\n', '--session', 'demo.py', '--json');
  assert.equal(r.err, '');
  const docs = r.out.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(docs.length, 4);
  assert.deepEqual(bridge.requests[2], { id: 3, type: 'locals', valueBag: true });
  assert.equal(docs[3].error, 'the shell reads the live session, not run.json');
  assert.deepEqual(shlexSplit(`eval 'payload["x"]' a\\ b "c d"`), ['eval', 'payload["x"]', 'a b', 'c d']);
  assert.throws(() => shlexSplit("eval 'x"));
});

// -- the relaunch memory -------------------------------------------------------------------------------

test('the memory sits beside the sessions directory and answers the nearest directory', () => {
  const home = realpathSync(work);
  assert.equal(resolve(memoryPath(), '..'), resolve(sessions, '..'));
  remember({ program: join(home, 'demo.mjs') }, 'rrf', [], home);
  remember({ program: join(home, 'pkg', 'server.ts') }, null, [], join(home, 'pkg'));
  assert.equal(recall(home)!.at, 'rrf');
  assert.deepEqual(recall(join(home, 'pkg'))!.launch, { program: join(home, 'pkg', 'server.ts') });
  mkdirSync(join(home, 'sub'));
  assert.equal(recall(join(home, 'sub'))!.at, 'rrf');
  assert.equal(recall(resolve(home, '..')), null);
  assert.deepEqual(readdirSync(sessions).filter((n) => !n.startsWith(String(process.pid))), []);
  assert.equal(commandLine({ program: join(process.cwd(), 'app.ts'), args: ['--port', '8000'] }, 'app.ts:3'), `${NAME} debug app.ts --at app.ts:3 --args --port 8000`);
});

function fakeOpen(calls: unknown[], kind = 'debug', route = 'debug') {
  debugStartMod.debugStart.openDebugSession = async (launch: Msg, at: unknown) => {
    calls.push([launch, at]);
    return [await LiveRun.open({ ...bridge.descriptor(), kind }), null, route];
  };
}

test('a debugger verb with no session starts the last launch and prints its first stop', async () => {
  rmSync(join(sessions, `${process.pid}-1.json`));
  const none = await cli('continue', '--live');
  assert.equal(none.code, 2);
  assert.ok(none.err.includes(`${NAME} debug FILE --at NAME`), none.err);
  bridge.debug = { active: true, paused: pausedAt(7, 'breakpoint'), frontier: 7 };
  const calls: unknown[] = [];
  fakeOpen(calls);
  const launch = { program: join(work, 'demo.py'), cwd: work };
  remember(launch, 'rrf');
  const r = await cli('continue', '--live');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(calls, [[launch, ['rrf']]]);
  assert.ok(r.out.startsWith(`no debug session was running: started the last launch from this directory again, \`${NAME} debug demo.py --at rrf\`\npaused at`), r.out);
  assert.deepEqual(bridge.requests.filter((q) => q.type === 'continue' || q.type === 'debug').map((q) => q.type), ['debug']);
  // --no-start refuses and names the launch; listing breakpoints never starts a program
  const refused = await cli('continue', '--live', '--no-start', '--json');
  assert.equal(JSON.parse(refused.out).error, 'no live session');
  assert.ok(JSON.parse(refused.out).hint.includes(`${NAME} debug demo.py --at rrf`));
  assert.match((await cli('break', '--live', '--list')).err, /debug FILE --at NAME/);
  // break with no session stops at the new breakpoint, and remembers it
  calls.length = 0;
  assert.equal((await cli('break', '--live', 'demo.py:1')).code, 0);
  assert.deepEqual(calls.map((c) => (c as unknown[])[1]), [[`${join(work, 'demo.py')}:1`]]);
  assert.equal(recall()!.at, `${join(work, 'demo.py')}:1`);
  // every --at of a launch is started again
  calls.length = 0;
  remember(launch, 'load', ['clean', 'score']);
  const all = await cli('continue', '--live');
  assert.deepEqual(calls.map((c) => (c as unknown[])[1]), [['load', 'clean', 'score']]);
  assert.ok(all.out.includes(`\`${NAME} debug demo.py --at load --at clean --at score\``));
});

// -- the cold start ------------------------------------------------------------------------------------------

const APP = '/ws/app.ts';

function dbgDescriptor(name: string, o: Msg = {}): string {
  const file = o.file ?? APP;
  const doc: Msg = { socket: join(sessions, name + '.sock'), token: 't'.repeat(32), pid: process.pid, kind: o.kind ?? 'run', workspace: '/ws', file, displayName: basename(file), started: o.started ?? '2026-09-15T09:10:00.000Z' };
  if (doc.kind === 'debug') doc.launch = o.launch ?? { program: file, args: [], cwd: '/ws', record: false };
  const path = join(sessions, name + '.json');
  writeFileSync(path, JSON.stringify(doc));
  return path;
}

test('the URI, --at, and the launch', () => {
  const { buildLaunch, buildUri, parseAt, AT_UNREADABLE } = debugStartMod;
  const launch = buildLaunch({ program: APP, args: ['--port', '8000'], cwd: '/ws', env: { PORT: '8000' }, node: '/usr/bin/node', stopOnEntry: true });
  const uri = buildUri(launch, 'app.ts:42');
  assert.ok(uri.startsWith('vscode://ivor.tracelight/debug?'));
  for (const part of ['program=%2Fws%2Fapp.ts', 'args=%5B%22--port%22%2C%228000%22%5D', 'env=%7B%22PORT%22%3A%228000%22%7D', 'node=%2Fusr%2Fbin%2Fnode', 'stopOnEntry=1', 'at=app.ts%3A42']) assert.ok(uri.includes(part), part);
  const plain = buildUri(buildLaunch({ program: APP, cwd: '/ws' }));
  for (const absent of ['stopOnEntry', 'record', 'libraryCode', 'args', 'env']) assert.ok(!plain.includes(absent), absent);
  const two = buildUri({ program: '/w/app.ts' }, ['load', '/w/stage.ts:3']);
  assert.equal(two.split('&at=').length - 1, 2);
  assert.ok(two.includes('at=%2Fw%2Fstage.ts%3A3'));
  assert.deepEqual(parseAt('app.ts:42'), { file: 'app.ts', line: 42 });
  assert.deepEqual(parseAt('  rrf  '), { function: 'rrf' });
  assert.deepEqual(parseAt('Ranker.rank'), { function: 'Ranker.rank' });
  for (const junk of ['app.ts:0', 'app.ts:x', '9lives', '']) assert.throws(() => parseAt(junk), (e: AgentError) => e.message.includes(AT_UNREADABLE));
  assert.throws(() => buildLaunch({}), (e: AgentError) => /debug needs a file/.test(e.message) && /debug app\.ts/.test(e.hint!));
  assert.equal(buildLaunch({ program: APP, recordFrom: 'rrf' }).record, true);
});

test('debug FILE: --module is not a flag, --env wants K=V, and --at names a file that exists', async () => {
  const mod = await cli('debug', '--module', 'app.server');
  assert.equal(mod.code, 2);
  assert.match(mod.err, /unrecognized arguments: --module|--module/);
  assert.match((await cli('debug', 'app.ts', '--env', 'PORT')).err, /--env wants K=V, got 'PORT'/);
  assert.match((await cli('debug', 'app.ts', '--at', '9lives')).err, /--at wants FILE:LINE or a function name/);
  assert.match((await cli('debug', 'app.ts', '--at', 'sub/app.ts:3')).err, /--at names no file: sub\/app\.ts/);
});

test('the three routes: a matching debug socket, a run socket, else the URI', async () => {
  const { buildLaunch, buildRoute, findDebugDescriptor, startViaUri } = debugStartMod;
  rmSync(join(sessions, `${process.pid}-1.json`));
  const launch = buildLaunch({ program: APP, cwd: '/ws' });
  assert.deepEqual(buildRoute(launch), ['uri', null]);
  const run = dbgDescriptor('1-1');
  assert.equal(buildRoute(launch)[0], 'run');
  assert.equal(buildRoute(launch)[1]!.descriptor, run);
  const dbg = dbgDescriptor('1-2', { kind: 'debug' });
  assert.equal(buildRoute(launch)[1]!.descriptor, dbg);
  assert.equal(findDebugDescriptor(launch, { since: Date.now() / 1000 }), null, 'older than the request');
  rmSync(run);
  rmSync(dbg);
  // route (c): the `code` stand-in records the URI, the window's descriptor shows up later
  const record = join(work, 'uri.txt');
  const stub = join(work, 'code-stub');
  writeFileSync(stub, `#!/bin/sh\nprintf "%s" "$2" > "${record}"\n`);
  chmodSync(stub, 0o755);
  process.env[`${ENV}CODE`] = stub;
  try {
    setTimeout(() => dbgDescriptor('1-9', { kind: 'debug', started: new Date(Date.now() + 1000).toISOString() }), 300);
    const found = await startViaUri(launch, null, { timeout: 10 });
    assert.equal(found.kind, 'debug');
    assert.ok(readFileSync(record, 'utf8').startsWith('vscode://ivor.tracelight/debug?'));
    process.env[`${ENV}CODE`] = '/bin/true';
    rmSync(join(sessions, '1-9.json'));
    await assert.rejects(startViaUri(launch, null, { timeout: 0.5 }), (e: AgentError) => /did not start a debug session for app\.ts/.test(e.message) && e.hint!.startsWith('look at the VS Code window first') && e.hint!.includes(`\`${NAME} state --live\` is the next command`));
  } finally {
    delete process.env[`${ENV}CODE`];
  }
  const savedPath = process.env.PATH;
  process.env.PATH = '/nonexistent';
  try {
    assert.throws(() => debugStartMod.codeCommand(), (e: AgentError) => e.message === debugStartMod.CODE_MISSING && e.hint!.includes(`${ENV}CODE`));
  } finally {
    process.env.PATH = savedPath;
  }
});

test('debug FILE on a run socket sends the launch with the request, --at first over the socket', async () => {
  rmSync(join(sessions, `${process.pid}-1.json`));
  const file = join(work, 'app.ts');
  writeFileSync(file, 'const x = 1;\n');
  writeDescriptor('run', { ...bridge.descriptor({ file, workspace: work }), kind: 'run' });
  const r = await cli('debug', 'app.ts', '--at', 'app.ts:1', '--at', 'rrf', '--node', '/opt/node', '--args', '--port', '8000');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(bridge.requests.map((q) => q.type), ['break', 'break', 'debug']);
  assert.deepEqual(bridge.requests[0]!.add, [{ file, line: 1 }]);
  assert.equal(bridge.requests[1]!.at, 'rrf');
  assert.deepEqual(bridge.requests[2]!.launch, { args: ['--port', '8000'], env: {}, stopOnEntry: false, libraryCode: false, record: false, program: file, cwd: work, node: '/opt/node' });
  assert.match(r.out, /^paused at \S+:1 \(breakpoint\)\n/);
  assert.equal(recall()!.at, `${file}:1`);
  assert.deepEqual(recall()!.also, ['rrf']);
});

// -- render_debug -------------------------------------------------------------------------------------------

const src = { displayPath: (p: unknown) => (p ? basename(String(p)) : '<unknown>') } as any;

test('the debug stop text: modified values, a count that ended, folded frames, output delta, block gaps', () => {
  const stop = { location: { file: '/ws/app.ts', line: 42 }, paused: { reason: 'breakpoint' }, modified: true, stoppedEarly: { after: 2, reason: 'breakpoint' } };
  const lines = renderDebugStop(stop, src, {});
  assert.equal(lines[0], 'paused at app.ts:42 (breakpoint) (values modified from the console)');
  assert.equal(lines[1], 'stopped early after 2 steps: breakpoint');
  assert.deepEqual(renderDebugStop({ finished: { exitCode: 0, stepCount: 1403 }, stepped: 2 }, src, {}), ['finished: exit 0, 1403 steps', '2 steps were taken before it ended']);
  const deep = { location: { file: '/ws/app.ts', line: 1 }, paused: { reason: 'step' }, stack: Array.from({ length: 20 }, (_, i) => ({ file: '/ws/app.ts', line: i + 1, function: `f${i}` })) };
  const stack = renderDebugStop(deep, src, {}).find((l) => l.startsWith('stack:'))!;
  assert.ok(stack.includes('f0 app.ts:1') && stack.includes('… 13 frames …') && stack.endsWith('f19 app.ts:20'), stack);
  const lib = { ...deep, stack: [{ file: '/ws/app.ts', line: 42, function: 'get' }, { elided: 3, where: 'library', in: ['undici/index.js'] }, { file: '/ws/app.ts', line: 9, function: '<module>' }] };
  assert.ok(renderDebugStop(lib, src, {}).find((l) => l.startsWith('stack:'))!.includes('… 3 library frames in undici/index.js …'));
  const base = { location: { file: '/ws/app.ts', line: 42 }, paused: { reason: 'step' } };
  assert.ok(renderDebugStop({ ...base, output: { text: 'served /\nserved /x\n', since: 'stop', earlier: 412 } }, src, {}).includes('output (2 new lines; 412 earlier):'));
  assert.ok(renderDebugStop({ ...base, output: { text: '', since: 'stop', earlier: 412 } }, src, {}).includes('output: nothing new since the last stop (412 lines earlier; --scope for the window)'));
  const block = renderDebugStop({ ...base, block: { file: '/ws/app.ts', function: 'big', capped: true, totalLines: 400, lines: [{ line: 1, text: 'function big(rows) {' }, { line: 301, text: '  for (const r of rows) {' }, { line: 302, text: '    step = r;', current: true }] } }, src, {});
  assert.ok(block.includes('block big  app.ts (3 of 400 lines; --scope for all)'));
  assert.ok(block.some((l) => l.trim() === '… 299 lines'));
  assert.ok(block.some((l) => l.startsWith('>302')));
});

test('exec and state text forms', () => {
  assert.deepEqual(renderDebugExec({ text: "'last'", modified: false }, src, {}), ["'last'"]);
  assert.deepEqual(renderDebugExec({ text: '', modified: false }, src, {}), ['ok']);
  assert.equal(execError({ text: '3' }), null);
  const lines = renderDebugState({
    kind: 'debug', running: true, paused: true, displayName: 'app.ts', file: APP,
    launch: { program: APP, args: ['--port', '8000'], cwd: '/ws', node: '/usr/bin/node', record: false, libraryCode: true },
    debug: { active: true, paused: { file: APP, line: 42, reason: 'breakpoint' }, exceptions: 'uncaught' },
    output: { text: 'listening on 8000\n' },
    others: [{ kind: 'run', displayName: 'app.ts', running: false, steps: 1240 }],
  }, src, {});
  assert.ok(lines[0]!.startsWith('debug  app.ts') && lines[0]!.includes('[this]'));
  assert.ok(lines[1]!.startsWith('run    app.ts') && lines[1]!.includes('finished, 1240 steps'));
  for (const want of ['app.ts  paused at app.ts:42 (breakpoint)', '  launch: /usr/bin/node /ws/app.ts --port 8000   (cwd /ws)', '  record: off', '  library code: on', '  exceptions: uncaught', '    listening on 8000']) assert.ok(lines.includes(want), want);
});
