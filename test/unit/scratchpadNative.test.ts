import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {createServer} from 'node:net';
import { runScratch } from '../../web/scratchpadRuntime';
import { scratchCompatibility } from '../../web/scratchpadCompatibility';

const directory = mkdtempSync(join(tmpdir(),'tl-native-fixture-'));
const file = join(directory,'main.ts');
writeFileSync(file,'export {};');
afterAll(()=>rmSync(directory,{recursive:true,force:true}));
const bun = process.env.TRACELIGHT_TEST_BUN ?? 'bun';
const runtimes = [process.execPath,...(spawnSync(bun,['--version']).status===0?[bun]:[])];
for (const executable of runtimes) describe(`native scratchpad ${executable}`,()=>{
  const run = (code:string,mocks:Record<string,unknown>={}) => runScratch({file,code,inputs:{},mocks},executable);
  it('reads four chunks, then done, using the native Streams constructor',async()=>{
    const r = await run(`const stream = ReadableStream.from([1,2,3,4]);
const reader = stream.getReader();
const first = await reader.read();
const second = await reader.read();
const third = await reader.read();
const fourth = await reader.read();
const done = await reader.read();
const result = [first,second,third,fourth,done];`);
    expect(r.error).toBeUndefined(); expect(r.applicationErrors).toEqual([]);
    expect(r.result).toEqual([{value:1,done:false},{value:2,done:false},{value:3,done:false},{value:4,done:false},{done:true}]);
  });
  it('uses native encoding, timers, crypto, Buffer, URL and filesystem modules',async()=>{
    const r = await run(`import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
await writeFile('native.txt',new TextEncoder().encode('hé😀'));
await delay(5);
const text = new TextDecoder().decode(await readFile('native.txt'));
const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode('fixture'));
const result = {text,encoded:Buffer.from('hello').toString('base64'),path:new URL('/answer','https://example.test').pathname,hash:createHash('sha256').update('fixture').digest('hex'),bytes:digest.byteLength};`);
    expect(r.error).toBeUndefined(); expect(r.result).toMatchObject({text:'hé😀',encoded:'aGVsbG8=',path:'/answer',bytes:32});
    expect((r.result as any).hash).toHaveLength(64);
  });
  it('keeps native stream transformations and async iteration',async()=>{
    const r = await run(`const source = ReadableStream.from((async function*(){yield 1; yield 2;})());
const stream = source.pipeThrough(new TransformStream({transform(value,controller){controller.enqueue(value*2);}}));
const result=[]; for await (const value of stream) result.push(value);`);
    expect(r.error).toBeUndefined(); expect(r.result).toEqual([2,4]);
  });
  it('preloads fixtures before native imported modules initialize and preserves their URLs',async()=>{
    const helper=join(directory,'native-import.ts');
    writeFileSync(helper,`export const reply=await (await fetch('https://invalid.test/init')).json(); export const url=import.meta.url;`);
    const r=await run(`import {reply,url} from './native-import.ts'; const result={reply,url};`,{'http:https://invalid.test/init':{answer:42}});
    expect(r.error).toBeUndefined();
    expect(r.result).toMatchObject({reply:{answer:42}});
    expect((r.result as any).url).toContain('/native-import.ts');
  });
  it('uses explicit HTTP fixtures as native Responses and denies imported network calls',async()=>{
    const r = await run(`const response = await fetch('https://invalid.test'); const result = {status:response.status,body:await response.json(),native:response instanceof Response};`,{'http:https://invalid.test':{answer:42}});
    expect(r.error).toBeUndefined(); expect(r.result).toEqual({status:200,body:{answer:42},native:true});
    let connected=false;
    const server=createServer(socket=>{connected=true;socket.end();});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {
      const address=server.address() as {port:number};
      const blocked = await run(`import {connect} from 'node:net'; await new Promise((resolve,reject)=>connect(${address.port},'127.0.0.1').on('connect',resolve).on('error',reject));`);
      expect(blocked.error).toMatch(/EPERM|ECONNREFUSED|Operation not permitted|denied/i);
      expect(connected).toBe(false);
    } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }

  });
  it('times out unresolved async operations and stops native process descendants',async()=>{
    const blocked = await run('await new Promise(()=>{setInterval(()=>{},100);});');
    expect(blocked.error).toContain('exceeded 3 seconds');
    const r = await run(`import {spawn} from 'node:child_process'; const child=spawn(process.execPath,['-e','setInterval(()=>{},100)'],{stdio:'ignore'}); const result=child.pid;`);
    expect(r.error).toBeUndefined();
    await new Promise(resolve=>setTimeout(resolve,150));
    expect(()=>process.kill(r.result as number,0)).toThrow();
  },10000);
  it('inventories native APIs and editor declaration gaps without executing application code',async()=>{
    const r = await scratchCompatibility(executable,resolve('.'));
    expect(r.inventory.globals.ReadableStream?.members).toContain('from');
    expect(r.inventory.modules['node:fs']).not.toHaveProperty('unavailable');
    expect(r.missingDeclarations).not.toContain('globalThis.ReadableStream.from');
    expect(r.missingRuntimeApis).toEqual([]);
    writeFileSync(join('/private/tmp',`tracelight-scratch-${r.inventory.runtime}-compatibility.json`),JSON.stringify({...r,libraries:r.libraries.map(l=>({path:l.path}))},null,2));
  },20000);
  it('matches Bun APIs and runtime versions instead of installing synthetic globals',async()=>{
    const isBun = executable===bun;
    const r = await run(isBun?`await Bun.write('bun.txt','native Bun'); const result={text:await Bun.file('bun.txt').text(),runtime:process.versions.bun};`:`const result={bun:typeof Bun,runtime:process.versions.node};`);
    expect(r.error).toBeUndefined();
    if(isBun) expect(r.result).toMatchObject({text:'native Bun'});
    else expect(r.result).toMatchObject({bun:'undefined',runtime:process.versions.node});
  });
});
