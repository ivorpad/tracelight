import { describe, expect, it } from 'vitest';
import { LOG_PATH, PageHost, PROFILE_PATH, type CodeDecorations, type CodeView, type Link } from '../../web/pageHost';
import { STORY_PATH } from '../../web/story';
import { runAgentCommand, webMcpTools } from '../../web/agent';
import { packSteps } from '../../src/timeMachine/traceModel';
import type { BridgeFile, BridgeToPage, PageToBridge, RequestBody } from '../../web/bridgeProtocol';
import type { HostToWebview } from '../../src/shared/webviewProtocol';
import type { RunEvent, RunnerMessage, StatementBinding } from '../../src/shared/protocol';
import type { TourDoc } from '../../src/session/tourTypes';

const SOURCE = ['def add(a, b):', '    s = a + b', '    return s', '', 'x = add(1, 2)', 'print(x)'].join('\n');
const MAIN: BridgeFile = { path: '/w/demo.py', displayName: 'demo.py', language: 'python', content: SOURCE };

class FakeCode implements CodeView {
  inspectValue(name: string, open: boolean) {
    if (!this.last?.liveValues?.locals.some(v => v.name === name)) throw new Error('hidden binding');
    return { name, open, visible: true };
  }
  shown: string | undefined;
  last: CodeDecorations | undefined;
  narration: { text: string; line: number } | null = null;
  revealed: number[] = [];
  cursor: number | undefined;
  languageFiles = new Map<string, BridgeFile>();
  cacheFile(file: BridgeFile): void { this.languageFiles.set(file.path, file); }
  files = new Map<string, BridgeFile>();
  showFile(file: BridgeFile): void {
    this.shown = file.path;
    this.files.set(file.path, file);
  }
  setMain(file: BridgeFile): void {
    this.showFile(file);
  }
  shownPath(): string | undefined {
    return this.shown;
  }
  render(d: CodeDecorations): void {
    this.last = d;
  }
  reveal(line: number): void {
    this.revealed.push(line);
  }
  setNarration(n: { text: string; line: number } | null): void {
    this.narration = n;
  }
  cursorLine(): number | undefined {
    return this.cursor;
  }
}

class FakeLink implements Link {
  sent: PageToBridge[] = [];
  replies: RunnerMessage[] = [];
  send(msg: PageToBridge): void {
    this.sent.push(msg);
  }
  requests: RequestBody[] = [];
  debugRequests: RequestBody[] = [];
  request(body: RequestBody): Promise<RunnerMessage> {
    this.requests.push(body);
    return Promise.resolve(this.replies.shift() ?? { type: 'error', id: 0, message: 'none' });
  }
  debugRequest(body: RequestBody): Promise<RunnerMessage> {
    this.debugRequests.push(body);
    return Promise.resolve(this.replies.shift() ?? { type: 'error', id: 0, message: 'none' });
  }
}

function b64(steps: Int32Array): string {
  return Buffer.from(steps.buffer).toString('base64');
}

/** A run of SOURCE: module (rids 0..), add's def header, its body, the print. */
function runEvents(runId: string): RunEvent[] {
  // local ranges: 0 whole file, 1 def, 2 `s = a + b`, 3 `return s`, 4 `x = add(1, 2)`, 5 `print(x)`
  const ranges: [number, number, number, number][] = [[1, 0, 6, 8], [1, 0, 3, 12], [2, 4, 2, 13], [3, 4, 3, 12], [5, 0, 5, 13], [6, 0, 6, 8]];
  const steps = packSteps([[1, 0, 0], [4, 0, 0], [1, 1, 1, 4], [2, 1, 1], [3, 1, 1], [5, 0, 0]]);
  let seq = 0;
  const base = { runId };
  return [
    { ...base, seq: ++seq, type: 'run.started', pid: 1 },
    { ...base, seq: ++seq, type: 'file.instrumented', fileId: 1, path: MAIN.path, rangeBase: 0, ranges, statements: [1, 2, 3, 4, 5], functions: [{ rid: 1, name: 'add', bodyRange: [2, 4, 3, 12] }], magic: [] },
    { ...base, seq: ++seq, type: 'log', logId: 'l1', kind: 'log', fileId: 1, rid: 5, hit: 1, step: 5, text: '3', runtimeKey: 'k5' },
    { ...base, seq: ++seq, type: 'coverage', fileId: 1, states: [1, 1, 1, 1, 1, 1], hits: [1, 1, 1, 1, 1, 1] },
    { ...base, seq: ++seq, type: 'locals', entries: [{ step: 2, scopeId: 1, changes: [{ name: 'a', text: '1' }, { name: 'b', text: '2' }] }, { step: 4, scopeId: 1, changes: [{ name: 's', text: '3' }] }] },
    { ...base, seq: ++seq, type: 'trace', steps: b64(steps), scopes: [{ scopeId: 0, rid: 0, name: '<module>', parent: -1, depth: 0, first: 0, last: 5 }, { scopeId: 1, rid: 1, name: 'add', parent: 0, depth: 1, first: 2, last: 4, returned: '3' }], truncated: false },
    { ...base, seq: ++seq, type: 'run.finished', exitCode: 0, durationMs: 5, timedOut: false, stopped: false, stepCount: 6, logCount: 1 },
  ];
}

