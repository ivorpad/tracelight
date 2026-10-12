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
import type { BridgeFile, TeachingNote } from './bridgeProtocol';
import { PROFILE_PATH, type CodeDecorations, type CodeView } from './pageHost';
import { STORY_PATH } from './story';
import { pausedOccurrences, pausedInline, pausedHover } from './pausedValues';
import { ObservedBindings } from './debugPane';
import { render as renderUi } from 'preact';
import { h } from 'preact';
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
  private noteNodes = new Map<string, { note: TeachingNote; node: HTMLElement }>();
  private inspectionNode: HTMLElement | null = null;
  private expandedValues = new Set<string>();
  private inspectionSnapshot: string | undefined;
  private drawInspection: (() => void) | null = null;

  async presentationReady(): Promise<void> {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }

  noteUiState(): { noteId: string; file: string; line: number; rendered: boolean; visible: boolean }[] {
    return [...this.noteNodes.values()].map(({ note, node }) => {
      const rect = node.getBoundingClientRect();
      return { noteId: note.noteId, file: note.file, line: note.line, rendered: node.isConnected,
        visible: node.isConnected && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight };
    });
  }

  valueUiState(): { name: string; open: boolean; visible: boolean }[] {
    return [...this.inspectionNode?.querySelectorAll<HTMLButtonElement>('.pkw-observed-summary') ?? []].map(button => {
      const rect = button.getBoundingClientRect();
      return { name: button.querySelector('.pkw-debug-name')?.textContent ?? '', open: button.getAttribute('aria-expanded') === 'true', visible: rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight };
    });
  }

  inspectValue(name: string, open: boolean): { name: string; open: boolean; visible: boolean } {
    const node = this.inspectionNode;
    if (!node || !this.drawInspection) throw new Error('value row is not visible; choose Aprender and show this binding first');
    const names = this.lastRender?.liveValues?.locals.filter(v => this.lastRender?.liveValues?.ghostNames === undefined || this.lastRender.liveValues.ghostNames.includes(v.name)).map(v => v.name) ?? [];
    if (!names.includes(name)) throw new Error(`binding is not shown: ${name}`);
    if (open) this.expandedValues.add(name); else this.expandedValues.delete(name);
    this.drawInspection();
    return this.valueUiState().find(v => v.name === name)!;
  }
  onExpandValue: (node: ValueNode) => Promise<ValueNode | null> = async () => null;
  private applying = false;
  private lastRender: CodeDecorations | undefined;
  /** a click in the glyph margin or on a line number: toggle the live debugger's breakpoint there */
  onGutterClick: (path: string, line: number) => void = () => {};
  /** a made-up document's row (the Code Story, the profile): text selected on it, or Ctrl/Cmd+click */
  onLinePick: (path: string, line: number, how: 'select' | 'open') => void = () => {};

  constructor(
    host: HTMLElement,
    private readonly onEdit: (content: string) => void,
    private readonly onSave: (content: string) => void,
  ) {
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
      quickSuggestions: false,
      matchBrackets: 'always',
      occurrencesHighlight: 'singleFile',
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    });
    this.decorations = this.editor.createDecorationsCollection();
    this.editor.onDidLayoutChange(() => { if (this.lastRender) this.render(this.lastRender); });
    this.editor.onDidChangeModelContent(() => {
      this.decorations.clear();
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
    this.shown = file.path;
    this.shownDisplay = file.displayName;
    // the story and the profile carry their own line numbers
    this.editor.updateOptions({ readOnly: file.path !== this.mainPath, domReadOnly: file.path !== this.mainPath, lineNumbers: file.path === STORY_PATH || file.path === PROFILE_PATH ? 'off' : 'on' });
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
    this.lastRender = d;
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
      for (const o of occurrences) {
        out.push({ range: new monaco.Range(o.line, o.start + 1, o.line, o.end + 1), options: {
          hoverMessage: { value: pausedHover(o.local), isTrusted: false },
        } });
      }
      const ghosts = d.liveValues.ghostNames === undefined ? occurrences : d.liveValues.locals.filter((v) => d.liveValues!.ghostNames!.includes(v.name)).map((local) => ({ line: d.liveValues!.line, start: 0, end: 0, local }));
      for (const [line, text] of document.body.dataset.presentation === 'learn' ? [] : pausedInline(ghosts, d.liveValues.line, d.liveValues.anchor)) {
        if (line < 1 || line > lines) continue;
        const font = this.editor.getOption(monaco.editor.EditorOption.fontInfo);
        const available = Math.floor(this.editor.getLayoutInfo().contentWidth / font.typicalHalfwidthCharacterWidth) - model.getLineLength(line) - 4;
        // Do not create horizontal scrolling just to show a value; hover keeps the complete preview.
        const parts: string[] = [];
        for (const part of text.split(' · ')) {
          if ([...parts, part].join(' · ').length <= available) parts.push(part);
        }
        if (parts.length) out.push({ range: endOf(line), options: { after: { content: `  ${parts.join(' · ')}`, inlineClassName: 'pkw-live-value' } } });
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
    const pause = this.lastRender?.liveValues;
    const observed = document.body.dataset.presentation === 'learn' && pause && this.editor.getValue() === (pause.content ?? this.loaded.get(this.shown!)) ? pause : undefined;
    const locals = observed?.locals.filter((v) => observed.ghostNames === undefined || observed.ghostNames.includes(v.name)) ?? [];
    const key = JSON.stringify([notes, observed?.snapshot, observed?.anchor, locals, this.editor.getLayoutInfo().contentWidth]);
    if (this.notesKey === key) return;
    this.clearZone();
    this.notesKey = key;
    const model = this.editor.getModel();
    if (!model) return;
    if (observed && locals.length) {
      const line = observed.anchor ?? observed.line;
      if (line >= 1 && line <= model.getLineCount()) {
        const node = document.createElement('div');
        node.className = 'pkw-observed-zone';
        node.style.width = `${this.editor.getLayoutInfo().contentWidth}px`;
        this.inspectionNode = node;
        if (this.inspectionSnapshot !== observed.snapshot) this.expandedValues.clear();
        this.inspectionSnapshot = observed.snapshot;
        this.drawInspection = () => renderUi(h(ObservedBindings, {
          locals, expanded: this.expandedValues,
          onToggle: (name) => { this.inspectValue(name, !this.expandedValues.has(name)); },
          inspector: { expandNode: (value) => this.onExpandValue(value) },
        }), node);
        this.drawInspection();
        this.editor.changeViewZones((acc) => {
          const height = Math.max(28, (node.firstElementChild as HTMLElement)?.scrollHeight + 8 || 28);
          const zone = { afterLineNumber: line, heightInPx: height, domNode: node, suppressMouseDown: true };
          const id = acc.addZone(zone);
          // The native embedded browser also hit-tests Monaco's transparent view-lines.
          // Give the interactive zone its own explicit layer rather than relying on :has().
          if (node.parentElement) node.parentElement.style.zIndex = '30';
          node.style.zIndex = '30';
          node.addEventListener('mousedown', event => event.stopPropagation());
          node.addEventListener('pointerdown', event => event.stopPropagation());
          this.extraZones.push(id);
          // Expansion changes only the view zone, not the program or its source.
          const resize = new ResizeObserver(() => {
            if (this.inspectionNode !== node) { resize.disconnect(); return; }
            this.editor.changeViewZones((zones) => {
            zone.heightInPx = Math.min(this.editor.getLayoutInfo().height * .45, Math.max(28, (node.firstElementChild as HTMLElement)?.scrollHeight + 8 || 28));
            zones.layoutZone(id);
          });
          });
          resize.observe(node.firstElementChild!);
        });
      }
    }
    for (const n of notes) {
    if (n.line < 1 || n.line > model.getLineCount()) continue;
    const line = n.line;
    // Monaco positions and shows/hides the zone's own node, so the bubble is a child of it
    const node = document.createElement('div');
    const bubble = document.createElement('div');
    bubble.className = 'pkw-narration';
    this.noteNodes.set(n.noteId, { note: n, node: bubble });
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
    this.noteNodes.clear();
    if (this.inspectionNode) renderUi(null, this.inspectionNode);
    this.inspectionNode = null;
    this.drawInspection = null;
    const ids = [...(zone ? [zone.id] : []), ...this.extraZones];
    this.zone = null;
    this.extraZones = [];
    if (ids.length) this.editor.changeViewZones((acc) => ids.forEach((id) => acc.removeZone(id)));
  }

  layout(): void {
    this.editor.layout();
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
