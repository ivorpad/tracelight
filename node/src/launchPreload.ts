/** Loaded by Node before the normal project entry, without changing argv, cwd, IPC or exit behavior. */
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { threadId } from 'node:worker_threads';
import { RunChild } from './child.ts';
import { Tracer } from './tracer.ts';
import { runConfig, RUNTIME_VERSION } from './protocol.ts';
import { secrets } from './secrets.ts';
import { getters } from './serialize.ts';
import { api } from './execute.ts';
import { loadPlugins, runAfter, runStage, withHttpPlugin } from './plugins.ts';
import { redact } from './agent/redact.ts';
import { sha256Text } from './agent/save.ts';
import { statementBindings } from './bindings.ts';

const configPath = process.env.TRACELIGHT_LAUNCH_CONFIG;
if (configPath) await start(configPath);

async function start(configPath: string): Promise<void> {
  const setup = JSON.parse(readFileSync(configPath, 'utf8'));
  const child = new RunChild();
  const events: Record<string, any>[] = [], files: Record<string, any>[] = [];
  const started = Date.now();
  child.root = realpathSync(setup.cwd);
  let entry = resolve(process.argv[1] ?? join(child.root, '__launch__.mjs'));
  try { entry = realpathSync(entry); } catch { /* eval or a command without a file */ }
  child.mainPath = entry.startsWith(child.root + sep) && !entry.includes(sep + 'node_modules' + sep) ? entry : join(child.root, '__launch__.mjs');
  child.rawConfig = setup.config;
  child.config = runConfig(setup.config);
  secrets.configure(child.config.secrets.mask, child.config.secrets.names);
  child.emit = event => {
    if (child.done) return;
    // Partial snapshots are superseded at exit, keeping idle servers bounded by the trace cap.
    if (event.type === 'trace' && event.partial) return;
    events.push(event);
    if (event.type === 'file.instrumented') {
      const source = readFileSync(event.path, 'utf8');
      files.push({ fileId: event.fileId, path: event.path, sha256: sha256Text(source), source: redact(source), bindings: statementBindings(source, event.path) });
    }
  };
  const tracer = child.tracer = new Tracer(child.config, child.emit, { registry: child.registry });
  const log = tracer.hooks.log;
  tracer.hooks.log = (rid: number, method: string, ...args: unknown[]) => {
    log(rid, method, ...args);
    const original = (console as any)[method];
    if (typeof original === 'function') original.apply(console, args);
  };
  (globalThis as any).__tk = tracer.hooks;
  getters.resolve = child.config.resolveGetters;
  getters.invoke = fn => { tracer.quiet++; try { return fn(); } finally { tracer.quiet--; } };
  const report = (message: string) => child.emit({ type: 'runner.error', message });
  api.current = { filePath: child.mainPath, workspaceRoot: child.root, runId: `launch-${process.pid}-${threadId}`, config: child.rawConfig, emit: child.emit,
    position: () => ({ rid: tracer.rec.n ? tracer.rec.buffer[(Math.min(tracer.rec.n, tracer.rec.cap) - 1) * 4]! : -1, step: tracer.attributedStep() }) };
  (globalThis as any).__tracelight = api;
  const plugins = await loadPlugins(withHttpPlugin(child.rawConfig, []), [child.root], report, 'beforeEach');
  await runStage(plugins, 'beforeEach', child.rawConfig, report);
  let uncaught: unknown, hasError = false;
  process.on('uncaughtExceptionMonitor', error => { uncaught = error; hasError = true; });
  process.on('exit', exitCode => {
    try {
      runAfter(plugins, child.rawConfig, report);
      tracer.finish(uncaught, hasError);
      if (!files.length) return;
      const file = files.some(f => f.path === child.mainPath) ? child.mainPath : files[0]!.path;
      const finished = { type: 'run.finished', exitCode, stepCount: tracer.nSteps, durationMs: Date.now() - started };
      events.push(finished);
      const meta = { runtimeVersion: RUNTIME_VERSION, language: 'javascript', node: process.versions.node, executable: process.execPath,
        pid: process.pid, parentPid: process.ppid, threadId, file, workspaceRoot: child.root, cwd: process.cwd(), argv: process.argv.slice(2), config: setup.config,
        started: new Date(started).toISOString(), ...finished, files, launch: true };
      writeFileSync(join(setup.out, `run-${process.pid}-${threadId}.json`), JSON.stringify({ meta, events }), { mode: 0o600 });
    } catch (error) { process.stderr.write(`Tracelight could not save this process: ${String(error)}\n`); }
    finally { child.done = true; }
  });
  child.installLoader({});
}
