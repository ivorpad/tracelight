/**
 * Quick package install for `Cannot find package/module`: hover, code action and the two
 * commands. Installs use the project's package manager
 * (`jsPackages.ts`); a per-file install goes to a private folder found through NODE_PATH.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Session } from '../session/session';
import type { SessionManager } from '../session/sessionManager';
import { ensureDir } from '../util/paths';
import { log } from '../util/log';
import { RUNNABLE_SELECTOR } from '../runtime/language';
import { buildJsInstallCommand, importLine, missingJsPackage, packageManagerFor } from './jsPackages';

/** The folder of the nearest package.json above the file (within the workspace), else the workspace or the file's folder. */
function projectDir(s: Session): string {
  const fileDir = s.document.uri.scheme === 'file' ? path.dirname(s.document.uri.fsPath) : undefined;
  if (!fileDir) return s.workspaceRoot || process.cwd();
  for (let d = fileDir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'package.json'))) return d;
    if (d === s.workspaceRoot || path.dirname(d) === d) break;
  }
  return s.workspaceRoot || fileDir;
}

export class PackageInstall implements vscode.HoverProvider, vscode.CodeActionProvider, vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly manager: SessionManager) {
    const selector: vscode.DocumentSelector = RUNNABLE_SELECTOR;
    this.disposables.push(
      vscode.languages.registerHoverProvider(selector, this),
      vscode.languages.registerCodeActionsProvider(selector, this, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  private missingAt(document: vscode.TextDocument, line: number): { session: Session; module: string } | undefined {
    const s = this.manager.sessionForDocument(document);
    if (!s || !s.missingModules.size) return undefined;
    const fileId = s.fileIdForDocument(document);
    for (const err of s.state.errors) {
      const js = missingJsPackage(err.message);
      if (!js) continue;
      const loc = s.locate(err.rid);
      const at = err.stack.find((f) => f.fileId === fileId)?.line;
      // an ES module import fails before any statement runs: no frame, so find the import in the text
      const errLine = at !== undefined ? at - 1 : importLine(document.getText(), js.specifier);
      if (errLine === line || (loc && loc.fileId === fileId && err.stack.length && line >= loc.range[0] - 1 && line <= loc.range[2] - 1)) return { session: s, module: js.packageName };
    }
    return undefined;
  }

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const hit = this.missingAt(document, position.line);
    if (!hit) return undefined;
    const pkg = hit.module;
    const args = encodeURIComponent(JSON.stringify({ package: pkg }));
    const md = new vscode.MarkdownString(`**Tracelight:** module \`${hit.module}\` is not installed.\n\n[$(package) Install ${pkg} into project](command:tracelight.installMissingPackageToProject?${args}) &nbsp;|&nbsp; [$(file) Install only for this Tracelight file](command:tracelight.installMissingPackageForFile?${args})`, true);
    md.isTrusted = true;
    return new vscode.Hover(md);
  }

  provideCodeActions(document: vscode.TextDocument, range: vscode.Range): vscode.CodeAction[] {
    const hit = this.missingAt(document, range.start.line);
    if (!hit) return [];
    const pkg = hit.module;
    const mk = (title: string, command: string): vscode.CodeAction => {
      const a = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
      a.command = { title, command, arguments: [{ package: pkg }] };
      a.isPreferred = command === 'tracelight.installMissingPackageToProject';
      return a;
    };
    return [mk(`Tracelight: install ${pkg} into project`, 'tracelight.installMissingPackageToProject'), mk(`Tracelight: install ${pkg} only for this Tracelight file`, 'tracelight.installMissingPackageForFile')];
  }

  private async pickPackage(session: Session, arg: unknown): Promise<string | undefined> {
    const fromArg = arg && typeof arg === 'object' ? (arg as { package?: string }).package : typeof arg === 'string' ? arg : undefined;
    if (fromArg) return fromArg;
    const missing = [...session.missingModules];
    if (missing.length === 1) return missing[0];
    if (missing.length > 1) {
      const pick = await vscode.window.showQuickPick(missing, { title: 'Tracelight: which package?' });
      return pick;
    }
    return vscode.window.showInputBox({ prompt: 'Package to install (npm name)', ignoreFocusOut: true });
  }

  async installToProject(arg?: unknown): Promise<void> {
    const s = this.manager.active();
    if (!s) return;
    const pkg = await this.pickPackage(s, arg);
    if (!pkg) return;
    const cmd = buildJsInstallCommand({ template: s.config.installPackageCommand, manager: packageManagerFor(projectDir(s), s.workspaceRoot || undefined), packageName: pkg });
    await this.runInTerminal(s, cmd, () => s.scheduleRun('install', 0));
  }

  async installForFile(arg?: unknown): Promise<void> {
    const s = this.manager.active();
    if (!s) return;
    const pkg = await this.pickPackage(s, arg);
    if (!pkg) return;
    const target = ensureDir(this.manager.forFileDataDir(s.document));
    const cmd = buildJsInstallCommand({ template: '', manager: 'npm', packageName: pkg, target });
    if (!s.extraModulePath.includes(target)) s.extraModulePath.push(target);
    await this.runInTerminal(s, cmd, () => s.scheduleRun('install', 0));
  }

  private async runInTerminal(session: Session, command: string, onDone: () => void): Promise<void> {
    log.info(`install: ${command}`);
    // an install runs where the file's package.json is, so the package lands in that project
    const terminal = vscode.window.createTerminal({ name: 'Tracelight install', cwd: projectDir(session) });
    terminal.show(true);
    // shell integration arrives shortly after creation; wait for it briefly
    const integration = await new Promise<vscode.TerminalShellIntegration | undefined>((resolve) => {
      if (terminal.shellIntegration) return resolve(terminal.shellIntegration);
      const t = setTimeout(() => {
        d.dispose();
        resolve(undefined);
      }, 3000);
      const d = vscode.window.onDidChangeTerminalShellIntegration((e) => {
        if (e.terminal === terminal) {
          clearTimeout(t);
          d.dispose();
          resolve(e.shellIntegration);
        }
      });
    });
    if (integration) {
      const execution = integration.executeCommand(command);
      const d = vscode.window.onDidEndTerminalShellExecution((e) => {
        if (e.execution !== execution) return;
        d.dispose();
        if (e.exitCode === 0) {
          session.missingModules.clear();
          onDone();
        } else void vscode.window.showWarningMessage(`Tracelight: install command exited with code ${e.exitCode ?? '?'}.`);
      });
    } else {
      terminal.sendText(command, true);
      const pick = await vscode.window.showInformationMessage('Tracelight: installing in the terminal. Re-execute the file when it finishes.', 'Re-execute now');
      if (pick) {
        session.missingModules.clear();
        onDone();
      }
    }
  }
}
