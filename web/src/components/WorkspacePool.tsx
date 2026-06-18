import { useState, useEffect, useRef, useCallback } from 'react'
import type { WorkspaceInfo as BaseWorkspaceInfo } from '../api'
import { discoverWorkspaces } from '../api'
import { SubscribeModal, PLANS } from './SubscribeModal'
import { AutoPaySettings } from './AutoPaySettings'
import {
  fetchAutoPayConfig, updateAutoPayConfig, runAutoPayNow,
  clampIntervalSeconds, type ServerAutoPayConfig, type AutoPayPatch,
} from '../autopay'

// The backend forwards an optional space `icon` (emoji or image URL), a
// `plan_name` (marketed plan name from getSubscriptionData), and the premium
// AI credit budget (`ai_credits_used` / `ai_credits_limit`, e.g. 0 of 400).
// They aren't part of the base API type, so we widen it here without touching
// the shared def.
export type WorkspaceInfo = BaseWorkspaceInfo & {
  icon?: string
  plan_name?: string
  ai_credits_used?: number
  ai_credits_limit?: number
}

export interface DiscoveredAccount {
  user_id?: string
  user_name?: string
  user_email?: string
  token_v2: string
  spaces: WorkspaceInfo[]
}

// Same localStorage key App uses to hydrate the pool, so a refresh here keeps
// the persisted copy current across reloads.
const STORAGE_KEY = 'nmp_discovered_workspaces'

const PLAN_LABELS: Record<string, string> = {
  free: 'Free',
  personal: 'Free',
  plus: 'Plus',
  pro: 'Plus',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  education: 'Education',
}

function planLabel(plan?: string): string {
  const p = (plan || 'free').toLowerCase()
  if (PLAN_LABELS[p]) return PLAN_LABELS[p]
  return plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : 'Free'
}

// Prefer Notion's marketed plan name when present (e.g. "Enterprise Limited
// Plan"), otherwise fall back to the tier label.
function displayPlan(space: WorkspaceInfo): string {
  if (space.plan_name && space.plan_name.trim()) return space.plan_name.trim()
  return planLabel(space.plan_type)
}

// --- inline icons (no extra deps) ---
function IconRefreshSmall({ spinning }: { spinning?: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={spinning ? 'animate-spin' : ''}>
      <path d="M21 2v6h-6" />
      <path d="M21 13a9 9 0 1 1-3-7.7L21 8" />
    </svg>
  )
}

function IconGear() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

function IconDots() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="5" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="12" cy="19" r="1.6" />
    </svg>
  )
}

function IconClock() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
    </svg>
  )
}

function IconCard() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="5" width="20" height="14" rx="2" /><line x1="2" y1="10" x2="22" y2="10" />
    </svg>
  )
}

function IconBolt() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
      <path d="M13 2 4.5 13.5H11l-1 8.5L19.5 10H12z" />
    </svg>
  )
}

function IconAlertTri() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-amber-400 shrink-0 mt-px">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}

// Per-workspace premium AI credit gauge (mockup TokenBar). Hidden when the
// space has no premium AI budget (limit 0).
function AICreditsBar({ used, limit }: { used?: number; limit?: number }) {
  if (!limit || limit <= 0) return null
  const u = Math.max(0, Math.min(used ?? 0, limit))
  const remaining = limit - u
  const remainPct = Math.round((remaining / limit) * 100)
  const barCls = remainPct > 50 ? 'bg-emerald-500' : remainPct > 20 ? 'bg-amber-500' : 'bg-red-500'
  const textCls = remainPct > 50 ? 'text-emerald-400' : remainPct > 20 ? 'text-amber-400' : 'text-red-400'
  const barStyle = { width: `${remainPct}%` }
  return (
    <div className="mt-3 pt-3 border-t border-white/[0.06]">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] text-text-muted uppercase tracking-wider">AI-токены</span>
        <span className={`text-[10px] font-mono tabular-nums ${textCls}`}>{remainPct}% · {remaining.toLocaleString('ru-RU')} / {limit.toLocaleString('ru-RU')}</span>
      </div>
      <div className="h-1 w-full rounded-full bg-white/[0.06] overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-300 ${barCls}`} style={barStyle} />
      </div>
    </div>
  )
}

