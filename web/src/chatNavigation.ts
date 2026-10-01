export interface ChatLocation {
  account_id: string
  account_email?: string
  space_id: string
  thread_id: string
}
export interface ChatNavigation {
  revision: number
  unavailable?: boolean
  active: ChatLocation | null
  threads: Record<string, string>
}
export function stableAccountId(account: { user_id?: string; user_email?: string }): string {
  return account.user_id?.trim() || account.user_email?.trim().toLowerCase() || ''
}
export function chatSpaceKey(accountId: string, spaceId: string): string {
  return JSON.stringify([accountId, spaceId])
}
export function locationKey(location: ChatLocation): string {
  return chatSpaceKey(location.account_id, location.space_id)
}
export interface WorkspaceActivity {
  hasMessages: boolean | null
  lastMessageAt: number
  chatCount: number
  checkedAt: number
}
export function activityGroup(activity?: WorkspaceActivity): number {
  return activity?.hasMessages === true ? 0 : activity?.hasMessages === false ? 2 : 1
}
export function sortChatSpaces<T extends { key: string; spaceName: string; accountLabel: string }>(spaces: T[], activity: Record<string, WorkspaceActivity>): T[] {
  return [...spaces].sort((a,b) =>
    activityGroup(activity[a.key]) - activityGroup(activity[b.key]) ||
    (activity[b.key]?.lastMessageAt || 0) - (activity[a.key]?.lastMessageAt || 0) ||
    a.spaceName.localeCompare(b.spaceName, 'ru', { numeric: true, sensitivity: 'base' }) ||
    a.accountLabel.localeCompare(b.accountLabel, 'ru', { sensitivity: 'base' }) || a.key.localeCompare(b.key))
}

// null means "still loading". A missing saved target is NOT a reason to pick
// the first row: ordering/availability must never silently change the account.
export function resolveInitialChatSpace(savedKey: string, availableKeys: string[], ready: boolean): string | null {
  if (!ready) return null
  return savedKey || availableKeys[0] || null
}
