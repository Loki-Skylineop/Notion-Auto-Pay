import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

// Compile the pure TS helper in memory; no extra test framework or live API calls.
const source = readFileSync(new URL('./workspaceFilters.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } })
const { isFreeWorkspace, getFreeOnlyAccounts, isMonthlyExhausted, getMonthlyExhaustedAccounts } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'))

test('Free aliases and case/whitespace normalization', () => {
  for (const tier of ['free', 'personal', ' Free ', 'PERSONAL']) {
    assert.equal(isFreeWorkspace({ plan_type: tier, is_subscribed: false }), true)
  }
})
test('Paid, unknown and category-only plans are never Free', () => {
  for (const tier of ['plus', 'pro', 'personal_pro', 'team', 'business', 'enterprise', 'education', 'unknown', '', undefined]) {
    assert.equal(isFreeWorkspace({ plan_type: tier, is_subscribed: false }), false)
  }
})
test('Subscribed flag wins over a stale Free tier', () => {
  assert.equal(isFreeWorkspace({ plan_type: 'free', is_subscribed: true }), false)
  assert.equal(isFreeWorkspace({ plan_type: 'personal', is_subscribed: true }), false)
})
test('Bulk remove selects only non-empty accounts where every space is Free', () => {
  const free = { email: 'free', spaces: [{ plan_type: 'free' }, { plan_type: 'personal' }] }
  const mixed = { email: 'mixed', spaces: [{ plan_type: 'free' }, { plan_type: 'business' }] }
  const paid = { email: 'paid', spaces: [{ plan_type: 'plus' }] }
  const unknown = { email: 'unknown', spaces: [{ plan_type: 'free' }, {}] }
  const empty = { email: 'empty', spaces: [] }
  const missing = { email: 'missing' }
  const subscribed = { email: 'subscribed', spaces: [{ plan_type: 'free', is_subscribed: true }] }
  const accounts = [free, mixed, paid, unknown, empty, missing, subscribed]
  assert.deepEqual(getFreeOnlyAccounts(accounts), [free])
  assert.equal(accounts.length, 7)
  assert.equal(mixed.spaces.length, 2)
})
test('Bulk hide shares the individual remove callback and has no show toggle', () => {
  const component = readFileSync(new URL('./components/WorkspacePool.tsx', import.meta.url), 'utf8')
  assert.ok(component.includes('for (const acc of targets) onRemoveAccount(acc.user_email || acc.token_v2)'))
  assert.ok(component.includes('onRemove={() => onRemoveAccount(key)}'))
  assert.ok(!component.includes('Показать Free'))
  assert.ok(!component.includes('nmp_hide_free_workspaces'))
})

test('Monthly uses the billing window only, without rounding 99.99% to full', () => {
  const full = {rate_limit_ok:true, period_used:100, period_limit:100}
  assert.equal(isMonthlyExhausted(full), true)
  assert.equal(isMonthlyExhausted({...full,period_used:101}), true)
  for (const s of [{...full,period_used:99.99,rolling_used:100}, {...full,rate_limit_ok:false}, {...full,period_limit:0}, {...full,period_used:NaN}, {...full,period_limit:Infinity}, {...full,period_end_ms:1}, {}]) assert.equal(isMonthlyExhausted(s), false)
})
test('Monthly removes one row per email only when every workspace is full and known', () => {
  const full={rate_limit_ok:true,period_used:100,period_limit:100}
  const a={user_email:'A@example.com',spaces:[full,full]}
  const mixed={user_email:'mixed@example.com',spaces:[full,{...full,period_used:50}]}
  const unknown={user_email:'unknown@example.com',spaces:[full,{}]}
  assert.deepEqual(getMonthlyExhaustedAccounts([a,{...a,user_email:'a@EXAMPLE.com'},mixed,unknown,{user_email:'empty@example.com',spaces:[]},{spaces:[full]}]),[a])
})
