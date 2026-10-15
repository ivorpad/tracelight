import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { definitions, localImports } from '../../web/definitions';

// The first lookup loads the typescript package through vitest's module runner: about 4.4 s here
// against 0.4 s in plain Node, so the default 5 s limit failed whenever other suites ran alongside.
vi.setConfig({ testTimeout: 30_000 });

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

it('follows imports and aliased calls through package re-exports to implementation, before execution', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tl-definition-')));
  roots.push(root);
  const pkg = path.join(root, 'node_modules', 'example');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'example', type: 'module', exports: { types: './index.d.ts', import: './index.js', default: './index.js' } }));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(pkg, 'index.d.ts'), 'export declare function twice(n: number): number;');
  fs.writeFileSync(path.join(pkg, 'index.js'), 'export { twice } from "./impl.js";');
  fs.writeFileSync(path.join(pkg, 'impl.js'), 'export function twice(n) { return n * 2; }');
  const file = path.join(root, 'main.ts');
  fs.writeFileSync(file, '// buffer is intentionally different');
  const content = 'import { twice as double } from "example";\ndouble(2);';
  for (const offset of [content.indexOf('twice'), content.lastIndexOf('double')]) {
    const result = definitions(file, content, offset);
    expect(result[0]?.path).toBe(path.join(pkg, 'impl.js'));
    expect(result[0]?.range.startLineNumber).toBe(1);
  }
  expect(definitions(file, content, content.indexOf('example'))[0]?.path).toBe(path.join(pkg, 'index.js'));
});

it('resolves local TypeScript and local symbols from the unsaved buffer', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tl-definition-')));
  roots.push(root);
  const file = path.join(root, 'main.ts');
  fs.writeFileSync(path.join(root, 'helper.ts'), 'export function helper() { return 1; }');
  const content = 'import { helper } from "./helper.js";\nconst value = helper();\nvalue;';
  expect(definitions(file, content, content.lastIndexOf('helper'))[0]?.path).toBe(path.join(root, 'helper.ts'));
  expect(definitions(file, content, content.lastIndexOf('value'))[0]?.range.startLineNumber).toBe(2);
  expect(() => definitions(file, content, -1)).toThrow('Invalid source position');
});

it('returns both the class declaration and constructor for an imported library class', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tl-definition-')));
  roots.push(root);
  const pkg = path.join(root, 'node_modules', 'example');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"example","main":"index.js"}');
  fs.writeFileSync(path.join(pkg, 'index.js'), 'export class Agent {\n  constructor(options) { this.options = options; }\n}');
  const content = 'import { Agent } from "example";\nconst agent = new Agent({});';
  const result = definitions(path.join(root, 'main.ts'), content, content.lastIndexOf('Agent'));
  expect(result.map(target => target.range.startLineNumber)).toEqual([1, 2]);
  expect(result.every(target => target.path === path.join(pkg, 'index.js'))).toBe(true);
});

it('lists the local files an entry reaches before any run, as the editor needs them, and nothing from packages', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tl-imports-')));
  roots.push(root);
  const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  write('package.json', JSON.stringify({ type: 'module' }));
  write('index.ts', "import { a } from './models/a.ts';\nimport { readFileSync } from 'node:fs';\nimport x from 'example';\nexport type { B } from './b';\n");
  write('models/a.ts', "export { c as a } from '../lib/c.js';\n");
  write('b.ts', 'export type B = 1;\n');
  write('lib/c.ts', 'export const c = 1;\n');
  write('node_modules/example/index.js', 'export default 1;\n');
  write('unused.ts', 'export {};\n');
  expect(localImports(path.join(root, 'index.ts')).sort()).toEqual(['b.ts', 'lib/c.ts', 'models/a.ts'].map(rel => path.join(root, rel)));
});
