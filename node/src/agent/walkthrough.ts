/**
 * The walkthrough: what happened, in order, one moment per line (docs/PROTOCOL.md, "Walkthrough").
 *
 * Deterministic and instant: every moment comes from the recording (scope entries, decisions,
 * loops, logged values, prints, errors) with a templated sentence (`moments.ts`); a model only
 * ever adds `gloss` (`narrate.ts`). A library is a file under `node_modules` (a Python run's
 * `site-packages` too), its package the npm name (`@scope/name`).
 */
import { basename, dirname, resolve, sep } from 'node:path';
import { cutLine } from './recording.ts';
import type { SavedRun } from './source.ts';
import { MomentBuilder } from './moments.ts';

type Msg = Record<string, any>;

export const CAP = 400;
export const PRINT_MAX = 120;
export const VALUE_MAX = 200;
export const INLINE_MAX = 60;
const LIBRARY_MARKERS = ['node_modules', 'site-packages', 'dist-packages'];
const MODULE_EXT = /\.(?:[cm]?[jt]sx?|py)$/;

// -- files ------------------------------------------------------------------------------------------------------

/** the main file and files under the workspace that are not an installed package */
export function isUserFile(path: string | null | undefined, workspaceRoot: string, mainFile: string | null | undefined): boolean {
  if (!path) return false;
  if (mainFile && resolve(path) === resolve(mainFile)) return true;
  if (path.split(sep).some((p) => LIBRARY_MARKERS.includes(p))) return false;
  const root = workspaceRoot.replace(/[\\/]+$/, '') + sep;
  return !!workspaceRoot && path.startsWith(root);
}

/** `openai` for `.../node_modules/openai/index.js`, `@scope/pkg` for a scoped one; null for user files */
export function packageOf(path: string | null | undefined): string | null {
  if (!path) return null;
  let best: string | null = null;
  let at = -1;
  for (const marker of LIBRARY_MARKERS) {
    const i = path.lastIndexOf(marker + sep);
    if (i > at) {
      at = i;
      const rest = path.slice(i + marker.length + 1).split(sep);
      const top = rest[0]!;
      best = top.startsWith('@') && rest.length > 1 ? `${top}/${rest[1]}` : top.replace(MODULE_EXT, '');
    }
  }
  return best;
}

/**
 * The package a library file belongs to: `packageOf`, else (a file outside `node_modules`) the
 * directory of an `index.*` or the module's stem.
 */
export function libraryPackage(path: string | null | undefined): string | null {
  const pkg = packageOf(path);
  if (pkg || !path) return pkg;
  const base = basename(path);
  if (/^(?:index|__init__)\.[^.]+$/.test(base)) return basename(dirname(path));
  return base.replace(MODULE_EXT, '');
}

/** `70 ms` / `3.7 s`; rounding is half-up on both sides */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '?';
  if (ms < 1000) return `${Math.floor(ms + 0.5)} ms`;
  return `${(Math.floor(ms / 100 + 0.5) / 10).toFixed(1)} s`;
}

/** Python's `" ".join(s.split())`: every run of whitespace one space, none at the ends */
export function squash(text: unknown): string {
  return String(text ?? '')
    .split(/[\s\x1c-\x1f\x85]+/)
    .filter(Boolean)
    .join(' ');
}

export function cut(text: unknown, limit: number): string {
  return cutLine(squash(text), limit);
}

// -- windows and the cap ---------------------------------------------------------------------------------------

function collapse(moments: Msg[], kind: string, keyOf: (m: Msg) => string | null): Msg[] {
  const firsts = new Map<string, Msg>();
  const out: Msg[] = [];
  for (const m of moments) {
    if (m.kind !== kind) {
      out.push(m);
      continue;
    }
    const key = keyOf(m);
    if (key === null) {
      out.push(m);
      continue;
    }
    const first = firsts.get(key);
    if (first) {
      first.more = Number(first.more ?? 0) + 1;
      continue;
    }
    firsts.set(key, m);
    out.push(m);
  }
  return out;
}

/** drop moments that happened inside a collapsed call (its step range) */
function dropInside(moments: Msg[], removed: Msg[]): Msg[] {
  const ranges = removed.filter((m) => m.entryStep !== null && m.entryStep !== undefined).map((m) => [Number(m.entryStep), Number(m.endStep)] as const);
  if (!ranges.length) return moments;
  const gone = new Set(removed);
  return moments.filter((m) => !ranges.some(([a, b]) => a <= Number(m.step) && Number(m.step) <= b) || gone.has(m));
}

export interface WalkthroughOptions {
  file?: string | null;
  scope?: string | null;
  start?: number | null;
  end?: number | null;
  allScopes?: boolean;
  cap?: number;
  gloss?: Msg | null;
}

export function walkthrough(run: SavedRun, opts: WalkthroughOptions = {}): Msg {
  const { file = null, scope = null, start = null, end = null, allScopes = false, cap = CAP } = opts;
  const builder = new MomentBuilder(run, allScopes);
  let moments = builder.build();
  const total = moments.length;
  const glosses = opts.gloss ?? run.meta.walkthroughGloss ?? {};
  for (const m of moments) {
    const g = glosses && typeof glosses === 'object' && !Array.isArray(glosses) ? glosses[m.id] : null;
    m.gloss = typeof g === 'string' && g ? g : null;
  }
  const windowed = file !== null || scope !== null || start !== null || end !== null;
  if (file !== null) {
    const fid = Number(run.resolveFile(file).fileId);
    moments = moments.filter((m) => m.location.fileId === fid);
  }
  if (scope !== null) {
    const ranges = run.trace.scopes.filter((s) => String(s.name) === scope || builder.scopeQualname(Number(s.scopeId)).endsWith(scope)).map((s) => [Number(s.first), Number(s.last)] as const);
    moments = moments.filter((m) => ranges.some(([a, b]) => a <= Number(m.step) && Number(m.step) <= b) || ((m.kind === 'call' || m.kind === 'tool') && String(m.callee?.function ?? '').endsWith(scope)));
  }
  if (start !== null) moments = moments.filter((m) => Number(m.step) >= start);
  if (end !== null) moments = moments.filter((m) => Number(m.step) <= end);
  let capped = false;
  let truncated = false;
  if (!windowed && moments.length > cap) {
    capped = true;
    const before = moments;
    moments = collapse(moments, 'call', (m) => (m.key ? String(m.key) : null));
    const kept = new Set(moments);
    moments = dropInside(
      moments,
      before.filter((m) => !kept.has(m)),
    );
    if (moments.length > cap) moments = collapse(moments, 'value', (m) => JSON.stringify([m.location.fileId ?? null, m.location.line ?? null, String(m.text).split(' = ')[0]]));
    if (moments.length > cap) {
      moments = moments.slice(0, cap);
      truncated = true;
    }
  }
  for (const m of moments) delete m.key;
  return {
    count: run.trace.count,
    total,
    shown: moments.length,
    capped,
    truncated,
    file: run.meta.file ?? null,
    exitCode: run.meta.exitCode ?? null,
    stale: run.staleFiles().length > 0,
    staleFiles: run.staleFiles(),
    moments,
  };
}
