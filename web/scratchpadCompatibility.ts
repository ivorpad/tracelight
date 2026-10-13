import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { scratchProcess } from './scratchpadProcess';
import { scratchEnvironment } from './scratchpadEnvironment';

export interface ApiShape { members: string[]; prototype: string[] }
export interface ScratchInventory {
  runtime: 'node' | 'bun'; version: string; nodeVersion: string;
  globals: Record<string, ApiShape>; modules: Record<string, Record<string, ApiShape> | {unavailable:string}>;
  bun: Record<string, ApiShape>;
}
export interface ScratchCompatibility {
  inventory: ScratchInventory;
  libraries: {path:string;content:string}[];
  declarations: Record<string,string>;
  missingDeclarations: string[];
  missingRuntimeApis: string[];
  boundaries: string[];
}
const cache = new Map<string, Promise<ScratchCompatibility>>();
const probe = `
const fs=require('node:fs');
const shape=value=>({members:value==null||!['object','function'].includes(typeof value)?[]:Object.getOwnPropertyNames(value).filter(n=>!['length','name','caller','arguments','prototype'].includes(n)),prototype:typeof value==='function'&&value.prototype?Object.getOwnPropertyNames(value.prototype).filter(n=>n!=='constructor'):[]});
const entries=value=>Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(value)).map(([name,d])=>[name,shape(d.value)]));
(async()=>{const globals=entries(globalThis),modules={};
for(const name of require('node:module').builtinModules){if(name.startsWith('_'))continue;const key=name.startsWith('node:')?name:'node:'+name;try{modules[key]=entries(await import(key));}catch(e){modules[key]={unavailable:String(e.message)};}}
if(process.versions.bun)for(const name of ['bun','bun:sqlite','bun:ffi','bun:jsc','bun:test']){try{modules[name]=entries(await import(name));}catch(e){modules[name]={unavailable:String(e.message)};}}
fs.writeSync(3,JSON.stringify({runtime:process.versions.bun?'bun':'node',version:process.versions.bun||process.versions.node,nodeVersion:process.versions.node,globals,modules,bun:globalThis.Bun?entries(Bun):{}})+'\\n');})();`;

export function scratchCompatibility(executable: string, root: string): Promise<ScratchCompatibility> {
  const key = executable + ':' + root;
  let result = cache.get(key);
  if (!result) {
    result = buildCompatibility(executable, root);
    cache.set(key, result);
    result.catch(() => cache.delete(key));
  }
  return result;
}

