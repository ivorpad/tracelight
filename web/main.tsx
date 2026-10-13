/**
 * Tracelight, the panel in a browser: the code pane (Monaco) beside the unchanged panel (webview/App.tsx), both
 * fed by the bridge (web/server.ts) over a WebSocket. `?layout=panel` shows the panel alone, for a
 * VS Code Simple Browser tab next to the real editor; `?layout=code` the code pane alone.
 * The page sets `window.__tracelight` (worker and codicons) before this script; see web/index.html.
 */
import { render } from 'preact';
import { App } from '../webview/App';
import { bootMonaco } from '../webview/monaco';
import '../webview/styles.css';
import '../webview/http.css';
import '../webview/exec-story.css';
import '../webview/debug.css';
import './theme.css';
import './web.css';
import type { HostToWebview, WebviewToHost } from '../src/shared/webviewProtocol';
import type { BridgeToPage } from './bridgeProtocol';
import { BridgeLink } from './link';
import { PageHost, runtimeLabelText } from './pageHost';
import { CodePane } from './codePane';
import { registerWebMcp, runAgentCommand } from './agent';
import { DebugPane } from './debugPane';
import { RecordingControls } from './recordingControls';

const params = new URLSearchParams(location.search);
const layout = params.get('layout') === 'panel' ? 'panel' : params.get('layout') === 'code' ? 'code' : 'split';
const theme = params.get('theme') ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
if (theme === 'light') document.body.classList.add('light');
document.body.dataset.layout = layout;
let presentation: 'learn' | 'debug' = params.get('presentation') === 'debug' || layout === 'panel' ? 'debug' : 'learn';
let toolsOpen = presentation === 'debug';
let panelView = 'output';
document.body.dataset.presentation = presentation;

function injectCodicons(): void {
  const uri = window.__tracelight?.codiconsUri;
  if (!uri) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = uri;
  document.head.appendChild(link);
}
injectCodicons();
bootMonaco();

const $ = (id: string) => document.getElementById(id)!;
const fileLabel = $('pkw-file');
const runtimeLabel = $('pkw-runtime');
const statusDot = $('pkw-status');

// the panel's VS Code API, answered by the page host instead of an extension
let host: PageHost;
const PREFS_KEY = 'tracelight.web.panelState';
(globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
  postMessage: (m: WebviewToHost) => queueMicrotask(() => {
    if (m.type === 'viewChanged') { panelView = m.view; updateRecordingNotice(); }
    host.onPanel(m);
  }),
  getState: () => {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      return raw ? JSON.parse(raw) : undefined;
    } catch {
      return undefined;
    }
  },
  setState: (s: unknown) => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(s));
    } catch {
      /* private window: preferences last for the visit */
    }
  },
});
const toPanel = (m: HostToWebview) => window.postMessage(m, location.origin);

let editTimer: ReturnType<typeof setTimeout> | undefined;
const code = new CodePane(
  $('pkw-code'),
  (content) => {
    // Quokka-style: an edit runs the buffer as it stands, without saving it (Run Automatically only)
    if (editTimer) clearTimeout(editTimer);
    if (host.settings.runMode === 'auto') editTimer = setTimeout(() => host.rerun(content), 350);
    updateTitle();
  },
  (content) => {
    link.send({ type: 'save', content });
    // Run on Save runs what was saved; Run Automatically already ran it as it was typed
    if (host.settings.runMode === 'onSave') host.rerun();
    updateTitle();
  },
);

const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const link = new BridgeLink(wsUrl, (msg) => onBridge(msg), (connected) => {
  host.connected = connected;
  statusDot.className = connected ? 'pkw-dot ok' : 'pkw-dot off';
  statusDot.title = connected ? 'Connected to the Tracelight bridge' : 'Bridge not reachable: is tracelight-web still running?';
});
host = new PageHost(link, code, toPanel);
host.theme = theme === 'light' ? 'light' : 'dark';
// for an agent driving the page with browser tools, and for debugging: the same calls the WebMCP tools make
(window as unknown as { tracelight: PageHost }).tracelight = host;

