/**
 * The runtime's HTTP plugin (`BUILTIN.http`), as Pyokka's `plugins/http_record.py`: `config.http`
 * record or replay, or observe only ("off"), on `@mswjs/interceptors` (http/record.ts). Installed
 * in `beforeEach`, before the main file is imported; `after` puts `{http, replayed?}` on
 * `run.finished` and removes the interceptors.
 */
import type { Execution } from '../execute.ts';
import { installHttp, type HttpMode, type HttpSession } from '../http/record.ts';

let session: HttpSession | null = null;

export function beforeEach(config: Record<string, any>, api: { current: Execution | null }): void {
  const cur = api.current;
  if (!cur) return;
  const mode = (config.http === 'record' || config.http === 'replay' ? config.http : 'off') as HttpMode;
  session = installHttp({ mode, file: cur.filePath, workspaceRoot: cur.workspaceRoot, emit: (e) => cur.emit(e), position: () => cur.position() });
}

export function after(): Record<string, unknown> | undefined {
  const s = session;
  session = null;
  return s?.finish();
}
