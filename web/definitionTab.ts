import { monaco } from '../webview/monaco';

export interface DefinitionDocument { path: string; content: string; line: number; column: number }
export const DEFINITION_DOCUMENT = 'tracelight.definition';

/** A source-only tab has no debugger connection and cannot change the caller's pause. */
export function openDefinitionTab(path: string, line: number, column: number): void {
  const model = monaco.editor.getModel(monaco.Uri.file(path));
  if (!model) throw new Error('Definition source is not loaded');
  const target = window.open('about:blank', '_blank');
  if (!target) throw new Error('Allow pop-ups for Tracelight to open the definition in a new tab.');
  try {
    // Store only in the new tab's session, so reload works without copying the live session.
    const document: DefinitionDocument = { path, content: model.getValue(), line, column };
    target.sessionStorage.setItem(DEFINITION_DOCUMENT, JSON.stringify(document));
    target.opener = null;
    target.location.replace(new URL('/web/source.html', location.href).href);
  } catch (error) { target.close(); throw error; }
}
