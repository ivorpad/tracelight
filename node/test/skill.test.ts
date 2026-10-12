/**
 * The skill (`skills/tracelight`) names everything an agent can drive: every verb with each of its
 * flags in that verb's own synopsis, `run` and the other top-level commands, the MCP tools and
 * their arguments, the browser page's `ctl` commands, its HTTP API and WebMCP tools, the band's
 * keys, and every TRACELIGHT_ variable. A flag added without a line in the skill fails here.
 *
 * A synopsis is a line that starts `tracelight VERB` (its continuation lines indented under it),
 * or a bold inline span `**`VERB ...`**`, in the skill's references.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getVerb, parserFor, verbNames } from '../src/agent/commands.ts';
import '../src/agent/verbs.ts';
import { DEBUG_ACTIONS, MAP_ACTIONS, MOVES, VALUE_ACTIONS, toolDefinitions } from '../src/mcp/tools.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const SKILL = join(ROOT, 'skills/tracelight');
const source = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const doc = (rel: string) => readFileSync(join(SKILL, rel), 'utf8');
const REFS = readdirSync(join(SKILL, 'references')).filter((f) => f.endsWith('.md')).map((f) => `references/${f}`);
const ALL = ['SKILL.md', ...REFS].map(doc).join('\n');
const REFERENCE = REFS.map(doc).join('\n');

/** flags every verb shares, documented once */
const SHARED = new Set(['-h', '--help', '--json', '--live', '--session']);

/** every synopsis of `tracelight NAME` in `text`, joined */
export function synopses(text: string, name: string): string {
  const out: string[] = [];
  const lines = text.split('\n');
  const head = new RegExp(`^\\s*(?:\\$ )?tracelight ${name}(?=\\s|$)`);
  for (let i = 0; i < lines.length; i++) {
    if (!head.test(lines[i]!)) continue;
    out.push(lines[i]!);
    while (i + 1 < lines.length && /^\s{8,}\S/.test(lines[i + 1]!) && /--|\[/.test(lines[i + 1]!)) out.push(lines[++i]!);
  }
  const inline = new RegExp(`\\*\\*\`${name} ([^\`]*)\`\\*\\*`, 'g');
  for (const m of text.matchAll(inline)) out.push(m[0]);
  return out.join('\n');
}

const has = (text: string, word: string) => new RegExp(`(^|[^\\w-])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(text);

test('every verb has a synopsis with each of its flags', () => {
  const missing: string[] = [];
  for (const name of verbNames()) {
    const syn = synopses(REFERENCE, name);
    if (!syn) {
      missing.push(`${name}: no synopsis`);
      continue;
    }
    for (const a of parserFor(getVerb(name)!).actions) for (const f of a.flags) if (!SHARED.has(f) && !has(syn, f)) missing.push(`${name} ${f}`);
  }
  assert.deepEqual(missing, []);
});

test('the frontmatter is strict YAML: no ": " in a plain value', () => {
  // a loader with a strict parser (Codex's) drops a skill whose description reads `... in chat: how ...`
  const head = doc('SKILL.md').split('\n---')[0]!.split('\n').slice(1);
  for (const line of head) {
    const m = line.match(/^([a-z-]+): (.*)$/);
    if (!m || /^[>|'"]/.test(m[2]!)) continue;
    assert.ok(!m[2]!.includes(': '), `${m[1]}: a plain value may not hold ": "; write it as a >- block or quote it`);
  }
});

test('only the user starts the skill, in Claude Code and in Codex', () => {
  // `/tracelight` and `$tracelight`; neither agent loads it on its own
  assert.match(doc('SKILL.md').split('\n---')[0]!, /^disable-model-invocation: true$/m);
  assert.match(doc('agents/openai.yaml'), /^policy:\n(?: {2}.*\n)*? {2}allow_implicit_invocation: false$/m);
});

test('the shared flags are documented', () => {
  for (const f of SHARED) assert.ok(has(REFERENCE, f), f);
});

test('run and the other top-level commands have synopses with their flags', () => {
  const cli = source('node/src/cli.ts');
  const commands = [...cli.matchAll(/^\s+case '([a-z][\w-]*)':/gm)].map((m) => m[1]!);
  const missing: string[] = [];
  for (const c of new Set(commands)) if (!synopses(REFERENCE, c)) missing.push(`${c}: no synopsis`);
  const parseRun = cli.slice(cli.indexOf('function parseRunArgs'), cli.indexOf('export function buildRequest'));
  const runFlags = [...parseRun.matchAll(/a === '(--[a-z-]+)'/g)].map((m) => m[1]!).filter((f) => f !== '--');
  assert.ok(runFlags.length > 15, `parsed ${runFlags.length} run flags`);
  const run = synopses(REFERENCE, 'run');
  for (const f of runFlags) if (!has(run, f)) missing.push(`run ${f}`);
  for (const [c, f] of [['instrument', '--json'], ['cache', '--clear'], ['cache', '--json']] as const) if (!has(synopses(REFERENCE, c), f)) missing.push(`${c} ${f}`);
  assert.deepEqual(missing, []);
});

test('the MCP tools, their arguments and actions are in mcp.md', () => {
  const mcp = doc('references/mcp.md');
  const missing: string[] = [];
  for (const tool of toolDefinitions({})) {
    if (!has(mcp, tool.name)) missing.push(tool.name);
    for (const prop of Object.keys(tool.inputSchema.properties ?? {})) if (!mcp.includes(`\`${prop}\``)) missing.push(`${tool.name}.${prop}`);
  }
  for (const a of [...MAP_ACTIONS, ...VALUE_ACTIONS, ...MOVES, ...DEBUG_ACTIONS]) if (!mcp.includes(`\`${a}\``)) missing.push(`action ${a}`);
  assert.deepEqual(missing, []);
});

