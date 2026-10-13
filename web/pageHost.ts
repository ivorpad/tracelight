/**
 * The browser page's stand-in for the extension host: it reads the runtime's events relayed by the
 * bridge, keeps the run (files, values, errors, coverage, the recorded trace) and the Time Machine
 * position, and feeds the unchanged panel (webview/App.tsx) the same `HostToWebview` messages the
 * extension sends, while drawing the code pane. The other views are panes.ts's, the live debugger
 * debugHost.ts's. Only vscode-free modules of the extension are reused, so nothing here knows the
 * runtime's language.
 */
import type { TraceModel } from '../src/timeMachine/traceModel';
import { buildWalkthrough } from '../src/session/walkthrough';
import { buildExceptionReport } from '../src/session/exceptionReport';
import type { WalkthroughInputs } from '../src/session/walkthroughShared';
import type { ExceptionSite } from '../src/session/exceptionReportTypes';
import type { LogEvent, RunEvent } from '../src/shared/protocol';
import type { DebuggerState, ExceptionsPanel, HostToWebview, PanelEntry, PanelMoment, PanelSettings, WalkthroughPanel, WebviewToHost } from '../src/shared/webviewProtocol';
import type { BridgeFile, BridgeProfile, BridgeToPage, ConfigPatch, PageState, PageToBridge, RecentFile, RequestBody, RuntimeInfo } from './bridgeProtocol';
import { renderProfile } from './profileSummary';
import type { RunnerMessage } from '../src/shared/protocol';
import { applyEvent, emptyRun, runInputs, type RunData } from './runState';
import { Panes } from './panes';
import { DebugHost } from './debugHost';
import type { PausedValues } from './pausedValues';
import type { TeachingNote } from './bridgeProtocol';
import { buildStory, paintStory, storyRowOf, storyTarget, STORY_PATH, type StoryModel } from './story';

/** What the page needs from its bridge connection (web/link.ts). */
export interface Link {
  send(msg: PageToBridge): void;
  request(body: RequestBody): Promise<RunnerMessage>;
  /** a request for the live debugger's run */
  debugRequest(body: RequestBody): Promise<RunnerMessage>;
}

export interface CodeDecorations {
  /** line -> the value text shown after it */
  inline: Map<number, string>;
  /** line -> coverage state (docs/PROTOCOL.md `coverage`: 0 not run, 1 covered, 2 partial, 3 error source, 4 error path) */
  coverage: Map<number, number>;
  /** the Time Machine's line, and whether the step entered a function */
  current: { line: number; col: number } | null;
  /** lines of the frames that called the current one */
  callers: number[];
  /** line -> exception text */
  errors: Map<number, string>;
  /** line -> breakpoint of the live debugger (`condition` when it has one) */
  breakpoints: Map<number, { condition?: string }>;
  /** the line the live debugger is paused at, in this file */
  paused: number | null;
  liveValues?: PausedValues;
  /** the Code Story only: the current step's columns on its line, and the columns to render dim */
  box?: { line: number; start: number; end: number } | null;
  dim?: { line: number; start: number; end: number }[];
}

/** What the page needs from the code pane (web/codePane.ts). */
export interface CodeView {
  peekValue?(name: string): Promise<{ name: string; visible: boolean }>;
  inspectValue?(name: string, open: boolean): { name: string; open: boolean; visible: boolean };
  valueUiState?(): { name: string; open: boolean; visible: boolean }[];
  presentationReady?(): Promise<void>;
  setNotes?(notes: TeachingNote[]): void;
  cacheFile?(file: BridgeFile): void;
  showFile(file: BridgeFile, opts?: { keepDirty?: boolean }): void;
  shownPath(): string | undefined;
  render(d: CodeDecorations): void;
  reveal(line: number): void;
  setNarration(n: { text: string; line: number } | null): void;
  cursorLine(): number | undefined;
  /** the main file's edited text when it differs from the disk */
  dirtyContent?(): string | undefined;
  /** the bridge switched to another main file (Open Recent) */
  setMain?(file: BridgeFile): void;
}

/** Paths of the read-only documents the page makes up (never files on disk). */
export const PROFILE_PATH = 'tracelight://profile';
export const LOG_PATH = 'tracelight://logs';

export type { RunData } from './runState';

export type MoveKind = 'into' | 'over' | 'out' | 'back' | 'backOver' | 'backOut';

interface Nav {
  active: boolean;
  step: number;
  showCallStack: boolean;
  selectedFrame: number;
  codePreview: boolean;
  echo: boolean;
  autoPlaying: boolean;
}

export const BROWSER_SETTINGS: PanelSettings = {
  autoLog: false,
  valuePeek: true,
  showValueOnSelection: false,
  showSingleInlineValue: true,
  runMode: 'auto',
  libraryCode: false,
  maskSecrets: true,
  runTimeoutMs: 30000,
  recordLocals: true,
  http: 'off',
  diagramDetail: 'scopes',
  diagramDataEdges: true,
};

export class PageHost {
  main: BridgeFile | null = null;
  runtime: RuntimeInfo | null = null;
  connected = false;
  run: RunData | null = null;
  /** a run that began but has sent nothing yet: the previous run stays on screen until it does */
  private incoming: RunData | null = null;
  readonly nav: Nav = { active: false, step: -1, showCallStack: false, selectedFrame: 0, codePreview: true, echo: true, autoPlaying: false };
  settings: PanelSettings = { ...BROWSER_SETTINGS };
  theme: 'dark' | 'light' = 'dark';
  narration: { text: string; line: number; path: string } | null = null;
  /** sources of files other than the main one, fetched on demand */
  private readonly sources = new Map<string, string>();
  private readonly sourceIdentities = new Map<string, import('../src/shared/protocol').SourceBindings>();
  private readonly identityRequests = new Map<string, Promise<void>>();

  private identities(path: string, content: string): import('../src/shared/protocol').SourceBindings {
    const key = JSON.stringify([path, content]);
    const known = this.sourceIdentities.get(key);
    if (known) return known;
    if (!this.identityRequests.has(key)) {
      const request = this.link.request({ type: 'bindings', source: content, path, identifiers: true }).then(reply => {
        if (reply.type === 'bindings' && reply.identifiers) this.sourceIdentities.set(key, reply.identifiers);
        this.scheduleRender();
      }).catch(() => { /* No syntax identity means no value attached to source. */ });
      this.identityRequests.set(key, request);
    }
    return { scopes: [], references: [] };
  }
  private panelReady = false;
  private pendingEntries: LogEvent[] = [];
  private entriesTimer: ReturnType<typeof setTimeout> | undefined;
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private autoPlayTimer: ReturnType<typeof setInterval> | undefined;
  /** the Time Machine was asked for before the trace arrived: start it when it does */
  private startWhenTraced: { step?: number; line?: number } | null = null;
  private readonly finishWaiters: (() => void)[] = [];
  /** called on every change an agent could ask about */
  onChange: () => void = () => {};
  /** a message for the person: a runtime error, an action the browser cannot do yet */
  notice: (text: string, level: 'info' | 'error') => void = (text) => console.warn(`[tracelight] ${text}`);
  /** the views beyond Output and the Time Machine (panes.ts) */
  readonly panes: Panes;
  /** the live debugger (debugHost.ts) */
  readonly debug: DebugHost;
  /** `fetchSource` callers waiting for the bridge's `file` answer, by path */
  private readonly sourceWaiters = new Map<string, ((content: string | undefined) => void)[]>();

