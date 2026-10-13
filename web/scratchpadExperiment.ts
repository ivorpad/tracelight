import type { ScratchCommand, ScratchState } from './scratchpadProtocol';

export function validateScratchUpdate(command: ScratchCommand): void {
  if (command.autoRun !== undefined && typeof command.autoRun !== 'boolean') throw new Error('autoRun must be boolean');
  if (command.code !== undefined && (typeof command.code !== 'string' || command.code.length > 100000)) throw new Error('Invalid scratchpad code');
  for (const value of [command.inputs, command.mocks, command.mockLabels]) if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error('Inputs, mocks and mockLabels must be objects');
  if (command.mocks && Object.keys(command.mocks).some(path => typeof command.mockLabels?.[path] !== 'string' || !command.mockLabels[path]!.trim())) throw new Error('Label every supplied mock in mockLabels');
}

export interface ExperimentPort {
  format(code: string): Promise<string>;
  begin(): void;
  open(line: number | undefined, publish: boolean): Promise<void>;
  replace(command: ScratchCommand): void;
  publish(): void;
  finish(): void;
  run(): Promise<void>;
  state(): ScratchState;
}

/** Publish only the complete package, and run once after automatic scheduling is released. */
export async function scratchExperiment(command: ScratchCommand, port: ExperimentPort): Promise<ScratchState> {
  validateScratchUpdate(command);
  if (typeof command.code !== 'string' || !command.code.trim()) throw new Error('experiment needs the complete prepared code');
  const code = await port.format(command.code);
  port.begin();
  try {
    await port.open(command.line, false);
    port.replace({ ...command, code, autoRun: command.autoRun ?? false });
    port.publish();
  } finally { port.finish(); }
  await port.run();
  return port.state();
}
