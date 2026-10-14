import { render } from 'preact';
import { monaco } from '../webview/monaco';
import { ValueTree, ValueSyntax } from './debugPane';
import type { PageHost } from './pageHost';
import type { CodePane } from './codePane';
import type { ValueNode } from '../src/shared/protocol';
import type { ScratchResult } from './scratchpadRuntime';

import type { ScratchBaseline, ScratchCommand, ScratchEntry, ScratchState, ScratchSummary } from './scratchpadProtocol';
import { scratchInput } from './scratchpadValues';
import { scratchExperiment, validateScratchUpdate } from './scratchpadExperiment';
import { registerRuntimeLibraries } from './languageService';
import type { ScratchCompatibility } from './scratchpadCompatibility';
function valueNode(value: unknown, id = 'scratch'): ValueNode {
  if (value === null || value === undefined) return { id, queryPath: [], type: 'None', value: String(value) };
  if (typeof value !== 'object') return { id, queryPath: [], type: typeof value === 'string' ? 'str' : typeof value === 'boolean' ? 'bool' : 'number', value: String(value) };
  return { id, queryPath: [], type: Array.isArray(value) ? 'list' : 'dict', length: Object.keys(value).length,
    props: Object.entries(value).map(([name, v]) => ({ ...valueNode(v, `${id}.${name}`), name })) };
}

export class Scratchpad {
  private editor: monaco.editor.IStandaloneCodeEditor;
  private environment: Promise<void>;
  private environmentError: string | null = null;

  private async configureEnvironment(): Promise<void> {
    try {
      const response = await fetch('/api/scratchpad/environment');
      const environment = await response.json() as ScratchCompatibility & {error?:string};
      if (!response.ok) throw new Error(environment.error ?? 'Cannot load native scratchpad environment');
      registerRuntimeLibraries(environment.libraries.map(l => ({filePath:`inmemory://scratchpad/${l.path}`,content:l.content})));
      registerRuntimeLibraries([{filePath:'inmemory://scratchpad/runtime.d.ts',content:`/// <reference path="node_modules/${environment.inventory.runtime === 'bun' ? 'bun-types' : '@types/node'}/index.d.ts" />`}]);
      for (const defaults of [monaco.languages.typescript.typescriptDefaults,monaco.languages.typescript.javascriptDefaults]) { defaults.setCompilerOptions({...defaults.getCompilerOptions(),lib:['esnext'],types:[],skipLibCheck:true,moduleDetection:3}); defaults.setDiagnosticsOptions({...defaults.getDiagnosticsOptions(),noSuggestionDiagnostics:true}); }
      const node = document.createElement('p'); node.className = 'pkw-scratch-runtime';
      node.textContent = `${environment.inventory.runtime === 'bun' ? 'Bun' : 'Node'} ${environment.inventory.version} · separate process · HTTP uses explicit mocks · native file/process effects`;
      this.pane.querySelector('.pkw-scratch-file')!.after(node);
    } catch (error) { this.environmentError = error instanceof Error ? error.message : String(error); }
  }
  private model: monaco.editor.ITextModel;
  private values: monaco.editor.IEditorDecorationsCollection;
  private inputs: monaco.editor.IStandaloneCodeEditor;
  private mocks: monaco.editor.IStandaloneCodeEditor;
  private file = '';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private revision = 0;
  private auto: HTMLInputElement;
  private original = '';
  private initialInputs = '';
  private initialMocks = '{}';
  private resize: ResizeObserver;
  private activeRequest?: AbortController;
  private inputNames: string[] = [];
  private helperNames: string[] = [];
  private capturedValues: ScratchResult['values'] = [];

  private runStatus: ScratchState['status'] = 'empty';
  private result: ScratchResult | null = null;
  private error: string | null = null;
  private provenance: ScratchState['provenance'] = null;
  private mockLabels: Record<string, string> = {};
  private updating = false;
  private requiresReceiver = false;
  private id: string | null = null;
  private title = '';
  private versions = new Map<string, number>();
  private saveError: string | null = null;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private pendingSaveReason = 'edit';
  private pendingSaves = 0;
  private loadedVersion: number | null = null;
  private saves: Promise<void> = Promise.resolve();
  private initialMockLabels: Record<string, string> = {};

