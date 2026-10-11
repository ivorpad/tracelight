/**
 * NDJSON client of a kept runner's Unix socket (`keep.ts`)
 * `SocketLink`; a live session's bridge socket (`live.ts`, later) speaks the same lines.
 *
 * `send`, `recv` and `call` (send, then read until the reply that carries the request id, handing
 * every other message to `onEvent`). A connection that cannot be made or that closes rejects
 * with `LinkClosed`.
 */
import { connect, type Socket } from 'node:net';

type Msg = Record<string, any>;

export class LinkClosed extends Error {}

export class SocketLink {
  readonly sock: Socket;
  nextId = 0;
  private buffer = '';
  private readonly queue: Msg[] = [];
  private waiter: ((m: Msg | null) => void) | null = null;
  private closed: string | null = null;

  constructor(sock: Socket) {
    this.sock = sock;
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        let m: Msg;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        this.push(m);
      }
    });
    const gone = (why: string) => {
      if (this.closed === null) this.closed = why;
      const w = this.waiter;
      this.waiter = null;
      w?.(null);
    };
    sock.on('end', () => gone('runner closed the connection'));
    sock.on('close', () => gone('runner closed the connection'));
    sock.on('error', (e) => gone(`runner is gone: ${e.message}`));
  }

  private push(m: Msg): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(m);
    } else this.queue.push(m);
  }

  /** connect to `path`; `timeoutS` bounds the connect only */
  static open(path: string, timeoutS: number | null = null): Promise<SocketLink> {
    return new Promise((res, rej) => {
      const s = connect(path);
      const timer = timeoutS ? setTimeout(() => {
        s.destroy();
        rej(new LinkClosed(`cannot reach ${path}: timed out`));
      }, timeoutS * 1000) : null;
      s.once('connect', () => {
        if (timer) clearTimeout(timer);
        s.removeAllListeners('error');
        res(new SocketLink(s));
      });
      s.once('error', (e) => {
        if (timer) clearTimeout(timer);
        rej(new LinkClosed(`cannot reach ${path}: ${e.message}`));
      });
    });
  }

  send(msg: Msg): unknown {
    if (!('id' in msg)) msg.id = ++this.nextId;
    this.sendRaw(msg);
    return msg.id;
  }

  /** one line, as given: the bridge's token line carries no id */
  sendRaw(msg: Msg): void {
    if (this.closed !== null || this.sock.destroyed) throw new LinkClosed(`runner is gone: ${this.closed ?? 'closed'}`);
    this.sock.write(JSON.stringify(msg) + '\n');
  }

  recv(): Promise<Msg> {
    const m = this.queue.shift();
    if (m) return Promise.resolve(m);
    if (this.closed !== null) return Promise.reject(new LinkClosed(this.closed));
    return new Promise((res, rej) => {
      this.waiter = (x) => (x ? res(x) : rej(new LinkClosed(this.closed ?? 'runner closed the connection')));
    });
  }

  async call(msg: Msg, onEvent?: (m: Msg) => void): Promise<Msg> {
    const rid = this.send(msg);
    for (;;) {
      const reply = await this.recv();
      if (reply.id === rid) return reply;
      onEvent?.(reply);
    }
  }

  close(): void {
    this.closed ??= 'closed';
    // end() flushes what was written (a `shutdown` sent just before) before the socket goes
    this.sock.end(() => this.sock.destroy());
  }
}
