import { describe, expect, it, vi } from 'vitest';
import { enclosingStart, namesOnLines } from '../../src/debug/debugInlineValues';

// the module registers a provider with vscode; the helpers under test never touch it
vi.mock('vscode', () => ({}));
vi.mock('../../src/debug/dapAdapter', () => ({ DEBUG_TYPE: 'tracelight' }));

describe('JS/TS inline values', () => {
  const JS = [
    "import { readFile } from 'node:fs';",          // 0
    'const LIMIT = 3;',                             // 1
    'class Ranker {',                               // 2
    '  rank(docs: Doc[], k = 60): number {',        // 3
    "    const scores = { total: 0 }; // k here",   // 4
    '    for (const [rank, doc] of docs.entries()) {', // 5
    '      scores[doc.id] = 1 / (k + rank) + this.#bias;', // 6
    "      console.log(`at ${rank}`, $el?.value);",  // 7
  ];
  it('starts at the enclosing method', () => {
    expect(enclosingStart(JS, 7)).toBe(3);
    expect(enclosingStart(['const f = (a) => {', '  return a;', '};'], 1)).toBe(0);
    expect(enclosingStart(['function g(x) {', '  if (x) {', '    x++;', '  }', '}'], 2)).toBe(0);
  });
  it('names variables, not keywords, members, keys, strings or comments', () => {
    const names = (line: number) => namesOnLines(JS, line, line).map((n) => n.name);
    expect(names(3)).toEqual(['rank', 'docs', 'Doc', 'k']);
    expect(names(4)).toEqual(['scores']);
    expect(names(5)).toEqual(['rank', 'doc', 'docs']);
    expect(names(6)).toEqual(['scores', 'doc', 'k', 'rank']);
    expect(names(7)).toEqual(['$el']);
  });
});
