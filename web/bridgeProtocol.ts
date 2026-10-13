/**
 * Messages between the browser bridge (web/server.ts) and the browser page (web/main.tsx) over the
 * WebSocket at `/ws`. The bridge relays the runtime's NDJSON protocol (docs/PROTOCOL.md) verbatim:
 * run events arrive as `event`, host requests go out as `request` and come back as `reply`. Nothing
 * here knows which language the runtime speaks, so the same page serves the Python runtime and the
 * JS/TS one. See docs/WEB.md.
 */
import type { DebugBreakpointSpec, DebugExceptionMode, HostRequest, RunConfig, RunEvent, RunnerMessage, WatchRequest } from '../src/shared/protocol';
import type { TourDoc } from '../src/session/tourTypes';
import type { ScratchCommand } from './scratchpadProtocol';
import type { ProfileSummary } from './profileSummary';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type RequestBody = DistributiveOmit<HostRequest, 'id'>;

/** The run settings a page may change; everything else stays the extension's defaults. */
export type ConfigPatch = Partial<Pick<RunConfig, 'autoLog' | 'libraryCode' | 'timeoutMs' | 'recordLocals' | 'http'>> & { maskSecrets?: boolean; only?: string[] };

export interface BridgeFile {
  /** absolute path on the machine the bridge runs on */
  path: string;
  displayName: string;
  /** Monaco language id: `python`, `javascript`, `typescript` */
  language: string;
  content: string;
}

export interface RuntimeInfo {
  /** what the bridge spawned, for the header: `node node/bin/tracelight.mjs serve` */
  command: string;
  /** the `ready` reply's fields; null until the handshake completed */
  ready: { pythonVersion?: string; executable?: string; platform?: string; capabilities: string[]; runtimeVersion?: string; language?: string; nodeVersion?: string } | null;
}

/** An instruction from an agent (the HTTP API, the `ctl` CLI or WebMCP), carried out by the page. */
export interface AgentExpectation {
  source?: 'live' | 'recording'; runId?: string; step?: number | null; frame?: number; file?: string | null;
}

export type AgentCommand = ({ expect?: AgentExpectation } & (
  | ({ action: 'scratchpad' } & ScratchCommand)
  | { action: 'waitPause'; after?: number; timeoutMs?: number }
  | { action: 'state' }
  | { action: 'position'; mode?: 'live' | 'recorded' | 'visible'; focus?: boolean }
  | { action: 'goto'; step: number; say?: string }
  | { action: 'step'; kind: 'next' | 'into' | 'over' | 'out' | 'back' | 'backOver' | 'backOut'; say?: string }
  | { action: 'line'; line: number; file?: string; say?: string }
  | { action: 'say'; text: string; line?: number; step?: number; file?: string; noteId?: string; kind?: 'explanation' | 'prediction' }
  | { action: 'clear'; noteId?: string }
  /** Select existing bindings for display only; no expressions are evaluated. */
  | { action: 'values'; mode: 'selected' | 'all' | 'none'; names?: string[]; file?: string; line?: number }
  | { action: 'inspect'; name: string; names?: string[]; open: boolean }
  | { action: 'peek'; name: string }
  | { action: 'start' }
  | { action: 'stop' }
  | { action: 'run' }
  | { action: 'eval'; expression: string }
  /** every recorded change of a variable (the Variable History view) */
  | { action: 'var'; name: string }
  /** why `name` had its value after `step` (empty name: the statement), the Details pane's tree */
  | { action: 'why'; step?: number; name: string }
  /** add a Time Machine watch (`remove` drops the one with this text) */
  | { action: 'watch'; exp: string; remove?: boolean }
  /** the live debugger: start one recorded execution, move it, or stop it */
  | { action: 'debug'; op: 'start' | 'restart' | 'continue' | 'step' | 'pause' | 'stop' | 'state'; kind?: 'into' | 'over' | 'out'; say?: string }
  /** set or clear a breakpoint of the main file (toggles without `on`) */
  | { action: 'breakpoint'; line: number; file?: string; on?: boolean; condition?: string }
  /** open the Code Story of the last run (starting the Time Machine), and read it back */
  | { action: 'story' }
  /** run once under the runtime's profiler and read the hottest functions */
  | { action: 'profile' }));

/** The TOUR section's state for a run, as the bridge computed it with `tracelight tour`. */
export interface BridgeTour {
  runId: string;
  status: 'computing' | 'ready' | 'error';
  doc?: TourDoc;
  error?: string;
  narrating: boolean;
  narrationError?: string;
}

/** Profile's answer: the hottest functions of one profiled run (web/profileSummary.ts), or why there are none. */
export interface BridgeProfile {
  /** the `.cpuprofile` the runtime wrote, served at `/api/profile` */
  path?: string;
  summary?: ProfileSummary;
  error?: string;
}

/** A file the bridge ran as its main file, newest first (View Recent Files). */
export interface RecentFile {
  path: string;
  displayName: string;
  /** ms since the epoch */
  at: number;
}

/** Narrate's state for a run: the glosses once one model call answered. */
export interface BridgeNarration {
  runId: string;
  narrating: boolean;
  glosses?: Record<string, string>;
  error?: string;
}

