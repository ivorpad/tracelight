import { describe, expect, it } from 'vitest';
import { pausedHover, pausedInline, pausedOccurrences, pausedSummary, runtimeCapped } from '../../web/pausedValues';

describe('paused source values', () => {
  it('finds both arguments in a typed function signature', () => {
    const lines = ['export function processNext(queue: { name: string; seconds: number }[], elapsed: number) {'];
    const locals = [{ name: 'queue', text: '[1, 2, 3]' }, { name: 'elapsed', text: '0' }];
    expect(pausedOccurrences(lines, [[{ offset: 0, type: '' }]], { line: 1, start: 1, end: 1, locals }).map(o => o.local.name)).toEqual(['queue', 'elapsed']);
  });
  it('summarizes containers without serializing them into the code line', () => {
    const queue = { name: 'queue', text: "[ { name: 'A', seconds: 2 }, { name: 'B', seconds: 5 } ]", valueBag: { runtimeKey: 'd:1', data: { id: 'd:1', type: 'array', length: 2, queryPath: [] } } };
    expect(pausedSummary(queue)).toContain("name: 'A'");
    expect(pausedSummary(queue)).toContain('(2 elementos)');
    expect(pausedSummary(queue).length).toBeLessThan(70);
    expect(pausedSummary({ name: 'queue', text: '[unknown preview]' })).toBe('[unknown preview]');
    expect(pausedSummary({ name: 'big', text: '{ ' + 'x'.repeat(200) + ' }' })).toContain('xxx');
    expect(pausedSummary({ name: 'elapsed', text: '0' })).toBe('0');
    expect(pausedHover(queue)).toContain(queue.text);
  });
  it('uses frame bindings and excludes properties, strings, comments and object keys', () => {
    const lines = ['const updated = elapsed + job.seconds;', 'obj.elapsed; "elapsed"; // elapsed', 'const x = { elapsed: 5 };', 'return elapsed;'];
    const locals = [{ name: 'elapsed', text: '0' }, { name: 'job', text: "{ name: 'Send email', seconds: 2 }" }];
    const tokens = [[{ offset: 0, type: '' }], [{ offset: 0, type: '' }, { offset: 13, type: 'string' }, { offset: 22, type: 'comment' }], [{ offset: 0, type: '' }], [{ offset: 0, type: '' }]];
    const found = pausedOccurrences(lines, tokens, { line: 1, start: 1, end: 4, locals });
    expect(found.map((o) => [o.line, o.local.name])).toEqual([[1, 'elapsed'], [1, 'job'], [4, 'elapsed']]);
    expect([...pausedInline(found, 1)]).toEqual([[1, "elapsed = 0 · job = { name: 'Send email', seconds: 2 }"]]);
  });

  it('clips only the ghost while keeping the runtime text intact and inert in the hover', () => {
    const text = '```\n' + 'x'.repeat(200);
    const local = { name: 'queue', text };
    const rows = pausedInline([{ line: 3, start: 0, end: 5, local }], 3);
    expect(rows.get(3)).toContain('…');
    expect(pausedHover(local)).toContain('````text\n' + text + '\n````');
    expect(runtimeCapped(undefined, text)).toBe(false);
    expect(runtimeCapped(undefined, 'abc…(+200 chars)')).toBe(true);
    expect(pausedHover({ name: 'x', text: 'abc…(+200 chars)' })).toContain('Runtime preview is truncated');
  });
});
