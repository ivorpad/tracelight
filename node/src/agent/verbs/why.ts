/**
 * `why`: why a value is what it is: the statement that made it, what it read with values, the
 * calls it made, five levels back. The tree is `provenance.ts`; the text
 * is the twin of `src/shared/provenanceText.ts`.
 */
import { pyText } from '../checkpoint.ts';
import { isLive, registerVerb } from '../commands.ts';
import { PROVENANCE_DEPTH, PROVENANCE_MAX_DEPTH, PROVENANCE_NODES } from '../protocol.ts';
import { provenance } from '../provenance.ts';
import { loc, oneLine, type Args } from '../render.ts';
import { AgentError, callSource, registerSavedMethod, type RunSource, type SavedRun } from '../source.ts';
import { pyRepr } from '../argparse.ts';

type Msg = Record<string, any>;

export const WHY_VALUE = 100;
export const WHY_STATEMENT = 80;
export const WHY_INPUT = 60;
/** a leaf of a recording that began at a pause (`--record-from`): its value was made before step 0 */
export const BEFORE_RECORDING = '   made before #0, where the recording started';

registerSavedMethod('why', (run: SavedRun, step: number | null, name = '', opts: { depth?: number } = {}) => {
  if (step === null || step === undefined) throw new AgentError('why needs STEP, the step whose statement made the value', 'e.g. `why run.json 24 label`; `var run.json label` lists the steps where it changed');
  const out = provenance(run, run.checkStep(step), name, opts.depth ?? PROVENANCE_DEPTH);
  out.stale = run.staleFiles().length > 0;
  out.staleFiles = run.staleFiles();
  return out;
});

function whyNode(n: Msg, prefix: string, source: RunSource): string {
  const parts: string[] = [];
  if (n.name) {
    if (n.text !== null && n.text !== undefined) parts.push(`${n.name} = ${oneLine(n.text, WHY_VALUE)}${n.unchanged ? '  (same object)' : ''}`);
    else if (n.step !== null && n.step !== undefined) parts.push(`${n.name}  assigned here (value not recorded)`);
    else parts.push(`${n.name} = ?${n.beforeRecording ? BEFORE_RECORDING : ''}`);
  }
  if (n.step !== null && n.step !== undefined) parts.push(`#${pyText(n.step)} ${loc(source, n.file, n.line)} ${n.function || '<module>'}`);
  if (n.statement) parts.push(oneLine(n.statement, WHY_STATEMENT));
  return prefix + parts.join('   ') + (n.cut ? '  …' : '');
}

function whyCall(c: Msg, source: RunSource): string {
  let s = `↳ ${pyText(c.name)} #${pyText(c.entryStep)}–#${pyText(c.returnStep)} ${loc(source, c.file, c.line)}`;
  const inputs = (c.inputs ?? []).filter((i: unknown) => i && typeof i === 'object' && !Array.isArray(i));
  if (inputs.length) s += '   in ' + inputs.map((i: Msg) => `${pyText(i.name)} = ${oneLine(i.text, WHY_INPUT)}`).join(', ');
  if (c.result !== null && c.result !== undefined) s += `   out ${oneLine(c.result, WHY_STATEMENT)}`;
  return s;
}

/** the header, one line per node depth-first (its reads, then its calls, then its opaque calls), the truncation note */
export function renderWhy(result: Msg, source: RunSource, _args: Args): string[] {
  const out = [result.name ? `why ${result.name} at #${pyText(result.step)}` : `why #${pyText(result.step)}`];
  const walk = (n: Msg, level: number): void => {
    const pad = '  '.repeat(level);
    out.push(pad + whyNode(n, level ? '← ' : '', source));
    for (const r of n.reads ?? []) walk(r, level + 1);
    for (const c of n.calls ?? []) out.push(pad + '  ' + whyCall(c, source));
    for (const o of n.opaque ?? []) out.push(`${pad}  · ${o}   not stepped`);
  };
  walk(result.root, 0);
  if (result.truncated) out.push(`… more inputs than ${PROVENANCE_NODES} nodes show; ask why for a node's name at its step`);
  if (result.conclusion) out.push(String(result.conclusion));
  return out;
}

registerVerb({
  name: 'why',
  help: 'why a value is what it is: the statement that made it, what it read with values, the calls it made, five levels back',
  configure(p) {
    p.addArgument('step', { nargs: '?', metavar: 'STEP', help: 'the step whose statement made the value (omit with --live: the Time Machine\'s step)' });
    p.addArgument('name', { nargs: '?', metavar: 'NAME', help: 'a name or property path (label, this.balance); omit it to explain the statement at STEP' });
    p.addArgument('--depth', { type: 'int', default: PROVENANCE_DEPTH, metavar: 'N', help: `levels below the value to expand (default ${PROVENANCE_DEPTH}, at most ${PROVENANCE_MAX_DEPTH})` });
    p.setDefaults({ _words: ['step', 'name'] });
  },
  run(source, args) {
    if ((args.step === null || args.step === undefined) && !isLive(args)) throw new AgentError('why needs STEP, the step whose statement made the value', 'e.g. `why run.json 24 label`; `var run.json label` lists the steps where it changed, `steps --line F:L` the steps on a line');
    if (args.step !== null && args.step !== undefined && !/^\d+$/.test(String(args.step).replace(/^-+/, ''))) throw new AgentError(`STEP must be a step number, got ${pyRepr(String(args.step))}`, 'e.g. `why run.json 24 label`: the step first, then the name');
    const depth = Math.max(1, Math.min(PROVENANCE_MAX_DEPTH, Math.trunc(args.depth)));
    return callSource(source, 'why', args.step !== null && args.step !== undefined ? parseInt(String(args.step), 10) : null, String(args.name ?? '').trim(), { depth });
  },
  render: renderWhy,
});
