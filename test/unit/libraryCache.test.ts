import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearCache, clearLibraryCache, describeClear, libraryCacheDir } from '../../src/features/libraryCache';

// the module imports vscode for the command; the helpers under test never touch it
vi.mock('vscode', () => ({}));

describe('libraryCacheDir', () => {
  it('follows TRACELIGHT_CACHE_DIR like the runtime: set moves it, empty turns the cache off, unset is ~/.tracelight/cache', () => {
    expect(libraryCacheDir({ TRACELIGHT_CACHE_DIR: '/tmp/pk' })).toBe('/tmp/pk');
    expect(libraryCacheDir({ TRACELIGHT_CACHE_DIR: '' })).toBeUndefined();
    expect(libraryCacheDir({})).toBe(path.join(os.homedir(), '.tracelight', 'cache'));
    expect(libraryCacheDir({ TRACELIGHT_HOME: '/tmp/tlhome' })).toBe('/tmp/tlhome/cache');
  });
});

describe('clearLibraryCache', () => {
  it('removes the .json/.js entries and temp files at the top level, nothing else, and sums their size', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracelight-cache-test-'));
    try {
      fs.writeFileSync(path.join(dir, 'a'.repeat(40) + '.json'), Buffer.alloc(200));
      fs.writeFileSync(path.join(dir, 'a'.repeat(40) + '.js'), Buffer.alloc(1000));
      fs.writeFileSync(path.join(dir, '.tmp-xyz.js'), Buffer.alloc(310));
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep');
      fs.mkdirSync(path.join(dir, 'sub.js'));
      fs.writeFileSync(path.join(dir, 'sub.js', 'inner.js'), Buffer.alloc(5));
      expect(clearLibraryCache(dir)).toEqual({ removed: 3, bytes: 1510, failed: 0 });
      expect(fs.readdirSync(dir).sort()).toEqual(['notes.txt', 'sub.js']);
      expect(fs.existsSync(path.join(dir, 'sub.js', 'inner.js'))).toBe(true);
      // a second pass finds nothing
      expect(clearLibraryCache(dir)).toEqual({ removed: 0, bytes: 0, failed: 0 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('treats a missing directory as empty', () => {
    expect(clearLibraryCache(path.join(os.tmpdir(), 'tracelight-cache-test-missing-' + process.pid))).toEqual({ removed: 0, bytes: 0, failed: 0 });
  });
});

describe('describeClear', () => {
  it('says what happened in one sentence', () => {
    expect(describeClear(undefined, undefined)).toContain('TRACELIGHT_CACHE_DIR is empty');
    expect(describeClear('/c', { removed: 0, bytes: 0, failed: 0 })).toBe('the library cache at /c is already empty.');
    expect(describeClear('/c', { removed: 1, bytes: 512, failed: 0 })).toBe('removed 1 cached library file (512 B) from /c; the next run with Step Into Library Code on rewrites what it needs.');
    expect(describeClear('/c', { removed: 2454, bytes: 31_200_000, failed: 3 })).toBe('removed 2454 cached library files (31 MB) from /c; the next run with Step Into Library Code on rewrites what it needs. 3 could not be removed (in use or read-only).');
    expect(describeClear('/c', { removed: 0, bytes: 0, failed: 2 })).toBe('none of the 2 cached library files at /c could be removed (in use or read-only).');
  });
});

describe('clearCache', () => {
  it('clears the cache the environment points at and says so', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracelight-cache-env-'));
    try {
      fs.writeFileSync(path.join(dir, 'k.json'), '{}');
      fs.writeFileSync(path.join(dir, 'k.js'), 'x');
      fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep');
      expect(clearCache({ TRACELIGHT_CACHE_DIR: dir })).toContain(`removed 2 cached library files (3 B) from ${dir}`);
      expect(fs.readdirSync(dir)).toEqual(['keep.txt']);
      expect(clearCache({ TRACELIGHT_CACHE_DIR: dir })).toBe(`the library cache at ${dir} is already empty.`);
      expect(clearCache({ TRACELIGHT_CACHE_DIR: '' })).toContain('TRACELIGHT_CACHE_DIR is empty');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
