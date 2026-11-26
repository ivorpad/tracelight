import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { project, run } from './helpers.ts';
import { Driver } from './driver.ts';
import { kindOf } from '../src/select.ts';

const manager = `export class Manager {
  private constructor(private cwd: string, private sessionFile?: string) {}
  static create(cwd: string) {
    const instance = new Manager(cwd, 'history.json');
    return instance;
  }
  append(message: string) {
    const entry = {message, cwd: this.cwd};
    return this.persist(entry);
  }
  private persist(entry: {message: string; cwd: string}) {
    const file = this.sessionFile;
    return {file, entry};
  }
}`;

test('explicit only paths include external sources while exclusion still wins', () => {
  const sel = {root:'/caller', mainPath:'/caller/entry.ts', libraryCode:false, libraryPackages:[], exclude:[], only:[]};
  assert.equal(kindOf('/manager/manager.ts', sel), null);
  assert.equal(kindOf('/manager/manager.ts', {...sel, imported:true}), 'project');
  assert.equal(kindOf('/manager/manager.ts', {...sel, imported:true, only:['/caller']}), null);
  assert.equal(kindOf('/manager/manager.ts', {...sel, imported:true, exclude:['/manager']}), null);
  assert.equal(kindOf('/manager/node_modules/pkg/index.js', {...sel, imported:true}), null);
  assert.equal(kindOf('/manager/manager.ts', {...sel, only:['/manager']}), 'project');
  assert.equal(kindOf('/manager/manager.ts', {...sel, only:['/manager'], exclude:['/manager']}), null);
});

const bun = process.env.TRACELIGHT_TEST_BUN || 'bun';
for (const node of [process.execPath, bun]) {
  test(`external parameter properties and live imported breakpoints (${node})`, {skip:node === bun && spawnSync(bun, ['--version']).status !== 0, timeout:20000}, async () => {
    const dir = project({'manager.ts':manager});
    const path = `${dir}/manager.ts`;
    const d = new Driver();
    try {
      d.start({'entry.ts':`import {Manager} from '${path}';\nconst instance = Manager.create('scratch');\nconsole.log(instance.append('Hello'));`}, 'entry.ts', {stopOnEntry:false, record:true}, {node, breakpoints:[{path,line:4},{path,line:8},{path,line:13}]});
      for (const line of [4,8,13]) {
        const pause = await d.paused();
        assert.equal(pause.line, line);
        assert.equal(d.seen.find(e => e.type === 'file.instrumented' && e.fileId === pause.fileId)?.path, path);
        const locals = (await d.ask({type:'debug',action:'locals'})).locals;
        if (line === 4) assert.ok(locals.some((v:any) => v.name === 'cwd' && v.text === "'scratch'"));
        if (line === 8) assert.ok(locals.some((v:any) => v.name === 'message' && v.text === "'Hello'"));
        if (line === 13) assert.ok(locals.some((v:any) => v.name === 'file' && v.text === "'history.json'"));
        await d.ask({type:'debug',action:'continue'});
      }
      assert.equal((await d.next(e => e.type === 'run.finished')).exitCode, 0);
    } finally {d.close();}
  });
}

// Explicitly excluded imports still load when TypeScript requires more than type stripping.
for (const node of [process.execPath, bun]) {
  test(`unselected external TypeScript with parameter properties still loads (${node})`, {skip:node === bun && spawnSync(bun, ['--version']).status !== 0, timeout:20000}, async () => {
    const dir = project({'manager.ts':manager, 'kind.ts':'export enum Kind { A, B = 5 }'});
    const r = await run({'entry.ts':`import {Manager} from '${dir}/manager.ts';\nimport {Kind} from '${dir}/kind.ts';\nconsole.log(Manager.create('scratch').append('Hello').file, Kind.B);`}, 'entry.ts', {node}, {exclude:[dir]});
    assert.deepEqual(r.of('error').map(e => e.message), []);
    assert.equal(r.finished.exitCode, 0);
    assert.equal(r.logs()[0]?.text, 'history.json 5');
    assert.deepEqual(r.of('file.instrumented').map(e => e.path.split('/').pop()), ['entry.ts']);
  });
}

for (const node of [process.execPath, bun]) {
  for (const dynamic of [false, true]) {
    test(`external transitive JavaScript ${dynamic ? 'dynamic' : 'static'} imports pause without scope flags (${node})`, {skip:node === bun && spawnSync(bun, ['--version']).status !== 0, timeout:20000}, async () => {
      const dir = project({'loop.mjs': `export function decide(reply) {
  const hasTools = Boolean(reply.toolCalls?.length);
  return hasTools;
}`, 'index.mjs': "export {decide} from './loop.mjs';"});
      const path = `${dir}/loop.mjs`;
      const load = dynamic ? `const {decide} = await import('${dir}/index.mjs');` : `import {decide} from '${dir}/index.mjs';`;
      const d = new Driver();
      try {
        d.start({'entry.mjs': `${load}
console.log(decide({content:'hello'}));`}, 'entry.mjs', {stopOnEntry:false}, {node, breakpoints:[{path,line:2}]});
        const pause = await d.paused();
        assert.equal(pause.line, 2);
        assert.equal(d.seen.find(e => e.type === 'file.instrumented' && e.fileId === pause.fileId)?.path, path);
        const locals = (await d.ask({type:'debug',action:'locals'})).locals;
        assert.ok(locals.some((v:any) => v.name === 'reply' && v.text.includes('hello')));
        await d.ask({type:'debug',action:'continue'});
        assert.equal((await d.next(e => e.type === 'run.finished')).exitCode, 0);
      } finally {d.close();}
    });
  }
}

test('Node requires and pauses in external CommonJS without scope flags', {timeout:20000}, async () => {
  const dir = project({'loop.cjs': `exports.decide = function decide(reply) {
  return Boolean(reply.toolCalls?.length);
};`});
  const path = `${dir}/loop.cjs`;
  const d = new Driver();
  try {
    d.start({'entry.cjs': `const {decide} = require('${path}');
console.log(decide({content:'hello'}));`}, 'entry.cjs', {stopOnEntry:false}, {breakpoints:[{path,line:2}]});
    assert.equal((await d.paused()).line, 2);
    await d.ask({type:'debug',action:'continue'});
    assert.equal((await d.next(e => e.type === 'run.finished')).exitCode, 0);
  } finally {d.close();}
});
