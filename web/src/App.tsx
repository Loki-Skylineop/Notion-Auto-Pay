import { forgetAccount, sanitizePool } from './workspaceLifecycle'
import { AUTH_EXPIRED_EVENT, AUTH_RECOVERY_BLOCKED_EVENT } from './authRecovery'
import { useState, useEffect, useCallback, useRef } from 'react'
import { addAccount, discoverWorkspaces, extractTokens, checkAuth, deleteAccount, login as apiLogin, logout as apiLogout } from './api'
import { WorkspacePool, type DiscoveredAccount } from './components/WorkspacePool'
import { ChatTab } from './components/ChatTab'
import { ApiKeysTab } from './components/ApiKeysTab'
import { McpHostsTab } from './components/McpHostsTab'
import { ErrorBoundary } from './components/ErrorBoundary'
import { UsersTab } from './components/UsersTab'
import { fetchMe, loginWithUsername, type Me } from './apiUsers'
import { L, TAB_LABELS, type TabId } from './uiLabels'

// Server-only membership: never restore account/workspace records from browser storage.
async function fetchServerWorkspaces(): Promise<DiscoveredAccount[]> {
  const resp = await fetch('/admin/workspaces', {
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
  })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  const data = await resp.json()
  if (!Array.isArray(data)) return []
  return (data as Array<{
    user_id?: string
    user_name?: string
    user_email?: string
    token_v2?: string
    spaces?: DiscoveredAccount['spaces']
  }>)
    // Раньше отбрасывались аккаунты, по которым discovery вернул ноль
    // пространств: сервер про такой аккаунт молчал, а localStorage его
    // продолжал показывать. Теперь состав аккаунтов = ровно то, что есть
    // на сервере, а пустые spaces при гидрации подставятся из кэша.
    .filter(a => !!a.token_v2)
    .map(a => ({
      user_id: a.user_id,
      user_name: a.user_name,
      user_email: a.user_email,
      token_v2: a.token_v2 as string,
      spaces: (a.spaces || []) as DiscoveredAccount['spaces'],
    }))
}

const IconPlus = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
  </svg>
)

const IconLogOut = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
  </svg>
)

const IconEye = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" /><circle cx="12" cy="12" r="3" />
  </svg>
)

const IconEyeOff = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" />
  </svg>
)

