import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { buildJsInstallCommand, importLine, missingJsPackage, npmPackageName, packageManagerFor } from '../../src/features/jsPackages';

describe('missingJsPackage', () => {
  it('reads the package from ESM and CommonJS resolution errors', () => {
    expect(missingJsPackage("Cannot find package 'lodash-es' imported from /tmp/a.mjs")).toEqual({ specifier: 'lodash-es', packageName: 'lodash-es' });
    expect(missingJsPackage("Cannot find module '@scope/pkg/sub'\nRequire stack:\n- /tmp/b.cjs")).toEqual({ specifier: '@scope/pkg/sub', packageName: '@scope/pkg' });
    expect(missingJsPackage("Cannot find module 'lodash/map.js' imported from /tmp/a.mjs")?.packageName).toBe('lodash');
  });
  it('ignores missing relative files, builtins and other errors', () => {
    expect(missingJsPackage("Cannot find module './util.js' imported from /tmp/a.mjs")).toBeUndefined();
    expect(missingJsPackage("Cannot find module '/abs/x.js'")).toBeUndefined();
    expect(missingJsPackage("Cannot find module 'node:nope'")).toBeUndefined();
    expect(missingJsPackage('x is not defined')).toBeUndefined();
    expect(npmPackageName('#internal')).toBeUndefined();
  });
});

describe('packageManagerFor', () => {
  const tree = (files: Record<string, string>) => ({
    exists: (p: string) => p in files,
    read: (p: string) => files[p] ?? '',
  });
  it('takes the nearest lockfile going up', () => {
    const t = tree({ [path.resolve('/w/pnpm-lock.yaml')]: '', [path.resolve('/w/app/package.json')]: '{}' });
    expect(packageManagerFor('/w/app/src', undefined, t.exists, t.read)).toBe('pnpm');
    const y = tree({ [path.resolve('/w/yarn.lock')]: '' });
    expect(packageManagerFor('/w/a', undefined, y.exists, y.read)).toBe('yarn');
    const b = tree({ [path.resolve('/w/bun.lock')]: '' });
    expect(packageManagerFor('/w', undefined, b.exists, b.read)).toBe('bun');
  });
  it('falls back to the packageManager field, then npm', () => {
    const t = tree({ [path.resolve('/w/package.json')]: '{"packageManager":"pnpm@9.1.0"}' });
    expect(packageManagerFor('/w/src', undefined, t.exists, t.read)).toBe('pnpm');
    const none = tree({});
    expect(packageManagerFor('/w/src', undefined, none.exists, none.read)).toBe('npm');
  });
  it('stops at the workspace folder', () => {
    const t = tree({ [path.resolve('/yarn.lock')]: '' });
    expect(packageManagerFor('/w/src', '/w', t.exists, t.read)).toBe('npm');
  });
});

describe('buildJsInstallCommand', () => {
  it('uses the project manager, the template, or a private npm prefix per file', () => {
    expect(buildJsInstallCommand({ template: '', manager: 'npm', packageName: 'lodash' })).toBe('npm install lodash');
    expect(buildJsInstallCommand({ template: '', manager: 'pnpm', packageName: 'lodash' })).toBe('pnpm add lodash');
    expect(buildJsInstallCommand({ template: '', manager: 'yarn', packageName: '@a/b' })).toBe('yarn add @a/b');
    expect(buildJsInstallCommand({ template: '{packageManager} add -D {packageName}', manager: 'bun', packageName: 'x' })).toBe('bun add -D x');
    expect(buildJsInstallCommand({ template: 'ignored', manager: 'pnpm', packageName: 'x', target: '/h/my data' })).toBe('npm install --prefix "/h/my data" --no-save --no-package-lock x');
  });
});

describe('importLine', () => {
  it('finds the import, dynamic import or require of a specifier', () => {
    const src = ["import a from './a.js';", "import { map } from 'lodash/map.js';", "const x = require( 'left-pad' );", "await import('chalk');"].join('\n');
    expect(importLine(src, 'lodash/map.js')).toBe(1);
    expect(importLine(src, 'left-pad')).toBe(2);
    expect(importLine(src, 'chalk')).toBe(3);
    expect(importLine(src, 'nope')).toBe(-1);
  });
});