  private baseline(): ScratchBaseline { return { code: this.original, inputsText: this.initialInputs, mocksText: this.initialMocks, mockLabels: this.initialMockLabels, helperNames: this.helperNames, requiresReceiver: this.requiresReceiver }; }
  private async library<T>(op: string, data: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch('/api/scratchpad/library', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...data, op }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Cannot access saved scratchpads');
    return result;
  }
  private persist(reason: string): void {
    if (!this.id) return;
    const id = this.id, title = this.title;
    const state = JSON.parse(JSON.stringify(this.state())) as ScratchState;
    const baseline = JSON.parse(JSON.stringify(this.baseline())) as ScratchBaseline;
    ++this.pendingSaves; this.saveStatus();
    this.saves = this.saves.then(async () => {
      try {
        const entry = await this.library<ScratchEntry>('save', { entry: { id, title, reason, state, baseline, expectedVersion: this.versions.get(id) ?? 0 } });
        this.versions.set(id, entry.version);
        if (this.id === id) { this.saveError = null; if (state.revision === this.revision) this.loadedVersion = entry.version; await this.refreshLibrary(); }
      } catch (error) {
        if (this.id === id) { this.saveError = String(error instanceof Error ? error.message : error); this.status(`Not saved: ${this.saveError}`); }
      } finally { --this.pendingSaves; this.saveStatus(); }
    });
  }
  private saveStatus(): void {
    const node = this.pane.querySelector('.pkw-scratch-autosave');
    if (node) node.textContent = this.saveError ? `Not saved: ${this.saveError}` : this.saveTimer || this.pendingSaves ? 'Autosaving…' : this.id ? `Autosaved · v${this.versions.get(this.id) ?? 0}` : 'Autosave on';
  }
  private async flushSave(): Promise<void> {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined; this.persist(this.pendingSaveReason); }
    await this.saves;
  }
  private async refreshLibrary(): Promise<void> {
    const entries = await this.library<ScratchSummary[]>('list');
    const select = this.pane.querySelector<HTMLSelectElement>('.pkw-scratch-list')!;
    select.replaceChildren(new Option('Saved scratchpads', ''));
    for (const item of entries) select.add(new Option(`${item.title} · v${item.version}`, item.id));
    select.value = this.id ?? '';
    if (this.id) {
      const history = await this.library<ScratchSummary[]>('history', { id: this.id });
      const versions = this.pane.querySelector<HTMLSelectElement>('.pkw-scratch-history')!;
      versions.replaceChildren(new Option('Scratchpad history', ''));
      for (const item of history) versions.add(new Option(`v${item.version} · ${item.reason} · ${new Date(item.updatedAt).toLocaleString()}`, String(item.version)));
      versions.value = this.loadedVersion === null ? '' : String(this.loadedVersion);
    }
    this.pane.querySelector<HTMLInputElement>('.pkw-scratch-title')!.value = this.title;
  }
  async showLibrary(): Promise<void> {
    await this.flushSave();
    if (!this.id) {
      const entries = await this.library<ScratchSummary[]>('list');
      if (entries[0]) { await this.load(entries[0].id); return; }
      if (this.host.debug.paused) { await this.open(); return; }
      await this.create({}); return;
    }
    this.pane.hidden = false; document.body.classList.add('pkw-scratch-open'); this.onLayout();
    await this.refreshLibrary();
  }
  private async load(id: string, version?: number): Promise<void> {
    await this.flushSave();
    const latest = await this.library<ScratchEntry>('get', { id });
    const entry = version === undefined ? latest : await this.library<ScratchEntry>('get', { id, version });
    if (this.timer) clearTimeout(this.timer);
    ++this.revision; this.activeRequest?.abort();
    this.updating = true;
    try {
      this.id = id; this.loadedVersion = entry.version; this.title = entry.title; this.versions.set(id, latest.version); this.saveError = null;
      this.file = entry.state.file; this.provenance = entry.state.provenance; this.requiresReceiver = entry.baseline.requiresReceiver ?? entry.state.preparation?.requiresReceiver ?? false;
      this.original = entry.baseline.code; this.initialInputs = entry.baseline.inputsText; this.initialMocks = entry.baseline.mocksText;
      this.initialMockLabels = entry.baseline.mockLabels; this.helperNames = entry.baseline.helperNames;
      this.model.setValue(entry.state.code); this.inputs.setValue(entry.state.inputsText); this.mocks.setValue(entry.state.mocksText);
      this.mockLabels = entry.state.mockLabels; this.auto.checked = entry.state.autoRun;
      this.inputNames = Object.keys(entry.state.inputs ?? {}).filter(n => /^[A-Za-z_$][\w$]*$/.test(n));
      this.result = entry.state.result; this.error = entry.state.error;
      this.runStatus = this.error ? 'error' : this.result ? 'completed' : entry.state.status === 'needsPreparation' ? 'needsPreparation' : 'dirty';
      this.capturedValues = this.result?.values ?? [];
    } finally { this.updating = false; }
    this.pane.hidden = false; document.body.classList.add('pkw-scratch-open'); this.onLayout(); this.editor.layout();
    this.pane.querySelector('.pkw-scratch-file')!.textContent = `${this.file.split('/').pop()} · saved v${entry.version} · no execution on reopen`;
    this.status(this.error ?? ''); this.renderResult(this.result ?? { values: [], output: [] }); this.fixtureLabels();
    await this.refreshLibrary(); this.saveStatus();
  }
  private async create(command: ScratchCommand): Promise<void> {
    await this.flushSave();
    this.validateEdit(command);
    const file = command.file ?? this.host.main?.path;
    if (!file) throw new Error('A scratchpad needs a source file for resolving dependencies');
    if (this.timer) clearTimeout(this.timer); ++this.revision; this.activeRequest?.abort();
    this.updating = true;
    try {
      this.id = crypto.randomUUID(); this.title = command.title?.trim() || 'Untitled experiment'; this.saveError = null;
      this.file = file; this.provenance = null; this.helperNames = []; this.requiresReceiver = false;
      this.original = command.code ?? '// Write your experiment here.\nexport {};';
      this.initialInputs = JSON.stringify(command.inputs ?? {}, null, 2); this.initialMocks = JSON.stringify(command.mocks ?? {}, null, 2);
      this.initialMockLabels = command.mockLabels ?? {}; this.mockLabels = { ...this.initialMockLabels };
      this.model.setValue(this.original); this.inputs.setValue(this.initialInputs); this.mocks.setValue(this.initialMocks);
      this.inputNames = Object.keys(command.inputs ?? {}); this.auto.checked = command.autoRun ?? true;
    } finally { this.updating = false; }
    this.pane.querySelector('.pkw-scratch-file')!.textContent = `${file.split('/').pop()} · supplied experiment`;
    this.pane.hidden = false; document.body.classList.add('pkw-scratch-open'); this.onLayout(); this.editor.layout(); this.schedule('create');
    await this.flushSave();
  }
  private validateEdit(command: ScratchCommand): void {
    if (command.title !== undefined && (typeof command.title !== 'string' || !command.title.trim() || command.title.length > 200)) throw new Error('Scratchpad title must contain 1–200 characters');
    validateScratchUpdate(command);
  }

  state(): ScratchState {
    const parse = (text: string): Record<string, unknown> | null => { try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; } catch { return null; } };
    const mocks = parse(this.mocks.getValue());
    return { diagnostics:monaco.editor.getModelMarkers({resource:this.model.uri}).map(m=>({code:typeof m.code==='string'?m.code:m.code?.value,message:m.message,line:m.startLineNumber,severity:m.severity})), id: this.id, title: this.title, loadedVersion: this.loadedVersion, saving: Boolean(this.saveTimer || this.pendingSaves), savedVersion: this.id ? this.versions.get(this.id) ?? 0 : 0, saveError: this.saveError, open: !this.pane.hidden, file: this.file, code: this.model.getValue(), inputs: parse(this.inputs.getValue()), mocks, inputsText: this.inputs.getValue(), mocksText: this.mocks.getValue(), mockLabels: Object.fromEntries(Object.keys(mocks ?? {}).map(path => [path, this.mockLabels[path] ?? 'manual synthetic fixture'])), autoRun: this.auto.checked, revision: this.revision, status: this.runStatus, preparation: this.provenance ? { requiresReceiver: this.requiresReceiver } : null, result: this.result, error: this.error, provenance: this.provenance, liveExecutionChanged: false };
  }
  async control(command: ScratchCommand): Promise<ScratchState> {
    await this.environment;
    const op = command.op ?? (typeof command.open === 'boolean' ? command.open ? 'open' : 'close' : 'state');
    if (!['experiment', 'open', 'close', 'state', 'update', 'run', 'restore', 'create', 'save', 'list', 'load', 'history'].includes(op)) throw new Error('Unknown scratchpad operation');
    if (op === 'experiment') {
      this.validateEdit(command);
      await this.flushSave();
      return scratchExperiment(command, {
      format: async code => {
        const response = await fetch('/api/scratchpad/format', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
        const value = await response.json() as { code?: string; error?: string };
        if (!response.ok || value.error || typeof value.code !== 'string') throw new Error(value.error ?? 'Cannot format scratchpad code');
        return value.code;
      },
      begin: () => { this.updating = true; this.activeRequest?.abort(); if (this.timer) clearTimeout(this.timer); this.pane.hidden = true; },
      open: (line, publish) => this.open(line, publish),
      replace: update => this.replace(update),
      publish: () => this.publish(),
      finish: () => { this.updating = false; },
      run: () => this.run(), state: () => this.state(),
    });
    }
    if (op === 'list') { await this.flushSave(); return { ...this.state(), scratchpads: await this.library<ScratchSummary[]>('list') }; }
    if (op === 'history') { await this.flushSave(); const id = command.id ?? this.id; if (!id) throw new Error('Choose a scratchpad id'); return { ...this.state(), history: await this.library<ScratchSummary[]>('history', { id }), ...(command.version !== undefined ? { entry: await this.library<ScratchEntry>('get', { id, version: command.version }) } : {}) }; }
    if (op === 'load') { if (!command.id) throw new Error('load needs a scratchpad id'); await this.load(command.id, command.version); }
    else if (op === 'create') await this.create(command);
    else if (op === 'save') { if (!this.id) throw new Error('Create or open a scratchpad before saving'); this.validateEdit(command); if (command.title !== undefined) this.title = command.title.trim(); await this.flushSave(); this.persist('save'); }
    else if (op === 'open') await this.open(command.line);
    else if (op === 'close') this.close();
    else if (op === 'update') {
      if (this.pane.hidden) throw new Error('Open scratchpad before editing');
      this.validateEdit(command);
      this.updating = true;
      try {
        if (command.title !== undefined) this.title = command.title.trim();
        if (command.autoRun !== undefined) this.auto.checked = command.autoRun;
        if (command.code !== undefined) this.model.setValue(command.code);
        if (command.inputs !== undefined) { this.inputs.setValue(JSON.stringify(command.inputs, null, 2)); this.inputNames = Object.keys(command.inputs).filter(n => /^[A-Za-z_$][\w$]*$/.test(n)); }
        if (command.mocks !== undefined) this.mocks.setValue(JSON.stringify(command.mocks, null, 2));
        if (command.mockLabels !== undefined || command.mocks !== undefined) this.mockLabels = { ...command.mockLabels };
      } finally { this.updating = false; }
      this.schedule();
    } else if (op === 'run') {
      if (this.pane.hidden) throw new Error('Open scratchpad before running');
      await this.run();
    } else if (op === 'restore') this.restore();
    await this.flushSave();
    return this.state();
  }
  private replace(command: ScratchCommand): void {
    if (command.title !== undefined) this.title = command.title.trim();
    if (command.autoRun !== undefined) this.auto.checked = command.autoRun;
    if (command.code !== undefined) this.model.setValue(command.code);
    if (command.inputs !== undefined) { this.inputs.setValue(JSON.stringify(command.inputs, null, 2)); this.inputNames = Object.keys(command.inputs).filter(n => /^[A-Za-z_$][\w$]*$/.test(n)); }
    if (command.mocks !== undefined) { this.mocks.setValue(JSON.stringify(command.mocks, null, 2)); this.mockLabels = { ...command.mockLabels }; }
    this.result = null; this.error = null; this.capturedValues = []; this.values.clear();
    render(null, this.pane.querySelector('.pkw-scratch-results')!); this.status('');
    this.fixtureLabels();
  }
  private publish(): void {
    this.pane.hidden = false; document.body.classList.add('pkw-scratch-open');
    this.onLayout(); this.editor.layout(); this.editor.focus();
  }
  private restore(): void {
    this.updating = true;
    try { this.model.setValue(this.original); this.inputs.setValue(this.initialInputs); this.mocks.setValue(this.initialMocks); this.mockLabels = { ...this.initialMockLabels }; } finally { this.updating = false; }
    this.inputNames = Object.keys(JSON.parse(this.initialInputs || '{}'));
    this.schedule('restore');
  }
  constructor(private pane: HTMLElement, private host: PageHost, private code: CodePane, private onLayout: () => void) {
    monaco.languages.register({ id: 'json' });
    monaco.languages.setMonarchTokensProvider('json', { tokenizer: { root: [[/"([^"\\]|\\.)*"(?=\s*:)/, 'string.key'], [/"([^"\\]|\\.)*"/, 'string'], [/-?\d+(\.\d+)?([eE][+-]?\d+)?/, 'number'], [/\b(true|false|null)\b/, 'keyword'], [/[{}\[\],:]/, 'delimiter']] } });
    pane.innerHTML = `<header><span>Scratchpad</span><label><input type="checkbox" checked> Auto run</label><button type="button" class="pkw-btn" aria-label="Close scratchpad"><i class="codicon codicon-close"></i></button></header><div class="pkw-scratch-library">
      <label for="pkw-scratch-list">Scratchpads</label><div class="pkw-scratch-select"><select id="pkw-scratch-list" class="pkw-scratch-list" aria-label="Saved scratchpads"><option value="">Saved scratchpads</option></select><i class="codicon codicon-chevron-down" aria-hidden="true"></i></div><button type="button" class="pkw-btn pkw-scratch-new" aria-label="New scratchpad" title="New scratchpad"><i class="codicon codicon-new-file" aria-hidden="true"></i></button>
      <label for="pkw-scratch-title">Name</label><input id="pkw-scratch-title" class="pkw-scratch-title" aria-label="Scratchpad name" placeholder="Scratchpad name"><button type="button" class="pkw-btn pkw-scratch-save" aria-label="Save checkpoint" title="Save checkpoint"><i class="codicon codicon-save" aria-hidden="true"></i></button>
      <label for="pkw-scratch-history">History</label><div class="pkw-scratch-select pkw-scratch-history-field"><select id="pkw-scratch-history" class="pkw-scratch-history" aria-label="Scratchpad history"><option value="">Scratchpad history</option></select><i class="codicon codicon-chevron-down" aria-hidden="true"></i></div>
      <span class="pkw-scratch-autosave" role="status">Autosave on</span></div><div class="pkw-scratch-file"></div><div class="pkw-scratch-editor" aria-label="TypeScript scratchpad"></div><div class="pkw-scratch-results" aria-live="polite"></div><details><summary>Inputs · copied at pause</summary><textarea class="pkw-scratch-inputs" aria-label="Editable copied inputs" spellcheck="false"></textarea></details><details><summary>Mocks · external calls</summary><textarea class="pkw-scratch-mocks" aria-label="Mock response fixtures" spellcheck="false">{}</textarea></details><footer><button type="button" class="pkw-text-btn pkw-scratch-run">Run</button><button type="button" class="pkw-text-btn pkw-scratch-reset">Restore copy</button><span class="pkw-scratch-state" role="status"></span></footer>`;
    for (const name of ['inputs', 'mocks']) {
      const old = pane.querySelector(`.pkw-scratch-${name}`)!;
      const container = document.createElement('div'); container.className = `pkw-scratch-${name} pkw-scratch-json`;
      container.setAttribute('aria-label', name === 'inputs' ? 'Editable copied inputs' : 'Mock response fixtures'); old.replaceWith(container);
    }
    const jsonEditor = (name: string) => monaco.editor.create(pane.querySelector(`.pkw-scratch-${name}`)!, { value: '{}', language: 'json', ariaLabel: name === 'inputs' ? 'Editable copied inputs' : 'Mock response fixtures', theme: this.host.theme === 'light' ? 'vs' : 'vs-dark', automaticLayout: true, minimap: { enabled: false }, fontSize: 13, wordWrap: 'on', scrollBeyondLastLine: false, lineNumbers: 'off', folding: true });
    this.inputs = jsonEditor('inputs'); this.mocks = jsonEditor('mocks');
    for (const details of pane.querySelectorAll('details')) details.addEventListener('toggle', () => { this.inputs.layout(); this.mocks.layout(); });
    this.auto = pane.querySelector('input')!;
    this.model = monaco.editor.createModel('', 'typescript', monaco.Uri.parse(`inmemory://scratchpad/${Date.now()}.ts`));
    this.environment = this.configureEnvironment();
    this.editor = monaco.editor.create(pane.querySelector('.pkw-scratch-editor')!, { model: this.model, theme: this.host.theme === 'light' ? 'vs' : 'vs-dark', automaticLayout: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, wordWrap: 'on', lineNumbers: 'on', padding: { top: 12 } });
    this.values = this.editor.createDecorationsCollection();
    monaco.languages.registerHoverProvider('typescript', { provideHover: (model, position) => {
      if (model !== this.model) return null;
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const observed = [...this.capturedValues].reverse().find(v => v.name === word.word && v.line <= position.lineNumber);
      if (!observed) return null;
      return { range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn), contents: [{ value: `Scratchpad value\n\n\`\`\`json\n${JSON.stringify(observed.value, null, 2)}\n\`\`\`` }] };
    } });
    this.model.onDidChangeContent(() => this.schedule());
    this.inputs.onDidChangeModelContent(() => this.schedule()); this.mocks.onDidChangeModelContent(() => { if (!this.updating) this.mockLabels = {}; this.schedule(); });
    this.auto.onchange = () => this.schedule();
    pane.querySelector('[aria-label="Close scratchpad"]')!.addEventListener('click', () => this.close());
    const addFunction = document.createElement('button');
    addFunction.type = 'button'; addFunction.className = 'pkw-text-btn'; addFunction.textContent = 'Add function';
    addFunction.title = 'Copy the function at the cursor with captured paused inputs';
    addFunction.addEventListener('click', () => void this.open(this.code.cursorLine() ?? undefined).catch(error => this.status(String(error))));
    pane.querySelector('header')!.insertBefore(addFunction, pane.querySelector('[aria-label="Close scratchpad"]'));
    pane.querySelector('.pkw-scratch-run')!.addEventListener('click', () => void this.run());
    pane.querySelector('.pkw-scratch-reset')!.addEventListener('click', () => this.restore());
    const report = (error: unknown) => this.status(String(error));
    pane.querySelector<HTMLSelectElement>('.pkw-scratch-list')!.onchange = event => { const id = (event.target as HTMLSelectElement).value; if (id) void this.load(id).catch(report); };
    pane.querySelector<HTMLSelectElement>('.pkw-scratch-history')!.onchange = event => { const version = Number((event.target as HTMLSelectElement).value); if (this.id && version) void this.load(this.id, version).catch(report); };
    pane.querySelector('.pkw-scratch-new')!.addEventListener('click', () => void this.create({}).catch(report));
    pane.querySelector('.pkw-scratch-save')!.addEventListener('click', () => void this.control({ op: 'save', title: pane.querySelector<HTMLInputElement>('.pkw-scratch-title')!.value }).catch(report));
    pane.querySelector<HTMLInputElement>('.pkw-scratch-title')!.oninput = event => {
      const title = (event.target as HTMLInputElement).value.trim();
      if (!title || title.length > 200) return;
      this.title = title;
      if (this.saveTimer) clearTimeout(this.saveTimer);
      this.pendingSaveReason = 'rename';
      this.saveTimer = setTimeout(() => { this.saveTimer = undefined; this.persist('rename'); }, 200);
      this.saveStatus();
    };
    void this.refreshLibrary().catch(report);
    this.resize = new ResizeObserver(() => { this.editor.layout(); this.onLayout(); });
    this.resize.observe(pane);
  }
  close(): void { if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined; } this.runStatus = 'closed'; this.persist('close'); ++this.revision; this.activeRequest?.abort(); if (this.timer) clearTimeout(this.timer); this.pane.hidden = true; document.body.classList.remove('pkw-scratch-open'); this.onLayout(); }
  private status(text: string): void { this.pane.querySelector('.pkw-scratch-state')!.textContent = text; }
  async open(line?: number, publish = true): Promise<void> {
    await this.flushSave();
    const paused = this.host.debug.paused, state = this.host.debug.state();
    if (!paused || !state) throw new Error('Start scratchpad at a live pause to copy its inputs.');
    const frame = paused.stack[this.host.debug.selectedFrame];
    this.file = this.code.shownPath() ?? this.host.debug.pathOf(frame?.fileId ?? paused.fileId) ?? '';
    const pausedPath = this.host.debug.pathOf(frame?.fileId ?? paused.fileId);
    const targetLine = line ?? (this.file === pausedPath ? frame?.line ?? paused.line : this.code.cursorLine() ?? 1);
    const response = await fetch('/api/scratchpad/prepare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: this.file, line: targetLine }) });
    const fn = await response.json() as { code: string; name?: string; parameters: string[]; helpers?: string[]; requiresReceiver?: boolean; error?: string };
    if (!response.ok || fn.error) throw new Error(fn.error ?? 'Cannot prepare scratchpad');
    if (this.host.debug.paused !== paused) throw new Error('Pause changed while copying scratchpad inputs.');
    this.inputNames = state.locals.map(v => v.name).filter(name => /^[A-Za-z_$][\w$]*$/.test(name));
    this.helperNames = fn.helpers ?? [];
    let remaining = 80;
    const copy = async (node: ValueNode, depth = 0): Promise<ValueNode> => {
      if (node.type === 'function' || node.secret || node.circular || depth > 5 || --remaining < 0) return node;
      const expanded = node.expandable ? await this.host.debug.expandNode(node) ?? node : node;
      return expanded.props ? { ...expanded, props: await Promise.all(expanded.props.map(async p => ({ ...await copy(p, depth + 1), name: p.name }))) } : expanded;
    };
    const inputs: Record<string, unknown> = {};
    for (const v of state.locals.filter(v => this.inputNames.includes(v.name))) { remaining = 80; inputs[v.name] = v.valueBag ? scratchInput(await copy(v.valueBag.data)) : { __scratchUnavailable: 'not captured' }; }
    if (this.host.debug.paused !== paused) throw new Error('Pause changed while copying scratchpad inputs.');
    this.id = crypto.randomUUID(); this.title = fn.name ?? `${this.file.split('/').pop()} experiment`; this.saveError = null;
    const wasUpdating = this.updating;
    this.updating = true;
    this.initialMockLabels = {};
    this.initialInputs = JSON.stringify(inputs, null, 2);
    this.initialMocks = '{}';
    this.requiresReceiver = fn.requiresReceiver === true;
    this.mockLabels = {};
    this.provenance = { file: this.file, line: frame?.line ?? paused.line, runId: this.host.state().live?.runId ?? null, frame: this.host.debug.selectedFrame, capturedInputs: JSON.parse(this.initialInputs) };
    this.inputs.setValue(this.initialInputs); this.mocks.setValue(this.initialMocks);
    this.original = (fn.name ? `${fn.code}\n\nconst result = await ${fn.name}(${fn.parameters.join(', ')});` : this.code.selectedText() || `// Use the copied variables below.\n`) + '\n\nexport {};';
    this.model.setValue(this.original);
    this.pane.querySelector('.pkw-scratch-file')!.textContent = `${this.file.split('/').pop()} · copy at line ${frame?.line ?? paused.line}`;
    this.updating = wasUpdating;
    if (publish) { this.publish(); this.schedule('create'); await this.flushSave(); }
  }
  private fixtureLabels(): void {
    const labels = this.pane.querySelector('.pkw-scratch-labels') ?? (() => {
      const node = document.createElement('p'); node.className = 'pkw-scratch-labels';
      node.setAttribute('aria-label', 'Synthetic fixture labels');
      node.style.cssText = 'margin:0;padding:0 12px 8px;overflow-wrap:anywhere';
      this.pane.querySelector('.pkw-scratch-file')!.after(node);
      return node;
    })();
    let fixtures: Record<string, unknown> = {};
    try { fixtures = JSON.parse(this.mocks.getValue()); } catch { /* The run reports invalid JSON. */ }
    labels.textContent = fixtures && typeof fixtures === 'object' ? Object.keys(fixtures).map(path => `${path}: ${this.mockLabels[path] ?? 'manual synthetic fixture'}`).join(' · ') : '';
    (labels as HTMLElement).hidden = !labels.textContent;
  }
  private schedule(reason = 'edit'): void {
    if (this.updating) return;
    this.fixtureLabels();
    this.loadedVersion = null;
    this.runStatus = 'dirty'; this.result = null; this.error = null;
    this.capturedValues = [];
    ++this.revision; this.activeRequest?.abort(); this.values.clear(); render(null, this.pane.querySelector('.pkw-scratch-results')!);
    if (this.timer) clearTimeout(this.timer);
    this.status('');
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.pendingSaveReason = reason;
    this.saveTimer = setTimeout(() => { this.saveTimer = undefined; this.persist(reason); }, 200);
    this.saveStatus();
    if (!this.pane.hidden && this.requiresReceiver && this.model.getValue() === this.original) {
      this.runStatus = 'needsPreparation';
      this.status('This method needs its copied receiver before automatic execution.');
      return;
    }
    if (!this.auto.checked || this.pane.hidden) return;
    this.runStatus = 'scheduled'; this.status(''); this.timer = setTimeout(() => void this.run(), 150);
  }
  private async run(): Promise<void> {
    if (this.pane.hidden) return;
    if (this.timer) clearTimeout(this.timer);
    this.runStatus = 'running'; this.result = null; this.error = null;
    const revision = ++this.revision;
    this.activeRequest?.abort(); this.activeRequest = new AbortController();
    this.status('Running…');
    try {
      await this.environment;
      if (this.environmentError) throw new Error(this.environmentError);
      const inputs = JSON.parse(this.inputs.getValue()), mocks = JSON.parse(this.mocks.getValue());
      if (!inputs || Array.isArray(inputs) || typeof inputs !== 'object' || !mocks || Array.isArray(mocks) || typeof mocks !== 'object') throw new Error('Inputs and mocks must be JSON objects.');
      const declarations = [...this.inputNames, ...this.helperNames].map(name => `declare const ${name}: any;`).join('\n');
      registerRuntimeLibraries([{content:`${declarations}\n`,filePath:'inmemory://scratchpad/context.d.ts'}]);
      const response = await fetch('/api/scratchpad/run', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: this.activeRequest.signal, body: JSON.stringify({ file: this.file, code: this.model.getValue(), inputs, mocks }) });
      const data = await response.json() as ScratchResult;
      if (revision !== this.revision) return;
      this.result = data; this.error = data.error ?? null; this.runStatus = data.error ? 'error' : 'completed';
      this.status(data.error ?? '');
      data.values ??= []; data.output ??= [];
      this.renderResult(data);
      await this.flushSave(); this.persist('run'); await this.saves;
    } catch (e) { if (revision === this.revision) { this.error = e instanceof Error ? e.message : String(e); this.runStatus = 'error'; this.status(this.error); await this.flushSave(); this.persist('run'); await this.saves; } }
  }
  private renderResult(data: ScratchResult): void {
    this.capturedValues = data.values;
      this.values.set(data.values.filter(v => v.line <= this.model.getLineCount()).map(v => ({ range: new monaco.Range(v.line, this.model.getLineMaxColumn(v.line), v.line, this.model.getLineMaxColumn(v.line)), options: { after: { content: `  ${v.name} = ${JSON.stringify(v.value)?.slice(0, 90)}`, inlineClassName: 'pkw-inline-value' } } })));
      const latest = [...new Map(data.values.map(v => [v.name, v])).values()];
      const inspector = { expandNode: async (n: ValueNode) => n };
      render(<>{latest.map(v => <ValueTree key={`${this.revision}:${v.name}`} node={valueNode(v.value)} name={v.name} debug={inspector} initialOpen={v.name === 'result'} />)}{data.output.length ? <section aria-label="Console output">{data.output.map((entry, i) => <div class="pkw-scratch-console-row" key={i}>{(Array.isArray(entry) ? entry : [entry]).map((arg, j) => typeof arg === 'object' && arg !== null ? <ValueTree key={j} node={valueNode(arg)} name="" debug={inspector} /> : <span key={j}><ValueSyntax text={String(arg)} /></span>)}</div>)}</section> : null}</>, this.pane.querySelector('.pkw-scratch-results')!);
  }
}
