import { useState, useEffect, useCallback, useRef } from 'react'
import { addAccount, discoverWorkspaces, checkAuth, login as apiLogin, logout as apiLogout } from './api'
import { WorkspacePool, type DiscoveredAccount } from './components/WorkspacePool'
import { ChatTab } from './components/ChatTab'

// Pull the persisted accounts + their workspaces straight from the server so
// the pool shows up even in a fresh browser / incognito window where the
// localStorage cache (nmp_discovered_workspaces) is empty.
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
    .filter(a => a.token_v2 && a.spaces && a.spaces.length > 0)
    .map(a => ({
      user_id: a.user_id,
      user_name: a.user_name,
      user_email: a.user_email,
      token_v2: a.token_v2 as string,
      spaces: a.spaces as DiscoveredAccount['spaces'],
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
function TabBar({ tab, onChange }: { tab: 'pay' | 'chat'; onChange: (t: 'pay' | 'chat') => void }) {
  return (
    <div className="p-[3px] rounded-full bg-white/[0.03] border border-white/[0.07]">
      {(['pay', 'chat'] as const).map(t => (
        <button
          key={t}
          onClick={() => onChange(t)}
          className={`px-5 py-1.5 rounded-full text-[12px] font-medium transition-all duration-200 border-none cursor-pointer ${tab === t ? 'bg-white text-black' : 'bg-transparent text-text-muted hover:text-text-secondary'}`}
        >
          {t === 'pay' ? 'Оплата' : 'Чат'}
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
  collapsed,
  onToggleCollapse,
}: {
  onAdd: () => void
  accountCount: number
  spaceCount: number
  onLogout?: () => void
  tab?: 'pay' | 'chat'
  onTab?: (t: 'pay' | 'chat') => void
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
              <button
                onClick={onAdd}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white text-black text-[11px] font-medium hover:bg-[#f2f2f2] active:scale-[0.98] transition-all border-none cursor-pointer"
              >
                <IconPlus size={12} />
                <span className="hidden sm:inline">Добавить аккаунт</span>
                <span className="sm:hidden">Добавить</span>
              </button>
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
            <TabBar tab={tab} onChange={onTab} />
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
      const res = await apiLogin(password)
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
        <p className="text-center text-[12px] text-text-muted mb-8">Введите пароль для доступа</p>

        <form onSubmit={handleSubmit} className="space-y-3">
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
  const [token, setToken] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ name: string; email: string; space: string; plan_type: string } | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = token.trim()
    if (!trimmed) return
    setLoading(true)
    setError('')
    setResult(null)
    try {
      const res = await addAccount(trimmed)
      if (res.error) {
        setError(res.error)
        setLoading(false)
        return
      }
      // Авто-обнаружение всех рабочих пространств аккаунта.
      try {
        const disc = await discoverWorkspaces(trimmed)
        if (!disc.error && disc.spaces && disc.spaces.length > 0) {
          onDiscovered({
            user_id: disc.user_id,
            user_name: disc.user_name || res.account?.name,
            user_email: disc.user_email || res.account?.email,
            token_v2: trimmed,
            spaces: disc.spaces,
          })
        }
      } catch { /* discovery best-effort */ }
      if (res.account) {
        setResult(res.account)
      }
      setTimeout(() => {
        onClose()
      }, 1600)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка запроса')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-xl border border-white/[0.12] bg-[#0c0c0c] shadow-modal overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.07]">
          <div className="text-[13px] font-medium text-text-primary">Добавить аккаунт Notion</div>
          <button onClick={onClose} className="p-1 rounded text-text-muted hover:text-text-secondary bg-transparent border-none cursor-pointer">
            <IconClose size={15} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {result ? (
            <div className="flex flex-col items-center py-6 gap-3">
              <div className="w-10 h-10 rounded-full bg-ok/10 border border-ok/30 flex items-center justify-center text-ok text-lg leading-none">✓</div>
              <div className="text-[13px] font-medium text-text-primary">Аккаунт добавлен</div>
              <div className="text-[11px] text-text-muted text-center">
                {result.name} · {result.email}<br />{result.space} · {result.plan_type}
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <p className="text-[12px] text-text-secondary leading-relaxed">
                Откройте <span className="text-text-primary">notion.so</span> → F12 → Application → Cookies →{' '}
                <code className="px-1 py-0.5 rounded bg-white/[0.05] text-text-secondary font-mono text-[11px]">token_v2</code>
              </p>
              <textarea
                ref={inputRef}
                value={token}
                onChange={e => { setToken(e.target.value); setError('') }}
                placeholder="v02:user_token_or_internal:..."
                rows={4}
                className="w-full bg-[#080808] border border-white/[0.08] rounded-lg px-3 py-2.5 text-[12px] text-text-primary placeholder:text-text-muted font-mono resize-none focus:outline-none focus:border-white/[0.18] transition-colors"
              />
              {error && <p className="text-[12px] text-err">{error}</p>}
              <div className="flex gap-2.5">
                <button
                  type="button"
                  onClick={onClose}
                  className="flex-1 py-2 rounded-lg border border-white/[0.08] text-[12px] text-text-muted hover:text-text-secondary hover:border-white/[0.14] transition-colors bg-transparent cursor-pointer"
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  disabled={loading || !token.trim()}
                  className="flex-1 py-2 rounded-lg bg-white text-black text-[12px] font-medium hover:bg-[#f0f0f0] disabled:opacity-35 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 border-none cursor-pointer"
                >
                  {loading ? 'Проверка…' : 'Добавить аккаунт'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}

function Dashboard({ onLogout }: { onLogout?: () => void }) {
  const [showAddModal, setShowAddModal] = useState(false)
  const [tab, setTab] = useState<'pay' | 'chat'>(() => {
    try {
      return localStorage.getItem('nmp_active_tab') === 'chat' ? 'chat' : 'pay'
    } catch {
      return 'pay'
    }
  })
  const [headerCollapsed, setHeaderCollapsed] = useState(false)
  const [discovered, setDiscovered] = useState<DiscoveredAccount[]>(() => {
    try {
      const raw = localStorage.getItem('nmp_discovered_workspaces')
      return raw ? (JSON.parse(raw) as DiscoveredAccount[]) : []
    } catch {
      return []
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('nmp_discovered_workspaces', JSON.stringify(discovered))
    } catch { /* ignore */ }
  }, [discovered])

  // Remember which tab the user was on so a reload reopens the same one.
  useEffect(() => {
    try {
      localStorage.setItem('nmp_active_tab', tab)
    } catch { /* ignore */ }
  }, [tab])

  const [hydrating, setHydrating] = useState(true)
  useEffect(() => {
    let cancelled = false
    fetchServerWorkspaces()
      .then(serverAccounts => {
        if (cancelled || serverAccounts.length === 0) return
        setDiscovered(prev => {
          const byKey = new Map<string, DiscoveredAccount>()
          for (const a of prev) byKey.set(a.user_email || a.token_v2, a)
          for (const a of serverAccounts) byKey.set(a.user_email || a.token_v2, a)
          return Array.from(byKey.values())
        })
      })
      .catch(() => { /* server hydration is best-effort */ })
      .finally(() => { if (!cancelled) setHydrating(false) })
    return () => { cancelled = true }
  }, [])

  const upsertDiscovered = useCallback((acc: DiscoveredAccount) => {
    setDiscovered(prev => {
      const key = acc.user_email || acc.token_v2
      const rest = prev.filter(a => (a.user_email || a.token_v2) !== key)
      return [acc, ...rest]
    })
  }, [])
  const removeDiscovered = useCallback((key: string) => {
    setDiscovered(prev => prev.filter(a => (a.user_email || a.token_v2) !== key))
  }, [])

  const accountCount = discovered.length
  const spaceCount = discovered.reduce((s, a) => s + (a.spaces?.length || 0), 0)

  return (
    <div className="min-h-screen">
      <Hero
        onAdd={() => setShowAddModal(true)}
        accountCount={accountCount}
        spaceCount={spaceCount}
        onLogout={onLogout}
        tab={tab}
        onTab={setTab}
        collapsed={headerCollapsed}
        onToggleCollapse={() => setHeaderCollapsed(v => !v)}
      />

      <main className={`px-5 sm:px-8 py-7 ${tab === 'chat' ? 'w-full' : 'max-w-4xl mx-auto'}`}>
        {tab === 'pay' ? (
          discovered.length === 0 ? (
            hydrating ? (
              <div className="text-center py-24 text-text-muted text-[13px]">Загрузка рабочих пространств…</div>
            ) : (
              <div className="flex flex-col items-center justify-center py-24 gap-4">
                <div className="w-12 h-12 rounded-full border border-white/[0.07] flex items-center justify-center text-text-muted text-2xl">◻</div>
                <div className="text-[13px] text-text-muted">Пока нет рабочих пространств</div>
                <button
                  onClick={() => setShowAddModal(true)}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-white text-black text-[12px] font-medium hover:bg-[#f0f0f0] transition-colors border-none cursor-pointer"
                >
                  <IconPlus size={13} /> Добавить аккаунт
                </button>
              </div>
            )
          ) : (
            <WorkspacePool accounts={discovered} onRemoveAccount={removeDiscovered} onPaid={() => {}} />
          )
        ) : (
          <ChatTab accounts={discovered} />
        )}
      </main>

      {showAddModal && <AddAccountModal onClose={() => setShowAddModal(false)} onDiscovered={upsertDiscovered} />}
    </div>
  )
}

export default function App() {
  const [authState, setAuthState] = useState<'loading' | 'login' | 'authed'>('loading')
  const [requiresPassword, setRequiresPassword] = useState(false)

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

  const handleLogout = useCallback(async () => {
    try { await apiLogout() } catch { /* ignore */ }
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

  return <Dashboard onLogout={requiresPassword ? handleLogout : undefined} />
}
