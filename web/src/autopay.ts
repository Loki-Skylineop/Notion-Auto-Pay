// Shared, browser-local config for workspace auto-refresh and auto-pay.
// There is no backend persistence for these preferences — everything lives in
// localStorage, so the settings are per-browser. The dashboard discovery /
// checkout endpoints are reused as-is.

export interface RefreshConfig {
  // When on, periodically re-discover every account's workspaces. This is what
  // keeps the plan tier and workspace count fresh, and it is also the moment
  // the auto-pay scan runs.
  autoRefresh: boolean
  // Minutes between automatic refresh cycles.
  intervalMin: number
}

export interface AutoPayConfig {
  // Master switch. When on, each refresh cycle scans the pool and pays any
  // workspace that is still on a free tier AND has its per-workspace "Авто"
  // checkbox enabled, using the saved card + target plan below.
  enabled: boolean
  // Target Notion plan id (one of the SubscribeModal PLANS ids).
  plan: string
  // Billing country (ISO-2) forwarded to the checkout endpoint.
  country: string
  // Saved Stripe PaymentMethod id (pm_...) created once from the card form.
  pmId: string
  // Display-only metadata about the saved card.
  brand: string
  last4: string
  savedAt: number
}

const REFRESH_KEY = 'nmp_ws_refresh'
const AUTOPAY_KEY = 'nmp_autopay'
const SPACES_KEY = 'nmp_autopay_spaces'
const PAID_KEY = 'nmp_autopay_done'

export const DEFAULT_REFRESH: RefreshConfig = { autoRefresh: false, intervalMin: 30 }

export const DEFAULT_AUTOPAY: AutoPayConfig = {
  enabled: false,
  plan: 'business_monthly_eur_202505',
  country: 'DE',
  pmId: '',
  brand: '',
  last4: '',
  savedAt: 0,
}

export function clampInterval(v: unknown): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_REFRESH.intervalMin
  // Keep it sane: 1 minute floor, 24h ceiling.
  return Math.min(Math.max(Math.round(n), 1), 1440)
}

export function loadRefreshConfig(): RefreshConfig {
  try {
    const raw = localStorage.getItem(REFRESH_KEY)
    if (!raw) return { ...DEFAULT_REFRESH }
    const parsed = JSON.parse(raw) as Partial<RefreshConfig>
    return {
      autoRefresh: !!parsed.autoRefresh,
      intervalMin: clampInterval(parsed.intervalMin),
    }
  } catch {
    return { ...DEFAULT_REFRESH }
  }
}

export function saveRefreshConfig(cfg: RefreshConfig): void {
  try { localStorage.setItem(REFRESH_KEY, JSON.stringify(cfg)) } catch { /* ignore */ }
}

export function loadAutoPayConfig(): AutoPayConfig {
  try {
    const raw = localStorage.getItem(AUTOPAY_KEY)
    if (!raw) return { ...DEFAULT_AUTOPAY }
    const parsed = JSON.parse(raw) as Partial<AutoPayConfig>
    return { ...DEFAULT_AUTOPAY, ...parsed }
  } catch {
    return { ...DEFAULT_AUTOPAY }
  }
}

export function saveAutoPayConfig(cfg: AutoPayConfig): void {
  try { localStorage.setItem(AUTOPAY_KEY, JSON.stringify(cfg)) } catch { /* ignore */ }
}

export function loadSpaceFlags(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(SPACES_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

export function saveSpaceFlags(flags: Record<string, boolean>): void {
  try { localStorage.setItem(SPACES_KEY, JSON.stringify(flags)) } catch { /* ignore */ }
}

// Spaces we have already auto-paid (spaceId -> timestamp). This guard is what
// prevents the periodic loop from charging the same workspace twice before the
// new tier propagates back from Notion.
export function loadPaidSet(): Record<string, number> {
  try {
    const raw = localStorage.getItem(PAID_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {}
  } catch {
    return {}
  }
}

export function savePaidSet(set: Record<string, number>): void {
  try { localStorage.setItem(PAID_KEY, JSON.stringify(set)) } catch { /* ignore */ }
}

// A workspace is eligible for auto-pay only when the backend does NOT report it
// as subscribed and its tier is empty/free/personal. We deliberately exclude
// 'team' and other categories so an ambiguous workspace is never charged.
export function isFreeTier(tier?: string, isSubscribed?: boolean): boolean {
  if (isSubscribed) return false
  const t = (tier || '').toLowerCase()
  return t === '' || t === 'free' || t === 'personal'
}
