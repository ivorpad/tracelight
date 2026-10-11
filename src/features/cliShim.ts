/**
 * The extension's command on PATH: a shell script at `~/.local/bin/tracelight` that runs this
 * extension's own `dist/node` runtime. An agent then finds the CLI without knowing where the
 * extension lives, and a path it saved from an older version cannot go stale, because every
 * activation rewrites the script with the current one.
 *
 * Written only while `tracelight.agentAccess` is on, since that is the user saying agents may use
 * Tracelight. A script that is already ours is refreshed whatever the setting. Anything else at that
 * path (a `uv tool install` symlink, the user's own script) is never touched.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AGENT_ACCESS_SETTING } from '../agent/bridge';
import { setting } from '../config/settings';
import { resolveNode } from '../runtime/interpreter';
import { jsRuntimeEntry } from '../runtime/language';
import { log } from '../util/log';

/** the line that marks a script as one this extension wrote and may rewrite */
export const SHIM_MARKER = '# tracelight-shim: written by the Tracelight extension';
export interface ShimInputs {
  /** `bin/tracelight.mjs` of the runtime inside the extension */
  entry: string;
  /** the Node the window resolved (`tracelight.nodePath`, else `node` on PATH), used unless $TRACELIGHT_CLI_NODE is set */
  node: string;
  /** the editor's own launcher, exported as $TRACELIGHT_CODE unless the caller set one */
  launcher?: string;
  version: string;
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The script. $TRACELIGHT_CLI_NODE picks the Node that runs the CLI itself (22.18+); the program's
 * Node stays the CLI's `--node` / $TRACELIGHT_NODE.
 */
export function shimScript(i: ShimInputs): string {
  const lines = ['#!/bin/sh', `${SHIM_MARKER} ${i.version}. It is rewritten on every activation; edit nothing here.`, `node=\${TRACELIGHT_CLI_NODE:-${shQuote(i.node)}}`];
  if (i.launcher) lines.push(`if [ -z "\${TRACELIGHT_CODE:-}" ]; then TRACELIGHT_CODE=${shQuote(i.launcher)}; export TRACELIGHT_CODE; fi`);
  lines.push(`exec "$node" ${shQuote(i.entry)} "$@"`, '');
  return lines.join('\n');
}

export type ShimState = { kind: 'absent' } | { kind: 'ours'; text: string } | { kind: 'foreign'; why: string };

/** What is at `file` now. A symlink is never ours: that is how `uv tool install` puts the CLI there. */
export function shimState(file: string): ShimState {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    return { kind: 'absent' };
  }
  if (st.isSymbolicLink()) return { kind: 'foreign', why: `a symlink to ${fs.readlinkSync(file)}` };
  if (!st.isFile()) return { kind: 'foreign', why: 'not a file' };
  const text = fs.readFileSync(file, 'utf8');
  const ours = text.includes(SHIM_MARKER);
  return ours ? { kind: 'ours', text } : { kind: 'foreign', why: 'a script Tracelight did not write' };
}

/** Write `text` to `file` when it should: absent and allowed, or ours and different. Returns what it did; `foreign` is someone else's file, left alone. */
export function syncShim(file: string, text: string, allowCreate: boolean): 'created' | 'updated' | 'unchanged' | 'skipped' | 'foreign' {
  const state = shimState(file);
  if (state.kind === 'foreign') return 'foreign';
  if (state.kind === 'ours' && state.text === text) return 'unchanged';
  if (state.kind === 'absent' && !allowCreate) return 'skipped';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o755 });
  fs.renameSync(tmp, file);
  return state.kind === 'absent' ? 'created' : 'updated';
}

/** The editor's command-line launcher under its app root (`bin/code`, `bin/cursor`), skipping the tunnel binaries. */
export function findLauncher(appRoot: string): string | undefined {
  let names: string[];
  try {
    names = fs.readdirSync(path.join(appRoot, 'bin'));
  } catch {
    return undefined;
  }
  const name = names.filter((n) => !n.includes('tunnel') && !/\.(cmd|exe|ps1)$/.test(n)).sort()[0];
  return name ? path.join(appRoot, 'bin', name) : undefined;
}

/** The line a shell profile needs; it names $HOME rather than the account's path. */
export const PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH"';
const PATH_ASKED_KEY = 'tracelight.cliPathAsked';

