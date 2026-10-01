// Only explicit Free tiers; unknown plans and paid subscriptions stay visible.
export function isFreeWorkspace(space: { plan_type?: string; is_subscribed?: boolean }): boolean {
  const tier = (space.plan_type || '').trim().toLowerCase()
  return !space.is_subscribed && (tier === 'free' || tier === 'personal')
}

// Match the existing account-level "Remove from list" action. Never remove
// mixed-plan accounts, empty accounts, or accounts with unclassified spaces.
export function getFreeOnlyAccounts<T extends { spaces?: { plan_type?: string; is_subscribed?: boolean }[] }>(accounts: T[]): T[] {
  return accounts.filter((account) => !!account.spaces?.length && account.spaces.every(isFreeWorkspace))
}

export interface MonthlyQuota {
  rate_limit_ok?: boolean
  period_used?: number
  period_limit?: number
  period_end_ms?: number
}
export function isMonthlyExhausted(space: MonthlyQuota, now = Date.now()): boolean {
  return space.rate_limit_ok === true &&
    typeof space.period_used === 'number' && Number.isFinite(space.period_used) &&
    typeof space.period_limit === 'number' && Number.isFinite(space.period_limit) && space.period_limit > 0 &&
    space.period_used >= space.period_limit &&
    !(typeof space.period_end_ms === 'number' && space.period_end_ms > 0 && space.period_end_ms <= now)
}
// Account removal affects ALL its spaces: preserve any usable or unknown one.
export function getMonthlyExhaustedAccounts<T extends { user_email?: string; spaces: MonthlyQuota[] }>(accounts: T[], now = Date.now()): T[] {
  const seen = new Set<string>()
  return accounts.filter(a => {
    const email = a.user_email?.trim().toLowerCase()
    if (!email || seen.has(email) || !a.spaces?.length || !a.spaces.every(s => isMonthlyExhausted(s, now))) return false
    seen.add(email)
    return true
  })
}
