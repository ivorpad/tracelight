/**
 * Tracelight, the panel in a browser: the code pane (Monaco) beside the unchanged panel (webview/App.tsx), both
 * fed by the bridge (web/server.ts) over a WebSocket. `?layout=panel` shows the panel alone, for a
 * VS Code Simple Browser tab next to the real editor; `?layout=code` the code pane alone.
 * The page sets `window.__tracelight` (worker and codicons) before this script; see web/index.html.
 */
import { staleBuild } from './pageBuild';
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
import { Scratchpad } from './scratchpad';
import { openDefinitionTab } from './definitionTab';

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
const storyCode = new CodePane($('pkw-story-code'), () => {}, () => {});
let storyVisible = false;
/** the bridge build this page's code came from, set by the first hello */
let pageBuild: string | undefined;
code.showStory = file => { storyCode.showFile(file); storyVisible = true; };
code.storyShown = () => storyVisible;
code.renderStory = decorations => storyCode.render(decorations);
code.revealStory = line => storyCode.reveal(line);
code.closeStory = () => { storyVisible = false; };
code.renderedStory = () => storyVisible ? storyCode.renderedSource() : null;
storyCode.onLinePick = (_path, line, how) => host.storyPick(line, how === 'open');
const link = new BridgeLink(wsUrl, (msg) => onBridge(msg), (connected) => {
  host.connected = connected;
  statusDot.className = connected ? 'pkw-dot ok' : 'pkw-dot off';
  statusDot.title = connected ? 'Connected to the Tracelight bridge' : 'Bridge not reachable: is tracelight-web still running?';
});
host = new PageHost(link, code, toPanel);
host.theme = theme === 'light' ? 'light' : 'dark';
const scratchpad = new Scratchpad($('pkw-scratchpad'), host, code, () => { code.layout(); storyCode.layout(); });
host.onScratchpad = command => scratchpad.control(command);
code.onScratchpad = line => { void scratchpad.open(line).catch(e => host.notice(String(e), 'error')); };
$('pkw-scratch-toggle').addEventListener('click', () => { void scratchpad.showLibrary().catch(e => host.notice(String(e), 'error')); });
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
code.onNavigate = (path, line) => host.navigateSource(path, line);
code.onDefinitionNavigate = (path, line, column) => {
  try { openDefinitionTab(path, line, column); }
  catch (e) { host.notice(e instanceof Error ? e.message : String(e), 'error'); }
};
code.onGutterClick = (path, line) => host.debug.setBreakpoint(path, line);
code.onExpandValue = (node) => host.debug.expandNode(node);
code.onInspectValue = (name) => {
  toolsOpen = true;
  renderDebug();
  code.layout();
  const row = [...debugPane.querySelectorAll<HTMLElement>('[data-variable-name]')]
    .find(row => row.dataset.variableName === name);
  if (!row) return;
  const toggle = row.querySelector<HTMLButtonElement>('button.pkw-value-toggle');
  if (toggle?.getAttribute('aria-expanded') === 'false') toggle.click();
  if (row instanceof HTMLDetailsElement) row.open = true;
  (toggle ?? row.querySelector<HTMLElement>('summary'))?.focus();
  row.scrollIntoView({ block: 'nearest' });
};
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
  const historyShown = host.storyShown();
  document.body.dataset.story = historyShown ? 'shown' : 'hidden';
  code.layout();
  storyCode.layout();
  $('pkw-story-toggle').setAttribute('aria-pressed', String(historyShown));
  const historyNotice = $('pkw-story-notice');
  historyNotice.hidden = !historyShown;
  historyNotice.textContent = host.debug.active ? host.historyFollowing ? 'Code history · following live execution' : host.viewingRecordedSource ? 'Code history · reviewing a recorded step. Live execution remains at its pause.' : 'Code history · reviewing an earlier step. Source remains at the live pause.' : 'Code history · recorded execution. Select a line to review that moment.';
  $('pkw-story-follow').hidden = !historyShown || !host.debug.active || host.historyFollowing;
  document.body.classList.toggle('pkw-live-debug', host.debug.active);
  document.body.classList.toggle('pkw-live-active', host.debug.active);
  updateRecordingNotice();
  if (!host.nav.active || !host.run?.trace?.valid(host.nav.step)) render(null, $('pkw-story-controls'));
  if (presentation === 'learn' && host.nav.active && host.run?.trace?.valid(host.nav.step) && (historyShown || !host.debug.active || host.viewingRecordedSource)) {
    const at = host.run.trace.location(host.nav.step);
    const controlsPane = historyShown ? $('pkw-story-controls') : debugPane;
    if (!historyShown) debugPane.classList.add('compact');
    render(<RecordingControls step={host.nav.step} location={at ? `${host.displayPath(at.fileId)}:${at.range[0]}` : ''}
      canAdvance={host.run.trace.valid(host.nav.step + 1)} advance={() => host.goto(host.nav.step + 1)}
      canStep={host.run.trace.canStep(host.nav.step)} move={kind => host.move(kind)} restart={() => host.goto(0)} stop={() => host.closeStory()} />, controlsPane);
    if (!historyShown) return;
  }
  debugPane.classList.toggle('compact', !host.debug.paused || !toolsOpen);
  render(<DebugPane debug={host.debug} learning={presentation === 'learn'} expanded={toolsOpen}
    onReturnToPause={host.viewingFunctionSource ? () => { void host.returnToPause().catch(e => host.notice(String(e), 'error')); } : undefined}
    onToggleTools={() => { toolsOpen = !toolsOpen; renderDebug(); code.layout(); host.scheduleRender(true); }}
    onShowView={showDebuggerView} onLayout={() => { code.layout(); host.scheduleRender(true); }} />, debugPane);
  $('pkw-debug').classList.toggle('active', host.debug.active);
}
document.addEventListener('keydown', (e) => {
  const key = e.key === 'F5' ? (e.shiftKey ? 'stop' : 'continue') : e.key === 'F10' ? 'stepOver' : e.key === 'F11' ? (e.shiftKey ? 'stepOut' : 'stepInto') : null;
  if (!key) return;
  if (host.storyShown()) {
    e.preventDefault();
    if (key === 'stop') host.closeStory();
    else if (key === 'stepInto' || key === 'stepOver' || key === 'stepOut') host.move(key === 'stepInto' ? 'into' : key === 'stepOut' ? 'out' : 'over');
    return;
  }
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
  if (msg.type === 'hello' && msg.build) {
    // A bridge restarted on a new build serves page code this tab does not have.
    if (staleBuild(pageBuild, msg.build, code.dirty)) { location.reload(); return; }
    pageBuild ??= msg.build;
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
$('pkw-story-toggle').addEventListener('click', () => {
  if (presentation !== 'learn') setPresentation('learn');
  if (host.storyShown()) host.closeStory();
  else void host.openStory();
});
$('pkw-story-follow').addEventListener('click', () => host.followLiveHistory());
let historyVisible = true;
try { historyVisible = localStorage.getItem('tracelight.web.historyVisible') !== 'false'; } catch { /* use the default */ }
function updateHistoryVisibility(): void {
  document.body.dataset.history = historyVisible ? 'shown' : 'hidden';
  $('pkw-history-toggle').setAttribute('aria-pressed', String(historyVisible));
  $('pkw-history-toggle').title = historyVisible ? 'Hide inline values' : 'Show inline values';
  code.layout();
  host.scheduleRender(true);
}
$('pkw-history-toggle').addEventListener('click', () => {
  historyVisible = !historyVisible;
  try { localStorage.setItem('tracelight.web.historyVisible', String(historyVisible)); } catch { /* preference lasts for this visit */ }
  updateHistoryVisibility();
});
updateHistoryVisibility();
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
const storySplit = $('pkw-story-split');
let historyWidth = 32;
try {
  const saved = Number(localStorage.getItem('tracelight.web.historyWidth'));
  if (saved >= 20 && saved <= 60) historyWidth = saved;
} catch { /* use the default width */ }
function resizeHistory(width: number): void {
  historyWidth = Math.max(20, Math.min(60, width));
  $('pkw-main').style.setProperty('--pkw-history-width', `${historyWidth}%`);
  storySplit.setAttribute('aria-valuenow', String(Math.round(historyWidth)));
  storySplit.setAttribute('aria-orientation', innerWidth <= 760 ? 'horizontal' : 'vertical');
  code.layout();
  storyCode.layout();
}
function saveHistoryWidth(): void {
  try { localStorage.setItem('tracelight.web.historyWidth', String(historyWidth)); } catch { /* keep this visit's width */ }
}
resizeHistory(historyWidth);
storySplit.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  e.preventDefault();
  storySplit.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => {
    const rect = $('pkw-main').getBoundingClientRect();
    resizeHistory(innerWidth <= 760 ? (rect.bottom - ev.clientY) / rect.height * 100 : (rect.right - ev.clientX) / rect.width * 100);
  };
  const up = () => {
    storySplit.removeEventListener('pointermove', move);
    storySplit.removeEventListener('pointerup', up);
    storySplit.removeEventListener('pointercancel', up);
    saveHistoryWidth();
  };
  storySplit.addEventListener('pointermove', move);
  storySplit.addEventListener('pointerup', up);
  storySplit.addEventListener('pointercancel', up);
});
storySplit.addEventListener('keydown', e => {
  const delta = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? 2 : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? -2 : 0;
  if (!delta) return;
  e.preventDefault();
  resizeHistory(historyWidth + delta);
  saveHistoryWidth();
});
window.addEventListener('resize', () => resizeHistory(historyWidth));

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
