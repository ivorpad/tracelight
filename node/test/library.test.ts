import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from './helpers.ts';
import { matches, kindOf, packageOf } from '../src/select.ts';
import { join } from 'node:path';

const lib = {
  'node_modules/greet/package.json': '{"name":"greet","main":"index.js"}',
  'node_modules/greet/index.js': [
    'const table = [];',
    'for (let i = 0; i < 50; i++) table.push(i);', // import-time work: quiet
    'function hello(name) {',
    '  const s = "hi " + name;',
    '  return s;',
    '}',
    'module.exports = { hello };',
  ].join('\n'),
  'node_modules/esm-lib/package.json': '{"name":"esm-lib","type":"module","exports":"./x.js"}',
  'node_modules/esm-lib/x.js': 'const v = await Promise.resolve(2);\nexport function twice(n) { return n * v; }\n',
};
const main = 'import { hello } from "greet";\nimport { twice } from "esm-lib";\nconst a = hello("bo");\nconst b = twice(4);\nconsole.log(a, b);\n';

test('libraryCode off: node_modules runs as is', async () => {
  const r = await run({ ...lib, 'main.mjs': main }, 'main.mjs');
  assert.equal(r.finished.exitCode, 0);
  assert.equal(r.logs()[0]!.text, 'hi bo 8');
  assert.equal(r.of('file.instrumented').length, 1);
});

test('libraryCode: library files instrumented, import quiet, calls from stepped code recorded', async () => {
  const r = await run({ ...lib, 'main.mjs': main }, 'main.mjs', {}, { libraryCode: true });
  assert.equal(r.finished.exitCode, 0);
  assert.equal(r.logs()[0]!.text, 'hi bo 8');
  const files = r.of('file.instrumented');
  assert.equal(files.length, 3);
  for (const f of files.slice(1)) assert.equal(f.instrumentedSource, undefined);
  const names = r.scopes().map((s) => s.name);
  assert.deepEqual(names.filter((n) => n !== '<module>'), ['hello', 'twice']);
  // the import-time loop counted hits but recorded no steps
  const greet = files.find((f) => f.path.endsWith('greet/index.js'))!;
  const loopRids = new Set(Array.from({ length: greet.ranges.length }, (_, i) => greet.rangeBase + i));
  const steps = r.steps().filter(([rid]) => loopRids.has(rid!));
  assert.ok(steps.length > 0 && steps.length < 10, `steps in greet: ${steps.length}`);
  const hello = r.scopes().find((s) => s.name === 'hello')!;
  assert.equal(hello.returned, "'hi bo'");
  const cov = r.of('coverage').find((c) => c.fileId === greet.fileId)!;
  assert.ok(cov.states.some((s: number) => s === 1));
});

test('libraryPackages narrows; exclude and only', async () => {
  const r = await run({ ...lib, 'main.mjs': main }, 'main.mjs', {}, { libraryCode: true, libraryPackages: ['esm-lib'] });
  assert.deepEqual(r.of('file.instrumented').map((f) => f.path.split('/').pop()), ['main.mjs', 'x.js']);
  const files = { 'main.js': 'const a = require("./a");\nconst b = require("./gen/b");\nconsole.log(a + b);\n', 'a.js': 'module.exports = 1;\n', 'gen/b.js': 'module.exports = 2;\n' };
  const ex = await run(files, 'main.js', {}, { exclude: ['gen'] });
  assert.equal(ex.logs()[0]!.text, '3');
  assert.deepEqual(ex.of('file.instrumented').map((f) => f.path.split('/').pop()), ['main.js', 'a.js']);
  const only = await run(files, 'main.js', {}, { only: ['gen/b.js'] });
  assert.deepEqual(only.of('file.instrumented').map((f) => f.path.split('/').pop()), ['main.js', 'b.js']);
  const both = await run(files, 'main.js', {}, { only: ['gen'], exclude: ['b'] });
  assert.deepEqual(both.of('file.instrumented').map((f) => f.path.split('/').pop()), ['main.js']);
});

test('patterns: package names, path globs, bare names', () => {
  const root = '/w';
  assert.ok(matches('lodash', '/w/node_modules/lodash/fp/map.js', root));
  assert.ok(matches('lodash/fp', '/w/node_modules/lodash/fp/map.js', root));
  assert.ok(!matches('lodash/core', '/w/node_modules/lodash/fp/map.js', root));
  assert.ok(matches('@scope/*', '/w/node_modules/@scope/pkg/index.js', root));
  assert.ok(matches('src/gen', '/w/src/gen/x.ts', root));
  assert.ok(matches('**/parser.ts', '/w/a/b/parser.ts', root));
  assert.ok(matches('parser', '/w/a/b/parser.ts', root));
  assert.ok(matches('/w/a', '/w/a/b/parser.ts', root));
  assert.ok(!matches('pars', '/w/a/b/parser.ts', root));
  assert.deepEqual(packageOf('/w/node_modules/a/node_modules/@s/b/lib/c.js'), { name: '@s/b', sub: 'lib/c.js' });
  const sel = { root, mainPath: '/w/main.js', libraryCode: false, libraryPackages: [], exclude: ['main'], only: [] };
  assert.equal(kindOf('/w/main.js', sel), 'project'); // never the program file
  assert.equal(kindOf('/w/node_modules/x/i.js', { ...sel, only: ['x'] }), 'library');
  assert.equal(kindOf('/elsewhere/y.js', sel), null);
});

