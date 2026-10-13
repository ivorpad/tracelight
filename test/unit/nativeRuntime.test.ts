import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BridgeServer } from '../../web/server';

const bunAvailable = spawnSync('bun', ['--version']).status === 0;
for (const runtime of ['node', 'bun']) {
  it.skipIf(runtime === 'bun' && !bunAvailable)(`${runtime} browser bridge records native execution and reruns disk edits`, async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tl-native-watch-')));
    const file = path.join(dir, 'main.ts');
    fs.writeFileSync(path.join(dir, 'value.json'), '{"answer":42}');
    const read = runtime === 'bun'
      ? `await Bun.file(new URL('./value.json', import.meta.url)).json()`
      : `JSON.parse(readFileSync(new URL('./value.json', import.meta.url), 'utf8'))`;
    const source = `${runtime === 'node' ? "import { readFileSync } from 'node:fs';\n" : ''}const data = ${read};\nconsole.log(data.answer + 0, process.versions.bun ? 'bun' : 'node');`;
    fs.writeFileSync(file, source);
    const server = new BridgeServer({ file, runtime, port: 0, host: '127.0.0.1', watch: true, initialRun: false, open: false, distDir: path.resolve(__dirname, '../../unbuilt-test'), stateDir: dir });
    let socket: WebSocket | undefined;
    try {
      await server.start();
      const port = new URL(server.url).port;
      socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const messages: any[] = [];
      const waiters: { predicate(m: any): boolean; resolve(m: any): void }[] = [];
      socket.onmessage = event => {
        const message = JSON.parse(String(event.data));
        messages.push(message);
        for (const waiter of [...waiters]) if (waiter.predicate(message)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      };
      const next = (predicate: (m: any) => boolean): Promise<any> => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Missing native ${runtime} event: ${JSON.stringify(messages.slice(-4))}`)), 10000);
        const done = (m: any) => { clearTimeout(timer); resolve(m); };
        const hit = messages.find(predicate);
        if (hit) done(hit);
        else waiters.push({ predicate, resolve: done });
      });
      await next(m => m.type === 'hello');
      await server.run('native-fixture');
      const first = await next(m => m.type === 'event' && m.event.type === 'run.finished');
      expect(first.event.exitCode).toBe(0);
      expect(messages.some(m => m.type === 'event' && m.event.type === 'log' && m.event.text === `42 ${runtime}`)).toBe(true);
      fs.writeFileSync(file, source.replace('answer + 0', 'answer + 1'));
      const changed = await next(m => m.type === 'run.begin' && m.reason === 'disk');
      const second = await next(m => m.type === 'event' && m.event.type === 'run.finished' && m.event.runId === changed.runId);
      expect(second.event.exitCode).toBe(0);
      expect(messages.some(m => m.type === 'event' && m.event.type === 'log' && m.event.runId === changed.runId && m.event.text === `43 ${runtime}`)).toBe(true);
    } finally {
      socket?.close();
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 25000);
}