  constructor(
    private readonly link: Link,
    private readonly code: CodeView,
    private readonly toPanel: (m: HostToWebview) => void,
  ) {
    const host = this;
    this.panes = new Panes({
      get run() {
        return host.run;
      },
      get main() {
        return host.main;
      },
      get nav() {
        return host.nav;
      },
      busy: () => !!this.incoming || !!this.run?.running,
      recordLocals: () => this.settings.recordLocals,
      post: (m) => this.post(m),
      send: (m) => this.link.send(m),
      request: (body) => this.link.request(body),
      displayPath: (fileId) => this.displayPath(fileId),
      sourceLines: (fileId) => this.sourceOf(fileId)?.split(/\r?\n/),
      fetchSource: (fileId) => this.fetchSource(fileId),
      mainFileId: () => this.mainFileId(),
      inputs: () => this.inputs(),
      gotoStep: (step) => (this.nav.active ? this.goto(step) : void this.start({ step })),
      rerunForWatches: () => this.rerun(this.code.dirtyContent?.()),
      pushDebugger: () => this.pushDebugger(),
      pushWalkthrough: () => this.pushWalkthrough(),
      updateSettings: (patch) => this.updateSettings(patch),
    });
    this.debug = new DebugHost(
      { send: (m) => this.link.send(m), debugRequest: (body) => this.link.debugRequest(body) },
      (m) => this.post(m),
      () => this.main,
      (path, line) => this.revealPath(path, line),
      (text, level) => this.notice(text, level),
      () => this.run?.files.all().map((f) => f.path) ?? [],
    );
    this.debug.onChange = () => {
      const p = this.debug.paused;
      const path = p ? this.debug.pathOf(p.stack[this.debug.selectedFrame]?.fileId ?? p.fileId) : undefined;
      if (this.valuePresentation && (this.valuePresentation.runId !== this.debug.run?.runId || this.valuePresentation.frame !== this.debug.selectedFrame || !this.debug.active || (path && path !== this.valuePresentation.file))) this.valuePresentation = null;
      this.scheduleRender();
      this.onChange();
    };
  }

  /** Every message to the panel goes through here: none before it said it is ready. */
  private post(m: HostToWebview): void {
    if (this.panelReady) this.toPanel(m);
  }

  /* ---------- bridge ---------- */

  onBridge(msg: BridgeToPage): void {
    switch (msg.type) {
      case 'hello':
        if (this.main && this.main.path !== msg.file.path) {
          // Open Recent: another file is the main one now
          this.stop();
          this.debug.stop();
          this.sources.clear();
          this.code.setMain?.(msg.file);
        }
        this.main = msg.file;
        this.runtime = msg.runtime;
        this.panes.canNarrate = msg.canNarrate;
        this.code.showFile(msg.file);
        this.pushSession();
        break;
      case 'runtime':
        this.runtime = msg.runtime;
        break;
      case 'file':
        this.languageSourcesPending.delete(msg.file.path);
        this.code.cacheFile?.(msg.file);
        if (this.main && msg.file.path === this.main.path) {
          this.main = msg.file;
          if (this.code.shownPath() === msg.file.path) this.code.showFile(msg.file);
        } else {
          this.sources.set(msg.file.path, msg.file.content);
          for (const w of this.sourceWaiters.get(msg.file.path)?.splice(0) ?? []) w(msg.file.content);
          if (this.wantPath === msg.file.path) {
            this.wantPath = undefined;
            this.code.showFile(msg.file);
            this.scheduleRender(true);
            if (this.wantLine) this.code.reveal(this.wantLine);
            this.wantLine = undefined;
          }
        }
        break;
      case 'run.begin':
        this.incoming = emptyRun(msg.runId, msg.content);
        this.pushSession(true);
        break;
      case 'event':
        this.onEvent(msg.event);
        break;
      case 'runner.error':
        (this.incoming ?? this.run)?.runnerErrors.push(msg.message);
        this.notice(msg.message, 'error');
        break;
      case 'narration':
        this.panes.onNarration(msg.narration);
        break;
      case 'tour':
        this.panes.onTour(msg.tour);
        break;
      case 'debug.begin':
        this.debug.onBegin(msg.runId, msg.content);
        break;
      case 'debug.event':
        if (msg.event.type === 'file.instrumented') this.ensureLanguageSource(msg.event.path);
        this.debug.onEvent(msg.event);
        break;
      case 'debug.end':
        this.debug.onEnd(msg.runId, msg.message);
        break;
      case 'profile':
        this.onProfile(msg.profile);
        break;
      case 'recent':
        this.onRecent(msg.files);
        break;
      case 'saved':
      case 'agent':
        break;
    }
    this.onChange();
  }

  private readonly languageSourcesPending = new Set<string>();
  private ensureLanguageSource(path: string): void {
    if (!this.code.cacheFile || path === this.main?.path || !/\.[cm]?[jt]sx?$/.test(path) || this.languageSourcesPending.has(path)) return;
    const content = this.sources.get(path);
    if (content !== undefined) {
      this.code.cacheFile({ path, content, displayName: path.split('/').pop()!, language: languageOf(path) });
      return;
    }
    this.languageSourcesPending.add(path);
    this.link.send({ type: 'file.read', path });
  }

  private onEvent(ev: RunEvent): void {
    if (this.incoming && ev.runId === this.incoming.runId) this.adoptIncoming();
    const run = this.run;
    if (!run || !applyEvent(run, ev)) return;
    switch (ev.type) {
      case 'file.instrumented':
        this.ensureLanguageSource(ev.path);
        break;
      case 'log':
        if (!this.nav.active || ev.step <= this.nav.step) this.queueEntry(ev);
        this.scheduleRender();
        break;
      case 'output':
        this.post({ type: 'output', stream: ev.stream, text: ev.text });
        break;
      case 'error':
        this.pushErrors();
        this.scheduleRender();
        break;
      case 'coverage':
        this.scheduleRender();
        break;
      case 'trace':
        if (run.trace && run.traceEvent === ev) this.post({ type: 'timeline', model: run.trace.toTimelineModel() });
        break;
      case 'http.exchange':
        this.panes.scheduleHttp();
        break;
      case 'watch':
        this.panes.onWatchEvent(ev);
        break;
      case 'run.finished':
        this.flushEntries();
        this.pushSession();
        this.pushWalkthrough();
        this.pushExceptions();
        this.panes.runFinished();
        this.afterFinish();
        break;
      default:
        break;
    }
  }

  /** The new run's first event: it replaces the one on screen. */
  private adoptIncoming(): void {
    const prevStep = this.nav.active ? this.nav.step : null;
    this.run = this.incoming;
    this.incoming = null;
    this.pendingEntries = [];
    this.toPanel({ type: 'entries.reset' });
    this.toPanel({ type: 'errors', errors: [] });
    this.toPanel({ type: 'timeline', model: null });
    this.toPanel({ type: 'walkthrough', walkthrough: null });
    this.toPanel({ type: 'exceptions', report: null });
    if (this.run) this.panes.runAdopted(this.run);
    if (prevStep !== null) {
      // keep the Time Machine where it was across a re-run (an edit, a save): restored on the new trace
      this.stopAutoPlay();
      this.nav.active = false;
      this.startWhenTraced = { step: prevStep };
      this.pushDebugger();
    }
    this.pushSession();
  }

  private afterFinish(): void {
    const want = this.startWhenTraced;
    this.startWhenTraced = null;
    if (want && this.run?.trace) this.start(want);
    else this.scheduleRender(true);
    for (const w of this.finishWaiters.splice(0)) w();
  }