function setup() {
  const code = new FakeCode();
  const link = new FakeLink();
  const panel: HostToWebview[] = [];
  const host = new PageHost(link, code, (m) => panel.push(m));
  const feed = (m: BridgeToPage) => host.onBridge(m);
  feed({ type: 'hello', file: MAIN, runtime: { command: 'fake', ready: null }, watch: true, canNarrate: false });
  host.onPanel({ type: 'ready' });
  feed({ type: 'run.begin', runId: 'w-1', content: SOURCE, reason: 'start' });
  for (const ev of runEvents('w-1')) feed({ type: 'event', event: ev });
  return { code, link, panel, host, feed };
}

describe('PageHost', () => {
  it('loads discovered dependency sources for language checking without navigating to them', () => {
    const { feed, code, link } = setup();
    const dependency = { ...(runEvents('w-1')[1] as Extract<RunEvent, { type: 'file.instrumented' }>), seq: 20, fileId: 2, path: '/w/worker.ts' };
    feed({ type: 'event', event: dependency });
    feed({ type: 'event', event: { ...dependency, seq: 21 } });
    expect(link.sent.filter(m => m.type === 'file.read' && m.path === dependency.path)).toHaveLength(1);
    const file = { path: dependency.path, displayName: 'worker.ts', language: 'typescript', content: 'export const n = 2;' };
    feed({ type: 'file', file });
    expect(code.languageFiles.get(file.path)).toEqual(file);
    expect(code.shown).toBe(MAIN.path);
    expect(code.files.has(file.path)).toBe(false);
    feed({ type: 'debug.begin', runId: 'd-dependencies', content: SOURCE });
    feed({ type: 'debug.event', event: { ...dependency, runId: 'd-dependencies', seq: 1 } });
    expect(link.sent.filter(m => m.type === 'file.read' && m.path === dependency.path)).toHaveLength(1);
  });

  it('ignores locals and expansions arriving after a frame change or resume', async () => {
    const { host, link, feed } = setup();
    feed({ type: 'debug.begin', runId: 'd-race', content: SOURCE });
    feed({ type: 'debug.event', event: runEvents('d-race')[1]! });
    const pending: ((reply: RunnerMessage) => void)[] = [];
    link.debugRequest = () => new Promise((resolve) => pending.push(resolve));
    feed({ type: 'debug.event', event: { runId: 'd-race', seq: 3, type: 'debug.paused', step: 3, rid: 2, fileId: 1, line: 2, scopeId: 1, depth: 1, reason: 'step', stack: [{ name: 'add', fileId: 1, line: 2 }, { name: '<module>', fileId: 1, line: 5 }] } });
    const selection = host.debug.selectFrame(1);
    expect(host.debug.locals).toBeNull();
    pending[1]!({ type: 'debug.result', id: 1, locals: [{ name: 'x', text: 'caller' }] });
    await selection;
    pending[0]!({ type: 'debug.result', id: 2, locals: [{ name: 'a', text: 'stale callee' }] });
    await tick();
    expect(host.debug.state()?.locals).toEqual([{ name: 'x', text: 'caller' }]);
    const node = { id: 'd:1', type: 'object', queryPath: [], expandable: true };
    const expansion = host.debug.expandNode(node);
    feed({ type: 'debug.event', event: { runId: 'd-race', seq: 4, type: 'debug.resumed', step: 3, action: 'continue' } });
    pending[2]!({ type: 'value', id: 3, node: { ...node, value: 'old value' } });
    expect(await expansion).toBeNull();
    expect(host.debug.state()?.locals).toEqual([]);
  });

  it('uses the selected debug file and local function ranges, excluding the module wrapper', async () => {
    const { host, link, feed, code } = setup();
    feed({ type: 'debug.begin', runId: 'd-files', content: SOURCE });
    feed({ type: 'debug.event', event: { type: 'file.instrumented', runId: 'd-files', seq: 1, fileId: 2, path: '/w/worker.ts', rangeBase: 100, ranges: [[1, 0, 9, 0], [1, 0, 8, 1]], statements: [1], functions: [{ rid: 0, name: '<module>', bodyRange: [1, 0, 9, 0] }, { rid: 1, name: 'processNext', bodyRange: [1, 0, 8, 1] }], magic: [] } });
    link.replies.push({ type: 'debug.result', id: 1, locals: [{ name: 'queue', text: '[1, 2, 3]' }] });
    feed({ type: 'debug.event', event: { type: 'debug.paused', runId: 'd-files', seq: 2, step: 4, rid: 101, fileId: 2, line: 4, scopeId: 1, depth: 1, reason: 'step', stack: [{ name: 'processNext', fileId: 2, line: 4 }] } });
    feed({ type: 'file', file: { path: '/w/worker.ts', displayName: 'worker.ts', language: 'typescript', content: 'function processNext(queue) {\n\n\n queue.shift();\n}' } });
    await tick();
    host.render();
    expect(code.shown).toBe('/w/worker.ts');
    expect(code.last?.paused).toBe(4);
    expect(code.last?.liveValues).toMatchObject({ start: 1, end: 8, excluded: [], locals: [{ name: 'queue', text: '[1, 2, 3]' }] });
  });

  it('feeds the panel what the extension would: init, entries, timeline, walkthrough, exceptions', () => {
    const { panel } = setup();
    const types = panel.map((m) => m.type);
    expect(types[0]).toBe('init');
    expect(types).toContain('timeline');
    expect(types).toContain('walkthrough');
    expect(types).toContain('exceptions');
    const appended = panel.filter((m): m is Extract<HostToWebview, { type: 'entries.append' }> => m.type === 'entries.append').flatMap((m) => m.entries);
    expect(appended).toEqual([expect.objectContaining({ logId: 'l1', file: 'demo.py', line: 6, text: '3' })]);
    const timeline = panel.find((m): m is Extract<HostToWebview, { type: 'timeline' }> => m.type === 'timeline' && m.model !== null);
    expect(timeline?.model?.stepCount).toBe(6);
    expect(timeline?.model?.lines).toEqual([1, 5, 1, 2, 3, 6]);
  });

  it('draws values and coverage in the code pane', () => {
    const { code } = setup();
    expect(code.last?.inline.get(6)).toBe('3');
    expect(code.last?.coverage.get(2)).toBe(1);
    expect(code.last?.current).toBeNull();
  });

  it('steps the Time Machine like the toolbar and reports where it is', () => {
    const { host, code, panel } = setup();
    expect(host.start({ line: 2 })).toBe(true);
    expect(host.nav.step).toBe(3);
    expect(code.last?.current).toEqual({ line: 2, col: 4 });
    expect(code.last?.callers).toEqual([5]);
    const st = host.state();
    expect(st).toMatchObject({ timeMachine: true, step: 3, location: { file: 'demo.py', line: 2, function: 'add' }, code: '    s = a + b' });
    expect(st.locals).toEqual([{ name: 'a', text: '1' }, { name: 'b', text: '2' }]);
    expect(st.stack.map((f) => f.function)).toEqual(['add', '<module>']);
    // the log on line 6 has not happened yet at step 3
    expect(st.values).toEqual([]);
    // the variables a step records were changed by the statement before it, so they show on that line
    expect(host.move('into')).toBe(true);
    expect(code.last?.inline.get(2)).toBe('s = 3');
    expect(host.move('back')).toBe(true);
    expect(host.move('out')).toBe(true);
    expect(host.state().location?.line).toBe(6);
    expect(host.move('back')).toBe(true);
    expect(host.state().locals).toEqual([{ name: 'a', text: '1' }, { name: 'b', text: '2' }, { name: 's', text: '3' }]);
    const dbg = panel.filter((m): m is Extract<HostToWebview, { type: 'debugger' }> => m.type === 'debugger').pop();
    expect(dbg?.state).toMatchObject({ active: true, currentStep: 4 });
    host.stop();
    expect(host.state().timeMachine).toBe(false);
  });

  it('keeps the Time Machine step across a re-run', () => {
    const { host, feed } = setup();
    host.start({ step: 4 });
    feed({ type: 'run.begin', runId: 'w-2', content: SOURCE, reason: 'disk' });
    for (const ev of runEvents('w-2')) feed({ type: 'event', event: ev });
    expect(host.state()).toMatchObject({ runId: 'w-2', timeMachine: true, step: 4 });
  });

  it('answers agent commands: move with a narration, say, eval', async () => {
    const { host, link, code } = setup();
    const moved = (await runAgentCommand(host, link, { action: 'goto', step: 2, say: 'add is called with 1 and 2' })) as { location: { line: number } };
    expect(moved.location.line).toBe(1);
    expect(code.narration).toEqual({ text: 'add is called with 1 and 2', line: 1 });
    const stepped = (await runAgentCommand(host, link, { action: 'step', kind: 'over' })) as { moved: boolean; state: { step: number; narration: unknown } };
    expect(stepped).toMatchObject({ moved: true, state: { step: 3, narration: null } });
    await runAgentCommand(host, link, { action: 'line', line: 6, say: 'prints 3' });
    expect(host.state()).toMatchObject({ step: 5, narration: { text: 'prints 3', line: 6 } });
    link.replies.push({ type: 'evaluated', id: 1, text: '3', valueBag: { runtimeKey: 'e', data: { type: 'number', value: '3', id: 'v', queryPath: [] } } });
    expect(await runAgentCommand(host, link, { action: 'eval', expression: 'x' })).toEqual({ text: '3' });
  });

  it('declares WebMCP tools that run the same commands', async () => {
    const { host, link } = setup();
    const tools = webMcpTools(host, link);
    expect(tools.map((t) => t.name)).toEqual(['tracelight_state', 'tracelight_goto', 'tracelight_step', 'tracelight_line', 'tracelight_say', 'tracelight_values', 'tracelight_inspect', 'tracelight_run', 'tracelight_eval', 'tracelight_var', 'tracelight_why', 'tracelight_watch', 'tracelight_breakpoint', 'tracelight_story', 'tracelight_profile', 'tracelight_debug']);
    const step = tools.find((t) => t.name === 'tracelight_step')!;
    const out = await step.execute({ kind: 'into' });
    expect(JSON.parse(out.content[0]!.text)).toMatchObject({ moved: true });
    const bad = await tools.find((t) => t.name === 'tracelight_line')!.execute({ line: 2 });
    expect(bad.isError).toBeUndefined();
  });

  it('turns panel settings into a run config change for the bridge', () => {
    const { host, link } = setup();
    host.onPanel({ type: 'settings.update', patch: { runTimeoutMs: 5000, valuePeek: false }, scope: 'session' });
    expect(link.sent).toContainEqual({ type: 'config', patch: { timeoutMs: 5000 } });
  });
});

