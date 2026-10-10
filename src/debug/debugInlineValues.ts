/**
 * Inline values at a Debugger pause: `name = value` at the end of each line of the paused function,
 * the way a recording shows them. A `record: false` session recorded nothing, so the values come
 * from the paused frame: this provider only names the variables on each line, and VS Code looks
 * each one up in the frame through the adapter's `scopes` and `variables`. A name the frame does not
 * hold shows nothing, so naming too many is harmless.
 *
 * A `record: true` session is skipped: the run-all decorator already draws its values.
 */
import * as vscode from 'vscode';
import { DEBUG_TYPE } from './dapAdapter';
import { RUNNABLE_SELECTOR } from '../runtime/language';

const KEYWORDS = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum',
  'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'of',
  'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while', 'with',
  'yield', 'as', 'from', 'get', 'set', 'type', 'interface', 'implements', 'readonly', 'private', 'protected', 'public',
  'console', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Promise', 'Map', 'Set', 'Date', 'Error',
  'string', 'number', 'boolean', 'unknown', 'any', 'never', 'object', 'require', 'module', 'exports',
]);

/** the most lines one pause annotates, so a long module-level script stays readable */
export const MAX_LINES = 200;

export interface NameAt {
  line: number;
  start: number;
  end: number;
  name: string;
}

/** `line` with strings and the comment blanked to spaces, so columns stay where they were. */
function codeOnly(line: string): string {
  return line
    .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, (m) => ' '.repeat(m.length))
    .replace(/\/\*.*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/\/\/.*$/, (m) => ' '.repeat(m.length));
}

/** A JS/TS line that opens a function body: `function f(…) {`, `(a) => {`, a method `name(…) {`. */
const JS_FUNCTION_HEAD = /\bfunction\b|=>\s*\{?\s*$|^\s*(?:(?:public|private|protected|static|async|get|set)\s+)*(?!(?:if|for|while|switch|catch|with)\b)[\w$#]+\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** The head line of the function enclosing `stop`, or a window above `stop` when it is at module level. */
export function enclosingStart(lines: string[], stop: number): number {
  const target = indentOf(lines[stop] ?? '');
  for (let i = stop - 1; i >= 0 && target > 0; i--) {
    const text = lines[i] ?? '';
    if (!text.trim() || indentOf(text) >= target) continue;
    if (JS_FUNCTION_HEAD.test(codeOnly(text))) return i;
    if (indentOf(text) === 0) break; // inside a top-level block, not a function
  }
  return Math.max(0, stop - MAX_LINES + 1);
}

/** The variable names on lines `first`..`last`: identifiers (with `$`) that are not keywords, members (`.x`, `?.x`), object keys (`{ k: v }`) or labels. */
export function namesOnLines(lines: string[], first: number, last: number): NameAt[] {
  const out: NameAt[] = [];
  for (let line = Math.max(0, first); line <= last && line < lines.length; line++) {
    const code = codeOnly(lines[line] ?? '');
    const seen = new Set<string>();
    for (const m of code.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
      const name = m[0];
      const start = m.index ?? 0;
      if (/\d/.test(code[start - 1] ?? '')) continue; // the tail of a number literal, `1e5`
      const before = code.slice(0, start).trimEnd();
      const after = code.slice(start + name.length).trimStart();
      if (KEYWORDS.has(name) || seen.has(name)) continue;
      if (before.endsWith('.') || before.endsWith('#')) continue; // a member
      if (/^\s*(?:async\s+)?function\s*\*?\s*$|^\s*class\s*$/.test(before)) continue; // the name being defined
      if (after.startsWith(':') && /[{,]\s*$/.test(before)) continue; // an object key, `{ k: v }`
      seen.add(name);
      out.push({ line, start, end: start + name.length, name });
    }
  }
  return out;
}

export function registerDebugInlineValues(): vscode.Disposable {
  return vscode.languages.registerInlineValuesProvider(RUNNABLE_SELECTOR, {
    provideInlineValues(document, viewPort, context) {
      const session = vscode.debug.activeDebugSession;
      if (session?.type !== DEBUG_TYPE || session.configuration['record'] === true) return [];
      const lines = Array.from({ length: document.lineCount }, (_, i) => document.lineAt(i).text);
      const stop = context.stoppedLocation.end.line;
      const first = Math.max(enclosingStart(lines, stop), viewPort.start.line);
      const last = Math.min(stop, viewPort.end.line);
      return namesOnLines(lines, first, last).map((n) => new vscode.InlineValueVariableLookup(new vscode.Range(n.line, n.start, n.line, n.end), n.name, true));
    },
  });
}
