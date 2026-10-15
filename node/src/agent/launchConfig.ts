/**
 * `debug --configuration NAME`: a Node or Bun launch configuration of the workspace's
 * `.vscode/launch.json`, turned into the flags `debug FILE` already takes (program, args, cwd, env,
 * runtime). The nearest `.vscode/launch.json` above the file, the --cwd or the current directory is
 * the one read. VS Code's own variables are substituted; keys Tracelight has no use for are named
 * in the reply instead of silently dropped.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { AgentError } from './source.ts';

type Msg = Record<string, any>;

/** the keys a configuration may carry that `debug` maps or that change nothing about the run */
const MAPPED = new Set(['type', 'request', 'name', 'program', 'args', 'cwd', 'env', 'envFile', 'runtimeExecutable', 'stopOnEntry']);
const HARMLESS = new Set(['console', 'internalConsoleOptions', 'skipFiles', 'outFiles', 'sourceMaps', 'smartStep', 'presentation', 'autoAttachChildProcesses', 'resolveSourceMapLocations', 'outputCapture', 'showAsyncStacks', 'trace', 'preLaunchTask', 'postDebugTask']);
const NODE_TYPES = new Set(['node', 'pwa-node', 'bun']);

export interface LaunchFlags {
  file: string;
  name: string;
  program: string | null;
  args: string[];
  cwd: string | null;
  env: Record<string, string>;
  node: string | null;
  stopOnEntry: boolean;
  /** keys of the configuration that `debug` does not apply */
  ignored: string[];
}

/** JSON with comments and trailing commas, as launch.json is written */
export function parseJsonc(text: string): any {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
    } else if (c === '"') { inString = true; out += c; }
    else if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; }
    else if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; }
    else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** the nearest `.vscode/launch.json` at or above `from` */
export function findLaunchJson(from: string): string | null {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, '.vscode', 'launch.json');
    if (existsSync(candidate)) return candidate;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function dotenv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}

/** Read configuration `name` and return the flags `debug` runs with. `file` is the FILE given on the command line, if any. */
export function launchConfiguration(name: string, from: string, file: string | null = null): LaunchFlags {
  const path = findLaunchJson(from);
  if (!path) throw new AgentError(`no .vscode/launch.json at or above ${from}`, 'give the file and its flags instead, or pass --cwd inside the workspace');
  let json: Msg;
  try {
    json = parseJsonc(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new AgentError(`${path} is not readable JSON: ${(e as Error).message}`);
  }
  const configs: Msg[] = Array.isArray(json?.configurations) ? json.configurations : [];
  const config = configs.find((c) => c?.name === name);
  if (!config) throw new AgentError(`${path} has no configuration named ${JSON.stringify(name)}`, configs.length ? `its configurations: ${configs.map((c) => JSON.stringify(c?.name)).join(', ')}` : 'it lists no configurations');
  if (!NODE_TYPES.has(config.type)) throw new AgentError(`configuration ${JSON.stringify(name)} is type ${JSON.stringify(config.type)}`, 'Tracelight debugs Node and Bun programs: type node, pwa-node or bun');
  if ((config.request ?? 'launch') !== 'launch') throw new AgentError(`configuration ${JSON.stringify(name)} attaches to a running process`, 'Tracelight starts the program itself: use a launch configuration');
  const workspace = dirname(dirname(path));
  const current = file ? resolve(file) : null;
  const sub = (value: string): string => value.replace(/\$\{([^}]+)\}/g, (whole, key: string) => {
    if (key === 'workspaceFolder' || key === 'workspaceRoot') return workspace;
    if (key === 'workspaceFolderBasename') return basename(workspace);
    if (key === 'userHome') return homedir();
    if (key === 'cwd') return process.cwd();
    if (key === 'pathSeparator' || key === '/') return sep;
    if (key.startsWith('env:')) return process.env[key.slice(4)] ?? '';
    if (key.startsWith('workspaceFolder:')) return workspace;
    if (current) {
      if (key === 'file') return current;
      if (key === 'fileDirname') return dirname(current);
      if (key === 'fileBasename') return basename(current);
      if (key === 'fileBasenameNoExtension') return basename(current, extname(current));
      if (key === 'fileExtname') return extname(current);
      if (key === 'relativeFile') return current.startsWith(workspace + sep) ? current.slice(workspace.length + 1) : current;
    }
    throw new AgentError(`configuration ${JSON.stringify(name)} uses ${whole}, which needs ${key.startsWith('file') || key === 'relativeFile' ? 'the FILE argument' : 'VS Code to resolve'}`, key.startsWith('file') || key === 'relativeFile' ? 'pass the file as well as --configuration' : 'replace it in launch.json, or give the flags directly');
  });
  const abs = (p: string, base: string): string => (isAbsolute(p) ? p : resolve(base, p));
  const cwd = typeof config.cwd === 'string' ? abs(sub(config.cwd), workspace) : null;
  const env: Record<string, string> = {};
  if (typeof config.envFile === 'string') Object.assign(env, dotenv(abs(sub(config.envFile), workspace)));
  for (const [k, v] of Object.entries(config.env ?? {})) if (v !== null && v !== undefined) env[k] = sub(String(v));
  const runtime = typeof config.runtimeExecutable === 'string' ? sub(config.runtimeExecutable) : null;
  return {
    file: path,
    name,
    program: typeof config.program === 'string' ? abs(sub(config.program), cwd ?? workspace) : null,
    args: Array.isArray(config.args) ? config.args.map((a: unknown) => sub(String(a))) : typeof config.args === 'string' ? sub(config.args).split(/\s+/).filter(Boolean) : [],
    cwd,
    env,
    node: config.type === 'bun' ? (runtime ?? 'bun') : runtime && runtime !== 'node' ? runtime : null,
    stopOnEntry: config.stopOnEntry === true,
    ignored: Object.keys(config).filter((k) => !MAPPED.has(k) && !HARMLESS.has(k)),
  };
}

/** `debug --test NAME`: the `--test-name-pattern` that runs only that node:test test (its name, or its full `suite test` name) */
export function testNamePattern(name: string): string {
  return `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}
