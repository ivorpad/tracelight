import { RecordedRun } from '../agent/recorded.ts';
import { AgentError } from '../agent/source.ts';
import { LiveRun } from '../agent/live.ts';
import { descriptorKind, listSessions, pickSession } from '../agent/sessions.ts';

type Msg = Record<string, any>;
export interface SessionArgs { run?: string; session?: string; live?: boolean; step?: number }

/** Descriptors identify a selectable session, never its authentication or transport. */
function descriptor(d: Msg): Msg {
  const string = (key: string) => typeof d[key] === 'string' ? d[key] : null;
  return { session: string('descriptor'), kind: descriptorKind(d), file: string('file'),
    workspace: string('workspace'), displayName: string('displayName'), pid: Number.isInteger(d.pid) ? d.pid : null,
    started: string('started') };
}

function location(value: Msg | null | undefined): Msg | null {
  if (!value || typeof value !== 'object') return null;
  return Object.fromEntries(['step', 'file', 'line', 'col', 'function', 'reason', 'thread']
    .filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}

/** Read state only. Discovery never selects, starts or resumes a program. */
export async function sessionState(args: SessionArgs = {}): Promise<Msg> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new AgentError('session arguments must be an object');
  for (const key of Object.keys(args)) if (!['run', 'session', 'live', 'step'].includes(key)) throw new AgentError(`unknown session argument ${key}`);
  for (const key of ['run', 'session'] as const) if (args[key] !== undefined && (typeof args[key] !== 'string' || !args[key]!.trim())) throw new AgentError(`${key} must be a nonempty string`);
  if (args.live !== undefined && typeof args.live !== 'boolean') throw new AgentError('live must be a boolean');
  if (args.step !== undefined && (!Number.isInteger(args.step) || args.step < 0)) throw new AgentError('step must be a nonnegative integer');
  if (args.run && (args.live || args.session)) throw new AgentError('choose a saved run or a live session, not both');
  if (args.step !== undefined && !args.run) throw new AgentError('step selects saved-run context; live state reports its existing selection and pause');

  if (args.run) {
    const run = new RecordedRun(args.run);
    const step = run.trace.count ? args.step ?? 0 : null;
    if (args.step !== undefined) run.checkStep(args.step);
    const context = step === null ? null : run.context({ step });
    const missingSource = [...run.files.values()].some(file => run.keptSource(String(file.path)) === null);
    return { kind: 'session', mode: 'recorded', run: run.path, runId: run.meta.runId ?? null,
      file: run.meta.file ?? null, finished: run.finished.type === 'run.finished', running: false,
      exitCode: run.finished.exitCode ?? run.meta.exitCode ?? null, stale: run.staleFiles().length > 0,
      livePause: null, recordedSelection: { active: step !== null, step, count: run.trace.count, location: location(context?.location) },
      context, visibleEditor: null,
      capabilities: { readContext: step !== null, readRecording: true, recordedNavigation: step !== null, liveControl: false },
      allowedActions: ['state', 'walkthrough', 'story', 'find', 'graph', 'exceptions', 'http', 'coverage',
        ...(step === null ? [] : ['context', 'step', 'var', 'why', 'origin'])],
      notes: ['Saved-run selection is a read position, not a live pause or a confirmed editor position.',
        ...(!run.finished.type ? ['The recording has no completion event.'] : []),
        ...(missingSource ? ['Some recorded source snapshots are missing; current disk source is not substituted.'] : []),
        ...(run.recording ? ['The recording was truncated.'] : []),
        ...(run.midRun ? ['Recording began partway through execution.'] : [])] };
  }

  const sessions = listSessions();
  if (!args.live && !args.session) return { kind: 'session', mode: 'list', sessions: sessions.map(descriptor),
    visibleEditor: null, notes: ['Descriptors show published sessions, not confirmed pauses or visible editors. Select a session to read its current state.'] };
  const selected = pickSession(sessions, { session: args.session ?? null, prefer: null });
  const source = await LiveRun.open(selected);
  try {
    const state = await source.request({ type: 'state' });
    const pause = state.debug?.paused && typeof state.debug.paused === 'object' ? state.debug.paused : null;
    const count = Number(state.nav?.count ?? 0);
    const recording = state.kind !== 'debug' && count > 0;
    const active = recording && state.nav?.active === true;
    const selectedStep = active ? state.nav.step ?? null : null;
    const liveActive = state.debug?.active === true;
    const readContext = active || !!pause && (state.kind === 'debug' || recording && Number.isInteger(pause.step) && pause.step >= 0 && pause.step < count);
    return { kind: 'session', mode: 'live', session: descriptor(selected), runId: state.runId ?? null,
      file: state.file ?? selected.file, running: state.running === true, finished: state.finished === true,
      stale: state.stale === true, modified: state.modified === true || state.debug?.modified === true,
      livePause: pause ? { ...location(pause), runId: state.runId ?? null, frame: 0 } : null,
      recordedSelection: { active, step: selectedStep, count, location: active ? location(state.location) : null },
      frontier: state.debug?.frontier ?? null, visibleEditor: null,
      capabilities: { readContext, readRecording: recording, recordedNavigation: recording, liveControl: liveActive },
      allowedActions: ['state', ...(recording ? ['walkthrough', 'graph', 'exceptions', 'http', 'var', 'why', 'origin'] : []),
        ...(readContext ? ['context'] : []), ...(active || pause ? ['step'] : []), ...(pause ? ['locals', 'eval', 'exec', 'continue'] : []),
        ...(liveActive ? ['stop', 'restart', 'break', 'watches', ...(!pause && state.running ? ['pause'] : [])] : [])],
      notes: ['livePause is the actual innermost runtime pause; recordedSelection is independent history navigation.',
        'State does not confirm the editor shown or its selected stack frame.',
        ...(pause && !readContext ? ['No recorded context is available at this pause; read live locals instead.'] : []),
        ...(active && pause && selectedStep !== pause.step ? ['The recording is selected behind the live pause. Forward history navigation does not necessarily resume execution.'] : [])] };
  } finally { source.close(); }
}
