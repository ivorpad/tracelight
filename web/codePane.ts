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
import 'monaco-editor/esm/vs/editor/contrib/contextmenu/browser/contextmenu';
import { configureLanguageService, registerLanguageSource, staticHover } from './languageService';
import type { BridgeFile, TeachingNote, RenderedSource } from './bridgeProtocol';
import { PROFILE_PATH, type CodeDecorations, type CodeView, type PresentedNote } from './pageHost';
import { STORY_PATH } from './story';
import { pausedOccurrences, pausedInline, pausedHover, pausedProperty, type ValueOccurrence } from './pausedValues';
import type { ValueNode } from '../src/shared/protocol';
import { inlineHistory } from './codeHistory';
import { h, render as renderUi } from 'preact';
import { ValueTree, ValueSyntax } from './debugPane';

const INLINE_MAX = 160;

export class CodePane implements CodeView {
  onScratchpad?: (line: number) => void;
  selectedText(): string { const selection = this.editor.getSelection(); return selection ? this.editor.getModel()?.getValueInRange(selection) ?? '' : ''; }
  showStory?: CodeView['showStory'];
  storyShown?: CodeView['storyShown'];
  renderStory?: CodeView['renderStory'];
  revealStory?: CodeView['revealStory'];
  closeStory?: CodeView['closeStory'];
  renderedStory?: CodeView['renderedStory'];
  private readonly editor: monaco.editor.IStandaloneCodeEditor;
  private readonly models = new Map<string, monaco.editor.ITextModel>();
  /** the content each model last had on disk (or from the bridge), to tell an edit from a reload */
  private readonly loaded = new Map<string, string>();
  private mainPath: string | undefined;
  private shown: string | undefined;
  private decorations: monaco.editor.IEditorDecorationsCollection;
  private zone: { id: string; line: number; text: string } | null = null;
  private extraZones: string[] = [];
  private noteLayouts = new Map<string, { bubble: HTMLElement; observer: ResizeObserver }>();
  private notesKey = '';
  private lastNotes: PresentedNote[] = [];
  private valueOccurrences: ValueOccurrence[] = [];
  private valuesModel: monaco.editor.ITextModel | null = null;
  private valuesContent: string | undefined;
  private pendingNavigation: { path: string; line: number; column: number } | undefined;
  private hoverSnapshot: string | undefined;

  async presentationReady(): Promise<void> {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }

  renderedSource(): RenderedSource {
    const model = this.editor.getModel();
    const decorations = model?.getAllDecorations() ?? [];
    const marker = decorations.find(d => d.options.className === 'pkw-paused-line')
      ?? decorations.find(d => d.options.className === 'pkw-current-line');
    const line = marker?.range.startLineNumber ?? null;
    const element = this.editor.getDomNode();
    const box = element?.getBoundingClientRect();
    const visible = !!element?.isConnected && !!box?.width && !!box.height && element.getClientRects().length > 0;
    return { file: this.shown ?? null, pane: this.shown === STORY_PATH ? 'story' : 'source', line,
      code: model && line ? model.getLineContent(line) : null,
      highlight: marker ? marker.options.className === 'pkw-paused-line' ? 'live' : 'recorded' : null,
      visible, lineVisible: visible && !!line && this.editor.getVisibleRanges().some(r => r.startLineNumber <= line && r.endLineNumber >= line),
      content: model?.getValue() };
  }

  private inspected = new Set<string>();
  private inspectorZone: string | undefined;
  private inspectorNode: HTMLElement | undefined;
  private inspectorResize: ResizeObserver | undefined;

  noteUiState(): { noteId: string; file: string; line: number; rendered: boolean; visible: boolean }[] {
    return this.lastNotes.map(note => {
      const bubble = [...this.noteLayouts.values()].find(item => item.bubble.dataset.noteId === note.noteId)?.bubble;
      const box = bubble?.getBoundingClientRect();
      return { noteId: note.noteId, file: note.file, line: note.line, rendered: !!bubble?.isConnected,
        visible: !!bubble?.isConnected && !!box?.width && !!box.height && box.bottom > 0 && box.top < window.innerHeight };
    });
  }

