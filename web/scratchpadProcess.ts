import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Native experiments share no JavaScript state or credentials with the lesson. */
export async function scratchProcess(executable: string, source: string, timeoutMs = 3000, options: {cwd?:string;setup?:string} = {}): Promise<string> {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) {
    throw new Error('Native scratchpad requires a process network sandbox. This host currently supports macOS sandbox-exec.');
  }
  const directory = mkdtempSync(join(tmpdir(), 'tl-scratch-process-'));
  const file = join(directory, 'experiment.cjs');
  writeFileSync(file, options.setup ?? source);
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)(deny network*)', executable, ...(options.setup === undefined ? [file] : ['--require',file,'--input-type=module','--eval',source])], {
      cwd: options.cwd ?? directory, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '', LANG: process.env.LANG ?? 'en_US.UTF-8' },
    });
    let response = '', diagnostics = '', settled = false;
    const stop = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); stop();
      // Wait for process exit before deleting the files it might still have open.
      child.once('close', () => rmSync(directory, {recursive:true,force:true}));
      if (error) reject(error); else resolve(response.trim());
    };
    const timer = setTimeout(() => finish(new Error('Scratchpad exceeded 3 seconds')), timeoutMs);
    child.on('error', error => { finish(error); rmSync(directory, {recursive:true,force:true}); });
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => {
      diagnostics += String(chunk);
      if (diagnostics.length > 128000) finish(new Error('Scratchpad exceeded its output limit'));
    });
    child.stdio[3]?.on('data', chunk => {
      response += String(chunk);
      if (response.length > 1000000) finish(new Error('Scratchpad exceeded its result limit'));
      else if (response.endsWith('\n')) finish();
    });
    child.on('close', (code, signal) => {
      rmSync(directory, {recursive:true,force:true});
      if (!settled) finish(new Error(`Scratchpad process exited before returning a result (code ${code}, signal ${signal}). ${diagnostics.slice(0,2000)}`));
    });
  });
}