function SpaceIcon({ icon, name }: { icon?: string; name: string }) {
  if (icon && /^https?:\/\//i.test(icon)) {
    return <img src={icon} alt="" className="w-6 h-6 rounded object-cover shrink-0" />
  }
  if (icon) {
    return <span className="text-[18px] leading-none shrink-0">{icon}</span>
  }
  return (
    <span className="w-6 h-6 rounded bg-white/[0.08] border border-white/[0.10] flex items-center justify-center text-[11px] font-bold text-text-primary shrink-0">
      {(name || '?').charAt(0).toUpperCase()}
    </span>
  )
}

// Colored plan pill, ported from the mockup palette.
function PlanBadge({ plan }: { plan?: string }) {
  const p = (plan || 'free').toLowerCase()
  const palette: Record<string, string> = {
    free: 'bg-zinc-900 text-zinc-400 border-zinc-800',
    plus: 'bg-blue-950/50 text-blue-400 border-blue-900/60',
    team: 'bg-purple-950/50 text-purple-400 border-purple-900/60',
    business: 'bg-amber-950/50 text-amber-400 border-amber-900/60',
    enterprise: 'bg-emerald-950/50 text-emerald-400 border-emerald-900/60',
  }
  const cls = palette[p] || palette.free
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border leading-none ${cls}`}>
      {planLabel(plan)}
    </span>
  )
}

// White-on toggle (mockup). Used for the global auto-pay switch in the popover.
function Toggle({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`relative inline-flex w-8 h-4 rounded-full transition-colors duration-200 shrink-0 border-none ${on ? 'bg-white' : 'bg-white/10'} ${disabled ? 'opacity-30 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <span className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full transition-transform duration-200 ${on ? 'translate-x-4 bg-black' : 'translate-x-0 bg-white/40'}`} />
    </button>
  )
}

// Per-account kebab menu: copy the account token_v2 or remove the account from
// the local pool. Manages its own open/close + outside-click + copy feedback.
function AccountMenu({ token, onRemove }: { token: string; onRemove: () => void }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const copyToken = async () => {
    try {
      await navigator.clipboard.writeText(token)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Fallback for non-secure contexts where the Clipboard API is blocked.
      try {
        const ta = document.createElement('textarea')
        ta.value = token
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      } catch { /* ignore */ }
    }
  }

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        onClick={() => setOpen(v => !v)}
        title="Действия"
        className={`p-1.5 rounded-md flex items-center bg-transparent border-none cursor-pointer transition-colors ${open ? 'text-text-primary bg-white/[0.07]' : 'text-text-muted hover:text-text-secondary hover:bg-white/[0.04]'}`}
      >
        <IconDots />
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-50 w-48 rounded-lg border border-white/[0.12] bg-[#0f0f0f] shadow-modal py-1 overflow-hidden">
          <button
            onClick={copyToken}
            className={`w-full text-left px-3 py-2 text-[12px] bg-transparent border-none cursor-pointer transition-colors hover:bg-white/[0.05] ${copied ? 'text-ok' : 'text-text-secondary'}`}
          >
            {copied ? '✓ Скопировано' : 'Скопировать токен'}
          </button>
          <div className="mx-3 my-1 border-t border-white/[0.06]" />
          <button
            onClick={() => { setOpen(false); onRemove() }}
            className="w-full text-left px-3 py-2 text-[12px] text-red-400 hover:bg-red-500/[0.07] bg-transparent border-none cursor-pointer transition-colors"
          >
            Убрать из списка
          </button>
        </div>
      )}
    </div>
  )
}