test('the library cache: a second run loads relocated code, same results at another range base', async () => {
  const { mkdtempSync, readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const saved = process.env.TRACELIGHT_CACHE_DIR;
  process.env.TRACELIGHT_CACHE_DIR = mkdtempSync(join(tmpdir(), 'tracelight-cache-'));
  try {
    const { project } = await import('./helpers.ts');
    const { buildRequest, runOnce } = await import('../src/cli.ts');
    const dir = project({ ...lib, 'main.mjs': main, 'other.mjs': 'const pad = [1, 2, 3].map((x) => x + 1);\nexport default pad;\n' });
    const go = async (src: string) => {
      const req = buildRequest(join(dir, 'main.mjs'), src, {}, 'c');
      req.config.libraryCode = true;
      const { wrap } = await import('./helpers.ts');
      const out = await runOnce(req);
      return wrap(out.events, out.finished);
    };
    const first = await go(main);
    assert.equal(readdirSync(process.env.TRACELIGHT_CACHE_DIR!).filter((n) => n.endsWith('.json')).length, 2);
    // the second run imports another project file first, so the library files land at other range bases
    const second = await go('import "./other.mjs";\n' + main);
    const base = (r: typeof first, end: string) => r.of('file.instrumented').find((f) => f.path.endsWith(end))!.rangeBase;
    assert.notEqual(base(first, 'greet/index.js'), base(second, 'greet/index.js'));
    assert.equal(second.logs()[0]!.text, 'hi bo 8');
    const hello = (r: typeof first) => r.scopes().find((s) => s.name === 'hello')!;
    assert.equal(hello(second).returned, "'hi bo'");
    assert.equal(hello(second).rid - base(second, 'greet/index.js'), hello(first).rid - base(first, 'greet/index.js'));
    const cov = (r: typeof first) => r.of('coverage').find((c) => c.fileId === r.of('file.instrumented').find((f) => f.path.endsWith('greet/index.js'))!.fileId)!.states;
    assert.deepEqual(cov(second), cov(first));
  } finally {
    process.env.TRACELIGHT_CACHE_DIR = saved;
  }
});

test('the module launch: a package bin or a specifier from cwd, argv, errors', async () => {
  const { project } = await import('./helpers.ts');
  const { runOnce } = await import('../src/cli.ts');
  const { wrap } = await import('./helpers.ts');
  const dir = project({
    'node_modules/tool/package.json': '{"name":"tool","bin":{"tool":"cli.js"}}',
    'node_modules/tool/cli.js': 'const args = process.argv.slice(2);\nconsole.log("tool", args.join(","));\n',
    'node_modules/esm-only/package.json': '{"name":"esm-only","type":"module","exports":{".":{"import":"./m.js"}}}',
    'node_modules/esm-only/m.js': 'const v = 40 + 2;\nconsole.log(v);\n',
  });
  const go = async (module: string, extra: Record<string, any> = {}) => {
    const req = { type: 'run', id: 1, runId: `m-${module}`, module, cwd: dir, argv: ['a', 'b'], env: {}, config: { timeoutMs: 10000 }, ...extra };
    const out = await runOnce(req);
    return wrap(out.events, out.finished);
  };
  const t = await go('tool');
  assert.equal(t.finished.exitCode, 0);
  assert.equal(t.logs()[0]!.text, 'tool a,b');
  assert.ok(t.of('file.instrumented')[0]!.path.endsWith('tool/cli.js'));
  const e = await go('esm-only');
  assert.equal(e.logs()[0]!.text, '42');
  const missing = await go('nope-not-here');
  assert.equal(missing.finished.exitCode, 1);
  assert.match(missing.of('runner.error')[0]!.message, /^cannot run -m nope-not-here: /);
  const both = await go('tool', { file: { path: join(dir, 'x.js') } });
  assert.equal(both.of('runner.error')[0]!.message, 'run.module and run.file are both set; running the module tool');
  assert.equal(both.logs()[0]!.text, 'tool a,b');
});

test('an ESM library whose body throws does not leave the run quiet', async () => {
  const files = {
    'node_modules/bad/package.json': '{"name":"bad","type":"module","exports":"./x.js"}',
    'node_modules/bad/x.js': 'const v = 1;\nthrow new Error("boom");\n',
    'main.mjs': 'let r = 0;\ntry {\n  await import("bad");\n} catch (e) {\n  r = 1;\n}\nfunction f(n) {\n  return n + 1;\n}\nconst z = f(r);\nconsole.log(z);\n',
  };
  const r = await run(files, 'main.mjs', {}, { libraryCode: true });
  assert.equal(r.logs()[0]!.text, '2');
  assert.ok(r.scopes().some((s) => s.name === 'f'), 'f is recorded');
});

test('library stack columns map back to the source without a source map', async () => {
  const files = {
    'node_modules/deep/package.json': '{"name":"deep","main":"index.js"}',
    'node_modules/deep/index.js': 'function check(v) {\n  if (v > 1) { const msg = "too big"; throw new Error(msg); }\n  return v;\n}\nmodule.exports = { check };\n',
    'main.cjs': 'const { check } = require("deep");\ncheck(5);\n',
  };
  const r = await run(files, 'main.cjs', {}, { libraryCode: true });
  const err = r.of('error')[0]!;
  const lib = err.stack.find((f: any) => f.path.endsWith('deep/index.js'));
  // `throw new Error(msg)`: `new` is at column 44 (0-based) of line 2 in the file as written
  assert.deepEqual([lib.line, lib.col], [2, 44]);
  assert.match(err.traceback, /deep\/index\.js:2:45\)/);
});
