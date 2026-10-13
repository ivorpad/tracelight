import * as ts from 'typescript';
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { scratchProcess } from './scratchpadProcess';
import { scratchEnvironment } from './scratchpadEnvironment';

export interface ScratchRequest { file: string; code: string; inputs: Record<string, unknown>; mocks: Record<string, unknown> }
export interface ScratchResult { values: { name: string; line: number; value: unknown }[]; output: unknown[]; result?: unknown; error?: string; missingMocks?: string[]; caps?: { values: boolean; output: boolean }; applicationErrors?: { path: string; value: unknown }[] }

export function formatScratchCode(code: string): string {
  if (typeof code !== 'string' || code.length > 100000) throw new Error('Invalid scratchpad code');
  const checked = ts.transpileModule(code, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  const errors = checked.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error) ?? [];
  if (errors.length) throw new Error(ts.flattenDiagnosticMessageText(errors[0]!.messageText, '\n'));
  const source = ts.createSourceFile('scratch.ts', code, ts.ScriptTarget.Latest, true);
  const formatted = ts.transform(source, [context => root => {
    const visit: ts.Visitor = node => ts.isBlock(node)
      ? ts.factory.createBlock(ts.visitNodes(node.statements, visit, ts.isStatement), true)
      : ts.visitEachChild(node, visit, context);
    return ts.visitNode(root, visit) as ts.SourceFile;
  }]);
  try { return ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(formatted.transformed[0]!); }
  finally { formatted.dispose(); }
}

/** Find a function without running the module's initialization. */
export function scratchFunction(source: string, line: number): { code: string; name?: string; parameters: string[]; helpers?: string[]; requiresReceiver?: boolean } {
  const sf = ts.createSourceFile('scratch.ts', source, ts.ScriptTarget.Latest, true);
  let found: ts.FunctionLikeDeclaration | undefined;
  function visit(node: ts.Node): void {
    const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const end = sf.getLineAndCharacterOfPosition(node.end).line + 1;
    if (start <= line && end >= line) {
      if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) found = node;
      else if (!found && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))) found = node;
      ts.forEachChild(node, visit);
    }
  }
  visit(sf);
  if (!found) return { code: '', parameters: [] };
  const binding = ts.isVariableDeclaration(found.parent) && ts.isIdentifier(found.parent.name) ? found.parent.name.text : undefined;
  const name = found.name && ts.isIdentifier(found.name) ? found.name.text : binding;
  const typed = ts.transform(found, [context => root => {
    const visit: ts.Visitor = node => ts.isParameter(node) && !node.type
      ? ts.factory.updateParameterDeclaration(node, node.modifiers, node.dotDotDotToken, node.name, node.questionToken, ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword), node.initializer)
      : ts.visitEachChild(node, visit, context);
    return ts.visitNode(root, visit) as typeof root;
  }]);
  const declaration = typed.transformed[0]!;
  const standalone = ts.isMethodDeclaration(declaration)
    ? ts.factory.createFunctionDeclaration(declaration.modifiers?.filter(m => m.kind === ts.SyntaxKind.AsyncKeyword), declaration.asteriskToken, name, declaration.typeParameters, declaration.parameters, declaration.type, declaration.body)
    : declaration;
  let code = ts.createPrinter().printNode(ts.EmitHint.Unspecified, standalone, sf).replace(/^export\s+/, '');
  typed.dispose();
  if (binding && (ts.isArrowFunction(found) || ts.isFunctionExpression(found))) code = `const ${binding} = ${code};`;
  let requiresReceiver = false;
  const receiver = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) requiresReceiver = true;
    ts.forEachChild(node, receiver);
  };
  if (found.body) receiver(found.body);
  const helpers = sf.statements.filter(ts.isFunctionDeclaration).flatMap(s => s.name && s.name.text !== name ? [s.name.text] : []);
  return { code, ...(name ? { name } : {}), parameters: found.parameters.map(p => `${p.dotDotDotToken ? '...' : ''}${p.name.getText(sf)}`), helpers, ...(requiresReceiver ? { requiresReceiver } : {}) };
}