export function WorkspacePool({
  accounts,
  onRemoveAccount,
  onPaid,
}: {
  accounts: DiscoveredAccount[]
  onRemoveAccount: (key: string) => void
  onPaid: () => void
}) {
  const [pool, setPool] = useState<DiscoveredAccount[]>(accounts)
  const poolRef = useRef(pool)
  useEffect(() => { setPool(accounts) }, [accounts])
  useEffect(() => { poolRef.current = pool }, [pool])

  const [payTarget, setPayTarget] = useState<{ token: string; spaceId: string; name: string } | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showCardModal, setShowCardModal] = useState(false)
  const [lastRun, setLastRun] = useState('')

  // Server-side auto-pay config is the single source of truth. The browser
  // only reads/edits it — the Go scheduler does the actual paying, even with
  // this tab closed.
  const [cfg, setCfg] = useState<ServerAutoPayConfig | null>(null)

  const reloadCfg = useCallback(async () => {
    try { const c = await fetchAutoPayConfig(); setCfg(c) } catch { /* ignore */ }
  }, [])

  useEffect(() => { reloadCfg() }, [reloadCfg])

  // Poll the server status (log + last run) so the panel stays fresh while open.
  useEffect(() => {
    const id = setInterval(() => { reloadCfg() }, 15000)
    return () => clearInterval(id)
  }, [reloadCfg])

  const popRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!showSettings) return
    const handler = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setShowSettings(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showSettings])

  const persistPool = useCallback((next: DiscoveredAccount[]) => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* ignore */ }
  }, [])

  // Manual list refresh: re-discovers plans + counts for display only. Paying
  // is handled server-side, so this no longer charges anything.
  const refresh = useCallback(async () => {
    const current = poolRef.current
    if (!current.length) return
    setRefreshing(true)
    try {
      const next: DiscoveredAccount[] = []
      for (const acc of current) {
        try {
          const disc = await discoverWorkspaces(acc.token_v2)
          if (!disc.error && disc.spaces && disc.spaces.length > 0) {
            next.push({
              user_id: disc.user_id ?? acc.user_id,
              user_name: disc.user_name ?? acc.user_name,
              user_email: disc.user_email ?? acc.user_email,
              token_v2: acc.token_v2,
              spaces: disc.spaces as WorkspaceInfo[],
            })
          } else {
            next.push(acc)
          }
        } catch {
          next.push(acc)
        }
      }
      setPool(next)
      persistPool(next)
      setLastRun(new Date().toLocaleTimeString('ru-RU'))
    } finally {
      setRefreshing(false)
    }
  }, [persistPool])

  const patchCfg = useCallback(async (patch: AutoPayPatch) => {
    try { const c = await updateAutoPayConfig(patch); setCfg(c) } catch { /* ignore */ }
  }, [])

  const toggleAutoPay = () => { if (cfg) patchCfg({ enabled: !cfg.enabled }) }
  const setInterval2 = (v: string) => patchCfg({ interval_seconds: clampIntervalSeconds(v) })
  const toggleSpace = (id: string, on: boolean) => patchCfg({ space: { id, on } })
  const payNow = async () => { try { await runAutoPayNow(); setTimeout(reloadCfg, 1500) } catch { /* ignore */ } }

  if (!pool.length) return null

  const totalSpaces = pool.reduce((sum, acc) => sum + (acc.spaces?.length || 0), 0)
  const targetPlan = PLANS.find(p => p.id === (cfg?.plan || ''))
  const targetPlanLabel = targetPlan ? `${targetPlan.name} ${targetPlan.price}${targetPlan.interval}` : (cfg?.plan || '—')
  const intervalSec = cfg?.interval_seconds ?? 60
  const canPayNow = !!cfg?.enabled && !!cfg?.has_card

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div className="text-[13px] text-text-secondary">
          Рабочие пространства <span className="text-text-muted">({totalSpaces})</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden sm:flex items-center gap-2 text-[11px] text-text-muted">
            {cfg?.enabled && <span className="text-emerald-500/80">авто · {intervalSec}с</span>}
            {cfg?.enabled && lastRun && <span>·</span>}
            {lastRun && (
              <span className="flex items-center gap-1"><IconClock /><span className="font-mono">{lastRun}</span></span>
            )}
          </div>
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => refresh()}
              disabled={refreshing}
              title="Обновить тарифы и список пространств"
              className="p-1.5 rounded-md text-text-muted hover:text-text-secondary hover:bg-white/[0.04] transition-colors bg-transparent border-none cursor-pointer disabled:opacity-40"
            >
              <IconRefreshSmall spinning={refreshing} />
            </button>
            <div className="relative" ref={popRef}>
              <button
                onClick={() => setShowSettings(v => !v)}
                title="Настройки автооплаты"
                className={`p-1.5 rounded-md transition-colors bg-transparent border-none cursor-pointer ${showSettings ? 'text-text-primary bg-white/[0.07]' : 'text-text-muted hover:text-text-secondary hover:bg-white/[0.04]'}`}
              >
                <IconGear />
              </button>
              {showSettings && (
                <div className="absolute right-0 top-9 z-50 w-72 rounded-xl border border-white/[0.12] bg-[#0c0c0c] shadow-modal overflow-hidden text-left">
                  <div className="px-4 py-3.5 border-b border-white/[0.07]">
                    <div className="text-[13px] font-medium text-text-primary">Автооплата</div>
                    <div className="text-[11px] text-text-muted mt-0.5 leading-relaxed">Работает на сервере, браузер можно закрыть</div>
                  </div>
                  <div className="p-4 space-y-4">
                    <div className="flex items-center justify-between">
                      <span className="text-[12px] text-text-secondary">Платить при Free тарифе</span>
                      <Toggle on={!!cfg?.enabled} disabled={!cfg?.has_card} onClick={toggleAutoPay} />
                    </div>
                    <div>
                      <label className="text-[11px] text-text-muted block mb-1.5 uppercase tracking-wider">Интервал проверки, сек</label>
                      <input
                        type="number"
                        min={5}
                        max={86400}
                        value={intervalSec}
                        onChange={e => setInterval2(e.target.value)}
                        className="w-full bg-[#0a0a0a] border border-white/[0.08] rounded-md px-3 py-1.5 text-[12px] text-text-primary font-mono focus:outline-none focus:border-white/[0.20] transition-colors"
                      />
                    </div>
                    <div className="space-y-2 py-1">
                      <div className="flex items-center justify-between text-[12px]">
                        <span className="text-text-muted">План</span>
                        <span className="text-text-secondary font-mono">{targetPlanLabel}</span>
                      </div>
                      <div className="flex items-center justify-between text-[12px]">
                        <span className="text-text-muted">Карта</span>
                        <span className="text-text-secondary font-mono">{cfg?.has_card ? `···· ${cfg.card_last4}` : 'не задана'}</span>
                      </div>
                    </div>
                    <button
                      onClick={() => { setShowSettings(false); setShowCardModal(true) }}
                      className="w-full flex items-center justify-center gap-2 py-2 rounded-lg border border-white/[0.09] text-[12px] text-text-secondary hover:border-white/[0.18] hover:text-text-primary transition-colors bg-transparent cursor-pointer"
                    >
                      <IconCard />Настроить карту и план
                    </button>
                    <button
                      onClick={payNow}
                      disabled={!canPayNow}
                      className={`w-full flex items-center justify-center gap-2 py-2 rounded-lg text-[12px] font-medium transition-colors border-none cursor-pointer ${canPayNow ? 'bg-white text-black hover:bg-[#f0f0f0]' : 'bg-white/[0.04] text-text-muted cursor-not-allowed'}`}
                    >
                      <IconBolt />Проверить и оплатить сейчас
                    </button>

                    {cfg && cfg.log.length > 0 && (
                      <div>
                        <div className="text-[10px] text-text-muted uppercase tracking-wider mb-2">Последние автооплаты</div>
                        <div className="max-h-28 overflow-y-auto space-y-0.5">
                          {cfg.log.map((line, i) => (
                            <div key={i} className="text-[11px] text-text-secondary truncate">{line}</div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-500/[0.06] border border-amber-500/[0.18]">
                      <IconAlertTri />
                      <p className="text-[11px] text-amber-400/80 leading-relaxed">Каждое Free-пространство оплачивается один раз. Списываются реальные деньги.</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {pool.map((acc) => {
          const key = acc.user_email || acc.token_v2
          return (
            <div key={key} className="rounded-xl border border-white/[0.08] overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 bg-[#080808] border-b border-white/[0.06]">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-7 h-7 rounded-full bg-white/[0.08] border border-white/[0.10] flex items-center justify-center text-[12px] font-semibold text-white shrink-0">
                    {(acc.user_name || acc.user_email || '?').charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-text-primary truncate">{acc.user_name || 'Без имени'}</div>
                    <div className="text-[11px] text-text-muted truncate">
                      {acc.user_email || 'token'} · {acc.spaces?.length || 0} пространств
                    </div>
                  </div>
                </div>
                <AccountMenu token={acc.token_v2} onRemove={() => onRemoveAccount(key)} />
              </div>

              <div className="p-3 grid grid-cols-1 md:grid-cols-2 gap-2.5 bg-[#040404]">
                {(acc.spaces || []).map((space) => {
                  const planText = displayPlan(space)
                  const tier = (space.plan_type || '').toLowerCase()
                  const subscribed = space.is_subscribed || (tier !== '' && tier !== 'free' && tier !== 'team' && tier !== 'personal')
                  const autoOn = !!cfg?.spaces?.[space.space_id]
                  return (
                    <div
                      key={space.space_id}
                      className="rounded-lg border border-white/[0.07] bg-black p-4 hover:border-white/[0.14] transition-colors duration-150"
                    >
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5"><SpaceIcon icon={space.icon} name={space.name} /></div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap mb-0.5">
                            <span className="text-[13px] font-medium text-text-primary truncate">
                              {space.name || 'Workspace'}
                            </span>
                            <PlanBadge plan={space.plan_type} />
                          </div>
                          <div className="text-[11px] text-text-muted truncate">
                            {subscribed ? `Подписка: ${planText}` : 'Бесплатный план'}
                            {space.domain ? ` · ${space.domain}` : ''}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 mt-3">
                        <button
                          type="button"
                          onClick={() => toggleSpace(space.space_id, !autoOn)}
                          title="Автооплата этого пространства при Free тарифе"
                          className={`flex items-center gap-1.5 px-2 py-1 rounded border text-[10px] font-medium transition-colors bg-transparent cursor-pointer ${autoOn ? 'border-white/[0.12] bg-white/[0.05] text-text-secondary' : 'border-white/[0.06] text-text-muted hover:text-text-secondary hover:border-white/[0.10]'}`}
                        >
                          <span className={`relative inline-flex w-8 h-4 rounded-full transition-colors duration-200 shrink-0 ${autoOn ? 'bg-white' : 'bg-white/10'}`}>
                            <span className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full transition-transform duration-200 ${autoOn ? 'translate-x-4 bg-black' : 'translate-x-0 bg-white/40'}`} />
                          </span>
                          Авто
                        </button>
                        <button
                          onClick={() =>
                            setPayTarget({ token: acc.token_v2, spaceId: space.space_id, name: space.name || 'Workspace' })
                          }
                          className="ml-auto px-3 py-1 rounded bg-white text-black text-[11px] font-medium hover:bg-[#f0f0f0] active:bg-[#e0e0e0] transition-colors border-none cursor-pointer"
                        >
                          Оплатить
                        </button>
                      </div>
                      <AICreditsBar used={space.ai_credits_used} limit={space.ai_credits_limit} />
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      {payTarget && (
        <SubscribeModal
          initialToken={payTarget.token}
          spaceId={payTarget.spaceId}
          workspaceName={payTarget.name}
          onClose={() => setPayTarget(null)}
          onSuccess={() => {
            setPayTarget(null)
            onPaid()
          }}
        />
      )}

      {showCardModal && (
        <AutoPaySettings
          onClose={() => { setShowCardModal(false); reloadCfg() }}
          onSaved={reloadCfg}
        />
      )}
    </div>
  )
}
