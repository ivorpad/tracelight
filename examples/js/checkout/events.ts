/** Events published during an order, delivered after the publisher's turn of the event loop. */

export type Handler = (event: Record<string, unknown>) => void;

export class EventBus {
  private readonly handlers = new Map<string, Handler[]>();
  private readonly queue: { name: string; event: Record<string, unknown> }[] = [];
  private draining: Promise<void> | null = null;

  subscribe(name: string, handler: Handler): void {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
  }

  /** Queues the event; its handlers run from `setImmediate`, never inside the caller. */
  publish(name: string, event: Record<string, unknown>): void {
    this.queue.push({ name, event });
    this.draining ??= new Promise((resolve) => setImmediate(() => {
      this.flush();
      resolve();
    }));
  }

  private flush(): void {
    this.draining = null;
    while (this.queue.length) {
      const { name, event } = this.queue.shift()!;
      for (const handler of this.handlers.get(name) ?? []) handler(event);
    }
  }

  /** Resolves once everything published so far was delivered. */
  idle(): Promise<void> {
    return this.draining ?? Promise.resolve();
  }
}
