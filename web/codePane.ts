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
import type { BridgeFile } from './bridgeProtocol';
import { PROFILE_PATH, type CodeDecorations, type CodeView, type PresentedNote } from './pageHost';
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
  private readonly zones = new Map<string, { id: string; node: HTMLElement; content: HTMLElement; zone: monaco.editor.IViewZone; resize: ResizeObserver; key: string }>();
  private revealKey = '';
  private learning: boolean | undefined;
  private notesKey = '';
  private lastNotes: PresentedNote[] = [];
  private inspectionNode: HTMLElement | null = null;
  private expandedValues = new Set<string>();
  private inspectionSnapshot: string | undefined;
  private drawInspection: (() => void) | null = null;

  async presentationReady(): Promise<void> {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }

  noteUiState(): { noteId: string; file: string; line: number; rendered: boolean; visible: boolean }[] {
    return this.lastNotes.flatMap(note => {
      const node = this.zones.get(`note:${note.noteId}`)?.content;
      if (!node) return [];
      const rect = node.getBoundingClientRect();
      return { noteId: note.noteId, file: note.file, line: note.line, rendered: node.isConnected,
        visible: node.isConnected && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight };
    });
  }

  valueUiState(): { name: string; open: boolean; visible: boolean }[] {
    return [...this.inspectionNode?.querySelectorAll<HTMLElement>('.pkw-observed-summary, .pkw-observed-scalar') ?? []].map(button => {
      const rect = button.getBoundingClientRect();
      return { name: button.querySelector('.pkw-debug-name')?.textContent ?? '', open: button.getAttribute('aria-expanded') === 'true', visible: rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight };
    });
  }

  inspectValue(name: string, open: boolean): { name: string; open: boolean; visible: boolean } {
    const node = this.inspectionNode;
    if (!node || !this.drawInspection) throw new Error('value row is not visible; choose Aprender and show this binding first');
    const names = this.lastRender?.liveValues?.locals.filter(v => this.lastRender?.liveValues?.ghostNames === undefined || this.lastRender.liveValues.ghostNames.includes(v.name)).map(v => v.name) ?? [];
    if (!names.includes(name)) throw new Error(`binding is not shown: ${name}`);
    const control = [...node.querySelectorAll<HTMLElement>('.pkw-observed-summary, .pkw-observed-scalar')].find(el => el.querySelector('.pkw-debug-name')?.textContent === name);
    if (open && control?.classList.contains('pkw-observed-scalar')) throw new Error(`binding is already shown in full: ${name}`);
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
    const learning = document.body.dataset.presentation === 'learn';
    if (learning !== this.learning) {
      this.learning = learning;
      this.editor.updateOptions({ wordWrap: learning ? 'on' : 'off', wrappingIndent: 'indent', scrollBeyondLastLine: !learning });
    }
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

  setNotes(notes: PresentedNote[]): void {
    this.lastNotes = notes;
    const pause = this.lastRender?.liveValues;
    const observed = document.body.dataset.presentation === 'learn' && pause && this.editor.getValue() === (pause.content ?? this.loaded.get(this.shown!)) ? pause : undefined;
    const locals = observed?.locals.filter((v) => observed.ghostNames === undefined || observed.ghostNames.includes(v.name)) ?? [];
    const width = this.editor.getLayoutInfo().contentWidth;
    const model = this.editor.getModel();
    if (!model) return;
    const wanted = new Set<string>();
    const key = JSON.stringify([observed?.snapshot, observed?.anchor, locals]);
    if (observed && locals.length) {
      const line = observed.anchor ?? observed.line;
      if (line >= 1 && line <= model.getLineCount()) {
        wanted.add('values');
        if (this.notesKey !== key || !this.zones.has('values')) {
          // A new pause resets the tree. Width changes keep the component, focus and children.
          if (this.inspectionSnapshot !== observed.snapshot) {
            this.expandedValues.clear();
            if (this.inspectionNode) renderUi(null, this.inspectionNode);
          }
          this.inspectionSnapshot = observed.snapshot;
          const node = this.zones.get('values')?.node ?? document.createElement('div');
          node.className = 'pkw-observed-zone';
          this.inspectionNode = node;
          this.drawInspection = () => renderUi(h(ObservedBindings, {
            locals, expanded: this.expandedValues,
            onToggle: (name) => { this.inspectValue(name, !this.expandedValues.has(name)); },
            inspector: { expandNode: (value) => this.onExpandValue(value) },
          }), node);
          this.drawInspection();
          this.upsertZone('values', line, node, node.firstElementChild as HTMLElement, key);
        }
      }
    }
    this.notesKey = key;
    const active = this.lastRender?.liveValues?.line ?? this.lastRender?.paused ?? this.lastRender?.current?.line;
    for (const n of notes) {
      if (n.file !== this.shown || n.line < 1 || n.line > model.getLineCount()) continue;
      const id = `note:${n.noteId}`;
      wanted.add(id);
      const current = active === n.line && n.current !== false;
      const reference = n.current === false || (active !== undefined && !current);
      const key = JSON.stringify([n, reference]);
      if (this.zones.get(id)?.key === key) continue;
      const node = this.zones.get(id)?.node ?? document.createElement('div');
      node.className = 'pkw-note-zone';
      const bubble = document.createElement('div');
      bubble.className = `pkw-narration${reference ? ' pkw-note-reference' : ''}`;
      const label = document.createElement('span');
      label.className = 'pkw-note-label';
      label.textContent = `${n.kind === 'prediction' ? 'Predicción' : 'Nota'} · línea ${n.line}${n.current === false ? ' · contexto anterior' : active !== undefined && !current ? ' · fuera de la pausa actual' : ''}`;
      const text = document.createElement('div');
      text.className = 'pkw-narration-text';
      text.textContent = n.text;
      bubble.append(label, text);
      node.replaceChildren(bubble);
      this.upsertZone(id, n.line, node, bubble, key);
    }
    for (const id of this.zones.keys()) if (!wanted.has(id)) this.removeZone(id);
    for (const item of this.zones.values()) {
      item.node.style.width = `${width}px`;
      this.measureZone(item);
    }
    const revealKey = `${this.shown}:${observed?.snapshot ?? ''}:${active}`;
    if (active && revealKey !== this.revealKey) this.reveal(active);
    this.revealKey = revealKey;
  }

  private measureZone(item: { id: string; content: HTMLElement; zone: monaco.editor.IViewZone }): void {
    const cap = Math.max(60, Math.floor(this.editor.getLayoutInfo().height * .4));
    item.content.style.maxHeight = `${cap - 8}px`;
    // Measure the rendered content, including wrapping. Never guess from character count.
    const height = Math.ceil(item.content.getBoundingClientRect().height) + 8;
    if (height !== item.zone.heightInPx) {
      item.zone.heightInPx = height;
      this.editor.changeViewZones(acc => acc.layoutZone(item.id));
    }
  }

  private upsertZone(name: string, line: number, node: HTMLElement, content: HTMLElement, key: string): void {
    const previous = this.zones.get(name);
    if (previous && previous.content === content) {
      previous.zone.afterLineNumber = line;
      previous.key = key;
      this.editor.changeViewZones(acc => acc.layoutZone(previous.id));
      return;
    }
    if (previous) { previous.resize.disconnect(); this.editor.changeViewZones(acc => acc.removeZone(previous.id)); }
    node.style.width = `${this.editor.getLayoutInfo().contentWidth}px`;
    const zone = { afterLineNumber: line, heightInPx: 28, domNode: node, suppressMouseDown: true };
    let id = '';
    this.editor.changeViewZones(acc => { id = acc.addZone(zone); });
    // Keep c9c2808's native hit-test fix. Monaco's transparent view-lines cover zones otherwise.
    if (node.parentElement) {
      node.parentElement.style.zIndex = '30';
      // Monaco hides view zones from assistive technology by default. These contain controls.
      node.parentElement.removeAttribute('aria-hidden');
    }
    node.style.zIndex = '30';
    node.onmousedown = event => event.stopPropagation();
    node.onpointerdown = event => event.stopPropagation();
    const item = { id, node, content, zone, key, resize: new ResizeObserver(() => this.measureZone(item)) };
    this.zones.set(name, item);
    item.resize.observe(content);
    requestAnimationFrame(() => { if (this.zones.get(name) === item) this.measureZone(item); });
  }

  private removeZone(name: string): void {
    const item = this.zones.get(name);
    if (!item) return;
    item.resize.disconnect();
    if (name === 'values') {
      renderUi(null, item.node);
      this.inspectionNode = null;
      this.drawInspection = null;
    }
    this.editor.changeViewZones(acc => acc.removeZone(item.id));
    this.zones.delete(name);
  }

  private clearZone(): void {
    for (const name of this.zones.keys()) this.removeZone(name);
    this.notesKey = '';
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
