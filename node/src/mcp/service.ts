/**
 * `tracelight mcp service install|uninstall|status`: keep `tracelight mcp --http` running for the
 * user, so an HTTP client config (`http://127.0.0.1:4787/mcp`) always finds a server. On macOS a
 * launchd agent (`~/Library/LaunchAgents/dev.tracelight.mcp.plist`), on Linux a systemd user unit
 * (`~/.config/systemd/user/tracelight-mcp.service`); both start at login and restart the server
 * when it exits.
 *
 * The agent runs the `tracelight` command the extension keeps in ~/.local/bin, with
 * `--restart-on-change` on that file: when an extension update rewrites it, the server finishes
 * its calls and exits, and launchd or systemd starts the new version. Without that command it runs
 * this runtime's own entry and watches that instead.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAME, RUNTIME_VERSION } from '../protocol.ts';
import { DEFAULT_MCP_PORT, isLoopback } from './http.ts';

export const LABEL = 'dev.tracelight.mcp';
const UNIT = 'tracelight-mcp.service';
const ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'tracelight.mjs');

export interface ServiceOptions {
  port: number;
  host: string;
  token?: string;
}

export interface ServicePaths {
  home: string;
  /** the extension's command on PATH, when it is there */
  shim: string;
  plist: string;
  unit: string;
  log: string;
}

export function servicePaths(home = homedir()): ServicePaths {
  return {
    home,
    shim: join(home, '.local', 'bin', NAME),
    plist: join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
    unit: join(home, '.config', 'systemd', 'user', UNIT),
    log: join(process.env.TRACELIGHT_HOME || join(home, '.tracelight'), 'mcp-http.log'),
  };
}

/** what the service runs: the shim when it exists (it follows extension updates), else this runtime */
export function serviceCommand(o: ServiceOptions, p: ServicePaths, shimExists = existsSync(p.shim)): string[] {
  const head = shimExists ? [p.shim] : [process.execPath, ENTRY];
  const watched = shimExists ? p.shim : ENTRY;
  return [...head, 'mcp', '--http', '--port', String(o.port), ...(o.host !== '127.0.0.1' ? ['--host', o.host] : []), ...(o.token ? ['--token', o.token] : []), '--restart-on-change', watched];
}

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function plist(command: string[], p: ServicePaths, path = process.env.PATH ?? '/usr/bin:/bin'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${command.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(path)}</string>
    <key>HOME</key><string>${xml(p.home)}</string>
  </dict>
  <key>WorkingDirectory</key><string>${xml(p.home)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${xml(p.log)}</string>
  <key>StandardErrorPath</key><string>${xml(p.log)}</string>
</dict>
</plist>
`;
}

const shellWord = (s: string): string => (/^[\w@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, '\\$1')}"`);

export function systemdUnit(command: string[], p: ServicePaths, path = process.env.PATH ?? '/usr/bin:/bin'): string {
  return `[Unit]
Description=Tracelight MCP server (Streamable HTTP)
After=default.target

[Service]
ExecStart=${command.map(shellWord).join(' ')}
WorkingDirectory=${p.home}
Environment=${shellWord(`PATH=${path}`)}
Restart=always
RestartSec=5
StandardOutput=append:${p.log}
StandardError=append:${p.log}

[Install]
WantedBy=default.target
`;
}

function run(cmd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

async function probe(port: number, host: string, timeoutMs: number): Promise<{ version?: string; name?: string } | null> {
  const shown = host.includes(':') ? `[${host}]` : host;
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const res = await fetch(`http://${isLoopback(host) ? '127.0.0.1' : shown}:${port}/`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return await res.json() as { version?: string; name?: string };
    } catch { /* not up yet */ }
    if (Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
  } while (Date.now() < deadline);
  return null;
}

function clientLines(port: number): string[] {
  const url = `http://127.0.0.1:${port}/mcp`;
  return [
    `Claude Code: claude mcp add --scope user --transport http tracelight ${url}`,
    `Codex: [mcp_servers.tracelight] url = "${url}" in ~/.codex/config.toml`,
  ];
}

export function parseServiceArgs(args: string[]): { action: string; opts: ServiceOptions } {
  const [action = 'status', ...rest] = args;
  const opts: ServiceOptions = { port: Number(process.env.TRACELIGHT_MCP_PORT ?? DEFAULT_MCP_PORT), host: '127.0.0.1', token: process.env.TRACELIGHT_MCP_TOKEN || undefined };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const v = rest[++i];
    if (v === undefined) throw new Error(`${a} needs a value`);
    if (a === '--port') opts.port = Number(v);
    else if (a === '--host') opts.host = v;
    else if (a === '--token') opts.token = v;
    else throw new Error(`unknown option ${a}: ${NAME} mcp service install|uninstall|status [--port N] [--host H] [--token T]`);
  }
  if (!['install', 'uninstall', 'status'].includes(action)) throw new Error(`unknown service action ${action}: install, uninstall or status`);
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) throw new Error(`--port must be 1 to 65535, got ${opts.port}`);
  if (!isLoopback(opts.host) && !opts.token) throw new Error(`a service on ${opts.host} needs --token: the tools run programs on this machine`);
  return { action, opts };
}

