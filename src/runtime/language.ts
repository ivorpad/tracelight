/**
 * Which documents a build runs, and with which runtime: Pyokka runs Python files with
 * `pyokka_runtime`, Tracelight runs JavaScript and TypeScript files with the Node runtime in `node/`
 * (it speaks the same protocol). `runtimeLanguage` only classifies a file; `isRunnable` and
 * `RUNNABLE_SELECTOR` are what this build actually runs (`src/brand.ts`).
 * vscode-free so the rules can be unit tested.
 */
import { IS_TRACELIGHT } from '../brand';

export type RuntimeLanguage = 'python' | 'javascript';

export const JS_LANGUAGE_IDS = new Set(['javascript', 'typescript', 'javascriptreact', 'typescriptreact']);
const JS_EXT = /\.(m?js|cjs|m?ts|cts|jsx|tsx)$/i;

/** The language a build runs: Pyokka Python, Tracelight JavaScript and TypeScript. */
export function brandLanguage(tracelight: boolean = IS_TRACELIGHT): RuntimeLanguage {
  return tracelight ? 'javascript' : 'python';
}

/** The document selector of the languages this build runs. */
export const RUNNABLE_SELECTOR = (brandLanguage() === 'javascript' ? [...JS_LANGUAGE_IDS] : ['python']).map((language) => ({ language }));

export interface DocLike {
  languageId: string;
  fileName: string;
}

export function runtimeLanguage(doc: DocLike): RuntimeLanguage | undefined {
  if (doc.languageId === 'python' || doc.fileName.endsWith('.py')) return 'python';
  if (JS_LANGUAGE_IDS.has(doc.languageId) || JS_EXT.test(doc.fileName)) return 'javascript';
  return undefined;
}

/** A file this build runs: a Python file in Pyokka, a JS/TS file in Tracelight. */
export function isRunnable(doc: DocLike, tracelight: boolean = IS_TRACELIGHT): boolean {
  return runtimeLanguage(doc) === brandLanguage(tracelight);
}

/** Tracelight's entry point next to the Python runtime directory (`dist/python` -> `dist/node`, `python` -> `node`). */
export function jsRuntimeEntry(runtimeDir: string, join: (...p: string[]) => string, dirname: (p: string) => string): string {
  return join(dirname(runtimeDir), 'node', 'bin', 'tracelight.mjs');
}

/** The lowest Node release with `module.registerHooks` and default type stripping. */
export const MIN_NODE: [number, number] = [22, 18];

export function nodeVersionOk(v: [number, number, number]): boolean {
  return v[0] > MIN_NODE[0] || (v[0] === MIN_NODE[0] && v[1] >= MIN_NODE[1]);
}

/** The Markdown code-fence language a hover shows `doc`'s values and source in. */
export function fenceLanguage(doc: DocLike | undefined): string {
  if (!doc || runtimeLanguage(doc) !== 'javascript') return 'python';
  return /typescript/.test(doc.languageId) || /\.(m|c)?tsx?$/i.test(doc.fileName) ? 'typescript' : 'javascript';
}

const PYTHON_KEYWORDS = new Set(['and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'print', 'True', 'False', 'None']);
/** JS/TS words a hover never evaluates (`this` is not one: its value is worth showing). */
const JS_KEYWORDS = new Set(['async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'of', 'return', 'static', 'super', 'switch', 'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield', 'interface', 'type', 'implements', 'declare', 'namespace', 'readonly', 'keyof', 'as', 'satisfies', 'console']);

/** A word of `doc`'s language that is syntax, not a value. */
export function isKeyword(doc: DocLike | undefined, word: string): boolean {
  return (doc && runtimeLanguage(doc) === 'javascript' ? JS_KEYWORDS : PYTHON_KEYWORDS).has(word);
}

/** The line-comment marker of `doc`'s language. */
export function lineComment(doc: DocLike | undefined): string {
  return doc && runtimeLanguage(doc) === 'javascript' ? '//' : '#';
}

const EXT_LANGUAGE: [RegExp, string][] = [
  [/\.py$/i, 'python'],
  [/\.tsx$/i, 'typescriptreact'],
  [/\.(m|c)?ts$/i, 'typescript'],
  [/\.jsx$/i, 'javascriptreact'],
  [/\.(m|c)?js$/i, 'javascript'],
];

/**
 * The editor language to open text in when only its name or its content is known (a recent file
 * that is gone, a snippet, a clone): the extension first, then a snippet's `scope`, then a look at
 * the code. Python unless the code reads as JS/TS.
 */
export function languageIdFor(opts: { fileName?: string; scope?: string; content?: string }): string {
  for (const [re, id] of EXT_LANGUAGE) if (opts.fileName && re.test(opts.fileName)) return id;
  const scope = opts.scope?.split(',').map((s) => s.trim()).find((s) => s === 'python' || JS_LANGUAGE_IDS.has(s));
  if (scope) return scope;
  const text = opts.content ?? '';
  if (/^\s*(def |class \w+(\(|:)|from \S+ import |import \w+\s*$|print\()/m.test(text)) return 'python';
  if (/(^|\n)\s*(const |let |var |function |export |import .+ from |interface |type \w+ =)|=>|console\.\w+\(|;\s*$/m.test(text)) {
    return /(:\s*(string|number|boolean|unknown|any)\b|^\s*(interface|type \w+ =)|\bas const\b)/m.test(text) ? 'typescript' : 'javascript';
  }
  return 'python';
}
