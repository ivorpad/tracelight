/**
 * The text form of `tour.json`, as Pyokka's `agent/tour/text.py`: the run, the goal, chapters with
 * their step ranges, then one line per candidate; a tour merged with its prose lists the picks.
 */
import { basename } from 'node:path';
import { commas, cpLen, cpSlice, flat, pyStr } from './py.ts';

type Msg = Record<string, any>;

export const LINE_VALUE = 70;
export const STATEMENT = 48;

function flatCut(text: unknown, limit: number): string {
  const s = flat(text !== null && text !== undefined ? String(text) : '');
  return cpLen(s) <= limit ? s : cpSlice(s, 0, limit - 1) + '…';
}

/** the first value worth a glance: `name = text`, a repeat as `name = same as <id>` */
function value(c: Msg): string {
  for (const v of c.values || []) {
    if (v.sameAs) return `${v.name} = same as ${String(v.sameAs).split('.')[0]}`;
    const text = v.text ?? '';
    if (v.like) return `${v.name} = …${flatCut(text, LINE_VALUE - 30)}… (differs from ${String(v.like).split('.')[0]} at ${v.from}-${v.to})`;
    return `${v.name} = ${flatCut(text, LINE_VALUE)}`;
  }
  return '';
}

/** a tour merged with its prose: what was accepted, the warnings, then the picks in order under their chapters */
export function renderMerged(doc: Msg): string {
  const prose = doc.prose || {};
  const warnings: string[] = prose.warnings || [];
  const lines = [`prose accepted: ${prose.stops ?? 0} stops, ${prose.chapters ?? 0} chapter texts, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`];
  for (const w of warnings) lines.push(`warning: ${w}`);
  if (doc.intro) lines.push('', flatCut(doc.intro, 400));
  const byId = new Map<string, Msg>((doc.candidates || []).map((c: Msg) => [c.id, c]));
  const chapters = new Map<string, Msg>((doc.chapters || []).map((ch: Msg) => [ch.id, ch]));
  let chapter: string | null = null;
  for (const sid of doc.pick || []) {
    const c = byId.get(sid)!;
    if (c.chapter !== chapter) {
      chapter = c.chapter;
      const ch = chapters.get(chapter!) || {};
      const [a, b] = ch.steps?.length ? ch.steps : [0, 0];
      lines.push('', `${chapter}  #${a}-${b}  ${(ch.prose || {}).title || ch.title || ''}`);
    }
    const p = c.prose || {};
    const q = p.quote;
    lines.push(`  ${p.order ?? 0}. ${sid}  #${c.step}  ${c.file}:${c.line}  ${flatCut(p.title, 70)}${q ? `  [quote ${q.name} ${q.from}-${q.to}]` : ''}`);
  }
  return lines.join('\n');
}

/** the text form; `wrote` names the file `--out` wrote, printed last */
export function renderTour(doc: Msg, wrote: string | null = null): string {
  const text = doc.prose !== null && doc.prose !== undefined ? renderMerged(doc) : renderCandidates(doc);
  return text + (wrote ? `\nwrote ${wrote}` : '');
}

function renderCandidates(doc: Msg): string {
  const run = doc.run || {};
  const budget = doc.budget || {};
  const lines = [
    `tour  ${basename(String(run.file || ''))}  ${commas(run.steps ?? 0)} steps  exit ${pyStr(run.exitCode)}  ${run.http ?? 0} HTTP (${run.llm ?? 0} model calls)  ${pyStr(budget.kept)} of ${pyStr(budget.found)} candidates, ~${commas(budget.estimate ?? 0)} tokens (budget ${commas(budget.tokens ?? 0)})`,
  ];
  const goal = doc.goal || {};
  if (goal.step !== null && goal.step !== undefined) {
    const named: Record<string, unknown> = { output: "the program's output", name: goal.name, line: goal.line, end: 'the last step' };
    const what = goal.kind in named ? named[goal.kind] : goal.kind;
    lines.push(`goal: ${pyStr(what)} at #${goal.step}${goal.text ? ': ' + flatCut(goal.text, 90) : ''}`);
  }
  if (doc.small) lines.push("small run: the walkthrough's moments are the candidates, one chapter");
  const rec = run.recording;
  if (rec && typeof rec === 'object' && !Array.isArray(rec) && rec.truncated) lines.push(`note: truncated recording: steps 0-${(rec.kept ?? 0) - 1} of ${pyStr(rec.stepsRun)} kept`);
  lines.push('');
  lines.push('chapters');
  for (const ch of doc.chapters || []) {
    const [a, b] = ch.steps;
    const extra = ch.http ? `  ${ch.http} HTTP (${ch.llm} model)` : '';
    const opens: string[] = ch.opens || [];
    const more = opens.length > 1 ? '  + ' + opens.slice(1, 4).join(', ') + (opens.length > 4 ? ' …' : '') : '';
    lines.push(`  ${String(ch.id).padEnd(4)} #${a}-${b}  ${(100 * (ch.share ?? 0)).toFixed(1).padStart(4)}%  ${ch.title}${more}  ${ch.candidates ?? 0} candidates${extra}`);
  }
  lines.push('');
  lines.push('candidates (id  #step  file:line  signals  statement  value)');
  let chapter: string | null = null;
  for (const c of doc.candidates || []) {
    if (c.chapter !== chapter) {
      chapter = c.chapter;
      lines.push(`  [${chapter}]`);
    }
    const sigs = (c.signals || []).map((s: Msg) => s.signal).join(',');
    const v = value(c);
    lines.push(`  ${c.id}  #${c.step}  ${c.file}:${c.line}  ${sigs}  ${flatCut(c.statement, STATEMENT)}${v ? '  → ' + v : ''}`);
  }
  return lines.join('\n');
}