/** `tracelight mcp service ...` */
export async function cmdService(args: string[], out: (s: string) => void = (s) => process.stdout.write(s)): Promise<number> {
  const { action, opts } = parseServiceArgs(args);
  const p = servicePaths();
  const mac = process.platform === 'darwin';
  if (!mac && process.platform !== 'linux') throw new Error(`${NAME} mcp service supports macOS (launchd) and Linux (systemd); run \`${NAME} mcp --http\` yourself on ${process.platform}`);
  const uid = process.getuid?.() ?? 0;
  const domain = `gui/${uid}`;
  const file = mac ? p.plist : p.unit;

  if (action === 'status') {
    const installed = existsSync(file);
    let port = opts.port;
    if (installed) {
      const m = /--port<\/string>\s*<string>(\d+)|--port (\d+)/.exec(readFileSync(file, 'utf8'));
      if (m) port = Number(m[1] ?? m[2]);
    }
    const up = await probe(port, '127.0.0.1', 1500);
    out(`${installed ? `installed: ${file}` : 'not installed'}\n`);
    out(up ? `serving: http://127.0.0.1:${port}/mcp (${up.name ?? NAME} ${up.version ?? '?'})\n` : `nothing answers on 127.0.0.1:${port}\n`);
    if (installed) out(`log: ${p.log}\n`);
    return installed && up ? 0 : 1;
  }

  if (action === 'uninstall') {
    if (mac) run('launchctl', ['bootout', `${domain}/${LABEL}`]);
    else run('systemctl', ['--user', 'disable', '--now', UNIT]);
    const had = existsSync(file);
    rmSync(file, { force: true });
    if (!mac) run('systemctl', ['--user', 'daemon-reload']);
    out(had ? `removed ${file}; the server is stopped\n` : 'no service was installed\n');
    return 0;
  }

  if (existsSync(p.shim)) {
    // launchd would restart an older command forever, and one without `mcp --http` never listens
    const v = run(p.shim, ['version']);
    const shimVersion = /\b(\d+\.\d+\.\d+)\b/.exec(v.out)?.[1];
    if (!v.ok || shimVersion !== RUNTIME_VERSION) {
      throw new Error(`${p.shim} runs ${shimVersion ? `${NAME} ${shimVersion}` : 'something that does not answer `version`'}, not this ${RUNTIME_VERSION}: reload a VS Code window (or open a new one) so the extension rewrites it, then install again`);
    }
  }
  const command = serviceCommand(opts, p);
  mkdirSync(dirname(file), { recursive: true });
  mkdirSync(dirname(p.log), { recursive: true });
  if (mac) {
    run('launchctl', ['bootout', `${domain}/${LABEL}`]); // an older version of the agent, if any
    writeFileSync(file, plist(command, p));
    chmodSync(file, 0o600);
    // bootout returns before the old process is gone: retry while launchd still holds the label
    let boot = run('launchctl', ['bootstrap', domain, file]);
    for (let i = 0; !boot.ok && i < 10; i++) {
      await new Promise((r) => setTimeout(r, 300));
      boot = run('launchctl', ['bootstrap', domain, file]);
    }
    if (!boot.ok) throw new Error(`launchctl bootstrap ${domain} ${file} failed: ${boot.out}`);
  } else {
    writeFileSync(file, systemdUnit(command, p));
    chmodSync(file, 0o600);
    for (const step of [['daemon-reload'], ['enable', UNIT], ['restart', UNIT]]) {
      const r = run('systemctl', ['--user', ...step]);
      if (!r.ok) throw new Error(`systemctl --user ${step.join(' ')} failed: ${r.out}`);
    }
  }
  const up = await probe(opts.port, opts.host, 15_000);
  if (!up) throw new Error(`the service is installed (${file}) but nothing answers on port ${opts.port} after 15 s; see ${p.log}`);
  out([
    `installed: ${file}`,
    `serving: http://127.0.0.1:${opts.port}/mcp (${up.name ?? NAME} ${up.version ?? RUNTIME_VERSION}), started at login, restarted when it exits or ${command.at(-1)} changes`,
    `log: ${p.log}`,
    ...clientLines(opts.port),
  ].join('\n') + '\n');
  return 0;
}
