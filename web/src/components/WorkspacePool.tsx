import { useState, useEffect, useRef, useCallback } from 'react'
import type { WorkspaceInfo as BaseWorkspaceInfo, McpServerInfo } from '../api'
import { connectMcp, createWorkspaces, deleteWorkspaces, disconnectMcp, discoverWorkspaces, setOverage } from '../api'
import { SubscribeModal, PLANS } from './SubscribeModal'
import { AutoPaySettings } from './AutoPaySettings'
import {
  fetchAutoPayConfig, updateAutoPayConfig, runAutoPayNow,
  clampIntervalSeconds, type ServerAutoPayConfig, type AutoPayPatch,
} from '../autopay'

// The backend forwards an optional space `icon` (emoji or image URL), a
// `plan_name` (marketed plan name from getSubscriptionData), the premium AI
// credit budget (`ai_credits_used` / `ai_credits_limit`, e.g. 0 of 400) and the
// separate basic allowance the ordinary agent spends (`basic_credits_used` /
// `basic_credits_limit`, e.g. 1708 of 75). On top of that come the two
// throttling windows Notion draws on its own Limits tab, both from
// /api/v3/getCreditRateLimitStatus and already scaled to 100: `rolling_*` is
// the short sliding window (`rolling_window` is its size, e.g. "6h") and
// `period_*` is the billing-period allowance that resets at `period_end_ms`.
// `rate_limit_ok` is false when that call failed, so the bars stay hidden
// rather than reading as a misleading 0%. None of this is part of the base API
// type, so we widen it here without touching the shared def.
export type WorkspaceInfo = BaseWorkspaceInfo & {
  icon?: string
  plan_name?: string
  ai_credits_used?: number
  ai_credits_limit?: number
  basic_credits_used?: number
  basic_credits_limit?: number
  basic_credits_unlimited?: boolean
  rate_limit_ok?: boolean
  rolling_used?: number
  rolling_limit?: number
  rolling_window?: string
  rolling_resets_in_sec?: number
  period_used?: number
  period_limit?: number
  period_end_ms?: number
  overage_policy?: string
  overage_enabled?: boolean
}

export interface DiscoveredAccount {
  user_id?: string
  user_name?: string
  user_email?: string
  token_v2: string
  spaces: WorkspaceInfo[]
}

// Кэш списка аккаунтов теперь пишет только App (см. onPoolChange): раньше в
// ключ nmp_discovered_workspaces писали оба компонента, и после «Обновить»
// сохранённая копия расходилась с состоянием App до перезагрузки страницы.

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

// Notion reports the throttling windows with two decimals (87.68 of 100), the
// credit pools as whole numbers, so keep the fraction only when there is one.
const fmtNum = (n: number) =>
  Number.isInteger(n)
    ? n.toLocaleString('ru-RU')
    : n.toLocaleString('ru-RU', { maximumFractionDigits: 2 })

// "сброс через 4 ч 27 мин". The countdown is a snapshot taken when the pool was
// last discovered, so it ages between refreshes exactly the way Notion's own
// Limits tab does between page loads.
function fmtResetIn(sec?: number): string | undefined {
  if (!sec || sec <= 0) return undefined
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (h > 0) return `сброс через ${h} ч ${m} мин`
  if (m > 0) return `сброс через ${m} мин`
  return 'сброс вот-вот'
}

// "сброс 24 авг" - when the billing-period allowance rolls over.
function fmtResetAt(ms?: number): string | undefined {
  if (!ms || ms <= 0) return undefined
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return undefined
  return `сброс ${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}`
}

// "6ч · сброс через 4 ч 27 мин" - the sliding window size plus how long until
// it frees up again.
function rollingNote(win?: string, resetsInSec?: number): string | undefined {
  const size = (win || '').trim().toLowerCase().replace('h', 'ч').replace('d', 'д')
  return [size, fmtResetIn(resetsInSec)].filter(Boolean).join(' · ') || undefined
}