export type BridgeToPage =
  | { type: 'hello'; file: BridgeFile; runtime: RuntimeInfo; watch: boolean; /** a narration backend exists (claude, codex, TRACELIGHT_EXPLAIN_COMMAND) */ canNarrate: boolean }
  /** the file changed on disk (or `file.read` asked for another one) */
  | { type: 'file'; file: BridgeFile }
  | { type: 'event'; event: RunEvent }
  | { type: 'reply'; id: number; reply: RunnerMessage }
  | { type: 'runner.error'; message: string; detail?: string }
  | { type: 'runtime'; runtime: RuntimeInfo }
  | { type: 'agent'; id: number; command: AgentCommand }
  /** a run the bridge started and the content it ran, sent before the runtime's first event */
  | { type: 'run.begin'; runId: string; content: string; reason: string }
  | { type: 'saved'; path: string }
  | { type: 'narration'; narration: BridgeNarration }
  | { type: 'tour'; tour: BridgeTour }
  /** the live debugger's run (a runtime of its own): begun, each of its events, and gone */
  | { type: 'debug.begin'; runId: string; content: string; recording?: boolean }
  | { type: 'debug.event'; event: RunEvent }
  | { type: 'debug.end'; runId: string; message?: string }
  | { type: 'profile'; profile: BridgeProfile }
  | { type: 'recent'; files: RecentFile[] };

export type PageToBridge =
  /** run the file; `watch` and `traceContext` stay for later runs (a save, a settings change) until the next `run` */
  | { type: 'run'; content?: string; watch?: WatchRequest[]; traceContext?: { step: number; prefetch: number } | null }
  /** change the run config for this and every later run (the panel's Settings view), then re-run */
  | { type: 'config'; patch: ConfigPatch }
  | { type: 'stop' }
  | { type: 'request'; id: number; body: RequestBody }
  | { type: 'save'; content: string }
  | { type: 'file.read'; path: string }
  /** what the page shows now, for `GET /api/state` */
  | { type: 'state'; state: PageState }
  | { type: 'agent.result'; id: number; result: unknown; error?: string }
  /** one model call that glosses the last run's walkthrough */
  | { type: 'narrate' }
  /** the tour of the last run (`tracelight tour`), or Narrate Tour */
  | { type: 'tour'; action: 'compute' | 'narrate' }
  | { type: 'debug.start'; breakpoints: DebugBreakpointSpec[]; exceptions: DebugExceptionMode; content?: string; stopOnEntry?: boolean }
  /** a host request for the debugger's run (`debug`, `evaluate`, `expand`, `complete`), answered with `reply` */
  | { type: 'debug.request'; id: number; body: RequestBody }
  | { type: 'debug.stop' }
  /** run once in the runtime's profile mode (the buffer when `content` is given); answered with `profile` */
  | { type: 'profile'; content?: string }
  /** when a change on disk re-runs the file: `auto` and `onSave` do, `onDemand` waits for Run */
  | { type: 'runMode'; mode: 'auto' | 'onSave' | 'onDemand' }
  /** the files this bridge ran, answered with `recent` */
  | { type: 'recent' }
  /** make another file of the workspace the main one (a recent file), and run it */
  | { type: 'open'; path: string };

/** The page's position as an agent reads it back (`GET /api/state`, `ctl state`, WebMCP `tracelight_state`). */
export interface PageState {
  /** Confirmed after rendering; recording selection never implies a visible source position. */
  position?: ConfirmedPosition;
  context: { source: 'live' | 'recording'; runId: string | null; running: boolean; paused: boolean; step: number | null; frame: number; file: string | null; line: number | null; localsReady: boolean; locals: { name: string; text: string }[] };
  shownFile: string | null;
  runId: string | null;
  running: boolean;
  file: string;
  /** steps recorded in the last run; 0 before a trace arrived */
  steps: number;
  /** the Time Machine is on and `step` is its position */
  timeMachine: boolean;
  step: number | null;
  location: { file: string; line: number; function: string } | null;
  /** the source line at `location` */
  code: string | null;
  /** recorded variable changes at `step` (record locals is on in the browser) */
  locals: { name: string; text: string }[];
  /** the call stack at `step`, innermost first */
  stack: { function: string; line: number; step: number }[];
  /** values logged so far (up to `step` while the Time Machine is on) */
  values: { line: number; context?: string; text: string; step: number }[];
  output: string;
  errors: { type: string; message: string; line: number }[];
  /** the narration bubble now showing */
  narration: { text: string; line: number } | null;
  notes?: TeachingNote[];
  noteRendering?: { noteId: string; file: string; line: number; rendered: boolean; visible: boolean }[] | null;
  valuePresentation?: { mode: 'selected' | 'all' | 'none'; names: string[]; file: string; line?: number } | null;
  /** Live execution is separate from the recording fields above. */
  live?: { runId: string; step: number | null; frame: number; file: string | null; line: number | null; locals: { name: string; text: string }[] } | null;
}

export interface RenderedSource {
  file: string | null;
  pane: 'source' | 'story';
  line: number | null;
  code: string | null;
  highlight: 'live' | 'recorded' | null;
  visible: boolean;
  lineVisible: boolean;
  /** Used inside the page to detect edited or mismatched source, omitted from agent replies. */
  content?: string;
}

export interface PositionAnchor {
  runId: string;
  step: number;
  frame: number;
  file: string;
  line: number;
  function: string;
  code: string | null;
}

export interface ConfirmedPosition {
  mode: 'live' | 'recorded' | 'visible';
  ready: boolean;
  blockers: string[];
  activePane: 'source' | 'story';
  source: Omit<RenderedSource, 'content'> | null;
  story: Omit<RenderedSource, 'content'> | null;
  recorded: PositionAnchor | null;
  live: PositionAnchor | null;
  sourceMatches: boolean;
  recordedDiffersFromLive: boolean;
}

export interface TeachingNote {
  /** Execution context at creation, distinct from the author's prediction/explanation. */
  observed?: AgentExpectation;
  noteId: string;
  file: string;
  line: number;
  text: string;
  kind: 'explanation' | 'prediction';
}
