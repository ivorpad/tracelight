// End-to-end: the Tracelight extension on its own in a real VS Code. It activates on a .js and a
// .ts file, runs each to completion (values, no hang in "running"), and the plain VS Code debugger
// (F5 with a `tracelight` launch config) stops at a gutter breakpoint, shows the frame, steps and
// runs to the end. E2E_EXTENSION picks the extension under test (default ivor.tracelight).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const EXT_ID = process.env.E2E_EXTENSION || 'ivor.tracelight';
const BRAND = EXT_ID.split('.')[1];
const FIXTURES = path.resolve(__dirname, 'fixtures');

async function waitFor(pred, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${typeof what === 'function' ? what() : what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** DAP events of every debug session, as the tracker sees them */
const events = [];
vscode.debug.registerDebugAdapterTrackerFactory('*', {
  createDebugAdapterTracker: () => ({ onDidSendMessage: (m) => { if (m.type === 'event') events.push(m); } }),
});
const nextStop = (after) => waitFor(() => events.slice(after).find((e) => e.event === 'stopped'), 'a stopped event');
const terminated = (after) => waitFor(() => events.slice(after).find((e) => e.event === 'terminated'), 'the debug session to end', 30_000);

async function topFrame(ds, threadId) {
  const st = await ds.customRequest('stackTrace', { threadId, startFrame: 0, levels: 20 });
  return st.stackFrames[0];
}

async function localsOf(ds, frameId) {
  const { scopes } = await ds.customRequest('scopes', { frameId });
  const out = {};
  for (const sc of scopes) {
    const { variables } = await ds.customRequest('variables', { variablesReference: sc.variablesReference });
    for (const v of variables) out[v.name] ??= v.value;
  }
  return out;
}

for (const c of [
  { file: 'tl_target.js', bpLine: 3, fn: 'add', local: 'sum', expect: '10', output: /totals 10,11,12/, loop: [7, 9] },
  { file: 'tl_target.ts', bpLine: 5, fn: 'total', local: 'amount', expect: '10', output: /grand 17/, loop: [10, 12] },
]) {
  describe(`${EXT_ID} on ${c.file}`, function () {
    this.timeout(180_000);
    let ext, api, doc, file;

    before(async () => {
      const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
      file = path.join(root, `_e2e_${c.file}`);
      fs.writeFileSync(file, fs.readFileSync(path.join(FIXTURES, c.file), 'utf8'));
      doc = await vscode.workspace.openTextDocument(file);
      await vscode.window.showTextDocument(doc);
      ext = vscode.extensions.getExtension(EXT_ID);
      assert.ok(ext, `${EXT_ID} is installed`);
      // opening the file must be what starts the extension, not a test calling activate()
      await waitFor(() => ext.isActive, `${EXT_ID} to activate on ${doc.languageId}`);
      api = ext.exports;
      assert.ok(api && api.manager, 'activate returned the API');
    });

    after(async () => {
      await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
      api?.manager.stopAll();
      fs.rmSync(file, { force: true });
    });

    it('runs the file to the end with values', async () => {
      await vscode.commands.executeCommand(`${BRAND}.startOnCurrentFile`);
      const session = await waitFor(() => api.manager.sessionForDocument(doc), 'a session');
      await api.waitForIdle(session, 60_000);
      const st = session.state;
      assert.equal(st.errors.length, 0, `errors: ${JSON.stringify(st.errors.map((e) => e.message))}`);
      const text = st.entries.map((e) => e.text ?? JSON.stringify(e)).join('\n');
      assert.match(text, c.output, `output was: ${text.slice(0, 500)}`);
      assert.ok(st.trace && st.trace.count > 5, `trace steps: ${st.trace && st.trace.count}`);
    });

    it('stops at a breakpoint under F5, shows the frame, steps and runs to the end', async () => {
      api.manager.stopAll();
      const bp = new vscode.SourceBreakpoint(new vscode.Location(doc.uri, new vscode.Position(c.bpLine - 1, 0)));
      vscode.debug.addBreakpoints([bp]);
      const mark = events.length;
      const ok = await vscode.debug.startDebugging(vscode.workspace.workspaceFolders[0], {
        type: BRAND, request: 'launch', name: `e2e ${c.file}`, program: file,
      });
      assert.ok(ok, 'startDebugging accepted the launch config');
      const ds = await waitFor(() => vscode.debug.activeDebugSession, 'an active debug session');
      assert.equal(ds.type, BRAND);

      let stop = await nextStop(mark);
      let frame = await topFrame(ds, stop.body.threadId);
      // a launch may pause on entry first; continue to the breakpoint
      if (frame.line !== c.bpLine) {
        const m = events.length;
        await ds.customRequest('continue', { threadId: stop.body.threadId });
        stop = await nextStop(m);
        frame = await topFrame(ds, stop.body.threadId);
      }
      assert.equal(frame.line, c.bpLine, `paused at line ${frame.line}`);
      assert.equal(frame.name, c.fn);
      assert.equal(path.basename(frame.source.path), path.basename(file));
      const locals = await localsOf(ds, frame.id);
      assert.equal(String(locals[c.local]), c.expect, `locals: ${JSON.stringify(locals)}`);

      // step out of the function back to the loop
      let m = events.length;
      await ds.customRequest('stepOut', { threadId: stop.body.threadId });
      stop = await nextStop(m);
      frame = await topFrame(ds, stop.body.threadId);
      // back in the loop that called it
      assert.notEqual(frame.name, c.fn, `still in ${c.fn} after step out (line ${frame.line})`);
      assert.ok(frame.line >= c.loop[0] && frame.line <= c.loop[1], `after step out at line ${frame.line}`);

      // drop the breakpoint and run to the end
      await vscode.debug.removeBreakpoints([bp]);
      m = events.length;
      await ds.customRequest('continue', { threadId: stop.body.threadId });
      await terminated(m);
      const out = events.slice(mark).filter((e) => e.event === 'output').map((e) => e.body.output).join('');
      assert.match(out, c.output, `debug console: ${out.slice(0, 500)}`);
    });
  });
}

// Recorded evidence through the real extension host, including failures absorbed by a promise combinator.
describe('investigation evidence in the editor', function () {
  this.timeout(180_000);
  let api, file, doc, session;
  before(async () => {
    file = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '_e2e_investigation.mjs');
    fs.writeFileSync(file, [
      'async function rejected() { await Promise.resolve(); throw new Error("absorbed fixture"); }',
      'function change() {',
      '  const state = { total: 1 };',
      '  const alias = state;',
      '  alias.total = 3;',
      '  const total = state.total;',
      '  return total;',
      '}',
      'const total = change();',
      'const settled = await Promise.allSettled([rejected()]);',
      'console.log(total, settled[0].status);',
    ].join('\n'));
    doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    api = vscode.extensions.getExtension(EXT_ID).exports;
    await vscode.commands.executeCommand(`${BRAND}.startOnCurrentFile`);
    session = await waitFor(() => api.manager.sessionForDocument(doc), 'an investigation session');
    await api.waitForIdle(session, 60_000);
    await vscode.commands.executeCommand(`${BRAND}.recordForInvestigation`);
    await api.waitForIdle(session, 60_000);
  });
  after(() => { api?.manager.stopAll(); fs.rmSync(file, { force: true }); });
  it('shows alias mutations and their provenance without rerunning', async () => {
    const history = await api.variableHistory(session, 'state');
    const last = history.changes.at(-1);
    assert.match(last.text, /total: 3/);
    assert.equal(last.line, 5);
    const why = await api.provenance(session, last.step, 'state');
    assert.ok(why);
    assert.ok(JSON.stringify(why).includes('total: 3'));
    assert.ok(api.graph(session));
  });
  it('surfaces absorbed async failures and opens populated Code Story', async () => {
    const report = api.exceptions(session);
    assert.ok(report.rows.some(r => r.kind === 'caught' && r.message === 'absorbed fixture'));
    await vscode.commands.executeCommand(`${BRAND}.viewCodeStory`);
    const editor = await waitFor(() => vscode.window.visibleTextEditors.find(editor => editor.document.uri.scheme === 'tracelight-code-timeline'), 'Code Story');
    assert.match(editor.document.getText(), /alias\.total = 3/);
    await waitFor(() => api.storyValues(editor).length > 0, () => `Code Story values: ${JSON.stringify({ entries: session.state.entries.map(e => ({ text: e.text, step: e.step, rid: e.rid })), mode: vscode.workspace.getConfiguration('tracelight').get('story.values'), count: session.trace.count, content: editor.document.getText().slice(-1500) })}`, 5000);
  });
});
