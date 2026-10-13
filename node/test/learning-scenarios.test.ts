/**
 * The investigation patterns in skills/tracelight/references/learning-patterns.md, run on the
 * repository's multi-file examples through the routes an agent uses: the live debugger the CLI and
 * the browser page drive (here the runner, without a window), and `tracelight mcp` over recordings.
 * Each test asserts the evidence a pattern promises, so a change that breaks what the skill
 * teaches fails here. skill.test.ts only holds the documentation to the CLI's names and flags.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Driver } from './driver.ts';
import type { Msg } from './helpers.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const CHECKOUT = join(ROOT, 'examples/js/checkout');
const RRF = join(ROOT, 'examples/js/rrf');
const BIN = resolve(import.meta.dirname, '../bin/tracelight.mjs');

const files = (dir: string, rels: string[]) => Object.fromEntries([['package.json', '{"type":"module"}'], ...rels.map((r) => [r, readFileSync(join(dir, r), 'utf8')])]);
const names = (pause: Msg) => pause.stack.map((f: Msg) => f.name as string);

async function localsOf(d: Driver): Promise<Record<string, string>> {
  const r = await d.ask({ type: 'debug', action: 'locals' });
  return Object.fromEntries(r.locals.map((l: Msg) => [l.name, l.text]));
}

/** The class whose body holds LINE of a checkout file: frame names alone (`charge`, `constructor`) do not say. */
function classAt(rel: string, line: number): string | undefined {
  const declared = readFileSync(join(CHECKOUT, rel), 'utf8').split('\n').slice(0, line).reverse();
  return declared.find((l) => l.startsWith('export class'))?.match(/^export class (\w+)/)?.[1];
}

