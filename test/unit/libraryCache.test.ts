import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearBothCaches, clearLibraryCache, describeClear, jsLibraryCacheDir, libraryCacheDir } from '../../src/features/libraryCache';
import { JS_RUNTIME_ENV, JS_RUNTIME_NAME } from '../../src/runtime/jsRuntimeName';

// the module imports vscode for the command; the helpers under test never touch it
vi.mock('vscode', () => ({}));

describe('libraryCacheDir', () => {
  it('follows PYOKKA_CACHE_DIR like the runtime: set moves it, empty turns the cache off, unset is ~/.pyokka/cache', () => {
    expect(libraryCacheDir({ PYOKKA_CACHE_DIR: '/tmp/pk' })).toBe('/tmp/pk');
    expect(libraryCacheDir({ PYOKKA_CACHE_DIR: '' })).toBeUndefined();
    expect(libraryCacheDir({})).toBe(path.join(os.homedir(), '.pyokka', 'cache'));
  });
});

describe('clearLibraryCache', () => {
  it('removes the .bin entries and temp files at the top level, nothing else, and sums their size', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyokka-cache-test-'));
    try {
      fs.writeFileSync(path.join(dir, 'a'.repeat(40) + '.bin'), Buffer.alloc(1200));
      fs.writeFileSync(path.join(dir, 'b'.repeat(40) + '.bin'), Buffer.alloc(300));
      fs.writeFileSync(path.join(dir, '.tmp-xyz.bin'), Buffer.alloc(10));
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep');
      fs.mkdirSync(path.join(dir, 'sub.bin'));
      fs.writeFileSync(path.join(dir, 'sub.bin', 'inner.bin'), Buffer.alloc(5));
      expect(clearLibraryCache(dir)).toEqual({ removed: 3, bytes: 1510, failed: 0 });
      expect(fs.readdirSync(dir).sort()).toEqual(['notes.txt', 'sub.bin']);
      expect(fs.existsSync(path.join(dir, 'sub.bin', 'inner.bin'))).toBe(true);
      // a second pass finds nothing
      expect(clearLibraryCache(dir)).toEqual({ removed: 0, bytes: 0, failed: 0 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('treats a missing directory as empty', () => {
    expect(clearLibraryCache(path.join(os.tmpdir(), 'pyokka-cache-test-missing-' + process.pid))).toEqual({ removed: 0, bytes: 0, failed: 0 });
  });
});

describe('describeClear', () => {
  it('says what happened in one sentence', () => {
    expect(describeClear(undefined, undefined)).toContain('PYOKKA_CACHE_DIR is empty');
    expect(describeClear('/c', { removed: 0, bytes: 0, failed: 0 })).toBe('the library cache at /c is already empty.');
    expect(describeClear('/c', { removed: 1, bytes: 512, failed: 0 })).toBe('removed 1 cached library file (512 B) from /c; the next run with Step Into Library Code on rewrites what it needs.');
    expect(describeClear('/c', { removed: 2454, bytes: 31_200_000, failed: 3 })).toBe('removed 2454 cached library files (31 MB) from /c; the next run with Step Into Library Code on rewrites what it needs. 3 could not be removed (in use or read-only).');
    expect(describeClear('/c', { removed: 0, bytes: 0, failed: 2 })).toBe('none of the 2 cached library files at /c could be removed (in use or read-only).');
  });
});

describe('the JS/TS runtime cache', () => {
  it('follows the JS runtime env prefix and name', () => {
    expect(jsLibraryCacheDir({ [`${JS_RUNTIME_ENV}CACHE_DIR`]: '/tmp/js' })).toBe('/tmp/js');
    expect(jsLibraryCacheDir({ [`${JS_RUNTIME_ENV}CACHE_DIR`]: '' })).toBeUndefined();
    expect(jsLibraryCacheDir({})).toBe(path.join(os.homedir(), `.${JS_RUNTIME_NAME}`, 'cache'));
    expect(jsLibraryCacheDir({ [`${JS_RUNTIME_ENV}HOME`]: '/tmp/jshome' })).toBe('/tmp/jshome/cache');
  });
  it('clears the .json/.js entries of the JS cache along with the Python one', () => {
    const py = fs.mkdtempSync(path.join(os.tmpdir(), 'pyokka-cache-py-'));
    const js = fs.mkdtempSync(path.join(os.tmpdir(), 'pyokka-cache-js-'));
    try {
      fs.writeFileSync(path.join(py, 'a.bin'), Buffer.alloc(10));
      fs.writeFileSync(path.join(js, 'k.json'), '{}');
      fs.writeFileSync(path.join(js, 'k.js'), 'x');
      fs.writeFileSync(path.join(js, 'keep.txt'), 'keep');
      const message = clearBothCaches({ PYOKKA_CACHE_DIR: py, [`${JS_RUNTIME_ENV}CACHE_DIR`]: js });
      expect(message).toContain(`removed 1 cached library file (10 B) from ${py}`);
      expect(message).toContain(`JavaScript/TypeScript: removed 2 cached library files`);
      expect(fs.readdirSync(js)).toEqual(['keep.txt']);
      // an empty JS cache adds nothing to the sentence
      expect(clearBothCaches({ PYOKKA_CACHE_DIR: py, [`${JS_RUNTIME_ENV}CACHE_DIR`]: js })).toBe(`the library cache at ${py} is already empty.`);
    } finally {
      fs.rmSync(py, { recursive: true, force: true });
      fs.rmSync(js, { recursive: true, force: true });
    }
  });
});
