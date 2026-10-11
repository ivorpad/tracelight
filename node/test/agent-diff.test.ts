/**
 * Differential: `tracelight VERB` against Pyokka's own `pyokka VERB` over the same saved JavaScript
 * run. The outputs (stdout, stderr, exit code) must be the same once the program name is swapped.
 * Skipped without python3 >= 3.12. The known differences (hint wording that names JavaScript
 * files or bindings, usage indentation from the longer name) are kept out of these commands.
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NAME } from '../src/protocol.ts';

const PY = resolve(import.meta.dirname, '../../python');
const BIN = resolve(import.meta.dirname, '../bin/tracelight.mjs');
const havePython = spawnSync('python3', ['-c', 'import sys; assert sys.version_info >= (3, 12)']).status === 0;
const skip = !havePython && 'python3 >= 3.12 not found';

const LIB = `export function total(xs) {
  let sum = 0;
  for (const x of xs) {
    sum += x;
  }
  return sum;
}

export class Box {
  constructor(items) {
    this.items = items;
  }
  first() {
    if (this.items.length === 0) {
      throw new RangeError('empty box');
    }
    return this.items[0];
  }
}
`;
const APP = `import { Box, total } from './lib.mjs';

const prices = [3, 4, 5];
const sum = total(prices);
console.log('sum', sum);
const box = new Box(prices);
console.log(box.first());
const kind = sum > 10 ? 'big' : 'small';
console.log(kind);
const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
console.log(secret);
try {
  new Box([]).first();
} catch (e) {
  console.log('caught', e.message);
}
let n = 0;
while (n < 2) {
  n++;
}
console.log({ n, kind });
`;

const COMMANDS = [
  'state R',
  'state R --json',
  'story R',
  'story R --json',
  'story R --scope first',
  'story R --file lib.mjs --limit 4',
  'story R --line app.mjs:7',
  'steps R',
  'steps R --from 5 --count 4 --json',
  'steps R --line lib.mjs:4',
  'step R 3 --into',
  'step R 3 --over',
  'step R 6 --out',
  'step R 6 --back',
  'step R 10 --back-over',
  'step R 6 --back-out --json',
  'step R 0 --to 20',
  'step R 3 --into --over',
  'step R 999 --into',
  'step R 999 --into --json',
  'context R 4',
  'context R 4 --scope',
  'context R 12 --json',
  'values R --line app.mjs:5',
  'values R --line app.mjs:11 --json',
  'values R --line nope.mjs:1',
  'find R caught',
  'find R ghp_',
  'find R zzz --json',
  'exceptions R',
  'exceptions R --json',
  'http R',
  'http R --json',
  'why R 3',
  'why R 4 sum',
  'why R 4 sum --json',
  'why R 4 sum --depth 1',
  'why R 999',
  'why R x',
  'why R',
  'origin R',
  'origin R x',
  'origin R 999',
  'origin R 999 --json',
  'origin R 3 --depth x',
  'steps R --count x',
  'story R --bogus',
  'history R --at 4 --at 12 --out hist-1.json',
  'history R --var sum --limit 1 --out hist-2.json --json',
  'history R --why 4 sum --out hist-3.json',
  'history R --why x y --out hist-4.json',
  'history R --out hist-5.json --json',
  'narrate R --command definitely-missing-cli',
  'tour R --budget 10',
  'tour R --budget 10 --json',
  'tour R --goal nope_name',
  'tour R --goal lib.mjs:8',
  'tour R --goal x --bogus',
];

let dir = '';
let saved = '';

before(() => {
  if (skip) return;
  // a folder whose path does not hold the program name, which the comparison swaps
  dir = mkdtempSync(join(tmpdir(), 'agent-diff-'));
  writeFileSync(join(dir, 'app.mjs'), APP);
  writeFileSync(join(dir, 'lib.mjs'), LIB);
  saved = join(dir, 'app.json');
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', BIN, 'run', join(dir, 'app.mjs'), '--save', saved], { cwd: dir, encoding: 'utf8' });
  assert.match(r.stderr, /^saved /m, r.stderr);
});

interface Result {
  code: number;
  out: string;
  err: string;
}

function exec(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<Result> {
  return new Promise((done) => {
    execFile(cmd, args, { cwd: dir, env, encoding: 'utf8' }, (error, out, err) => done({ code: error ? Number(error.code ?? 1) : 0, out, err }));
  });
}

/** the same words for both programs: `R` is the run, a name argument stays relative to the run's folder */
const words = (command: string) => command.split(' ').map((w) => (w === 'R' ? saved : w));
const norm = (text: string) => text.replaceAll(NAME, 'pyokka').replaceAll('skills/tracelight/', 'skills/pyokka/'); // the JS skill holds the same renderers
/** a usage error: only its last line, the error (the usage above it is indented by the program name's length, and the top-level one lists each program's own commands) */
const usageError = (err: string) => (err.startsWith('usage:') ? err.trimEnd().split('\n').pop()! + '\n' : err);

test('tracelight agent verbs print what pyokka prints over the same run', { skip }, async () => {
  const pyEnv = { ...process.env, PYTHONPATH: PY, COLUMNS: '80' };
  const jsEnv = { ...process.env, COLUMNS: '80' };
  const results = await Promise.all(
    COMMANDS.map(async (command) => {
      const [py, js] = await Promise.all([
        exec('python3', ['-m', 'pyokka_runtime', ...words(command)], pyEnv),
        exec(process.execPath, ['--disable-warning=ExperimentalWarning', BIN, ...words(command)], jsEnv),
      ]);
      return { command, py, js };
    }),
  );
  const differ: string[] = [];
  for (const { command, py, js } of results) {
    // pyokka prints paths the Tracelight run saved (its `.tracelight/replay` file), so both sides are normalized
    const a = `[exit ${py.code}]\n${norm(py.out)}--stderr--\n${usageError(norm(py.err))}`;
    const b = `[exit ${js.code}]\n${norm(js.out)}--stderr--\n${usageError(norm(js.err))}`;
    if (a !== b) differ.push(`### ${command}\n--- pyokka\n${a}\n--- ${NAME}\n${b}`);
  }
  assert.equal(differ.length, 0, differ.join('\n'));
});
