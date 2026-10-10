import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { looksLikeProject } from '../../src/config/project';

describe('looksLikeProject', () => {
  it('detects marker files and ignores scratch folders', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tracelight-proj-'));
    const scratch = path.join(root, 'scratch');
    const proj = path.join(root, 'proj');
    fs.mkdirSync(scratch);
    fs.mkdirSync(proj);
    fs.writeFileSync(path.join(proj, 'tsconfig.json'), '{}');
    expect(looksLikeProject([scratch])).toBe(false);
    expect(looksLikeProject([undefined, scratch, proj])).toBe(true);
    expect(looksLikeProject([path.join(root, 'missing')])).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('takes a package.json, and not a Python project, as a project', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tracelight-proj-'));
    fs.writeFileSync(path.join(root, 'pyproject.toml'), '');
    expect(looksLikeProject([root])).toBe(false);
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    expect(looksLikeProject([root])).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