/** What each statement of SOURCE assigns and reads, as the runtime's `bindings` answers. */
const BINDINGS: StatementBinding[] = [
  { line: 1, col: 0, assigns: ['add'], reads: [] },
  { line: 2, col: 4, assigns: ['s'], reads: ['a', 'b'] },
  { line: 3, col: 4, assigns: [], reads: ['s'] },
  { line: 5, col: 0, assigns: ['x'], reads: ['add'] },
  { line: 6, col: 0, assigns: [], reads: ['print', 'x'] },
] as StatementBinding[];

const tick = () => new Promise((r) => setTimeout(r, 0));
const last = <T extends HostToWebview['type']>(panel: HostToWebview[], type: T) => panel.filter((m): m is Extract<HostToWebview, { type: T }> => m.type === type).pop();

describe('PageHost views', () => {
  it('answers the Variable History view from the recorded locals and the bindings', async () => {
    const { host, link, panel } = setup();
    link.replies.push({ type: 'bindings', id: 1, statements: BINDINGS });
    host.onPanel({ type: 'variable.query', name: 's' });
    for (let i = 0; i < 5; i++) await tick();
    expect(link.requests[0]).toEqual({ type: 'bindings', source: SOURCE });
    const view = last(panel, 'variable')!.view;
    expect(view.name).toBe('s');
    expect(view.history?.changes).toEqual([expect.objectContaining({ step: 3, line: 2, function: 'add', file: 'demo.py', text: '3' })]);
  });

  it('builds the Execution Diagram on request and follows the Time Machine', async () => {
    const { host, panel } = setup();
    host.onPanel({ type: 'executionGraph.request' });
    const graph = last(panel, 'executionGraph')!.graph!;
    expect(graph.runId).toBe('w-1');
    expect(graph.nodes.length).toBeGreaterThan(1);
    host.start({ step: 3 });
    await new Promise((r) => setTimeout(r, 80));
    const stack = last(panel, 'executionGraph.stack')!;
    expect(stack.step).toBe(3);
    expect(stack.stack.length).toBeGreaterThan(0);
  });

  it('sends the HTTP table of the run, and compares two entries', () => {
    const { host, panel } = setup();
    expect(last(panel, 'http')!.panel).toMatchObject({ runId: 'w-1', count: 0, requests: [] });
    host.onPanel({ type: 'compare', leftLogId: 'l1', rightLogId: 'l1' });
    expect(last(panel, 'diff')).toEqual({ type: 'diff', left: { title: 'demo.py:6', text: '3' }, right: { title: 'demo.py:6', text: '3' } });
    expect(last(panel, 'showView')).toEqual({ type: 'showView', view: 'diff' });
  });

  it('records a watch around the Time Machine step with one run, and shows its value', () => {
    const { host, link, panel, feed } = setup();
    host.start({ step: 3 });
    host.onPanel({ type: 'watch.add', exp: 'a + b' });
    const run = link.sent.filter((m) => m.type === 'run').pop() as Extract<typeof link.sent[number], { type: 'run' }>;
    expect(run.watch).toEqual([{ id: expect.any(String), exp: 'a + b' }]);
    expect(run.traceContext).toEqual({ step: 3, prefetch: 10 });
    const id = run.watch![0]!.id;
    feed({ type: 'run.begin', runId: 'w-2', content: SOURCE, reason: 'page' });
    const events = runEvents('w-2');
    events.splice(events.length - 1, 0, { runId: 'w-2', seq: 99, type: 'watch', watchId: id, step: 3, valueBag: { runtimeKey: 'w', data: { type: 'number', value: '3', id: 'w1', queryPath: [] } } });
    for (const ev of events) feed({ type: 'event', event: ev });
    const rows = last(panel, 'debugger')!.state.watches;
    expect(rows).toEqual([expect.objectContaining({ exp: 'a + b', step: 3, valueBag: expect.objectContaining({ runtimeKey: 'w' }) })]);
  });

  it('narrates through the bridge and shows the glosses in the walkthrough', () => {
    const { host, link, panel, feed } = setup();
    host.onPanel({ type: 'narrate' });
    expect(link.sent).toContainEqual({ type: 'narrate' });
    expect(last(panel, 'walkthrough')!.walkthrough!.narrating).toBe(true);
    feed({ type: 'narration', narration: { runId: 'w-1', narrating: false, glosses: { m0: 'the module starts' } } });
    const w = last(panel, 'walkthrough')!.walkthrough!;
    expect(w.narrating).toBe(false);
    expect(w.moments.find((m) => m.id === 'm0')?.gloss).toBe('the module starts');
  });

  it('asks the bridge for the tour when the section opens and draws it', () => {
    const { host, link, panel, feed } = setup();
    host.onPanel({ type: 'tour.open', open: true });
    expect(link.sent).toContainEqual({ type: 'tour', action: 'compute' });
    const doc: TourDoc = {
      tour: 1,
      run: { file: MAIN.path, steps: 6, exitCode: 0, durationMs: 5, http: 0, llm: 0 },
      goal: { kind: 'output', step: 5, text: 'prints 3' },
      small: true,
      budget: { tokens: 0, estimate: 0, found: 1, kept: 1, dropped: 0 },
      chapters: [{ id: 'c1', title: 'add', steps: [0, 5], llm: 0, http: 0 } as TourDoc['chapters'][number]],
      candidates: [{ id: 's1', key: 'k', step: 4, chapter: 'c1', file: 'demo.py', line: 3, function: 'add', scopeId: 1, statement: 'return s', signals: [{ signal: 'call:return' }], values: [{ id: 'v1', role: 'returned', name: 'add', length: 1, text: '3' }] } as unknown as TourDoc['candidates'][number]],
    };
    feed({ type: 'tour', tour: { runId: 'w-1', status: 'ready', doc, narrating: false } });
    const tour = last(panel, 'tour')!.tour!;
    expect(tour).toMatchObject({ status: 'ready', steps: 6, chapters: [expect.objectContaining({ id: 'c1', stops: 1 })] });
    expect(tour.stops[0]).toMatchObject({ id: 's1', fileId: 1, short: 'add = 3' });
    host.onPanel({ type: 'tour.goto', step: 4, stopId: 's1' });
    expect(host.state().step).toBe(4);
  });

  it('runs the live debugger: breakpoints from the gutter, the pause, its variables', async () => {
    const { host, link, panel, feed, code } = setup();
    expect(host.debug.setBreakpoint(MAIN.path, 2)).toBe(true);
    host.render();
    expect([...(code.last?.breakpoints.keys() ?? [])]).toEqual([2]);
    host.onPanel({ type: 'command', command: 'tracelight.debugCurrentFile' });
    expect(link.sent).toContainEqual({ type: 'debug.start', breakpoints: [{ path: MAIN.path, line: 2 }], exceptions: 'uncaught', stopOnEntry: false });
    feed({ type: 'debug.begin', runId: 'd-1', content: SOURCE });
    const [, file] = runEvents('d-1');
    feed({ type: 'debug.event', event: file! });
    link.replies.push({ type: 'debug.result', id: 1, locals: [{ name: 'a', text: '1' }, { name: 'b', text: '2' }] });
    feed({ type: 'debug.event', event: { runId: 'd-1', seq: 3, type: 'debug.paused', step: 3, rid: 2, fileId: 1, line: 2, scopeId: 1, depth: 1, reason: 'breakpoint', breakpoint: { path: MAIN.path, line: 2 }, stack: [{ frameId: 0, name: 'add', fileId: 1, line: 2 }, { frameId: 1, name: '<module>', fileId: 1, line: 5 }] } });
    for (let i = 0; i < 5; i++) await tick();
    expect(link.debugRequests[0]).toEqual({ type: 'debug', runId: 'd-1', action: 'locals' });
    const st = last(panel, 'debug.session')!.state!;
    expect(st).toMatchObject({ paused: true, reasonText: 'breakpoint', location: 'demo.py:2', stack: [{ name: 'add', file: 'demo.py', line: 2 }, { name: '<module>', file: 'demo.py', line: 5 }], locals: [{ name: 'a', text: '1' }, { name: 'b', text: '2' }] });
    host.render();
    expect(code.last?.paused).toBe(2);
    expect(code.last?.inline.size).toBe(0);
    expect(code.last?.coverage.size).toBe(0);
    expect(code.last?.liveValues?.locals).toEqual(st.locals);
    const requestCount = link.debugRequests.length;
    expect(await runAgentCommand(host, link, { action: 'values', mode: 'selected', names: ['a'], file: 'demo.py', line: 2 })).toMatchObject({ observed: { runId: 'd-1', step: 3, frame: 0, file: MAIN.path }, shown: [{ name: 'a', text: '1' }] });
    expect(code.last?.liveValues?.ghostNames).toEqual(['a']);
    expect(code.last?.liveValues?.locals).toEqual(st.locals); // unselected names still have accurate hovers
    expect(link.debugRequests.length).toBe(requestCount); // display never evaluates or mutates
    const inspect = webMcpTools(host, link).find(t => t.name === 'tracelight_inspect')!;
    const opened = await inspect.execute({ name: 'a', open: true });
    expect(JSON.parse(opened.content[0]!.text)).toMatchObject({ name: 'a', open: true, visible: true, observed: { runId: 'd-1', step: 3, frame: 0 } });
    expect(await runAgentCommand(host, link, { action: 'inspect', name: 'a', open: false })).toMatchObject({ name: 'a', open: false, visible: true });
    const badInspect = await inspect.execute({ name: 'a + b', open: true });
    expect(badInspect.isError).toBe(true);
    expect(link.debugRequests.length).toBe(requestCount);
    await expect(runAgentCommand(host, link, { action: 'values', mode: 'selected', names: ['a + b'] })).rejects.toThrow('not in the current paused frame');
    expect(panel).toContainEqual({ type: 'showView', view: 'debug' });
    feed({ type: 'debug.event', event: { runId: 'd-1', seq: 4, type: 'debug.resumed', step: 3, action: 'step', kind: 'over' } });
    host.render();
    expect(code.last?.liveValues).toBeUndefined();
    expect(code.last?.inline.size).toBe(0);
    // A resume removes live values but still hides the earlier recording until the run ends.
    feed({ type: 'debug.event', event: { runId: 'd-1', seq: 5, type: 'debug.paused', step: 4, rid: 3, fileId: 1, line: 3, scopeId: 1, depth: 1, reason: 'step', stack: [{ frameId: 0, name: 'add', fileId: 1, line: 3 }] } });
    link.replies.push({ type: 'debug.result', id: 2 });
    host.onPanel({ type: 'debug.control', action: 'stepOver' });
    await tick();
    expect(link.debugRequests).toContainEqual({ type: 'debug', runId: 'd-1', action: 'step', kind: 'over' });
    feed({ type: 'debug.end', runId: 'd-1' });
    expect(last(panel, 'debug.session')!.state).toMatchObject({ running: false, paused: false, reasonText: 'ended' });
    host.render();
    expect(code.last?.liveValues).toBeUndefined();
    expect(code.last?.inline.get(6)).toBe('3');
  });

  it('starts the live debugger at the first breakpoint, at the first statement only when none can hit', () => {
    const { host, link } = setup();
    const entries = () => link.sent.flatMap((m) => (m.type === 'debug.start' ? [m.stopOnEntry] : []));
    host.debug.start();
    // a file the recorded run never touched: that breakpoint cannot hit, so the run still stops somewhere
    host.debug.setBreakpoint('/w/lib.js', 4);
    host.debug.start();
    host.debug.setBreakpoint(MAIN.path, 2);
    host.debug.start();
    host.debug.start(undefined, true);
    expect(entries()).toEqual([true, true, false, true]);
  });

  it('evaluates an agent eval in the paused frame while the live debugger is paused', async () => {
    const { host, link, feed } = setup();
    host.debug.setBreakpoint(MAIN.path, 2);
    host.debug.start();
    feed({ type: 'debug.begin', runId: 'd-1', content: SOURCE });
    feed({ type: 'debug.event', event: runEvents('d-1')[1]! });
    link.replies.push({ type: 'debug.result', id: 1, locals: [{ name: 'a', text: '1' }, { name: 'b', text: '2' }] });
    feed({ type: 'debug.event', event: { runId: 'd-1', seq: 3, type: 'debug.paused', step: 3, rid: 2, fileId: 1, line: 2, scopeId: 1, depth: 1, reason: 'breakpoint', breakpoint: { path: MAIN.path, line: 2 }, stack: [{ frameId: 0, name: 'add', fileId: 1, line: 2 }, { frameId: 1, name: '<module>', fileId: 1, line: 5 }] } });
    for (let i = 0; i < 5; i++) await tick();
    link.replies.push({ type: 'evaluated', id: 2, text: '3', valueBag: { runtimeKey: 'e', data: { type: 'number', value: '3', id: 'v', queryPath: [] } } });
    expect(await runAgentCommand(host, link, { action: 'eval', expression: 'a + b' })).toEqual({ text: '3', at: 'demo.py:2' });
    expect(link.debugRequests.at(-1)).toEqual({ type: 'evaluate', runId: 'd-1', expression: 'a + b' });
    // the recorded run, where `a` is not in scope, is never asked
    expect(link.requests.filter((r) => r.type === 'evaluate')).toEqual([]);
    link.replies.push({ type: 'error', id: 3, message: 'ReferenceError: nope is not defined' });
    await expect(runAgentCommand(host, link, { action: 'eval', expression: 'nope' })).rejects.toThrow('ReferenceError: nope is not defined');
  });

  it('answers an agent debug start as soon as the run ends without pausing', async () => {
    const { host, link, feed } = setup();
    host.debug.setBreakpoint(MAIN.path, 2);
    const began = Date.now();
    const answer = runAgentCommand(host, link, { action: 'debug', op: 'start' });
    feed({ type: 'debug.begin', runId: 'd-1', content: SOURCE });
    feed({ type: 'debug.end', runId: 'd-1' });
    expect(await answer).toMatchObject({ running: false, paused: false });
    expect(Date.now() - began).toBeLessThan(2000);
  });

  it('answers the agent var, why and breakpoint commands', async () => {
    const { host, link } = setup();
    link.replies.push({ type: 'bindings', id: 1, statements: BINDINGS });
    const v = (await runAgentCommand(host, link, { action: 'var', name: 's' })) as { changes: { step: number; text: string }[] };
    expect(v.changes).toEqual([expect.objectContaining({ step: 3, line: 2, text: '3' })]);
    const why = (await runAgentCommand(host, link, { action: 'why', name: 's', step: 4 })) as { root: { name: string } };
    expect(why.root.name).toBe('s');
    expect(await runAgentCommand(host, link, { action: 'breakpoint', line: 3 })).toEqual({ line: 3, on: true, breakpoints: [{ line: 3 }] });
    expect(await runAgentCommand(host, link, { action: 'breakpoint', line: 3 })).toEqual({ line: 3, on: false, breakpoints: [] });
  });
});

