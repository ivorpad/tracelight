/** JavaScriptCore's remote inspector, used by Bun's debugger worker instead of Node Session. */
import { EventEmitter } from 'node:events';

export class BunInspector extends EventEmitter {
  private readonly socket: WebSocket;
  private readonly opened: Promise<void>;
  private nextId = 0;
  private readonly pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();

  constructor(url: string) {
    super();
    this.socket = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.socket.close(); reject(new Error('Bun inspector connection timed out after 10 seconds')); }, 10000);
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      const failed = () => { clearTimeout(timer); reject(new Error('Cannot connect to Bun inspector')); };
      this.socket.addEventListener('error', failed, { once: true });
      this.socket.addEventListener('close', failed, { once: true });
    });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else {
          const reply = message.result ?? {};
          if (reply.properties && !reply.result) reply.result = reply.properties;
          if (reply.wasThrown) reply.exceptionDetails = { exception: reply.result, text: reply.result?.description ?? 'Bun evaluation threw' };
          waiter.resolve(reply);
        }
      } else this.emit(message.method, { params: message.params });
    });
    this.socket.addEventListener('close', () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error('Bun inspector disconnected'));
      this.pending.clear();
    });
  }

  async post(method: string, params: Record<string, any> = {}): Promise<any> {
    await this.opened;
    if (params.throwOnSideEffect && params.expression !== '_tk_scope_') {
      throw new Error('Bun inspector cannot guarantee side-effect-free evaluation; read captured locals instead');
    }
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  disconnect(): void { this.socket.close(); }
}