/** Names explicitly declared by the edited copy override captured bindings. */
function topLevelNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const binding = (n: ts.BindingName): void => {
    if (ts.isIdentifier(n)) names.add(n.text);
    else for (const e of n.elements) if (ts.isBindingElement(e)) binding(e.name);
  };
  for (const s of sf.statements) {
    if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name) names.add(s.name.text);
    if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) binding(d.name);
    if (ts.isImportDeclaration(s) && s.importClause) {
      const c = s.importClause;
      if (c.name) names.add(c.name.text);
      if (c.namedBindings) {
        if (ts.isNamespaceImport(c.namedBindings)) names.add(c.namedBindings.name.text);
        else for (const e of c.namedBindings.elements) names.add(e.name.text);
      }
    }
  }
  return names;
}

/** Bring in referenced module declarations and imports, without its top-level run. */
export function scratchDependencies(source: string, code: string, mocked: Set<string>): string {
  const sf = ts.createSourceFile('original.ts', source, ts.ScriptTarget.Latest, true);
  const declarations = new Map<string, ts.Statement>();
  for (const s of sf.statements) {
    if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name) declarations.set(s.name.text, s);
    if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name)) declarations.set(d.name.text, s);
    if (ts.isImportDeclaration(s)) {
      const c = s.importClause;
      if (c?.name) declarations.set(c.name.text, s);
      if (c?.namedBindings) {
        if (ts.isNamespaceImport(c.namedBindings)) declarations.set(c.namedBindings.name.text, s);
        else for (const e of c.namedBindings.elements) declarations.set(e.name.text, s);
      }
    }
  }
  const edited = ts.createSourceFile('scratch.ts', code, ts.ScriptTarget.Latest, true);
  const own = new Set([...mocked, ...topLevelNames(edited)]);
  for (const s of edited.statements) {
    if (ts.isFunctionDeclaration(s) && s.name) own.add(s.name.text);
    if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name)) own.add(d.name.text);
  }
  const chosen = new Set<ts.Statement>();
  function collect(node: ts.Node): void {
    if (ts.isIdentifier(node) && !own.has(node.text)) {
      const declaration = declarations.get(node.text);
      if (declaration && !chosen.has(declaration)) { chosen.add(declaration); collect(declaration); }
    }
    ts.forEachChild(node, collect);
  }
  collect(edited);
  return sf.statements.filter(s => chosen.has(s)).map(s => s.getText(sf).replace(/^export\s+/, '')).join('\n');
}

/** Instrument the scratch copy only. */
export function captureScratch(code: string): string {
  const sf = ts.createSourceFile('scratch.ts', code, ts.ScriptTarget.Latest, true);
  const edits: { at: number; text: string }[] = [];
  function visit(n: ts.Node): void {
    if (ts.isVariableStatement(n)) {
      const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
      for (const d of n.declarationList.declarations) if (ts.isIdentifier(d.name)) edits.push({ at: n.end, text: `\n__capture(${JSON.stringify(d.name.text)},${line},${d.name.text});` });
    }
    ts.forEachChild(n, visit);
  }
  visit(sf);
  for (const e of edits.sort((a, b) => b.at - a.at)) code = code.slice(0, e.at) + e.text + code.slice(e.at);
  return code;
}