describe('PageHost: the views VS Code opens as editors', () => {
  it('shows the Code Story in the code pane, following the Time Machine step', async () => {
    const { host, code } = setup();
    expect(await host.openStory()).toBe(true);
    expect(code.shown).toBe(STORY_PATH);
    const text = code.files.get(STORY_PATH)!.content;
    const rowOf = (needle: string) => text.split('\n').map((l) => l.includes(needle)).lastIndexOf(true) + 1;
    // the module's pass, the call's pass through add, then the module again
    expect(text).toContain('5  x = add(1, 2)');
    expect(text).toContain('2      s = a + b');
    host.goto(3);
    const d = code.last!;
    const row = rowOf('s = a + b');
    expect(d.box).toMatchObject({ line: row });
    expect(d.current?.line).toBe(row);
    // a row picked in the story moves the Time Machine to the step that ran it
    const printRow = rowOf('print(x)');
    host.linePick(STORY_PATH, printRow, 'select');
    expect(host.nav.step).toBe(5);
    expect(code.last!.inline.get(printRow)).toBe('3');
    // Ctrl/Cmd+click opens the source line; stopping the Time Machine closes the story (D2)
    host.linePick(STORY_PATH, printRow, 'open');
    expect(code.shown).toBe(MAIN.path);
    await host.openStory();
    host.stop();
    expect(code.shown).toBe(MAIN.path);
    expect(await runAgentCommand(host, new FakeLink(), { action: 'story' })).toMatchObject({ step: 0, row: expect.any(Number), text: expect.stringContaining('print(x)') });
  });

  it('asks the bridge for a profile and shows its table, rows opening their source', async () => {
    const { host, link, code, feed } = setup();
    host.onPanel({ type: 'command', command: 'tracelight.profile' });
    expect(link.sent).toContainEqual({ type: 'profile' });
    feed({ type: 'profile', profile: { path: '/tmp/p.cpuprofile', summary: { totalMs: 3, rows: [{ name: 'add', file: MAIN.path, line: 1, selfMs: 2, totalMs: 2.5, calls: 1 }] } } });
    expect(code.shown).toBe(PROFILE_PATH);
    expect(code.files.get(PROFILE_PATH)!.content).toMatch(/2\.00\s+2\.50\s+1 {2}add {2}demo\.py:1/);
    host.linePick(PROFILE_PATH, 3, 'open');
    expect(code.shown).toBe(MAIN.path);
  });

  it('shows the instrumented source, the logs, recent files, and honors the run mode', async () => {
    const { host, link, code, feed } = setup();
    link.replies.push({ type: 'source', id: 1, fileId: 1, instrumentedSource: '__pk.step(1)' });
    host.onPanel({ type: 'command', command: 'tracelight.showInstrumentedFile' });
    await tick();
    expect(link.requests).toContainEqual({ type: 'source', runId: 'w-1', fileId: 1 });
    expect(code.shown).toBe('tracelight://instrumented/demo.py');
    expect(code.files.get(code.shown!)!.content).toBe('__pk.step(1)');
    host.onPanel({ type: 'command', command: 'tracelight.showLogs' });
    expect(link.sent).toContainEqual({ type: 'file.read', path: LOG_PATH });
    host.onPanel({ type: 'command', command: 'tracelight.viewRecentFiles' });
    expect(link.sent).toContainEqual({ type: 'recent' });
    let listed: string[] = [];
    host.onRecent = (files) => (listed = files.map((f) => f.path));
    feed({ type: 'recent', files: [{ path: '/w/other.py', displayName: 'other.py', at: 1 }] });
    expect(listed).toEqual(['/w/other.py']);
    host.openFile('/w/other.py');
    expect(link.sent).toContainEqual({ type: 'open', path: '/w/other.py' });
    feed({ type: 'hello', file: { ...MAIN, path: '/w/other.py', displayName: 'other.py' }, runtime: { command: 'fake', ready: null }, watch: true, canNarrate: false });
    expect(host.main?.path).toBe('/w/other.py');
    host.onPanel({ type: 'settings.update', patch: { runMode: 'onDemand' }, scope: 'session' });
    expect(link.sent).toContainEqual({ type: 'runMode', mode: 'onDemand' });
  });
});
