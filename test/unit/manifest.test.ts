import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface LaunchAttribute {
  type?: string;
  default?: unknown;
  enum?: string[];
  description?: string;
  items?: { type: string };
  additionalProperties?: { type: string };
}

interface Manifest {
  activationEvents: string[];
  contributes: {
    commands: { command: string; title: string; icon?: string }[];
    menus: Record<string, { command: string; when?: string; group?: string }[]>;
    keybindings: { command: string; key: string; mac?: string; when?: string }[];
    views: Record<string, { id: string; when?: string }[]>;
    configurationDefaults: Record<string, Record<string, unknown>>;
    grammars: { language?: string; injectTo?: string[]; path: string }[];
    configuration: { properties: Record<string, { type?: string; default?: unknown; enum?: string[]; enumDescriptions?: string[]; description?: string; markdownDescription?: string }> };
    debuggers: {
      type: string;
      configurationAttributes: { launch: { required: string[]; properties: Record<string, LaunchAttribute> } };
      initialConfigurations: Record<string, unknown>[];
      configurationSnippets: { label: string; description?: string; body: Record<string, unknown> }[];
    }[];
  };
}

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as Manifest;
const palette = manifest.contributes.menus.commandPalette ?? [];
const settings = manifest.contributes.configuration.properties;
const commands = manifest.contributes.commands;
const keybindings = manifest.contributes.keybindings;

