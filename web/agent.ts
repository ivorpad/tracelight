/**
 * What an agent can do with the page: read where the Time Machine is, move it, and explain a line
 * in a bubble under it. The same commands arrive three ways: from the bridge's HTTP API (and the
 * `ctl` subcommand that calls it), and as WebMCP tools for an agent working in the browser itself.
 */
import type { AgentCommand, PageState } from './bridgeProtocol';
import type { Link, PageHost } from './pageHost';
import { renderValueNode } from '../src/views/valueText';

export async function runAgentCommand(host: PageHost, link: Link, cmd: AgentCommand): Promise<unknown> {
  if (cmd.action === 'waitPause') {
    const event = await host.waitForPause(cmd.after, cmd.timeoutMs);
    return { ...event, ...(event.changed ? { state: debugSummary(host), source: host.pauseSource() } : {}) };
  }
  if (cmd.action !== 'state' && cmd.action !== 'say' && cmd.action !== 'clear' && cmd.action !== 'values' && cmd.action !== 'peek' && cmd.action !== 'inspect' && cmd.action !== 'debug' && cmd.action !== 'breakpoint' && cmd.action !== 'profile' && cmd.action !== 'scratchpad') await host.idle();
  switch (cmd.action) {
    case 'state':
      return host.state();
    case 'goto':
      if (!host.nav.active) host.start({ step: cmd.step });
      else host.goto(cmd.step);
      return afterMove(host, cmd.say);
    case 'step': {
      let moved = true;
      if (!host.nav.active) host.start();
      else if (cmd.kind === 'next') {
        moved = !!host.trace?.valid(host.nav.step + 1);
        if (moved) host.goto(host.nav.step + 1);
      } else moved = host.move(cmd.kind);
      if (!moved) return { moved, state: host.state() };
      return { moved, state: await afterMove(host, cmd.say) };
    }
    case 'line': {
      if (!host.trace) throw new Error('nothing recorded yet: the run has no trace');
      const fileId = host.shownFileId() ?? host.mainFileId();
      if (fileId === undefined) throw new Error('the shown file is not part of the run');
      if (!host.nav.active) {
        host.start({ line: cmd.line });
      } else {
        const t = host.trace;
        const next = t.runToLine(host.nav.step, fileId, cmd.line);
        host.goto(next >= 0 ? next : t.startStep(fileId, cmd.line));
      }
      return afterMove(host, cmd.say);
    }
    case 'say':
      if (cmd.step !== undefined) {
        if (!host.nav.active) host.start({ step: cmd.step });
        else host.goto(cmd.step);
      }
      host.say(cmd.text, cmd.line, { file: cmd.file, noteId: cmd.noteId, kind: cmd.kind });
      return host.state();
    case 'clear':
      host.say(null, undefined, { noteId: cmd.noteId });
      return host.state();
    case 'values':
      return host.presentValues(cmd);
    case 'inspect':
      return host.inspectValue(cmd.name, cmd.open, cmd.names);
    case 'peek':
      return host.peekValue(cmd.name);
    case 'start':
      host.start();
      return host.state();
    case 'stop':
      host.stop();
      return host.state();
    case 'run':
      host.rerun();
      await new Promise((r) => setTimeout(r, 50));
      await host.idle();
      return host.state();
    case 'eval': {
      // at a pause of the live debugger the paused frame answers, as `tracelight eval --live` does
      if (host.debug.paused) return { text: (await host.debug.evaluateAtPause(cmd.expression)).text, at: host.debug.state()?.location };
      const runId = host.run?.runId;
      if (!runId) throw new Error('no run yet');
      const reply = await link.request({ type: 'evaluate', runId, expression: cmd.expression });
      if (reply.type === 'evaluated') return { text: reply.text };
      throw new Error(reply.type === 'error' ? reply.message : `unexpected reply ${reply.type}`);
    }
    case 'var': {
      const history = await host.panes.variableHistory(cmd.name);
      if (!history) throw new Error('nothing recorded yet: the run has no trace');
      // the Variable History view shows the same answer to the person watching
      void host.panes.queryVariable(cmd.name);
      return { name: history.name, changes: history.changes.map((c) => ({ step: c.step, line: c.line, function: c.function, file: host.displayPath(c.fileId), source: c.source, ...(c.text !== undefined ? { text: c.text } : {}) })) };
    }
    case 'why': {
      const step = cmd.step ?? (host.nav.active ? host.nav.step : undefined);
      if (step === undefined) throw new Error('name a step, or start the Time Machine first');
      const tree = await host.panes.provenance(step, cmd.name);
      if (!tree) throw new Error('nothing recorded yet: the run has no trace');
      void host.panes.queryWhy(step, cmd.name);
      return tree;
    }
    case 'watch': {
      if (cmd.remove) {
        const w = host.panes.watches.find((x) => x.exp === cmd.exp.trim());
        if (w) host.panes.removeWatch(w.id);
      } else {
        if (!host.nav.active) host.start();
        host.panes.addWatch(cmd.exp);
        await new Promise((r) => setTimeout(r, 50));
        await host.idle();
      }
      const step = host.nav.active ? host.nav.step : -1;
      return { step, watches: host.panes.watchRows(step).map((w) => ({ exp: w.exp, ...(w.valueBag ? { value: renderValueNode(w.valueBag.data) } : {}), ...(w.text !== undefined ? { text: w.text } : {}), ...(w.error ? { error: w.error } : {}), ...(w.step !== undefined ? { at: w.step } : {}) })) };
    }
    case 'breakpoint': {
      const path = cmd.file ? host.resolvePresentationFile(cmd.file) : host.main?.path;
      if (!path) throw new Error('no file yet');
      const on = host.debug.setBreakpoint(path, cmd.line, cmd.on, cmd.condition);
      return { file: path, line: cmd.line, on, breakpoints: host.debug.specs().map((b) => ({ file: b.path, line: b.line, ...(b.condition ? { condition: b.condition } : {}) })) };
    }
    case 'debug':
      return debugCommand(host, cmd);
    case 'scratchpad':
      if (!host.onScratchpad) throw new Error('Scratchpad is unavailable');
      await host.onScratchpad(cmd.open, cmd.line);
      return { open: cmd.open, liveExecutionChanged: false };
    case 'story': {
      if (!(await host.openStory())) throw new Error('no recorded run to tell: run the file first');
      return host.storyText();
    }
    case 'profile': {
      const p = await host.profileRun();
      if (p.error || !p.summary) throw new Error(p.error ?? 'no profile');
      return { path: p.path, totalMs: p.summary.totalMs, rows: p.summary.rows.slice(0, 20) };
    }
  }
}