test('cold live learning from the real entry: the branch that picks the gateway, the implementation that ran, the handler on a later turn', async () => {
  const d = new Driver();
  try {
    const main = d.start(files(CHECKOUT, ['main.ts', 'checkout.ts', 'payments.ts', 'events.ts']), 'main.ts', { stopOnEntry: false }, { argv: ['--country', 'de'], breakpoints: [{ path: '', function: 'gatewayFor' }, { path: '', function: 'placeOrder' }] });
    const file = (id: number) => d.seen.find((m) => m.type === 'file.instrumented' && m.fileId === id)?.path as string | undefined;
    // decision: the operand before the branch runs, then the arm that ran
    assert.equal(names(await d.paused())[0], 'gatewayFor');
    await d.ask({ type: 'debug', action: 'step', kind: 'into' });
    const branch = await d.paused();
    assert.equal(branch.line, 36);
    assert.equal((await localsOf(d)).country, "'de'");
    let built = branch;
    for (let i = 0; i < 4 && names(built)[0] !== 'constructor'; i++) {
      await d.ask({ type: 'debug', action: 'step', kind: 'into' });
      built = await d.paused();
    }
    assert.deepEqual(names(built).slice(0, 2), ['constructor', 'gatewayFor']);
    assert.match(file(built.fileId) ?? '', /payments\.ts$/);
    assert.equal(classAt('payments.ts', built.line), 'InvoiceGateway');
    assert.equal((await localsOf(d)).dueDays, '14');

    await d.ask({ type: 'debug', action: 'continue' });
    const entry = await d.paused();
    assert.equal(names(entry)[0], 'placeOrder');
    // a destination breakpoint at the call, then Continue: the route a learner's question picks
    await d.ask({ type: 'debug', action: 'breakpoints', set: [{ path: join(dirname(main), 'checkout.ts'), line: 46 }] });
    await d.ask({ type: 'debug', action: 'continue' });
    const atCall = await d.paused();
    assert.deepEqual([atCall.reason, atCall.line, names(atCall)[0]], ['breakpoint', 46, 'placeOrder']);
    // before the statement: its inputs exist, its result does not yet
    const before = await localsOf(d);
    assert.equal(before.total, '153.47');
    assert.equal(before.currency, "'EUR'");
    assert.ok(before.charge === undefined || before.charge === 'undefined', `charge before the call: ${before.charge}`);

    await d.ask({ type: 'debug', action: 'step', kind: 'into' });
    const inside = await d.paused();
    // the call site names only PaymentGateway, and both gateways have a `charge`: the pause's
    // file and line, then `this`, say which class answered
    assert.deepEqual(names(inside).slice(0, 2), ['charge', 'placeOrder']);
    assert.match(file(inside.fileId) ?? '', /payments\.ts$/);
    assert.match(readFileSync(join(CHECKOUT, 'payments.ts'), 'utf8').split('\n')[inside.line - 1]!, /async charge\(/);
    assert.equal(classAt('payments.ts', inside.line), 'InvoiceGateway');
    const self = await d.ask({ type: 'evaluate', expression: 'this' });
    assert.equal(self.text, 'InvoiceGateway { dueDays: 14 }');

    // the handler for the published event runs after placeOrder returned: no placeOrder frame
    await d.ask({ type: 'debug', action: 'breakpoints', set: [{ path: main, line: 25 }] });
    await d.ask({ type: 'debug', action: 'continue' });
    const handler = await d.paused();
    // the stack starts at the setImmediate callback in events.ts; the module frame under it is no caller and has no line
    assert.deepEqual(handler.stack.map((f: Msg) => [f.name, f.fileId === undefined ? undefined : file(f.fileId)?.split('/').pop(), f.line]), [
      ['sendReceipt', 'main.ts', 25],
      ['flush', 'events.ts', 27],
      ['<arrow>', 'events.ts', 18],
      ['<module>', undefined, undefined],
    ]);
    assert.ok(d.seen.some((m) => m.type === 'log' && String(m.text).startsWith('placed ord-1 153.47 EUR')), 'placeOrder finished before the handler');
    await d.ask({ type: 'debug', action: 'breakpoints', set: [] });
    await d.ask({ type: 'debug', action: 'continue' });
    const end = await d.next((m) => m.type === 'run.finished', 'run.finished');
    assert.equal(end.exitCode, 0);
  } finally {
    d.close();
  }
});

test('a test is a real entry too: the debugger pauses in placeOrder under the test file\'s own cart', async () => {
  const d = new Driver();
  try {
    d.start(files(CHECKOUT, ['checkout.test.ts', 'checkout.ts', 'payments.ts', 'events.ts']), 'checkout.test.ts', { stopOnEntry: false }, { breakpoints: [{ path: '', function: 'placeOrder' }] });
    const entry = await d.paused();
    assert.deepEqual(names(entry), ['placeOrder', '<arrow>', '<module>']);
    assert.match((await localsOf(d)).cart ?? '', /country: 'de'.*sku: 'KB-01', qty: 2/);
    await d.ask({ type: 'debug', action: 'breakpoints', set: [] });
    await d.ask({ type: 'debug', action: 'continue' });
    assert.equal((await d.next((m) => m.type === 'run.finished', 'run.finished')).exitCode, 0);
  } finally {
    d.close();
  }
});

test('a request crossing an HTTP boundary in one process: the handler pause holds the request, not the client', async () => {
  const d = new Driver();
  try {
    d.start(files(RRF, ['api/server.ts', 'api/ranking.ts']), 'api/server.ts', { stopOnEntry: false }, { argv: ['--once'], breakpoints: [{ path: '', function: 'rank' }] });
    const atRank = await d.paused();
    assert.equal(names(atRank)[0], 'rank');
    assert.ok(names(atRank).includes('handle'), names(atRank).join(' ← '));
    const rankLocals = await localsOf(d);
    assert.match(rankLocals.request ?? '', /bm25: \[ 'A', 'C', 'B', 'D' \]/);
    // the client side of the same request (the listen callback awaiting fetch at line 86) is not a
    // frame here; the open frames under handle carry no line of their own
    const file = (id: number) => d.seen.find((m) => m.type === 'file.instrumented' && m.fileId === id)?.path as string | undefined;
    assert.ok(atRank.stack.every((f: Msg) => f.line !== 86), JSON.stringify(atRank.stack));
    assert.deepEqual(atRank.stack.filter((f: Msg) => f.line === undefined).map((f: Msg) => f.name), ['<arrow>', '<module>']);
    // step to the rrf call and into the imported implementation
    for (let i = 0; i < 5 && (await d.ask({ type: 'debug', action: 'step', kind: 'over' }), (await d.paused()).line !== 34); i++);
    await d.ask({ type: 'debug', action: 'step', kind: 'into' });
    const inRrf = await d.paused();
    assert.equal(names(inRrf)[0], 'rrf');
    assert.match(file(inRrf.fileId) ?? '', /ranking\.ts$/);
    await d.ask({ type: 'debug', action: 'breakpoints', set: [] });
    await d.ask({ type: 'debug', action: 'continue' });
    const end = await d.next((m) => m.type === 'run.finished', 'run.finished');
    assert.equal(end.exitCode, 0);
    assert.ok(d.seen.some((m) => m.type === 'log' && String(m.text).startsWith('200 ')), 'the client got its answer');
  } finally {
    d.close();
  }
});

function mcp() {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', BIN, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'], cwd: CHECKOUT });
  const lines: string[] = [];
  const waiting: ((l: string) => void)[] = [];
  createInterface({ input: child.stdout }).on('line', (l) => {
    const w = waiting.shift();
    if (w) w(l);
    else lines.push(l);
  });
  let id = 0;
  const next = () => new Promise<string>((r) => (lines.length ? r(lines.shift()!) : waiting.push(r)));
  return {
    async tool(name: string, args: Msg): Promise<string> {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
      const reply = JSON.parse(await next());
      assert.equal(reply.id, id);
      const text = reply.result.content.map((c: Msg) => c.text).join('\n') as string;
      assert.ok(!reply.result.isError, `${name} ${JSON.stringify(args)}: ${text}`);
      return text;
    },
    async init(): Promise<void> {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'scenarios', version: '0' } } }) + '\n');
      await next();
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    },
    close: () => child.stdin.end(),
  };
}