// Per-workspace usage gauge. Shows how much of the budget has been SPENT
// (0% = untouched, 100% = drained), so the colours run the opposite way round
// from a "remaining" bar: green while there is room, red once it is gone.
// Hidden when the space has no such budget (limit 0). `overflow` covers budgets
// that are not actually enforced - paid plans keep burning basic credits well
// past the nominal free allowance - by drawing a full bar next to the raw
// counters instead of a meaningless percentage. `showNums` is turned off for
// the rate-limit windows, where Notion's own used/limit pair is already a
// percentage and repeating "87,68 / 100" next to "88%" would just be noise.
// `note` carries the reset hint that Notion prints under each of its gauges.
function CreditsBar({
  label,
  used,
  limit,
  overflow,
  divider = true,
  note,
  showNums = true,
}: {
  label: string
  used?: number
  limit?: number
  overflow?: boolean
  divider?: boolean
  note?: string
  showNums?: boolean
}) {
  if (!limit || limit <= 0) return null
  const rawUsed = Math.max(0, used ?? 0)
  const over = overflow === true || rawUsed > limit
  const spentPct = over ? 100 : Math.round((rawUsed / limit) * 100)
  const barCls = spentPct < 50 ? 'bg-emerald-500' : spentPct < 80 ? 'bg-amber-500' : 'bg-red-500'
  const textCls = spentPct < 50 ? 'text-emerald-400' : spentPct < 80 ? 'text-amber-400' : 'text-red-400'
  const barStyle = { width: `${spentPct}%` }
  const nums = `${fmtNum(rawUsed)} / ${fmtNum(limit)}`
  const right = over ? nums : showNums ? `${spentPct}% \u00b7 ${nums}` : `${spentPct}%`
  return (
    <div className={divider ? 'mt-3 pt-3 border-t border-white/[0.06]' : 'mt-2'}>
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-[10px] text-text-muted uppercase tracking-wider truncate min-w-0">
          {label}
          {note ? <span className="normal-case tracking-normal opacity-60">{` \u00b7 ${note}`}</span> : null}
        </span>
        <span className={`text-[10px] font-mono tabular-nums shrink-0 ${textCls}`}>{right}</span>
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

// MCP connection indicator, drawn right after the workspace name. A filled
// emerald dot means at least one MCP server is connected to this space; a
// hollow grey dot means none are. The tooltip names every server with its tool
// count and URL, so hovering answers "which server?" without opening Notion.
function McpBadge({ servers, connected, onConnect, onDisconnect, busy }: { servers?: McpServerInfo[]; connected?: boolean; onConnect?: () => void; onDisconnect?: () => void; busy?: boolean }) {
  const list = servers || []
  const on = !!connected || list.some((s) => (s.status || '').toLowerCase() === 'connected')
  const lines = list.map((s) => {
    const name = (s.name || '').trim() || s.url || 'MCP'
    const tools = s.tools_count ? ' \u00b7 ' + s.tools_count + ' \u0438\u043d\u0441\u0442\u0440.' : ''
    const state = (s.status || '').toLowerCase() === 'connected' ? '' : ' \u00b7 ' + (s.status || '\u043d\u0435\u0442 \u0441\u0432\u044f\u0437\u0438')
    const url = s.url ? ' \u2014 ' + s.url : ''
    return name + tools + state + url
  })
  const title = lines.length ? lines.join('\n') : 'MCP-\u0441\u0435\u0440\u0432\u0435\u0440 \u043d\u0435 \u043f\u043e\u0434\u043a\u043b\u044e\u0447\u0451\u043d'
  // Подключён — клик отключает сервер (тем же запросом, что шлёт веб-клиент
  // Notion), не подключён — клик открывает модалку подключения.
  const clickable = !busy && (on ? !!onDisconnect : !!onConnect)
  const hint = busy
    ? 'Отключаем MCP-сервер…'
    : on
      ? (clickable ? `Нажмите, чтобы отключить MCP-сервер\n${title}` : title)
      : (clickable ? 'Нажмите, чтобы подключить MCP-сервер' : title)
  return (
    <span
      title={hint}
      onClick={clickable ? (e) => { e.stopPropagation(); if (on) { onDisconnect && onDisconnect() } else { onConnect && onConnect() } } : undefined}
      role={clickable ? 'button' : undefined}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border leading-none ${on ? 'bg-emerald-950/50 text-emerald-400 border-emerald-900/60' : 'bg-zinc-900 text-zinc-500 border-zinc-800'}${clickable ? (on ? ' cursor-pointer hover:text-red-400 hover:border-red-500/60 transition-colors' : ' cursor-pointer hover:text-notion-blue hover:border-notion-blue/60 transition-colors') : ''}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${busy ? 'bg-amber-400 animate-pulse' : on ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
      MCP{on && list.length > 1 ? ' ' + list.length : ''}
    </span>
  )
}

// A workspace whose daily window reads 100% cannot run another turn on its
// included credits, so that is exactly when the "use additional credits"
// switch starts to matter - and the only case where the pool renders the badge
// at all.
function rollingMaxed(s: WorkspaceInfo): boolean {
  const limit = s.rolling_limit || 0
  const used = s.rolling_used || 0
  if (!s.rate_limit_ok || limit <= 0) return false
  return used >= limit - 0.005
}

// Small companion to McpBadge, rendered only on a workspace whose daily limit
// is fully spent - the one moment this setting decides anything. It shows
// whether extra credits are allowed and doubles as the switch. Chat sends flip
// it by themselves for the length of one turn, so after a refresh it may well
// have changed without anyone touching it.
function OverageBadge({ on, busy, onToggle }: { on?: boolean; busy?: boolean; onToggle?: () => void }) {
  const clickable = !busy && !!onToggle
  const tone = on ? 'bg-amber-950/50 text-amber-400 border-amber-900/60' : 'bg-zinc-900 text-zinc-500 border-zinc-800'
  let extra = ''
  if (busy) extra = ' opacity-60'
  else if (clickable) extra = ' cursor-pointer hover:text-notion-blue hover:border-notion-blue/60 transition-colors'
  let title = 'Доп. токены выключены — дневной лимит исчерпан. Нажмите, чтобы включить'
  if (on) title = 'Доп. токены разрешены — дневной лимит исчерпан, но сообщения проходят. Нажмите, чтобы выключить'
  if (busy) title = 'Переключаю…'
  return (
    <span
      title={title}
      onClick={clickable ? (e) => { e.stopPropagation(); if (onToggle) onToggle() } : undefined}
      role={clickable ? 'button' : undefined}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border leading-none ${tone}${extra}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${on ? 'bg-amber-400' : 'bg-zinc-600'}`} />
      ДОП
    </span>
  )
}

// Servers remembered in this browser after a successful connect. Notion never
// returns a stored secret, so reusing a server in the next workspace only works
// one-click if we kept the token locally when it was first entered.
const MCP_PRESETS_KEY = 'notion_mcp_presets'

export interface McpPreset {
  url: string
  name?: string
  icon?: string
  headerName?: string
  headerValue?: string
}

function loadMcpPresets(): McpPreset[] {
  try {
    const raw = localStorage.getItem(MCP_PRESETS_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return (arr as McpPreset[]).filter((p) => p && typeof p.url === 'string' && p.url.length > 0)
  } catch {
    return []
  }
}

function saveMcpPreset(p: McpPreset) {
  try {
    const list = loadMcpPresets().filter((x) => x.url !== p.url)
    list.unshift(p)
    localStorage.setItem(MCP_PRESETS_KEY, JSON.stringify(list.slice(0, 12)))
  } catch { /* ignore */ }
}

// Every MCP server already visible anywhere in the pool, so a workspace without
// one can copy the setup used by the others.
function collectMcpServers(list: DiscoveredAccount[]): McpServerInfo[] {
  const out: McpServerInfo[] = []
  for (const a of list) {
    for (const s of a.spaces || []) {
      for (const m of s.mcp_servers || []) out.push(m)
    }
  }
  return out
}

const mcpInputCls = 'px-2.5 py-1.5 rounded-lg bg-black border border-white/[0.10] text-[12px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-notion-blue/60'

function McpConnectModal({
  target,
  known,
  onClose,
  onDone,
}: {
  target: { token: string; userId: string; spaceId: string; spaceViewId: string; name: string }
  known: McpServerInfo[]
  onClose: () => void
  onDone: () => void
}) {
  const sources: McpPreset[] = loadMcpPresets().map((p) => ({ ...p }))
  for (const s of known) {
    const u = (s.url || '').trim()
    if (!u) continue
    if (sources.some((o) => o.url === u)) continue
    sources.push({ url: u, name: s.name, icon: s.icon })
  }

  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [icon, setIcon] = useState('')
  const [headerName, setHeaderName] = useState('Authorization')
  const [headerValue, setHeaderValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [okMsg, setOkMsg] = useState('')

  const applySource = (p: McpPreset) => {
    setUrl(p.url)
    setName((p.name || '').trim())
    setIcon(p.icon || '')
    setHeaderName(p.headerName || 'Authorization')
    setHeaderValue(p.headerValue || '')
    setErr('')
  }

  const submit = async () => {
    const u = url.trim()
    if (!u) { setErr('Укажите адрес MCP-сервера'); return }
    setBusy(true)
    setErr('')
    setOkMsg('')
    try {
      const res = await connectMcp({
        tokenV2: target.token,
        userId: target.userId,
        spaceId: target.spaceId,
        spaceViewId: target.spaceViewId,
        serverUrl: u,
        headerName: headerName.trim(),
        headerValue: headerValue.trim(),
        name: name.trim(),
        icon: icon.trim(),
      })
      if (!res.ok || res.error) {
        setErr(res.error || 'Не удалось подключить сервер')
        return
      }
      saveMcpPreset({
        url: u,
        name: res.name || name.trim(),
        icon: res.icon || icon.trim(),
        headerName: headerName.trim(),
        headerValue: headerValue.trim(),
      })
      setOkMsg('Подключено · инструментов: ' + (res.tools_count || 0))
      setTimeout(onDone, 800)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка сети')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-xl border border-white/[0.10] bg-[#0b0b0b] p-5 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[14px] font-medium text-text-primary mb-1">Подключить MCP-сервер</div>
        <div className="text-[11px] text-text-muted mb-4 truncate">{target.name}</div>

        {sources.length > 0 && (
          <div className="mb-4">
            <div className="text-[11px] text-text-secondary mb-1.5">Как в других воркспейсах</div>
            <div className="flex flex-col gap-1.5">
              {sources.map((p) => (
                <button
                  key={p.url}
                  type="button"
                  onClick={() => applySource(p)}
                  className="text-left px-2.5 py-1.5 rounded-lg border border-white/[0.07] bg-black hover:border-notion-blue/50 transition-colors"
                >
                  <div className="text-[12px] text-text-primary truncate">
                    {p.icon ? p.icon + ' ' : ''}{(p.name || '').trim() || p.url}
                  </div>
                  <div className="text-[10px] text-text-muted truncate">
                    {p.url}{p.headerValue ? ' · токен сохранён' : ' · нужен токен'}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="text-[11px] text-text-secondary mb-1.5">Свои значения</div>
        <div className="flex flex-col gap-2">
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" className={mcpInputCls} />
          <div className="flex gap-2">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Название (необязательно)" className={mcpInputCls + ' flex-1'} />
            <input value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="Иконка" className={mcpInputCls + ' w-20 text-center'} />
          </div>
          <div className="flex gap-2">
            <input value={headerName} onChange={(e) => setHeaderName(e.target.value)} placeholder="Authorization" className={mcpInputCls + ' w-40'} />
            <input value={headerValue} onChange={(e) => setHeaderValue(e.target.value)} placeholder="Токен или «Bearer токен»" className={mcpInputCls + ' flex-1'} />
          </div>
          <div className="text-[10px] text-text-muted leading-snug">
            Можно вставить только сам токен — «Bearer » подставится автоматически. Notion никогда не отдаёт уже сохранённые токены, поэтому для воркспейса с пометкой «нужен токен» его придётся ввести один раз, дальше он запомнится.
          </div>
        </div>

        {err && <div className="mt-3 text-[11px] text-err break-words">{err}</div>}
        {okMsg && <div className="mt-3 text-[11px] text-ok">{okMsg}</div>}

        <div className="flex items-center justify-end gap-2 mt-5">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-lg text-[12px] text-text-secondary hover:text-text-primary transition-colors">
            Отмена
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !url.trim()}
            className="px-3 py-1.5 rounded-lg text-[12px] font-medium bg-notion-blue text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-notion-blue/90 transition-colors"
          >
            {busy ? 'Подключаю…' : 'Подключить'}
          </button>
        </div>
      </div>
    </div>
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

// Plus glyph for the create-workspace trigger, matching the other inline
// icons in this file.
function IconPlusSmall() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

// Quick presets plus the hard cap, mirroring maxWorkspacesPerRequest on the
// server so the UI never asks for more than the backend will do.
const CREATE_PRESETS = [1, 2, 3, 5, 10]
const MAX_CREATE = 25

// Create-workspace control sitting next to the account kebab menu. Opens a
// small popover to pick how many workspaces to create; the server generates a
// random name for each one, creates them sequentially and reports a partial
// result, so "3 of 5" is a normal outcome rather than a hard error.
function CreateWorkspaceMenu({ token, onCreated }: { token: string; onCreated: () => void }) {
  const [open, setOpen] = useState(false)
  const [count, setCount] = useState(1)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: number; message: string } | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const clamped = Math.min(MAX_CREATE, Math.max(1, Math.round(count) || 1))

  const submit = async () => {
    if (busy) return
    setBusy(true)
    setResult(null)
    try {
      const res = await createWorkspaces(token, clamped)
      const ok = res.created?.length || 0
      const message = ok === 0
        ? (res.error || res.errors?.[0] || 'Не удалось создать')
        : ok < clamped
          ? `Создано ${ok} из ${clamped}`
          : `Создано: ${ok}`
      setResult({ ok, message })
      if (ok > 0) onCreated()
    } catch (err) {
      setResult({ ok: 0, message: err instanceof Error ? err.message : 'Ошибка запроса' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        onClick={() => setOpen(v => !v)}
        title="Создать воркспейс"
        className={`p-1.5 rounded-md flex items-center bg-transparent border-none cursor-pointer transition-colors ${open ? 'text-text-primary bg-white/[0.07]' : 'text-text-muted hover:text-text-secondary hover:bg-white/[0.04]'}`}
      >
        <IconPlusSmall />
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-50 w-60 rounded-lg border border-white/[0.12] bg-[#0f0f0f] shadow-modal overflow-hidden text-left">
          <div className="px-3.5 py-3 border-b border-white/[0.07]">
            <div className="text-[12px] font-medium text-text-primary">Создать воркспейс</div>
            <div className="text-[11px] text-text-muted mt-0.5 leading-relaxed">Имена генерируются случайно</div>
          </div>
          <div className="p-3.5 space-y-3">
            <div>
              <div className="text-[10px] text-text-muted uppercase tracking-wider mb-1.5">Сколько создать</div>
              <div className="flex items-center gap-1">
                {CREATE_PRESETS.map(n => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setCount(n)}
                    className={`flex-1 py-1 rounded border text-[11px] font-medium transition-colors cursor-pointer ${clamped === n ? 'border-white/[0.25] bg-white/[0.10] text-text-primary' : 'border-white/[0.07] bg-transparent text-text-muted hover:text-text-secondary hover:border-white/[0.12]'}`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <input
              type="number"
              min={1}
              max={MAX_CREATE}
              value={count}
              onChange={e => {
                const v = parseInt(e.target.value, 10)
                setCount(Number.isNaN(v) ? 1 : v)
              }}
              title="Сколько воркспейсов создать"
              className="w-full bg-[#0a0a0a] border border-white/[0.08] rounded-md px-3 py-1.5 text-[12px] text-text-primary font-mono focus:outline-none focus:border-white/[0.20] transition-colors"
            />
            <button
              type="button"
              onClick={submit}
              disabled={busy}
              className={`w-full py-2 rounded-lg text-[12px] font-medium transition-colors border-none ${busy ? 'bg-white/[0.06] text-text-muted cursor-not-allowed' : 'bg-white text-black hover:bg-[#f0f0f0] cursor-pointer'}`}
            >
              {busy ? 'Создание…' : `Создать ${clamped}`}
            </button>
            {result && (
              <div className={`text-[11px] leading-relaxed ${result.ok > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {result.message}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export function WorkspacePool({
  accounts,
  onRemoveAccount,
  onPoolChange,
  onPaid,
}: {
  accounts: DiscoveredAccount[]
  onRemoveAccount: (key: string) => void
  // Обновлённый список уходит в App: там он ложится в state и ровно один раз
  // записывается в localStorage.
  onPoolChange?: (next: DiscoveredAccount[]) => void
  onPaid: () => void
}) {
  const [pool, setPool] = useState<DiscoveredAccount[]>(accounts)
  const poolRef = useRef(pool)
  useEffect(() => { setPool(accounts) }, [accounts])
  useEffect(() => { poolRef.current = pool }, [pool])

  const [payTarget, setPayTarget] = useState<{ token: string; spaceId: string; name: string } | null>(null)
  const [mcpTarget, setMcpTarget] = useState<{ token: string; userId: string; spaceId: string; spaceViewId: string; name: string } | null>(null)
  // space_id -> true while that workspace's overage switch is being flipped.
  const [overageBusy, setOverageBusy] = useState<Record<string, boolean>>({})
  // space_id -> true, пока по этому пространству едет отключение MCP-сервера.
  const [mcpBusy, setMcpBusy] = useState<Record<string, boolean>>({})
  // На стороне Notion у удаления нет ни подтверждения, ни отмены, поэтому
  // корзина только заполняет delTarget: запрос уходит только после красной
  // кнопки в диалоге.
  const [delTarget, setDelTarget] = useState<{ token: string; userId: string; spaceId: string; name: string } | null>(null)
  const [delBusy, setDelBusy] = useState(false)
  const [delErr, setDelErr] = useState('')
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

  // Никакой записи в localStorage: отдаём свежий список наверх, чтобы состояние
  // App и кэш обновлялись из одного места.
  const persistPool = useCallback((next: DiscoveredAccount[]) => {
    onPoolChange?.(next)
  }, [onPoolChange])

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

  // Re-discover a single account after new workspaces were created, so the
  // fresh spaces show up without re-scanning every account in the pool.
  const refreshAccount = useCallback(async (token: string) => {
    try {
      const disc = await discoverWorkspaces(token)
      if (disc.error || !disc.spaces || disc.spaces.length === 0) return
      const next = poolRef.current.map(a =>
        a.token_v2 === token
          ? {
              user_id: disc.user_id ?? a.user_id,
              user_name: disc.user_name ?? a.user_name,
              user_email: disc.user_email ?? a.user_email,
              token_v2: token,
              spaces: disc.spaces as WorkspaceInfo[],
            }
          : a,
      )
      setPool(next)
      persistPool(next)
    } catch { /* best effort */ }
  }, [persistPool])
  const patchCfg = useCallback(async (patch: AutoPayPatch) => {
    try { const c = await updateAutoPayConfig(patch); setCfg(c) } catch { /* ignore */ }
  }, [])

  const toggleAutoPay = () => { if (cfg) patchCfg({ enabled: !cfg.enabled }) }
  const setInterval2 = (v: string) => patchCfg({ interval_seconds: clampIntervalSeconds(v) })
  const toggleSpace = (id: string, on: boolean) => patchCfg({ space: { id, on } })
  // Per-space plan override: rebuild the whole space_plans map (empty value =
  // clear, so that space falls back to the global plan). Lets each workspace be
  // auto-paid on its own tariff instead of one shared plan for every space.
  const setSpacePlan = (id: string, plan: string) => {
    const next: Record<string, string> = { ...(cfg?.space_plans || {}) }
    if (plan) next[id] = plan
    else delete next[id]
    patchCfg({ space_plans: next })
  }
  const payNow = async () => { try { await runAutoPayNow(); setTimeout(reloadCfg, 1500) } catch { /* ignore */ } }

  if (!pool.length) return null

  const totalSpaces = pool.reduce((sum, acc) => sum + (acc.spaces?.length || 0), 0)
  const targetPlan = PLANS.find(p => p.id === (cfg?.plan || ''))
  const globalPlanName = targetPlan ? targetPlan.name : (cfg?.plan || '')
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

                    {cfg && Array.isArray(cfg.log) && cfg.log.length > 0 && (
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
                <div className="flex items-center gap-0.5 shrink-0">
                  <CreateWorkspaceMenu token={acc.token_v2} onCreated={() => refreshAccount(acc.token_v2)} />
                  <AccountMenu token={acc.token_v2} onRemove={() => onRemoveAccount(key)} />
                </div>
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
                            <McpBadge
                              servers={space.mcp_servers}
                              connected={space.mcp_connected}
                              busy={!!mcpBusy[space.space_id]}
                              onConnect={() => setMcpTarget({ token: acc.token_v2, userId: acc.user_id || '', spaceId: space.space_id, spaceViewId: space.space_view_id, name: space.name || 'Workspace' })}
                              onDisconnect={() => {
                                // Отключение повторяет одну транзакцию веб-клиента
                                // (disconnectPersonalMcpServer): модуль убирается из
                                // space_view.settings.agent_chat_modules и гасится
                                // флагом alive:false.
                                const sid = space.space_id
                                const tok = acc.token_v2
                                const srv = (space.mcp_servers || [])[0]
                                const label = (srv?.name || '').trim() || srv?.url || 'MCP-сервер'
                                if (!window.confirm(`Отключить ${label} от «${space.name || 'Workspace'}»?`)) return
                                setMcpBusy((b) => ({ ...b, [sid]: true }))
                                disconnectMcp({
                                  tokenV2: tok,
                                  userId: acc.user_id || '',
                                  spaceId: sid,
                                  spaceViewId: space.space_view_id,
                                  moduleId: srv?.id || '',
                                  serverUrl: srv?.url || '',
                                })
                                  .then((r) => { if (!r.ok) window.alert(r.error || 'Не удалось отключить MCP-сервер') })
                                  .catch(() => window.alert('Не удалось отключить MCP-сервер'))
                                  .finally(() => {
                                    setMcpBusy((b) => ({ ...b, [sid]: false }))
                                    refreshAccount(tok)
                                  })
                              }}
                            />
                            {rollingMaxed(space) && (
                              <OverageBadge
                                on={space.overage_enabled}
                                busy={!!overageBusy[space.space_id]}
                                onToggle={() => {
                                  const sid = space.space_id
                                  const tok = acc.token_v2
                                  const next = !space.overage_enabled
                                  setOverageBusy((b) => ({ ...b, [sid]: true }))
                                  const done = () => setOverageBusy((b) => ({ ...b, [sid]: false }))
                                  setOverage({ tokenV2: tok, userId: acc.user_id || '', spaceId: sid, enabled: next }).then(() => {
                                    done()
                                    refreshAccount(tok)
                                  }, () => {
                                    done()
                                  })
                                }}
                              />
                            )}
                          </div>
                          <div className="text-[11px] text-text-muted truncate">
                            {subscribed ? `Подписка: ${planText}` : 'Бесплатный план'}
                            {space.domain ? ` · ${space.domain}` : ''}
                          </div>
                        </div>
                        <button
                          type="button"
                          title="Удалить пространство навсегда"
                          onClick={() => {
                            setDelErr('')
                            setDelTarget({ token: acc.token_v2, userId: acc.user_id || '', spaceId: space.space_id, name: space.name || 'Workspace' })
                          }}
                          className="shrink-0 p-1.5 rounded-md text-text-muted hover:text-[#eb5757] hover:bg-white/[0.06] transition-colors bg-transparent border-none cursor-pointer"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M4 7h16" />
                            <path d="M9 7V5h6v2" />
                            <path d="M18 7l-1 13H7L6 7" />
                            <path d="M10 11v6M14 11v6" />
                          </svg>
                        </button>
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
                      <div className="flex items-center gap-2 mt-2">
                        <span className="text-[10px] text-text-muted uppercase tracking-wider shrink-0">План авто</span>
                        <select
                          value={cfg?.space_plans?.[space.space_id] || ''}
                          onChange={(e) => setSpacePlan(space.space_id, e.target.value)}
                          title="План автооплаты для этого пространства"
                          className="flex-1 min-w-0 bg-[#0a0a0a] border border-white/[0.08] rounded px-2 py-1 text-[10px] text-text-secondary focus:outline-none focus:border-white/[0.20] transition-colors cursor-pointer"
                        >
                          <option value="">По умолчанию · {globalPlanName}</option>
                          {PLANS.map((pl) => (
                            <option key={pl.id} value={pl.id}>{pl.name}</option>
                          ))}
                        </select>
                      </div>
                      <CreditsBar label="AI-токены" used={space.ai_credits_used} limit={space.ai_credits_limit} />
                      <CreditsBar
                        label="Дневной лимит"
                        note={rollingNote(space.rolling_window, space.rolling_resets_in_sec)}
                        used={space.rolling_used}
                        limit={space.rolling_limit}
                        showNums={false}
                        divider={!space.ai_credits_limit}
                      />
                      <CreditsBar
                        label="Месячный лимит"
                        note={fmtResetAt(space.period_end_ms)}
                        used={space.period_used}
                        limit={space.period_limit}
                        showNums={false}
                        divider={!space.ai_credits_limit && !space.rolling_limit}
                      />
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

      {mcpTarget && (
        <McpConnectModal
          target={mcpTarget}
          known={collectMcpServers(pool)}
          onClose={() => setMcpTarget(null)}
          onDone={() => {
            const t = mcpTarget.token
            setMcpTarget(null)
            refreshAccount(t)
          }}
        />
      )}

      {delTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-md rounded-xl border border-white/[0.10] bg-[#0b0b0b] p-5">
            <div className="text-[14px] font-medium text-text-primary mb-1">Удалить пространство?</div>
            <div className="text-[12px] text-text-secondary leading-relaxed">
              «{delTarget.name}» будет удалено вместе со страницами, базами и подключёнными MCP-серверами.
            </div>
            <div className="text-[11px] text-amber-400/80 leading-relaxed mt-2">
              Notion удаляет пространство фоновой задачей и не спрашивает подтверждение на сервере — отменить его нельзя.
            </div>
            {delErr && (
              <div className="text-[11px] text-[#eb5757] leading-snug mt-3 break-words">{delErr}</div>
            )}
            <div className="flex items-center justify-end gap-2 mt-4">
              <button
                type="button"
                disabled={delBusy}
                onClick={() => setDelTarget(null)}
                className="px-3 py-1.5 rounded border border-white/[0.10] text-[12px] text-text-secondary hover:text-text-primary hover:border-white/[0.18] transition-colors bg-transparent cursor-pointer disabled:opacity-40"
              >
                Отмена
              </button>
              <button
                type="button"
                disabled={delBusy}
                onClick={() => {
                  const t = delTarget.token
                  const uid = delTarget.userId
                  const sid = delTarget.spaceId
                  setDelBusy(true)
                  setDelErr('')
                  deleteWorkspaces(t, [sid], uid).then(
                    (res) => {
                      setDelBusy(false)
                      const first = res.deleted && res.deleted.length > 0 ? res.deleted[0] : null
                      if (res.error) {
                        setDelErr(res.error)
                        return
                      }
                      if (first && first.state === 'failure') {
                        setDelErr('Notion сообщил, что задача удаления завершилась ошибкой')
                        return
                      }
                      setDelTarget(null)
                      refreshAccount(t)
                    },
                    (e) => {
                      setDelBusy(false)
                      setDelErr(String(e))
                    },
                  )
                }}
                className="px-3 py-1.5 rounded bg-[#eb5757] text-white text-[12px] font-medium hover:bg-[#d94b4b] transition-colors border-none cursor-pointer disabled:opacity-60"
              >
                {delBusy ? 'Удаляю…' : 'Удалить навсегда'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
