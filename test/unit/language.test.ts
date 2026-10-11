import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { isRunnable, nodeVersionOk, runtimeLanguage, jsRuntimeEntry } from '../../src/runtime/language';

describe('runtime language', () => {
  it('runs Python on pyokka_runtime and JavaScript / TypeScript on Tracelight', () => {
    expect(runtimeLanguage({ languageId: 'python', fileName: '/a/x.py' })).toBe('python');
    expect(runtimeLanguage({ languageId: 'javascript', fileName: '/a/x.js' })).toBe('javascript');
    expect(runtimeLanguage({ languageId: 'typescript', fileName: '/a/x.ts' })).toBe('javascript');
    expect(runtimeLanguage({ languageId: 'plaintext', fileName: '/a/x.mts' })).toBe('javascript');
    expect(runtimeLanguage({ languageId: 'typescriptreact', fileName: '/a/App.tsx' })).toBe('javascript');
    expect(runtimeLanguage({ languageId: 'plaintext', fileName: '/a/App.jsx' })).toBe('javascript');
    expect(isRunnable({ languageId: 'markdown', fileName: '/a/x.md' })).toBe(false);
  });

  it('finds Tracelight next to the Python runtime, in dist and in a checkout', () => {
    expect(jsRuntimeEntry('/ext/dist/python', path.join, path.dirname)).toBe(path.join('/ext/dist/node/bin/tracelight.mjs'));
    expect(jsRuntimeEntry('/repo/python', path.join, path.dirname)).toBe(path.join('/repo/node/bin/tracelight.mjs'));
  });

  it('needs Node 22.18 or newer', () => {
    expect(nodeVersionOk([22, 17, 0])).toBe(false);
    expect(nodeVersionOk([22, 18, 0])).toBe(true);
    expect(nodeVersionOk([24, 19, 0])).toBe(true);
  });
});