  valueUiState(): { name: string; open: boolean; visible: boolean }[] {
    return [...this.inspected].map(name => ({ name, open: true, visible: !!this.inspectorZone }));
  }

  private clearInspector(): void {
    this.inspectorResize?.disconnect();
    this.inspectorResize = undefined;
    if (this.inspectorNode) renderUi(null, this.inspectorNode);
    if (this.inspectorZone) this.editor.changeViewZones(acc => acc.removeZone(this.inspectorZone!));
    this.inspectorNode = undefined;
    this.inspectorZone = undefined;
  }

  async peekValue(name: string): Promise<{ name: string; visible: boolean }> {
    this.hideValueHover();
    if (!name) return { name, visible: false };
    const [binding, ...path] = name.split('.');
    const o = this.valueOccurrences.find(o => o.local.name === binding && !o.unavailable &&
      path.every((part, i) => o.path?.[i] === part));
    const model = this.editor.getModel();
    if (!o || !model || model !== this.valuesModel || model.getValue() !== this.valuesContent) throw new Error(`No observed source binding at this pause: ${name}`);
    if (path.length && !pausedProperty(o.local, path)) throw new Error(`Property unavailable in this snapshot: ${name}`);
    const suffix = model.getLineContent(o.line).slice(o.end);
    const parts = [...suffix.matchAll(/(?:\?\.|\.)\s*([\p{ID_Start}_$][\p{ID_Continue}$]*)/gu)].slice(0, path.length);
    const column = path.length ? o.end + parts[path.length - 1]!.index + parts[path.length - 1]![0].length : o.start + 1;
    this.editor.revealLineInCenterIfOutsideViewport(o.line);
    this.editor.setPosition({ lineNumber: o.line, column });
    const action = this.editor.getAction('editor.action.showHover');
    if (!action) throw new Error('The editor hover action is unavailable');
    await action.run();
    await this.presentationReady();
    return { name, visible: true };
  }

  inspectValue(name: string, open: boolean): { name: string; open: boolean; visible: boolean } {
    return this.showValueCard([name], open, false)[0]!;
  }

  inspectValues(names: string[], open: boolean): { name: string; open: boolean; visible: boolean }[] {
    return this.showValueCard(names, open, true);
  }

