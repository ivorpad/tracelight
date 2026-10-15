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

/**
 * The project files the entry reaches through relative imports, read statically. The editor needs
 * them before any run, or a page started with `--no-run` reports every local import as missing.
 */
export function localImports(entry: string, limit = 200): string[] {
  const options: ts.CompilerOptions = { allowJs: true, allowImportingTsExtensions: true, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noDtsResolution: true };
  const found = new Set<string>();
  const queue = [entry];
  while (queue.length && found.size < limit) {
    const from = queue.shift()!;
    const text = ts.sys.readFile(from);
    if (text === undefined) continue;
    for (const { fileName } of ts.preProcessFile(text, true, true).importedFiles) {
      if (!fileName.startsWith('.')) continue;
      const resolved = ts.resolveModuleName(fileName, from, options, ts.sys).resolvedModule?.resolvedFileName;
      if (!resolved || resolved.endsWith('.d.ts') || resolved.includes(`${path.sep}node_modules${path.sep}`)) continue;
      const full = path.resolve(resolved);
      if (full === entry || found.has(full)) continue;
      found.add(full);
      queue.push(full);
    }
  }
  return [...found];
}
