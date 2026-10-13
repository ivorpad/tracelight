import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerWebMcp } from '../../web/agent';
import type { PageHost, Link } from '../../web/pageHost';

const host = {} as PageHost;
const link = {} as Link;
afterEach(() => vi.unstubAllGlobals());
describe('browser WebMCP registration', () => {
  it('registers tools on the current document API, including peeks and restart', () => {
    const registerTool = vi.fn();
    const legacy = vi.fn();
    vi.stubGlobal('document', { modelContext: { registerTool } });
    vi.stubGlobal('navigator', { modelContext: { registerTool: legacy } });
    expect(registerWebMcp(host, link)).toBe(true);
    expect(legacy).not.toHaveBeenCalled();
    const tools = registerTool.mock.calls.map(([tool]) => tool);
    expect(tools.find(t => t.name === 'tracelight_peek')).toBeDefined();
    expect(tools.find(t => t.name === 'tracelight_debug').inputSchema.properties.op.enum).toContain('restart');
  });
  it('supports old navigator previews and does not fake unavailable browser support', () => {
    vi.stubGlobal('document', {});
    const provideContext = vi.fn();
    vi.stubGlobal('navigator', { modelContext: { provideContext } });
    expect(registerWebMcp(host, link)).toBe(true);
    expect(provideContext).toHaveBeenCalledOnce();
    vi.stubGlobal('navigator', {});
    expect(registerWebMcp(host, link)).toBe(false);
  });
});
