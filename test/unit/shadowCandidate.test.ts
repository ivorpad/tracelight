import { describe, expect, it, vi } from 'vitest';
import { shadowCandidate } from '../../src/features/shadowValues';

// the module imports vscode for its class; the filter under test never touches it
vi.mock('vscode', () => ({}));

describe('shadowCandidate', () => {
  it('keeps JS/TS statements and skips headers, braces, comments and type declarations', () => {
    for (const t of ['const total = a + b;', 'x.push(4)', 'let y = f(x)', 'count++']) expect(shadowCandidate(t), t).toBe(true);
    for (const t of ['function f(x) {', 'if (x) {', '} else {', '}', '// note', '/* c */', ' * doc', "import fs from 'node:fs';", 'export const x = 1;', 'type A = number;', 'interface B {', 'for (const v of xs) {', 'return x;', '']) expect(shadowCandidate(t), t).toBe(false);
  });
});
