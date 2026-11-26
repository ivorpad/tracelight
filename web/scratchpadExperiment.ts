import type { ConfirmedPosition } from './bridgeProtocol';
import type { ScratchCommand, ScratchState } from './scratchpadProtocol';

export function validateScratchUpdate(command: ScratchCommand): void {
  if (command.autoRun !== undefined && typeof command.autoRun !== 'boolean') throw new Error('autoRun must be boolean');
  if (command.code !== undefined && (typeof command.code !== 'string' || command.code.length > 100000)) throw new Error('Invalid scratchpad code');
  for (const value of [command.inputs, command.mocks, command.mockLabels]) if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error('Inputs, mocks and mockLabels must be objects');
  if (command.mocks && Object.keys(command.mocks).some(path => typeof command.mockLabels?.[path] !== 'string' || !command.mockLabels[path]!.trim())) throw new Error('Label every supplied mock in mockLabels');
}

export interface ExperimentPort {
  align?(): Promise<ConfirmedPosition>;
  format(code: string, operation?: string): Promise<string>;
  begin(): void;
  open(line: number | undefined, publish: boolean): Promise<void>;
  replace(command: ScratchCommand): void;
  publish(): void;
  finish(): void;
  run(): Promise<void>;
  state(): ScratchState;
}

/** Refuse a lesson whose live frame differs from the requested teaching location. */
export function requireLessonPosition(command: ScratchCommand, position: ConfirmedPosition): void {
  if (!command.file || !Number.isInteger(command.line) || command.line! < 1) throw new Error('lesson needs the expected source file and paused line');
  if (!position.ready || !position.live) throw new Error(`lesson needs a matching visible live pause: ${position.blockers.join('; ')}`);
  if (position.live.file !== command.file || position.live.line !== command.line) throw new Error('lesson target differs from the live pause; set a breakpoint and pause at the requested file and line first');
}

/** Saved lessons retain the exact pause they were copied from. */
export function requireLessonProvenance(provenance: ScratchState['provenance'], position: ConfirmedPosition, runStartedAt?: number): void {
  if (!provenance) throw new Error('Lesson has no copied pause provenance');
  requireLessonPosition({ file: provenance.file, line: provenance.line ?? undefined }, position);
  const live = position.live!;
  if ((runStartedAt !== undefined && provenance.runStartedAt !== runStartedAt) || provenance.runId !== live.runId || provenance.frame !== live.frame || provenance.step !== live.step) throw new Error('Pause changed since lesson preparation; prepare the stage again at the current pause');
}

/** Publish only the complete package. Lessons remain unrun beside their matching live pause. */
export async function scratchExperiment(command: ScratchCommand, port: ExperimentPort): Promise<ScratchState> {
  validateScratchUpdate(command);
  if (typeof command.code !== 'string' || !command.code.trim()) throw new Error('experiment needs the complete prepared code');
  const lesson = command.op === 'lesson';
  if (lesson && (!command.file || !Number.isInteger(command.line) || command.line! < 1)) throw new Error('lesson needs the expected source file and paused line');
  let operation: string | undefined;
  if (lesson) {
    if (typeof command.explanation !== 'string' || !command.explanation.trim()) throw new Error('lesson needs an explanation beside the copied source operation');
    if (!port.align) throw new Error('lesson needs live source alignment');
    const position = await port.align();
    requireLessonPosition(command, position);
    operation = position.live?.code?.trim();
    if (!operation) throw new Error('lesson needs the paused source operation');
  }
  const annotated = lesson ? `${command.explanation!.trim().split(/\r?\n/).map(line => `// ${line}`).join('\n')}\n\n${command.code}` : command.code;
  const code = await port.format(annotated, operation);
  port.begin();
  try {
    await port.open(command.line, false);
    port.replace({ ...command, code, autoRun: lesson ? false : command.autoRun ?? false });
    port.publish();
  } finally { port.finish(); }
  if (!lesson) await port.run();
  return port.state();
}
