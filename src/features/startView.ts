/**
 * Start View: welcome panel with the interactive demo.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import type { SessionManager } from '../session/sessionManager';
import { setting } from '../config/settings';
import { log } from '../util/log';

const SHOWN_KEY = 'tracelight.startViewShown.v1';

export class StartView implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: SessionManager,
  ) {}

  dispose(): void {
    this.panel?.dispose();
  }

  /** Shown once after the first activation unless `tracelight.showStartViewOnFeatureRelease` is off. */
  maybeShowOnFirstActivation(): void {
    if (!setting<boolean>('showStartViewOnFeatureRelease', true)) return;
    if (this.context.globalState.get<boolean>(SHOWN_KEY)) return;
    void this.context.globalState.update(SHOWN_KEY, true);
    this.show();
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('tracelight.startView', 'Tracelight', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] });
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'logo.png');
    panel.webview.html = this.html(panel.webview);
    panel.onDidDispose(() => {
      this.panel = undefined;
    });
    panel.webview.onDidReceiveMessage((msg: { type: string }) => void this.onMessage(msg).catch((err) => log.error('start view', err)));
  }

  private async onMessage(msg: { type: string }): Promise<void> {
    switch (msg.type) {
      case 'demo':
        await this.launchDemo();
        return;
      case 'newJsFile':
        await vscode.commands.executeCommand('tracelight.newJavaScriptFile');
        return;
      case 'newTsFile':
        await vscode.commands.executeCommand('tracelight.newTypeScriptFile');
        return;
      case 'node':
        await vscode.commands.executeCommand('tracelight.selectNode');
        return;
      case 'recent':
        await vscode.commands.executeCommand('tracelight.viewRecentFiles');
        return;
      case 'settings':
        await vscode.commands.executeCommand('workbench.action.openSettings', 'tracelight');
        return;
      default:
        return;
    }
  }

  /** The demo: `examples/demo.ts`, run on Node. */
  async launchDemo(): Promise<void> {
    const language = 'typescript';
    const rel = 'examples/demo.ts';
    const file = this.context.asAbsolutePath(rel);
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      void vscode.window.showErrorMessage(`Tracelight: ${rel} is missing from the extension.`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument({ language, content });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
    await this.manager.start(doc);
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const logo = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'logo.png'));
    const isMac = process.platform === 'darwin';
    const mod = isMac ? '⌘' : 'Ctrl';
    const rows: [string, string][] = [
      ['Start on the current file', `${mod}+K Q`],
      ['New JavaScript file', `${mod}+K J`],
      ['New file from snippet / recent', `${mod}+K L`],
      ['Show value of the selection', `${mod}+K V`],
      ['Copy value', `${mod}+K X`],
      ['Start Time Machine on this line', 'Shift+F5'],
      ['Step over / back over', 'F10 / Ctrl+F10'],
      ['Step into / back into', 'F11 / Ctrl+F11'],
      ['Step out / back out', 'Shift+F11 / Ctrl+Shift+F11'],
      ['Run to / back to the cursor line', 'F5 / Ctrl+F5'],
      ['Clear a value / all values', 'Esc / Esc Esc'],
    ];
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>Tracelight</title>
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 24px 32px; max-width: 880px; margin: 0 auto; }
  header { display: flex; align-items: center; gap: 16px; margin-bottom: 8px; }
  header img { width: 56px; height: 56px; }
  h1 { font-size: 26px; margin: 0; }
  .sub { opacity: .8; margin: 0 0 20px; }
  .actions { display: flex; flex-wrap: wrap; gap: 10px; margin: 18px 0 26px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 8px 14px; border-radius: 3px; cursor: pointer; font-size: 13px; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:hover { filter: brightness(1.1); }
  h2 { font-size: 15px; margin: 22px 0 8px; }
  table { border-collapse: collapse; width: 100%; }
  td { padding: 5px 8px; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.25)); }
  td:last-child { text-align: right; font-family: var(--vscode-editor-font-family); white-space: nowrap; }
  code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
  .card { border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.25)); border-radius: 6px; padding: 12px 14px; }
  .card b { display: block; margin-bottom: 4px; }
  p { line-height: 1.45; }
</style></head>
<body>
${intro(String(logo))}
<h2>Keyboard shortcuts</h2>
<table>${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table>
<p class="sub">In Cursor, every <code>${mod}+K</code> chord is also available as <code>Ctrl+Alt+P</code> + letter.</p>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const bind = (id, type) => document.getElementById(id).addEventListener('click', () => vscode.postMessage({ type }));
  for (const [id, type] of [['demo', 'demo'], ['newJs', 'newJsFile'], ['newTs', 'newTsFile'], ['node', 'node'], ['recent', 'recent'], ['settings', 'settings']]) {
    document.getElementById(id)?.addEventListener('click', () => vscode.postMessage({ type }));
  }
</script>
</body></html>`;
  }
}

/** The welcome: JavaScript and TypeScript on Node. */
const intro = (logo: string): string => `<header><img src="${logo}" alt=""><div><h1>Welcome to Tracelight</h1><p class="sub">A live JavaScript and TypeScript scratchpad: values next to your code as you type, coverage in the gutter, and a Time Machine that steps backwards.</p></div></header>
<div class="actions">
  <button id="demo">🚀 Launch Interactive Demo</button>
  <button id="newJs" class="secondary">New JavaScript File</button>
  <button id="newTs" class="secondary">New TypeScript File</button>
  <button id="recent" class="secondary">Recent Files</button>
  <button id="node" class="secondary">Select Node.js</button>
  <button id="settings" class="secondary">Settings</button>
</div>
<div class="cards">
  <div class="card"><b>Live values</b>Type a variable name on its own line, use <code>console.log()</code>, or add <code>&nbsp;// ?</code> after any expression. <code>?.</code> times it, <code>?+</code> expands it.</div>
  <div class="card"><b>Time Machine</b>Press <code>Shift+F5</code> on any line. Step forwards and backwards; the panel shows the timeline, call stack and watches.</div>
  <div class="card"><b>Debugger</b>Press <code>F5</code> with a breakpoint set: the program runs at full speed and stops there with the frame live.</div>
  <div class="card"><b>Requirements</b>Node.js 22.18 or newer (<code>tracelight.nodePath</code>, else <code>node</code> on PATH). The runtime ships inside the extension; nothing is installed into your project.</div>
</div>`;