let noticeTimer: ReturnType<typeof setTimeout> | undefined;
host.notice = (text, level) => {
  const el = $('pkw-notice');
  el.textContent = text;
  el.className = `pkw-notice ${level}`;
  el.hidden = false;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (el.hidden = true), level === 'error' ? 12000 : 4000);
};

// the live debugger: breakpoints in the gutter (or F9), its controls under the code
code.onGutterClick = (path, line) => host.debug.setBreakpoint(path, line);
code.onExpandValue = (node) => host.debug.expandNode(node);
// the Code Story and the profile: a row picked goes to its step, Ctrl/Cmd+click opens its source
code.onLinePick = (path, line, how) => host.linePick(path, line, how);

// View Recent Files: the files this bridge ran, a click makes one the main file
host.onRecent = (files) => {
  const box = $('pkw-recent');
  render(
    <div class="pkw-recent-list" role="menu">
      <div class="pkw-recent-head">Recent files</div>
      {files.length ? (
        files.map((f) => (
          <button
            type="button"
            class={`pkw-recent-item${f.path === host.main?.path ? ' current' : ''}`}
            title={f.path}
            onClick={() => {
              box.hidden = true;
              if (f.path !== host.main?.path) host.openFile(f.path);
            }}
          >
            <span class="pkw-recent-name">{f.displayName}</span>
            <span class="pkw-recent-path">{f.path}</span>
          </button>
        ))
      ) : (
        <div class="pkw-recent-path">none yet</div>
      )}
    </div>,
    box,
  );
  box.hidden = false;
};
document.addEventListener('pointerdown', (e) => {
  const box = $('pkw-recent');
  if (!box.hidden && !box.contains(e.target as Node)) box.hidden = true;
});
const debugPane = $('pkw-debugpane');
const showDebuggerView = () => {
  setPresentation('debug');
  toPanel({ type: 'showView', view: 'debug' });
};
function updateRecordingNotice(): void {
  document.body.classList.toggle('pkw-show-recording-notice', host.debug.active && panelView !== 'debug' && panelView !== 'settings');
}
function setPresentation(next: 'learn' | 'debug'): void {
  presentation = next;
  toolsOpen = next === 'debug';
  document.body.dataset.presentation = next;
  if (next === 'debug') document.body.dataset.layout = 'split';
  $('pkw-learn').setAttribute('aria-pressed', String(next === 'learn'));
  $('pkw-tools').setAttribute('aria-pressed', String(next === 'debug'));
  const u = new URL(location.href);
  if (next === 'learn') u.searchParams.delete('presentation');
  else u.searchParams.set('presentation', next);
  history.replaceState(null, '', u);
  renderDebug();
  code.layout();
  host.scheduleRender(true);
}
function renderDebug(): void {
  document.body.classList.toggle('pkw-live-debug', host.debug.active);
  document.body.classList.toggle('pkw-live-active', host.debug.active);
  updateRecordingNotice();
  if (presentation === 'learn' && !host.debug.active && host.nav.active && host.run?.trace?.valid(host.nav.step)) {
    const at = host.state().location;
    debugPane.classList.add('compact');
    render(<RecordingControls step={host.nav.step} location={at ? `${at.file}:${at.line}` : ''}
      canStep={host.run.trace.canStep(host.nav.step)} move={kind => host.move(kind)} restart={() => host.goto(0)} stop={() => host.stop()} />, debugPane);
    return;
  }
  debugPane.classList.toggle('compact', !host.debug.paused || !toolsOpen);
  render(<DebugPane debug={host.debug} learning={presentation === 'learn'} expanded={toolsOpen}
    onToggleTools={() => { toolsOpen = !toolsOpen; renderDebug(); code.layout(); host.scheduleRender(true); }}
    onShowView={showDebuggerView} onLayout={() => { code.layout(); host.scheduleRender(true); }} />, debugPane);
  $('pkw-debug').classList.toggle('active', host.debug.active);
}
document.addEventListener('keydown', (e) => {
  const key = e.key === 'F5' ? (e.shiftKey ? 'stop' : 'continue') : e.key === 'F10' ? 'stepOver' : e.key === 'F11' ? (e.shiftKey ? 'stepOut' : 'stepInto') : null;
  if (!key) return;
  if (!host.debug.active && presentation === 'learn' && host.nav.active) {
    if (key === 'stepOver' || key === 'stepInto' || key === 'stepOut') { e.preventDefault(); host.move(key === 'stepOver' ? 'over' : key === 'stepInto' ? 'into' : 'out'); }
    return;
  }
  if (!host.debug.run?.running) return;
  e.preventDefault();
  void host.debug.control(key);
});

