/** A question and named stops anchored to one immutable saved recording. */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { AgentError } from './source.ts';
import { RecordedRun } from './recorded.ts';

export interface InvestigationCheckpoint { name: string; step: number }
export interface SaveInvestigationOptions {
  path: string;
  run: string;
  question: string;
  checkpoints: InvestigationCheckpoint[];
}
interface InvestigationArtifact {
  kind: 'investigation';
  version: 1;
  /** Relative to the artifact, resolved to the canonical recording when opened. */
  run: string;
  sha256: string;
  question: string;
  checkpoints: InvestigationCheckpoint[];
}
export interface InvestigationResult {
  kind: 'saved-investigation';
  version: 1;
  path: string;
  run: string;
  sha256: string;
  question: string;
  checkpoints: (InvestigationCheckpoint & { context: Record<string, any> })[];
  identity: { runId: string | null; file: string | null; language: string | null; steps: number };
  recording: { truncated: boolean; midRun: boolean; completed: boolean; exitCode: number | null };
  notes: string[];
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw new AgentError(`${name} must be a nonempty string of at most ${max} characters.`);
  }
  return value;
}
function checkpoints(value: unknown): InvestigationCheckpoint[] {
  if (!Array.isArray(value) || value.length > 20) throw new AgentError('An investigation may have at most 20 checkpoints.');
  const names = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new AgentError('Each checkpoint needs a name and recorded step.');
    const name = text(item.name, 'Checkpoint name', 256).trim();
    if (names.has(name)) throw new AgentError(`Duplicate checkpoint name: ${name}`);
    names.add(name);
    if (!Number.isInteger(item.step) || item.step < 0) throw new AgentError(`Checkpoint ${name} needs a nonnegative integer recorded step.`);
    return { name, step: item.step };
  });
}
function readRun(path: string): { path: string; sha256: string; run: RecordedRun } {
  try {
    const canonical = realpathSync(text(path, 'Recording path', 4096));
    text(canonical, 'Canonical recording path', 4096);
    const bytes = readFileSync(canonical);
    const doc = JSON.parse(bytes.toString('utf8'));
    if (!doc || typeof doc.meta !== 'object' || !doc.meta || !Array.isArray(doc.events)) throw new Error('expected a saved run with meta and events');
    return { path: canonical, sha256: createHash('sha256').update(bytes).digest('hex'), run: new RecordedRun(canonical, doc) };
  } catch (error) {
    throw new AgentError(`Cannot open investigation recording ${path}: ${(error as Error).message}`);
  }
}
function resume(path: string, artifact: InvestigationArtifact, loaded: ReturnType<typeof readRun>): InvestigationResult {
  const run = loaded.run;
  const stops = artifact.checkpoints.map(checkpoint => {
    run.checkStep(checkpoint.step);
    return { ...checkpoint, context: run.context({ step: checkpoint.step }) };
  });
  const notes = ['Evidence covers this recorded input only. Opening an investigation does not execute code or move a live debugger.'];
  if (run.recording) notes.push('The recording is truncated.');
  if (run.midRun) notes.push('Recording began partway through execution. Earlier steps are unavailable.');
  if (!run.finished.type) notes.push('The recording has no completion event. Final values are not established.');
  if (!run.localsEntries.length) notes.push('No local-value changes were recorded.');
  if (run.sortedFiles.some(file => run.keptSource(String(file.path)) === null)) notes.push('Some source files have no recorded copy. Their source context is unavailable, rather than read from current files.');
  return { kind: 'saved-investigation', version: 1, path, run: loaded.path, sha256: loaded.sha256,
    question: artifact.question, checkpoints: stops,
    identity: { runId: typeof run.meta.runId === 'string' ? run.meta.runId : null, file: typeof run.meta.file === 'string' ? run.meta.file : null,
      language: typeof run.meta.language === 'string' ? run.meta.language : null, steps: run.trace.count },
    recording: { truncated: !!run.recording, midRun: run.midRun, completed: !!run.finished.type,
      exitCode: typeof run.finished.exitCode === 'number' ? run.finished.exitCode : null }, notes };
}

export function saveInvestigation(options: SaveInvestigationOptions): InvestigationResult {
  const requested = resolve(text(options.path, 'Investigation path', 4096));
  // Canonicalize the existing parent before making a relative recording reference.
  // On macOS /var and /private/var can otherwise create a broken saved reference.
  const path = join(realpathSync(dirname(requested)), basename(requested));
  text(path, 'Canonical investigation path', 4096);
  const question = text(options.question, 'Investigation question', 4096);
  const stops = checkpoints(options.checkpoints);
  const loaded = readRun(options.run);
  const artifact: InvestigationArtifact = { kind: 'investigation', version: 1,
    run: text(relative(dirname(path), loaded.path), 'Artifact recording path', 4096), sha256: loaded.sha256, question, checkpoints: stops };
  // Build and validate every recorded context before creating the artifact.
  const result = resume(path, artifact, loaded);
  try { writeFileSync(path, JSON.stringify(artifact) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { throw new AgentError(`Cannot save investigation ${path}: ${(error as Error).message}`); }
  result.path = realpathSync(path);
  return result;
}

export function openInvestigation(path: string): InvestigationResult {
  let canonical: string, doc: any;
  try {
    canonical = realpathSync(text(path, 'Investigation path', 4096));
    text(canonical, 'Canonical investigation path', 4096);
    doc = JSON.parse(readFileSync(canonical, 'utf8'));
  } catch (error) { throw new AgentError(`Cannot open investigation ${path}: ${(error as Error).message}`); }
  if (!doc || doc.kind !== 'investigation' || doc.version !== 1) throw new AgentError('Unsupported investigation artifact. Expected kind investigation, version 1.');
  if (typeof doc.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(doc.sha256)) throw new AgentError('Investigation recording identity must be a SHA256 digest.');
  const artifact: InvestigationArtifact = { kind: 'investigation', version: 1,
    run: text(doc.run, 'Artifact recording path', 4096), sha256: doc.sha256,
    question: text(doc.question, 'Investigation question', 4096), checkpoints: checkpoints(doc.checkpoints) };
  const loaded = readRun(resolve(dirname(canonical), artifact.run));
  if (loaded.sha256 !== artifact.sha256) throw new AgentError('The investigation recording changed. Its SHA256 no longer matches; save a new investigation before reusing checkpoints.');
  return resume(canonical, artifact, loaded);
}
