// Server-driven auto-pay.
//
// Everything (enabled, target plan, country, scan interval, per-space flags
// and the saved card) now lives on the BACKEND in accounts/.autopay.json and
// is paid by a background scheduler in Go. That means auto-pay keeps working
// even when the dashboard tab / browser is closed. The browser only reads and
// edits the config via /admin/autopay; it no longer charges anything itself.
//
// The scan interval is configured in SECONDS (minimum 5s).

export interface ServerAutoPayConfig {
  enabled: boolean
  plan: string
  country: string
  interval_seconds: number
  has_card: boolean
  card_brand: string
  card_last4: string
  spaces: Record<string, boolean>
  last_run: string
  log: string[]
}

export interface AutoPayCardInput {
  number: string
  exp_month: string
  exp_year: string
  cvc: string
}

export interface AutoPayPatch {
  enabled?: boolean
  plan?: string
  country?: string
  interval_seconds?: number
  spaces?: Record<string, boolean>
  space?: { id: string; on: boolean }
  card?: AutoPayCardInput
  clear_card?: boolean
}

export const MIN_INTERVAL_SECONDS = 5

// Clamp the scan interval to a sane range: 5s floor, 24h ceiling.
export function clampIntervalSeconds(v: unknown): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10)
  if (!Number.isFinite(n) || n <= 0) return 60
  return Math.min(Math.max(Math.round(n), MIN_INTERVAL_SECONDS), 86400)
}

export async function fetchAutoPayConfig(): Promise<ServerAutoPayConfig> {
  const resp = await fetch('/admin/autopay', { credentials: 'same-origin' })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return resp.json()
}

export async function updateAutoPayConfig(patch: AutoPayPatch): Promise<ServerAutoPayConfig> {
  const resp = await fetch('/admin/autopay', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(patch),
  })
  if (!resp.ok) {
    const text = await resp.text()
    let msg = `HTTP ${resp.status}`
    if (text) {
      try { const d = JSON.parse(text); if (d && typeof d.error === 'string') msg = d.error } catch { /* ignore */ }
    }
    throw new Error(msg)
  }
  return resp.json()
}

export async function runAutoPayNow(): Promise<{ started: boolean }> {
  const resp = await fetch('/admin/autopay/run', { method: 'POST', credentials: 'same-origin' })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return resp.json()
}

export interface PaySpaceInput {
  token_v2: string
  space_id: string
  plan: string
  country: string
}

export interface PaySpaceResult {
  ok?: boolean
  email?: string
  plan?: string
  error?: string
}

// Pay a single workspace using the card SAVED on the server (from the last
// auto-pay setup). Lets the manual "Оплатить" modal charge a workspace without
// re-typing the card — the server re-tokenizes the saved card freshly for
// this space, exactly like auto-pay does.
export async function paySpaceWithSavedCard(input: PaySpaceInput): Promise<PaySpaceResult> {
  const resp = await fetch('/admin/autopay/pay-space', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(input),
  })
  const text = await resp.text()
  let data: PaySpaceResult = {}
  try { data = text ? JSON.parse(text) : {} } catch { data = {} }
  if (!resp.ok || data.error) return { error: data.error || `HTTP ${resp.status}` }
  return data
}
