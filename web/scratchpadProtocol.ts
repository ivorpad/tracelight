import type { ScratchResult } from './scratchpadRuntime';

/** All edits affect the visible scratch copy only. Inputs/mocks replace their whole JSON object. */
export interface ScratchCommand {
  op?: 'experiment' | 'open' | 'close' | 'state' | 'update' | 'run' | 'restore' | 'create' | 'save' | 'list' | 'load' | 'history';
  id?: string;
  title?: string;
  file?: string;
  /** Load a saved history version; omitted selects the latest. */
  version?: number;
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
  diagnostics?: {code?:string;message:string;line:number;severity:number}[];
  /** control replies only: the TypeScript worker checked this exact code, it has no errors, and nothing failed or waits for preparation */
  ready?: boolean;
  id: string | null;
  title: string;
  savedVersion: number;
  loadedVersion: number | null;
  saving: boolean;
  saveError: string | null;
  scratchpads?: ScratchSummary[];
  history?: ScratchSummary[];
  entry?: ScratchEntry;
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


export interface ScratchBaseline { code: string; inputsText: string; mocksText: string; mockLabels: Record<string, string>; helperNames: string[]; requiresReceiver?: boolean }
export interface ScratchEntry {
  id: string;
  title: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  reason: string;
  state: ScratchState;
  baseline: ScratchBaseline;
}
export interface ScratchSummary { id: string; title: string; version: number; createdAt: string; updatedAt: string; reason: string; file: string; status: ScratchState['status']; error: string | null }
