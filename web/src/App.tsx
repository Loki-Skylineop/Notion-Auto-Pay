import { useState, useEffect, useCallback, useRef } from 'react'
import { addAccount, discoverWorkspaces } from './api'
import { WorkspacePool, type DiscoveredAccount } from './components/WorkspacePool'

const IconPlus = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
  </svg>
)

const IconSpark = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2l1.7 6.3L20 10l-6.3 1.7L12 18l-1.7-6.3L4 10l6.3-1.7z" />
  </svg>
)

// Hero band carrying the brand's signature mesh-gradient atmospheric glow over
// the black canvas. Headline copy intentionally omitted — just the brand chip
// and the primary action.
function Hero({ onAdd, accountCount, spaceCount }: { onAdd: () => void; accountCount: number; spaceCount: number }) {
  return (
    <header className="relative overflow-hidden border-b border-border">
      <div aria-hidden="true" className="mesh-hero pointer-events-none absolute -top-56 left-1/2 -translate-x-1/2 w-[150%] h-[520px] opacity-70" />
      <div className="relative max-w-[1100px] mx-auto px-6 pt-16 pb-12 text-center">
        <span className="eyebrow inline-flex items-center gap-1.5 bg-white/5 backdrop-blur border border-border rounded-full px-3 py-1 shadow-card">
          <IconSpark /> Motion Pay
        </span>
        <div className="flex items-center justify-center gap-3 mt-7">
          <button
            onClick={onAdd}
            className="inline-flex items-center gap-2 h-11 px-5 bg-white hover:bg-white/90 text-black rounded-full text-[15px] font-medium cursor-pointer transition-colors border-none"
          >
            <IconPlus /> Добавить аккаунт
          </button>
        </div>
        {(accountCount > 0 || spaceCount > 0) && (
          <div className="flex items-center justify-center gap-6 mt-9">
            <Stat value={accountCount} label="аккаунтов" />
            <span className="w-px h-8 bg-border" />
            <Stat value={spaceCount} label="пространств" />
          </div>
        )}
      </div>
    </header>
  )
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex flex-col items-center">
      <span className="text-[24px] font-semibold tracking-tight text-text-primary tabular-nums leading-none">{value}</span>
      <span className="text-[12px] text-text-muted mt-1.5">{label}</span>
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
      // Авто-обнаружение всех рабочих пространств аккаунта,
      // чтобы они появились в пуле ниже.
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
      }, 1500)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка запроса')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-lg bg-bg-card border border-border rounded-2xl shadow-modal p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[18px] font-semibold tracking-tight text-text-primary">Добавить аккаунт Notion</h2>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-full text-text-muted hover:text-text-primary hover:bg-bg-secondary bg-transparent border-none cursor-pointer text-lg leading-none">×</button>
        </div>

        <div className="text-[13px] text-text-secondary mb-4 space-y-1.5">
          <p>Вставьте cookie <code className="font-mono bg-bg-secondary px-1.5 py-0.5 rounded text-[12px] text-text-primary">token_v2</code> — система автоматически получит данные аккаунта.</p>
          <p className="text-text-muted">Как получить: откройте <code className="font-mono bg-bg-secondary px-1.5 py-0.5 rounded text-[12px] text-text-primary">notion.so</code> → F12 → Application → Cookies → скопируйте значение <code className="font-mono bg-bg-secondary px-1.5 py-0.5 rounded text-[12px] text-text-primary">token_v2</code></p>
        </div>

        <form onSubmit={handleSubmit}>
          <textarea
            ref={inputRef}
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder="Вставьте значение token_v2..."
            rows={3}
            className="w-full py-2.5 px-3 bg-bg-input border border-border rounded-lg text-[13px] text-text-primary outline-none focus:border-notion-blue focus:ring-2 focus:ring-notion-blue/20 transition-all placeholder:text-text-muted resize-none font-mono"
          />
          {error && (
            <div className="text-err text-[12px] mt-2 px-1">{error}</div>
          )}
          {result && (
            <div className="mt-3 p-3 bg-notion-blue/10 border border-notion-blue/30 rounded-lg text-[12px]">
              <div className="text-notion-blue font-semibold mb-1.5">Аккаунт добавлен</div>
              <div className="space-y-0.5 text-text-secondary">
                <div>Пользователь: <span className="text-text-primary font-medium">{result.name}</span> ({result.email})</div>
                <div>Пространство: <span className="text-text-primary font-medium">{result.space}</span> · {result.plan_type}</div>
              </div>
            </div>
          )}
          <div className="flex gap-2.5 mt-5">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 h-11 bg-bg-card hover:bg-bg-secondary text-text-primary rounded-full text-[14px] font-medium cursor-pointer transition-colors border border-border"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={loading || !token.trim() || !!result}
              className="flex-1 h-11 bg-white hover:bg-white/90 text-black rounded-full text-[14px] font-medium cursor-pointer transition-colors border-none disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {loading ? 'Проверка...' : 'Добавить аккаунт'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function App() {
  const [showAddModal, setShowAddModal] = useState(false)
  // Обнаруженные рабочие пространства по каждому добавленному аккаунту.
  // Сохраняются локально, чтобы пул переживал перезагрузку.
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
      <Hero onAdd={() => setShowAddModal(true)} accountCount={accountCount} spaceCount={spaceCount} />

      <main className="max-w-[1100px] mx-auto px-6 py-10">
        {discovered.length === 0 ? (
          <div className="text-center py-16 px-6 bg-bg-secondary border border-border rounded-2xl">
            <div className="w-12 h-12 mx-auto mb-4 rounded-xl bg-bg-card border border-border flex items-center justify-center text-text-muted shadow-card">
              <IconPlus />
            </div>
            <div className="text-[16px] font-medium text-text-primary mb-1">Пока нет рабочих пространств</div>
            <p className="text-[13px] text-text-muted max-w-sm mx-auto mb-5">
              Нажмите «Добавить аккаунт» — все пространства токена появятся здесь автоматически.
            </p>
            <button
              onClick={() => setShowAddModal(true)}
              className="inline-flex items-center gap-2 h-9 px-4 bg-white hover:bg-white/90 text-black rounded-full text-[13px] font-medium cursor-pointer transition-colors border-none"
            >
              <IconPlus /> Добавить аккаунт
            </button>
          </div>
        ) : (
          <WorkspacePool accounts={discovered} onRemoveAccount={removeDiscovered} onPaid={() => {}} />
        )}
      </main>

      {showAddModal && <AddAccountModal onClose={() => setShowAddModal(false)} onDiscovered={upsertDiscovered} />}
    </div>
  )
}
