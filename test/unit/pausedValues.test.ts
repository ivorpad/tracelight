import { describe, expect, it } from 'vitest';
import { pausedFrameLocals, pausedHover, pausedInline, pausedOccurrences, pausedProperty, pausedSummary, pausedShadows, runtimeCapped } from '../../web/pausedValues';

describe('paused source values', () => {
  it('does not attach another lexical binding of the same name to source', () => {
    const lines = ['let x = 1;', '{ let x = 0;', ' use(x);', '}', 'use(x);'];
    const source = lines.join('\n');
    const inner = source.indexOf('{');
    const end = source.indexOf('}') + 1;
    const identifiers = { scopes: [{ start: 0, end: source.length, parent: -1, names: ['x'] }, { start: inner, end, parent: 0, names: ['x'] }], references: [...source.matchAll(/\bx\b/g)].map(m => ({ start: m.index, end: m.index + 1, name: 'x', scope: m.index > inner && m.index < end ? 1 : 0, path: [] })) };
    const pause = { line: 3, start: 1, end: 5, content: source, identifiers, locals: [{ name: 'x', text: '0' }] };
    expect(pausedOccurrences(lines, [], pause).map(o => o.line)).toEqual([2, 3]);
    expect(pausedOccurrences(lines, [], { ...pause, line: 5, locals: [{ name: 'x', text: '1' }] }).map(o => o.line)).toEqual([1, 5]);
    expect(pausedOccurrences(lines, [], { ...pause, identifiers: { scopes: [], references: [] } })).toEqual([]);
    identifiers.scopes[1] = { ...identifiers.scopes[1]!, pending: [{ name: 'x', until: source.indexOf(' use') }] } as typeof identifiers.scopes[number];
    const before = { ...pause, line: 2, locals: [{ name: 'x', text: '1' }] };
    expect(pausedOccurrences(lines, [], before).every(o => o.unavailable)).toBe(true);
    expect(pausedFrameLocals(before)).toEqual([{ name: 'x', text: 'Not available in this pause' }]);
    expect(pausedFrameLocals(pause)).toEqual([{ name: 'x', text: '0' }]);
    expect(pausedFrameLocals({ ...pause, identifiers: { scopes: [], references: [] } })).toEqual([]);
  });

  it('keeps shadow previews at declarations as execution moves through reads', () => {
    const lines = ['const job = next();', 'use(job);', 'return job;'];
    const local = { name: 'job', text: "{ seconds: 2 }" };
    const occurrences = lines.map((line, i) => ({ line: i + 1, start: line.indexOf('job'), end: line.indexOf('job') + 3, local }));
    expect([...pausedShadows(lines, occurrences, { line: 2, start: 1, end: 3, locals: [local] })]).toEqual([[1, 'job = { seconds: 2 }']]);
    expect([...pausedShadows(lines, occurrences, { line: 3, start: 1, end: 3, locals: [local] })]).toEqual([[1, 'job = { seconds: 2 }']]);
    expect(pausedShadows(lines, occurrences.map(o => ({ ...o, unavailable: true })), { line: 1, start: 1, end: 3, locals: [] }).size).toBe(0);
  });

  it('reads only available serialized properties and preserves falsy values', () => {
    const prop = (name: string, value: string, type = 'number') => ({ name, value, type, id: 'p', queryPath: [name] });
    const local = { name: 'job', text: '{}', valueBag: { runtimeKey: 'd:1', data: { id: 'root', type: 'object', queryPath: [], props: [prop('seconds', '0'), prop('flag', 'false', 'bool'), prop('empty', '""', 'str'), prop('nil', 'null', 'null'), prop('absent', 'undefined', 'undefined'), prop('access', '[Getter]', 'getter')] } } };
    expect(pausedProperty(local, ['seconds'])?.text).toBe('0');
    expect(pausedProperty(local, ['flag'])?.text).toBe('false');
    expect(pausedProperty(local, ['empty'])?.text).toBe('""');
    expect(pausedProperty(local, ['nil'])?.text).toBe('null');
    expect(pausedProperty(local, ['absent'])?.text).toBe('undefined');
    expect(pausedProperty(local, ['missing'])).toBeUndefined();
    expect(pausedProperty(local, ['access'])).toBeUndefined();
    expect(pausedProperty({ name: 'x', text: '{}'}, ['seconds'])).toBeUndefined();
  });
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
    expect(pausedHover(local)).toContain('````javascript\n' + text + '\n````');
    expect(runtimeCapped(undefined, text)).toBe(false);
    expect(runtimeCapped(undefined, 'abc…(+200 chars)')).toBe(true);
    expect(pausedHover({ name: 'x', text: 'abc…(+200 chars)' })).toContain('Runtime preview is truncated');
  });
});
