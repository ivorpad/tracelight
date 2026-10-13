import { render } from 'preact';
import { monaco } from '../webview/monaco';
import { ValueTree, ValueSyntax } from './debugPane';
import type { PageHost } from './pageHost';
import type { CodePane } from './codePane';
import type { ValueNode } from '../src/shared/protocol';
import type { ScratchResult } from './scratchpadRuntime';

import type { ScratchCommand, ScratchState } from './scratchpadProtocol';
import { scratchInput } from './scratchpadValues';
import { scratchExperiment, validateScratchUpdate } from './scratchpadExperiment';
function valueNode(value: unknown, id = 'scratch'): ValueNode {
  if (value === null || value === undefined) return { id, queryPath: [], type: 'None', value: String(value) };
  if (typeof value !== 'object') return { id, queryPath: [], type: typeof value === 'string' ? 'str' : typeof value === 'boolean' ? 'bool' : 'number', value: String(value) };
  return { id, queryPath: [], type: Array.isArray(value) ? 'list' : 'dict', length: Object.keys(value).length,
    props: Object.entries(value).map(([name, v]) => ({ ...valueNode(v, `${id}.${name}`), name })) };
}

export class Scratchpad {
  private editor: monaco.editor.IStandaloneCodeEditor;
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

  state(): ScratchState {
    const parse = (text: string): Record<string, unknown> | null => { try { return JSON.parse(text); } catch { return null; } };
    return { open: !this.pane.hidden, file: this.file, code: this.model.getValue(), inputs: parse(this.inputs.getValue()), mocks: parse(this.mocks.getValue()), inputsText: this.inputs.getValue(), mocksText: this.mocks.getValue(), mockLabels: { ...this.mockLabels }, autoRun: this.auto.checked, revision: this.revision, status: this.runStatus, preparation: this.provenance ? { requiresReceiver: this.requiresReceiver } : null, result: this.result, error: this.error, provenance: this.provenance, liveExecutionChanged: false };
  }
  async control(command: ScratchCommand): Promise<ScratchState> {
    const op = command.op ?? (typeof command.open === 'boolean' ? command.open ? 'open' : 'close' : 'state');
    if (!['experiment', 'open', 'close', 'state', 'update', 'run', 'restore'].includes(op)) throw new Error('Unknown scratchpad operation');
    if (op === 'experiment') return scratchExperiment(command, {
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
    if (op === 'open') await this.open(command.line);
    else if (op === 'close') this.close();
    else if (op === 'update') {
      if (this.pane.hidden) throw new Error('Open scratchpad before editing');
      validateScratchUpdate(command);
      this.updating = true;
      try { this.replace(command); } finally { this.updating = false; }
      this.schedule();
    } else if (op === 'run') {
      if (this.pane.hidden) throw new Error('Open scratchpad before running');
      await this.run();
    } else if (op === 'restore') this.restore();
    return this.state();
  }
  private replace(command: ScratchCommand): void {
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
    try { this.model.setValue(this.original); this.inputs.setValue(this.initialInputs); this.mocks.setValue(this.initialMocks); this.mockLabels = {}; } finally { this.updating = false; }
    this.inputNames = Object.keys(JSON.parse(this.initialInputs || '{}'));
    this.schedule();
  }
  constructor(private pane: HTMLElement, private host: PageHost, private code: CodePane, private onLayout: () => void) {
    monaco.languages.register({ id: 'json' });
    monaco.languages.setMonarchTokensProvider('json', { tokenizer: { root: [[/"([^"\\]|\\.)*"(?=\s*:)/, 'string.key'], [/"([^"\\]|\\.)*"/, 'string'], [/-?\d+(\.\d+)?([eE][+-]?\d+)?/, 'number'], [/\b(true|false|null)\b/, 'keyword'], [/[{}\[\],:]/, 'delimiter']] } });
    pane.innerHTML = `<header><span>Scratchpad</span><label><input type="checkbox" checked> Auto run</label><button type="button" class="pkw-btn" aria-label="Close scratchpad"><i class="codicon codicon-close"></i></button></header><div class="pkw-scratch-file"></div><div class="pkw-scratch-editor" aria-label="TypeScript scratchpad"></div><div class="pkw-scratch-results" aria-live="polite"></div><details><summary>Inputs · copied at pause</summary><textarea class="pkw-scratch-inputs" aria-label="Editable copied inputs" spellcheck="false"></textarea></details><details><summary>Mocks · external calls</summary><textarea class="pkw-scratch-mocks" aria-label="Mock response fixtures" spellcheck="false">{}</textarea></details><footer><button type="button" class="pkw-text-btn pkw-scratch-run">Run</button><button type="button" class="pkw-text-btn pkw-scratch-reset">Restore copy</button><span class="pkw-scratch-state" role="status"></span></footer>`;
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
    this.resize = new ResizeObserver(() => { this.editor.layout(); this.onLayout(); });
    this.resize.observe(pane);
  }
  close(): void { this.runStatus = 'closed'; ++this.revision; this.activeRequest?.abort(); if (this.timer) clearTimeout(this.timer); this.pane.hidden = true; document.body.classList.remove('pkw-scratch-open'); this.onLayout(); }
  private status(text: string): void { this.pane.querySelector('.pkw-scratch-state')!.textContent = text; }
  async open(line?: number, publish = true): Promise<void> {
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
    this.initialInputs = JSON.stringify(inputs, null, 2);
    this.initialMocks = '{}';
    this.requiresReceiver = fn.requiresReceiver === true;
    this.mockLabels = {};
    this.provenance = { file: this.file, line: frame?.line ?? paused.line, runId: this.host.state().live?.runId ?? null, frame: this.host.debug.selectedFrame, capturedInputs: JSON.parse(this.initialInputs) };
    this.inputs.setValue(this.initialInputs); this.mocks.setValue(this.initialMocks);
    this.original = (fn.name ? `${fn.code}\n\nconst result = await ${fn.name}(${fn.parameters.join(', ')});` : this.code.selectedText() || `// Use the copied variables below.\n`) + '\n\nexport {};';
    this.model.setValue(this.original);
    this.pane.querySelector('.pkw-scratch-file')!.textContent = `${this.file.split('/').pop()} · copy at line ${frame?.line ?? paused.line}`;
    if (publish) this.publish();
    this.schedule();
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
  private schedule(): void {
    if (this.updating) return;
    this.fixtureLabels();
    this.runStatus = 'dirty'; this.result = null; this.error = null;
    this.capturedValues = [];
    ++this.revision; this.activeRequest?.abort(); this.values.clear(); render(null, this.pane.querySelector('.pkw-scratch-results')!);
    if (this.timer) clearTimeout(this.timer);
    this.status('');
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
      const inputs = JSON.parse(this.inputs.getValue()), mocks = JSON.parse(this.mocks.getValue());
      if (!inputs || Array.isArray(inputs) || typeof inputs !== 'object' || !mocks || Array.isArray(mocks) || typeof mocks !== 'object') throw new Error('Inputs and mocks must be JSON objects.');
      const declarations = [...this.inputNames, ...this.helperNames].map(name => `declare const ${name}: any;`).join('\n');
      monaco.languages.typescript.typescriptDefaults.addExtraLib(`${declarations}\n`, 'inmemory://scratchpad/context.d.ts');
      const response = await fetch('/api/scratchpad/run', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: this.activeRequest.signal, body: JSON.stringify({ file: this.file, code: this.model.getValue(), inputs, mocks }) });
      const data = await response.json() as ScratchResult;
      if (revision !== this.revision) return;
      this.result = data; this.error = data.error ?? null; this.runStatus = data.error ? 'error' : 'completed';
      this.status(data.error ?? '');
      data.values ??= []; data.output ??= [];
      this.capturedValues = data.values;
      this.values.set(data.values.filter(v => v.line <= this.model.getLineCount()).map(v => ({ range: new monaco.Range(v.line, this.model.getLineMaxColumn(v.line), v.line, this.model.getLineMaxColumn(v.line)), options: { after: { content: `  ${v.name} = ${JSON.stringify(v.value)?.slice(0, 90)}`, inlineClassName: 'pkw-inline-value' } } })));
      const latest = [...new Map(data.values.map(v => [v.name, v])).values()];
      const inspector = { expandNode: async (n: ValueNode) => n };
      render(<>{latest.map(v => <ValueTree key={`${revision}:${v.name}`} node={valueNode(v.value)} name={v.name} debug={inspector} initialOpen={v.name === 'result'} />)}{data.output.length ? <section aria-label="Console output">{data.output.map((entry, i) => <div class="pkw-scratch-console-row" key={i}>{(Array.isArray(entry) ? entry : [entry]).map((arg, j) => typeof arg === 'object' && arg !== null ? <ValueTree key={j} node={valueNode(arg)} name="" debug={inspector} /> : <span key={j}><ValueSyntax text={String(arg)} /></span>)}</div>)}</section> : null}</>, this.pane.querySelector('.pkw-scratch-results')!);
    } catch (e) { if (revision === this.revision) { this.error = e instanceof Error ? e.message : String(e); this.runStatus = 'error'; this.status(this.error); } }
  }
}
