/**
 * What plugin code may reach while a run is going, as Pyokka's `pyokka_runtime.execute`:
 * `current` is the running execution from `beforeEach` to `after` (null in the runner process),
 * and `runnerError(message)` emits a `runner.error` for it (nothing outside a run).
 *
 * Plugins outside the runtime get the same object as the second argument of every hook and as
 * `globalThis.__tracelight`, since they cannot import the runtime by name.
 */
export interface Execution {
  filePath: string;
  workspaceRoot: string;
  runId: string | undefined;
  config: Record<string, any>;
  emit(event: Record<string, any>): void;
  /** the user statement running now, as a recorded step and its range (`{rid: -1, step: -1}` when none was recorded) */
  position(): { rid: number; step: number };
}

export const api: { current: Execution | null; runnerError(message: string): void } = {
  current: null,
  runnerError(message: string): void {
    api.current?.emit({ type: 'runner.error', message: String(message) });
  },
};

export function runnerError(message: string): void {
  api.runnerError(message);
}

export function current(): Execution | null {
  return api.current;
}
