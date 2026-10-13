import { describe, expect, it } from 'vitest';
import { render } from 'preact-render-to-string';
import { ObservedBindings } from '../../web/debugPane';
import type { ValueNode } from '../../src/shared/protocol';

const inspector = { expandNode: async () => null };
const draw = (locals: { name: string; text: string; valueBag?: { data: ValueNode; runtimeKey: string } }[], names: string[] = []) => render(<ObservedBindings locals={locals} expanded={new Set(names)} onToggle={() => {}} inspector={inspector} />);

describe('learning values', () => {
  it('shows falsy scalars in full without a disclosure control', () => {
    const html = draw([{ name: 'count', text: '0' }, { name: 'ready', text: 'false' }, { name: 'empty', text: "''" }, { name: 'absent', text: 'undefined' }]);
    expect(html).not.toContain('<button');
    for (const text of ['0', 'false', 'undefined']) expect(html).toContain(text);
  });
  it('does not offer an empty array a fake expansion', () => {
    expect(draw([{ name: 'items', text: '[]', valueBag: { runtimeKey: 'k', data: { id: 'a', type: 'array', length: 0, queryPath: [] } } }])).not.toContain('<button');
  });
  it('shows object properties once when opened, without repeating the full preview', () => {
    const html = draw([{ name: 'entry', text: "{ label: 'hello', count: 0 }", valueBag: { runtimeKey: 'k', data: { id: 'o', type: 'object', value: "{ label: 'hello', count: 0 }", queryPath: [], props: [{ id: 's', name: 'label', type: 'str', value: 'hello', queryPath: ['label'] }, { id: 'n', name: 'count', type: 'number', value: '0', queryPath: ['count'] }] } } }], ['entry']);
    expect(html).not.toContain('<pre>');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('pkw-value-name');
    expect(html).toContain('count');
    expect(html).toContain('&quot;hello&quot;');
    expect(html.match(/pkw-observed-preview/g)).toHaveLength(1);
    // The full preview remains only in the native hover title.
    expect(html.match(/count: 0/g)).toHaveLength(1);
  });
  it('makes an empty string visible inside an expanded object', () => {
    const html = draw([{ name: 'record', text: "{ empty: '' }", valueBag: { runtimeKey: 'k', data: { id: 'o', type: 'object', queryPath: [], props: [{ id: 's', name: 'empty', type: 'str', value: '', queryPath: ['empty'] }] } } }], ['record']);
    expect(html).toContain('&quot;&quot;');
  });
  it('gives a clipped string an explicit disclosure and full text on open', () => {
    const text = 'a'.repeat(90);
    expect(draw([{ name: 'message', text }])).toContain('aria-expanded="false"');
    expect(draw([{ name: 'message', text }], ['message'])).toContain(`<pre>${text}</pre>`);
  });
});