/** The live debugger as an agent drives it: each move waits for the next pause (or the end). */
async function debugCommand(host: PageHost, cmd: Extract<AgentCommand, { action: 'debug' }>): Promise<unknown> {
  const d = host.debug;
  const wait = (): Promise<void> => d.nextStop();
  switch (cmd.op) {
    case 'restart':
    case 'start': {
      // the new run's first stop (a breakpoint, or the first statement when none can hit) or its end
      const before = d.run?.runId;
      const waiting = new Promise<void>((resolve) => {
        const t = setInterval(() => {
          if (d.run && d.run.runId !== before && (d.paused || !d.run.running)) {
            clearInterval(t);
            resolve();
          }
        }, 30);
        setTimeout(() => {
          clearInterval(t);
          resolve();
        }, 10_000);
      });
      d.start(cmd.op === 'restart' ? d.run?.content : undefined);
      await waiting;
      break;
    }
    case 'continue':
    case 'step':
    case 'pause': {
      const stop = wait();
      await d.control(cmd.op === 'continue' ? 'continue' : cmd.op === 'pause' ? 'pause' : cmd.kind === 'over' ? 'stepOver' : cmd.kind === 'out' ? 'stepOut' : 'stepInto');
      await stop;
      break;
    }
    case 'stop':
      d.stop();
      await new Promise((r) => setTimeout(r, 100));
      break;
    case 'state':
      break;
  }
  // the locals of a new pause arrive just after it
  for (let i = 0; i < 20 && d.paused && d.locals?.step !== d.paused.step; i++) await new Promise((r) => setTimeout(r, 25));
  if (cmd.say !== undefined && d.paused?.line) host.say(cmd.say, d.paused.line);
  return debugSummary(host);
}

