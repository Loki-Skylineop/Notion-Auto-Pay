// Session-only rejection of stale responses. No account/workspace data is persisted.
import type { DiscoveredAccount } from './components/WorkspacePool'
const removedTokens = new Set<string>()
const removedEmails = new Set<string>()
const removedSpaces = new Set<string>()
export function forgetAccount(account: DiscoveredAccount) {
  removedTokens.add(account.token_v2)
  if (account.user_email) removedEmails.add(account.user_email.trim().toLowerCase())
}
export function forgetSpace(id: string) { removedSpaces.add(id) }
export function sanitizePool(accounts: DiscoveredAccount[]): DiscoveredAccount[] {
  return accounts.filter(a => !removedTokens.has(a.token_v2) && !removedEmails.has((a.user_email || '').trim().toLowerCase()))
    .map(a => ({ ...a, spaces: (a.spaces || []).filter(s => !removedSpaces.has(s.space_id)) }))
    .filter(a => a.spaces.length > 0)
}
