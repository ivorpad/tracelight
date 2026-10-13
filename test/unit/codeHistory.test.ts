import { describe, expect, it } from 'vitest';
import { inlineHistory } from '../../web/codeHistory';
import type { PausedValues } from '../../web/pausedValues';

const source = 'let total = 0;\ntotal += 2;\nconsole.log(total);';
const tokens = source.split('\n').map(() => [{ offset: 0, type: 'identifier' }]);
const pause = (text: string, line = 3): PausedValues => ({ content: source, line, start: 1, end: 3, locals: [{ name: 'total', text }], snapshot: `run:${text}:0` });

describe('inline code history', () => {
  it('anchors changes to the declaration and preserves the full hover without duplicating unchanged observations', () => {
    const history = inlineHistory(source, tokens, [pause('0'), pause('0'), pause('2')]);
    expect([...history.keys()]).toEqual([1]);
    expect(history.get(1)?.preview).toBe('total = 0 → 2');
    expect(history.get(1)?.hover).toContain('```javascript\n2\n```');
    expect(history.get(1)?.hover.match(/Paused frame/g)).toHaveLength(2);
  });
  it('refuses snapshots from edited code and declarations not yet available', () => {
    expect(inlineHistory(source + '\n// edited', tokens, [pause('2')]).size).toBe(0);
    expect(inlineHistory(source, tokens, [{ ...pause('2'), line: 0 }]).size).toBe(0);
  });
  it('keeps same-named declarations in different scopes separate', () => {
    const nested = 'let total = 0;\nfunction f() {\nlet total = 7;\nreturn total;\n}';
    const nestedTokens = nested.split('\n').map(() => [{ offset: 0, type: 'identifier' }]);
    const snapshots = [{ ...pause('0'), content: nested, start: 1, end: 1 }, { ...pause('7'), content: nested, start: 3, end: 4, line: 4 }];
    const history = inlineHistory(nested, nestedTokens, snapshots);
    expect(history.get(1)?.preview).toBe('total = 0');
    expect(history.get(3)?.preview).toBe('total = 7');
  });
});
