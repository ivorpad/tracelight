import { bootMonaco, monaco, READONLY_OPTIONS, applyTheme } from '../webview/monaco';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution';
import 'monaco-editor/esm/vs/language/typescript/monaco.contribution';
import 'monaco-editor/esm/vs/editor/contrib/gotoSymbol/browser/goToCommands';
import 'monaco-editor/esm/vs/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition';
import 'monaco-editor/esm/vs/editor/contrib/contextmenu/browser/contextmenu';
import './theme.css';
import './web.css';
import { configureLanguageService } from './languageService';
import { DEFINITION_DOCUMENT, openDefinitionTab, type DefinitionDocument } from './definitionTab';

function error(message: string): void {
  const element = document.getElementById('source-error')!;
  element.textContent = message;
  element.hidden = false;
}

try {
  const source: DefinitionDocument = JSON.parse(sessionStorage.getItem(DEFINITION_DOCUMENT) ?? 'null');
  if (!source || typeof source.path !== 'string' || typeof source.content !== 'string') throw new Error('Open a definition from the Tracelight code editor.');
  bootMonaco();
  configureLanguageService();
  const light = matchMedia('(prefers-color-scheme: light)').matches;
  document.body.classList.toggle('light', light);
  applyTheme(light ? 'light' : 'dark');
  const name = source.path.split(/[\\/]/).pop()!;
  document.title = `${name} · Library source · Tracelight`;
  const label = document.getElementById('source-path')!;
  label.textContent = name;
  label.title = source.path;
  const model = monaco.editor.createModel(source.content, /\.[cm]?tsx?$/.test(source.path) ? 'typescript' : 'javascript', monaco.Uri.file(source.path));
  const editor = monaco.editor.create(document.getElementById('source-editor')!, {
    ...READONLY_OPTIONS, model, lineNumbers: 'on', fontSize: 13, lineHeight: 20,
    minimap: { enabled: false }, gotoLocation: { multipleDefinitions: 'goto' },
  });
  editor.setPosition({ lineNumber: source.line, column: source.column });
  editor.revealLineInCenter(source.line);
  editor.focus();
  monaco.editor.registerEditorOpener({ openCodeEditor: (origin, resource, selection) => {
    if (origin !== editor || resource.scheme !== 'file') return false;
    const line = selection ? 'startLineNumber' in selection ? selection.startLineNumber : selection.lineNumber : 1;
    const column = selection ? 'startColumn' in selection ? selection.startColumn : selection.column : 1;
    try { openDefinitionTab(resource.fsPath, line, column); } catch (e) { error(String(e)); }
    return true;
  } });
} catch (e) { error(e instanceof Error ? e.message : String(e)); }