export function debugSummary(host: PageHost): unknown {
  const s = host.debug.state();
  if (!s) return { running: false };
  return { running: s.running, paused: s.paused, reason: s.reasonText, location: s.location,
    runId: host.debug.run?.runId, step: host.debug.paused?.step, frame: host.debug.selectedFrame,
    source: host.pauseSource(),
    stack: s.stack.map((f) => ({ name: f.name, file: f.file, line: f.line })),
    locals: s.locals.map((v) => ({ name: v.name, text: v.text, ...(v.valueBag ? { valueBag: v.valueBag } : {}) })),
    output: s.output.map((c) => c.text).join('').slice(-2000) };
}

function afterMove(host: PageHost, say: string | undefined): PageState {
  if (say !== undefined) host.say(say);
  else if (host.narration) host.say(null);
  return host.state();
}

/* ---------- WebMCP ---------- */

interface WebMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>;
}

interface ModelContext {
  registerTool?: (tool: WebMcpTool) => unknown;
  provideContext?: (ctx: { tools: WebMcpTool[] }) => unknown;
}

const SAY = { type: 'string', description: 'Optional explanation to show in a bubble under the new line, for the person watching' };

/** The tools, as WebMCP declares them. Exported for tests. */
export function webMcpTools(host: PageHost, link: Link): WebMcpTool[] {
  const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[], toCommand: (input: Record<string, unknown>) => AgentCommand): WebMcpTool => ({
    name,
    description,
    inputSchema: { type: 'object', properties, required },
    execute: async (input) => {
      try {
        const result = await runAgentCommand(host, link, toCommand(input ?? {}));
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    },
  });
  return [
    tool('tracelight_scratchpad', 'Open an editable TypeScript scratchpad from the current source function and captured paused inputs, or close it. Auto run executes only the scratch copy in an isolated worker. Local helpers and project imports resolve from this file. External effects require explicit mocks. Never steps or evaluates in the live debugger.', { open: { type: 'boolean' }, line: { type: 'integer', minimum: 1 } }, ['open'], i => ({ action: 'scratchpad', open: i['open'] === true, ...(typeof i['line'] === 'number' ? { line: i['line'] } : {}) })),
    tool('tracelight_wait_pause', 'Wait for a new live debugger pause caused by manual Step, Step into, Step over, Step out or Continue. Call without after to obtain the current cursor, then wait with after equal to the previous cursor. Returns nearby source, stack, pause provenance and captured structured value bags together after locals and the editor are ready. Use these values directly for explanation without extra inspect, peek or evaluate calls; preserve capped/unavailable markers. Re-arm after explaining each changed pause. Does not step, evaluate, or open an overlay. Event-driven within an active agent session; cannot wake an idle chat. Timeout is at most 25000 ms.', { after: { type: 'integer', minimum: 0 }, timeoutMs: { type: 'integer', minimum: 0, maximum: 25000 } }, [], i => ({ action: 'waitPause', ...(typeof i['after'] === 'number' ? { after: i['after'] } : {}), ...(typeof i['timeoutMs'] === 'number' ? { timeoutMs: i['timeoutMs'] } : {}) })),
    tool('tracelight_state', 'Where the Time Machine is in the recorded run: file, line, function, the source line, variables, call stack, logged values, output and errors.', {}, [], () => ({ action: 'state' })),
    tool('tracelight_goto', 'Move the Time Machine to a recorded step (0-based) and show it in the code pane.', { step: { type: 'integer', minimum: 0 }, say: SAY }, ['step'], (i) => ({ action: 'goto', step: Number(i['step']), ...(typeof i['say'] === 'string' ? { say: i['say'] } : {}) })),
    tool('tracelight_step', 'Step the Time Machine like a debugger, forwards or backwards: next (one recorded event), into, over, out, back, backOver, backOut.', { kind: { type: 'string', enum: ['next', 'into', 'over', 'out', 'back', 'backOver', 'backOut'] }, say: SAY }, ['kind'], (i) => ({ action: 'step', kind: String(i['kind']) as Extract<AgentCommand, { action: 'step' }>['kind'], ...(typeof i['say'] === 'string' ? { say: i['say'] } : {}) })),
    tool('tracelight_line', 'Move the Time Machine to the next time a line of the shown file runs.', { line: { type: 'integer', minimum: 1 }, say: SAY }, ['line'], (i) => ({ action: 'line', line: Number(i['line']), ...(typeof i['say'] === 'string' ? { say: i['say'] } : {}) })),
    tool('tracelight_say', 'Add or update a labelled teaching note without editing or executing source. file anchors it across modules; noteId updates that note, kind distinguishes explanation from prediction. Empty text removes noteId, or all notes when omitted.', { text: { type: 'string' }, line: { type: 'integer', minimum: 1 }, file: { type: 'string' }, noteId: { type: 'string' }, kind: { type: 'string', enum: ['explanation', 'prediction'] } }, ['text'], (i) => (String(i['text'] ?? '') === '' ? { action: 'clear', ...(typeof i['noteId'] === 'string' ? { noteId: i['noteId'] } : {}) } : { action: 'say', text: String(i['text']), ...(typeof i['line'] === 'number' ? { line: i['line'] } : {}), ...(typeof i['file'] === 'string' ? { file: i['file'] } : {}), ...(typeof i['noteId'] === 'string' ? { noteId: i['noteId'] } : {}), ...(typeof i['kind'] === 'string' ? { kind: i['kind'] as 'explanation' | 'prediction' } : {}) })),
    tool('tracelight_values', 'Select existing bindings to emphasize beside source at the live pause. selected shows names, all restores automatic values, none hides them. Optional file must match the selected frame; line anchors the selected values there. Reads only supplied locals, never evaluates expressions or changes program state. Returns actual observed values with run/step/frame provenance.', { mode: { type: 'string', enum: ['selected', 'all', 'none'] }, names: { type: 'array', items: { type: 'string' } }, file: { type: 'string' }, line: { type: 'integer', minimum: 1 } }, ['mode'], (i) => ({ action: 'values', mode: i['mode'] as 'selected' | 'all' | 'none', ...(Array.isArray(i['names']) ? { names: i['names'] as string[] } : {}), ...(typeof i['file'] === 'string' ? { file: i['file'] } : {}), ...(typeof i['line'] === 'number' ? { line: i['line'] } : {}) })),
    tool('tracelight_peek', 'Show the syntax-highlighted hover for a binding or its serialized property in the current paused frame. Reads the captured value without evaluating an expression. An empty name dismisses the hover.', { name: { type: 'string' } }, ['name'], i => ({ action: 'peek', name: String(i['name'] ?? '') })),
    tool('tracelight_inspect', 'Display a focused value card under the live paused line. Send all relevant captured binding names together in names in ONE call: at a call boundary include its actual arguments and relevant derived inputs. This replaces the card selection atomically. Expand only the fields being taught. Legacy name adds one binding. open=false closes the selected bindings. Function details show runtime source/location when captured, not an inferred callback identity. Never evaluates an expression, advances execution, or populates future results. Confirm visibility before explaining. The card clears when the pause changes.', { names: { type: 'array', items: { type: 'string' }, minItems: 1 }, name: { type: 'string' }, open: { type: 'boolean' } }, ['open'], i => ({ action: 'inspect', name: String(i['name'] ?? ''), ...(Array.isArray(i['names']) ? { names: i['names'] as string[] } : {}), open: i['open'] === true })),
    tool('tracelight_start', 'Start navigating the recorded run at its beginning.', {}, [], () => ({ action: 'start' })),
    tool('tracelight_stop', 'Stop navigating the recorded run.', {}, [], () => ({ action: 'stop' })),
    tool('tracelight_run', 'Run the file again and wait for it to finish; returns the new state.', {}, [], () => ({ action: 'run' })),
    tool('tracelight_eval', 'Evaluate an expression. While the live debugger is paused it runs in the paused frame and sees its variables; otherwise it is evaluated side-effect-free against the finished run (no statement is re-run).',{ expression: { type: 'string' } }, ['expression'], (i) => ({ action: 'eval', expression: String(i['expression'] ?? '') })),
    tool('tracelight_var', 'Every recorded change of a variable in the run: step, line, function and value. Also opens the Variable History view.', { name: { type: 'string' } }, ['name'], (i) => ({ action: 'var', name: String(i['name'] ?? '') })),
    tool('tracelight_why', 'Why a variable had its value after a step (default: the Time Machine step): the statements and values it came from. An empty name explains the statement.', { name: { type: 'string' }, step: { type: 'integer', minimum: 0 } }, ['name'], (i) => ({ action: 'why', name: String(i['name'] ?? ''), ...(typeof i['step'] === 'number' ? { step: i['step'] } : {}) })),
    tool('tracelight_watch', 'Add a Time Machine watch expression (remove: true drops it); returns every watch value at the current step.', { exp: { type: 'string' }, remove: { type: 'boolean' } }, ['exp'], (i) => ({ action: 'watch', exp: String(i['exp'] ?? ''), ...(i['remove'] === true ? { remove: true } : {}) })),
    tool('tracelight_breakpoint', 'Set, clear or toggle a live breakpoint in the main file or a known imported source file.', { line: { type: 'integer', minimum: 1 }, file: { type: 'string' }, on: { type: 'boolean' }, condition: { type: 'string' } }, ['line'], (i) => ({ action: 'breakpoint', line: Number(i['line']), ...(typeof i['file'] === 'string' ? { file: i['file'] } : {}), ...(typeof i['on'] === 'boolean' ? { on: i['on'] } : {}), ...(typeof i['condition'] === 'string' ? { condition: i['condition'] } : {}) })),
    tool('tracelight_story', 'Open the Code Story of the recorded run (every pass through a scope, in execution order) in the code pane; returns its text and the row of the Time Machine step.', {}, [], () => ({ action: 'story' })),
    tool('tracelight_profile', 'Run the file once under the runtime profiler and show the hottest functions (self and total ms) in the code pane.', {}, [], () => ({ action: 'profile' })),
    tool('tracelight_debug', 'Drive the live debugger and record that same execution for code history: start (runs to the first breakpoint, or pauses at the first statement when no breakpoint is set), restart, continue, step (into/over/out), pause, stop, state. Returns where it paused, the stack and the variables.', { op: { type: 'string', enum: ['start', 'restart', 'continue', 'step', 'pause', 'stop', 'state'] }, kind: { type: 'string', enum: ['into', 'over', 'out'] }, say: SAY }, ['op'], (i) => ({ action: 'debug', op: String(i['op']) as Extract<AgentCommand, { action: 'debug' }>['op'], ...(typeof i['kind'] === 'string' ? { kind: i['kind'] as 'into' | 'over' | 'out' } : {}), ...(typeof i['say'] === 'string' ? { say: i['say'] } : {}) })),
  ];
}

/** Prefer the current document API, retaining support for older browser previews. */
export function registerWebMcp(host: PageHost, link: Link): boolean {
  const mc = (typeof document !== 'undefined' ? (document as Document & { modelContext?: ModelContext }).modelContext : undefined)
    ?? (typeof navigator !== 'undefined' ? (navigator as Navigator & { modelContext?: ModelContext }).modelContext : undefined);
  if (!mc) return false;
  const tools = webMcpTools(host, link);
  try {
    if (typeof mc.registerTool === 'function') for (const t of tools) mc.registerTool(t);
    else if (typeof mc.provideContext === 'function') mc.provideContext({ tools });
    else return false;
    return true;
  } catch (err) {
    console.warn('[tracelight] WebMCP registration failed', err);
    return false;
  }
}