  private showValueCard(names: string[], open: boolean, replace: boolean): { name: string; open: boolean; visible: boolean }[] {
    const values = this.lastRender?.liveValues;
    if (!values || names.some(name => !values.locals.some(v => v.name === name))) throw new Error('No observed binding at this pause');
    if (this.editor.getModel()?.getValue() !== (values.content ?? this.loaded.get(this.shown!))) throw new Error('Source changed since this pause');
    if (replace && open) this.inspected.clear();
    for (const name of names) { if (open) this.inspected.add(name); else this.inspected.delete(name); }
    this.clearInspector();
    if (!this.inspected.size) return names.map(name => ({ name, open: false, visible: false }));
    const node = document.createElement('div');
    node.style.zIndex = '5';
    const card = document.createElement('div');
    card.className = 'pkw-pause-card';
    for (const event of ['pointerdown', 'mousedown', 'mouseup', 'click', 'keydown', 'wheel']) card.addEventListener(event, e => e.stopPropagation());
    card.tabIndex = 0;
    card.setAttribute('aria-label', 'Scrollable values at the live pause');
    node.append(card);
    this.inspectorNode = card;
    renderUi(h('section', { 'aria-label': 'Values at the live pause' },
      h('header', {}, h('span', {}, `Values · line ${values.line}`), h('button', {
        type: 'button', 'aria-label': 'Close value card', onClick: () => { this.inspected.clear(); this.clearInspector(); },
      }, '×')),
      ...values.locals.filter(v => this.inspected.has(v.name)).map(v =>
        v.valueBag ? h(ValueTree, { key: `${values.snapshot}:${v.name}`, name: v.name, node: v.valueBag.data,
          initialOpen: false, debug: { expandNode: n => this.onExpandValue(n) }, onOpenSource: location => {
            this.pendingNavigation = { path: location.path, line: location.line, column: 1 };
            this.onNavigate(location.path, location.line);
            this.applyNavigation();
          } })
          : h('div', { class: 'pkw-pause-scalar' }, h('span', {}, `${v.name}: `), h(ValueSyntax, { text: v.text }))),
    ), card);
    const zone: monaco.editor.IViewZone = { afterLineNumber: values.line, heightInPx: 180, domNode: node, suppressMouseDown: true };
    this.editor.changeViewZones(acc => { this.inspectorZone = acc.addZone(zone); });
    this.inspectorResize = new ResizeObserver(() => {
      if (!this.inspectorZone) return;
      zone.heightInPx = Math.min(360, Math.max(80, card.getBoundingClientRect().height + 16));
      this.editor.changeViewZones(acc => acc.layoutZone(this.inspectorZone!));
    });
    this.inspectorResize.observe(card);
    this.editor.revealLineInCenter(values.line);
    return names.map(name => ({ name, open, visible: open }));
  }
  onInspectValue: (name: string) => void = () => {};
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
    this.editor.addAction({ id: 'tracelight.scratchpad', label: 'Add function to scratchpad', contextMenuGroupId: 'navigation', contextMenuOrder: 2, run: () => this.onScratchpad?.(this.cursorLine() ?? 1) });
    const inspectCommand = `tracelight.inspectPausedValue.${this.editor.getId()}`;
    const valueOpener = monaco.editor.registerCommand(inspectCommand, (_accessor, target: { name: string; snapshot: string }) => {
      if (target?.snapshot !== this.hoverSnapshot || !this.valueOccurrences.some(o => !o.unavailable && o.local.name === target.name)) return;
      this.hideValueHover();
      this.onInspectValue(target.name);
    });
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
          contents.push({ value: value ? pausedHover(value, snapshot, inspectCommand) : `Paused frame · ${[o.local.name, ...hit.path].join('.')}\n\nProperty unavailable in this snapshot. No expression was evaluated.`, isTrusted: { enabledCommands: [inspectCommand] } });
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
    this.editor.onDidDispose(() => { providers.forEach(p => p.dispose()); opener.dispose(); valueOpener.dispose(); this.clearInspector(); this.clearZone(); });
    this.editor.onDidLayoutChange(() => {
      for (const { bubble } of this.noteLayouts.values()) this.sizeNarration(bubble);
      if (this.lastRender) this.render(this.lastRender);
    });
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
    this.editor.setSelection(new monaco.Range(target.line, 1, target.line, this.editor.getModel()!.getLineMaxColumn(target.line)));
    this.editor.revealLineInCenter(target.line);
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
    if (line > 0) this.editor.revealLineInCenterIfOutsideViewport(line, monaco.editor.ScrollType.Immediate);
  }

  render(d: CodeDecorations): void {
    if (this.hoverSnapshot !== d.liveValues?.snapshot) { this.hideValueHover(); this.inspected.clear(); this.clearInspector(); }
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
      if (document.body.dataset.presentation === 'learn' && (document.body.dataset.history === 'hidden' || d.historyValues?.length)) continue;
      if (line < 1 || line > lines || d.errors.has(line)) continue;
      out.push({ range: endOf(line), options: { after: { content: `  ${clip(text)}`, inlineClassName: 'pkw-inline-value' }, hoverMessage: { value: '```\n' + text + '\n```' } } });
    }
    if (d.liveValues && model.getValue() === (d.liveValues.content ?? this.loaded.get(this.shown!))) {
      const occurrences = pausedOccurrences(model.getLinesContent(), monaco.editor.tokenize(model.getValue(), model.getLanguageId()), d.liveValues);
      this.valueOccurrences = occurrences;
      this.valuesModel = model;
      this.valuesContent = model.getValue();
      const ghosts = d.liveValues.ghostNames === undefined ? occurrences : d.liveValues.locals.filter((v) => d.liveValues!.ghostNames!.includes(v.name)).map((local) => ({ line: d.liveValues!.line, start: 0, end: 0, local }));
      const shadows = document.body.dataset.presentation === 'learn' ? new Map<number, string>() : pausedInline(ghosts, d.liveValues.line, d.liveValues.anchor);
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
    if (document.body.dataset.presentation === 'learn' && document.body.dataset.history !== 'hidden') {
      const history = inlineHistory(model.getValue(), monaco.editor.tokenize(model.getValue(), model.getLanguageId()), d.historyValues ?? (d.liveValues ? [d.liveValues] : []));
      for (const [line, value] of history) {
        if (line < 1 || line > lines) continue;
        const font = this.editor.getOption(monaco.editor.EditorOption.fontInfo);
        const available = Math.floor(this.editor.getLayoutInfo().contentWidth / font.typicalHalfwidthCharacterWidth) - model.getLineLength(line) - 4;
        const preview = available >= 12 ? value.preview.length > available ? value.preview.slice(0, available - 1) + '…' : value.preview : '';
        if (!preview) continue;
        out.push({ range: endOf(line), options: {
          after: { content: `  ${preview}`, inlineClassName: 'pkw-live-value', cursorStops: monaco.editor.InjectedTextCursorStops.None },
          hoverMessage: { value: value.hover, isTrusted: false },
        } });
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
    this.sizeNarration(bubble);
    node.appendChild(bubble);
    const icon = document.createElement('i');
    icon.className = 'codicon codicon-comment-discussion';
    icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('div');
    text.className = 'pkw-narration-text';
    const label = document.createElement('span');
    label.className = 'pkw-note-label';
    label.textContent = `${n.kind === 'prediction' ? 'Predicción' : 'Nota'} · línea ${n.line}${n.current === false ? ' · contexto anterior' : ''}`;
    bubble.dataset.noteId = n.noteId;
    text.append(label, document.createTextNode(n.text));
    text.setAttribute('role', 'note');
    bubble.append(icon, text);
    let height = 0;
    let id = '';
    const viewZone: monaco.editor.IViewZone = { afterLineNumber: line, heightInPx: 1, domNode: node };
    const observer = new ResizeObserver(() => {
      if (!this.noteLayouts.has(id)) return;
      const next = Math.ceil(bubble.getBoundingClientRect().height) + 12;
      text.tabIndex = text.scrollHeight > text.clientHeight ? 0 : -1;
      if (next === height) return;
      height = next;
      viewZone.heightInPx = height;
      this.editor.changeViewZones(acc => acc.layoutZone(id));
    });
    this.editor.changeViewZones(acc => {
      id = acc.addZone(viewZone);
      if (!this.zone) this.zone = { id, line, text: n.text };
      else this.extraZones.push(id);
    });
    this.noteLayouts.set(id, { bubble, observer });
    observer.observe(bubble);
    }
    const active = this.lastRender?.paused ?? this.lastRender?.current?.line;
    if (active) this.reveal(active);
  }

  private sizeNarration(bubble: HTMLElement): void {
    // View zones span the scrollable code width, which can exceed the visible pane.
    const layout = this.editor.getLayoutInfo();
    bubble.style.width = `${Math.max(0, layout.contentWidth - 16)}px`;
    const text = bubble.querySelector<HTMLElement>('.pkw-narration-text');
    if (text) text.style.maxHeight = `${Math.min(190, Math.max(40, layout.height * .35 - 34))}px`;
  }

  private clearZone(): void {
    const zone = this.zone;
    this.notesKey = '';
    for (const { observer } of this.noteLayouts.values()) observer.disconnect();
    this.noteLayouts.clear();
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
