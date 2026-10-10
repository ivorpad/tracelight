import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildRequest, runOnce } from '../src/cli.ts';
import { decodeSteps } from '../src/protocol.ts';

export type Msg = Record<string, any>;

// library instrumentation is cached; tests keep theirs out of ~/.tracelight
process.env.TRACELIGHT_CACHE_DIR ??= mkdtempSync(join(tmpdir(), 'tracelight-cache-'));

/** write `files` (relative path -> text) into a fresh directory; returns its path */
export function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'tracelight-test-'));
  for (const [rel, text] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  return dir;
}

export interface Run {
  events: Msg[];
  finished: Msg;
  of(type: string): Msg[];
  logs(): Msg[];
  /** the final trace's steps as [rid, scope, depth, flags] */
  steps(): number[][];
  scopes(): Msg[];
  /** the source line of a global rid */
  line(rid: number): number;
  file(fileId: number): Msg;
}

export async function run(files: Record<string, string>, main: string, extra: Msg = {}, config: Msg = {}, content?: string): Promise<Run> {
  const dir = project(files);
  const path = join(dir, main);
  const req = buildRequest(path, files[main]!, {}, `t-${Math.random().toString(36).slice(2)}`);
  if (content === undefined) delete req.file.content;
  else req.file.content = content;
  Object.assign(req.config, { timeoutMs: 10000 }, config);
  Object.assign(req, extra);
  const { events, finished } = await runOnce(req);
  return wrap(events, finished);
}

export function wrap(events: Msg[], finished: Msg): Run {
  const instr = events.filter((e) => e.type === 'file.instrumented');
  const trace = events.filter((e) => e.type === 'trace' && !e.partial).pop();
  return {
    events,
    finished,
    of: (type) => events.filter((e) => e.type === type),
    logs: () => events.filter((e) => e.type === 'log'),
    steps: () => {
      const q = decodeSteps(trace?.steps ?? '');
      const out: number[][] = [];
      for (let i = 0; i < q.length; i += 4) out.push([q[i]!, q[i + 1]!, q[i + 2]!, q[i + 3]!]);
      return out;
    },
    scopes: () => trace?.scopes ?? [],
    line: (rid) => {
      for (const f of instr) {
        const local = rid - f.rangeBase;
        if (local >= 0 && local < f.ranges.length) return f.ranges[local][0];
      }
      return -1;
    },
    file: (fileId) => instr.find((f) => f.fileId === fileId)!,
  };
}
