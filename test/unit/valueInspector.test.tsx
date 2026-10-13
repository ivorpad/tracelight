import { describe, expect, it } from 'vitest';
import { render } from 'preact-render-to-string';
import { ValueSyntax, ValueTree } from '../../web/debugPane';
import type { ValueNode } from '../../src/shared/protocol';

describe('live value inspector', () => {
  it('shows JavaScript collection previews including empty arrays', () => {
    for (const [node, expected] of [
      [{ type: 'list', length: 0, props: [] }, '[]'],
      [{ type: 'list', length: 1, props: [{ name: '0', type: 'number', value: '1', id: 'item', queryPath: [] }] }, 'Array'],
      [{ type: 'dict', props: [] }, '{}'],
    ] as [Omit<ValueNode, 'id' | 'queryPath'>, string][]) {
      const html = render(<ValueTree name="value" node={{ ...node, props: [...node.props ?? []], id: 'root', queryPath: [] }} debug={{ expandNode: async () => null }} />);
      expect(html.replace(/<[^>]*>/g, '')).toContain(expected);
      expect(html).not.toMatch(/>list<|>dict</);
    }
  });
  it('shows runtime callback context and a source action without invoking it', () => {
    const html = render(<ValueTree name="emit" initialOpen node={{ type: 'function', value: '[Function: (anonymous)]', id: 'f', queryPath: [], functionSource: 'event => processEvent(event)', functionLocation: { path: '/w/agent.js', line: 289, column: 10 } }} debug={{ expandNode: async () => { throw new Error('must not expand a callback'); } }} onOpenSource={() => { throw new Error('must not navigate until clicked'); }} />);
    expect(html).toContain('processEvent');
    expect(html).toContain('Open function source');
    expect(html).toContain('289');
  });
  it('opens a card root immediately with captured fields', () => {
    const html = render(<ValueTree name="arguments" initialOpen node={{ type: 'dict', id: 'args', queryPath: [], props: [{ name: 'id', type: 'str', value: 'email', id: 'id', queryPath: ['id'] }] }} debug={{ expandNode: async () => null }} />);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('email');
    expect(html).toContain('pkw-token-str');
  });
  it('colors captured JavaScript values while keeping markup inert', () => {
    const html = render(<ValueSyntax text={'{ name: "<img src=x onerror=alert(1)>", seconds: 2, active: false }'} />);
    expect(html).toContain('pkw-token-str');
    expect(html).toContain('pkw-token-num');
    expect(html).toContain('pkw-token-kw');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
  });

  it('retains complete string text and offers expansion for long or multiline values', () => {
    const text = 'first line\n' + 'x'.repeat(400) + '\nlast line';
    const html = render(<ValueTree name="content" node={{ type: 'str', value: text, id: 's', queryPath: [] }} debug={{ expandNode: async () => null }} />);
    expect(html).toContain('aria-label="Inspect content"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('x'.repeat(400));
    expect(html).toContain('last line');
    expect(html).not.toContain('truncated');
  });
});
