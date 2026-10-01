import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
const source=readFileSync(new URL('./authRecovery.ts',import.meta.url),'utf8')
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText
const {createAuthRecovery}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'))
const drain=async()=>{for(let i=0;i<4;i++)await new Promise(r=>setImmediate(r))}
function setup({status={required:true,authenticated:true},cache=new Map(),http=401,storageFail=false,now=1000000}={}) {
 const calls=[];const events={reload:0,expired:0,blocked:0}
 const native=async(input,init)=>{
  calls.push({input,init})
  return String(input)==='/dashboard/auth/check'?new Response(JSON.stringify(status),{status:200}):new Response('{"error":"unauthorized"}',{status:http})
 }
 const wrapped=createAuthRecovery({fetch:native,origin:'https://example.com',now:()=>now,storage:{getItem:k=>{if(storageFail)throw Error('blocked');return cache.get(k)||null},setItem:(k,v)=>cache.set(k,v)},reload:()=>events.reload++,onExpired:()=>events.expired++,onBlocked:()=>events.blocked++})
 return {wrapped,calls,events,cache}
}
test('protected 401 automatically reloads once; DELETE is never replayed and body remains readable',async()=>{
 const h=setup();const response=await h.wrapped('/admin/accounts/a',{method:'DELETE'});await drain()
 assert.equal(h.events.reload,1);assert.equal(h.calls.filter(c=>c.init?.method==='DELETE').length,1)
 assert.deepEqual(await response.json(),{error:'unauthorized'})
 await h.wrapped('/admin/me');await drain();assert.equal(h.events.reload,1)
})
test('concurrent unauthorized polls coalesce to one session probe/reload',async()=>{
 const h=setup();await Promise.all(Array.from({length:20},()=>h.wrapped('/admin/chat/history')));await drain()
 assert.equal(h.events.reload,1);assert.equal(h.calls.filter(c=>c.input==='/dashboard/auth/check').length,1)
})
test('guard survives a page reload and stops a repeated 401 loop',async()=>{
 const first=setup();await first.wrapped('/admin/me');await drain()
 const second=setup({cache:first.cache,now:1000001});await second.wrapped('/admin/me');await drain()
 assert.equal(second.events.reload,0);assert.equal(second.events.blocked,1)
 const later=setup({cache:first.cache,now:1120001});await later.wrapped('/admin/me');await drain();assert.equal(later.events.reload,1)
})
test('expired session shows login rather than reload/replay or bypass authentication',async()=>{
 const h=setup({status:{required:true,authenticated:false}});await h.wrapped('/admin/me');await drain()
 assert.equal(h.events.expired,1);assert.equal(h.events.reload,0)
})
test('wrong login password, external 401, and permission 403 never reload',async()=>{
 const h=setup();await h.wrapped('/dashboard/auth/login',{method:'POST'});await h.wrapped('https://external.com/admin/me');await drain();assert.equal(h.events.reload,0);assert.equal(h.calls.length,2)
 const forbidden=setup({http:403});await forbidden.wrapped('/admin/users');await drain();assert.equal(forbidden.events.reload,0);assert.equal(forbidden.calls.length,1)
})
test('restricted sessionStorage cannot cause an infinite reload loop',async()=>{
 const h=setup({storageFail:true});await h.wrapped('/admin/me');await drain();assert.equal(h.events.reload,0);assert.equal(h.events.blocked,1)
})
test('normal JSON and streaming responses do not trigger a session probe',async()=>{
 const h=setup({http:200});const response=await h.wrapped('/admin/chat/stream',{method:'POST'});assert.equal(await response.text(),'{"error":"unauthorized"}');await drain();assert.equal(h.calls.length,1);assert.equal(h.events.reload,0)
})
