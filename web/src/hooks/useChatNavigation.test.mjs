import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

// A deterministic hook lifecycle harness, with no browser, live cookies or
// upstream requests. Exercises effects and asynchronous writes, not source text.
function harness(fetchImpl, initialCache = {}) {
  const slots = [], effects = [], cleanups = []
  let index = 0
  const storage = new Map(Object.entries(initialCache))
  const react = {
    useState(initial) {
      const at = index++
      if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial
      return [slots[at], next => { slots[at] = typeof next === 'function' ? next(slots[at]) : next }]
    },
    useRef(initial) { const at = index++; if (!(at in slots)) slots[at] = {current:initial}; return slots[at] },
    useCallback(fn, deps) {
      const at = index++, previous = slots[at]
      if (!previous || deps.some((d,i) => !Object.is(d,previous.deps[i]))) slots[at] = {fn,deps}
      return slots[at].fn
    },
    useEffect(fn, deps) {
      const at = index++, previous = slots[at]
      if (!previous || deps.some((d,i) => !Object.is(d,previous[i]))) { slots[at]=deps; effects.push(() => { cleanups[at]?.(); cleanups[at]=fn() }) }
    },
  }
  const source = readFileSync(new URL('./useChatNavigation.ts', import.meta.url), 'utf8')
  const js = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  const sandbox = {exports:{},fetch:fetchImpl,localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},require:name=>name==='react'?react:{locationKey:l=>JSON.stringify([l.account_id,l.space_id])}}
  vm.runInNewContext(js,sandbox)
  return {
    render(owner='alice') {index=0;const value=sandbox.exports.useChatNavigation(owner);while(effects.length)effects.shift()();return value},
    unmount() {for(const cleanup of cleanups)cleanup?.()},
    cache: storage,
  }
}
const drain = async () => {for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve))}
const reply = (value,status=200) => ({ok:status<400,status,json:async()=>value})
const location = (space,thread='') => ({account_id:'notion-alice',space_id:space,thread_id:thread})

test('mount loads server selection without writing an empty choice',async()=>{
  const requests=[]
  const saved=location('saved-space','saved-thread')
  const h=harness(async(url,opts)=>{requests.push(opts.method||'GET');return reply({revision:7,active:saved,threads:{'["notion-alice","saved-space"]':'saved-thread'}})})
  h.render();await drain();const state=h.render()
  assert.equal(state.ready,true);assert.equal(state.data.active.space_id,'saved-space')
  assert.deepEqual(requests,['GET']);h.unmount()
})
test('failed server load only uses this login cache, never global or another login',async()=>{
  const h=harness(async()=>{throw Error('offline')},{'nmp_chat_navigation_v2:bob':JSON.stringify({revision:9,active:location('bob-space'),threads:{}}),'nmp_chat_active_space':'global-space'})
  h.render();await drain();const state=h.render()
  assert.equal(state.data.active,null);assert.equal(state.ready,true);assert.match(state.error,/не загружен/);h.unmount()
})
test('rapid navigation is serialized and an old response cannot undo newest choice',async()=>{
  let finishFirst, puts=0
  const h=harness(async(url,opts)=>{
    if(!opts.method)return reply({revision:0,active:null,threads:{}})
    puts++;const body=JSON.parse(opts.body)
    if(puts===1)await new Promise(resolve=>{finishFirst=resolve})
    return reply({revision:puts,active:body.location,threads:{}})
  })
  h.render();await drain();let state=h.render()
  state.remember(location('a','ta'));state.remember(location('b','tb'));await drain()
  assert.equal(puts,1);assert.equal(h.render().data.active.space_id,'b')
  finishFirst();await drain();state=h.render()
  assert.equal(puts,2);assert.equal(state.data.active.space_id,'b')
  assert.equal(state.data.threads['["notion-alice","a"]'],'ta')
  assert.equal(state.data.threads['["notion-alice","b"]'],'tb');h.unmount()
})
test('revision conflict retries against the server revision',async()=>{
  const versions=[]
  const h=harness(async(url,opts)=>{
    if(!opts.method)return reply({revision:2,active:null,threads:{}})
    const body=JSON.parse(opts.body);versions.push(body.revision)
    return versions.length===1?reply({revision:5},409):reply({revision:6,active:body.location,threads:{}})
  })
  h.render();await drain();h.render().remember(location('chosen'));await drain()
  assert.deepEqual(versions,[2,5]);assert.equal(h.render().error,'');h.unmount()
})
test('queued navigation is not sent after logout/unmount',async()=>{
  let puts=0
  const h=harness(async(url,opts)=>{if(opts.method)puts++;return reply({revision:0,active:null,threads:{}})})
  h.render();await drain();h.render().remember(location('chosen'));h.unmount();await drain()
  assert.equal(puts,0)
})
