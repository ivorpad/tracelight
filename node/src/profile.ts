/**
 * `mode: "profile"`: the runtime's own frames out of the `.cpuprofile`, as Pyokka's `profile.py`
 * drops `pyokka_runtime`'s. A frame of the runtime (`node/src`, its `node_modules`, `node/bin`) is
 * removed and its callees move up to its caller; Node's own frames (`node:fs`, natives) called from
 * the runtime go with it. The samples of removed frames are removed and their time with them, so
 * no user function gains the runtime's time.
 */
import { dirname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

type Frame = { functionName: string; url: string; [k: string]: unknown };
type ProfileNode = { id: number; callFrame: Frame; hitCount?: number; children?: number[]; [k: string]: unknown };
export type CpuProfile = { nodes: ProfileNode[]; startTime: number; endTime: number; samples?: number[]; timeDeltas?: number[] };

const RUNTIME = pathToFileURL(dirname(import.meta.dirname) + sep).href;
const OWN = ['src/', 'node_modules/', 'bin/'].map((d) => RUNTIME + d);

/** a frame of this runtime (`url` as V8 reports it) */
export const isRuntimeUrl = (url: string): boolean => OWN.some((p) => url.startsWith(p));

/** `profile` without the frames `isOwn` names, nor the non-file frames they called; changes it in place and returns it */
export function pruneProfile(profile: CpuProfile, isOwn: (url: string) => boolean = isRuntimeUrl): CpuProfile {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const dropped = new Set<number>();
  // nodes come parent first in V8's list, but walk from the root to be safe
  const root = profile.nodes.find((n) => !parent.has(n.id));
  if (!root) return profile;
  const walk = (id: number, ownCaller: boolean): void => {
    const n = byId.get(id);
    if (!n) return;
    const url = n.callFrame.url ?? '';
    const isFile = url.startsWith('file:');
    const own = isOwn(url) || (!isFile && ownCaller);
    if (own) dropped.add(id);
    const callerOwn = isFile ? own : own || ownCaller;
    for (const c of n.children ?? []) walk(c, callerOwn);
  };
  walk(root.id, false);
  if (!dropped.size) return profile;
  // the nearest kept ancestor of each node
  const keptParent = (id: number): number | undefined => {
    let p = parent.get(id);
    while (p !== undefined && dropped.has(p)) p = parent.get(p);
    return p;
  };
  const children = new Map<number, number[]>();
  for (const n of profile.nodes) {
    if (dropped.has(n.id) || n.id === root.id) continue;
    const p = keptParent(n.id) ?? root.id;
    (children.get(p) ?? children.set(p, []).get(p)!).push(n.id);
  }
  profile.nodes = profile.nodes.filter((n) => !dropped.has(n.id));
  for (const n of profile.nodes) n.children = children.get(n.id) ?? [];
  // a sample's time is the gap to the next one: a removed run of samples hands its first delta to
  // the next kept sample, which drops its own, so the timeline closes over the removed time
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  const keptSamples: number[] = [];
  const keptDeltas: number[] = [];
  let carry: number | null = null;
  for (let i = 0; i < samples.length; i++) {
    if (dropped.has(samples[i]!)) {
      carry ??= deltas[i] ?? 0;
      continue;
    }
    keptSamples.push(samples[i]!);
    keptDeltas.push(carry ?? deltas[i] ?? 0);
    carry = null;
  }
  profile.samples = keptSamples;
  profile.timeDeltas = keptDeltas;
  profile.endTime = profile.startTime + keptDeltas.reduce((a, b) => a + b, 0);
  return profile;
}
