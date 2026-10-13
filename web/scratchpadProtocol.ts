import type { ScratchResult } from './scratchpadRuntime';

/** All edits affect the visible scratch copy only. Inputs/mocks replace their whole JSON object. */
export interface ScratchCommand {
  op?: 'experiment' | 'open' | 'close' | 'state' | 'update' | 'run' | 'restore';
  /** Compatibility with the original open/close command. */
  open?: boolean;
  line?: number;
  code?: string;
  inputs?: Record<string, unknown>;
  mocks?: Record<string, unknown>;
  mockLabels?: Record<string, string>;
  autoRun?: boolean;
}
export interface ScratchState {
  open: boolean;
  file: string;
  code: string;
  inputs: Record<string, unknown> | null;
  mocks: Record<string, unknown> | null;
  inputsText: string;
  mocksText: string;
  mockLabels: Record<string, string>;
  autoRun: boolean;
  revision: number;
  status: 'empty' | 'dirty' | 'needsPreparation' | 'scheduled' | 'running' | 'completed' | 'error' | 'closed';
  preparation: { requiresReceiver: boolean } | null;
  result: ScratchResult | null;
  error: string | null;
  provenance: { file: string; line: number | null; runId: string | null; frame: number; capturedInputs: Record<string, unknown> } | null;
  liveExecutionChanged: false;
}
