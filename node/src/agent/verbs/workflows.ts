/** Guided investigations and comparisons use the same recorded evidence as the individual verbs. */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { registerVerb } from '../commands.ts';
import { AgentError, SavedRun, callSource, type RunSource } from '../source.ts';
import { MAX_LOCALS_ENTRIES } from '../protocol.ts';
import { coverageReport } from '../coverage.ts';
import { Side, diffSides, renderDiff } from '../diff.ts';

type Msg = Record<string, any>;
async function saved(source: RunSource): Promise<SavedRun> {
  if (source instanceof SavedRun) return source;
  if (typeof source.recording !== 'function') throw new AgentError('This workflow needs a recording. Start Debug Current File (Recording).');
  const doc = await source.recording();
  return new SavedRun('live-run.json', doc);
}
function privateWrite(file: string, content: string): void {
  try { writeFileSync(resolve(file), content, { flag: 'wx', mode: 0o600 }); }
  catch (error) { throw new AgentError(`Cannot write ${file}: ${(error as Error).message}`); }
}
function notes(run: SavedRun): string[] {
  return ['Evidence covers this input only.',
    ...(!run.localsEntries.length ? ['No locals were recorded. Enable Record Variable Changes and run again.'] : []),
    ...(run.recording ? ['The recording is truncated.'] : []),
    ...(run.localsEntries.some(e => e.changes?.some((c: Msg) => c.snapshotIncomplete)) ? ['Some object snapshots are bounded or contain accessors. Unobserved properties are unknown.'] : [])];
}
registerVerb({
  name: 'investigate', help: 'follow a selected value through its changes and origin, with exceptions and uncovered branches',
  configure(p) {
    p.addArgument('--value', { metavar: 'NAME', help: 'variable or property path to investigate' });
    p.addArgument('--at', { type: 'int', metavar: 'STEP', help: 'the recorded step to explain; defaults to the first suspicious value or last change' });
  },
  async run(source, args) {
    const run = await saved(source);
    const errors = await callSource(run, 'exceptions');
    const history = args.value ? run.var(args.value, { limit: 1000 }) : null;
    const suspicious = history?.changes.find((c: Msg) => /\bNaN\b|^undefined$/.test(c.text));
    const step = args.at ?? suspicious?.step ?? history?.changes.at(-1)?.step ?? run.errors[0]?.step;
    const evidence: Msg = { kind: 'investigation', notes: notes(run), exceptions: errors, coverage: await coverageReport(run), history };
    if (step !== undefined) {
      evidence.step = step;
      evidence.context = run.context({ step });
      if (args.value) {
        evidence.why = await callSource(run, 'why', step, args.value, { depth: 5 });
        evidence.origin = await callSource(run, 'origin', step, args.value, { depth: 20 });
        evidence.comparisons = history.changes.filter((c: Msg) => c.text !== suspicious?.text).slice(0, 5);
      }
    }
    return evidence;
  },
  render: r => [
    'Investigation', ...r.notes,
    ...(r.history?.changes ?? []).map((c: Msg) => `#${c.step} ${c.file}:${c.line} ${c.name} = ${c.text ?? '?'}`),
    ...(r.exceptions.rows ?? []).map((e: Msg) => `#${e.step} ${e.kind} ${e.errorType}: ${e.message}`),
    ...(r.origin?.links ?? []).map((l: Msg) => `#${l.step} ${l.file}:${l.line} ${l.expr} (${l.how}, ${l.certainty}) ${l.text ?? ''}`),
    ...(r.coverage.files ?? []).filter((f: Msg) => f.notRun.length || f.partial.length).map((f: Msg) => `${f.file}: unexecuted lines ${f.notRun.join(', ') || 'none'}; partial lines ${f.partial.join(', ') || 'none'}`),
  ],
});
registerVerb({
  name: 'learn', help: 'choose meaningful checkpoints, predict a result, then reveal the recorded evidence',
  configure(p) {
    p.addArgument('--at', { type: 'int', metavar: 'STEP', help: 'checkpoint to practice' });
    p.addArgument('--prediction', { metavar: 'TEXT', help: 'your prediction, kept beside the observed result' });
    p.addArgument('--reveal', { action: 'store_true', help: 'show the recorded values at the checkpoint' });
  },
  async run(source, args) {
    const run = await saved(source);
    const walk = await callSource(run, 'walkthrough', {});
    const checkpoints = walk.moments.filter((m: Msg) => ['call', 'decision', 'error', 'print'].includes(m.kind)).slice(0, 12);
    const result: Msg = { kind: 'learning', notes: notes(run), coverage: await coverageReport(run),
      checkpoints: checkpoints.map((m: Msg) => ({ step: m.step, kind: m.kind, source: run.context({ step: m.step }).block.lines.map((l: Msg) => `${l.line}  ${l.text}`).join('\n'), prompt: 'Predict the value, branch or outcome here before revealing it.' })) };
    if (args.at !== undefined && args.at !== null) {
      run.checkStep(args.at);
      result.step = args.at;
      result.prediction = args.prediction ?? null;
      if (args.reveal) { result.observed = run.context({ step: args.at }); result.moments = checkpoints.filter((m: Msg) => m.step === args.at); }
      else result.prompt = 'Record your prediction, then use --reveal at this step to compare it with the run.';
    } else result.outline = await callSource(run, 'graph', { statements: false });
    return result;
  },
  render: r => [
    'Learn from this run', ...r.notes,
    ...r.checkpoints.map((c: Msg) => `#${c.step} ${c.kind}: ${c.prompt}\n${c.source}`),
    ...(r.prediction !== undefined ? [`Your prediction: ${r.prediction ?? ''}`] : []),
    ...(r.moments ?? []).flatMap((m: Msg) => [m.text, ...(m.values ?? []).map((v: Msg) => `${v.name} = ${v.text}`)]),
    ...(r.observed?.values ?? []).map((v: Msg) => `#${v.step} ${v.context ?? 'value'} = ${v.text}`),
    ...(r.coverage.files ?? []).map((f: Msg) => `${f.file}: unexecuted lines ${f.notRun.join(', ') || 'none'}; partial lines ${f.partial.join(', ') || 'none'}`),
  ],
});
registerVerb({
  name: 'pin', help: 'keep a private baseline recording without rerunning the program',
  configure(p) { p.addArgument('--out', { required: true, metavar: 'PATH', help: 'new baseline file; refuses to overwrite' }); },
  async run(source, args) {
    const run = await saved(source);
    privateWrite(args.out, JSON.stringify({ meta: run.meta, events: run.events }) + '\n');
    return { pinned: resolve(args.out), notes: notes(run) };
  },
  render: r => [`Pinned ${r.pinned}`, ...r.notes],
});
registerVerb({
  name: 'verify', help: 'compare a baseline with a new run and check explicit expected values',
  configure(p) {
    p.addArgument('--after', { metavar: 'PATH', help: 'existing after recording' });
    p.addArgument('--rerun', { action: 'store_true', help: 'execute the baseline entry again with its saved arguments; recorded HTTP uses replay' });
    p.addArgument('--out', { metavar: 'PATH', help: 'save the rerun to this new file' });
    p.addArgument('--ignore', { action: 'append', default: [], metavar: 'NAME', help: 'ignore these named value/log facts, as in diff' });
    p.addArgument('--expect', { action: 'append', default: [], metavar: 'NAME=TEXT', help: 'expected final recorded value; repeatable' });
    p.addArgument('--test-out', { metavar: 'PATH', help: 'write a regression test for the explicit expectations; refuses to overwrite' });
  },
  async run(source, args) {
    const before = await saved(source);
    if (!!args.after === !!args.rerun) throw new AgentError('Choose exactly one of --after PATH or --rerun.');
    const expectations = (args.expect ?? []).map((text: string) => {
      const at = text.indexOf('=');
      if (at < 1) throw new AgentError('--expect needs NAME=TEXT, using the recorded text of the value.');
      return { name: text.slice(0, at), expected: text.slice(at + 1) };
    });
    let after: SavedRun;
    if (args.test_out && !expectations.length) throw new AgentError('--test-out needs at least one reviewed --expect NAME=TEXT.');
    if (args.rerun) {
      const { recordRun } = await import('../../cli.ts');
      const c = before.meta.config ?? {};
      const doc = await recordRun({ file: before.meta.file, argv: before.meta.argv ?? [], json: true, autoLog: !!c.autoLog,
        cwd: before.meta.cwd, workspaceRoot: before.meta.workspaceRoot, node: before.meta.executable, timeoutMs: c.timeoutMs ?? 30000, recordLocals: true, http: c.http === 'record' ? 'replay' : c.http,
        libraryCode: c.libraryCode, exclude: c.exclude, only: c.only, plugins: c.plugins, maxSteps: c.maxTraceSteps, maxValueChars: c.maxValueChars });
      after = new SavedRun(args.out ?? 'verification.json', doc);
      if (args.out) privateWrite(args.out, JSON.stringify({ meta: doc.meta, events: doc.events }) + '\n');
    } else after = new SavedRun(args.after);
    const checks = expectations.map(({ name, expected }: Msg) => {
      const history = after.var(name, { limit: 100000 });
      const value = history.changes.at(-1)?.text;
      const root = /^[A-Za-z_$][\w$]*/.exec(name)?.[0];
      const last = after.localsEntries.flatMap(e => e.changes ?? []).filter(c => c.name === root).at(-1);
      const complete = !after.recording && after.localsEntries.length < MAX_LOCALS_ENTRIES && !after.midRun && !!after.finished.type && !history.truncated && !last?.truncated && !last?.snapshotIncomplete;
      return { name, expected, actual: value ?? null, passed: complete && value === expected, ...(complete ? {} : { reason: 'The final value is not supported by a complete recording.' }) };
    });
    const comparison = await diffSides(await Side.open('a', before.path, before), await Side.open('b', after.path, after), { ignore: args.ignore, limit: 100 });
    const result: Msg = { ...comparison, checks, verified: checks.length > 0 && checks.every((c: Msg) => c.passed) && after.finished.exitCode === 0,
      coverage: await coverageReport(after), exceptions: await callSource(after, 'exceptions'), notes: [...comparison.notes, ...notes(after)] };
    if (!checks.length) result.notes.push('No expected values supplied. This comparison does not declare the fix correct.');
    if (args.test_out) {
      if (!expectations.length) throw new AgentError('--test-out needs at least one reviewed --expect NAME=TEXT.');
      const cli = resolve(import.meta.dirname, '../../../bin/tracelight.mjs');
      const spec = { file: before.meta.file, cwd: before.meta.cwd, argv: before.meta.argv ?? [], expectations, http: before.meta.config?.http === 'record' ? 'replay' : before.meta.config?.http };
      privateWrite(args.test_out, `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { execFileSync } from 'node:child_process';\nimport { mkdtempSync, rmSync } from 'node:fs';\nimport { tmpdir } from 'node:os';\nimport { join } from 'node:path';\nconst spec=${JSON.stringify(spec)};\nconst cli=${JSON.stringify(cli)};\ntest('recorded regression',()=>{const dir=mkdtempSync(join(tmpdir(),'tl-regression-'));try{const run=join(dir,'run.json');execFileSync(process.execPath,[cli,'run',spec.file,'--save',run,...(spec.cwd?['--cwd',spec.cwd]:[]),...(spec.http?['--http',spec.http]:[]),'--',...spec.argv]);for(const expected of spec.expectations){const history=JSON.parse(execFileSync(process.execPath,[cli,'var',run,expected.name,'--limit','100000','--json'],{encoding:'utf8'}));assert.equal(history.changes.at(-1)?.text,expected.expected,expected.name);}}finally{rmSync(dir,{recursive:true,force:true});}});\n`);
      result.test = resolve(args.test_out);
    }
    return result;
  },
  exitCode: r => r.checks.length && !r.verified ? 1 : 0,
  render: r => [...renderDiff(r), ...r.checks.map((c: Msg) => `${c.passed ? 'PASS' : 'FAIL'} ${c.name}: ${c.actual} (expected ${c.expected})${c.reason ? ' · ' + c.reason : ''}`), r.verified ? 'Expected values verified for this input.' : 'Fix not verified.'],
});