/** Is `dir` on this PATH, ignoring a trailing slash? */
export function onPath(dir: string, pathVar: string): boolean {
  const want = dir.replace(/\/+$/, '');
  return pathVar.split(path.delimiter).some((p) => p.replace(/\/+$/, '') === want);
}

/** The login profile the user's shell reads, or undefined for a shell whose file we should not guess. */
export function profileFor(shell: string, home: string, platform: NodeJS.Platform): string | undefined {
  const name = path.basename(shell);
  if (name === 'zsh') return path.join(home, '.zprofile');
  if (name === 'bash') return path.join(home, platform === 'darwin' ? '.bash_profile' : '.profile');
  return undefined;
}

/** Once per user: offer to put ~/.local/bin on PATH. Writes the profile only on a yes; otherwise the line is there to copy. */
async function offerPath(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(PATH_ASKED_KEY)) return;
  await context.globalState.update(PATH_ASKED_KEY, true);
  const profile = profileFor(process.env['SHELL'] ?? '', os.homedir(), process.platform);
  const add = profile ? `Add to ${path.basename(profile)}` : undefined;
  const pick = await vscode.window.showInformationMessage(
    `Tracelight installed the tracelight command in ~/.local/bin, which is not on your PATH. Agents can call it by its full path; for the bare name, add ${PATH_LINE} to your shell profile.`,
    ...(add ? [add] : []),
    'Copy Line',
  );
  if (pick === 'Copy Line') await vscode.env.clipboard.writeText(PATH_LINE);
  if (pick && pick === add && profile) {
    try {
      const text = fs.existsSync(profile) ? fs.readFileSync(profile, 'utf8') : '';
      if (!text.includes(PATH_LINE)) fs.writeFileSync(profile, `${text.replace(/\n*$/, text ? '\n' : '')}${PATH_LINE}\n`);
      void vscode.window.showInformationMessage(`Added to ${profile}. New terminals will find tracelight; running ones keep their PATH.`);
    } catch (err) {
      // a managed machine may lock the profile: say so and hand over the line instead
      log.error(`tracelight CLI: could not write ${profile}`, err);
      await vscode.env.clipboard.writeText(PATH_LINE);
      void vscode.window.showWarningMessage(`Tracelight could not write ${profile}. The PATH line is on the clipboard.`);
    }
  }
}

/** Keep the shim current now and whenever agent access is turned on. POSIX only: a Windows user profile has no bin directory on PATH to put it in. */
export function installCliShim(context: vscode.ExtensionContext, runtimeDir: string): vscode.Disposable {
  if (process.platform === 'win32' || process.env['TRACELIGHT_E2E'] || context.extensionMode === vscode.ExtensionMode.Test) return new vscode.Disposable(() => {});
  const bin = path.join(os.homedir(), '.local', 'bin');
  const version = String(context.extension.packageJSON.version);
  const launcher = findLauncher(vscode.env.appRoot);
  const entry = jsRuntimeEntry(runtimeDir, path.join, path.dirname);
  // target is what the shim runs, for the log line
  const scripts: { file: string; target: string; text: () => Promise<string> }[] = [
    { file: path.join(bin, 'tracelight'), target: entry, text: async () => shimScript({ entry, node: await resolveNode().then((i) => i.path, () => 'node'), launcher, version }) },
  ];
  const syncOne = async (file: string, target: string, script: () => Promise<string>): Promise<void> => {
    const allowCreate = setting<boolean>(AGENT_ACCESS_SETTING, false);
    if (!allowCreate && shimState(file).kind !== 'ours') return;
    const text = await script();
    const did = syncShim(file, text, allowCreate);
    if (did === 'foreign') {
      const state = shimState(file);
      log.info(`tracelight CLI: left ${file} alone (${state.kind === 'foreign' ? state.why : 'changed meanwhile'})`);
    }
    if (did === 'created' || did === 'updated') log.info(`tracelight CLI: ${did} ${file} -> ${target}`);
    if (did === 'created' && !onPath(path.dirname(file), process.env['PATH'] ?? '')) {
      log.warn(`tracelight CLI: ${path.dirname(file)} is not on PATH, so agents will not find ${file} by name`);
      void offerPath(context);
    }
  };
  const sync = async (): Promise<void> => {
    for (const s of scripts) await syncOne(s.file, s.target, s.text);
  };
  const run = (): void => void sync().catch((err) => log.error('tracelight CLI shim failed', err));
  run();
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(`tracelight.${AGENT_ACCESS_SETTING}`)) run();
  });
}
