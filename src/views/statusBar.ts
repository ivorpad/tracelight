import * as vscode from 'vscode';
import { TRACELIGHT_BUILD } from '../extension';
import type { SessionManager } from '../session/sessionManager';
import type { Session } from '../session/session';
import { formatDuration } from '../util/text';
import { debugSegment, httpSegment, httpTooltip } from './statusText';

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private bound: Session | undefined;
  private boundListener: (() => void) | undefined;

  constructor(private readonly manager: SessionManager) {
    this.item = vscode.window.createStatusBarItem('tracelight.status', vscode.StatusBarAlignment.Left, 50);
    this.item.name = 'Tracelight';
    this.item.command = 'tracelight.selectAction';
    manager.on('activeChanged', (s) => this.bind(s));
    manager.on('sessionsChanged', () => this.bind(manager.active()));
    this.bind(manager.active());
    this.item.show();
  }

  private bind(session: Session | undefined): void {
    if (this.bound && this.boundListener) {
      this.bound.off('statusChanged', this.boundListener);
      this.bound.off('runFinished', this.boundListener);
      this.bound.off('progress', this.boundListener);
      this.bound.off('settingsChanged', this.boundListener);
      this.bound.off('debugChanged', this.boundListener);
    }
    this.bound = session;
    if (session) {
      this.boundListener = () => this.render();
      session.on('statusChanged', this.boundListener);
      session.on('runFinished', this.boundListener);
      session.on('progress', this.boundListener);
      // the HTTP mode is a session setting; the segment names it as soon as it changes
      session.on('settingsChanged', this.boundListener);
      session.on('debugChanged', this.boundListener);
    }
    this.render();
  }

  private render(): void {
    this.item.command = 'tracelight.selectAction'; // the pending state below overrides it
    const s = this.bound;
    if (!s || s.isDisposed) {
      this.item.text = '$(debug-disconnect) Tracelight';
      this.item.tooltip = `Tracelight is idle. Click for actions. (build ${TRACELIGHT_BUILD})`;
      this.item.backgroundColor = undefined;
      return;
    }
    // while a run is in flight the "last run" is the previous state's
    const finished = s.state.finished ?? s.previous?.finished;
    const http = httpSegment(s.http, finished?.http, finished?.replayed);
    const httpTip = httpTooltip(s.http, finished?.http, finished?.replayed);
    const dbg = debugSegment(s.debug, s.displayName, s.running);
    switch (s.status) {
      case 'running': {
        const files = s.files.all().length;
        const icon = s.debug.paused ? '$(debug-pause)' : '$(sync~spin)';
        this.item.text = `${files > 1 ? `${icon} Tracelight · ${files} files` : `${icon} Tracelight`}${http}${dbg}`;
        this.item.tooltip = `${s.debug.paused ? `Debugging ${s.displayName}: paused` : files > 1 ? `Running ${s.displayName}… (${files} files instrumented so far)` : `Running ${s.displayName}…`}${httpTip}${dbg}`;
        this.item.backgroundColor = undefined;
        break;
      }
      case 'done':
        if (s.pendingRun) {
          this.item.command = 'tracelight.reexecute';
          this.item.text = `$(debug-rerun) Tracelight: run needed${http}`;
          this.item.tooltip = `${s.displayName}: values, watches or logpoints changed but the run mode is ${s.runMode === 'onSave' ? 'on save' : 'on demand'}. Re-execute (or save) to run.${httpTip}`;
          break;
        }
        this.item.text = `$(check-all) ${finished ? formatDuration(finished.durationMs) : 'Tracelight'}${http}`;
        this.item.tooltip = `${s.displayName}: finished in ${finished ? formatDuration(finished.durationMs) : '?'} (${s.runMode})${httpTip} · build ${TRACELIGHT_BUILD}`;
        this.item.backgroundColor = undefined;
        break;
      case 'failed':
        this.item.text = `$(warning) ${finished ? formatDuration(finished.durationMs) : 'Tracelight'}${http}`;
        this.item.tooltip = `${s.displayName}: ${s.lastError ?? s.state.errors.find((e) => !e.handled)?.message ?? 'run failed'}${httpTip}`;
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
      default:
        this.item.text = `$(debug-disconnect) Tracelight${http}`;
        this.item.tooltip = `${s.displayName}: waiting (${s.runMode})${httpTip}`;
        this.item.backgroundColor = undefined;
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
