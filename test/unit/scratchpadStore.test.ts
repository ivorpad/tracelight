import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ScratchpadStore } from '../../web/scratchpadStore';
import type { ScratchState } from '../../web/scratchpadProtocol';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-scratch-library-'));
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));
const state: ScratchState = { id: 'one', title: 'Filter calls', savedVersion: 0, loadedVersion: null, saving: false, saveError: null, open: true, file: '/demo.ts', code: 'const result = input;', inputs: { input: { __scratchUnavailable: 'incomplete array' } }, mocks: {}, inputsText: '{"input":{"__scratchUnavailable":"incomplete array"}}', mocksText: '{}', mockLabels: {}, autoRun: false, revision: 1, status: 'dirty', preparation: { requiresReceiver: true }, result: null, error: null, provenance: { file: '/demo.ts', line: 2, runId: 'd-1', frame: 0, capturedInputs: { input: { __scratchUnavailable: 'incomplete array' } } }, liveExecutionChanged: false };
const baseline = { code: state.code, inputsText: state.inputsText, mocksText: '{}', mockLabels: {}, helperNames: [], requiresReceiver: true };
const snapshot = { id: 'one', title: 'Filter calls', reason: 'create', state, baseline, expectedVersion: 0 };
describe('persistent scratchpad library', () => {
  it('creates named experiments and retains snapshots across store/server instances', () => {
    const store = new ScratchpadStore(directory);
    expect(store.save(snapshot)).toMatchObject({ version: 1, reason: 'create' });
    const reopened = new ScratchpadStore(directory);
    expect(reopened.list()).toMatchObject([{ id: 'one', title: 'Filter calls', version: 1 }]);
    expect(reopened.get('one').state).toEqual(state);
    expect(reopened.get('one').baseline).toEqual(baseline);
  });
  it('keeps code, inputs, fixtures, errors and actual run results in immutable history', () => {
    const store = new ScratchpadStore(directory);
    const result = { values: [{ name: 'result', line: 1, value: { error: 'fixture failure' } }], output: [[1]], error: 'runtime failure', missingMocks: ['emit'], caps: { values: true, output: false } };
    store.save({ ...snapshot, expectedVersion: 1, title: 'Renamed experiment', reason: 'run', state: { ...state, code: 'const result = emit(input);', mocks: { emit: null }, mocksText: '{"emit":null}', mockLabels: { emit: 'synthetic noop' }, status: 'error', result, error: result.error } });
    expect(store.get('one', 1).state.result).toBeNull();
    expect(store.get('one', 2).state.result).toEqual(result);
    expect(store.get('one').state.provenance).toEqual(state.provenance);
    expect(store.history('one').map(e => [e.version, e.reason])).toEqual([[2, 'run'], [1, 'create']]);
    expect(store.list()[0]!.title).toBe('Renamed experiment');
  });
  it('refuses stale writers without replacing a saved experiment', () => {
    const store = new ScratchpadStore(directory);
    expect(() => store.save({ ...snapshot, expectedVersion: 1 })).toThrow('changed in another page');
    expect(store.get('one').version).toBe(2);
    expect(fs.existsSync(path.join(directory, 'one', '.saving'))).toBe(false);
    expect(() => store.get('../one')).toThrow('Invalid scratchpad id');
    expect(() => store.get('one', 999)).toThrow('version not found');
  });
  it('keeps separate scratchpads and ignores incomplete temporary writes', () => {
    const store = new ScratchpadStore(directory);
    store.save({ ...snapshot, id: 'two', state: { ...state, id: 'two' } });
    fs.writeFileSync(path.join(directory, 'one', '.uncommitted.tmp'), 'incomplete');
    expect(store.list()).toHaveLength(2);
    expect(store.history('one')).toHaveLength(2);
  });
});
