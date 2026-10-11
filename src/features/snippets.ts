/**
 * Tracelight snippets (~/.tracelight/tracelight.code-snippets), New File picker, New JavaScript / TypeScript
 * File. A snippet opens in the language its `scope` names (or its code reads as).
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SessionManager } from '../session/sessionManager';
import type { RecentFilesView } from './recentFiles';
import { ensureDir, tracelightHome, readJsonFile, writeJsonFile } from '../util/paths';
import { isRunnable, languageIdFor } from '../runtime/language';

export interface TracelightSnippet {
  name: string;
  prefix: string[];
  body: string[];
  description?: string;
  /** VS Code's snippet `scope`: the languages it is for (`typescript`, `javascript,typescript`) */
  scope?: string;
}

const STARTER = `// Tracelight snippets: pick one with "Tracelight: New File" (Cmd/Ctrl+K L).
// Same format as VS Code snippets; $TM_SELECTED_TEXT and $0 are supported.
{
  "Scratch with a class": {
    "prefix": "tracelight-class",
    "scope": "javascript,typescript",
    "body": [
      "class Point {",
      "  constructor(x, y) {",
      "    this.x = x;",
      "    this.y = y;",
      "  }",
      "}",
      "",
      "const p = new Point(1, 2);",
      "p; // ?",
      "$0"
    ],
    "description": "Class playground"
  },
  "Snap": {
    "prefix": "tracelight-snap",
    "scope": "javascript,typescript",
    "body": ["/*{{", "$0", "}}*/"],
    "description": "A Tracelight snap fence"
  }
}
`;

export const NEW_FILE_STARTER = `// Tracelight is running this file. Values appear next to your code as you type.
// Try:  const x = 42;  then type  x  on its own line, or add  // ?  after any expression.

`;

/** The starter text of a new untitled file in `language`. */
export function starterFor(_language: 'javascript' | 'typescript'): string {
  return NEW_FILE_STARTER;
}

export function snippetsFile(): string {
  return path.join(tracelightHome(), 'tracelight.code-snippets');
}

export function loadSnippets(): TracelightSnippet[] {
  const raw = readJsonFile<Record<string, { prefix?: string | string[]; body?: string | string[]; description?: string; scope?: string }>>(snippetsFile(), {});
  return Object.entries(raw).map(([name, s]) => ({
    name,
    prefix: Array.isArray(s.prefix) ? s.prefix : s.prefix ? [s.prefix] : [],
    body: Array.isArray(s.body) ? s.body : s.body ? [s.body] : [],
    description: s.description,
    ...(typeof s.scope === 'string' ? { scope: s.scope } : {}),
  }));
}

/** Strip snippet tab stops / placeholders so the body can be inserted as plain text. */
export function snippetBodyToText(body: string[]): string {
  return body
    .join('\n')
    .replace(/\$\{TM_SELECTED_TEXT[^}]*\}|\$TM_SELECTED_TEXT/g, '')
    .replace(/\$\{\d+:([^}]*)\}/g, '$1')
    .replace(/\$\{\d+\|([^|]*)\|\}/g, (_m, choices: string) => choices.split(',')[0] ?? '')
    .replace(/\$\{\d+\}|\$\d+/g, '')
    .replace(/\\\$/g, '$');
}

export class SnippetsFeature {
  constructor(
    private readonly manager: SessionManager,
    private readonly recent: RecentFilesView,
  ) {}

  async editSnippets(): Promise<void> {
    const file = snippetsFile();
    if (!fs.existsSync(file)) {
      ensureDir(path.dirname(file));
      fs.writeFileSync(file, STARTER, 'utf8');
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.languages.setTextDocumentLanguage(doc, 'jsonc');
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  async createSnippetFromSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode.window.showInformationMessage('Tracelight: select the code to turn into a snippet first.');
      return;
    }
    const name = await vscode.window.showInputBox({ prompt: 'Snippet name', ignoreFocusOut: true });
    if (!name) return;
    const prefix = await vscode.window.showInputBox({ prompt: 'Snippet prefix (typed to trigger it)', value: name.toLowerCase().replace(/\s+/g, '-'), ignoreFocusOut: true });
    if (prefix === undefined) return;
    const file = snippetsFile();
    const raw = readJsonFile<Record<string, unknown>>(file, {});
    const body = editor.document.getText(editor.selection).replace(/\$/g, '\\$').split(/\r?\n/);
    const lang = editor.document.languageId;
    raw[name] = { prefix: prefix || name, body, description: `Created from ${path.basename(editor.document.fileName)}`, scope: lang };
    writeJsonFile(file, raw);
    const pick = await vscode.window.showInformationMessage(`Tracelight snippet "${name}" saved.`, 'Open snippets file');
    if (pick) await this.editSnippets();
  }

  /** An empty JavaScript file. */
  async newDefaultFile(): Promise<void> {
    return this.newFile('javascript');
  }

  async newFile(language: 'javascript' | 'typescript'): Promise<void> {
    const doc = await vscode.workspace.openTextDocument({ language, content: starterFor(language) });
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const last = doc.lineCount - 1;
    editor.selection = new vscode.Selection(last, 0, last, 0);
    await this.manager.start(doc);
  }

  /** Cmd+K L: Tracelight snippets + recent files + an empty file. Snippets enable auto log. */
  async createFile(): Promise<void> {
    type Item = vscode.QuickPickItem & { action: () => Promise<void> };
    const items: Item[] = [];
    items.push({ label: '$(new-file) Empty JavaScript file', description: 'Untitled, Tracelight started', action: () => this.newFile('javascript') });
    items.push({ label: '$(new-file) Empty TypeScript file', description: 'Untitled, Tracelight started', action: () => this.newFile('typescript') });
    // only the JavaScript and TypeScript snippets
    const snippets = loadSnippets().filter((s) => isRunnable({ languageId: languageIdFor({ scope: s.scope, content: snippetBodyToText(s.body) }), fileName: '' }));
    if (snippets.length) items.push({ label: 'Tracelight snippets', kind: vscode.QuickPickItemKind.Separator, action: async () => undefined });
    for (const s of snippets) {
      items.push({
        label: `$(symbol-snippet) ${s.name}`,
        description: s.prefix.join(', '),
        detail: s.description,
        action: async () => {
          const content = snippetBodyToText(s.body);
          const doc = await vscode.workspace.openTextDocument({ language: languageIdFor({ scope: s.scope, content }), content });
          await vscode.window.showTextDocument(doc, { preview: false });
          await this.manager.start(doc, { autoLog: true });
        },
      });
    }
    const recent = this.manager.recentFiles.list().slice(0, 15);
    if (recent.length) items.push({ label: 'Recent files', kind: vscode.QuickPickItemKind.Separator, action: async () => undefined });
    for (const r of recent) {
      items.push({
        label: `$(history) ${r.name}`,
        description: new Date(r.timestamp).toLocaleString(),
        detail: r.path ?? '(untitled)',
        action: () => this.recent.run({ id: r.id }),
      });
    }
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => undefined });
    items.push({ label: '$(edit) Edit Tracelight snippets…', action: () => this.editSnippets() });
    items.push({ label: '$(list-unordered) View all recent files…', action: () => this.recent.show() });
    const pick = await vscode.window.showQuickPick(items, { title: 'Tracelight: New File', placeHolder: 'Pick a snippet or a recent file', matchOnDescription: true, matchOnDetail: true });
    if (pick) await pick.action();
  }
}
