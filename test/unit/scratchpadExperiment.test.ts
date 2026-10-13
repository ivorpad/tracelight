import { describe, it, expect, vi } from 'vitest';
import { scratchExperiment, type ExperimentPort } from '../../web/scratchpadExperiment';
import type { ScratchState } from '../../web/scratchpadProtocol';

describe('complete scratch experiment', () => {
  it('publishes the complete formatted package and runs once without an intermediate automatic run', async () => {
    let suspended = false, code = '', runs = 0, intermediateRuns = 0;
    const events: string[] = [];
    const port: ExperimentPort = {
      format: async () => 'function prompt(input) {\n    return this.normalize(input);\n}\n',
      begin: () => { suspended = true; events.push('begin'); },
      open: async (_line, publish) => { expect(publish).toBe(false); if (!suspended) intermediateRuns++; events.push('copy'); },
      replace: command => { if (!suspended) intermediateRuns++; code = command.code!; expect(command.inputs).toEqual({ receiver: { label: 'captured' } }); expect(command.mockLabels).toEqual({ emit: 'external fixture' }); events.push('replace'); },
      publish: () => { expect(suspended).toBe(true); expect(code).toContain('\n    return'); events.push('publish'); },
      finish: () => { suspended = false; events.push('finish'); },
      run: async () => { expect(suspended).toBe(false); ++runs; events.push('run'); },
      state: () => ({ status: 'completed', liveExecutionChanged: false } as ScratchState),
    };
    const result = await scratchExperiment({ op: 'experiment', code: 'function prompt(input){return this.normalize(input)}', inputs: { receiver: { label: 'captured' } }, mocks: { emit: null }, mockLabels: { emit: 'external fixture' }, autoRun: true }, port);
    expect(result.status).toBe('completed');
    expect(events).toEqual(['begin', 'copy', 'replace', 'publish', 'finish', 'run']);
    expect(runs).toBe(1); expect(intermediateRuns).toBe(0);
  });
  it('rejects an incomplete package or unlabelled fixture before opening', async () => {
    const begin = vi.fn();
    const port = { begin } as unknown as ExperimentPort;
    await expect(scratchExperiment({ op: 'experiment' }, port)).rejects.toThrow('complete prepared code');
    await expect(scratchExperiment({ op: 'experiment', code: 'emit();', mocks: { emit: null } }, port)).rejects.toThrow('Label every supplied mock');
    expect(begin).not.toHaveBeenCalled();
  });
});
