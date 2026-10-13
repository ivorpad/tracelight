/** Run the project's actual command, carrying a recording preload into inherited Node children. */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { redact } from './agent/redact.ts';

export async function launch(args: string[]): Promise<number> {
  const split = args.indexOf('--');
  if (split < 0 || split === args.length - 1) throw new Error('usage: tracelight launch --out DIRECTORY [--cwd DIRECTORY] [--only PATTERN] [--exclude PATTERN] [--http record|replay] -- COMMAND [ARGS...]');
  let out = '', cwd = process.cwd(), http = 'off';
  const only: string[] = [], exclude: string[] = [];
  for (let i = 0; i < split; i++) {
    const option = args[i], value = args[++i];
    if (!value || i >= split) throw new Error(`Missing value for ${option}`);
    if (option === '--out') out = resolve(value);
    else if (option === '--cwd') cwd = realpathSync(resolve(value));
    else if (option === '--only') only.push(value);
    else if (option === '--exclude') exclude.push(value);
    else if (option === '--http' && ['off', 'record', 'replay'].includes(value)) http = value;
    else throw new Error(`Unknown launch option ${option}`);
  }
  if (!out) throw new Error('launch needs --out DIRECTORY (a new directory)');
  mkdirSync(out, { mode: 0o700 }); // refuse to mingle two launches
  cwd = realpathSync(cwd);
  const config = join(out, 'launch.json');
  writeFileSync(config, JSON.stringify({ out, cwd, config: { recordLocals: true, only, exclude, http } }), { mode: 0o600 });
  const preload = pathToFileURL(resolve(import.meta.dirname, 'launchPreload.ts')).href;
  const command = args.slice(split + 1);
  const started = Date.now();
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    const child = spawn(command[0]!, command.slice(1), { cwd, stdio: 'inherit', shell: false,
      env: { ...process.env, TRACELIGHT_LAUNCH_CONFIG: config, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${preload}`.trim() } });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit(code ?? (signal === 'SIGINT' ? 130 : 1)));
  });
  const recordings = readdirSync(out).filter(p => /^run-.*\.json$/.test(p)).map(file => {
    const { meta } = JSON.parse(readFileSync(join(out, file), 'utf8'));
    return { recording: file, pid: meta.pid, parentPid: meta.parentPid, threadId: meta.threadId, file: meta.file, steps: meta.stepCount, exitCode: meta.exitCode };
  });
  writeFileSync(join(out, 'index.json'), JSON.stringify({ command: command.map(redact), cwd, exitCode, durationMs: Date.now() - started, recordings }, null, 2) + '\n', { mode: 0o600 });
  process.stderr.write(`Recorded ${recordings.length} process/thread runs in ${out}\n`);
  if (!recordings.length) process.stderr.write('No project statements were observed. The command may not use Node, may replace NODE_OPTIONS, or may transform modules outside Node load hooks.\n');
  return exitCode;
}
