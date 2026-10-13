import { readFileSync } from 'node:fs';
import type { TextDocument } from 'vscode';

/** A disk reload is clean and matches disk. An edit can arrive before VS Code marks it dirty. */
export function isDiskReload(doc: TextDocument): boolean {
  if (doc.uri.scheme !== 'file' || doc.isDirty) return false;
  try {
    // VS Code removes the UTF-8 BOM when opening a document.
    return readFileSync(doc.uri.fsPath, 'utf8').replace(/^\uFEFF/, '') === doc.getText();
  } catch {
    return false;
  }
}