describe('package.json contributions', () => {
  it('keeps Start on Current File in the command palette without an editor gate', () => {
    // `activeEditor` is unset with focus in the panel or an empty editor area; the command
    // opens a new JavaScript file when there is no editor, so it needs no gate
    const entries = palette.filter((e) => e.command === 'tracelight.startOnCurrentFile');
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(e.when ?? '').toBe('');
  });
  it('lists the Node picker, the start view, the logs and the cache clear unconditionally', () => {
    for (const cmd of ['tracelight.selectNode', 'tracelight.openStartView', 'tracelight.showLogs', 'tracelight.clearLibraryCache']) {
      const e = palette.find((x) => x.command === cmd);
      expect(e, cmd).toBeDefined();
      expect(e?.when ?? '', cmd).not.toBe('false');
    }
  });
  it('offers tracelight.http as an off / record / replay choice that defaults to off', () => {
    const http = settings['tracelight.http'];
    expect(http).toBeDefined();
    expect(http?.type).toBe('string');
    expect(http?.default).toBe('off');
    expect(http?.enum).toEqual(['off', 'record', 'replay']);
    expect(http?.enumDescriptions?.length).toBe(3);
    expect(http?.markdownDescription).toContain('.tracelight/replay/');
  });
  it('offers tracelight.httpObserve as a boolean that defaults to on', () => {
    const observe = settings['tracelight.httpObserve'];
    expect(observe).toBeDefined();
    expect(observe?.type).toBe('boolean');
    expect(observe?.default).toBe(true);
    expect(observe?.markdownDescription ?? observe?.description).toContain('HTTP view');
  });
  it('offers the Execution Diagram settings with the folded defaults', () => {
    expect(settings['tracelight.diagram.build']).toMatchObject({ type: 'string', default: 'onOpen', enum: ['onOpen', 'onRun'] });
    expect(settings['tracelight.diagram.build']?.enumDescriptions?.length).toBe(2);
    expect(settings['tracelight.diagram.detail']).toMatchObject({ type: 'string', default: 'scopes', enum: ['scopes', 'statements'] });
    expect(settings['tracelight.diagram.dataEdges']).toMatchObject({ type: 'boolean', default: false });
    expect(settings['tracelight.diagram.phases']).toMatchObject({ type: 'boolean', default: true });
    expect(settings['tracelight.story.walkthrough']?.default).toBe(false);
    expect(settings['tracelight.story.values']).toMatchObject({ type: 'string', default: 'all', enum: ['all', 'asOf', 'step'] });
  });
  it('mirrors the editor-title Time Machine buttons for the Code Story scheme', () => {
    // Quokka declares them twice, both halves gated on its previous-generation UI flag, which
    // Tracelight maps to false; only the story half is kept, without the gate (design doc T4)
    const title = manifest.contributes.menus['editor/title'] ?? [];
    expect(title.map((e) => e.command)).toEqual([
      'tracelight.playTraceBackwardToSelection',
      'tracelight.playTracePrevStepOut',
      'tracelight.playTracePrevStep',
      'tracelight.playTracePrevStepOver',
      'tracelight.stopTraceNavigation',
      'tracelight.playTraceNextStepOver',
      'tracelight.playTraceNextStep',
      'tracelight.playTraceNextStepOut',
      'tracelight.playTraceForwardToSelection',
      'tracelight.playTraceBackwardToBreakpoint',
      'tracelight.playTraceForwardToBreakpoint',
    ]);
    for (const e of title) {
      expect(e.when ?? '', e.command).toContain('resourceScheme == tracelight-code-timeline');
      expect(e.when ?? '', e.command).toContain('tracelight.traceBeingNavigated');
      expect(e.when ?? '', e.command).not.toContain('false');
      expect(commands.find((c) => c.command === e.command)?.icon, e.command).toMatch(/^\$\(/);
    }
  });
  it('gives the story document the editor defaults a generated document needs', () => {
    const story = manifest.contributes.configurationDefaults['[tracelight-story-js]'] ?? {};
    // every row carries its source line number in the text, so the editor's own gutter is off
    expect(story['editor.lineNumbers']).toBe('off');
    expect(story['editor.glyphMargin']).toBe(false);
    expect(story['editor.folding']).toBe(false);
    expect(story['editor.minimap.enabled']).toBe(false);
    // Quokka's own defaults for the language, kept as they are
    expect(story['editor.unicodeHighlight.nonBasicASCII']).toBe(false);
    expect(story['editor.unicodeHighlight.invisibleCharacters']).toBe(false);
  });
  it('lets F5 fall through to Start Debugging when the active file has a breakpoint', () => {
    // both Tracelight bindings on F5 shadow VS Code's Start Debugging while a session exists on the
    // file; the guard hands the key back so the run can pause at the breakpoint
    const f5 = keybindings.filter((k) => k.key === 'f5');
    expect([...f5.map((k) => k.command)].sort()).toEqual(['tracelight.playTraceForwardToSelection', 'tracelight.reexecute']);
    for (const k of f5) expect(k.when ?? '', k.command).toContain('!tracelight.activeFileHasBreakpoints');
  });
  it('puts only the two debug starts in the panel title: once a session exists the VS Code debug toolbar steps it', () => {
    const title = (manifest.contributes.menus['view/title'] ?? []).filter((e) => e.when?.includes('tracelight.output'));
    expect(title.map((e) => e.command)).toEqual(['tracelight.debugCurrentFile', 'tracelight.debugCurrentFileRecording']);
    const debug = title.find((e) => e.command === 'tracelight.debugCurrentFile');
    expect(debug?.when).toContain('!tracelight.debugActive');
    expect(debug?.group).toBe('navigation@0');
    expect(commands.find((c) => c.command === 'tracelight.debugCurrentFile')?.icon).toBe('$(debug-alt)');
  });
  it('declares every launch attribute of the Tracelight debugger, with no required one', () => {
    const dbg = manifest.contributes.debuggers[0]!;
    expect(dbg.type).toBe('tracelight');
    const launch = dbg.configurationAttributes.launch;
    // `program` defaults to `${file}`, so nothing is required here
    expect(launch.required).toEqual([]);
    const p = launch.properties;
    expect(Object.keys(p).sort()).toEqual(['args', 'breakOnException', 'cwd', 'env', 'libraryCode', 'node', 'program', 'record', 'stopOnEntry']);
    expect(p['program']).toMatchObject({ type: 'string', default: '${file}' });
    expect(p['args']).toMatchObject({ type: 'array', default: [] });
    expect(p['args']!.items).toEqual({ type: 'string' });
    expect(p['cwd']).toMatchObject({ type: 'string', default: '${workspaceFolder}' });
    expect(p['env']).toMatchObject({ type: 'object', default: {} });
    expect(p['env']!.additionalProperties).toEqual({ type: 'string' });
    expect(p['node']).toMatchObject({ type: 'string' });
    expect(p['stopOnEntry']).toMatchObject({ type: 'boolean', default: false });
    expect(p['breakOnException']).toMatchObject({ type: 'string', default: 'uncaught', enum: ['off', 'uncaught', 'raised'] });
    expect(p['libraryCode']).toMatchObject({ type: 'boolean', default: false });
    expect(p['record']).toMatchObject({ type: 'boolean', default: false });
    for (const [name, spec] of Object.entries(p)) expect(spec.description, name).toBeTruthy();
  });

  it('shows the two launch shapes in launch.json and in the snippets', () => {
    const dbg = manifest.contributes.debuggers[0]!;
    expect(dbg.initialConfigurations.map((c) => c.name)).toEqual(['Tracelight: Debug Current File', 'Tracelight: Debug Current File (Recording)']);
    expect(dbg.initialConfigurations[1]).toMatchObject({ program: '${file}', record: true });
    expect(dbg.configurationSnippets.map((s) => s.label)).toEqual(['Tracelight: Debug Current File', 'Tracelight: Debug Current File (Recording)']);
    for (const s of dbg.configurationSnippets) expect(s.body.type).toBe('tracelight');
  });

  it('activates on a URI', () => {
    // assigned, not defaulted: without `onUri` the URI handler would never be registered
    expect(manifest.activationEvents).toContain('onUri');
  });

  it('shows the panel and Show / Focus Output with no session, where the panel offers Start and Debug', () => {
    expect(manifest.contributes.views['tracelight-output']?.[0]?.when).toBeUndefined();
    for (const cmd of ['tracelight.showOutput', 'tracelight.focusOutput']) {
      const entry = palette.find((e) => e.command === cmd);
      expect(entry, cmd).toBeTruthy();
      expect(entry?.when, cmd).toBeUndefined();
    }
  });

  it("offers Why This Value on a row of VS Code's Variables view while the Time Machine replays", () => {
    const menu = (manifest.contributes.menus as Record<string, { command: string; when?: string }[]>)['debug/variables/context'] ?? [];
    expect(menu.map((e) => e.command)).toEqual(['tracelight.whyVariable']);
    expect(menu[0]?.when).toBe('debugType == tracelight && tracelight.traceBeingNavigated');
    expect(commands.find((c) => c.command === 'tracelight.whyVariable')?.title).toBe('Why This Value');
  });

  it('keeps the backward keys in the replay debug session, and gives F10, F11 and Shift+F11 to VS Code there', () => {
    const when = (command: string) => keybindings.find((k) => k.command === command)?.when ?? '';
    for (const c of ['tracelight.playTracePrevStep', 'tracelight.playTracePrevStepOver', 'tracelight.playTracePrevStepOut', 'tracelight.playTraceBackwardToSelection', 'tracelight.playTraceBackwardToBreakpoint', 'tracelight.playTraceForwardToBreakpoint']) {
      expect(when(c), c).toContain('(!inDebugMode || debugType == tracelight)');
    }
    for (const c of ['tracelight.playTraceNextStep', 'tracelight.playTraceNextStepOver', 'tracelight.playTraceNextStepOut']) {
      expect(when(c), c).toContain('!inDebugMode');
      expect(when(c), c).not.toContain('debugType == tracelight');
    }
  });

  it('keeps the debugger commands in the palette for a keyboard or an agent', () => {
    for (const command of ['tracelight.debugStepOver', 'tracelight.debugStepInto', 'tracelight.debugStepOut', 'tracelight.debugRestart']) {
      expect(palette.find((e) => e.command === command)?.when, command).toBe('tracelight.debugActive');
    }
  });

  it('offers the recording start next to Debug in the panel and in the palette with no gate', () => {
    const title = (manifest.contributes.menus['view/title'] ?? []).filter((e) => e.when?.includes('tracelight.output'));
    const entry = title.find((e) => e.command === 'tracelight.debugCurrentFileRecording');
    // right next to Debug; both are gated on !debugActive, so it never shows at the same time as Stop
    expect(entry?.group).toBe('navigation@1');
    expect(entry?.when).toBe('view =~ /tracelight.output/ && !tracelight.debugActive');
    expect(commands.find((c) => c.command === 'tracelight.debugCurrentFileRecording')?.title).toBe('Debug Current File (Recording)');
    expect(commands.find((c) => c.command === 'tracelight.debugCurrentFileRecording')?.icon).toBe('$(debug-alt-small)');
    // like Debug Current File: always offered, because it starts a session of its own
    const inPalette = palette.find((e) => e.command === 'tracelight.debugCurrentFileRecording');
    expect(inPalette).toBeTruthy();
    expect(inPalette?.when).toBeUndefined();
  });

  it('lists Show HTTP Requests and Open HTTP Recording, in the palette while a session is active', () => {
    for (const [cmd, title] of [['tracelight.showHttp', 'Show HTTP Requests'], ['tracelight.openHttpRecording', 'Open HTTP Recording']] as const) {
      expect(commands.find((c) => c.command === cmd)?.title, cmd).toBe(title);
      expect(palette.find((e) => e.command === cmd)?.when, cmd).toBe('tracelight.hasActiveSession');
    }
  });
});

describe('JavaScript and TypeScript only', () => {
  const JS = ['javascript', 'typescript', 'javascriptreact', 'typescriptreact'];
  const tl = manifest as unknown as Manifest & { name: string; displayName: string; contributes: Manifest['contributes'] & { snippets: { language: string; path: string }[]; breakpoints: { language: string }[]; debuggers: { languages: string[] }[] } };
  const c = tl.contributes;
  it('is its own extension: every id is tracelight, and Pyokka is named nowhere', () => {
    expect(tl.name).toBe('tracelight');
    expect(tl.displayName).toBe('Tracelight');
    expect(JSON.stringify(tl)).not.toMatch(/pyokka/i);
    for (const x of c.commands) expect(x.command).toMatch(/^tracelight\./);
    for (const k of Object.keys(c.configuration.properties)) expect(k).toMatch(/^tracelight\./);
    expect(c.debuggers[0]!.type).toBe('tracelight');
    expect(Object.keys(c.views)).toEqual(['tracelight-output']);
  });
  it('activates on JS/TS files and on a URI, never on Python', () => {
    expect(tl.activationEvents).toEqual([...JS.map((l) => `onLanguage:${l}`), 'onStartupFinished', 'onUri']);
    expect(JSON.stringify(tl)).not.toMatch(/python/i);
  });
  it('shows the Start button and the Code Story commands in JS/TS editors', () => {
    const start = c.menus['editor/title/run']!.find((e) => e.command === 'tracelight.startOnCurrentFile');
    for (const lang of JS) expect(start?.when).toContain(`editorLangId == ${lang}`);
    const story = (c.menus.commandPalette ?? []).find((e) => e.command === 'tracelight.viewCodeStory');
    expect(story?.when).toContain('editorLangId == tracelight-story-js');
  });
  it('binds its editor keys in JS/TS editors only, so they never clash with another extension\'s', () => {
    for (const k of c.keybindings) {
      if (k.when?.includes('isActiveEditorRunningTracelight') || k.when?.includes('tracelight.traceBeingNavigated')) continue;
      for (const lang of JS) expect(k.when, `${k.key} ${k.command}`).toContain(`editorLangId == ${lang}`);
    }
  });
  it('offers the debugger, breakpoints, snippets and the snap-output grammar for JS/TS', () => {
    expect(c.debuggers[0]!.languages).toEqual(JS);
    expect(Object.keys(c.debuggers[0]!.configurationAttributes.launch.properties).sort()).toEqual(['args', 'breakOnException', 'cwd', 'env', 'libraryCode', 'node', 'program', 'record', 'stopOnEntry']);
    expect(c.breakpoints.map((b) => b.language)).toEqual(JS);
    for (const lang of JS) expect(c.snippets.find((s) => s.language === lang)?.path).toBe('./snippets/tracelight.code-snippets');
    expect(c.grammars.find((g) => g.injectTo?.includes('source.ts'))?.path).toBe('./syntaxes/tracelight-snap-js.tmLanguage.json');
    for (const g of c.grammars) expect(fs.existsSync(path.join(__dirname, '..', '..', g.path)), g.path).toBe(true);
  });
  it('colours the story as TypeScript, with the story editor defaults', () => {
    const grammar = c.grammars.find((g) => g.language === 'tracelight-story-js');
    expect(grammar?.path).toBe('./syntaxes/tracelight-story-js.tmLanguage.json');
    expect(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'syntaxes', 'tracelight-story-js.tmLanguage.json'), 'utf8')).repository.block.patterns).toEqual([{ include: 'source.tsx' }]);
    expect(c.configurationDefaults['[tracelight-story-js]']).toBeDefined();
  });
  it('has New JavaScript/TypeScript File and the Node picker', () => {
    for (const cmd of ['tracelight.newJavaScriptFile', 'tracelight.newTypeScriptFile', 'tracelight.selectNode']) expect(c.commands.find((x) => x.command === cmd), cmd).toBeDefined();
    expect(c.menus['file/newFile']!.map((e) => e.command)).toEqual(['tracelight.newJavaScriptFile', 'tracelight.newTypeScriptFile', 'tracelight.newRecentOrSnippet']);
    expect(c.configuration.properties['tracelight.nodePath']).toBeDefined();
  });
  it('registers every command it contributes', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'extension.ts'), 'utf8');
    const registered = new Set([...src.matchAll(/reg\('([\w.]+)'/g)].map((m) => m[1]));
    const others = fs.readdirSync(path.join(__dirname, '..', '..', 'src'), { recursive: true }).filter((f) => String(f).endsWith('.ts')).map((f) => fs.readFileSync(path.join(__dirname, '..', '..', 'src', String(f)), 'utf8')).join('\n');
    for (const x of c.commands) expect(registered.has(x.command) || others.includes(`'${x.command}'`), x.command).toBe(true);
  });
});
