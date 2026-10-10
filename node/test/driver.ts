/** The runner as a debug client drives it (debug.test.ts, debugRecord.test.ts). */
import { join } from 'node:path';
import { Runner } from '../src/runner.ts';
import { buildRequest } from '../src/cli.ts';
import { project, type Msg } from './helpers.ts';

/** A runner driven message by message: `next(pred)` waits for the next message that matches. */
export class Driver {
  readonly runner: Runner;
  readonly seen: Msg[] = [];
  private waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void; advance: boolean }[] = [];
  private cursor = 0;
  private id = 100;

  constructor() {
    this.runner = new Runner((line) => {
      const msg = JSON.parse(line) as Msg;
      this.seen.push(msg);
      this.flush();
    });
  }

  private flush(): void {
    for (const w of [...this.waiters]) {
      const i = this.seen.findIndex((m, k) => k >= this.cursor && w.pred(m));
      if (i >= 0) {
        if (w.advance) this.cursor = i + 1;
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(this.seen[i]!);
      }
    }
  }

  /** `advance: false` (a reply, matched by id) leaves the cursor: a pause the program sent before the reply is still next */
  next(pred: (m: Msg) => boolean, what = 'message', ms = 8000, advance = true): Promise<Msg> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}; last: ${JSON.stringify(this.seen.slice(-3))}`)), ms);
      this.waiters.push({ pred, resolve: (m) => (clearTimeout(timer), resolve(m)), advance });
      this.flush();
    });
  }

  paused(): Promise<Msg> {
    return this.next((m) => m.type === 'debug.paused', 'debug.paused');
  }

  async ask(req: Msg): Promise<Msg> {
    const id = ++this.id;
    void this.runner.dispatch({ ...req, id, runId: 'dbg' });
    return this.next((m) => m.id === id, `reply to ${req.type} ${req.action ?? ''}`, 8000, false);
  }

  start(files: Record<string, string>, main: string, config: Msg = {}, extra: Msg = {}): string {
    const dir = project(files);
    const path = join(dir, main);
    const req = buildRequest(path, files[main]!, {}, 'dbg');
    delete req.file.content;
    Object.assign(req.config, { debug: true }, config);
    Object.assign(req, extra);
    void this.runner.dispatch({ type: 'hello', id: 0 }).then(() => this.runner.dispatch(req));
    return path;
  }

  close(): void {
    this.runner.child?.kill();
  }
}
