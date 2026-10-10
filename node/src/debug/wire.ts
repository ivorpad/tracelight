/**
 * NDJSON lines on a file descriptor, from more than one thread.
 *
 * The run child's events and the debugger worker's replies share the event pipe. A line longer
 * than the pipe's atomic write size could interleave with another thread's, so every writer takes
 * one lock in a SharedArrayBuffer (an Int32 spin-then-wait mutex) around its `writeSync`. The
 * main thread creates the buffer and hands it to the worker; the run child's own `send` writes
 * through a `LineWriter` over the same buffer.
 *
 * `toWire` turns one of the debugger's messages into the child's framing (child.ts): a reply to a
 * runner request is `{kind: 'reply', id, msg}` with msg in the protocol's reply vocabulary
 * (`evaluated`, `executed`, `completed`, `debug.result`, `error`); anything else is an event.
 */
import fs from 'node:fs';

const nap = new Int32Array(new SharedArrayBuffer(4));

export function newLock(): SharedArrayBuffer {
  return new SharedArrayBuffer(4);
}

export class LineWriter {
  readonly fd: number;
  private readonly cell: Int32Array;

  constructor(fd: number, lock: SharedArrayBuffer = newLock()) {
    this.fd = fd;
    this.cell = new Int32Array(lock);
  }

  write(event: unknown): void {
    const buf = Buffer.from(JSON.stringify(event) + '\n', 'utf8');
    this.lock();
    try {
      let off = 0;
      while (off < buf.length) {
        try {
          off += fs.writeSync(this.fd, buf, off, buf.length - off);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === 'EPIPE' || code === 'EBADF') break; // the runner is gone
          if (code !== 'EAGAIN') throw e;
          Atomics.wait(nap, 0, 0, 1); // a full non-blocking pipe: let the reader catch up
        }
      }
    } finally {
      this.unlock();
    }
  }

  private lock(): void {
    for (let spins = 0; Atomics.compareExchange(this.cell, 0, 0, 1) !== 0; spins++) {
      if (spins > 100) Atomics.wait(this.cell, 0, 1, 5);
    }
  }

  private unlock(): void {
    Atomics.store(this.cell, 0, 0);
    Atomics.notify(this.cell, 0, 1);
  }
}

const REPLY_TYPES: Record<string, string> = {
  'evaluate.result': 'evaluated',
  'exec.result': 'executed',
  'complete.result': 'completed',
  'debug.result': 'debug.result',
};

export function toWire(message: Record<string, unknown>): Record<string, unknown> {
  const type = String(message.type ?? '');
  if (message.id === undefined || !/\.(result|error)$/.test(type)) return { kind: 'event', event: message };
  const { id, type: _type, ...rest } = message;
  if (type.endsWith('.error')) return { kind: 'reply', id, msg: { type: 'error', message: rest.message } };
  return { kind: 'reply', id, msg: { type: REPLY_TYPES[type] ?? type.replace(/\.result$/, ''), ...rest } };
}