/** The first step on FILE:LINE in a recording, read off `steps`' `#N` column. */
async function firstStep(s: ReturnType<typeof mcp>, run: string, line: string): Promise<number> {
  const text = await s.tool('tracelight_map', { action: 'steps', run, line });
  const m = text.match(/^#(\d+)\s/m);
  assert.ok(m, text);
  return Number(m[1]);
}

test('over MCP recordings: implementation, provenance, handoff and a real-path contrast', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tl-scenarios-')));
  const s = mcp();
  try {
    await s.init();
    const de = join(dir, 'de.json');
    const us = join(dir, 'us.json');
    assert.match(await s.tool('tracelight_run', { file: join(CHECKOUT, 'main.ts'), save: de, args: ['--country', 'de'] }), /exit 0/);
    assert.match(await s.tool('tracelight_run', { file: join(CHECKOUT, 'main.ts'), save: us, args: ['--country', 'us'] }), /exit 0/);

    // actual implementation: into the call the source types as PaymentGateway
    const call = await firstStep(s, de, 'checkout.ts:46');
    const into = await s.tool('tracelight_step', { run: de, step: call, move: 'into' });
    assert.match(into, /^stack: charge payments\.ts:\d+ #\d+ ← placeOrder checkout\.ts:46/m);
    assert.match(into, /this = InvoiceGateway \{ dueDays: 14 \}/);

    // value provenance: the consumer's value back to the producer's inputs
    const why = await s.tool('tracelight_value', { action: 'why', run: de, step: call, name: 'total' });
    for (const link of ['total = 153.47', 'subtotal = 128.97', 'discount = 0', 'taxRate = 0.19']) assert.ok(why.includes(link), `${link} in\n${why}`);

    // async handoff: the receipt handler's recorded stack starts at the setImmediate callback
    const handler = await firstStep(s, de, 'main.ts:25');
    const ctx = await s.tool('tracelight_step', { run: de, step: handler });
    const stack = ctx.match(/^stack: .*$/m)?.[0] ?? '';
    assert.match(stack, /^stack: sendReceipt main\.ts:\d+ #\d+ ← flush events\.ts/);
    assert.ok(!stack.includes('placeOrder'), stack);
    const publish = await firstStep(s, de, 'checkout.ts:48');
    assert.ok(publish < handler, `publish #${publish} before handler #${handler}`);
    // no verb prints it, but the run file keeps who scheduled the callback the event loop entered
    const scopes: Msg[] = JSON.parse(readFileSync(de, 'utf8')).events.filter((e: Msg) => e.type === 'trace' && !e.partial).at(-1).scopes;
    const byId = new Map(scopes.map((sc) => [sc.scopeId, sc]));
    const entered = scopes.find((sc) => sc.name === '<arrow>' && sc.parent === 0 && sc.asyncParent !== undefined);
    assert.ok(entered, 'an event-loop callback with asyncParent');
    assert.equal(byId.get(byId.get(entered.asyncParent)?.parent)?.name, 'publish');

    // contrast: same entry and cart, one changed condition; the input differs first, then the branch
    const diff = await s.tool('tracelight_map', { action: 'diff', before: us, after: de });
    assert.match(diff, /the first at main\.ts:30/);
    assert.match(diff, /gatewayFor\s+if \(country === 'de' \|\| country === 'nl'\)[^\n]*\n\s+took false → true/);
    assert.match(diff, /call CardGateway\.charge\(amount=138, currency='USD'\)\s+only in a/);
    assert.match(diff, /call InvoiceGateway\.charge\(amount=153\.47, currency='EUR'\)\s+only in b/);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
