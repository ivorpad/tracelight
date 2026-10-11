/** Pure snap-fence discovery, shared by the Snaps feature and unit tests. */
export interface SnapFence {
  /** 0-based lines; equal for a one-line JS fence, `/*{{ code }}*\/` */
  openLine: number;
  closeLine: number;
}

/** Which fence syntax a file uses: Python's `"""{{ … }}"""`, or JS/TS's block comment `/*{{ … }}*\/`. */
export type SnapSyntax = 'python' | 'javascript';

const OPEN_RE = /^\s*(?:[rRbBuUfF]{0,2})"""\{\{\s*$/;
const CLOSE_RE = /^\s*\}\}"""\s*$/;
const JS_OPEN_RE = /^\s*\/\*\{\{\s*$/;
const JS_CLOSE_RE = /^\s*\}\}\*\/\s*$/;
/** the runtime runs any block comment whose text is `{{ … }}` (node/src/instrument.ts `blankFences`) */
const JS_ONE_LINE_RE = /^\s*\/\*\s*\{\{.*\}\}\s*\*\/\s*$/;
export const OUTPUT_PREFIX = '#» ';
export const JS_OUTPUT_PREFIX = '//» ';

export function outputPrefix(syntax: SnapSyntax = 'python'): string {
  return syntax === 'javascript' ? JS_OUTPUT_PREFIX : OUTPUT_PREFIX;
}

export function findSnaps(text: string, syntax: SnapSyntax = 'python'): SnapFence[] {
  const js = syntax === 'javascript';
  const openRe = js ? JS_OPEN_RE : OPEN_RE;
  const closeRe = js ? JS_CLOSE_RE : CLOSE_RE;
  const lines = text.split(/\r?\n/);
  const out: SnapFence[] = [];
  let open = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (open < 0 && js && JS_ONE_LINE_RE.test(l)) out.push({ openLine: i, closeLine: i });
    else if (open < 0 && openRe.test(l)) open = i;
    else if (open >= 0 && closeRe.test(l)) {
      out.push({ openLine: open, closeLine: i });
      open = -1;
    }
  }
  return out;
}

export function fenceAt(fences: SnapFence[], line: number): SnapFence | undefined {
  return fences.find((f) => line >= f.openLine && line <= f.closeLine);
}

/** Is a statement starting on `line` (0-based) the fence's code? A one-line fence's code shares its line. */
export function insideFence(fence: SnapFence, line: number): boolean {
  if (fence.openLine === fence.closeLine) return line === fence.openLine;
  return line > fence.openLine && line < fence.closeLine;
}
