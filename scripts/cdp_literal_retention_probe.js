'use strict'

// Memory-only experiment in an isolated world. No login, navigation, DOM edits,
// or application globals are read/written. Never retain remote object handles.
const WS = require('ws')
const fs = require('fs')

async function main () {
  const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json()
  const target = targets.find((item) => item.type === 'page' && item.url.startsWith('http://localhost:3000/'))
  if (!target) throw new Error('No scoped localhost test page')
  const socket = new WS(target.webSocketDebuggerUrl)
  const pending = new Map()
  let id = 0
  socket.on('message', (raw) => {
    const message = JSON.parse(raw)
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result)
  })
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const next = ++id
    pending.set(next, { resolve, reject })
    socket.send(JSON.stringify({ id: next, method, params }))
  })
  try {
    const version = await send('Browser.getVersion')
    const tree = await send('Page.getFrameTree')
    const { executionContextId } = await send('Page.createIsolatedWorld', {
      frameId: tree.frameTree.frame.id, worldName: 'micro-app-memory-probe',
    })
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, contextId: executionContextId, returnByValue: true, awaitPromise: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
      return result.result.value
    }
    if (process.argv.includes('--pinia') || process.argv.includes('--pinia-vite')) {
      const vite = process.argv.includes('--pinia-vite')
      const source = fs.readFileSync(vite
        ? 'E:/work/wonder-project-vue/wonder-core-web/node_modules/.vite/deps/pinia.js'
        : 'E:/work/wonder-project-vue/wonder-core-web/node_modules/pinia/dist/pinia.prod.cjs', 'utf8')
      const start = 'const partialStore = {'
      const end = '$dispose\n  };'
      if (vite ? !source.includes(start) || !source.includes(end) : !source.includes('vueDemi.reactive(assign({}, partialStore')) {
        throw new Error('Unexpected Pinia source; do not silently patch another version')
      }
      const freshSource = vite
        ? source.replace(start, 'const partialStore = Object.assign(Object.create(Object.prototype), {').replace(end, '$dispose\n  });')
          .replace(/(["'])\.\//g, '$1http://localhost:3000/node_modules/.vite/deps/')
        : source.replace('vueDemi.reactive(assign({}, partialStore', 'vueDemi.reactive(assign(Object.create(Object.prototype), partialStore')
      await evaluate(`(async () => {
        const vue = await import('/node_modules/.vite/deps/vue.js');
        const demi = {...vue,isVue2:false,set:(o,k,v)=>{o[k]=v},del:(o,k)=>{delete o[k]}};
        function load(code) {
          const exports = {};
          new Function('exports','require','process',code)(exports,name=>name==='vue-demi'?demi:{},{env:{NODE_ENV:'production'}});
          return exports;
        }
        function install(api, id, retain=false) {
          const data = {payload:new Array(10000).fill('child')};
          const pinia = api.createPinia();
          const use = api.defineStore({id,state:()=>({theme:data}),actions:{setTheme(){}},getters:{getTheme:s=>s.theme}});
          const store = use(pinia);
          // Review: a collected state payload does not prove that the $state
          // accessor is gone. Track the getter implicated by the heap chain.
          const getter = Object.getOwnPropertyDescriptor(vue.toRaw(store),'$state').get;
          const weak = new WeakRef(getter);
          if (!retain) {
            store.$dispose();
            delete pinia.state.value[id];
          }
          api.setActivePinia(undefined);
          return {weak,base:retain?{pinia,store}:undefined};
        }
        const cases = ${vite ? `await (async()=>{
          // Preserve Vite's served dependency URLs/version queries. Raw disk
          // imports otherwise load a second, uninitialized Vue dependency.
          const response=await fetch('/node_modules/.vite/deps/pinia.js');
          if(!response.ok) throw new Error('Cannot load served Pinia module');
          const served=await response.text();
          if(!served.includes(${JSON.stringify(start)}) || !served.includes(${JSON.stringify(end)})) throw new Error('Unexpected served Pinia source');
          const candidate=served.replace(${JSON.stringify(start)},'const partialStore = Object.assign(Object.create(Object.prototype), {')
            .replace(${JSON.stringify(end)},'$dispose\\n  });')
            .replace(/(["'])\\.\\//g,'$1http://localhost:3000/node_modules/.vite/deps/')
            .replace(/(["'])\\/node_modules\\//g,'$1http://localhost:3000/node_modules/');
          const url=URL.createObjectURL(new Blob([candidate],{type:'text/javascript'}));
          try {return [
            {name:'vite-pinia-original',api:await import('/node_modules/.vite/deps/pinia.js')},
            {name:'vite-pinia-fresh-partial-store',api:await import(url)},
          ]} finally {URL.revokeObjectURL(url)}
        })()` : `[
          {name:'pinia-original',api:load(${JSON.stringify(source)})},
          {name:'pinia-fresh-target',api:load(${JSON.stringify(freshSource)})},
        ]`};
        globalThis.__memoryProbe = cases.map(({name,api})=>{
          for(let i=0;i<100;i++) install(api,'warm-'+i);
          const base=install(api,'base',true).base;
          return {name,api,base,weak:install(api,'theme').weak};
        });
        return true;
      })()`)
    } else if (process.argv.includes('--shared-shape')) await evaluate(`(() => {
      // Review: keep an active base instance and use variable-valued fields.
      // The earlier null-field probe did not reproduce the product shape.
      function literal(pinia,id,onAction,patch,reset,subscribe,dispose) {
        return {_p:pinia,$id:id,$onAction:onAction,$patch:patch,$reset:reset,$subscribe:subscribe,$dispose:dispose};
      }
      function fresh(pinia,id,onAction,patch,reset,subscribe,dispose) {
        return Object.assign(Object.create(Object.prototype),{_p:pinia,$id:id,$onAction:onAction,$patch:patch,$reset:reset,$subscribe:subscribe,$dispose:dispose});
      }
      function allocate(fn,id) {return fn({},id,()=>{},()=>{},()=>{},()=>{},()=>{})}
      function install(fn,id) {
        const data={payload:new Array(10000).fill('child')};
        const get=()=>data, set=value=>{data.value=value};
        const weak=new WeakRef(get);
        const store=allocate(fn,id);
        Object.assign(store,{theme:data,setTheme(){},getTheme:data});
        // Pinia defines an accessor pair without configurable:true.
        Object.defineProperty(store,'$state',{get,set});
        return {store,weak};
      }
      globalThis.__memoryProbe=[literal,fresh].map(fn=>{
        const base=install(fn,'base');
        for(let i=0;i<10000;i++) allocate(fn,'warm-'+i);
        return {name:fn.name,allocate:fn,base:base.store,weak:install(fn,'child').weak};
      });
      return true;
    })()`)
    else await evaluate(`(() => {
      function literal() { return {_p:null,$id:'',$onAction:null,$patch:null,$reset:null,$subscribe:null,$dispose:null} }
      function fresh() { return Object.assign(Object.create(Object.prototype), {_p:null,$id:'',$onAction:null,$patch:null,$reset:null,$subscribe:null,$dispose:null}) }
      function install(allocate) {
        const getter = new Function('const data = new Array(10000).fill("child"); return function childState() {return data}')();
        const weak = new WeakRef(getter);
        const store = allocate();
        Object.assign(store,{theme:'dark',setTheme(){},getTheme:'dark'});
        Object.defineProperty(store,'$state',{configurable:true,get:getter});
        return weak;
      }
      globalThis.__memoryProbe = [literal,fresh].map(fn=>{
        for(let i=0;i<10000;i++) fn();
        return {name:fn.name, weak:install(fn), allocate:fn};
      });
      return true;
    })()`)
    await send('Runtime.discardConsoleEntries')
    for (let index = 0; index < 3; index++) await send('HeapProfiler.collectGarbage')
    const cases = await evaluate('globalThis.__memoryProbe.map(({name,weak})=>({name,targetCollected:weak.deref()===undefined}))')
    await evaluate('delete globalThis.__memoryProbe')
    console.log(JSON.stringify({ version, cases, limitation: 'Synthetic isolated-world Chrome test, not real product Pinia acceptance.' }, null, 2))
  } finally {
    await send('Runtime.discardConsoleEntries')
    await send('Runtime.disable')
    socket.close()
  }
}

main().catch((error) => { console.error(String(error)); process.exitCode = 1 })
