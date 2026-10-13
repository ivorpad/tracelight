import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import type { Session } from '../session/session';
import { sessionRecording, awaitIdle } from '../agent/bridgeSupport';

/** Commands use private copies of recorded evidence; only the explicit record/verify commands execute code. */
export function registerInvestigation(context: vscode.ExtensionContext, runtimeDir: string, active: () => Session | undefined): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-investigation-'));
  const baselines = new Map(Object.entries(context.workspaceState.get<Record<string, string>>('investigation.baselines', {})));
  const pinnedDir = path.join((context.storageUri ?? context.globalStorageUri).fsPath, 'baselines');
  let serial = 0;
  context.subscriptions.push({ dispose: () => fs.rmSync(dir, { recursive: true, force: true }) });
  async function snapshot(s: Session): Promise<string> {
    await awaitIdle(s);
    if (s.running && !s.debug.paused) throw new Error('Wait for the run to finish or pause it before inspecting.');
    const doc = sessionRecording(s);
    if (!doc) throw new Error('Record a run first. Use Record for Investigation.');
    Object.assign(doc.meta, { config: { ...s.config.run, recordLocals: s.recordLocals, http: s.http }, argv: s.config.argv });
    const file = path.join(dir, `run-${++serial}.json`);
    fs.writeFileSync(file, JSON.stringify(doc), { mode: 0o600 });
    return file;
  }
  function cli(s: Session, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => execFile(s.interpreter.path, [path.join(runtimeDir, 'bin', 'tracelight.mjs'), ...args],
      { timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error && !stdout) reject(new Error(stderr || error.message)); else resolve(stdout);
      }));
  }
  async function show(content: string): Promise<void> {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content, language: 'markdown' }), { preview: true });
  }
  const register = (name: string, action: (s: Session) => Promise<void>): void => {
    context.subscriptions.push(vscode.commands.registerCommand(`tracelight.${name}`, async () => {
      const s = active();
      if (!s) { void vscode.window.showInformationMessage('Start Tracelight on a file first.'); return; }
      try { await action(s); } catch (error) { void vscode.window.showErrorMessage(String(error instanceof Error ? error.message : error)); }
    }));
  };
  register('recordForInvestigation', async s => {
    if (s.debug.paused) throw new Error('The program is paused. Continue or stop it before recording a new run.');
    s.setRecordLocals(true);
    await s.runNow('investigation');
    void vscode.window.showInformationMessage('Run recorded with variable changes. Choose Investigate a Value or Learn from This Run.');
  });
  register('investigateValue', async s => {
    const name = await vscode.window.showInputBox({ prompt: 'Which value is wrong? Enter a variable or property path.', ignoreFocusOut: true });
    if (!name) return;
    const run = await snapshot(s);
    await show(await cli(s, ['investigate', run, '--value', name]));
  });
  register('learnRun', async s => {
    const run = await snapshot(s);
    const lesson = JSON.parse(await cli(s, ['learn', run, '--json']));
    const chosen = await vscode.window.showQuickPick(lesson.checkpoints.map((c: { step: number; kind: string; source: string }) => ({ label: `Step ${c.step}`, description: c.kind, detail: c.source, step: c.step })), { title: 'Choose a checkpoint to predict' }) as { step: number } | undefined;
    if (!chosen) return;
    const prediction = await vscode.window.showInputBox({ prompt: 'What value, branch or outcome do you expect at this checkpoint?', ignoreFocusOut: true });
    if (prediction === undefined) return;
    await show(await cli(s, ['learn', run, '--at', String(chosen.step), '--prediction', prediction, '--reveal']));
  });
  register('pinRun', async s => {
    const run = await snapshot(s);
    fs.mkdirSync(pinnedDir, { recursive: true, mode: 0o700 });
    const pinned = path.join(pinnedDir, createHash('sha256').update(s.filePath).digest('hex') + '.json');
    fs.writeFileSync(pinned, fs.readFileSync(run), { mode: 0o600 });
    baselines.set(s.filePath, pinned);
    await context.workspaceState.update('investigation.baselines', Object.fromEntries(baselines));
    void vscode.window.showInformationMessage('Baseline pinned for this file. Edit the code, then choose Verify Fix against Baseline.');
  });
  register('verifyFix', async s => {
    const baseline = baselines.get(s.filePath);
    if (!baseline) throw new Error('Pin the failing run first.');
    if (s.debug.paused) throw new Error('Continue or stop the paused program before running the fix.');
    const expected = await vscode.window.showInputBox({ prompt: 'Expected final value, NAME=TEXT (for example total=42). Leave empty to compare only.', ignoreFocusOut: true });
    if (expected === undefined) return;
    const originalHttp = s.http;
    const config = JSON.parse(fs.readFileSync(baseline, 'utf8')).meta.config;
    try {
      if (config?.http === 'record') s.setHttp('replay');
      s.setRecordLocals(true);
      await s.runNow('verify fix');
      const after = await snapshot(s);
      await show(await cli(s, ['verify', baseline, '--after', after, ...(expected ? ['--expect', expected] : [])]));
    } finally { s.setHttp(originalHttp); }
  });
}
