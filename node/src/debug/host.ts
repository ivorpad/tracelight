/**
 * The run child as the debugger sees it (`DebugHost` over child.ts's `RunChild` and its
 * `Tracer`). A recording run puts the debugger in its recording mode: `step` is the trace index
 * and the stack and the step rules follow the scope chain. A `record: false` run (and a
 * `recordFrom` run until its recording starts) puts it in the other: the statement counter, the
 * frame chain, per-call ids.
 */
import type { DebugFile } from './breakpoints.ts';
import type { DebugHost, ScopeEntry } from './debugger.ts';
import { describeFallback, expressionName, type Described } from './describe.ts';
import { cutText, LOCALS_CHARS, shortText } from '../serialize.ts';
import { MASK, secrets } from '../secrets.ts';
import type { Tracer } from '../tracer.ts';
import type { InstrumentedFile } from '../instrument.ts';

export function debugFile(info: InstrumentedFile): DebugFile {
  return { fileId: info.fileId, path: info.filename, rangeBase: info.rangeBase, ranges: info.ranges, lineRids: info.lineRids, functionNames: info.functionNames };
}

export interface ChildLike {
  tracer: Tracer;
  emit(event: Record<string, unknown>): void;
  serve(msg: Record<string, any>): void;
  /** false while a debug run records nothing (record: false, or recordFrom before its pause) */
  recording?: boolean;
  /** the step code runs at now: the trace index, or the statement counter */
  stepNow?(): number;
  /** worker_threads recording (threads/hub.ts) */
  hub?: { pause(): void } | null;
  /** recordFrom: start recording at this pause */
  startRecording?(rid: number, scope: number): { scope: number; step: number };
}

export function childDebugHost(child: ChildLike): DebugHost {
  const t = () => child.tracer;
  return {
    get record() {
      return child.recording !== false;
    },
    startRecording: child.startRecording ? (rid, scope) => child.startRecording!(rid, scope) : undefined,
    emit: (e) => child.emit(e),
    files: () => t().files.map(debugFile),
    flush: () => {
      const tr = t();
      // worker threads: what they ran so far is merged first, so the trace reaches this pause
      child.hub?.pause();
      tr.flushTrace();
      if (tr.timesDirty) tr.emitTimes();
    },
    scopeChain: (scope: number): ScopeEntry[] => {
      const scopes = t().scopes;
      const out: ScopeEntry[] = [];
      for (let s = scope; s >= 0 && s < scopes.length && out.length < 10_000; s = scopes[s]!.parent) {
        const sc = scopes[s]!;
        out.push({ scopeId: sc.scopeId, name: sc.name, rid: sc.rid, depth: sc.depth });
      }
      return out;
    },
    describe: (value: unknown, name: string, key: string): Described => {
      const tr = t();
      tr.quiet++;
      try {
        const secret = (typeof value === 'string' || value instanceof Uint8Array) && secrets.isSecretName(expressionName(name));
        const text = secret ? MASK : secrets.scrub(cutText(shortText(value, 1_000_000), tr.valueChars(LOCALS_CHARS)).text);
        return { text, valueBag: tr.bag(value, key, 1, 'value', name) };
      } catch {
        return describeFallback(value, name, key);
      } finally {
        tr.quiet--;
      }
    },
    handleRequest: (req) => child.serve(req),
    currentStep: () => (child.stepNow ? child.stepNow() : t().curStep),
  };
}
