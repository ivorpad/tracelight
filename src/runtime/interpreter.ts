/**
 * The Node.js that runs a file: `tracelight.nodePath`, else `node` on PATH, at least MIN_NODE
 * (`language.ts`). A launch configuration's `node` (or the CLI's `--node`) names one outright.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { setting } from '../config/settings';
import { MIN_NODE, nodeVersionOk } from './language';

export interface Interpreter {
  path: string;
  version: [number, number, number];
  source: 'setting' | 'PATH' | 'user';
  /** always `javascript`: the Node executable that runs the runtime in `node/` */
  language: 'javascript';
}

export class InterpreterError extends Error {
  constructor(message: string, readonly actions: { title: string; command: string }[] = []) {
    super(message);
  }
}

const ACTIONS = [
  { title: 'Select Node.js', command: 'tracelight.selectNode' },
  { title: 'Show Logs', command: 'tracelight.showLogs' },
];

/** `tracelight.nodePath`, else `node` on PATH. Throws an InterpreterError when missing or too old. */
export async function resolveInterpreter(resource?: vscode.Uri): Promise<Interpreter> {
  const configured = setting<string>('nodePath', '', resource).trim();
  const exe = configured ? resolveSettingPath(configured, resource) : 'node';
  const version = await probeNode(exe);
  if (!version) throw new InterpreterError(`Node.js was not found (${exe}). Install Node ${MIN_NODE.join('.')}+ or set tracelight.nodePath.`, ACTIONS);
  if (!nodeVersionOk(version)) throw new InterpreterError(`Tracelight needs Node ${MIN_NODE.join('.')}+; ${exe} is ${version.join('.')}. Set tracelight.nodePath to a newer node.`, ACTIONS);
  return { path: exe, version, source: configured ? 'setting' : 'PATH', language: 'javascript' };
}

/** The Node a launch names outright (`"node"` in a launch configuration). Still requires MIN_NODE. */
export async function namedInterpreter(exe: string): Promise<Interpreter> {
  const version = await probeNode(exe);
  const actions = [{ title: 'Show Logs', command: 'tracelight.showLogs' }];
  if (!version) throw new InterpreterError(`Tracelight cannot run ${exe}: it did not report a Node.js version.`, actions);
  if (!nodeVersionOk(version)) throw new InterpreterError(`Tracelight needs Node ${MIN_NODE.join('.')} or newer; ${exe} is ${version.join('.')}.`, actions);
  return { path: exe, version, source: 'user', language: 'javascript' };
}

export async function showInterpreterError(err: unknown): Promise<void> {
  const e = err instanceof InterpreterError ? err : new InterpreterError(String(err instanceof Error ? err.message : err));
  const picked = await vscode.window.showErrorMessage(e.message, ...e.actions.map((a) => a.title));
  const action = e.actions.find((a) => a.title === picked);
  if (action) void vscode.commands.executeCommand(action.command);
}

/** A relative `tracelight.nodePath` is taken from the workspace folder of `resource` (or the first one). */
export function resolveSettingPath(value: string, resource?: vscode.Uri): string {
  if (path.isAbsolute(value) || !value.includes('/') && !value.includes('\\')) return value; // absolute, or a bare command on PATH
  const folder = (resource && vscode.workspace.getWorkspaceFolder(resource)) ?? vscode.workspace.workspaceFolders?.[0];
  return folder ? path.join(folder.uri.fsPath, value) : value;
}

/** Where a file dialog should start: the active file's folder, else the workspace folder, else home. */
function browseStartUri(): vscode.Uri | undefined {
  const doc = vscode.window.activeTextEditor?.document;
  if (doc && doc.uri.scheme === 'file') return vscode.Uri.file(path.dirname(doc.uri.fsPath));
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) return folder.uri;
  return process.env['HOME'] ? vscode.Uri.file(process.env['HOME']) : undefined;
}

/** `node --version` as numbers, or undefined when `exe` does not run as Node. */
export function probeNode(exe: string): Promise<[number, number, number] | undefined> {
  return new Promise((resolve) => {
    execFile(exe, ['--version'], { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve(undefined);
      const m = /v(\d+)\.(\d+)\.(\d+)/.exec(String(stdout));
      resolve(m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined);
    });
  });
}

/**
 * The Node picker: the current setting and `node` on PATH, or a file dialog / typed
 * path. Refuses a Node older than MIN_NODE and writes `tracelight.nodePath` per workspace (relative to
 * the folder when inside it).
 */
export async function selectNodeCommand(): Promise<string | undefined> {
  const found = new Map<string, string>();
  const current = setting<string>('nodePath', '').trim();
  if (current) found.set(resolveSettingPath(current), 'current setting');
  if (!found.has('node')) found.set('node', 'on PATH');
  const items: (vscode.QuickPickItem & { exe?: string; action?: string })[] = [];
  await Promise.all(
    [...found.entries()].map(async ([exe, label]) => {
      const v = await probeNode(exe);
      if (!v) return;
      const ok = nodeVersionOk(v);
      items.push({ label: `${ok ? '$(check)' : '$(warning)'} ${exe}`, description: `Node ${v.join('.')}`, detail: ok ? label : `${label} (too old, needs ${MIN_NODE.join('.')}+)`, exe });
    }),
  );
  const BROWSE = 'browse';
  const TYPE = 'type';
  items.push({ label: '$(folder-opened) Browse for a node executable…', detail: 'Opens a file dialog (e.g. ~/.nvm/versions/node/v24.0.0/bin/node)', action: BROWSE });
  items.push({ label: '$(edit) Type a path…', detail: 'Absolute, or relative to the workspace folder', action: TYPE });
  const pick = await vscode.window.showQuickPick(items, { title: 'Tracelight: Node.js', placeHolder: `Node used to run JavaScript and TypeScript files (${MIN_NODE.join('.')}+)` });
  if (!pick) return undefined;
  let exe = pick.exe;
  if (pick.action === BROWSE) {
    const chosen = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, defaultUri: browseStartUri(), openLabel: 'Use as Node', title: `Tracelight: choose a Node ${MIN_NODE.join('.')}+ executable` });
    exe = chosen?.[0]?.fsPath;
  } else if (pick.action === TYPE) {
    exe = await vscode.window.showInputBox({ prompt: `Path to a Node ${MIN_NODE.join('.')}+ executable (absolute, or relative to the workspace folder)`, ignoreFocusOut: true });
  }
  if (!exe) return undefined;
  const version = await probeNode(resolveSettingPath(exe));
  if (!version) {
    void vscode.window.showErrorMessage(`Tracelight: ${exe} does not run as Node.js.`);
    return undefined;
  }
  if (!nodeVersionOk(version)) {
    void vscode.window.showErrorMessage(`Tracelight needs Node ${MIN_NODE.join('.')} or newer for JavaScript and TypeScript; ${exe} is ${version.join('.')}.`);
    return undefined;
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  let stored = exe === 'node' ? '' : exe;
  if (folder && path.isAbsolute(exe)) {
    const rel = path.relative(folder.uri.fsPath, exe);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) stored = rel;
  }
  await vscode.workspace.getConfiguration('tracelight').update('nodePath', stored || undefined, folder ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
  return stored ? resolveSettingPath(stored) : 'node';
}
