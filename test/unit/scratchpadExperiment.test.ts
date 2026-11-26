import { describe, it, expect, vi } from 'vitest';
import { scratchExperiment, requireLessonPosition, requireLessonProvenance, type ExperimentPort } from '../../web/scratchpadExperiment';
import type { ConfirmedPosition } from '../../web/bridgeProtocol';
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

describe('pause-aligned learning stage', () => {
  const command = { op: 'lesson' as const, file: '/app/agent.ts', line: 91, code: 'console.log(reply);', explanation: 'Show the captured reply.', autoRun: true };
  const position = { ready: true, blockers: [], live: { file: '/app/agent.ts', line: 91, code: 'console.log(reply);' } } as unknown as ConfirmedPosition;
  it('focuses the live source, publishes atomically, and never executes even if autoRun was requested', async () => {
    const events: string[] = [];
    const run = vi.fn();
    const port: ExperimentPort = {
      format: async (code, operation) => { expect(code).toContain('// Show the captured reply.'); expect(operation).toBe('console.log(reply);'); return code; },
      align: async () => { events.push('align'); return position; },
      begin: () => { events.push('begin'); },
      open: async (_line, publish) => { expect(publish).toBe(false); events.push('copy'); },
      replace: update => { expect(update.autoRun).toBe(false); events.push('replace'); },
      publish: () => { events.push('publish'); },
      finish: () => { events.push('finish'); }, run,
      state: () => ({ status: 'dirty', result: null, autoRun: false } as ScratchState),
    };
    expect((await scratchExperiment(command, port)).result).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(events).toEqual(['align', 'begin', 'copy', 'replace', 'publish', 'finish']);
  });
  it('rejects absent, stale, recorded-only and wrong-location evidence before publishing', async () => {
    const begin = vi.fn();
    for (const bad of [
      { ...position, ready: false, blockers: ['stale source'] },
      { ...position, live: null },
      { ...position, live: { ...position.live!, file: '/app/index.ts' } },
      { ...position, live: { ...position.live!, line: 16 } },
    ]) {
      const port = { format: async (code: string) => code, align: async () => bad, begin } as unknown as ExperimentPort;
      await expect(scratchExperiment(command, port)).rejects.toThrow(/live pause/);
    }
    expect(begin).not.toHaveBeenCalled();
    expect(() => requireLessonPosition({ ...command, file: undefined }, position)).toThrow('expected source');
    expect(() => requireLessonPosition({ ...command, line: 1.5 }, position)).toThrow('expected source');
  });
  it('requires explanation text before publishing, without claiming the text is correct', async () => {
    const begin = vi.fn();
    const port = { begin } as unknown as ExperimentPort;
    for (const explanation of [undefined, '', '   ']) {
      await expect(scratchExperiment({ ...command, explanation }, port)).rejects.toThrow('needs an explanation');
    }
    expect(begin).not.toHaveBeenCalled();
  });
});

it('a saved lesson is bound to its original run, step and frame', () => {
  const provenance = { file: '/app/agent.ts', line: 91, runId: 'run-a', step: 12, frame: 0, capturedInputs: {} };
  const position = { ready: true, blockers: [], live: { ...provenance } } as unknown as ConfirmedPosition;
  expect(() => requireLessonProvenance(provenance, position)).not.toThrow();
  for (const change of [{ runId: 'run-b' }, { step: 20 }, { frame: 1 }]) {
    expect(() => requireLessonProvenance(provenance, { ...position, live: { ...position.live!, ...change } })).toThrow('Pause changed');
  }
});

it('a restarted bridge cannot reuse an old lesson when its short run ID repeats', () => {
  const provenance = { file: '/app/agent.ts', line: 91, runId: 'd-1', step: 12, frame: 0, runStartedAt: 100, capturedInputs: {} };
  const position = { ready: true, blockers: [], live: { ...provenance } } as unknown as ConfirmedPosition;
  expect(() => requireLessonProvenance(provenance, position, 100)).not.toThrow();
  expect(() => requireLessonProvenance(provenance, position, 200)).toThrow('Pause changed');
});
