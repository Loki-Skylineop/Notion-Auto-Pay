import { useState, useEffect, useRef, useCallback } from 'react'
import type { WorkspaceInfo as BaseWorkspaceInfo } from '../api'
import { discoverWorkspaces } from '../api'
import { SubscribeModal, PLANS } from './SubscribeModal'
import { AutoPaySettings } from './AutoPaySettings'
import {
  fetchAutoPayConfig, updateAutoPayConfig, runAutoPayNow,
  clampIntervalSeconds, type ServerAutoPayConfig, type AutoPayPatch,
} from '../autopay'

// The backend forwards an optional space `icon` (emoji or image URL) and a
// `plan_name` (marketed plan name from getSubscriptionData). They aren't part
// of the base API type, so we widen it here without touching the shared def.
export type WorkspaceInfo = BaseWorkspaceInfo & { icon?: string; plan_name?: string }

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

// Dark translucent fill + bright accent text + hairline border. One step per
// tier, no sixth accent.
function PlanBadge({ plan }: { plan?: string }) {
  const p = (plan || 'free').toLowerCase()
  const palette: Record<string, string> = {
    free: 'bg-white/5 text-text-muted border-border',
    plus: 'bg-[#4ade80]/10 text-[#4ade80] border-[#4ade80]/25',
    team: 'bg-[#3291ff]/10 text-[#3291ff] border-[#3291ff]/25',
    business: 'bg-[#f5a623]/10 text-[#f5a623] border-[#f5a623]/25',
    enterprise: 'bg-[#a371f7]/12 text-[#a371f7] border-[#a371f7]/30',
  }
  const cls = palette[p] || palette.free
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium border ${cls}`}>
      {planLabel(plan)}
    </span>
  )
}

function SpaceIcon({ icon, name }: { icon?: string; name: string }) {
  if (icon && /^https?:\/\//i.test(icon)) {
    return <img src={icon} alt="" className="w-5 h-5 rounded object-cover shrink-0" />
  }
  if (icon) {
    return <span className="text-[16px] leading-none shrink-0">{icon}</span>
  }
  return (
    <span className="w-5 h-5 rounded bg-white/8 border border-border flex items-center justify-center text-[11px] font-bold text-text-primary shrink-0">
      {(name || '?').charAt(0).toUpperCase()}
    </span>
  )
}

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
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
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
        className={`bg-transparent border-none cursor-pointer p-1 flex items-center rounded ${open ? 'text-text-primary bg-white/8' : 'text-text-muted hover:text-text-primary'}`}
      >
        <IconDots />
      </button>
      {open && (
        <div className="absolute right-0 top-7 z-50 w-56 bg-bg-card border border-border rounded-lg shadow-modal py-1">
          <button
            onClick={copyToken}
            className={`w-full text-left px-3 py-2 text-[12px] bg-transparent border-none cursor-pointer transition-colors hover:bg-white/5 ${copied ? 'text-ok' : 'text-text-primary'}`}
          >
            {copied ? '✓ Токен скопирован' : 'Скопировать токен аккаунта'}
          </button>
          <button
            onClick={() => { setOpen(false); onRemove() }}
            className="w-full text-left px-3 py-2 text-[12px] text-err hover:bg-err/10 bg-transparent border-none cursor-pointer transition-colors"
          >
            Убрать из списка
          </button>
        </div>
      )}
    </div>
  )
}

function Toggle({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`relative w-7 h-4 rounded-full transition-colors duration-200 border-none shrink-0 ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'} ${on ? 'bg-notion-blue' : 'bg-[#333333]'}`}
    >
      <span className={`absolute top-[2px] left-[2px] w-3 h-3 rounded-full bg-white shadow-sm transition-all duration-200 ${on ? 'translate-x-[12px]' : ''}`} />
    </button>
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

  return (
    <div className="mb-8">
      <div className="eyebrow flex items-center gap-1.5 mb-4">
        <span>Рабочие пространства</span>
        <span className="text-text-muted">({totalSpaces})</span>
        <button
          onClick={() => refresh()}
          disabled={refreshing}
          title="Обновить тарифы и список пространств"
          className="text-text-muted hover:text-text-primary bg-transparent border-none cursor-pointer p-1 flex items-center disabled:opacity-40"
        >
          <IconRefreshSmall spinning={refreshing} />
        </button>
        <div className="relative" ref={popRef}>
          <button
            onClick={() => setShowSettings(v => !v)}
            title="Настройки автооплаты"
            className={`bg-transparent border-none cursor-pointer p-1 flex items-center ${showSettings ? 'text-text-primary' : 'text-text-muted hover:text-text-primary'}`}
          >
            <IconGear />
          </button>
          {showSettings && (
            <div className="absolute left-0 top-7 z-50 w-72 bg-bg-card border border-border rounded-xl shadow-modal p-3.5 text-left">
              <div className="text-[12px] font-semibold text-text-primary mb-1">Автооплата (на сервере)</div>
              <div className="text-[10px] text-text-muted mb-2.5 leading-relaxed">Работает в фоне на сервере — браузер можно закрыть.</div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[12px] text-text-secondary">Платить при Free тарифе</span>
                <Toggle on={!!cfg?.enabled} disabled={!cfg?.has_card} onClick={toggleAutoPay} />
              </div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[12px] text-text-secondary">Интервал проверки, сек</span>
                <input
                  type="number"
                  min={5}
                  max={86400}
                  value={intervalSec}
                  onChange={e => setInterval2(e.target.value)}
                  className="w-16 py-1 px-2 bg-bg-input border border-border rounded text-[12px] text-text-primary outline-none focus:border-notion-blue text-right"
                />
              </div>
              <div className="text-[10px] text-text-muted mb-3 leading-relaxed">Минимум 5 секунд. Сервер проверяет отмеченные пространства и оплачивает Free.</div>

              <div className="text-[11px] text-text-secondary mb-1">План: <span className="text-text-primary font-medium">{targetPlanLabel}</span></div>
              <div className="text-[11px] text-text-secondary mb-2.5">Карта: {cfg?.has_card ? <span className="text-ok font-medium">···· {cfg.card_last4}</span> : <span className="text-text-muted">не задана</span>}</div>
              <button
                onClick={() => { setShowSettings(false); setShowCardModal(true) }}
                className="w-full py-2 bg-bg-secondary hover:bg-bg-card-hover text-text-primary rounded-lg text-[12px] font-medium cursor-pointer border border-border transition-colors"
              >
                Настроить карту и план
              </button>
              <button
                onClick={payNow}
                disabled={!cfg?.enabled || !cfg?.has_card}
                className="w-full mt-2 py-2 bg-transparent hover:bg-white/5 text-text-secondary rounded-lg text-[12px] font-medium cursor-pointer border border-border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Проверить и оплатить сейчас
              </button>
              <div className="text-[10px] text-text-muted mt-2.5 leading-relaxed">Включите «Авто» у нужных пространств. Каждое Free‑пространство оплачивается один раз. Списываются реальные деньги.</div>

              {cfg && cfg.log.length > 0 && (
                <>
                  <div className="h-px bg-border my-2" />
                  <div className="text-[10px] text-text-muted mb-1">Последние автооплаты</div>
                  <div className="max-h-28 overflow-y-auto space-y-0.5">
                    {cfg.log.map((line, i) => (
                      <div key={i} className="text-[10px] text-text-secondary truncate">{line}</div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
        {cfg?.enabled && (
          <span className="font-normal text-text-muted text-[10px]">авто · {intervalSec}с</span>
        )}
        {lastRun && (
          <span className="font-normal text-text-muted text-[10px]">обновлено {lastRun}</span>
        )}
      </div>

      <div className="flex flex-col gap-4">
        {pool.map((acc) => {
          const key = acc.user_email || acc.token_v2
          return (
            <div key={key} className="bg-bg-card border border-border rounded-xl p-4 shadow-card">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold text-black shrink-0 bg-white">
                  {(acc.user_name || acc.user_email || '?').charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] font-medium text-text-primary truncate">{acc.user_name || 'Без имени'}</div>
                  <div className="text-[11px] text-text-muted truncate">
                    {acc.user_email || 'token'} · {acc.spaces?.length || 0} рабочих пространств
                  </div>
                </div>
                <AccountMenu token={acc.token_v2} onRemove={() => onRemoveAccount(key)} />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                {(acc.spaces || []).map((space) => {
                  const planText = displayPlan(space)
                  const tier = (space.plan_type || '').toLowerCase()
                  const subscribed = space.is_subscribed || (tier !== '' && tier !== 'free' && tier !== 'team' && tier !== 'personal')
                  return (
                    <div
                      key={space.space_id}
                      className="flex items-center gap-3 bg-bg-secondary border border-border rounded-lg px-3 py-2.5 transition-colors hover:bg-bg-card-hover"
                    >
                      <SpaceIcon icon={space.icon} name={space.name} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-[13px] font-semibold text-text-primary truncate">
                            {space.name || 'Workspace'}
                          </span>
                          <PlanBadge plan={space.plan_type} />
                        </div>
                        <div className="text-[11px] text-text-secondary truncate">
                          {subscribed ? `Подписка: ${planText}` : 'Бесплатный план'}
                          {space.domain ? ` · ${space.domain}` : ''}
                        </div>
                      </div>
                      <label className="flex items-center gap-1 cursor-pointer select-none shrink-0" title="Автооплата этого пространства при Free тарифе">
                        <input
                          type="checkbox"
                          checked={!!cfg?.spaces?.[space.space_id]}
                          onChange={e => toggleSpace(space.space_id, e.target.checked)}
                          className="accent-[#3291ff] w-3 h-3 cursor-pointer"
                        />
                        <span className="text-[11px] text-text-muted">Авто</span>
                      </label>
                      <button
                        onClick={() =>
                          setPayTarget({ token: acc.token_v2, spaceId: space.space_id, name: space.name || 'Workspace' })
                        }
                        className="shrink-0 px-3 h-7 bg-white hover:bg-white/90 text-black rounded-full text-[12px] font-medium cursor-pointer transition-colors border-none"
                      >
                        Оплатить
                      </button>
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
