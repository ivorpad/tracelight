import { afterEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { tracelightHome } from '../../src/util/paths';
import { libraryCacheDir } from '../../src/features/libraryCache';
import { sessionsDir, socketPathFor } from '../../src/agent/bridgeSupport';

// libraryCache imports vscode for its command; the resolver under test never touches it
vi.mock('vscode', () => ({}));

describe('tracelightHome', () => {
  it('is ~/.tracelight when TRACELIGHT_HOME is unset or empty', () => {
    expect(tracelightHome({})).toBe(path.join(os.homedir(), '.tracelight'));
    expect(tracelightHome({ TRACELIGHT_HOME: '' })).toBe(path.join(os.homedir(), '.tracelight'));
  });

  it('takes TRACELIGHT_HOME as an absolute path, expanding a leading ~', () => {
    expect(tracelightHome({ TRACELIGHT_HOME: '/tmp/pk-home' })).toBe('/tmp/pk-home');
    expect(tracelightHome({ TRACELIGHT_HOME: '~/pk-home' })).toBe(path.join(os.homedir(), 'pk-home'));
    expect(tracelightHome({ TRACELIGHT_HOME: '~' })).toBe(os.homedir());
    expect(tracelightHome({ TRACELIGHT_HOME: 'rel/home' })).toBe(path.resolve('rel/home'));
  });

  it('moves the library cache with it unless TRACELIGHT_CACHE_DIR says otherwise', () => {
    expect(libraryCacheDir({ TRACELIGHT_HOME: '/tmp/pk-home' })).toBe('/tmp/pk-home/cache');
    expect(libraryCacheDir({ TRACELIGHT_HOME: '/tmp/pk-home', TRACELIGHT_CACHE_DIR: '/tmp/c' })).toBe('/tmp/c');
  });
});

describe('sessionsDir', () => {
  const saved = { home: process.env['TRACELIGHT_HOME'], sessions: process.env['TRACELIGHT_SESSIONS_DIR'] };
  afterEach(() => {
    for (const [key, value] of [['TRACELIGHT_HOME', saved.home], ['TRACELIGHT_SESSIONS_DIR', saved.sessions]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('is <TRACELIGHT_HOME>/sessions, the directory the CLI reads, and TRACELIGHT_SESSIONS_DIR wins', () => {
    delete process.env['TRACELIGHT_SESSIONS_DIR'];
    process.env['TRACELIGHT_HOME'] = '/tmp/pk-home';
    expect(sessionsDir()).toBe('/tmp/pk-home/sessions');
    process.env['TRACELIGHT_SESSIONS_DIR'] = '/tmp/pk-sessions';
    expect(sessionsDir()).toBe('/tmp/pk-sessions');
  });
});

describe('socketPathFor', () => {
  it('puts the socket beside its descriptor when the path fits in sun_path', () => {
    expect(socketPathFor('/tmp/pk/sessions', '123-1')).toBe('/tmp/pk/sessions/123-1.sock');
  });

  it('falls back to a short temp path when the home is too deep for a Unix socket', () => {
    const deep = path.join('/tmp', 'x'.repeat(120), 'sessions');
    const sock = socketPathFor(deep, '123-d1');
    expect(path.dirname(sock)).toBe(os.tmpdir());
    expect(path.basename(sock)).toMatch(/^tracelight-123-d1-[0-9a-f]{6}\.sock$/);
    expect(Buffer.byteLength(sock)).toBeLessThanOrEqual(103);
  });
});