test('the browser page: tracelight web, every ctl command and flag, the HTTP API, the WebMCP tools', () => {
  const page = doc('references/browser.md');
  const server = source('web/server.ts');
  const missing: string[] = [];
  const parse = server.slice(server.indexOf('export function parseCtl'), server.indexOf('async function ctl('));
  const actions = [...parse.matchAll(/case '([a-z]+)':/g)].map((m) => m[1]!).filter((a) => a !== 'breakpoint');
  assert.ok(actions.length > 10, `parsed ${actions.length} ctl actions`);
  const ctl = synopses(page, 'web ctl');
  for (const a of actions) if (!has(ctl, a)) missing.push(`ctl ${a}`);
  for (const list of parse.matchAll(/\[('[a-zA-Z]+'(?:, '[a-zA-Z]+')+)\]\.includes/g)) for (const w of list[1]!.matchAll(/'([a-zA-Z]+)'/g)) if (!has(ctl, w[1]!)) missing.push(`ctl word ${w[1]}`);
  for (const f of new Set([...parse.matchAll(/flags\.(?:get|has|set)\('([a-z]+)'/g)].map((m) => `--${m[1]}`))) if (!has(ctl, f)) missing.push(`ctl ${f}`);
  if (!has(ctl, '--port')) missing.push('ctl --port');
  const main = server.slice(server.indexOf('export async function main'));
  const serve = synopses(page, 'web');
  for (const f of new Set([...main.matchAll(/a === '(--[a-z-]+)'/g)].map((m) => m[1]!))) if (!has(serve, f)) missing.push(`web ${f}`);
  for (const p of new Set([...server.matchAll(/'(\/api\/[a-z]+)'/g)].map((m) => m[1]!))) if (!page.includes(p)) missing.push(p);
  for (const t of source('web/agent.ts').matchAll(/tool\('(tracelight_\w+)'/g)) if (!has(page, t[1]!)) missing.push(t[1]!);
  assert.deepEqual(missing, []);
});

test('the band: its commands, keys and tool actions are in band.md', () => {
  const band = doc('references/band.md');
  const keys = source('claude-plugin/tracelight-band/hooks/keys.ts');
  const missing: string[] = [];
  for (const k of new Set([...keys.matchAll(/key: '([a-z])'/g)].map((m) => m[1]!))) if (!band.includes(`/tl ${k}`)) missing.push(`/tl ${k}`);
  const toolActions = keys.match(/TOOL_ACTIONS: Record<string, string> = \{([^}]*)\}/)?.[1] ?? '';
  const actions = ['show', 'hide', 'step', ...[...toolActions.matchAll(/(\w+):/g)].map((m) => m[1]!)];
  assert.ok(actions.length > 3 && keys.includes("enum: ['show', 'hide', 'step', ...Object.keys(TOOL_ACTIONS)]"), 'the band tool enum changed shape: update this test');
  for (const a of actions) if (!band.includes(`"${a}"`)) missing.push(`band action ${a}`);
  for (const c of ['/tracelight-band', 'mcp__tracelight-band__band']) if (!band.includes(c)) missing.push(c);
  assert.deepEqual(missing, []);
});

test('every TRACELIGHT_ variable an agent can set is named', () => {
  const files = ['node/src/home.ts', 'node/src/cli.ts', 'node/src/keep.ts', 'node/src/cache.ts', 'node/src/parse.ts', 'node/src/agent/debug_start.ts', 'web/server.ts', 'src/features/cliShim.ts'];
  const names = new Set<string>();
  for (const f of files) {
    const text = source(f);
    for (const m of text.matchAll(/\$\{ENV\}([A-Z0-9_]+)/g)) names.add(`TRACELIGHT_${m[1]}`);
    for (const m of text.matchAll(/TRACELIGHT_[A-Z0-9_]+/g)) names.add(m[0]);
  }
  for (const internal of ['TRACELIGHT_E2E', 'TRACELIGHT_BUILD']) names.delete(internal);
  assert.ok(names.size >= 10, [...names].join(' '));
  assert.deepEqual([...names].filter((n) => !has(ALL, n)).sort(), []);
});
