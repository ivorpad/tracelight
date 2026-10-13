import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { project } from './helpers.ts';
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
      d.start({'entry.ts':`import {Manager} from '${path}';\nconst instance = Manager.create('scratch');\nconsole.log(instance.append('Hello'));`}, 'entry.ts', {only:[dir], stopOnEntry:false, record:true}, {node, breakpoints:[{path,line:4},{path,line:8},{path,line:13}]});
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
