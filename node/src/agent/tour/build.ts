/**
 * `tour`: chapters and candidate stops of a recorded run, every value from the recording, as
 * Pyokka's `agent/tour/build.py`.
 *
 * `buildTour(run, {goal, budget})` returns `tour.json` (docs/TOUR.md). A run whose walkthrough has
 * under `SMALL_MOMENTS` moments is one chapter whose candidates are the walkthrough's moments; a
 * larger run is split into chapters (`chapters.ts`) and gets the signals' candidates
 * (`signals.ts`), kept by novelty and score under the budget (`rank.ts`), their values shaped
 * (`values.ts`).
 */
import { createHash } from 'node:crypto';
import { NAME } from '../../protocol.ts';
import { History } from '../history.ts';
import { AgentError, type SavedRun } from '../source.ts';
import { walkthrough } from '../walkthrough.ts';
import { bindsCall } from './astinfo.ts';
import { chapters, spine as spineFrame } from './chapters.ts';
import { TourRun } from './model.ts';
import { cut, flat, jsonLength } from './py.ts';
import * as rank from './rank.ts';
import * as sig from './signals.ts';
import { MAX_VALUES, gather, shape, tokens } from './values.ts';

type Msg = Record<string, any>;

export const VERSION = 1;
export const SMALL_MOMENTS = 60;
export const DEFAULT_BUDGET = 40_000;
export const STATEMENT_MAX = 240;

/** six hex characters of `file:line` and the statement's text: the same statement hashes the same in a re-recorded run */
export function stableKey(t: TourRun, i: number): string {
  const raw = `${t.display(i)}:${t.line[i]}\n${flat(t.text(i))}`;
  return createHash('sha1').update(raw, 'utf8').digest('hex').slice(0, 6);
}

/** `{kind, step, seeds, text, name?}`: where the spine starts and the text evidence is matched against */
export function resolveGoal(t: TourRun, goal: string | null): Msg {
  const run = t.run;
  if (goal) {
    const at = goal.lastIndexOf(':');
    if (at >= 0 && /^\d+$/.test(goal.slice(at + 1))) {
      const fname = goal.slice(0, at);
      const line = parseInt(goal.slice(at + 1), 10);
      const fid = Number(run.resolveFile(fname).fileId);
      const steps: number[] = [];
      for (let i = 0; i < t.n; i++) if (t.fid[i] === fid && t.line[i] === line) steps.push(i);
      if (!steps.length) throw new AgentError(`no step on ${goal}`, `\`${NAME} story RUN --file ${fname}\` lists the lines that ran`);
      const st = steps[steps.length - 1]!;
      const text = gather(t, st)
        .map((v) => v.text)
        .join(' ');
      return { kind: 'line', step: st, seeds: [st], text, line: goal };
    }
    const rows = new History(run).rows(goal).filter((r) => r.text !== null && r.text !== undefined);
    if (!rows.length) throw new AgentError(`no recorded value of ${goal}`, `\`${NAME} var RUN ${goal}\` lists its changes; give a FILE:LINE instead`);
    const row = rows[rows.length - 1]!;
    return { kind: 'name', name: goal, step: Number(row.step), seeds: [Number(row.step)], text: String(row.text) };
  }
  if (t.n === 0) return { kind: 'none', step: null, seeds: [], text: '' };
  const [scope] = spineFrame(t, 0, t.n - 1);
  const prints = t.prints().sort((a, b) => Number(a.step) - Number(b.step));
  const top = prints.filter((ev) => [scope, t.rootScope].includes(t.scope[Number(ev.step)]!));
  const chosen = top.length ? top : prints;
  if (!chosen.length) return { kind: 'end', step: t.n - 1, seeds: [t.n - 1], text: '' };
  const goalEv = chosen[chosen.length - 1]!;
  const goalStep = Number(goalEv.step);
  const firstPass = new Map<string, number>();
  for (const ev of chosen.slice(0, -1)) {
    // the first pass of every other output line of that frame, latest line first
    const st = Number(ev.step);
    const key = `${t.fid[st]}:${t.line[st]}`;
    if (key !== `${t.fid[goalStep]}:${t.line[goalStep]}` && !firstPass.has(key) && !literalPrint(t, st, String(ev.text || ''))) firstPass.set(key, st);
  }
  const seeds = [goalStep, ...[...firstPass.values()].sort((a, b) => b - a)];
  return { kind: 'output', step: goalStep, seeds, text: String(goalEv.text || '') };
}

