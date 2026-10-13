/** Explicit fixtures and value capture; all other APIs belong to the selected native process. */
export const scratchEnvironment = String.raw`
const __data=JSON.parse(__scratchPayload);
const __writeResult=require('node:fs').writeSync;
function __finish(error,result){__writeResult(3,JSON.stringify({result:__clone(result),values:__values,output:__output,missingMocks:__missingMocks,caps:__caps,...(error?{error}:{})})+'\n');}
      const __inputs=__data.inputs,__mocks=__data.mocks,__values=[],__output=[],__missingMocks=[],__caps={values:false,output:false};
      function __missing(path,message){if(!__missingMocks.includes(path))__missingMocks.push(path);throw Error(message);}
      const __clone=x=>{const seen=new WeakSet();return x===undefined?undefined:JSON.parse(JSON.stringify(x,(key,value)=>{if(typeof value==='function')return {__scratchUnavailable:'function'};if(typeof value==='bigint')return String(value)+'n';if(value&&typeof value==='object'){if(seen.has(value))return {__scratchUnavailable:'circular'};seen.add(value);}return value;}));};
      const __capture=(name,line,value)=>{if(__values.length<200)__values.push({name,line,value:__clone(value)});else __caps.values=true;};
      const console=Object.create(Object.getPrototypeOf(globalThis.console),Object.getOwnPropertyDescriptors(globalThis.console));
      const __log=(...xs)=>{if(__output.length<100)__output.push(__clone(xs));else __caps.output=true;};
      Object.assign(console,{log:__log,error:__log,warn:__log,info:__log,debug:__log});
      function __hydrate(x,name){
        if(x&&x.__scratchUnavailable){if(name in __mocks)return x.__scratchUnavailable==='function'?(...args)=>__clone(__mocks[name]):__clone(__mocks[name]);return new Proxy(function(){},{get(){return __missing(name,'Unavailable captured value: '+name+'. Add a mock.');},apply(){return __missing(name,'Unavailable captured function: '+name+'. Add a mock.');}});}
        if(Array.isArray(x))return x.map((v,i)=>__hydrate(v,name+'.'+i));
        if(x&&typeof x==='object'){for(const k of Object.keys(x))x[k]=__hydrate(x[k],name+'.'+k);if(x.__scratchMissing){delete x.__scratchMissing;return new Proxy(x,{get(target,key){if(!(key in target))return __missing(name+'.'+String(key),'Unavailable captured property: '+name+'.'+String(key));return target[key];}});}}
        return x;
      }
      const fetch=new Proxy(globalThis.fetch,{apply:async(_target,_receiver,[url])=>{const key='http:'+String(url);if(!(key in __mocks))return __missing(key,'No HTTP mock for '+url);const body=__clone(__mocks[key]);return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});}});
      Object.assign(globalThis,{fetch,console,__finish,__capture,__clone,__hydrate,__inputs,__mocks});
`;
