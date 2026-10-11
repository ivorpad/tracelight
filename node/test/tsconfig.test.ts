import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { project, run } from './helpers.ts';
import { parseJsonc, pathCandidates } from '../src/tsconfig.ts';

test('tsconfig paths: patterns, an exact alias, baseUrl, extends, comments; CJS too', async () => {
  const files = {
    'tsconfig.base.json': '{\n  // shared\n  "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["lib/*"], "config": ["src/config.ts"], }, },\n}\n',
    'tsconfig.json': '{ "extends": "./tsconfig.base.json", /* the app */ "compilerOptions": { "strict": true } }\n',
    'lib/math.ts': 'export const add = (a: number, b: number): number => a + b;\n',
    'lib/str/index.ts': 'export const up = (s: string): string => s.toUpperCase();\n',
    'src/config.ts': 'export default { name: "app" };\n',
    'src/util.ts': 'export const three = 3;\n',
    'cjs/helper.cts': 'module.exports = { four: 4 };\n',
    'main.ts': [
      'import { add } from "@lib/math.js";',
      'import { up } from "@lib/str";',
      'import config from "config";',
      'import { three } from "src/util";',
      'import { createRequire } from "node:module";',
      'const { four } = createRequire(import.meta.url)("cjs/helper.cts");',
      'console.log(add(1, 2), up(config.name), three, four);',
      '',
    ].join('\n'),
  };
  const r = await run(files, 'main.ts');
  assert.equal(r.finished.exitCode, 0, JSON.stringify(r.of('error')));
  assert.equal(r.logs()[0]!.text, '3 APP 3 4');
});

test('tsconfig paths: the longest prefix wins, the star is substituted, baseUrl comes last', () => {
  const cfg = { baseUrl: '/p', paths: [['@/*', ['/p/src/*']], ['@/ui/*', ['/p/ui/*', '/p/ui2/*']]] as [string, string[]][], pathsBase: '/p' };
  assert.deepEqual(pathCandidates('@/ui/button', cfg), ['/p/ui/button', '/p/ui2/button', '/p/@/ui/button']);
  assert.deepEqual(pathCandidates('@/x', cfg), ['/p/src/x', '/p/@/x']);
  assert.deepEqual(pathCandidates('lodash', { ...cfg, baseUrl: null }), []);
  assert.deepEqual(parseJsonc('{"a": "// not a comment", /* c */ "b": [1,],}'), { a: '// not a comment', b: [1] });
});

test('NODE_PATH reaches import too: a per-file install folder outside the project', async () => {
  const store = project({
    'node_modules/padme/package.json': '{ "name": "padme", "type": "module", "exports": "./index.js" }\n',
    'node_modules/padme/index.js': 'export default (s) => `[${s}]`;\n',
    'node_modules/cjsonly/index.js': 'module.exports = 7;\n',
  });
  const files = { 'main.ts': 'import pad from "padme";\nimport seven from "cjsonly";\nconsole.log(pad("x"), seven);\n' };
  const r = await run(files, 'main.ts', { env: { NODE_PATH: join(store, 'node_modules') } });
  assert.equal(r.finished.exitCode, 0, JSON.stringify(r.of('error')));
  assert.equal(r.logs()[0]!.text, '[x] 7');
});