let stateTimer: ReturnType<typeof setTimeout> | undefined;
host.onChange = () => {
  updateTitle();
  renderDebug();
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = undefined;
    link.send({ type: 'state', state: host.state() });
  }, 150);
};

function onBridge(msg: BridgeToPage): void {
  if (msg.type === 'agent') {
    runAgentCommand(host, link, msg.command).then(
      (result) => link.send({ type: 'agent.result', id: msg.id, result }),
      (err) => link.send({ type: 'agent.result', id: msg.id, result: null, error: err instanceof Error ? err.message : String(err) }),
    );
    return;
  }
  host.onBridge(msg);
  if (msg.type === 'hello' || msg.type === 'runtime') {
    const r = msg.runtime;
    runtimeLabel.textContent = runtimeLabelText(r.ready);
    runtimeLabel.title = r.command;
  }
}

function updateTitle(): void {
  const name = host.main?.displayName ?? '';
  const dirty = code.isMainShown() && code.dirty;
  const shown = code.shownPath();
  const other = shown && host.main && shown !== host.main.path ? ` › ${code.shownName() ?? shown.split(/[\\/]/).pop()}` : '';
  fileLabel.textContent = `${name}${dirty ? ' ●' : ''}${other}`;
  fileLabel.title = host.main?.path ?? '';
  document.title = `${name ? `${name} · ` : ''}Tracelight`;
  $('pkw-back').hidden = !other;
}

$('pkw-run').addEventListener('click', () => host.rerun(code.dirty ? code.mainContent() : undefined));
$('pkw-back').addEventListener('click', () => {
  host.showMain();
  updateTitle();
});
$('pkw-tm').addEventListener('click', () => (host.nav.active ? host.stop() : host.start({ line: code.cursorLine() })));
$('pkw-debug').addEventListener('click', () => (host.debug.active ? showDebuggerView() : host.debug.start(code.dirtyContent())));
$('pkw-learn').addEventListener('click', () => setPresentation('learn'));
$('pkw-tools').addEventListener('click', () => setPresentation('debug'));
$('pkw-learn').setAttribute('aria-pressed', String(presentation === 'learn'));
$('pkw-tools').setAttribute('aria-pressed', String(presentation === 'debug'));
$('pkw-layout').addEventListener('click', () => {
  const next = document.body.dataset.layout === 'split' ? 'panel' : document.body.dataset.layout === 'panel' ? 'code' : 'split';
  document.body.dataset.layout = next;
  const u = new URL(location.href);
  if (next === 'split') u.searchParams.delete('layout');
  else u.searchParams.set('layout', next);
  history.replaceState(null, '', u);
  code.layout();
});

// splitter between the code pane and the panel
const split = $('pkw-split');
split.addEventListener('pointerdown', (e) => {
  split.setPointerCapture(e.pointerId);
  const main = $('pkw-main');
  const move = (ev: PointerEvent) => {
    const rect = main.getBoundingClientRect();
    const frac = Math.min(0.8, Math.max(0.2, (ev.clientX - rect.left) / rect.width));
    main.style.setProperty('--pkw-code', `${frac * 100}%`);
  };
  const up = () => {
    split.removeEventListener('pointermove', move);
    split.removeEventListener('pointerup', up);
  };
  split.addEventListener('pointermove', move);
  split.addEventListener('pointerup', up);
});

const webMcp = registerWebMcp(host, link);
$('pkw-webmcp').hidden = !webMcp;

render(<App />, $('root'));
