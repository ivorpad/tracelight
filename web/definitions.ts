import * as path from 'node:path';
import ts from 'typescript';

/** Resolve against disk without executing imports. The open buffer may contain unsaved edits. */
export function definitions(file: string, content: string, offset: number) {
  if (!path.isAbsolute(file) || !Number.isInteger(offset) || offset < 0 || offset > content.length) throw new Error('Invalid source position');
  const config = ts.findConfigFile(path.dirname(file), ts.sys.fileExists);
  const configured = config ? ts.parseJsonConfigFileContent(ts.readConfigFile(config, ts.sys.readFile).config, ts.sys, path.dirname(config)).options : {};
  const options: ts.CompilerOptions = {
    ...configured, allowJs: true, checkJs: true, noEmit: true,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    // TypeScript's source-definition resolver uses this to skip package declaration files.
    noDtsResolution: true, maxNodeModuleJsDepth: 20,
  };
  const service = ts.createLanguageService({
    getCompilationSettings: () => options,
    getScriptFileNames: () => [file],
    getScriptVersion: () => '0',
    getScriptSnapshot: name => {
      const text = name === file ? content : ts.sys.readFile(name);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => path.dirname(file),
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    fileExists: ts.sys.fileExists, readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory, directoryExists: ts.sys.directoryExists,
    realpath: ts.sys.realpath,
  });
  try {
    return (service.getDefinitionAtPosition(file, offset) ?? []).flatMap(def => {
      const source = service.getProgram()?.getSourceFile(def.fileName);
      if (!source) return [];
      const start = source.getLineAndCharacterOfPosition(def.textSpan.start);
      const end = source.getLineAndCharacterOfPosition(def.textSpan.start + def.textSpan.length);
      return [{ path: def.fileName, content: source.text, range: {
        startLineNumber: start.line + 1, startColumn: start.character + 1,
        endLineNumber: end.line + 1, endColumn: end.character + 1,
      } }];
    });
  } finally { service.dispose(); }
}
