import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchApiConfig, updateApiConfig, type ApiConfig } from '../apiKeys'
import type { DiscoveredAccount } from './WorkspacePool'

const INPUT = 'w-full bg-[#0a0a0a] border border-white/[0.08] rounded-md px-3 py-2 text-[12px] text-text-primary focus:outline-none focus:border-white/[0.20] transition-colors'
const CARD = 'rounded-xl border border-white/[0.08] bg-[#0c0c0c]'
const BTN = 'px-3 py-2 rounded-lg border border-white/[0.09] text-[12px] text-text-secondary hover:border-white/[0.18] hover:text-text-primary transition-colors bg-transparent cursor-pointer disabled:opacity-40'
const PRIMARY = 'px-4 py-2 rounded-lg bg-white text-black text-[12px] font-medium hover:bg-[#f0f0f0] transition-colors border-none cursor-pointer disabled:opacity-40'

interface SpaceOption {
  id: string
  name: string
  viewId: string
  email: string
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText)
    return navigator.clipboard.writeText(value)
  return Promise.reject(new Error('Буфер обмена недоступен'))
}

export function ApiKeysTab({ accounts, active = false }: { accounts: DiscoveredAccount[]; active?: boolean }) {
  const [config, setConfig] = useState<ApiConfig | null>(null)
  const [selectedSpace, setSelectedSpace] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const loaded = useRef(false)

  const spaces = useMemo<SpaceOption[]>(() => {
    const result: SpaceOption[] = []
    const seen = new Set<string>()
    for (const account of accounts) {
      const email = (account.user_email || '').trim()
      for (const space of account.spaces || []) {
        if (!space.space_id || seen.has(space.space_id)) continue
        seen.add(space.space_id)
        result.push({
          id: space.space_id,
          name: space.name || space.space_id,
          viewId: space.space_view_id || '',
          email,
        })
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  }, [accounts])

  const applyConfig = useCallback((next: ApiConfig) => {
    setConfig(next)
    setSelectedSpace(next.routing.mode === 'pinned' ? next.routing.space_id : '')
    setSelectedModel(next.default_model)
  }, [])

  const load = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      applyConfig(await fetchApiConfig())
    }
    catch (e) {
      setError(errorText(e))
    }
    finally {
      setBusy(false)
    }
  }, [applyConfig])

  useEffect(() => {
    if (!active || loaded.current) return
    loaded.current = true
    void load()
  }, [active, load])

  const endpoint = typeof window === 'undefined'
    ? '/v1/'
    : `${window.location.origin}${config?.base_path || '/v1/'}`

  async function save() {
    if (!config) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const space = spaces.find(item => item.id === selectedSpace)
      const next = await updateApiConfig({
        default_model: selectedModel,
        api_routing: space ? 'pinned' : 'auto',
        api_account: space?.email || '',
        api_space: space?.id || '',
        api_space_name: space?.name || '',
        api_space_view_id: space?.viewId || '',
      })
      applyConfig(next)
      setNotice('Настройки сохранены. Новые запросы AIRI пойдут по выбранному маршруту.')
    }
    catch (e) {
      setError(errorText(e))
    }
    finally {
      setBusy(false)
    }
  }

  async function rotateKey() {
    if (!confirm('Создать новый ключ? Старый ключ сразу перестанет работать.')) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const next = await updateApiConfig({ rotate_key: true })
      applyConfig(next)
      setShowKey(true)
      try {
        await copyText(next.api_key)
        setNotice('Новый ключ создан и скопирован. Вставьте его в провайдер Notion AI в AIRI.')
      }
      catch {
        setNotice('Новый ключ создан. Скопируйте его вручную и вставьте в AIRI.')
      }
    }
    catch (e) {
      setError(errorText(e))
    }
    finally {
      setBusy(false)
    }
  }

  async function copy(value: string, label: string) {
    setError('')
    try {
      await copyText(value)
      setNotice(`${label} скопирован.`)
    }
    catch (e) {
      setError(errorText(e))
    }
  }

  if (!config && busy)
    return <div className="py-20 text-center text-[13px] text-text-muted">Загрузка API-настроек…</div>

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">API-ключи · AIRI MVP</h2>
          <p className="mt-1 text-[12px] text-text-muted">Тестовая интеграция: один ключ, один выбранный workspace и одна модель.</p>
        </div>
        <button className={BTN} onClick={() => void load()} disabled={busy}>Обновить</button>
      </div>

      {error && <div className="rounded-lg border border-[#eb5757]/35 bg-[#eb5757]/10 px-3 py-2 text-[12px] text-[#ff8d8d]">{error}</div>}
      {notice && <div className="rounded-lg border border-emerald-400/25 bg-emerald-400/10 px-3 py-2 text-[12px] text-emerald-300">{notice}</div>}

      <section className={`${CARD} p-4 space-y-4`}>
        <div>
          <div className="text-[13px] font-medium text-text-primary">Подключение AIRI</div>
          <div className="mt-1 text-[11px] text-text-muted">Ключ действует только на /v1/* и не даёт доступ к /admin/*.</div>
        </div>

        <label className="block">
          <span className="mb-1.5 block text-[11px] text-text-muted">Base URL</span>
          <div className="flex gap-2">
            <input className={`${INPUT} font-mono`} readOnly value={endpoint} />
            <button className={BTN} onClick={() => void copy(endpoint, 'Base URL')}>Копировать</button>
          </div>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-[11px] text-text-muted">API key</span>
          <div className="flex gap-2">
            <input className={`${INPUT} font-mono`} readOnly type={showKey ? 'text' : 'password'} value={config?.api_key || ''} />
            <button className={BTN} onClick={() => setShowKey(v => !v)}>{showKey ? 'Скрыть' : 'Показать'}</button>
            <button className={BTN} onClick={() => void copy(config?.api_key || '', 'API key')}>Копировать</button>
          </div>
        </label>

        <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-300/20 bg-amber-300/[0.06] px-3 py-2">
          <div className="text-[11px] text-amber-200/80">После ротации старый ключ перестанет принимать запросы без перезапуска сервера.</div>
          <button className={BTN} onClick={() => void rotateKey()} disabled={busy}>Новый ключ</button>
        </div>
      </section>

      <section className={`${CARD} p-4 space-y-4`}>
        <div>
          <div className="text-[13px] font-medium text-text-primary">Куда отправлять запросы</div>
          <div className="mt-1 text-[11px] text-text-muted">Для первого теста лучше закрепить конкретный workspace с подключённым Windows MCP.</div>
        </div>

        <label className="block">
          <span className="mb-1.5 block text-[11px] text-text-muted">Workspace</span>
          <select className={INPUT} value={selectedSpace} onChange={e => setSelectedSpace(e.target.value)}>
            <option value="">Автовыбор из пула</option>
            {spaces.map(space => (
              <option key={space.id} value={space.id}>{space.name}{space.email ? ` · ${space.email}` : ''}</option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-[11px] text-text-muted">Модель Notion</span>
          <select className={INPUT} value={selectedModel} onChange={e => setSelectedModel(e.target.value)}>
            {(config?.models || []).map(model => <option key={model} value={model}>{model}</option>)}
          </select>
          <div className="mt-1.5 text-[11px] text-text-muted">В AIRI выбирается стабильный alias <code className="text-text-secondary">{config?.model_alias || 'notion-ai'}</code>; реальная модель меняется здесь.</div>
        </label>

        {config?.routing.warning && <div className="text-[11px] text-amber-300">{config.routing.warning}</div>}
        <div className="flex justify-end">
          <button className={PRIMARY} onClick={() => void save()} disabled={busy || !selectedModel}>Сохранить маршрут</button>
        </div>
      </section>

      <section className={`${CARD} p-4`}>
        <div className="text-[13px] font-medium text-text-primary">Как включить в AIRI</div>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-[12px] text-text-secondary">
          <li>Откройте Settings → Providers и добавьте <b>Notion AI Gateway</b>.</li>
          <li>Вставьте Base URL и API key из этой вкладки.</li>
          <li>В Consciousness выберите провайдер <b>Notion AI Gateway</b> и модель <code>{config?.model_alias || 'notion-ai'}</code>.</li>
          <li>Создайте новый чат AIRI и отправьте безопасное тестовое сообщение. Один чат AIRI продолжает один thread Notion, пока сервер запущен.</li>
        </ol>
        <div className="mt-3 rounded-lg border border-white/[0.07] bg-black/20 px-3 py-2 text-[11px] text-text-muted">
          Это MVP: постоянное восстановление thread после перезапуска и подтверждение опасных команд добавим после проверки базового маршрута.
        </div>
      </section>
    </div>
  )
}