  /** Resolves once no run is in flight (at once when none is). */
  idle(timeoutMs = 30_000): Promise<void> {
    if (!this.incoming && !this.run?.running) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      this.finishWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  /* ---------- panel ---------- */

  onPanel(msg: WebviewToHost): void {
    switch (msg.type) {
      case 'ready':
        this.panelReady = true;
        this.toPanel({ type: 'init', theme: this.theme, settings: this.settings, sessionName: this.main?.displayName ?? null });
        this.pushSession();
        this.pushAll();
        return;
      case 'expand':
        void this.expand(msg.requestId, msg.valueId, msg.queryPath);
        return;
      case 'openLocation':
        this.openLocation(msg.fileId, msg.line, msg.file);
        return;
      case 'copy':
        void navigator.clipboard?.writeText(msg.text).catch(() => undefined);
        return;
      case 'settings.update':
        this.updateSettings(msg.patch);
        return;
      case 'debugger.goto':
        if (!this.nav.active) this.start({ step: msg.step });
        else this.goto(msg.step);
        return;
      case 'debugger.action':
        this.debuggerAction(msg.action);
        return;
      case 'debugger.previewRequest':
        this.pushPreview(msg.step);
        return;
      case 'debugger.selectFrame':
        this.selectFrame(msg.index);
        return;
      case 'command':
        this.command(msg.command);
        return;
      case 'variable.query':
        void this.panes.queryVariable(msg.name);
        return;
      case 'why.query':
        void this.panes.queryWhy(msg.step, msg.name, msg.logId);
        return;
      case 'why.close':
        this.panes.closeWhy();
        return;
      case 'executionGraph.request':
        this.panes.pushGraph();
        return;
      case 'executionGraph.expand':
        this.panes.expandGraph(msg.nodeId, msg.collapse);
        return;
      case 'executionGraph.hits':
        this.panes.graphHits(msg.nodeId);
        return;
      case 'narrate':
        this.panes.narrate();
        return;
      case 'tour.open':
        this.panes.setTourOpen(msg.open);
        return;
      case 'tour.goto':
        this.panes.tourGoto(msg.step, msg.stopId);
        return;
      case 'tour.narrate':
        this.panes.narrateTour();
        return;
      case 'tour.recordLocals':
        this.panes.recordLocalsAndRun();
        return;
      case 'compare':
        this.panes.compare(msg.leftLogId, msg.rightLogId);
        return;
      case 'diagram':
        this.post({ type: 'showView', view: 'diagram' });
        return;
      case 'watch.add':
        if (!this.nav.active) this.start({ line: this.code.cursorLine() });
        this.panes.addWatch(msg.exp);
        return;
      case 'watch.remove':
        this.panes.removeWatch(msg.id);
        return;
      case 'watch.edit':
        this.panes.editWatch(msg.id, msg.exp);
        return;
      case 'watch.refresh':
        this.panes.refreshWatch(msg.id);
        return;
      case 'watch.evaluate':
        this.panes.evaluateWatch(msg.id);
        return;
      case 'watch.complete':
        void this.panes.complete(msg.requestId, msg.text);
        return;
      case 'debug.selectFrame':
      case 'debug.watch.add':
      case 'debug.watch.edit':
      case 'debug.watch.remove':
      case 'debug.breakpoint.remove':
      case 'debug.exceptions':
      case 'debug.control':
      case 'debug.output.resync':
        void this.debug.handle(msg);
        return;
      case 'debugContinue':
        void this.debug.control('continue');
        return;
      case 'debugPause':
        void this.debug.control('pause');
        return;
      case 'debugStep':
        void this.debug.control(msg.kind === 'over' ? 'stepOver' : msg.kind === 'out' ? 'stepOut' : 'stepInto');
        return;
      case 'debugStop':
        this.debug.stop();
        return;
      default:
        return;
    }
  }

  private command(command: string): void {
    switch (command) {
      case 'tracelight.reexecute':
        this.rerun();
        return;
      case 'tracelight.debug':
      case 'tracelight.startOnCurrentFile':
        this.start({ line: this.code.cursorLine() });
        return;
      case 'tracelight.stopTraceNavigation':
        this.stop();
        return;
      case 'tracelight.showOutput':
        return;
      case 'tracelight.debugCurrentFile':
        this.debug.start(this.code.dirtyContent?.());
        return;
      case 'tracelight.explain':
        this.panes.narrate();
        return;
      case 'tracelight.viewCodeStory':
        void this.openStory();
        return;
      case 'tracelight.profile':
        this.profile();
        return;
      case 'tracelight.showInstrumentedFile':
        void this.showInstrumented();
        return;
      case 'tracelight.showLogs':
        // always the bridge's latest lines
        this.sources.delete(LOG_PATH);
        this.revealPath(LOG_PATH, 1);
        return;
      case 'tracelight.editSessionSettings':
        this.post({ type: 'showView', view: 'settings' });
        return;
      case 'tracelight.viewRecentFiles':
        this.link.send({ type: 'recent' });
        return;
      case 'tracelight.openHttpRecording': {
        const file = this.run?.finished?.http?.file;
        if (!file) this.notice('no HTTP recording yet: run once with HTTP Record', 'info');
        else this.revealPath(file, 1);
        return;
      }
      default:
        this.notice(`${command.replace(/^tracelight\./, '')} is not available in the browser yet`, 'info');
    }
  }

  updateSettings(patch: Partial<PanelSettings>): void {
    this.settings = { ...this.settings, ...patch };
    this.toPanel({ type: 'settings', settings: this.settings });
    const config: ConfigPatch = {};
    if (patch.autoLog !== undefined) config.autoLog = patch.autoLog;
    if (patch.libraryCode !== undefined) config.libraryCode = patch.libraryCode;
    if (patch.recordLocals !== undefined) config.recordLocals = patch.recordLocals;
    if (patch.maskSecrets !== undefined) config.maskSecrets = patch.maskSecrets;
    if (patch.runTimeoutMs !== undefined) config.timeoutMs = patch.runTimeoutMs;
    if (patch.http !== undefined) config.http = patch.http;
    if (Object.keys(config).length) this.link.send({ type: 'config', patch: config });
    if (patch.runMode !== undefined) this.link.send({ type: 'runMode', mode: patch.runMode });
    this.pushSession();
  }

  private async expand(requestId: number, valueId: string, queryPath: string[]): Promise<void> {
    const runId = this.run?.runId;
    if (!runId) return;
    const reply = await this.link.request({ type: 'expand', runId, valueId, queryPath });
    if (reply.type === 'value') this.toPanel({ type: 'value', requestId, node: reply.node });
    else this.toPanel({ type: 'value', requestId, error: reply.type === 'error' ? reply.message : `unexpected reply ${reply.type}` });
  }

  /** Run the file again (the buffer when `content` is given), with the watches around the Time Machine's step. */
  rerun(content?: string): void {
    const watch = this.panes.watchRequests();
    const traceContext = this.nav.active && watch.length ? { step: this.nav.step, prefetch: 10 } : null;
    this.link.send({ type: 'run', ...(content === undefined ? {} : { content }), watch, traceContext });
  }

  /* ---------- pushing state to the panel ---------- */

  private pushAll(): void {
    const run = this.run;
    if (!run) return;
    this.toPanel({ type: 'entries.reset' });
    this.pushEntries();
    this.pushErrors();
    this.toPanel({ type: 'timeline', model: run.trace ? run.trace.toTimelineModel() : null });
    this.pushDebugger();
    this.pushWalkthrough();
    this.pushExceptions();
    this.panes.resync();
    this.debug.push();
  }

  /** The inputs of the walkthrough and exceptions builders, once the run finished with a trace. */
  inputs(): WalkthroughInputs | undefined {
    if (!this.main) return undefined;
    return runInputs(this.run, this.main.path, (fileId) => this.sourceOf(fileId)?.split(/\r?\n/), this.panes.glosses());
  }

  /** The WALKTHROUGH section: the run's moments (no narration backend in the browser). */
  pushWalkthrough(): void {
    const inputs = this.inputs();
    if (!inputs || !this.panelReady) return;
    const w = buildWalkthrough(inputs);
    const moments: PanelMoment[] = w.moments.map((m) => ({ id: m.id, kind: m.kind, step: m.step, fileId: m.location.fileId, file: this.displayPath(m.location.fileId), line: m.location.line, function: m.location.function, text: m.text, values: m.values, gloss: m.gloss, more: m.more, entryStep: m.entryStep, endStep: m.endStep }));
    const panel: WalkthroughPanel = { runId: this.run!.runId, count: w.count, total: w.total, shown: w.shown, truncated: w.truncated, moments, narrating: this.panes.narrating(), canNarrate: this.panes.canNarrate, ...(this.panes.narrationError() ? { narrationError: this.panes.narrationError() } : {}) };
    this.toPanel({ type: 'walkthrough', walkthrough: panel });
  }

  /** The EXCEPTIONS section: every exception of the last run, with display paths. */
  private pushExceptions(): void {
    const inputs = this.inputs();
    if (!inputs || !this.panelReady) return;
    const report = buildExceptionReport(inputs);
    const shown = <T extends ExceptionSite>(site: T): T => ({ ...site, file: this.displayPath(site.fileId) });
    const rows = report.rows.map((r) => ({ ...r, raisedAt: shown(r.raisedAt), handledAt: r.handledAt ? shown(r.handledAt) : null }));
    const panel: ExceptionsPanel = { ...report, file: report.file ? (this.main?.displayName ?? null) : null, rows, runId: this.run!.runId };
    this.toPanel({ type: 'exceptions', report: panel });
  }

  private pushSession(running?: boolean): void {
    if (!this.panelReady) return;
    const run = this.run;
    const busy = running ?? (!!this.incoming || !!run?.running);
    this.toPanel({
      type: 'session',
      name: this.main?.displayName ?? null,
      running: busy,
      durationMs: run?.finished?.durationMs,
      runMode: 'auto',
      settings: this.settings,
      ...(run?.finished?.timedOut ? { timedOutMs: this.settings.runTimeoutMs } : {}),
    });
  }

  private queueEntry(ev: LogEvent): void {
    this.pendingEntries.push(ev);
    if (this.pendingEntries.length >= 200) this.flushEntries();
    else if (!this.entriesTimer) this.entriesTimer = setTimeout(() => this.flushEntries(), 30);
  }

  private flushEntries(): void {
    if (this.entriesTimer) clearTimeout(this.entriesTimer);
    this.entriesTimer = undefined;
    const batch = this.pendingEntries;
    this.pendingEntries = [];
    if (batch.length && this.panelReady) this.toPanel({ type: 'entries.append', entries: batch.map((e) => this.toPanelEntry(e)) });
  }

  private visibleLogs(): LogEvent[] {
    const run = this.run;
    if (!run) return [];
    return this.nav.active ? run.logs.filter((e) => e.step <= this.nav.step) : run.logs;
  }

  private pushEntries(): void {
    if (!this.panelReady) return;
    this.pendingEntries = [];
    const logs = this.visibleLogs();
    this.toPanel({ type: 'entries.reset' });
    for (let i = 0; i < logs.length; i += 500) this.toPanel({ type: 'entries.append', entries: logs.slice(i, i + 500).map((e) => this.toPanelEntry(e)) });
  }

  private pushErrors(): void {
    const run = this.run;
    if (!run || !this.panelReady) return;
    const errors = run.errors.map((e) => {
      const loc = run.files.locate(e.rid);
      return { ...e, file: this.displayPath(e.fileId), line: loc?.range[0] ?? e.stack[0]?.line ?? 0, col: loc?.range[1] ?? 0 };
    });
    this.toPanel({ type: 'errors', errors });
  }

  toPanelEntry(e: LogEvent): PanelEntry {
    const loc = this.run?.files.locate(e.rid);
    return {
      logId: e.logId,
      kind: e.kind,
      fileId: e.fileId,
      file: this.displayPath(e.fileId),
      line: e.liveLine ?? loc?.range[0] ?? 0,
      col: loc?.range[1] ?? 0,
      rid: e.rid,
      hit: e.hit,
      step: e.step,
      context: e.context,
      text: e.text,
      runtimeKey: e.runtimeKey,
      valueBag: e.valueBag,
      isError: e.kind === 'error',
      time: e.time,
    };
  }

  /** A path relative to the main file's directory, else as the runtime reported it. */
  displayPath(fileId: number): string {
    const p = this.run?.files.get(fileId)?.path;
    if (!p) return '';
    const dir = this.main ? this.main.path.slice(0, this.main.path.length - this.main.displayName.length) : '';
    return dir && p.startsWith(dir) ? p.slice(dir.length) : p;
  }

  private debuggerState(): DebuggerState {
    const trace = this.run?.trace;
    const nav = this.nav;
    const step = nav.step;
    const valid = !!trace && nav.active && trace.valid(step);
    const canStep = valid ? trace!.canStep(step) : { into: false, back: false, over: false, backOver: false, out: false, backOut: false };
    const callStack = nav.showCallStack && valid
      ? { frames: trace!.callStack(step).map((f) => ({ fileId: f.fileId, line: f.line, col: f.col, rid: f.rid, function: f.function, step: f.step, scopeId: f.scopeId })), selected: nav.selectedFrame }
      : undefined;
    const locals = this.run?.locals.find((l) => l.step === step)?.changes;
    return {
      active: nav.active,
      autoPlaying: nav.autoPlaying,
      currentStep: step,
      canStep,
      echoSteps: nav.echo && valid ? trace!.echoSteps(step) : [],
      callStack,
      showCallStack: nav.showCallStack,
      codePreview: nav.codePreview,
      echo: nav.echo,
      watches: this.panes.watchRows(step),
      locals,
    };
  }

  pushDebugger(): void {
    if (this.panelReady) this.toPanel({ type: 'debugger', state: this.debuggerState() });
  }

  private pushPreview(step: number): void {
    const run = this.run;
    const trace = run?.trace;
    const loc = trace?.location(step);
    if (!run || !trace || !loc) return;
    const lines = (this.sourceOf(loc.fileId) ?? '').split(/\r?\n/);
    const line = loc.range[0];
    const start = Math.max(1, line - 3);
    const end = Math.min(lines.length, start + 6);
    const [frame, callSite] = trace.callStack(step);
    const caller = callSite ? { step: callSite.step, function: callSite.function, file: this.displayPath(callSite.fileId), line: callSite.line } : undefined;
    this.toPanel({ type: 'codePreview', step, file: this.displayPath(loc.fileId), startLine: start, lines: lines.slice(start - 1, end), highlightLine: line, function: frame?.function ?? '<module>', caller });
  }

  /* ---------- Time Machine ---------- */

  get trace(): TraceModel | null {
    return this.run?.trace ?? null;
  }

  mainFileId(): number | undefined {
    if (!this.run || !this.main) return undefined;
    return this.run.files.byPath(this.main.path)?.fileId;
  }

  /** Turn the Time Machine on at `step`, or at the first step on `line` of the shown file, else step 0. */
  start(opts: { step?: number; line?: number } = {}): boolean {
    const trace = this.trace;
    if (!trace || this.incoming || this.run?.running) {
      this.startWhenTraced = opts;
      if (!this.run && !this.incoming) this.rerun();
      return false;
    }
    if (trace.count === 0) return false;
    let step = opts.step;
    if (step === undefined && opts.line !== undefined) {
      const fileId = this.shownFileId() ?? this.mainFileId();
      if (fileId !== undefined) step = trace.startStep(fileId, opts.line);
    }
    this.nav.active = true;
    this.nav.selectedFrame = 0;
    this.goto(step ?? 0);
    return true;
  }

  stop(): void {
    this.stopAutoPlay();
    if (!this.nav.active) return;
    this.nav.active = false;
    this.nav.step = -1;
    this.nav.showCallStack = false;
    // D2: the story exists only while the Time Machine is on
    if (this.storyShown()) this.showMain();
    this.pushDebugger();
    this.pushEntries();
    this.scheduleRender(true);
    this.panes.navChanged();
    this.onChange();
  }

  goto(step: number): void {
    const trace = this.trace;
    if (!trace || !this.nav.active) return;
    const clamped = trace.clamp(step);
    if (clamped < 0) return;
    this.nav.step = clamped;
    this.nav.selectedFrame = 0;
    this.pushDebugger();
    this.pushEntries();
    this.showStep(clamped);
    this.panes.navChanged();
    this.onChange();
  }

  /** Move like the toolbar; false when there is nowhere to go. */
  move(kind: MoveKind): boolean {
    const trace = this.trace;
    if (!trace || !this.nav.active) return false;
    const i = this.nav.step;
    const next = kind === 'into' ? trace.stepInto(i)
      : kind === 'back' ? trace.stepBackInto(i)
      : kind === 'over' ? trace.stepOver(i)
      : kind === 'backOver' ? trace.stepBackOver(i)
      : kind === 'out' ? trace.stepOut(i)
      : trace.stepBackOut(i);
    if (next < 0) return false;
    this.goto(next);
    return true;
  }

  private debuggerAction(action: Extract<WebviewToHost, { type: 'debugger.action' }>['action']): void {
    switch (action) {
      case 'start':
        this.start({ line: this.code.cursorLine() });
        return;
      case 'stop':
        this.stop();
        return;
      case 'stepInto':
        this.move('into');
        return;
      case 'stepBackInto':
        this.move('back');
        return;
      case 'stepOver':
        this.move('over');
        return;
      case 'stepBackOver':
        this.move('backOver');
        return;
      case 'stepOut':
        this.move('out');
        return;
      case 'stepBackOut':
        this.move('backOut');
        return;
      case 'runToLine':
      case 'runBackToLine': {
        const trace = this.trace;
        const line = this.code.cursorLine();
        const fileId = this.shownFileId();
        if (!trace || line === undefined || fileId === undefined) return;
        const next = action === 'runToLine' ? trace.runToLine(this.nav.step, fileId, line) : trace.runBackToLine(this.nav.step, fileId, line);
        if (next >= 0) this.goto(next);
        return;
      }
      case 'autoPlay':
        this.autoPlay();
        return;
      case 'pause':
        this.stopAutoPlay();
        this.pushDebugger();
        return;
      case 'toggleCallStack':
        this.nav.showCallStack = !this.nav.showCallStack;
        this.pushDebugger();
        return;
      case 'toggleEcho':
        this.nav.echo = !this.nav.echo;
        this.pushDebugger();
        return;
      case 'toggleCodePreview':
        this.nav.codePreview = !this.nav.codePreview;
        this.pushDebugger();
        return;
    }
  }

  private autoPlay(): void {
    if (!this.nav.active && !this.start()) return;
    this.stopAutoPlay();
    this.nav.autoPlaying = true;
    this.autoPlayTimer = setInterval(() => {
      if (!this.move('into')) {
        this.stopAutoPlay();
        this.pushDebugger();
      }
    }, 350);
    this.pushDebugger();
  }

  private stopAutoPlay(): void {
    if (this.autoPlayTimer) clearInterval(this.autoPlayTimer);
    this.autoPlayTimer = undefined;
    this.nav.autoPlaying = false;
  }

  private selectFrame(index: number): void {
    const trace = this.trace;
    if (!trace || !this.nav.active) return;
    const frame = trace.callStack(this.nav.step)[index];
    if (!frame) return;
    this.nav.selectedFrame = index;
    this.pushDebugger();
    this.ensureFileShown(frame.fileId);
    this.code.reveal(frame.line);
  }

  /** Show the step's file in the code pane, scroll to it and redraw. */
  private showStep(step: number): void {
    const loc = this.trace?.location(step);
    if (!loc) return;
    if (this.storyShown()) {
      // the story follows the step (T2) instead of giving the pane back to the source
      this.scheduleRender(true);
      const cur = this.story && this.run ? storyRowOf(this.story, this.run, step) : undefined;
      if (cur) this.code.reveal(cur.row + 1);
      return;
    }
    this.ensureFileShown(loc.fileId);
    this.scheduleRender(true);
    this.code.reveal(loc.range[0]);
  }

  /* ---------- the code pane ---------- */

  private wantPath: string | undefined;

  private sourceOf(fileId: number): string | undefined {
    const path = this.run?.files.get(fileId)?.path;
    if (!path) return undefined;
    if (this.main && path === this.main.path) return this.run!.content;
    return this.sources.get(path);
  }

  shownFileId(): number | undefined {
    const shown = this.code.shownPath();
    return shown ? this.run?.files.byPath(shown)?.fileId : undefined;
  }

  /** Switch the code pane to `fileId`'s source, asking the bridge for it the first time. */
  private ensureFileShown(fileId: number): void {
    const path = this.run?.files.get(fileId)?.path;
    if (!path || this.code.shownPath() === path) return;
    if (this.main && path === this.main.path) {
      this.code.showFile(this.main, { keepDirty: true });
      return;
    }
    const content = this.sources.get(path);
    const name = path.split(/[\\/]/).pop() ?? path;
    if (content !== undefined) this.code.showFile({ path, displayName: name, language: this.main?.language ?? 'plaintext', content });
    else {
      this.wantPath = path;
      this.link.send({ type: 'file.read', path });
    }
  }

  openLocation(fileId: number, line: number, file?: string): void {
    if (fileId < 0 && file) {
      // the Debugger view names files by display path: it has no run table of its own here
      const dir = this.main ? this.main.path.slice(0, this.main.path.length - this.main.displayName.length) : '';
      this.revealPath(file.startsWith('/') ? file : dir + file, line);
      return;
    }
    this.ensureFileShown(fileId);
    this.code.reveal(line);
  }

  /** Show `path` (the main file, a file of a run, the HTTP recording) and scroll to `line`. */
  revealPath(path: string, line: number): void {
    if (this.main && path === this.main.path) {
      if (this.code.shownPath() !== path) this.code.showFile(this.main, { keepDirty: true });
    } else if (this.code.shownPath() !== path) {
      const content = this.sources.get(path);
      const name = path.split(/[\\/]/).pop() ?? path;
      if (content !== undefined) this.code.showFile({ path, displayName: name, language: languageOf(path, this.main?.language), content });
      else {
        this.wantPath = path;
        this.wantLine = line;
        this.link.send({ type: 'file.read', path });
        return;
      }
    }
    this.scheduleRender(true);
    this.code.reveal(line);
  }

  private wantLine: number | undefined;

  /** The lines of a file of the run, asking the bridge for them the first time (undefined after 5 s). */
  fetchSource(fileId: number): Promise<string[] | undefined> {
    const have = this.sourceOf(fileId);
    if (have !== undefined) return Promise.resolve(have.split(/\r?\n/));
    const path = this.run?.files.get(fileId)?.path;
    if (!path) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const list = this.sourceWaiters.get(path) ?? [];
      const t = setTimeout(() => resolve(undefined), 5000);
      list.push((content) => {
        clearTimeout(t);
        resolve(content?.split(/\r?\n/));
      });
      this.sourceWaiters.set(path, list);
      this.link.send({ type: 'file.read', path });
    });
  }

  showMain(): void {
    if (this.main) this.code.showFile(this.main, { keepDirty: true });
    this.scheduleRender(true);
  }

  scheduleRender(now = false): void {
    if (now) {
      if (this.renderTimer) clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
      this.render();
      return;
    }
    if (!this.renderTimer) this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.render();
    }, 50);
  }

  /** The decorations of the file the code pane shows, as of the Time Machine step when it is on. */
  decorations(): CodeDecorations {
    const out: CodeDecorations = { inline: new Map(), coverage: new Map(), current: null, callers: [], errors: new Map(), breakpoints: new Map(), paused: null };
    const shown = this.code.shownPath();
    if (shown) {
      out.breakpoints = this.debug.breakpointsOf(shown);
      const p = this.debug.paused;
      const frame = p?.stack[this.debug.selectedFrame];
      const fileId = frame?.fileId ?? p?.fileId;
      const line = frame?.line ?? p?.line;
      if (p && line && this.debug.pathOf(fileId) === shown) {
        out.paused = line;
        const file = this.debug.run?.files.get(fileId!);
        const startOf = (f: NonNullable<typeof file>['functions'][number]) => file!.ranges[f.rid]?.[0] ?? f.bodyRange[0];
        const fn = file?.functions.filter((f) => f.name !== '<module>' && startOf(f) <= line && f.bodyRange[2] >= line)
          .sort((a, b) => (a.bodyRange[2] - a.bodyRange[0]) - (b.bodyRange[2] - b.bodyRange[0]))[0];
        const cached = this.debug.locals;
        if (cached && cached.step === p.step && cached.frameId === this.debug.selectedFrame) {
          const selection = this.valuePresentation;
          const applies = selection && selection.runId === this.debug.run?.runId && selection.frame === this.debug.selectedFrame && selection.file === shown;
          out.liveValues = {
            line, start: fn ? startOf(fn) : 1,
            end: fn?.bodyRange[2] ?? file?.ranges[0]?.[2] ?? line,
            locals: cached.locals,
            snapshot: `${this.debug.run!.runId}:${p.step}:${this.debug.selectedFrame}`,
            ...(applies && selection.mode !== 'all' ? { ghostNames: selection.mode === 'none' ? [] : selection.names, anchor: selection.line ?? line } : {}),
            excluded: file?.functions.filter((f) => f.name !== '<module>' && f !== fn && (!fn || startOf(f) >= startOf(fn))).map((f) => [startOf(f), f.bodyRange[2]]),
            content: shown === this.main?.path ? this.debug.run?.content : this.sources.get(shown),
          };
          out.liveValues.identifiers = out.liveValues.content !== undefined ? this.identities(shown, out.liveValues.content) : { scopes: [], references: [] };
          out.liveValues.column = this.debug.selectedFrame === 0 ? file?.ranges[p.rid]?.[1] : undefined;
          out.liveValues.entry = this.debug.selectedFrame === 0 && fn?.rid === p.rid && p.stack[0]?.name !== '<module>';
        }
      }
    }
    // Live execution has no recording. Keep the saved run intact, but never paint its results here.
    if (this.debug.active) return out;
    const run = this.run;
    if (shown === STORY_PATH) return this.storyDecorations(out);
    const fileId = this.shownFileId();
    if (!run || fileId === undefined) return out;
    const file = run.files.get(fileId);
    const cov = run.coverage.get(fileId);
    if (file && cov) {
      for (const local of file.statements) {
        const r = file.ranges[local];
        const s = cov.states[local];
        if (!r || s === undefined || s === 5) continue;
        const prev = out.coverage.get(r[0]);
        if (prev === undefined || rank(s) > rank(prev)) out.coverage.set(r[0], s);
      }
    }
    for (const e of this.visibleLogs()) {
      if (e.fileId !== fileId) continue;
      const line = e.liveLine ?? run.files.locate(e.rid)?.range[0];
      if (!line) continue;
      out.inline.set(line, e.context && e.kind === 'value' ? `${e.context} = ${e.text}` : e.text);
    }
    for (const e of run.errors) {
      if (e.handled || (this.nav.active && e.step > this.nav.step)) continue;
      const loc = run.files.locate(e.rid);
      if (loc && loc.fileId === fileId) out.errors.set(loc.range[0], `${e.errorType}: ${e.message}`);
    }
    const trace = run.trace;
    // a live debug run owns the current line while it runs: the Time Machine's would read as a second one
    if (this.nav.active && trace && trace.valid(this.nav.step) && !this.debug.active) {
      const loc = trace.location(this.nav.step);
      if (loc && loc.fileId === fileId) out.current = { line: loc.range[0], col: loc.range[1] };
      // the variables recorded at this step were changed by the statement before it: show them there
      const changes = run.locals.find((l) => l.step === this.nav.step)?.changes;
      const prev = trace.location(this.nav.step - 1) ?? loc;
      if (changes?.length && prev && prev.fileId === fileId) out.inline.set(prev.range[0], changes.map((c) => `${c.name} = ${c.text}`).join(', '));
      for (const f of trace.callStack(this.nav.step).slice(1)) if (f.fileId === fileId) out.callers.push(f.line);
    }
    return out;
  }

  /* ---------- the Code Story ---------- */

  /** the story the code pane shows (rebuilt when the run changes) */
  private story: StoryModel | null = null;

  storyShown(): boolean {
    return this.code.shownPath() === STORY_PATH;
  }

  /** Show the Code Story in the code pane, starting the Time Machine at the cursor first (D2). */
  async openStory(): Promise<boolean> {
    if (!this.nav.active && !this.start({ line: this.code.cursorLine() })) {
      if (!this.trace) this.notice('the Code Story needs a recorded run: run the file first', 'info');
      return false;
    }
    const run = this.run;
    if (!run?.trace) return false;
    // every file the trace ran in, so blocks of other modules list their source too
    const ids = new Set<number>();
    for (let i = 0; i < run.trace.count; i++) {
      const id = run.trace.location(i)?.fileId;
      if (id !== undefined) ids.add(id);
      if (ids.size > 50) break;
    }
    await Promise.all([...ids].map((id) => this.fetchSource(id)));
    if (this.run !== run) return false;
    this.showStory();
    return true;
  }

  private showStory(): void {
    const run = this.run;
    if (!run) return;
    if (!this.story || this.story.runId !== run.runId) this.story = buildStory(run, (id) => this.sourceOf(id)?.split(/\r?\n/) ?? []);
    this.code.showFile({ path: STORY_PATH, displayName: 'Code Story', language: this.main?.language ?? 'plaintext', content: this.story.text });
    this.scheduleRender(true);
    const cur = this.nav.active ? storyRowOf(this.story, run, this.nav.step) : undefined;
    if (cur) this.code.reveal(cur.row + 1);
    this.onChange();
  }

  /** The story as an agent reads it: the text (up to 400 rows) and the Time Machine step's row. */
  storyText(): { text: string; rows: number; step: number | null; row: number | null } {
    const m = this.story;
    if (!m || !this.run) return { text: '', rows: 0, step: null, row: null };
    const lines = m.text.split('\n');
    const cur = this.nav.active ? storyRowOf(m, this.run, this.nav.step) : undefined;
    return { text: lines.slice(0, 400).join('\n'), rows: lines.length - 1, step: this.nav.active ? this.nav.step : null, row: cur ? cur.row + 1 : null };
  }

  private storyDecorations(out: CodeDecorations): CodeDecorations {
    const run = this.run;
    if (!run) return out;
    // a new run: rebuild the story in place (its sources are the ones already fetched)
    if (!this.story || this.story.runId !== run.runId) {
      if (!run.trace || run.running) return out;
      queueMicrotask(() => this.showStory());
      return out;
    }
    const paint = paintStory(this.story, run, this.story.text.split('\n'), this.nav.active ? this.nav.step : undefined);
    out.box = paint.current;
    out.dim = paint.dim;
    if (paint.current) out.current = { line: paint.current.line, col: paint.current.start };
    for (const [line, v] of paint.values) (v.error ? out.errors : out.inline).set(line, v.text);
    return out;
  }

  /** A story row was picked (selection, gutter click): go to the step that ran it; `open` shows the source. */
  storyPick(line: number, open = false): void {
    const t = this.story ? storyTarget(this.story, line) : undefined;
    if (!t) return;
    if (open) {
      this.openLocation(t.fileId, t.line);
      return;
    }
    if (t.step !== undefined && this.nav.active && t.step !== this.nav.step) this.goto(t.step);
  }

  /* ---------- profile, instrumented source, recent files ---------- */

  /** Run once under the runtime's profiler; the bridge answers with `profile`, shown as a table. */
  profile(): void {
    const content = this.code.dirtyContent?.();
    this.link.send({ type: 'profile', ...(content === undefined ? {} : { content }) });
    this.notice(`profiling ${this.main?.displayName ?? 'the file'}…`, 'info');
  }

  /** the last profile, as the bridge summarized it */
  lastProfile: BridgeProfile | null = null;
  /** rows of a made-up document that open a source line (Ctrl/Cmd+click): path -> line -> where */
  private readonly lineTargets = new Map<string, Map<number, { path: string; line: number }>>();

  private readonly profileWaiters: ((p: BridgeProfile) => void)[] = [];

  /** Profile, resolved with the bridge's answer. */
  profileRun(): Promise<BridgeProfile> {
    return new Promise((resolve) => {
      this.profileWaiters.push(resolve);
      this.profile();
    });
  }

  private onProfile(p: BridgeProfile): void {
    this.lastProfile = p;
    for (const w of this.profileWaiters.splice(0)) w(p);
    if (p.error || !p.summary) {
      this.notice(`Profile: ${p.error ?? 'no profile'}`, 'error');
      return;
    }
    const dir = this.main ? this.main.path.slice(0, this.main.path.length - this.main.displayName.length) : '';
    const shortPath = (f: string) => (dir && f.startsWith(dir) ? f.slice(dir.length) : f);
    const targets = new Map<number, { path: string; line: number }>();
    p.summary.rows.forEach((r, i) => {
      if (r.file) targets.set(i + 3, { path: r.file, line: r.line });
    });
    this.lineTargets.set(PROFILE_PATH, targets);
    this.code.showFile({ path: PROFILE_PATH, displayName: 'Profile', language: 'plaintext', content: renderProfile(p.summary, this.main?.displayName ?? 'the file', shortPath) + (p.path ? `# the .cpuprofile (Chrome DevTools, VS Code): /api/profile\n` : '') });
    this.scheduleRender(true);
  }

  /** a row of a made-up document was picked: the story moves the Time Machine, the profile opens the source */
  linePick(path: string, line: number, how: 'select' | 'open'): void {
    if (path === STORY_PATH) {
      this.storyPick(line, how === 'open');
      return;
    }
    const t = this.lineTargets.get(path)?.get(line);
    if (t && how === 'open') this.revealPath(t.path, t.line);
  }

  /** the bridge's answer to View Recent Files (main.tsx shows the list) */
  onRecent: (files: RecentFile[]) => void = (files) => this.notice(files.map((f) => f.path).join('\n') || 'no recent files', 'info');

  /** Make a recent file the main one: the bridge switches, says hello again, and runs it. */
  openFile(path: string): void {
    this.link.send({ type: 'open', path });
  }

  /** The runtime's instrumented source of the shown file (the main one otherwise), read-only in the code pane. */
  async showInstrumented(): Promise<void> {
    const run = this.run;
    const fileId = this.shownFileId() ?? this.mainFileId();
    if (!run || fileId === undefined) {
      this.notice('no instrumented source yet: run the file first', 'info');
      return;
    }
    // library files come without it: the runtime serves those on demand
    let src = run.files.get(fileId)?.instrumentedSource;
    if (!src) {
      const reply = await this.link.request({ type: 'source', runId: run.runId, fileId });
      src = reply.type === 'source' ? (reply.instrumentedSource ?? undefined) : undefined;
      if (!src) {
        this.notice(reply.type === 'error' ? `could not get the instrumented source: ${reply.message}` : 'the runtime has no instrumented source for this file', 'error');
        return;
      }
    }
    const name = (run.files.get(fileId)?.path ?? 'file').split(/[\\/]/).pop();
    const path = `tracelight://instrumented/${name}`;
    this.code.showFile({ path, displayName: `${name} (instrumented)`, language: this.main?.language ?? 'plaintext', content: src });
    this.scheduleRender(true);
    this.onChange();
  }

  render(): void {
    this.code.render(this.decorations());
    if (this.code.setNotes) this.code.setNotes([...this.notes.values()].filter((n) => n.file === this.code.shownPath()));
    else if (this.narration && this.narration.path === this.code.shownPath()) this.code.setNarration({ text: this.narration.text, line: this.narration.line });
    else this.code.setNarration(null);
  }

  readonly notes = new Map<string, TeachingNote>();
  async peekValue(name: string): Promise<unknown> {
    if (!this.code.peekValue) throw new Error('the code view does not support value peeks');
    if (name && !this.debug.paused) throw new Error('peek needs a live pause');
    const pause = this.debug.paused;
    const frameIndex = this.debug.selectedFrame;
    const frame = pause?.stack[frameIndex];
    if (name && pause) {
      const fileId = frame?.fileId ?? pause.fileId;
      const path = fileId === null ? undefined : this.debug.pathOf(fileId);
      const line = frame?.line ?? pause.line;
      if (!path || line === null) throw new Error('The selected frame has no source location');
      this.revealPath(path, line);
      await this.code.presentationReady?.();
      const content = path === this.main?.path ? this.debug.run?.content : path ? this.sources.get(path) : undefined;
      if (path && content !== undefined) {
        this.identities(path, content);
        await this.identityRequests.get(JSON.stringify([path, content]));
      }
      if (this.debug.paused !== pause || this.debug.selectedFrame !== frameIndex) throw new Error('The paused frame changed while opening the value');
      this.render();
    }
    const ui = await this.code.peekValue(name);
    return { ...ui, observed: pause ? { runId: this.debug.run?.runId, step: pause.step, frame: this.debug.selectedFrame, file: this.debug.pathOf(frame?.fileId ?? pause.fileId), line: frame?.line ?? pause.line } : undefined };
  }
  private valuePresentation: { mode: 'selected' | 'all' | 'none'; names: string[]; file: string; line?: number; runId: string; frame: number } | null = null;

  async inspectValue(name: string, open: boolean): Promise<unknown> {
    const pause = this.debug.paused;
    const state = this.debug.state();
    if (!pause || !state) throw new Error('inspect needs a live pause');
    if (!state.locals.some(v => v.name === name)) throw new Error(`not in the current paused frame: ${name}`);
    if (!this.code.inspectValue) throw new Error('the code view does not support value inspection');
    const requested = this.code.inspectValue(name, open);
    await this.code.presentationReady?.();
    const ui = this.code.valueUiState?.().find(v => v.name === name) ?? requested;
    const frame = pause.stack[this.debug.selectedFrame];
    return { ...ui, observed: { runId: state.id, step: pause.step, frame: this.debug.selectedFrame, file: this.debug.pathOf(frame?.fileId ?? pause.fileId), line: frame?.line ?? pause.line } };
  }

  resolvePresentationFile(file?: string): string {
    if (!file) return this.code.shownPath() ?? this.main?.path ?? '';
    const paths = new Set([this.main?.path, ...this.run?.files.all().map((f) => f.path) ?? [], ...this.debug.run?.files.all().map((f) => f.path) ?? []].filter((p): p is string => !!p));
    if (paths.has(file)) return file;
    const matches = [...paths].filter((p) => p.endsWith('/' + file));
    if (matches.length !== 1) throw new Error(`file must name one known source file: ${file}`);
    return matches[0]!;
  }

  /** A display filter tied to the current run/frame/file. Values refresh from every new pause. */
  async presentValues(command: { mode: 'selected' | 'all' | 'none'; names?: string[]; file?: string; line?: number }): Promise<unknown> {
    const p = this.debug.paused;
    const state = this.debug.state();
    if (!p || !state) throw new Error('values needs a live pause');
    const f = p.stack[this.debug.selectedFrame];
    const path = this.debug.pathOf(f?.fileId ?? p.fileId);
    if (!path) throw new Error('the selected frame has no source file');
    const file = command.file ? this.resolvePresentationFile(command.file) : path;
    if (file !== path) throw new Error('values must target the selected frame’s file');
    if (!['selected', 'all', 'none'].includes(command.mode)) throw new Error('values mode must be selected, all or none');
    const names = [...new Set(command.names ?? [])];
    if (command.mode === 'selected' && (!names.length || names.some((n) => typeof n !== 'string'))) throw new Error('selected values needs binding names');
    if (command.line !== undefined && (!Number.isInteger(command.line) || command.line < 1)) throw new Error('line must be a positive integer');
    if (command.line !== undefined) this.validatePresentationLine(file, command.line);
    const missing = names.filter((name) => !state.locals.some((v) => v.name === name));
    if (missing.length) throw new Error(`not in the current paused frame: ${missing.join(', ')}`);
    this.valuePresentation = { mode: command.mode, names, file, ...(command.line !== undefined ? { line: command.line } : {}), runId: state.id, frame: this.debug.selectedFrame };
    this.render();
    this.onChange();
    await this.code.presentationReady?.();
    return { observed: { runId: state.id, step: p.step, frame: this.debug.selectedFrame, file, line: f?.line ?? p.line },
      shown: state.locals.filter((v) => command.mode === 'all' || (command.mode === 'selected' && names.includes(v.name))).map((v) => ({ name: v.name, text: v.text })), rendered: this.code.valueUiState?.() ?? null };
  }

  private validatePresentationLine(file: string, line: number): void {
    const source = file === this.main?.path ? this.debug.active ? this.debug.run?.content : this.main.content : this.sources.get(file);
    const max = source !== undefined ? source.split(/\r?\n/).length : (this.debug.run?.files.byPath(file) ?? this.run?.files.byPath(file))?.ranges[0]?.[2];
    if (max !== undefined && line > max) throw new Error(`line ${line} is outside ${file}`);
  }

  /** Show an explanation bubble under `line` of the shown file (null clears it). */
  say(text: string | null, line?: number, opts: { file?: string; noteId?: string; kind?: 'explanation' | 'prediction' } = {}): void {
    if (text === null) {
      if (opts.noteId) this.notes.delete(opts.noteId);
      else this.notes.clear();
      const last = [...this.notes.values()].at(-1);
      this.narration = last ? { text: last.text, line: last.line, path: last.file } : null;
    }
    else {
      const p = this.debug.paused;
      const f = p?.stack[this.debug.selectedFrame];
      const path = this.resolvePresentationFile(opts.file);
      const at = line ?? (p && this.debug.pathOf(f?.fileId ?? p.fileId) === path ? f?.line ?? p.line : undefined) ?? this.state().location?.line ?? 1;
      if (!Number.isInteger(at) || at < 1) throw new Error('line must be a positive integer');
      this.validatePresentationLine(path, at);
      if (opts.kind && !['explanation', 'prediction'].includes(opts.kind)) throw new Error('note kind must be explanation or prediction');
      this.notes.set(opts.noteId ?? 'main', { noteId: opts.noteId ?? 'main', file: path, line: at, text, kind: opts.kind ?? 'explanation' });
      this.narration = { text, line: at, path };
    }
    this.render();
    this.onChange();
  }

  /* ---------- what an agent reads ---------- */

  /** Variables of the current scope as of the step: the latest recorded change of each name. */
  localsAt(step: number): { name: string; text: string }[] {
    const run = this.run;
    const trace = run?.trace;
    if (!run || !trace || !trace.valid(step)) return [];
    const scopeId = trace.scopeId(step);
    const latest = new Map<string, string>();
    for (const l of run.locals) {
      if (l.step > step || l.scopeId !== scopeId) continue;
      for (const c of l.changes) latest.set(c.name, c.text);
    }
    return [...latest].map(([name, text]) => ({ name, text }));
  }

  state(): PageState {
    const run = this.run;
    const trace = run?.trace ?? null;
    const step = this.nav.active ? this.nav.step : null;
    let location: PageState['location'] = null;
    let code: string | null = null;
    let stack: PageState['stack'] = [];
    if (trace && step !== null && trace.valid(step)) {
      const loc = trace.location(step);
      const frames = trace.callStack(step);
      if (loc) {
        location = { file: this.displayPath(loc.fileId), line: loc.range[0], function: frames[0]?.function ?? '<module>' };
        code = (this.sourceOf(loc.fileId) ?? '').split(/\r?\n/)[loc.range[0] - 1] ?? null;
      }
      stack = frames.map((f) => ({ function: f.function, line: f.line, step: f.step }));
    }
    return {
      runId: run?.runId ?? null,
      running: !!this.incoming || !!run?.running,
      file: this.main?.path ?? '',
      steps: trace?.count ?? 0,
      timeMachine: this.nav.active,
      step,
      location,
      code,
      locals: step === null ? [] : this.localsAt(step),
      stack,
      values: this.visibleLogs().slice(-200).map((e) => ({ line: e.liveLine ?? run?.files.locate(e.rid)?.range[0] ?? 0, ...(e.context ? { context: e.context } : {}), text: e.text, step: e.step })),
      output: (run?.output ?? '').slice(-4000),
      errors: (run?.errors ?? []).filter((e) => !e.handled).map((e) => ({ type: e.errorType, message: e.message, line: run?.files.locate(e.rid)?.range[0] ?? 0 })),
      narration: this.narration ? { text: this.narration.text, line: this.narration.line } : null,
      notes: [...this.notes.values()],
      valuePresentation: this.valuePresentation ? { mode: this.valuePresentation.mode, names: this.valuePresentation.names, file: this.valuePresentation.file, ...(this.valuePresentation.line !== undefined ? { line: this.valuePresentation.line } : {}) } : null,
      live: this.debug.active ? { runId: this.debug.run!.runId, step: this.debug.paused?.step ?? null, frame: this.debug.selectedFrame,
        file: this.debug.pathOf(this.debug.paused?.stack[this.debug.selectedFrame]?.fileId ?? this.debug.paused?.fileId) ?? null,
        line: this.debug.paused?.stack[this.debug.selectedFrame]?.line ?? this.debug.paused?.line ?? null,
        locals: this.debug.state()?.locals.map((v) => ({ name: v.name, text: v.text })) ?? [] } : null,
    };
  }
}

const LANGUAGE_BY_EXT: Record<string, string> = { py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript', json: 'json', jsonl: 'json' };

/** The Monaco language of a file the page opens: by extension, else the main file's. */
function languageOf(path: string, fallback = 'plaintext'): string {
  return LANGUAGE_BY_EXT[path.split('.').pop()?.toLowerCase() ?? ''] ?? fallback;
}

/** Coverage states ranked so the worst one on a line wins. */
function rank(state: number): number {
  return state === 3 ? 4 : state === 4 ? 3 : state === 2 ? 2 : state === 1 ? 1 : 0;
}

/** `Python 3.13.1`, `Node 22.22.0`: the JS runtime mirrors its Node version into `pythonVersion` for the extension, so its own fields win. */
export function runtimeLabelText(ready: RuntimeInfo['ready']): string {
  if (!ready) return 'starting…';
  if (ready.language === 'javascript' && ready.nodeVersion) return `Node ${ready.nodeVersion}`;
  if (ready.pythonVersion) return `Python ${ready.pythonVersion.split(' ')[0]}`;
  return ready.runtimeVersion ?? '';
}
