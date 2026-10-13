/**
 * The browser page's code pane: Monaco showing the running file (editable; Ctrl/Cmd+S saves to
 * disk) or a file the Time Machine stepped into (read-only), with what VS Code's editor shows:
 * values after their lines, coverage in the gutter, the Time Machine's line and its callers, the
 * exception, and an agent's narration under a line.
 */
import { monaco, READONLY_OPTIONS } from '../webview/monaco';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution';
import 'monaco-editor/esm/vs/editor/contrib/hover/browser/hoverContribution';
import 'monaco-editor/esm/vs/language/typescript/monaco.contribution';
import 'monaco-editor/esm/vs/editor/contrib/gotoSymbol/browser/goToCommands';
import 'monaco-editor/esm/vs/editor/contrib/gotoSymbol/browser/peek/referencesController';
import 'monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController';
import 'monaco-editor/esm/vs/editor/contrib/parameterHints/browser/parameterHints';
import { configureLanguageService, registerLanguageSource, staticHover } from './languageService';
import type { BridgeFile, TeachingNote } from './bridgeProtocol';
import { PROFILE_PATH, type CodeDecorations, type CodeView } from './pageHost';
import { STORY_PATH } from './story';
import { pausedOccurrences, pausedInline, pausedShadows, pausedHover, pausedProperty, type ValueOccurrence } from './pausedValues';
import type { ValueNode } from '../src/shared/protocol';

const INLINE_MAX = 160;

export class CodePane implements CodeView {
  private readonly editor: monaco.editor.IStandaloneCodeEditor;
  private readonly models = new Map<string, monaco.editor.ITextModel>();
  /** the content each model last had on disk (or from the bridge), to tell an edit from a reload */
  private readonly loaded = new Map<string, string>();
  private mainPath: string | undefined;
  private shown: string | undefined;
  private decorations: monaco.editor.IEditorDecorationsCollection;
  private zone: { id: string; line: number; text: string } | null = null;
  private extraZones: string[] = [];
  private notesKey = '';
  private lastNotes: TeachingNote[] = [];
  private valueOccurrences: ValueOccurrence[] = [];
  private valuesModel: monaco.editor.ITextModel | null = null;
  private valuesContent: string | undefined;
  private pendingNavigation: { path: string; line: number; column: number } | undefined;
  private hoverSnapshot: string | undefined;

  async presentationReady(): Promise<void> {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }

  valueUiState(): { name: string; open: boolean; visible: boolean }[] { return []; }

  inspectValue(_name: string, _open: boolean): { name: string; open: boolean; visible: boolean } {
    throw new Error('Clickable source values are disabled. Hover a binding or open Variables and call stack.');
  }
  onExpandValue: (node: ValueNode) => Promise<ValueNode | null> = async () => null;
  private applying = false;
  private lastRender: CodeDecorations | undefined;
  /** a click in the glyph margin or on a line number: toggle the live debugger's breakpoint there */
  onNavigate: (path: string, line: number) => void = () => {};
  onGutterClick: (path: string, line: number) => void = () => {};
  /** a made-up document's row (the Code Story, the profile): text selected on it, or Ctrl/Cmd+click */
  onLinePick: (path: string, line: number, how: 'select' | 'open') => void = () => {};

