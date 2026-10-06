import { useCallback, useEffect, useState } from 'react'

type Mode = 'full' | 'no-code' | 'observe'
type Host = { id: string; owner: string; sub: string; tunnel_port: number; url: string; auth_key: string; setup_command: string; mode: Mode; online: boolean; created_at: string }
type Data = { hosts: Host[]; base_domain: string; local_panel: boolean }
const labels: Record<Mode, string> = { full: 'Полный доступ', 'no-code': 'Без выполнения кода', observe: 'Только наблюдение' }
const hints: Record<Mode, string> = {
  full: 'Все инструменты, включая PowerShell и реестр. Агент сможет выполнить на ПК любой код.',
  'no-code': 'Прямые вызовы PowerShell, реестра и неизвестных инструментов блокируются. Управление интерфейсом и файлами остаётся: через них всё ещё можно запускать программы. Это не защита от выполнения кода.',
  observe: 'Только снимки экрана, чтение состояния и ожидание. Остальные вызовы блокируются сервером.',
}
const button = 'min-h-11 px-4 py-2 rounded-lg border border-white/15 text-sm hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-notion-blue disabled:opacity-40 disabled:cursor-not-allowed'
async function request<T>(path: string, method = 'GET', body?: object): Promise<T> {
  const r = await fetch(path, { method, credentials: 'same-origin', headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const d = await r.json(); if (!r.ok) throw new Error(typeof d.error === 'string' ? d.error : `HTTP ${r.status}`); return d
}
function Copy({ value, label = 'Копировать' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false)
  return <button type="button" className={button} onClick={async () => { try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1600) } catch { window.prompt('Скопируйте текст:', value) } }}>{done ? 'Скопировано' : label}</button>
}
export function McpHostsTab({ active, owner }: { active: boolean; owner: string }) {
  const [data, setData] = useState<Data | null>(null)
  const [sub, setSub] = useState('')
  const [mode, setMode] = useState<Mode>('full')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [reveal, setReveal] = useState<Record<string, boolean>>({})
  const load = useCallback(async () => { try { const d = await request<Data>('/admin/mcphost'); setData(d); setError('') } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось загрузить хосты') } }, [])
  useEffect(() => { setData(null); setOpen({}); setReveal({}) }, [owner])
  useEffect(() => { if (!active) return; void load(); const t = setInterval(() => void load(), 15000); return () => clearInterval(t) }, [active, owner, load])
  useEffect(() => { if (!active) { setReveal({}); setOpen({}); setData(null) } }, [active])
  async function mutate(path: string, method: string, body: object) { setBusy(true); setError(''); try { await request(path, method, body); await load(); return true } catch (e) { setError(e instanceof Error ? e.message : 'Ошибка'); return false } finally { setBusy(false) } }
  return <section className="space-y-6 text-sm text-text-primary">
    <header><h2 className="text-xl font-medium">Свой ПК как MCP-сервер</h2><p className="mt-2 text-text-secondary leading-relaxed">Заведите поддомен, запустите одну команду на своём компьютере — и агент в Notion сможет управлять этим компьютером. Свой домен, сертификат и проброс портов не нужны.</p></header>
    {error && <div role="alert" className="p-4 rounded-lg border border-err/40 bg-err/10 text-err">{error}<button className={`${button} ml-3`} onClick={() => void load()}>Повторить</button></div>}
    {data?.local_panel && <div className="p-4 rounded-lg border border-warn/30 bg-warn/10 leading-relaxed">Публичные туннели управляются на VPS. Для создания работающего публичного хоста откройте <a className="text-notion-blue underline" href={'https://' + data.base_domain + '/dashboard/'} target="_blank" rel="noreferrer">панель сервера</a>. Локальная копия проекта содержит ту же вкладку и серверный модуль.</div>}
    <form className="p-5 sm:p-6 rounded-xl border border-white/10 bg-bg-card space-y-4" onSubmit={async e => { e.preventDefault(); if (await mutate('/admin/mcphost', 'POST', { sub, mode })) setSub('') }}>
      <h3 className="text-base font-medium">Новый хост</h3>
      <label className="block"><span className="block text-text-secondary mb-2">Адрес</span><div className="flex flex-wrap items-center gap-2"><input aria-describedby="mcp-sub-hint" required pattern="[a-z0-9][a-z0-9-]{1,28}[a-z0-9]" minLength={3} maxLength={30} value={sub} onChange={e => setSub(e.target.value)} placeholder="my-pc" className="min-h-11 w-44 max-w-full px-3 py-2 rounded-lg bg-bg-primary border border-white/15 focus:outline-notion-blue"/><span className="break-all text-text-secondary">.{data?.base_domain || '…'}</span></div><span id="mcp-sub-hint" className="block mt-2 text-text-secondary">Строчные латинские буквы, цифры и дефис, от 3 до 30 символов.</span></label>
      <fieldset><legend className="text-text-secondary mb-2">Что разрешить агенту</legend><div className="flex flex-wrap gap-2">{(Object.keys(labels) as Mode[]).map(m => <label key={m} className={`${button} flex items-center gap-2 cursor-pointer ${mode === m ? 'bg-white/10 border-white/40' : ''}`}><input type="radio" name="mcp-mode" value={m} checked={mode === m} onChange={() => setMode(m)} />{labels[m]}</label>)}</div><p className="mt-3 text-text-secondary leading-relaxed">{hints[mode]}</p></fieldset>
      <button type="submit" disabled={busy || !data || data.local_panel} className={`${button} bg-white text-black hover:bg-white/90`}>{busy ? 'Сохраняю…' : 'Создать'}</button>
    </form>
    {!data && !error && <p className="text-text-secondary">Загружаю хосты…</p>}
    {data?.hosts.length === 0 && <p className="text-text-secondary">Хостов пока нет. Создайте первый выше.</p>}
    {data?.hosts.map(h => <article key={h.id} className="rounded-xl border border-white/10 bg-bg-card p-5 sm:p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0"><h3 className="text-base font-medium break-all">{h.sub}.{data.base_domain}</h3><p className="mt-2 text-text-secondary"><span className={h.online ? 'text-ok' : 'text-warn'}>{h.online ? 'Туннель поднят' : 'Туннель не поднят'}</span> · {labels[h.mode]} · порт {h.tunnel_port}</p></div><button className={button} onClick={() => setOpen(o => ({ ...o, [h.id]: !o[h.id] }))}>{open[h.id] ? 'Скрыть' : 'Настроить'}</button></div>
      {open[h.id] && <div className="space-y-5 border-t border-white/10 pt-5">
        <div><h4 className="font-medium mb-2">Шаг 1. Запустите это в PowerShell на своём ПК</h4><div className="flex flex-wrap items-start gap-2"><code className="flex-1 min-w-0 p-3 bg-bg-primary rounded-lg break-all whitespace-pre-wrap select-all">{h.setup_command}</code><Copy value={h.setup_command} /></div><p className="mt-2 text-text-secondary leading-relaxed">Скрипт установит uv и windows-mcp в отдельное окружение, сохранит ключи, настроит автозапуск и поднимет SSH-туннель. Ссылка содержит приватный ключ — никому не передавайте. После перевыпуска ключей команду нужно запустить заново.</p></div>
        <div className="space-y-3"><h4 className="font-medium">Шаг 2. Добавьте MCP-сервер в Notion</h4><p className="text-text-secondary">URL сервера</p><div className="flex flex-wrap gap-2 items-center"><code className="flex-1 min-w-0 break-all select-all">{h.url}</code><Copy value={h.url} /></div><p className="text-text-secondary">Токен (Authorization: Bearer)</p><div className="flex flex-wrap gap-2 items-center"><code className="flex-1 min-w-0 break-all select-all">{reveal[h.id] ? h.auth_key : '••••••••••••••••••••••••'}</code><button className={button} onClick={() => setReveal(o => ({ ...o, [h.id]: !o[h.id] }))}>{reveal[h.id] ? 'Скрыть токен' : 'Показать токен'}</button><Copy value={h.auth_key} /></div></div>
        <label className="flex flex-wrap items-center gap-3">Режим доступа<select className="min-h-11 px-3 bg-bg-primary border border-white/15 rounded-lg" value={h.mode} disabled={busy} onChange={e => void mutate('/admin/mcphost/mode', 'POST', { id: h.id, mode: e.target.value })}>{(Object.keys(labels) as Mode[]).map(m => <option key={m} value={m}>{labels[m]}</option>)}</select></label>
        <div className="flex flex-wrap gap-2"><button disabled={busy} className={button} onClick={() => { if (window.confirm('Старый токен и SSH-ключ перестанут работать. Затем потребуется повторить установку на ПК. Продолжить?')) void mutate('/admin/mcphost/rotate', 'POST', { id: h.id }) }}>Перевыпустить ключи</button><button disabled={busy} className={`${button} text-err`} onClick={() => { if (window.confirm(`Удалить ${h.sub}? Подключение и установочная ссылка перестанут работать.`)) void mutate('/admin/mcphost', 'DELETE', { id: h.id }) }}>Удалить</button></div>
      </div>}
    </article>)}
  </section>
}
