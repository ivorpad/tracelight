import * as vscode from 'vscode';
import type { SessionManager } from '../session/sessionManager';

/**
 * `tracelight.showInstrumentedFile`: the runtime's instrumented source in an untitled editor.
 * The active editor's file when the last run instrumented it (a project or library module),
 * otherwise the session's main file. Library files are fetched from the runner on demand.
 */
export async function showInstrumentedFile(manager: SessionManager): Promise<void> {
  const s = manager.active();
  if (!s) return;
  const editor = vscode.window.activeTextEditor;
  const fileId = (editor ? s.fileIdForDocument(editor.document) : undefined) ?? s.mainFileId();
  let src: string | undefined;
  try {
    src = fileId === undefined ? undefined : await s.instrumentedSource(fileId);
  } catch (err) {
    void vscode.window.showErrorMessage(`Tracelight: could not get the instrumented source: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!src) {
    void vscode.window.showInformationMessage('Tracelight: no instrumented source is available yet (run the file first).');
    return;
  }
  // the instrumented code is in the session's own language
  const doc = await vscode.workspace.openTextDocument({ language: 'javascript', content: src });
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
}
