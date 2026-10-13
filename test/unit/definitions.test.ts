import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { definitions } from '../../web/definitions';

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
