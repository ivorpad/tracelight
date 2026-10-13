import { monaco } from '../webview/monaco';

let configured = false;
export function configureLanguageService(): void {
  if (configured) return;
  configured = true;
  const ts = monaco.languages.typescript;
  for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) {
    defaults.setCompilerOptions({ target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.NodeJs, allowNonTsExtensions: true, allowImportingTsExtensions: true, noEmit: true, strict: true, allowJs: true, checkJs: true });
    defaults.setEagerModelSync(true);
    // One hover combines the captured value with static type information, in that order.
    defaults.setModeConfiguration({ ...defaults.modeConfiguration, hovers: false });
    defaults.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false });
  }
}

const sources = new Map<string, string>();
/** Supply real project sources even when their editor tabs have never been opened. */
export function registerLanguageSource(path: string, content: string): void {
  if (!/\.[cm]?[jt]sx?$/.test(path)) return;
  const uri = monaco.Uri.file(path).toString();
  if (sources.get(uri) === content) return;
  sources.set(uri, content);
  const libraries = [...sources].map(([filePath, content]) => ({ filePath, content }));
  for (const defaults of [monaco.languages.typescript.typescriptDefaults, monaco.languages.typescript.javascriptDefaults]) {
    defaults.setExtraLibs(libraries);
  }
}

export async function staticHover(model: monaco.editor.ITextModel, position: monaco.Position): Promise<monaco.languages.Hover | undefined> {
  try {
    const factory = await (model.getLanguageId() === 'typescript' ? monaco.languages.typescript.getTypeScriptWorker() : monaco.languages.typescript.getJavaScriptWorker());
    const worker = await factory(model.uri);
    const info = await worker.getQuickInfoAtPosition(model.uri.toString(), model.getOffsetAt(position));
    if (!info || model.isDisposed()) return;
    const start = model.getPositionAt(info.textSpan.start);
    const end = model.getPositionAt(info.textSpan.start + info.textSpan.length);
    const signature = (info.displayParts ?? []).map((p: { text: string }) => p.text).join('');
    const documentation = (info.documentation ?? []).map((p: { text: string }) => p.text).join('');
    const fence = '`'.repeat(Math.max(3, ...(signature.match(/`+/g) ?? []).map((r: string) => r.length + 1)));
    const contents: monaco.IMarkdownString[] = [{ value: `TypeScript type\n\n${fence}typescript\n${signature}\n${fence}`, isTrusted: false }];
    if (documentation) contents.push({ value: documentation, isTrusted: false });
    return { range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column), contents };
  } catch { /* Runtime inspection remains available if the language worker cannot answer. */ }
}
