import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { launchKey, launchLine, launchName, launchReply, parseLaunch, substitute } from '../../src/debug/debugSessionState';
import { entryPause } from '../../src/session/debugState';

const root = path.resolve('/ws');
const app = path.join(root, 'app.py');

describe('parseLaunch', () => {
  it('fills every attribute with its default', () => {
    const l = parseLaunch({ program: app });
    expect(l).toEqual({ program: app, args: [], cwd: root, env: {}, stopOnEntry: false, breakOnException: 'uncaught', libraryCode: false, record: false });
  });

  it('resolves ${file} and ${workspaceFolder} and makes program absolute', () => {
    expect(substitute('${workspaceFolder}/app.py', { workspaceRoot: root })).toBe(`${root}/app.py`);
    const l = parseLaunch({ program: '${file}', cwd: '${workspaceFolder}' }, { activeFile: app, workspaceRoot: root });
    expect(l.program).toBe(app);
    expect(l.cwd).toBe(root);
    // a relative program is resolved against the process, as VS Code's own debuggers do
    expect(parseLaunch({ program: 'app.py' }).program).toBe(path.resolve('app.py'));
  });

  it('reads args, env, node, the exception mode and the toggles', () => {
    const l = parseLaunch({ program: app, args: ['--port', 8000], env: { PORT: 8000 }, node: '/opt/node/bin/node', cwd: root, stopOnEntry: true, breakOnException: 'raised', libraryCode: true });
    expect(l).toEqual({ program: app, args: ['--port', '8000'], env: { PORT: '8000' }, node: '/opt/node/bin/node', cwd: root, stopOnEntry: true, breakOnException: 'raised', libraryCode: true, record: false });
    // a bare node is a command on PATH, not a file in the cwd
    expect(parseLaunch({ program: app, node: 'node' }).node).toBe('node');
    // an unknown mode falls back to the default rather than reaching the runtime
    expect(parseLaunch({ program: app, breakOnException: 'sometimes' }).breakOnException).toBe('uncaught');
  });

  it('refuses a launch with no program, and a module launch', () => {
    expect(() => parseLaunch({})).toThrow(/needs "program"/);
    expect(() => parseLaunch({ module: 'app.server' })).toThrow(/"module" has no meaning on Node/);
    expect(() => parseLaunch({ program: app, module: 'app.server' })).toThrow(/"module" has no meaning on Node/);
  });

  it('names and prints a launch', () => {
    expect(launchName(parseLaunch({ program: app }))).toBe('app.py');
    expect(launchLine(parseLaunch({ program: app, args: ['--port', '8000'], node: '/opt/node/bin/node', cwd: root }))).toBe(`/opt/node/bin/node ${app} --port 8000`);
    // a launch that names no Node prints none: the session fills it in once it resolved one
    expect(launchLine(parseLaunch({ program: app, args: ['--port', '8000'], cwd: root }))).toBe(`${app} --port 8000`);
    expect(launchReply(parseLaunch({ program: app }))).toMatchObject({ program: app, record: false });
    expect(launchReply(parseLaunch({ program: app }))).not.toHaveProperty('module');
  });
});

describe('launchKey', () => {
  const real = (p: string): string => p; // no realpath in the test: the key's other half is what matters

  it('is the program and the working directory', () => {
    expect(launchKey(parseLaunch({ program: app }), real)).toBe(`f:${app}|${root}`);
  });

  it('ignores args and separates by cwd', () => {
    const a = parseLaunch({ program: app, args: ['--port', '8000'] });
    const b = parseLaunch({ program: app, args: ['--port', '9000'] });
    expect(launchKey(a, real)).toBe(launchKey(b, real));
    const elsewhere = parseLaunch({ program: app, cwd: path.join(root, 'sub') });
    expect(launchKey(elsewhere, real)).not.toBe(launchKey(a, real));
  });
});

describe('entryPause for an agent cold start', () => {
  it('stops at the first statement only when nothing else can stop the program', () => {
    // a cold start has no run, so any enabled breakpoint can still hit: the run goes to it
    expect(entryPause({}, [], [], { anyFile: true })).toBe(true);
    expect(entryPause({}, [{ path: app, line: 12 }], [], { anyFile: true })).toBe(false);
    expect(entryPause({ stopOnEntry: true }, [{ path: app, line: 12 }], [], { anyFile: true })).toBe(true);
    // a breakpoint in a file that is not the program's still counts: the run may import it
    expect(entryPause({}, [{ path: path.join(root, 'lib', 'rank.py'), line: 3 }], [], { anyFile: true })).toBe(false);
    // the run-all rule is unchanged: only a breakpoint in the run's own files counts
    expect(entryPause({}, [{ path: app, line: 12 }], [])).toBe(true);
    expect(entryPause({}, [{ path: app, line: 12 }], [app])).toBe(false);
  });
});

describe('parseLaunch for JS/TS', () => {
  it('reads "node": a path is resolved, a bare command stays on PATH, and the launch line names it', () => {
    const ts = path.join(root, 'app.ts');
    expect(parseLaunch({ program: ts, node: '/opt/node/bin/node' }).node).toBe(path.resolve('/opt/node/bin/node'));
    expect(parseLaunch({ program: ts, node: 'node' }).node).toBe('node');
    expect(launchLine(parseLaunch({ program: ts, node: 'node', args: ['--x'] }))).toBe(`node ${ts} --x`);
  });
});
