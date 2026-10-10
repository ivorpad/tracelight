import { describe, expect, it } from 'vitest';
import { findSnaps, fenceAt, insideFence, outputPrefix } from '../../src/features/snapFences';

describe('findSnaps', () => {
  it('finds fences anywhere, including inside functions', () => {
    const src = ['x = 1', '"""{{', 'x + 1', '}}"""', '#» 2', 'def f():', '    """{{', '    f()', '    }}"""', ''].join('\n');
    const fences = findSnaps(src);
    expect(fences).toEqual([
      { openLine: 1, closeLine: 3 },
      { openLine: 6, closeLine: 8 },
    ]);
    expect(fenceAt(fences, 7)).toEqual({ openLine: 6, closeLine: 8 });
    expect(fenceAt(fences, 4)).toBeUndefined();
  });

  it('ignores an unterminated fence', () => {
    expect(findSnaps('"""{{\nx\n')).toEqual([]);
  });
});

describe('findSnaps in JS/TS', () => {
  it('finds /*{{ … }}*/ fences, multi-line and on one line, and never Python ones', () => {
    const src = ['let x = 1;', '/*{{', 'x + 1;', '}}*/', '//» 2', 'function f() {', '  /*{{ f(); }}*/', '}', '"""{{', 'x', '}}"""'].join('\n');
    const fences = findSnaps(src, 'javascript');
    expect(fences).toEqual([
      { openLine: 1, closeLine: 3 },
      { openLine: 6, closeLine: 6 },
    ]);
    expect(findSnaps(src)).toEqual([{ openLine: 8, closeLine: 10 }]);
  });
  it('ignores ordinary block comments', () => {
    expect(findSnaps('/* {{ not closed\n */\n/** docs */', 'javascript')).toEqual([]);
  });
  it('a one-line fence holds the code on its own line', () => {
    expect(insideFence({ openLine: 4, closeLine: 4 }, 4)).toBe(true);
    expect(insideFence({ openLine: 1, closeLine: 3 }, 1)).toBe(false);
    expect(insideFence({ openLine: 1, closeLine: 3 }, 2)).toBe(true);
  });
  it('writes output under the comment marker of the language', () => {
    expect(outputPrefix('python')).toBe('#» ');
    expect(outputPrefix('javascript')).toBe('//» ');
  });
});