  constructor(
    host: HTMLElement,
    private readonly onEdit: (content: string) => void,
    private readonly onSave: (content: string) => void,
  ) {
    configureLanguageService();
    this.editor = monaco.editor.create(host, {
      ...READONLY_OPTIONS,
      readOnly: false,
      domReadOnly: false,
      lineNumbers: 'on',
      lineNumbersMinChars: 4,
      glyphMargin: true,
      lineDecorationsWidth: 6,
      renderLineHighlight: 'line',
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: false },
      scrollBeyondLastLine: true,
      quickSuggestions: { other: true, comments: false, strings: false },
      parameterHints: { enabled: true },
      matchBrackets: 'always',
      occurrencesHighlight: 'singleFile',
      hover: { enabled: true, delay: 250, above: true, sticky: true },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    });
    this.decorations = this.editor.createDecorationsCollection();
    // A provider also answers over a property token, without evaluating the expression.
    const providers = ['javascript', 'typescript'].map(language => monaco.languages.registerHoverProvider(language, {
      provideHover: async (model, position, token) => {
        if (model !== this.editor.getModel()) return null;
        const version = model.getVersionId();
        const snapshot = this.hoverSnapshot;
        const hit = this.valueAt(model, position);
        const contents: monaco.IMarkdownString[] = [];
        let range: monaco.IRange | undefined;
        if (hit) {
          const { occurrence: o, property } = hit;
          const value = property ? pausedProperty(o.local, hit.path) : o.local;
          range = new monaco.Range(o.line, o.start + 1, o.line, hit.end + 1);
          contents.push({ value: value ? pausedHover(value) : `Paused frame · ${[o.local.name, ...hit.path].join('.')}\n\nProperty unavailable in this snapshot. No expression was evaluated.`, isTrusted: false });
        }
        const info = await staticHover(model, position);
        if (token.isCancellationRequested || model.isDisposed() || model !== this.editor.getModel() || version !== model.getVersionId() || snapshot !== this.hoverSnapshot) return null;
        if (info) { contents.push(...info.contents); range ??= info.range; }
        return contents.length ? { range, contents } : null;
      },
    }));
    const opener = monaco.editor.registerEditorOpener({ openCodeEditor: (_source, resource, selection) => {
      if (resource.scheme !== 'file') return false;
      const line = selection ? 'startLineNumber' in selection ? selection.startLineNumber : selection.lineNumber : 1;
      const column = selection ? 'startColumn' in selection ? selection.startColumn : selection.column : 1;
      this.pendingNavigation = { path: resource.fsPath, line, column };
      this.onNavigate(resource.fsPath, line);
      this.applyNavigation();
      return true;
    } });
    this.editor.onDidDispose(() => { providers.forEach(p => p.dispose()); opener.dispose(); this.clearZone(); });
    this.editor.onDidLayoutChange(() => { if (this.lastRender) this.render(this.lastRender); });
    this.editor.onDidChangeModelContent(() => {
      this.decorations.clear();
      this.hideValueHover();
      const model = this.editor.getModel();
      if (model?.uri.scheme === 'file') registerLanguageSource(model.uri.fsPath, model.getValue());
      if (this.applying || this.shown !== this.mainPath) return;
      this.onEdit(this.editor.getValue());
    });
    this.editor.onDidChangeCursorSelection((e) => {
      const sel = e.selection;
      // T3: placing the cursor does nothing; selected text on one row picks it
      if (!this.shown || !isVirtual(this.shown) || this.applying || e.source === 'api' || sel.isEmpty() || sel.startLineNumber !== sel.endLineNumber) return;
      this.onLinePick(this.shown, sel.startLineNumber, 'select');
    });
    this.editor.onMouseDown((e) => {
      const t = e.target.type;
      const line = e.target.position?.lineNumber;
      if (!line || !this.shown) return;
      if (isVirtual(this.shown)) {
        if (t === monaco.editor.MouseTargetType.CONTENT_TEXT && (e.event.ctrlKey || e.event.metaKey)) this.onLinePick(this.shown, line, 'open');
        else if (t === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || t === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS) this.onLinePick(this.shown, line, 'select');
        return;
      }
      if (t === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || t === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) this.onGutterClick(this.shown, line);
    });
    this.editor.addCommand(monaco.KeyCode.F9, () => {
      const line = this.cursorLine();
      if (line && this.shown) this.onGutterClick(this.shown, line);
    });
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (this.shown !== this.mainPath) return;
      const content = this.editor.getValue();
      if (this.mainPath) this.loaded.set(this.mainPath, content);
      this.onSave(content);
    });
  }

  /** the main file has edits the disk does not */
  get dirty(): boolean {
    const m = this.mainPath ? this.models.get(this.mainPath) : undefined;
    return !!m && m.getValue() !== this.loaded.get(this.mainPath!);
  }

  /** the main file's edited text when it differs from the disk, else undefined (runs read the disk) */
  dirtyContent(): string | undefined {
    return this.dirty ? this.mainContent() : undefined;
  }

  /** the main file's text as edited, saved or not */
  mainContent(): string | undefined {
    return this.mainPath ? this.models.get(this.mainPath)?.getValue() : undefined;
  }

  /** Another file is the main one now (Open Recent): it is the editable one from here on. */
  setMain(file: BridgeFile): void {
    this.mainPath = file.path;
    this.showFile(file);
  }

  cacheFile(file: BridgeFile): void {
    const current = this.models.get(file.path);
    registerLanguageSource(file.path, file.path === this.mainPath && this.dirty ? current!.getValue() : file.content);
  }

  showFile(file: BridgeFile, opts: { keepDirty?: boolean } = {}): void {
    if (!this.mainPath) this.mainPath = file.path;
    let model = this.models.get(file.path);
    if (!model) {
      model = monaco.editor.createModel(file.content, file.language, monaco.Uri.file(file.path));
      this.models.set(file.path, model);
      this.loaded.set(file.path, file.content);
    } else if (model.getValue() !== file.content && !(opts.keepDirty && file.path === this.mainPath && this.dirty)) {
      // a change on disk: replace the text, keeping the cursor where it was
      this.applying = true;
      const pos = this.editor.getModel() === model ? this.editor.getPosition() : null;
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: file.content }], () => null);
      if (pos) this.editor.setPosition(pos);
      this.applying = false;
      this.loaded.set(file.path, file.content);
    }
    if (this.editor.getModel() !== model) {
      this.clearZone();
      this.editor.setModel(model);
    }
    registerLanguageSource(file.path, model.getValue());
    this.shown = file.path;
    this.shownDisplay = file.displayName;
    this.applyNavigation();
    // the story and the profile carry their own line numbers
    this.editor.updateOptions({ readOnly: file.path !== this.mainPath, domReadOnly: file.path !== this.mainPath, lineNumbers: file.path === STORY_PATH || file.path === PROFILE_PATH ? 'off' : 'on' });
  }

  private applyNavigation(): void {
    const target = this.pendingNavigation;
    if (!target || this.editor.getModel()?.uri.fsPath !== target.path) return;
    this.pendingNavigation = undefined;
    this.editor.setPosition({ lineNumber: target.line, column: target.column });
    this.editor.revealLineInCenterIfOutsideViewport(target.line);
    this.editor.focus();
  }

  shownPath(): string | undefined {
    return this.shown;
  }

  private shownDisplay: string | undefined;
  /** the shown file's name for the header: `Code Story`, `demo.py (instrumented)` */
  shownName(): string | undefined {
    return this.shownDisplay;
  }

  isMainShown(): boolean {
    return this.shown === this.mainPath;
  }

  cursorLine(): number | undefined {
    return this.editor.getPosition()?.lineNumber;
  }

  reveal(line: number): void {
    if (line > 0) this.editor.revealLineInCenterIfOutsideViewport(line, monaco.editor.ScrollType.Smooth);
  }

  render(d: CodeDecorations): void {
    if (this.hoverSnapshot !== d.liveValues?.snapshot) { this.hideValueHover(); }
    this.hoverSnapshot = d.liveValues?.snapshot;
    this.lastRender = d;
    this.valueOccurrences = [];
    this.valuesModel = null;
    const model = this.editor.getModel();
    if (!model) return;
    const lines = model.getLineCount();
    const out: monaco.editor.IModelDeltaDecoration[] = [];
    // the whole line, not its empty end: Monaco drops the injected text of an empty range there
    const endOf = (line: number) => new monaco.Range(line, 1, line, model.getLineMaxColumn(line));
    for (const [line, state] of d.coverage) {
      if (line < 1 || line > lines) continue;
      out.push({ range: new monaco.Range(line, 1, line, 1), options: { linesDecorationsClassName: `pkw-cov pkw-cov-${state}` } });
    }
    for (const line of d.callers) {
      if (line < 1 || line > lines) continue;
      out.push({ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: 'pkw-caller-line', glyphMarginClassName: 'codicon codicon-debug-stackframe-dot pkw-caller-glyph' } });
    }
    for (const [line, bp] of d.breakpoints) {
      if (line < 1 || line > lines) continue;
      out.push({ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: `codicon ${bp.condition ? 'codicon-debug-breakpoint-conditional' : 'codicon-debug-breakpoint'} pkw-breakpoint-glyph`, glyphMarginHoverMessage: { value: bp.condition ? `Breakpoint if \`${bp.condition}\`` : 'Breakpoint (click to remove)' } } });
    }
    if (d.paused !== null && d.paused >= 1 && d.paused <= lines) {
      const line = d.paused;
      out.push({ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: 'pkw-paused-line', glyphMarginClassName: 'codicon codicon-debug-stackframe pkw-paused-glyph', overviewRuler: { color: '#ffcc00', position: monaco.editor.OverviewRulerLane.Full } } });
    }
    for (const r of d.dim ?? []) {
      if (r.line < 1 || r.line > lines) continue;
      out.push({ range: new monaco.Range(r.line, r.start + 1, r.line, r.end + 1), options: { inlineClassName: 'pkw-dim' } });
    }
    if (d.box && d.box.line >= 1 && d.box.line <= lines) {
      out.push({ range: new monaco.Range(d.box.line, d.box.start + 1, d.box.line, d.box.end + 1), options: { className: 'pkw-story-box' } });
    }
    if (d.current && d.current.line >= 1 && d.current.line <= lines) {
      const line = d.current.line;
      out.push({ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: 'pkw-current-line', glyphMarginClassName: 'codicon codicon-debug-stackframe pkw-current-glyph', overviewRuler: { color: '#ffcc00', position: monaco.editor.OverviewRulerLane.Full } } });
    }
    for (const [line, text] of d.inline) {
      if (line < 1 || line > lines || d.errors.has(line)) continue;
      out.push({ range: endOf(line), options: { after: { content: `  ${clip(text)}`, inlineClassName: 'pkw-inline-value' }, hoverMessage: { value: '```\n' + text + '\n```' } } });
    }
    if (d.liveValues && model.getValue() === (d.liveValues.content ?? this.loaded.get(this.shown!))) {
      const occurrences = pausedOccurrences(model.getLinesContent(), monaco.editor.tokenize(model.getValue(), model.getLanguageId()), d.liveValues);
      this.valueOccurrences = occurrences;
      this.valuesModel = model;
      this.valuesContent = model.getValue();
      const ghosts = d.liveValues.ghostNames === undefined ? occurrences : d.liveValues.locals.filter((v) => d.liveValues!.ghostNames!.includes(v.name)).map((local) => ({ line: d.liveValues!.line, start: 0, end: 0, local }));
      const shadows = document.body.dataset.presentation === 'learn' ? pausedShadows(model.getLinesContent(), occurrences, d.liveValues) : pausedInline(ghosts, d.liveValues.line, d.liveValues.anchor);
      for (const [line, text] of shadows) {
        if (line < 1 || line > lines) continue;
        const font = this.editor.getOption(monaco.editor.EditorOption.fontInfo);
        const available = Math.floor(this.editor.getLayoutInfo().contentWidth / font.typicalHalfwidthCharacterWidth) - model.getLineLength(line) - 4;
        // Do not create horizontal scrolling just to show a value; hover keeps the complete preview.
        const parts: string[] = [];
        for (const part of text.split(' · ')) {
          if ([...parts, part].join(' · ').length <= available) parts.push(part);
        }
        const preview = parts.length ? parts.join(' · ') : available >= 12 ? text.slice(0, available - 1) + '…' : '';
        if (preview) out.push({ range: endOf(line), options: { after: { content: `  ${preview}`, inlineClassName: 'pkw-live-value', cursorStops: monaco.editor.InjectedTextCursorStops.None } } });
      }
    }
    for (const [line, text] of d.errors) {
      if (line < 1 || line > lines) continue;
      out.push({ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: 'pkw-error-line' } });
      out.push({ range: endOf(line), options: { after: { content: `  ${clip(text)}`, inlineClassName: 'pkw-inline-error' } } });
    }
    this.decorations.set(out);
    this.setNotes(this.lastNotes);
  }

  setNarration(n: { text: string; line: number } | null): void {
    this.setNotes(n ? [{ noteId: 'main', file: this.shown ?? '', text: n.text, line: n.line, kind: 'explanation' }] : []);
  }

  setNotes(notes: TeachingNote[]): void {
    this.lastNotes = notes;
    const key = JSON.stringify([notes, this.editor.getLayoutInfo().contentWidth]);
    if (this.notesKey === key) return;
    this.clearZone();
    this.notesKey = key;
    const model = this.editor.getModel();
    if (!model) return;
    for (const n of notes) {
    if (n.line < 1 || n.line > model.getLineCount()) continue;
    const line = n.line;
    // Monaco positions and shows/hides the zone's own node, so the bubble is a child of it
    const node = document.createElement('div');
    const bubble = document.createElement('div');
    bubble.className = 'pkw-narration';
    node.appendChild(bubble);
    const icon = document.createElement('i');
    icon.className = 'codicon codicon-comment-discussion';
    const text = document.createElement('div');
    text.className = 'pkw-narration-text';
    const label = document.createElement('span');
    label.className = 'pkw-note-label';
    label.textContent = n.kind === 'prediction' ? 'Predicción' : 'Nota';
    text.append(label, document.createTextNode(n.text));
    bubble.append(icon, text);
    // estimate the height from the text: about 90 characters a row at the pane's usual width
    const rows = n.text.split('\n').reduce((sum, l) => sum + Math.max(1, Math.ceil(l.length / 90)), 0);
    this.editor.changeViewZones((acc) => {
      const height = Math.min(rows * 19 + 40, Math.max(70, this.editor.getLayoutInfo().height * .35));
      bubble.style.maxHeight = `${height - 8}px`;
      bubble.style.overflow = 'auto';
      const id = acc.addZone({ afterLineNumber: line, heightInPx: height, domNode: node });
      if (!this.zone) this.zone = { id, line, text: n.text };
      else this.extraZones.push(id);
    });
    }
    const active = this.lastRender?.paused ?? this.lastRender?.current?.line;
    if (active) this.reveal(active);
  }

  private clearZone(): void {
    const zone = this.zone;
    this.notesKey = '';
    const ids = [...(zone ? [zone.id] : []), ...this.extraZones];
    this.zone = null;
    this.extraZones = [];
    if (ids.length) this.editor.changeViewZones((acc) => ids.forEach((id) => acc.removeZone(id)));
  }

  layout(): void {
    this.editor.layout();
  }

  private hideValueHover(): void {
    // Monaco 0.52 has no public hide-hover command. Cancel its scheduled hover as well
    // as the visible widget so a previous pause cannot survive a step or source edit.
    const hover = this.editor.getContribution<monaco.editor.IEditorContribution & { _cancelScheduler(): void; _hideWidgets(): void }>('editor.contrib.contentHover');
    hover?._cancelScheduler();
    hover?._hideWidgets();
  }

  private valueAt(model: monaco.editor.ITextModel, position: monaco.Position): { occurrence: ValueOccurrence; property: boolean; end: number; path: string[] } | undefined {
    if (model !== this.valuesModel || model !== this.editor.getModel() || model.getValue() !== this.valuesContent) return undefined;
    const col = position.column - 1;
    for (const o of this.valueOccurrences) {
      if (o.line !== position.lineNumber) continue;
      let end = o.end;
      const path: string[] = [];
      if (o.start <= col && col < end) return { occurrence: o, property: false, end, path };
      for (const name of o.path ?? []) {
        const part = /^\s*(?:\?\.|\.)\s*([\p{ID_Start}_$][\p{ID_Continue}$]*)/u.exec(model.getLineContent(o.line).slice(end));
        if (!part || part[1] !== name) break;
        const start = end;
        end += part[0].length;
        path.push(name);
        if (start <= col && col < end) return { occurrence: o, property: true, end, path };
      }
    }
    return undefined;
  }
}

/** the page's own read-only documents: the Code Story, the profile, the logs, an instrumented source */
function isVirtual(path: string): boolean {
  return path.startsWith('tracelight://');
}

function clip(text: string): string {
  const one = text.replace(/\s*\n\s*/g, ' ');
  return one.length > INLINE_MAX ? `${one.slice(0, INLINE_MAX - 1)}…` : one;
}