async function buildCompatibility(executable: string, root: string): Promise<ScratchCompatibility> {
  const moduleProbe = `import {createRequire} from 'node:module'; const require=createRequire(${JSON.stringify(path.join(root,'package.json'))});\n${probe}`;
  const inventory: ScratchInventory = JSON.parse(await scratchProcess(executable,moduleProbe,8000,{cwd:root,setup:''}));
  const actual: ScratchInventory = JSON.parse(await scratchProcess(executable,
    moduleProbe,8000,
    {cwd:root,setup:`const __scratchPayload='{"inputs":{},"mocks":{}}';\n${scratchEnvironment}`}));
  const missingRuntimeApis: string[] = [];
  const compareRuntime = (expected: Record<string,ApiShape>, observed: Record<string,ApiShape>, prefix: string) => {
    for (const [name,shape] of Object.entries(expected)) {
      if (name.startsWith('_')) continue;
      if (!observed[name]) {missingRuntimeApis.push(prefix+name);continue;}
      for (const member of shape.members) if (!member.startsWith('_') && !/^\d+$/.test(member) && !observed[name]!.members.includes(member)) missingRuntimeApis.push(prefix+name+'.'+member);
      for (const member of shape.prototype) if (!observed[name]!.prototype.includes(member)) missingRuntimeApis.push(prefix+name+'.prototype.'+member);
    }
  };
  compareRuntime(inventory.globals,actual.globals,'globalThis.');
  compareRuntime(inventory.bun,actual.bun,'Bun.');
  for (const [module,exports] of Object.entries(inventory.modules)) {
    if ('unavailable' in exports) continue;
    const observed=actual.modules[module];
    if (!observed || 'unavailable' in observed) missingRuntimeApis.push(module);
    else compareRuntime(exports,observed,module+'.');
  }
  const libraries: ScratchCompatibility['libraries'] = [];
  const declarations: Record<string,string> = {};
  for (const pkg of ['@types/node','undici-types',...(inventory.runtime === 'bun' ? ['bun-types'] : [])]) {
    const folder = path.join(root, 'node_modules', pkg);
    declarations[pkg] = JSON.parse(fs.readFileSync(path.join(folder,'package.json'),'utf8')).version;
    for (const item of fs.readdirSync(folder,{recursive:true}).filter((name): name is string => typeof name === 'string' && name.endsWith('.d.ts'))) {
      let content = fs.readFileSync(path.join(folder,item),'utf8');
      // Bun 1.4's shipped declarations omit a native constructor method. Use the
      // Node Streams signature only when the native inventory confirms it exists.
      if (pkg === 'bun-types' && item === 'globals.d.ts' && inventory.globals.ReadableStream?.members.includes('from')) {
        content = content.replace('    prototype: ReadableStream;', '    prototype: ReadableStream;\n    from: typeof import("node:stream/web").ReadableStream.from;');
      }
      libraries.push({path:`node_modules/${pkg}/${item.split(path.sep).join('/')}`,content});
    }
  }
  const virtual = new Map(libraries.map(l => [path.join(root,l.path),l.content]));
  const probeFile = path.join(root,'__scratch_api_inventory.ts');
  const modules = Object.entries(inventory.modules).filter(([,shape]) => !('unavailable' in shape));
  const source = 'export {};\n' + modules.map(([name],i)=>`import * as m${i} from ${JSON.stringify(name)};`).join('\n');
  virtual.set(probeFile,source);
  const options: ts.CompilerOptions = {target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,lib:['lib.esnext.d.ts'],types:inventory.runtime === 'bun'?['bun-types']:['node'],skipLibCheck:true,typeRoots:[path.join(root,'node_modules/@types'),path.join(root,'node_modules')]};
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host), exists = host.fileExists.bind(host);
  host.readFile = file => virtual.get(file) ?? read(file);
  host.fileExists = file => virtual.has(file) || exists(file);
  const program = ts.createProgram([probeFile],options,host), checker = program.getTypeChecker();
  const sf = program.getSourceFile(probeFile)!;
  const globalSymbol = checker.resolveName('globalThis',undefined,ts.SymbolFlags.Value,false)!;
  const globalType = checker.getTypeOfSymbolAtLocation(globalSymbol,sf);
  const missingDeclarations: string[] = [];
  const compare = (shape: Record<string,ApiShape>, type: ts.Type, prefix: string) => {
    for (const [name, api] of Object.entries(shape)) {
      if (name.startsWith('_') || !/^[$A-Z_a-z][$\w]*$/.test(name)) continue;
      const symbol = checker.getPropertyOfType(type,name);
      if (!symbol) { missingDeclarations.push(prefix+name); continue; }
      const valueType = checker.getTypeOfSymbolAtLocation(symbol,sf);
      for (const member of api.members) if (!member.startsWith('_') && !checker.getIndexTypeOfType(valueType,ts.IndexKind.String) && !(/^\d+$/.test(member) && checker.getIndexTypeOfType(valueType,ts.IndexKind.Number)) && !checker.getPropertyOfType(valueType,member)) missingDeclarations.push(prefix+name+'.'+member);
      const prototype = checker.getPropertyOfType(valueType,'prototype');
      if (prototype) for (const member of api.prototype) if (!checker.getPropertyOfType(checker.getTypeOfSymbolAtLocation(prototype,sf),member)) missingDeclarations.push(prefix+name+'.prototype.'+member);
    }
  };
  compare(inventory.globals,globalType,'globalThis.');
  modules.forEach(([,shape],i)=>{
    const statement = sf.statements[i+1] as ts.ImportDeclaration;
    compare(shape as Record<string,ApiShape>,checker.getTypeAtLocation(statement.importClause!.namedBindings!),modules[i]![0]+'.');
  });
  const bun = checker.getPropertyOfType(globalType,'Bun');
  if (bun) compare(inventory.bun,checker.getTypeOfSymbolAtLocation(bun,sf),'Bun.');
  return {inventory,libraries,declarations,missingRuntimeApis:missingRuntimeApis.sort(),missingDeclarations:missingDeclarations.sort(),boundaries:[
    'Experiments run in a separate process with native globals and built-in modules. They do not share the paused application frame or environment credentials.',
    'HTTP fetch requires an explicit http:URL fixture. Other real networking is denied by the operating system, including networking from subprocesses.',
    'File and process APIs have real effects. The process starts in the selected lesson source directory, so native imports and relative paths keep their runtime meaning. Only the runner bootstrap is temporary.',
    'The execution limit is 3 seconds; output and returned values are capped. Processes in the experiment process group are stopped with it. Explicitly detached services are outside the supported scratchpad model.',
    'Native process networking isolation currently requires macOS sandbox-exec. Native APIs and their absence follow the selected executable; declaration gaps are listed in this report.',
  ]};
}