const IconClose = ({ size = 15 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
)

// Small chevron used to collapse / expand the whole hero header. Points up when
// the header is expanded (click = collapse), flips down when collapsed.
const IconChevron = ({ up = false, size = 15 }: { up?: boolean; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform duration-200 ${up ? '' : 'rotate-180'}`}>
    <polyline points="18 15 12 9 6 15" />
  </svg>
)

// Subtle white radial glow behind the hero, matching the mockup.
const HERO_GLOW = { background: 'radial-gradient(ellipse, rgba(255,255,255,0.045) 0%, transparent 70%)' }

// Top-level tab switcher between the payment pool (Оплата) and the AI chat
// surface (Чат). Rendered as the mockup's capsule pill.
function TabBar({ tab, onChange, tabs }: { tab: TabId; onChange: (t: TabId) => void; tabs: readonly TabId[] }) {
  return (
    <div className="flex flex-wrap justify-center max-w-full p-[3px] rounded-2xl sm:rounded-full bg-white/[0.03] border border-white/[0.07]">
      {tabs.map(t => (
        <button
          key={t}
          onClick={() => onChange(t)}
          className={`px-3 sm:px-5 min-h-11 py-1.5 rounded-full text-[12px] font-medium transition-all duration-200 border-none cursor-pointer ${tab === t ? 'bg-white text-black' : 'bg-transparent text-text-muted hover:text-text-secondary'}`}
        >
          {TAB_LABELS[t]}
        </button>
      ))}
    </div>
  )
}

// Hero band: brand capsule (top-left), primary actions (top-right), centered
// tab pill + stats. Subtle white/blue/violet glow over the black canvas. A
// small chevron above the tab pill collapses the whole band to free up space —
// when collapsed only the chevron + tab pill remain.
function Hero({
  onAdd,
  accountCount,
  spaceCount,
  onLogout,
  tab,
  onTab,
  tabs,
  canAdd,
  collapsed,
  onToggleCollapse,
}: {
  onAdd: () => void
  accountCount: number
  spaceCount: number
  onLogout?: () => void
  tab?: TabId
  onTab?: (t: TabId) => void
  tabs: readonly TabId[]
  canAdd?: boolean
  collapsed?: boolean
  onToggleCollapse?: () => void
}) {
  return (
    <header className="relative overflow-hidden border-b border-white/[0.06]">
      {!collapsed && (
        <div aria-hidden="true" className="absolute inset-0 pointer-events-none overflow-hidden">
          <div className="hero-glow absolute -top-20 left-0 right-0 mx-auto w-[600px] h-[300px] rounded-full" style={HERO_GLOW} />
          <div className="hero-float-a absolute -top-8 left-1/4 w-80 h-40 bg-blue-500/[0.06] blur-3xl rounded-full" />
          <div className="hero-float-b absolute -top-8 right-1/4 w-64 h-36 bg-violet-500/[0.05] blur-3xl rounded-full" />
        </div>
      )}

      <div aria-hidden="true" className="hero-sweep absolute bottom-0 left-0 right-0 h-px pointer-events-none" />

      <div className={`relative max-w-4xl mx-auto px-5 sm:px-8 ${collapsed ? 'pt-2 pb-2' : 'pt-6 pb-5'}`}>
        {!collapsed && (
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/[0.08] bg-white/[0.02]">
              <span className="brand-star text-[11px] text-white/80">✦</span>
              <span className="text-[11px] text-text-muted tracking-wide font-mono">Notion Auto Pay</span>
            </div>
            <div className="flex items-center gap-2">
              {canAdd && (<button
                onClick={onAdd}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white text-black text-[11px] font-medium hover:bg-[#f2f2f2] active:scale-[0.98] transition-all border-none cursor-pointer"
              >
                <IconPlus size={12} />
                <span className="hidden sm:inline">Добавить аккаунт</span>
                <span className="sm:hidden">Добавить</span>
              </button>)}
              {onLogout && (
                <button
                  onClick={onLogout}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-white/[0.08] text-[11px] text-text-muted hover:text-text-secondary hover:border-white/[0.15] transition-colors bg-transparent cursor-pointer"
                >
                  <IconLogOut size={12} />
                  <span className="hidden sm:inline">Выйти</span>
                </button>
              )}
            </div>
          </div>
        )}

        {tab && onTab && (
          <div className="flex flex-col items-center gap-3">
            {onToggleCollapse && (
              <button
                onClick={onToggleCollapse}
                title={collapsed ? 'Развернуть шапку' : 'Свернуть шапку'}
                aria-label={collapsed ? 'Развернуть шапку' : 'Свернуть шапку'}
                className="-mb-0.5 p-1 rounded-md text-text-muted hover:text-text-secondary hover:bg-white/[0.04] transition-colors bg-transparent border-none cursor-pointer"
              >
                <IconChevron up={!collapsed} />
              </button>
            )}
            <TabBar tab={tab} onChange={onTab} tabs={tabs} />
            {!collapsed && (accountCount > 0 || spaceCount > 0) && (
              <div className="flex items-center gap-6 mt-1">
                <Stat value={accountCount} label="аккаунтов" />
                <span className="w-px h-7 bg-white/[0.06]" />
                <Stat value={spaceCount} label="пространств" />
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  )
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="text-center">
      <div className="text-[22px] font-medium text-white tabular-nums leading-none">{value}</div>
      <div className="text-[9px] text-text-muted uppercase tracking-widest mt-1">{label}</div>
    </div>
  )
}

// --- Login Screen ---
// Shown when the server reports that a dashboard password is required and the
// current browser session is not yet authenticated. api.login() salts +
// SHA-256-hashes the password before POSTing it.
function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!password) return
    setLoading(true)
    setError('')
    try {
      const res = username.trim()
        ? await loginWithUsername(username.trim(), password)
        : await apiLogin(password)
      if (res.ok) { onSuccess(); return }
      setError(res.error || 'Неверный пароль')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка входа')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-black flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="flex justify-center mb-8">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/[0.08] bg-white/[0.02]">
            <span className="brand-star text-[11px] text-white">✦</span>
            <span className="text-[11px] text-text-muted tracking-wide font-mono">Notion Auto Pay</span>
          </div>
        </div>
        <h1 className="text-center text-xl font-medium text-text-primary mb-1">Вход в панель</h1>
        <p className="text-center text-[12px] text-text-muted mb-8">{L.loginHint}</p>

        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            value={username}
            onChange={e => { setUsername(e.target.value); setError('') }}
            placeholder={L.loginUser}
            autoComplete="username"
            className="w-full bg-[#080808] border border-white/[0.08] rounded-lg px-3.5 py-2.5 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-white/[0.20] transition-colors"
          />
          <div className="relative">
            <input
              ref={inputRef}
              type={show ? 'text' : 'password'}
              value={password}
              onChange={e => { setPassword(e.target.value); setError('') }}
              placeholder="Пароль"
              autoComplete="current-password"
              className="w-full bg-[#080808] border border-white/[0.08] rounded-lg px-3.5 py-2.5 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-white/[0.20] transition-colors pr-10"
            />
            <button
              type="button"
              onClick={() => setShow(v => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary bg-transparent border-none cursor-pointer"
            >
              {show ? <IconEyeOff size={14} /> : <IconEye size={14} />}
            </button>
          </div>
          {error && <p className="text-[12px] text-err">{error}</p>}
          <button
            type="submit"
            disabled={loading || !password}
            className="w-full py-2.5 rounded-lg bg-white text-black text-[13px] font-medium hover:bg-[#f0f0f0] disabled:opacity-35 disabled:cursor-not-allowed transition-colors border-none cursor-pointer"
          >
            {loading ? 'Проверка…' : 'Войти'}
          </button>
        </form>
      </div>
    </div>
  )
}

// --- Add Account Modal ---

function AddAccountModal({ onClose, onDiscovered }: { onClose: () => void; onDiscovered: (acc: DiscoveredAccount) => void }) {
  type BulkStatus = 'pending' | 'running' | 'ok' | 'error'
  interface BulkItem {
    token: string
    status: BulkStatus
    label?: string
    error?: string
  }

  const [text, setText] = useState('')
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const [items, setItems] = useState<BulkItem[]>([])
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && !running) onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, running])

  const tokens = extractTokens(text)
  const okCount = items.filter(i => i.status === 'ok').length
  const failCount = items.filter(i => i.status === 'error').length
  const processed = okCount + failCount

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (running) return
    const list = extractTokens(text)
    if (list.length === 0) {
      setError('Не найдено ни одного token_v2. Вставьте токены через запятую, с новой строки или содержимое result.txt.')
      return
    }
    setError('')
    setDone(false)
    setRunning(true)
    setItems(list.map(t => ({ token: t, status: 'pending' as BulkStatus })))

    const mark = (idx: number, patch: Partial<BulkItem>) => {
      setItems(prev => prev.map((it, j) => (j === idx ? { ...it, ...patch } : it)))
    }

    const worker = async (idx: number) => {
      const tok = list[idx]
      mark(idx, { status: 'running' })
      try {
        const res = await addAccount(tok)
        if (res.error) {
          mark(idx, { status: 'error', error: res.error })
          return
        }
        let label = res.account?.email || res.account?.name || ''
        try {
          const disc = await discoverWorkspaces(tok)
          if (!disc.error && disc.spaces && disc.spaces.length > 0) {
            onDiscovered({
              user_id: disc.user_id,
              user_name: disc.user_name || res.account?.name,
              user_email: disc.user_email || res.account?.email,
              token_v2: tok,
              spaces: disc.spaces,
            })
            if (!label) label = disc.user_email || disc.user_name || ''
            label = `${label}${label ? ' · ' : ''}${disc.spaces.length} простр.`
          }
        } catch { /* discovery best-effort */ }
        mark(idx, { status: 'ok', label: label || 'добавлен' })
      } catch (err) {
        mark(idx, { status: 'error', error: err instanceof Error ? err.message : 'Ошибка запроса' })
      }
    }

    // Ограниченная параллельность: не бомбим сервер и Notion всеми токенами
    // сразу, но и не ждём каждый строго по очереди.
    const CONCURRENCY = 4
    let next = 0
    const runners = Array.from({ length: Math.min(CONCURRENCY, list.length) }, async () => {
      while (next < list.length) {
        const idx = next++
        await worker(idx)
      }
    })
    await Promise.all(runners)

    setRunning(false)
    setDone(true)
  }

  const statusDot = (s: BulkStatus) => {
    if (s === 'ok') return <span className='text-ok'>✓</span>
    if (s === 'error') return <span className='text-err'>✗</span>
    if (s === 'running') return <span className='text-text-secondary animate-pulse'>…</span>
    return <span className='text-text-muted'>•</span>
  }

  const shortToken = (t: string) => (t.length > 22 ? `${t.slice(0, 14)}…${t.slice(-4)}` : t)

  const resetForm = () => {
    setItems([])
    setText('')
    setDone(false)
    setError('')
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  return (
    <div className='fixed inset-0 z-[100] flex items-center justify-center p-4'>
      <div className='absolute inset-0 bg-black/75 backdrop-blur-sm' onClick={() => { if (!running) onClose() }} />
      <div className='relative w-full max-w-lg rounded-xl border border-white/[0.12] bg-[#0c0c0c] shadow-modal overflow-hidden'>
        <div className='flex items-center justify-between px-5 py-4 border-b border-white/[0.07]'>
          <div className='text-[13px] font-medium text-text-primary'>Массовое добавление аккаунтов Notion</div>
          <button onClick={onClose} disabled={running} className='p-1 rounded text-text-muted hover:text-text-secondary bg-transparent border-none cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed'>
            <IconClose size={15} />
          </button>
        </div>

        <div className='p-5 space-y-4'>
          {items.length === 0 ? (
            <form onSubmit={handleSubmit} className='space-y-4'>
              <p className='text-[12px] text-text-secondary leading-relaxed'>
                Вставьте один или несколько{' '}
                <code className='px-1 py-0.5 rounded bg-white/[0.05] text-text-secondary font-mono text-[11px]'>token_v2</code>{' '}
                — через запятую, с новой строки или целиком содержимое{' '}
                <span className='text-text-primary'>result.txt</span>.
              </p>
              <textarea
                ref={inputRef}
                value={text}
                onChange={e => { setText(e.target.value); setError('') }}
                placeholder={'v02:token_a...,\nv03:token_b...\n\nили вставьте содержимое result.txt'}
                rows={7}
                className='w-full bg-[#080808] border border-white/[0.08] rounded-lg px-3 py-2.5 text-[12px] text-text-primary placeholder:text-text-muted font-mono resize-none focus:outline-none focus:border-white/[0.18] transition-colors'
              />
              <div className='flex items-center justify-between text-[11px]'>
                <span className='text-text-muted'>
                  {tokens.length > 0 ? `Найдено токенов: ${tokens.length}` : 'Токены не обнаружены'}
                </span>
              </div>
              {error && <p className='text-[12px] text-err'>{error}</p>}
              <div className='flex gap-2.5'>
                <button
                  type='button'
                  onClick={onClose}
                  className='flex-1 py-2 rounded-lg border border-white/[0.08] text-[12px] text-text-muted hover:text-text-secondary hover:border-white/[0.14] transition-colors bg-transparent cursor-pointer'
                >
                  Отмена
                </button>
                <button
                  type='submit'
                  disabled={tokens.length === 0}
                  className='flex-1 py-2 rounded-lg bg-white text-black text-[12px] font-medium hover:bg-[#f0f0f0] disabled:opacity-35 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 border-none cursor-pointer'
                >
                  {tokens.length > 1 ? `Добавить ${tokens.length} аккаунтов` : 'Добавить аккаунт'}
                </button>
              </div>
            </form>
          ) : (
            <div className='space-y-4'>
              <div className='flex items-center justify-between'>
                <div className='text-[12px] text-text-secondary'>
                  {running ? `Добавление… ${processed}/${items.length}` : 'Готово'}
                </div>
                <div className='text-[11px] text-text-muted'>
                  <span className='text-ok'>✓ {okCount}</span>
                  {failCount > 0 && <span className='text-err'> · ✗ {failCount}</span>}
                </div>
              </div>

              <div className='h-1 w-full rounded-full bg-white/[0.06] overflow-hidden'>
                <div
                  className='h-full bg-notion-blue transition-all'
                  style={{ width: `${items.length ? (processed / items.length) * 100 : 0}%` }}
                />
              </div>

              <div className='max-h-64 overflow-y-auto space-y-1.5 pr-1'>
                {items.map((it, i) => (
                  <div key={i} className='flex items-start gap-2 text-[11px] leading-snug'>
                    <span className='mt-[1px] w-3 text-center shrink-0'>{statusDot(it.status)}</span>
                    <div className='min-w-0 flex-1'>
                      <div className='font-mono text-text-muted truncate'>{shortToken(it.token)}</div>
                      {it.status === 'ok' && it.label && <div className='text-ok truncate'>{it.label}</div>}
                      {it.status === 'error' && <div className='text-err truncate'>{it.error || 'Ошибка'}</div>}
                    </div>
                  </div>
                ))}
              </div>

              <div className='flex gap-2.5'>
                <button
                  type='button'
                  onClick={onClose}
                  disabled={running}
                  className='flex-1 py-2 rounded-lg border border-white/[0.08] text-[12px] text-text-muted hover:text-text-secondary hover:border-white/[0.14] transition-colors bg-transparent cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed'
                >
                  {running ? 'Добавление…' : 'Закрыть'}
                </button>
                {done && (
                  <button
                    type='button'
                    onClick={resetForm}
                    className='flex-1 py-2 rounded-lg bg-white text-black text-[12px] font-medium hover:bg-[#f0f0f0] transition-colors border-none cursor-pointer'
                  >
                    Добавить ещё
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// Идентичность аккаунта. user_id живёт дольше почты и токена, поэтому он
// первый: при переоткрытии сессии token_v2 меняется, и ключ по токену
// раздваивал один и тот же аккаунт в списке.
function accountKey(a: { user_id?: string; user_email?: string; token_v2?: string }): string {
  return a.user_id || a.user_email || a.token_v2 || ''
}

// Пул отдаёт наверх ключ, который посчитал сам (email или токен), поэтому
// сверяем аккаунт по всем трём идентификаторам.
function matchesAccountKey(a: DiscoveredAccount, key: string): boolean {
  return a.user_id === key || a.user_email === key || a.token_v2 === key
}

function Dashboard({ onLogout, me }: { onLogout?: () => void; me: Me | null }) {
  // Admin rights only once /admin/me confirms them: a slow, failed or offline
  // answer must never hand a regular user the admin controls. In the open
  // no-password mode the server itself reports is_admin: true.
  const isAdmin = me?.is_admin === true
  const tabs = (isAdmin ? (['pay', 'chat', 'mcp', 'api', 'users'] as const) : (['pay', 'chat', 'mcp'] as const)) as readonly TabId[]
  const canAdd = isAdmin
  const [showAddModal, setShowAddModal] = useState(false)
  const [tab, setTab] = useState<TabId>(() => {
    try {
      const saved = localStorage.getItem('nmp_active_tab')
      return saved === 'chat' || saved === 'mcp' || saved === 'api' || saved === 'users' ? saved : 'pay'
    } catch {
      return 'pay'
    }
  })
  const [headerCollapsed, setHeaderCollapsed] = useState(false)
  const [hydrating, setHydrating] = useState(true)
  const [discovered, setDiscoveredState] = useState<DiscoveredAccount[]>([])
  const setDiscovered = useCallback((update: DiscoveredAccount[] | ((prev: DiscoveredAccount[]) => DiscoveredAccount[])) => {
    setDiscoveredState(prev => sanitizePool(typeof update === 'function' ? update(prev) : update))
  }, [])
  // Retire ALL historical workspace caches. F5 starts empty and trusts the server.
  useEffect(() => {
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('nmp_discovered_workspaces')) localStorage.removeItem(key)
      }
    } catch { /* storage can be disabled */ }
  }, [])

  // Свежий список для колбэков с пустыми зависимостями (removeDiscovered).
  const discoveredRef = useRef<DiscoveredAccount[]>(discovered)
  useEffect(() => { discoveredRef.current = discovered }, [discovered])

  // Remember which tab the user was on so a reload reopens the same one.
  useEffect(() => {
    try {
      localStorage.setItem('nmp_active_tab', tab)
    } catch { /* ignore */ }
  }, [tab])

  useEffect(() => {
    if (!me) return
    let cancelled = false
    setHydrating(true)
    fetchServerWorkspaces()
      .then(serverAccounts => {
        if (cancelled) return
        setDiscovered(serverAccounts)
      })
      .catch(() => { /* no old browser cache is restored on failure */ })
      .finally(() => { if (!cancelled) setHydrating(false) })
    return () => { cancelled = true }
  }, [me?.username])

  const upsertDiscovered = useCallback((acc: DiscoveredAccount) => {
    setDiscovered(prev => {
      const key = accountKey(acc)
      const rest = prev.filter(a => accountKey(a) !== key)
      return [acc, ...rest]
    })
  }, [])

  // Удаление аккаунта из пула. Раньше отсюда только фильтровался React-стейт:
  // файл аккаунта на сервере оставался жить, /admin/workspaces продолжал его
  // отдавать, и «удалённый» аккаунт возвращался при следующем входе.
  const removeDiscovered = useCallback(async (key: string) => {
    const acc = discoveredRef.current.find(a => matchesAccountKey(a, key))
    if (!acc) return
    if (!acc.user_email) throw new Error('Нет email аккаунта: серверное удаление невозможно, аккаунт не удалён')
    await deleteAccount(acc.user_email)
    forgetAccount(acc)
    setDiscovered(prev => prev.filter(a => !matchesAccountKey(a, key)))
  }, [setDiscovered])

  const accountCount = discovered.length
  const spaceCount = discovered.reduce((s, a) => s + (a.spaces?.length || 0), 0)

  // A regular user must never stay on the admin-only tab.
  useEffect(() => {
    if (!isAdmin && (tab === 'users' || tab === 'api')) setTab('pay')
  }, [isAdmin, tab])

  return (
    <div className="min-h-screen">
      <Hero
        onAdd={() => setShowAddModal(true)}
        accountCount={accountCount}
        spaceCount={spaceCount}
        onLogout={onLogout}
        tab={tab}
        onTab={setTab}
        tabs={tabs}
        canAdd={canAdd}
        collapsed={headerCollapsed}
        onToggleCollapse={() => setHeaderCollapsed(v => !v)}
      />

      <main className={`px-5 sm:px-8 py-7 ${tab === 'chat' ? 'w-full' : 'max-w-4xl mx-auto'}`}>
        {/* Обе вкладки смонтированы всегда и просто прячутся через hidden. Так
            чат помнит, какой диалог был открыт, а идущий ход агента не рвётся,
            когда пользователь уходит на «Оплату» и возвращается обратно. */}
        <div hidden={tab !== 'pay'}>
          {discovered.length === 0 ? (
            hydrating ? (
              <div className="text-center py-24 text-text-muted text-[13px]">Загрузка рабочих пространств…</div>
            ) : (
              <div className="flex flex-col items-center justify-center py-24 gap-4">
                <div className="w-12 h-12 rounded-full border border-white/[0.07] flex items-center justify-center text-text-muted text-2xl">◻</div>
                <div className="text-[13px] text-text-muted">{isAdmin ? L.emptyAdmin : L.emptyUser}</div>
                {canAdd && (<button
                  onClick={() => setShowAddModal(true)}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-white text-black text-[12px] font-medium hover:bg-[#f0f0f0] transition-colors border-none cursor-pointer"
                >
                  <IconPlus size={13} /> Добавить аккаунт
                </button>)}
              </div>
            )
          ) : (
            <>
              {!isAdmin && <div className="mb-3 text-[11px] text-text-muted">{L.readOnlyNote}</div>}
              <WorkspacePool accounts={discovered} onRemoveAccount={removeDiscovered} onPoolChange={setDiscovered} onPaid={() => {}} readOnly={!isAdmin} />
            </>
          )}
        </div>
        <div hidden={tab !== 'chat'}>
          {/* Своя граница ошибок на чат: его падение больше не гасит вкладку «Оплата». */}
          <ErrorBoundary>
            {me ? <ChatTab key={me.username || '@open-dashboard'} owner={me.username || '@open-dashboard'} accountsReady={!hydrating} accounts={discovered} active={tab === 'chat'} onPoolChange={setDiscovered} /> : <div className="text-[12px] text-text-muted">Определяю аккаунт панели… Если сервер недоступен, обновите страницу после восстановления связи.</div>}
          </ErrorBoundary>
        </div>
        {me && <div hidden={tab !== 'mcp'}><ErrorBoundary><McpHostsTab key={me.username || '@open-dashboard'} owner={me.username || '@open-dashboard'} active={tab === 'mcp'} /></ErrorBoundary></div>}
        {isAdmin && (
          <div hidden={tab !== 'api'}>
            <ErrorBoundary>
              <ApiKeysTab accounts={discovered} active={tab === 'api'} />
            </ErrorBoundary>
          </div>
        )}
        {isAdmin && (
          <div hidden={tab !== 'users'}>
            <ErrorBoundary>
              <UsersTab accounts={discovered} currentUsername={me?.username || ''} active={tab === 'users'} />
            </ErrorBoundary>
          </div>
        )}
      </main>

      {canAdd && showAddModal && <AddAccountModal onClose={() => setShowAddModal(false)} onDiscovered={upsertDiscovered} />}
    </div>
  )
}

export default function App() {
  const [authState, setAuthState] = useState<'loading' | 'login' | 'authed'>('loading')
  const [requiresPassword, setRequiresPassword] = useState(false)
  const [me, setMe] = useState<Me | null>(null)
  const [recoveryWarning, setRecoveryWarning] = useState(false)

  useEffect(() => {
    const expired = () => { setMe(null); setRequiresPassword(true); setAuthState('login') }
    const blocked = () => setRecoveryWarning(true)
    window.addEventListener(AUTH_EXPIRED_EVENT, expired)
    window.addEventListener(AUTH_RECOVERY_BLOCKED_EVENT, blocked)
    return () => {
      window.removeEventListener(AUTH_EXPIRED_EVENT, expired)
      window.removeEventListener(AUTH_RECOVERY_BLOCKED_EVENT, blocked)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    checkAuth()
      .then(res => {
        if (cancelled) return
        setRequiresPassword(res.required)
        if (!res.required || res.authenticated) setAuthState('authed')
        else setAuthState('login')
      })
      .catch(() => {
        if (!cancelled) setAuthState('authed')
      })
    return () => { cancelled = true }
  }, [])

  // Who am I: role and granted scope. Drives the users tab and read-only mode.
  useEffect(() => {
    if (authState !== 'authed') return
    let cancelled = false
    fetchMe()
      .then(m => { if (!cancelled) setMe(m) })
      .catch(() => { if (!cancelled) setMe(null) })
    return () => { cancelled = true }
  }, [authState])

  const handleLogout = useCallback(async () => {
    try { await apiLogout() } catch { /* ignore */ }
    setMe(null)
    setAuthState('login')
  }, [])

  if (authState === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center text-text-muted text-[13px]">Загрузка…</div>
    )
  }

  if (authState === 'login') {
    return <LoginScreen onSuccess={() => setAuthState('authed')} />
  }

  return <>
    {recoveryWarning && <div role="alert" className="p-3 text-[12px] text-amber-400 bg-amber-950/30">Повторная ошибка авторизации. Автоперезагрузка приостановлена, чтобы избежать цикла. <button className="underline cursor-pointer" onClick={() => window.location.reload()}>Обновить страницу</button></div>}
    <Dashboard onLogout={requiresPassword ? handleLogout : undefined} me={me} />
  </>
}
