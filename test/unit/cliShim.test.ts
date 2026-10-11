import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SHIM_MARKER, findLauncher, onPath, profileFor, shimScript, shimState, syncShim } from '../../src/features/cliShim';

// the module imports vscode for activation; the helpers under test never touch it
vi.mock('vscode', () => ({}));

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tracelight-shim-'));
}

describe('shimScript', () => {
  it('runs the Node CLI entry with every argument, and $TRACELIGHT_CLI_NODE picks the Node', () => {
    const dir = tmpdir();
    const entry = path.join(dir, "it's", 'tracelight.mjs');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, 'console.log(JSON.stringify(process.argv.slice(2)), process.env.TRACELIGHT_CODE)');
    const file = path.join(dir, 'tracelight');
    fs.writeFileSync(file, shimScript({ entry, node: process.execPath, launcher: '/opt/ed/bin/code', version: '9.9.9' }), { mode: 0o755 });
    const env = { ...process.env, TRACELIGHT_CLI_NODE: '', TRACELIGHT_CODE: '' };
    expect(execFileSync(file, ['why', "a b's"], { env, encoding: 'utf8' }).trim()).toBe(`["why","a b's"] /opt/ed/bin/code`);
    // a launcher the caller already chose is kept
    expect(execFileSync(file, [], { env: { ...env, TRACELIGHT_CODE: '/mine' }, encoding: 'utf8' }).trim()).toBe('[] /mine');
    expect(() => execFileSync(file, [], { env: { ...env, TRACELIGHT_CLI_NODE: path.join(dir, 'no-node') }, stdio: 'pipe' })).toThrow();
  });
  it('leaves TRACELIGHT_CODE out when the editor has no launcher', () => {
    expect(shimScript({ entry: '/r/bin/tracelight.mjs', node: 'node', version: '1' })).not.toContain('TRACELIGHT_CODE');
  });
});

describe('syncShim', () => {
  it('creates only when allowed, then rewrites its own script and nothing else', () => {
    const dir = tmpdir();
    const file = path.join(dir, 'bin', 'tracelight');
    const v1 = `#!/bin/sh\n${SHIM_MARKER} 1\n`;
    expect(syncShim(file, v1, false)).toBe('skipped');
    expect(fs.existsSync(file)).toBe(false);
    expect(syncShim(file, v1, true)).toBe('created');
    expect(fs.statSync(file).mode & 0o111).not.toBe(0);
    expect(syncShim(file, v1, false)).toBe('unchanged');
    expect(syncShim(file, `#!/bin/sh\n${SHIM_MARKER} 2\n`, false)).toBe('updated');
    expect(shimState(file)).toEqual({ kind: 'ours', text: `#!/bin/sh\n${SHIM_MARKER} 2\n` });
  });
  it('never touches a symlink or a script it did not write', () => {
    const dir = tmpdir();
    const link = path.join(dir, 'link');
    fs.symlinkSync('/somewhere/uv/tools/tracelight', link);
    expect(syncShim(link, `${SHIM_MARKER}\n`, true)).toBe('foreign');
    expect(fs.readlinkSync(link)).toBe('/somewhere/uv/tools/tracelight');
    const own = path.join(dir, 'own');
    fs.writeFileSync(own, '#!/bin/sh\necho mine\n');
    expect(syncShim(own, `${SHIM_MARKER}\n`, true)).toBe('foreign');
    expect(fs.readFileSync(own, 'utf8')).toBe('#!/bin/sh\necho mine\n');
  });
});

describe('findLauncher', () => {
  it('takes the editor binary and skips the tunnel ones', () => {
    const root = tmpdir();
    fs.mkdirSync(path.join(root, 'bin'));
    for (const n of ['code-tunnel', 'cursor-tunnel', 'cursor', 'code']) fs.writeFileSync(path.join(root, 'bin', n), '');
    expect(findLauncher(root)).toBe(path.join(root, 'bin', 'code'));
    expect(findLauncher(path.join(root, 'missing'))).toBeUndefined();
  });
});

describe('onPath', () => {
  it('matches the directory with or without a trailing slash, and nothing else', () => {
    expect(onPath('/home/u/.local/bin', '/usr/bin:/home/u/.local/bin/:/bin')).toBe(true);
    expect(onPath('/home/u/.local/bin', '/usr/bin:/home/u/.local/binx')).toBe(false);
    expect(onPath('/home/u/.local/bin', '')).toBe(false);
  });
});

describe('profileFor', () => {
  it('picks the login profile zsh or bash reads, and guesses nothing for other shells', () => {
    expect(profileFor('/bin/zsh', '/h', 'darwin')).toBe('/h/.zprofile');
    expect(profileFor('/bin/bash', '/h', 'darwin')).toBe('/h/.bash_profile');
    expect(profileFor('/usr/bin/bash', '/h', 'linux')).toBe('/h/.profile');
    expect(profileFor('/usr/local/bin/fish', '/h', 'darwin')).toBeUndefined();
    expect(profileFor('', '/h', 'darwin')).toBeUndefined();
  });
});