/** a print whose output is written out in its own statement (a banner, a separator): nothing to explain */
function literalPrint(t: TourRun, step: number, text: string): boolean {
  const f = flat(text);
  return !f.replace(/^[=\-_*#~ ]+|[=\-_*#~ ]+$/g, '') || flat(t.text(step)).includes(f);
}

/** `[{signal: "io:http", reason}]`, one per signal that proposed the step */
function signalList(c: sig.Pooled): Msg[] {
  return [...c.subs].sort().map((s) => ({ signal: s, reason: cut(c.reasons.get(s) ?? '', 100) }));
}

function candidate(t: TourRun, c: sig.Pooled, chapter: string): Msg {
  const i = c.step;
  const key = stableKey(t, i);
  const out: Msg = {
    id: `s${i}-${key}`,
    key,
    step: i,
    chapter,
    file: t.display(i),
    line: t.line[i],
    function: t.function(i),
    scopeId: t.scope[i],
    signals: signalList(c),
    statement: cut(t.text(i), STATEMENT_MAX),
    score: c.score ?? 0,
    _values: mergeValues(
      gather(t, i),
      c.valuesFrom.flatMap((s) => gather(t, s)),
    ),
  };
  if (c.setup) out.setup = true;
  if (c.repeat) out.repeat = true;
  return out;
}

function mergeValues(own: Msg[], extra: Msg[]): Msg[] {
  const key = (v: Msg) => JSON.stringify([v.role, v.name, v.text]);
  const seen = new Set(own.map(key));
  const out = [...own];
  for (const v of extra) {
    if (!seen.has(key(v)) && ['set', 'returned', 'call', 'raised', 'value'].includes(v.role)) {
      seen.add(key(v));
      out.push(v);
    }
  }
  return out.slice(0, MAX_VALUES);
}

function chapterOf(chs: Msg[], step: number): string {
  for (const c of chs) if (c.steps[0] <= step && step <= c.steps[1]) return c.id;
  return chs.length ? chs[chs.length - 1]!.id : 'c1';
}

export interface TourOptions {
  goal?: string | null;
  budget?: number;
  /** filled with every kept value's whole recorded text by value id (the prose validator reads it) */
  full?: Record<string, string> | null;
}

/** `tour.json` */
export function buildTour(run: SavedRun, opts: TourOptions = {}): Msg {
  const goal = opts.goal ?? null;
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const started = performance.now();
  const t = new TourRun(run);
  const g = resolveGoal(t, goal);
  const pool = new sig.Pool(t);
  // the walkthrough merges library calls, so it never has more moments than the unrolled list in
  // TourRun; build it only when it can come out under the threshold
  const small = goal === null && t.moments.length < SMALL_MOMENTS * 10 ? walkthrough(run) : null;
  const isSmall = small !== null && small.total < SMALL_MOMENTS;
  sig.io(t, pool);
  sig.exceptions(t, pool);
  sig.crossings(t, pool);
  const spineInfo = g.seeds.length ? sig.spine(t, pool, g.seeds) : { whyCalls: 0 };
  if (g.step !== null && g.step !== undefined) pool.add(Number(g.step), 'spine', 'goal', `the goal: ${g.kind === 'output' ? "the program's output" : g.name || g.line || 'the last step'}`);
  let chs: Msg[];
  let pooled: Map<number, sig.Pooled>;
  if (isSmall && small !== null) {
    chs = [{ start: 0, end: Math.max(0, t.n - 1), title: t.n ? t.function(0) : '<module>', opens: [], kind: 'walkthrough' }];
    for (const m of small.moments) {
      let st = Number(m.step);
      if ((m.kind === 'call' || m.kind === 'tool') && m.entryStep !== null && m.entryStep !== undefined && Number(m.entryStep) - st > 3) st = Number(m.entryStep);
      pool.add(st, 'walkthrough', m.kind, m.text);
    }
    pooled = new Map([...pool.byStep].filter(([, c]) => [...c.subs].some((s) => s.startsWith('walkthrough:'))));
  } else {
    chs = chapters(t);
    sig.narrative(t, pool);
    sig.proseIn(t, pool);
    sig.evidence(t, pool, g.text);
    for (const c of chs) {
      const st = c.start;
      pool.add(st, 'chapter', 'start', `chapter opened by ${c.title}`);
      const nxt = t.nextInScope(st);
      if (bindsCall(t.stmt(st)) && nxt !== null && nxt <= c.end + 1) pool.add(nxt, 'chapter', 'result', `what ${c.title} produced lands`, [st]);
    }
    pooled = new Map(pool.byStep);
  }
  const chaptersOut: Msg[] = chs.map((c, k) => {
    const a = c.start;
    const b = c.end;
    const reqs = t.http.filter((r) => a <= Number(r.step) && Number(r.step) <= b);
    return { id: `c${k + 1}`, title: c.title, opens: c.opens?.length ? c.opens : [c.title], kind: c.kind, steps: [a, b], share: Math.round(((b - a + 1) / Math.max(1, t.n)) * 1e4) / 1e4, http: reqs.length, llm: reqs.filter((r) => r.llm).length };
  });
  const kept: Msg[] = [];
  for (const c of rank.novel(t, pooled)) {
    const i = c.step;
    const fid = t.fid[i]!;
    if (!isSmall) {
      if (fid < 0 || (!t.user(fid) && !c.subs.has('io:http'))) continue;
      if (t.function(i) === '<module>' && fid !== t.mainFid) continue; // import time of a module other than the script
    }
    c.setup = rank.isSetup(t, i) && !c.subs.has('spine:goal');
    c.score = rank.score(t, c);
    const cand = candidate(t, c, chapterOf(chaptersOut, i));
    if (!cand._values.length && [...c.subs].every((s) => s === 'spine:why')) continue; // a statement on the way to the goal that recorded nothing (a loop header, a bare print)
    kept.push(cand);
  }
  const goalWords = tokens(g.text);
  const totalCandidates = kept.length;
  const rawValues = new Map<Msg, Msg[]>(kept.map((c) => [c, c._values]));
  const goalOut: Msg = {};
  for (const [k, v] of Object.entries(g)) if (k !== 'seeds') goalOut[k] = v;
  goalOut.text = cut(g.text, 400);
  const doc: Msg = {
    tour: VERSION,
    run: summary(t),
    goal: goalOut,
    small: isSmall,
    budget: { tokens: budget },
    chapters: chaptersOut,
    candidates: [],
  };
  const fixed = jsonLength(doc, false);
  let selected = kept;
  for (let round = 0; round < 4; round++) {
    for (const c of selected) c._values = rawValues.get(c);
    shape(selected, goalWords);
    const sizes = new Map<Msg, number>(selected.map((c) => [c, jsonLength(c, true) + 2]));
    if ([...sizes.values()].reduce((s, x) => s + x, 0) + fixed <= budget * rank.CHARS_PER_TOKEN) break;
    selected = rank.fit(selected, (c) => sizes.get(c)!, budget, fixed);
  }
  selected.sort((a, b) => a.step - b.step);
  if (opts.full) {
    for (const c of selected) rawValues.get(c)!.forEach((v, k) => (opts.full![`${c.id}.v${k + 1}`] = v.text));
  }
  for (const ch of chaptersOut) ch.candidates = selected.filter((c) => c.chapter === ch.id).length;
  doc.candidates = selected;
  const length = jsonLength(doc, true);
  Object.assign(doc.budget, { estimate: Math.floor(length / rank.CHARS_PER_TOKEN), found: totalCandidates, kept: selected.length, dropped: totalCandidates - selected.length });
  doc.timing = { ms: Math.round(performance.now() - started), whyCalls: spineInfo.whyCalls };
  return doc;
}

function summary(t: TourRun): Msg {
  const run = t.run;
  const meta = run.meta;
  const out: Msg = {
    file: meta.file ?? null,
    steps: t.n,
    exitCode: 'exitCode' in meta ? meta.exitCode : (run.finished ?? {}).exitCode ?? null,
    durationMs: meta.durationMs ?? null,
    http: t.http.length,
    llm: t.http.filter((r) => r.llm).length,
    io: {
      http: (meta.config ?? {}).httpObserve !== false ? 'recorded' : 'not recorded (httpObserve off)',
      fileWrites: "from the statements' source; the recording has no file event",
      subprocess: "from the statements' source; the recording has no process event",
    },
  };
  if (run.recording) out.recording = run.recording;
  return out;
}
