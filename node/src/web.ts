/**
 * `tracelight web`: the browser page (docs/WEB.md) from this runtime's own install, so an agent
 * needs no checkout. The page's bridge is `web/server.js`, which esbuild writes next to the
 * runtime: `<ext>/dist/web` beside `<ext>/dist/node` in an installed extension, `<repo>/dist/web`
 * after `npm run build` in a checkout. Every argument goes to the bridge's own `main`:
 *
 *   tracelight web FILE [--port N] [--open] [--no-watch] [--verbose] [--runtime js|"CMD ARGS"]
 *   tracelight web ctl [--port N] state | step over --say TEXT | debug start | ...
 *
 * The bridge prints its JSON as it does for `node dist/web/server.js ctl`; this module only adds
 * the errors an agent hits before the bridge can answer (no build, a taken port, nothing served).
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV, NAME } from './protocol.ts';

const SRC = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PORT = 4777;

/** where the bridge is: an installed extension's `dist/web` (from `dist/node/src`), then a checkout's build (from `node/src`) */
export function serverCandidates(src = SRC): string[] {
  return [resolve(src, '..', '..', 'web', 'server.js'), resolve(src, '..', '..', 'dist', 'web', 'server.js')];
}

/** the built bridge, or an error that says how to get one */
export function findServer(src = SRC): string {
  const found = serverCandidates(src).find((p) => existsSync(p));
  if (found) return found;
  const root = resolve(src, '..', '..');
  if (existsSync(join(root, 'web', 'server.ts'))) throw new Error(`the browser page is not built in this checkout: run \`npm run build\` in ${root}, which writes dist/web/server.js`);
  throw new Error(`this ${NAME} install has no browser page (no web/server.js next to ${dirname(src)}): update the Tracelight extension, or run \`node <checkout>/dist/web/server.js FILE\` from a built checkout`);
}

/** the port a command names: `--port N`, else $TRACELIGHT_PORT, else 4777 (the bridge's own rule) */
export function portOf(args: string[], env: NodeJS.ProcessEnv = process.env): number {
  const i = args.indexOf('--port');
  if (i >= 0) return Number(args[i + 1]);
  return Number(env[`${ENV}PORT`] ?? DEFAULT_PORT);
}

/** whether something accepts connections on 127.0.0.1:port */
export function listening(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((done) => {
    const s = connect({ host: '127.0.0.1', port });
    const end = (ok: boolean) => {
      s.destroy();
      done(ok);
    };
    s.setTimeout(timeoutMs, () => end(false));
    s.once('connect', () => end(true));
    s.once('error', () => end(false));
  });
}

interface Bridge {
  main(argv: string[]): Promise<number>;
}

/** `tracelight web ARGS`: the bridge's `main`; serving keeps the process alive until Ctrl+C */
export async function cmdWeb(args: string[]): Promise<number> {
  const server = findServer();
  if (args[0] === '-h' || args[0] === '--help') process.stdout.write(`${NAME} web is the browser page's bridge, ${server}; \`${NAME}-web\` below is the same command.\n`);
  if (args[0] === 'ctl') {
    const port = portOf(args);
    if (!(await listening(port))) throw new Error(`no Tracelight page is served on 127.0.0.1:${port}: start one with \`${NAME} web FILE\`${args.includes('--port') ? '' : ', or pass the --port it was started with'}`);
  }
  const bridge = createRequire(import.meta.url)(server) as Bridge;
  let code: number;
  try {
    code = await bridge.main(args);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new Error(`port ${portOf(args)} is taken, most likely by another page (\`${NAME} web ctl --port ${portOf(args)} state\` names its file): pass --port N, or set ${ENV}PORT`);
    throw e;
  }
  // -1: the bridge is serving, and its SIGINT / SIGTERM handlers end the process
  return code >= 0 ? code : new Promise<number>(() => {});
}
