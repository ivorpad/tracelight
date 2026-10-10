import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { isRunnable, languageIdFor, nodeVersionOk, runtimeLanguage, jsRuntimeEntry } from '../../src/runtime/language';

describe('runtime language', () => {
  it('runs JavaScript and TypeScript files, and nothing else', () => {
    expect(runtimeLanguage({ languageId: 'javascript', fileName: '/a/x.js' })).toBe('javascript');
    expect(runtimeLanguage({ languageId: 'typescript', fileName: '/a/x.ts' })).toBe('javascript');
    expect(runtimeLanguage({ languageId: 'plaintext', fileName: '/a/x.mts' })).toBe('javascript');
    expect(runtimeLanguage({ languageId: 'typescriptreact', fileName: '/a/App.tsx' })).toBe('javascript');
    expect(runtimeLanguage({ languageId: 'plaintext', fileName: '/a/App.jsx' })).toBe('javascript');
    expect(isRunnable({ languageId: 'python', fileName: '/a/x.py' })).toBe(false);
    expect(isRunnable({ languageId: 'markdown', fileName: '/a/x.md' })).toBe(false);
  });

  it('finds the runtime entry point in dist/node and in a checkout', () => {
    expect(jsRuntimeEntry('/ext/dist/node', path.join)).toBe(path.join('/ext/dist/node/bin/tracelight.mjs'));
    expect(jsRuntimeEntry('/repo/node', path.join)).toBe(path.join('/repo/node/bin/tracelight.mjs'));
  });

  it('needs Node 22.18 or newer', () => {
    expect(nodeVersionOk([22, 17, 0])).toBe(false);
    expect(nodeVersionOk([22, 18, 0])).toBe(true);
    expect(nodeVersionOk([24, 19, 0])).toBe(true);
  });

  it('opens text by its name, its scope, then its code', () => {
    expect(languageIdFor({ fileName: 'a.tsx' })).toBe('typescriptreact');
    expect(languageIdFor({ fileName: 'a.mjs' })).toBe('javascript');
    expect(languageIdFor({ scope: 'typescript' })).toBe('typescript');
    expect(languageIdFor({ content: 'const x: number = 1;' })).toBe('typescript');
    expect(languageIdFor({ content: 'const x = 1;' })).toBe('javascript');
  });
});
