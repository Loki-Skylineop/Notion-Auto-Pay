import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
const source = readFileSync(new URL('./chatNavigation.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { stableAccountId, chatSpaceKey, sortChatSpaces, resolveInitialChatSpace } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
test('identity survives token rotation and email change', () => {
  assert.equal(stableAccountId({user_id:' u1 ',user_email:'old@example.com',token_v2:'old'}), 'u1')
  assert.equal(stableAccountId({user_id:'u1',user_email:'new@example.com',token_v2:'new'}), 'u1')
  assert.equal(stableAccountId({user_email:' A@EXAMPLE.COM '}), 'a@example.com')
  assert.equal(stableAccountId({token_v2:'secret'}), '')
})
test('same workspace on different accounts never collides', () => {
  assert.notEqual(chatSpaceKey('a','space'), chatSpaceKey('b','space'))
  assert.notEqual(chatSpaceKey('a:b','c'), chatSpaceKey('a','b:c'))
})
test('hydration and unavailable saved space never choose a different account', () => {
  assert.equal(resolveInitialChatSpace('saved',['wrong'],false), null)
  assert.equal(resolveInitialChatSpace('saved',[],true), 'saved')
  assert.equal(resolveInitialChatSpace('saved',['wrong'],true), 'saved')
  assert.equal(resolveInitialChatSpace('',[],true), null)
  assert.equal(resolveInitialChatSpace('',['first'],true), 'first')
})
test('messages first by recency, unknown in middle, empty last; does not mutate input', () => {
  const spaces = ['empty','old','unknown','recent'].map(key => ({key,spaceName:key,accountLabel:'A'}))
  const activity = { empty:{hasMessages:false,lastMessageAt:999}, old:{hasMessages:true,lastMessageAt:10}, recent:{hasMessages:true,lastMessageAt:20} }
  assert.deepEqual(sortChatSpaces(spaces, activity).map(s=>s.key), ['recent','old','unknown','empty'])
  assert.deepEqual(spaces.map(s=>s.key), ['empty','old','unknown','recent'])
})
test('equal activity sorts names naturally and disambiguates account labels', () => {
  const spaces = [{key:'2b',spaceName:'Space 2',accountLabel:'B'},{key:'10',spaceName:'Space 10',accountLabel:'A'},{key:'2a',spaceName:'Space 2',accountLabel:'A'}]
  assert.deepEqual(sortChatSpaces(spaces,{}).map(s=>s.key), ['2a','2b','10'])
})
