/** `debug --configuration NAME` and `--test NAME`: launch.json read into debug's flags, and the test filter. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { project } from './helpers.ts';
import { launchConfiguration, parseJsonc, testNamePattern } from '../src/agent/launchConfig.ts';
import { debugLaunch } from '../src/agent/verbs/debugger.ts';
import { wordsDebug } from '../src/mcp/server.ts';

const LAUNCH = `{
  // comments and trailing commas, as VS Code writes it
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node", "request": "launch", "name": "Checkout DE",
      "program": "\${workspaceFolder}/src/main.ts",
      "args": ["--country", "de"],
      "cwd": "\${workspaceFolder}/src",
      "env": { "MODE": "test", "HOME_DIR": "\${userHome}" },
      "envFile": "\${workspaceFolder}/.env",
      "runtimeArgs": ["--inspect"],
      "skipFiles": ["<node_internals>/**"],
    },
    { "type": "bun", "request": "launch", "name": "Bun one", "program": "\${file}" },
    { "type": "python", "request": "launch", "name": "Py" },
    { "type": "node", "request": "attach", "name": "Attach", "port": 9229 },
  ],
}`;

function workspace(): string {
  const root = realpathSync(project({ 'src/main.ts': 'console.log(1);\n', 'src/other.ts': 'console.log(2);\n', '.env': '# comment\nTOKEN="abc"\nexport LEVEL=3\n' }));
  mkdirSync(join(root, '.vscode'));
  writeFileSync(join(root, '.vscode', 'launch.json'), LAUNCH);
  return root;
}

test('a launch.json configuration becomes program, args, cwd, env and runtime, with the rest named', () => {
  const root = workspace();
  try {
    assert.deepEqual(parseJsonc('{"a": "// not a comment", /* x */ "b": [1, 2,],}'), { a: '// not a comment', b: [1, 2] });
    const c = launchConfiguration('Checkout DE', join(root, 'src'));
    assert.equal(c.file, join(root, '.vscode', 'launch.json'));
    assert.equal(c.program, join(root, 'src', 'main.ts'));
    assert.deepEqual(c.args, ['--country', 'de']);
    assert.equal(c.cwd, join(root, 'src'));
    assert.equal(c.env.MODE, 'test');
    assert.equal(c.env.TOKEN, 'abc');
    assert.equal(c.env.LEVEL, '3');
    assert.equal(c.node, null);
    assert.deepEqual(c.ignored, ['runtimeArgs']);

    const bun = launchConfiguration('Bun one', root, join(root, 'src', 'other.ts'));
    assert.equal(bun.program, join(root, 'src', 'other.ts'));
    assert.equal(bun.node, 'bun');
    assert.throws(() => launchConfiguration('Bun one', root), /needs the FILE argument/);
    assert.throws(() => launchConfiguration('Nope', root), (e: any) => /no configuration named "Nope"/.test(e.message) && /"Checkout DE", "Bun one"/.test(e.hint));
    assert.throws(() => launchConfiguration('Py', root), /type "python"/);
    assert.throws(() => launchConfiguration('Attach', root), /attaches/);
    assert.throws(() => launchConfiguration('Checkout DE', '/'), /no .vscode\/launch.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('debug --configuration fills the launch; flags given on the command line win; --test sets the filter', () => {
  const root = workspace();
  try {
    const launch = debugLaunch({ command: 'debug', configuration: 'Checkout DE', cwd: join(root, 'src'), env: ['MODE=override'], args: [] })!;
    assert.equal(launch.program, join(root, 'src', 'main.ts'));
    assert.deepEqual(launch.args, ['--country', 'de']);
    assert.equal(launch.env.MODE, 'override');
    assert.equal(launch.env.TOKEN, 'abc');
    const filtered = debugLaunch({ command: 'debug', program: join(root, 'src', 'main.ts'), test: 'math adds (x2)', args: [], env: [] })!;
    assert.equal(filtered.env.TRACELIGHT_TEST_NAME_PATTERN, '^math adds \\(x2\\)$');
    assert.throws(() => debugLaunch({ command: 'debug', program: join(root, 'src', 'main.ts'), test: 'x', node: 'bun', args: [], env: [] }), /node:test/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.ok(new RegExp(testNamePattern('a.b+c')).test('a.b+c'));
  assert.ok(!new RegExp(testNamePattern('a.b')).test('axb'));
  assert.deepEqual(wordsDebug({ action: 'start', configuration: 'Checkout DE', test: 'adds', cwd: '/w' }), ['debug', '--live', '--cwd=/w', '--configuration=Checkout DE', '--test=adds']);
  assert.deepEqual(wordsDebug({ action: 'locals', scope: 'global', names_only: true }), ['locals', '--live', '--names-only', '--scope=global']);
  assert.throws(() => wordsDebug({ action: 'locals', scope: 'everything' }), /unknown scope/);
});
