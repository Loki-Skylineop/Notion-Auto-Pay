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
