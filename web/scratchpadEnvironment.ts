/** VM bootstrap is passed as data, never nested inside generated worker source. */
export const scratchEnvironment = String.raw`
const __data=JSON.parse(globalThis.__scratchPayload);
delete globalThis.__scratchPayload;
      ((bridge)=>{delete globalThis.__nativeEncoding;const call=data=>{const r=JSON.parse(bridge(JSON.stringify(data)));if(r.error)throw Error(r.error);return r.value;};
      globalThis.performance={now:()=>call({op:'clock'}).now,timeOrigin:call({op:'clock'}).timeOrigin};
      globalThis.TextEncoder=class TextEncoder {
        get encoding(){return 'utf-8';}
        encode(value=''){return new Uint8Array(call({op:'encode',text:String(value)}));}
        encodeInto(value,destination){let read=0,written=0;for(const character of String(value)){const bytes=this.encode(character);if(written+bytes.length>destination.length)break;destination.set(bytes,written);written+=bytes.length;read+=character.length;}return {read,written};}
      };
      globalThis.TextDecoder=class TextDecoder {
        constructor(label='utf-8',options={}){Object.assign(this,call({op:'decoder',label,options}));}
        decode(input=new Uint8Array(),options={}){const bytes=new Uint8Array(input.buffer??input,input.byteOffset??0,input.byteLength??input.length);return call({op:'decode',id:this.id,bytes:Array.from(bytes),options});}
      };
      globalThis.URLSearchParams=class URLSearchParams {
        constructor(input=''){this._text=call({op:'params',input:input instanceof URLSearchParams?input.toString():input}).text;}
        _call(method,args=[]){const r=call({op:'params',input:this._text,method,args});this._text=r.text;this._change?.(r.text);return r.result;}
        append(...args){this._call('append',args);}delete(...args){this._call('delete',args);}get(...args){return this._call('get',args);}getAll(...args){return this._call('getAll',args);}has(...args){return this._call('has',args);}set(...args){this._call('set',args);}sort(){this._call('sort');}
        get size(){return [...this].length;}toString(){return this._text;}entries(){return call({op:'params',input:this._text}).entries[Symbol.iterator]();}keys(){return [...this].map(e=>e[0])[Symbol.iterator]();}values(){return [...this].map(e=>e[1])[Symbol.iterator]();}[Symbol.iterator](){return this.entries();}forEach(callback,thisArg){for(const [key,value]of this)callback.call(thisArg,value,key,this);}
      };
      globalThis.URL=class URL {
        constructor(input,base){this._data=call({op:'url',input:String(input),base:base===undefined?undefined:String(base)});this._params=new URLSearchParams(this._data.search);this._params._change=text=>this._update('search',text);}
        _update(key,value){this._data=call({op:'url',input:this.href,key,value:String(value)});this._params._text=this._data.search.replace(/^\?/,'');}
        get searchParams(){return this._params;}toString(){return this.href;}toJSON(){return this.href;}static canParse(input,base){try{new URL(input,base);return true;}catch{return false;}}static parse(input,base){try{return new URL(input,base);}catch{return null;}}
      };
      for(const key of ['href','origin','protocol','username','password','host','hostname','port','pathname','search','hash'])Object.defineProperty(URL.prototype,key,{get(){return this._data[key];},...(key==='origin'?{}:{set(value){this._update(key,value);}})});
      })(globalThis.__nativeEncoding);
      function structuredClone(value){const seen=new Map();function copy(x){if(typeof x==='function'||typeof x==='symbol')throw Error('DataCloneError: value cannot be cloned');if(x===null||typeof x!=='object')return x;if(seen.has(x))return seen.get(x);let out;if(x instanceof Date)out=new Date(x);else if(x instanceof RegExp)out=new RegExp(x.source,x.flags);else if(x instanceof ArrayBuffer)out=x.slice(0);else if(ArrayBuffer.isView(x))out=x instanceof DataView?new DataView(copy(x.buffer),x.byteOffset,x.byteLength):new x.constructor(copy(x.buffer),x.byteOffset,x.length);else out=x instanceof Map?new Map():x instanceof Set?new Set():Array.isArray(x)?[]:{};seen.set(x,out);if(x instanceof Map)for(const [k,v]of x)out.set(copy(k),copy(v));else if(x instanceof Set)for(const v of x)out.add(copy(v));else if(!(x instanceof Date||x instanceof RegExp||x instanceof ArrayBuffer||ArrayBuffer.isView(x)))for(const k of Object.keys(x))out[k]=copy(x[k]);return out;}return copy(value);}
      const __inputs=__data.inputs,__mocks=__data.mocks,__values=[],__output=[];
      const __clone=x=>{const seen=new WeakSet();return x===undefined?undefined:JSON.parse(JSON.stringify(x,(key,value)=>{if(typeof value==='function')return {__scratchUnavailable:'function'};if(typeof value==='bigint')return String(value)+'n';if(value&&typeof value==='object'){if(seen.has(value))return {__scratchUnavailable:'circular'};seen.add(value);}return value;}));};
      const __capture=(name,line,value)=>{if(__values.length<200)__values.push({name,line,value:__clone(value)});};
      const console={log:(...xs)=>{if(__output.length<100)__output.push(__clone(xs));},error:(...xs)=>console.log(...xs)};
      function __hydrate(x,name){
        if(x&&x.__scratchUnavailable){if(name in __mocks)return (...args)=>__clone(__mocks[name]);return new Proxy(function(){},{get(){throw Error('Unavailable captured value: '+name+'. Add a mock.');},apply(){throw Error('Unavailable captured function: '+name+'. Add a mock.');}});}
        if(Array.isArray(x))return x.map((v,i)=>__hydrate(v,name+'.'+i));
        if(x&&typeof x==='object'){for(const k of Object.keys(x))x[k]=__hydrate(x[k],name+'.'+k);if(x.__scratchMissing){delete x.__scratchMissing;return new Proxy(x,{get(target,key){if(!(key in target))throw Error('Unavailable captured property: '+name+'.'+String(key));return target[key];}});}}
        return x;
      }
      const fetch=async(url)=>{const key='http:'+String(url);if(!(key in __mocks))throw Error('No HTTP mock for '+url);const body=__clone(__mocks[key]);return {ok:true,status:200,json:async()=>__clone(body),text:async()=>JSON.stringify(body)};};
      Object.assign(globalThis,{fetch,console,structuredClone});
`;
