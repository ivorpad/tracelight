import { resolve } from 'node:path';
import { History } from '../agent/history.ts';
import { RecordedRun } from '../agent/recorded.ts';
import { AgentError } from '../agent/source.ts';
import { MAX_LOCALS_ENTRIES } from '../agent/protocol.ts';

export type SeekArgs = { run: string; value?: string; equals?: string; file?: string; line?: number; occurrence?: 'first' | 'last' };

/** Locate recorded evidence without evaluating an expression or moving a live program. */
export function seekRecorded(args: SeekArgs): Record<string, any> {
  const { run: path, value, equals, file, line, occurrence = 'first' } = args;
  if (typeof path !== 'string' || !path.trim()) throw new AgentError('run must name a saved recording');
  if (!['first', 'last'].includes(occurrence)) throw new AgentError('occurrence must be first or last');
  const byValue = value !== undefined || equals !== undefined;
  if (byValue && (typeof value !== 'string' || !value.trim() || typeof equals !== 'string' || file !== undefined || line !== undefined)) {
    throw new AgentError('choose value and equals, or file and line');
  }
  if (!byValue && (typeof file !== 'string' || !file.trim() || !Number.isInteger(line) || line! < 1)) {
    throw new AgentError('choose value and equals, or file and a positive line');
  }
  const run = new RecordedRun(resolve(path));
  const result: Record<string, any> = { kind: 'destination', mode: 'recorded', run: resolve(path), found: false,
    query: { ...(byValue ? { value, equals } : { file, line }), occurrence },
    notes: ['Search covers recorded execution only. No live execution or navigation occurred.'] };
  if (run.recording || run.midRun || !run.finished.type) result.notes.push('This recording is incomplete; no match does not prove the event never occurred.');
  if (run.localsEntries.length >= MAX_LOCALS_ENTRIES) result.notes.push('The local-value recording reached its limit. Later matches may be missing.');
  if (!run.localsEntries.length && byValue) result.notes.push('No local-value changes were recorded; this search can only find matching logged values.');
  if (run.sortedFiles.some(file => run.keptSource(String(file.path)) === null)) result.notes.push('Some recorded source snapshots are missing; current disk source is not substituted.');
  if (byValue) {
    const history = new History(run);
    const rows = history.rows(value!).filter(row => row.name === value && row.text === equals && ['locals', 'value'].includes(row.source));
    const selected = occurrence === 'last' ? rows.at(-1) : rows[0];
    result.matches = rows.length;
    if (!selected) return result;
    const observed = selected.source === 'locals' ? history.localsByName.get(selected.name)?.find(([step, scope, text]) =>
      scope === selected.scopeId && text === selected.text && history.attribute(step, scope, selected.name) === selected.step)?.[0] : undefined;
    result.selection = { changeStep: selected.step, observedStep: observed ?? null };
    result.evidence = selected;
    result.step = observed ?? selected.step;
    if (observed === undefined) result.notes.push('The value is attached to its recorded event; context locals are pre-execution and may differ.');
  } else {
    const selectedFile = run.resolveFile(file!);
    const steps = run.trace.stepsOnLine(Number(selectedFile.fileId), line!);
    result.matches = steps.length;
    if (!steps.length) return result;
    result.step = occurrence === 'last' ? steps.at(-1) : steps[0];
  }
  result.found = true;
  result.context = run.context({ step: result.step });
  result.next = { tool: 'tracelight_step', arguments: { run: result.run, step: result.step } };
  return result;
}
