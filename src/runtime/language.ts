/**
 * Which documents Tracelight runs: JavaScript and TypeScript files, with the Node runtime in
 * `node/` (`dist/node` in a build). vscode-free so the rules can be unit tested.
 */

export type RuntimeLanguage = 'javascript';

export const JS_LANGUAGE_IDS = new Set(['javascript', 'typescript', 'javascriptreact', 'typescriptreact']);
const JS_EXT = /\.(m?js|cjs|m?ts|cts|jsx|tsx)$/i;

/** The document selector of the languages Tracelight runs. */
export const RUNNABLE_SELECTOR = [...JS_LANGUAGE_IDS].map((language) => ({ language }));

export interface DocLike {
  languageId: string;
  fileName: string;
}

export function runtimeLanguage(doc: DocLike): RuntimeLanguage | undefined {
  if (JS_LANGUAGE_IDS.has(doc.languageId) || JS_EXT.test(doc.fileName)) return 'javascript';
  return undefined;
}

/** A file Tracelight runs: JavaScript or TypeScript. */
export function isRunnable(doc: DocLike): boolean {
  return runtimeLanguage(doc) === 'javascript';
}

/** The Node runtime's entry point in a runtime directory (`dist/node`, or the checkout's `node/`). */
export function jsRuntimeEntry(runtimeDir: string, join: (...p: string[]) => string): string {
  return join(runtimeDir, 'bin', 'tracelight.mjs');
}

/** The lowest Node release with `module.registerHooks` and default type stripping. */
export const MIN_NODE: [number, number] = [22, 18];

export function nodeVersionOk(v: [number, number, number]): boolean {
  return v[0] > MIN_NODE[0] || (v[0] === MIN_NODE[0] && v[1] >= MIN_NODE[1]);
}

/** The Markdown code-fence language a hover shows `doc`'s values and source in. */
export function fenceLanguage(doc: DocLike | undefined): string {
  return doc && (/typescript/.test(doc.languageId) || /\.(m|c)?tsx?$/i.test(doc.fileName)) ? 'typescript' : 'javascript';
}

/** JS/TS words a hover never evaluates (`this` is not one: its value is worth showing). */
const JS_KEYWORDS = new Set(['async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'of', 'return', 'static', 'super', 'switch', 'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield', 'interface', 'type', 'implements', 'declare', 'namespace', 'readonly', 'keyof', 'as', 'satisfies', 'console']);

/** A word that is syntax, not a value. */
export function isKeyword(_doc: DocLike | undefined, word: string): boolean {
  return JS_KEYWORDS.has(word);
}

/** The line-comment marker. */
export function lineComment(_doc: DocLike | undefined): string {
  return '//';
}

const EXT_LANGUAGE: [RegExp, string][] = [
  [/\.tsx$/i, 'typescriptreact'],
  [/\.(m|c)?ts$/i, 'typescript'],
  [/\.jsx$/i, 'javascriptreact'],
  [/\.(m|c)?js$/i, 'javascript'],
];

/**
 * The editor language to open text in when only its name or its content is known (a recent file
 * that is gone, a snippet, a clone): the extension first, then a snippet's `scope`, then a look at
 * the code. JavaScript unless the code reads as TypeScript.
 */
export function languageIdFor(opts: { fileName?: string; scope?: string; content?: string }): string {
  for (const [re, id] of EXT_LANGUAGE) if (opts.fileName && re.test(opts.fileName)) return id;
  const scope = opts.scope?.split(',').map((s) => s.trim()).find((s) => JS_LANGUAGE_IDS.has(s));
  if (scope) return scope;
  const text = opts.content ?? '';
  return /(:\s*(string|number|boolean|unknown|any)\b|^\s*(interface|type \w+ =)|\bas const\b)/m.test(text) ? 'typescript' : 'javascript';
}