export async function runScratch(request: ScratchRequest, executable = process.execPath): Promise<ScratchResult> {
  if (!request.file || typeof request.code !== 'string' || request.code.length > 100_000) throw new Error('Invalid scratchpad source');
  const inputs = request.inputs ?? {}, mocks = request.mocks ?? {};
  const names = [...Object.keys(inputs), ...Object.keys(mocks).filter(n => !n.startsWith('http:') && !n.includes('.'))];
  if (names.some(n => !/^[A-Za-z_$][\w$]*$/.test(n) || n.startsWith('__'))) throw new Error('Invalid input or mock name');
  const own = topLevelNames(ts.createSourceFile('scratch.ts', request.code, ts.ScriptTarget.Latest, true));
  const deps = scratchDependencies(fs.readFileSync(request.file, 'utf8'), request.code, new Set(names));
  const bindings = Object.keys(inputs).filter(n => !own.has(n)).map(n => `const ${n}=__hydrate(__inputs[${JSON.stringify(n)}],${JSON.stringify(n)});`).join('\n') + '\n' + Object.keys(mocks).filter(n => !own.has(n) && !(n in inputs) && /^[A-Za-z_$][\w$]*$/.test(n)).map(n => `const ${n}=(...args)=>__clone(__mocks[${JSON.stringify(n)}]);`).join('\n');
  const edited = ts.createSourceFile('scratch.ts', request.code, ts.ScriptTarget.Latest, true);
  const imports = edited.statements.filter(ts.isImportDeclaration);
  const moduleMarkers = edited.statements.filter(s => ts.isExportDeclaration(s) && !s.moduleSpecifier && s.exportClause && ts.isNamedExports(s.exportClause) && !s.exportClause.elements.length);
  let body = request.code;
  for (const statement of [...imports, ...moduleMarkers].sort((a, b) => b.pos - a.pos)) body = body.slice(0, statement.getStart(edited)) + statement.getText(edited).replace(/[^\n]/g, ' ') + body.slice(statement.end);
  const built = await esbuild.transform(`${deps}\n${imports.map(s => s.getText(edited)).join('\n')}\nasync function __run(){${bindings}\n${captureScratch(body)}\n${own.has("result") ? "return result;" : ""}\n}\ntry {const value=await __run();__finish(undefined,value);}catch(e){__finish(String(e.message||e));}`, {format:'esm',loader:'ts',target:'esnext',sourcefile:request.file,define:{'import.meta.url':JSON.stringify(pathToFileURL(request.file).href)}});
  const payload = JSON.stringify({ inputs, mocks });
  const compiler = createRequire(typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url)).resolve('esbuild');
  const loader = `if(!process.versions.bun){
    const {registerHooks}=require('node:module'),fs=require('node:fs'),{fileURLToPath}=require('node:url');
    const compiler=require(${JSON.stringify(compiler)});
    registerHooks({resolve(specifier,context,next){try{return next(specifier,context);}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND'||!specifier.startsWith('.'))throw error;for(const extension of ['.ts','.tsx','.mts','.js','.mjs','/index.ts','/index.js']){try{return next(specifier+extension,context);}catch{}}throw error;}},load(url,context,next){if(!/^file:.*\\.[cm]?tsx?$/.test(url))return next(url,context);const source=fs.readFileSync(fileURLToPath(url),'utf8');return {shortCircuit:true,format:'module',source:compiler.transformSync(source,{loader:url.endsWith('tsx')?'tsx':'ts',format:'esm',target:'esnext'}).code};}});
  }`;
  const setup = `${loader}\nconst __scratchPayload=${JSON.stringify(payload)};\n${scratchEnvironment}`;
  let result: ScratchResult;
  try { result = JSON.parse(await scratchProcess(executable,built.code,3000,{cwd:path.dirname(request.file),setup})); }
  catch (error) { return {values:[],output:[],error:error instanceof Error ? error.message : String(error)}; }
  result.result ??= result.values.filter(v => v.name === 'result').at(-1)?.value;
  result.applicationErrors = [];
  const inspect = (value: unknown, at: string): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (/^(error|errors|isError)$/.test(key) && child && (!Array.isArray(child) || child.length)) result.applicationErrors!.push({path:`${at}.${key}`,value:child});
      else inspect(child,`${at}.${key}`);
    }
  };
  inspect(result.result, 'result');
  for (const [name, value] of new Map(result.values.filter(v => v.name !== 'result').map(v => [v.name, v.value]))) inspect(value, `values.${name}`);
  result.output.forEach((entry, index) => inspect(entry, `output.${index}`));
  return result;
}
