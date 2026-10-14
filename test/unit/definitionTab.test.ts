import { afterEach, expect, it, vi } from 'vitest';
import { DEFINITION_DOCUMENT, openDefinitionTab } from '../../web/definitionTab';

vi.mock('../../webview/monaco', () => ({ monaco: {
  Uri: { file: (path: string) => path },
  editor: { getModel: () => ({ getValue: () => 'export class Agent {}' }) },
} }));
afterEach(() => vi.unstubAllGlobals());

it('puts source in a separate tab without navigating the caller', () => {
  const setItem = vi.fn();
  const replace = vi.fn();
  const child = { sessionStorage: { setItem }, opener: {}, location: { replace }, close: vi.fn() };
  const open = vi.fn(() => child);
  vi.stubGlobal('window', { open });
  vi.stubGlobal('location', { href: 'http://127.0.0.1:4777/' });
  openDefinitionTab('/lib/agent.js', 93, 14);
  expect(open).toHaveBeenCalledWith('about:blank', '_blank');
  expect(JSON.parse(setItem.mock.calls[0]![1])).toEqual({ path: '/lib/agent.js', content: 'export class Agent {}', line: 93, column: 14 });
  expect(setItem.mock.calls[0]![0]).toBe(DEFINITION_DOCUMENT);
  expect(child.opener).toBeNull();
  expect(replace).toHaveBeenCalledWith('http://127.0.0.1:4777/web/source.html');
});

it('reports blocked popups without replacing the caller', () => {
  vi.stubGlobal('window', { open: () => null });
  expect(() => openDefinitionTab('/lib/agent.js', 93, 14)).toThrow('Allow pop-ups');
});
