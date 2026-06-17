import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  chatAgents,
  chatDelete,
  chatHistory,
  chatModels,
  chatStream,
  type ChatAgent,
  type ChatModel,
  type ChatStatus,
  type ChatStep,
  type ChatThread,
} from '../api'
import { fetchAutoPayConfig, type ServerAutoPayConfig } from '../autopay'
import type { DiscoveredAccount } from './WorkspacePool'

// The chat grid is height-bounded to the viewport so a long thread list on the
// left can never push the message composer below the fold — instead each pane
// (thread list / message log) scrolls independently. See the min-h-0 children.
const gridStyle: React.CSSProperties = { height: 'calc(100vh - 190px)' }

// How many messages to render initially, and how many more to reveal each time
// the user scrolls to the top of the log. Keeping the rendered set small keeps
// very long threads snappy (lazy loading).
const PAGE_SIZE = 30

interface SpaceOption {
  key: string
  account: DiscoveredAccount
  spaceId: string
  spaceViewId: string
  spaceName: string
  accountLabel: string
}

interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  steps?: ChatStep[]
}

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

// A space counts as "free" (and is hidden from the chat picker) when its plan
// is empty/free/personal AND it is not explicitly subscribed. Such a space is
// still shown if server auto-pay is armed for it.
function isFreeTier(planType: string | undefined): boolean {
  const tier = (planType || '').toLowerCase()
  return tier === '' || tier === 'free' || tier === 'personal'
}

// --- copy helper ---

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy path (e.g. insecure-context LAN access)
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

function CopyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const onCopy = useCallback(async () => {
    const ok = await copyToClipboard(text)
    if (ok) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    }
  }, [text])
  if (!text) return null
  return (
    <button
      type="button"
      onClick={onCopy}
      title="Скопировать сообщение"
      className="mt-1 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-text-muted hover:text-text-secondary hover:bg-bg-secondary transition-colors bg-transparent border-none cursor-pointer"
    >
      {copied ? <span className="text-ok">✓</span> : <CopyIcon />}
      <span>{copied ? 'Скопировано' : 'Копировать'}</span>
    </button>
  )
}

// --- agent steps ---

function StepsBlock({ steps }: { steps: ChatStep[] }) {
  const [open, setOpen] = useState(true)
  if (!steps || steps.length === 0) return null
  return (
    <div className="mb-2 rounded-lg border border-border bg-bg-secondary overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-wide text-text-muted hover:text-text-secondary bg-transparent border-none cursor-pointer"
      >
        <span>Шаги агента · {steps.length}</span>
        <span>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="px-2.5 pb-2 space-y-1.5">
          {steps.map((s, i) => (
            <div key={i} className="text-[12px] leading-snug">
              {s.kind === 'tool' ? (
                <div className="flex items-center gap-1.5 text-notion-blue">
                  <span>🔧</span>
                  <span className="font-medium">{s.tool || s.text}</span>
                </div>
              ) : (
                <div className="flex gap-1.5 text-text-secondary">
                  <span className="shrink-0">💡</span>
                  <span className="whitespace-pre-wrap">{s.text}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// --- markdown rendering (inline + block, incl. tables) ---

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  const regex = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    if (m[1] !== undefined) {
      nodes.push(<strong key={`${keyPrefix}-b${i}`}>{m[1]}</strong>)
    } else if (m[2] !== undefined) {
      nodes.push(<em key={`${keyPrefix}-i${i}`}>{m[2]}</em>)
    } else if (m[3] !== undefined) {
      nodes.push(
        <code key={`${keyPrefix}-c${i}`} className="px-1 py-0.5 rounded bg-bg-secondary text-[0.85em] font-mono">
          {m[3]}
        </code>,
      )
    } else if (m[4] !== undefined) {
      nodes.push(
        <a key={`${keyPrefix}-l${i}`} href={m[5]} target="_blank" rel="noreferrer" className="text-notion-blue underline">
          {m[4]}
        </a>,
      )
    }
    last = regex.lastIndex
    i += 1
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

function splitTableRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim())
}

function isTableSeparator(line: string): boolean {
  const t = line.trim()
  return t.includes('-') && /^\|?[\s:|-]+\|?$/.test(t)
}

function renderBlocks(text: string): React.ReactNode[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: React.ReactNode[] = []
  let i = 0
  let key = 0
  while (i < lines.length) {
    const line = lines[i]

    // fenced code block
    if (line.trim().startsWith('```')) {
      const lang = line.trim().slice(3).trim()
      const buf: string[] = []
      i += 1
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        buf.push(lines[i])
        i += 1
      }
      i += 1 // skip closing fence
      blocks.push(
        <pre key={key++} className="my-2 p-3 rounded-lg bg-bg-secondary overflow-x-auto text-[12.5px] font-mono leading-relaxed">
          {lang ? <div className="mb-1 text-[10px] uppercase tracking-wide text-text-muted">{lang}</div> : null}
          <code>{buf.join('\n')}</code>
        </pre>,
      )
      continue
    }

    // markdown table: a row with pipes followed by a separator row
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitTableRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitTableRow(lines[i]))
        i += 1
      }
      blocks.push(
        <div key={key++} className="my-2 overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                {header.map((c, ci) => (
                  <th key={ci} className="border border-border bg-bg-secondary px-2.5 py-1.5 text-left font-semibold">
                    {renderInline(c, `th${key}-${ci}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {header.map((_, ci) => (
                    <td key={ci} className="border border-border px-2.5 py-1.5 align-top">
                      {renderInline(r[ci] || '', `td${key}-${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }

    // headings
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      const level = h[1].length
      const cls = level <= 1 ? 'text-lg font-semibold' : level === 2 ? 'text-base font-semibold' : 'text-sm font-semibold'
      blocks.push(
        <div key={key++} className={`mt-2 mb-1 ${cls}`}>
          {renderInline(h[2], `h${key}`)}
        </div>,
      )
      i += 1
      continue
    }

    // horizontal rule
    if (/^\s*---+\s*$/.test(line)) {
      blocks.push(<hr key={key++} className="my-2 border-border" />)
      i += 1
      continue
    }

    // unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''))
        i += 1
      }
      blocks.push(
        <ul key={key++} className="my-1.5 ml-4 list-disc space-y-0.5">
          {items.map((it, ii) => (
            <li key={ii}>{renderInline(it, `ul${key}-${ii}`)}</li>
          ))}
        </ul>,
      )
      continue
    }

    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''))
        i += 1
      }
      blocks.push(
        <ol key={key++} className="my-1.5 ml-4 list-decimal space-y-0.5">
          {items.map((it, ii) => (
            <li key={ii}>{renderInline(it, `ol${key}-${ii}`)}</li>
          ))}
        </ol>,
      )
      continue
    }

    // blank line
    if (line.trim() === '') {
      blocks.push(<div key={key++} className="h-2" />)
      i += 1
      continue
    }

    // paragraph
    blocks.push(
      <p key={key++} className="whitespace-pre-wrap">
        {renderInline(line, `p${key}`)}
      </p>,
    )
    i += 1
  }
  return blocks
}

function MessageBody({ text }: { text: string }) {
  return <div className="space-y-0.5">{renderBlocks(text)}</div>
}

// --- main component ---

export function ChatTab({ accounts }: { accounts: DiscoveredAccount[] }) {
  const [autoCfg, setAutoCfg] = useState<ServerAutoPayConfig | null>(null)
  const [spaceKey, setSpaceKey] = useState('')
  const [agents, setAgents] = useState<ChatAgent[]>([])
  const [agentId, setAgentId] = useState('default')
  const [models, setModels] = useState<ChatModel[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [threads, setThreads] = useState<ChatThread[]>([])
  const [activeThreadId, setActiveThreadId] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [status, setStatus] = useState<ChatStatus | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [error, setError] = useState('')
  // Lazy loading: only the last `visibleCount` messages are rendered; scrolling
  // to the top reveals more.
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const logRef = useRef<HTMLDivElement>(null)

  // Load server auto-pay config once — used to keep auto-pay-armed spaces in
  // the picker even when they are still on the free tier.
  useEffect(() => {
    fetchAutoPayConfig().then(setAutoCfg).catch(() => {})
  }, [])

  // Build the visible space list: only paid spaces OR spaces with auto-pay on.
  const spaceOptions = useMemo<SpaceOption[]>(() => {
    const out: SpaceOption[] = []
    for (const acc of accounts) {
      const accountLabel = acc.user_email || acc.user_name || acc.user_id || 'Аккаунт'
      for (const sp of acc.spaces || []) {
        const subscribed = sp.is_subscribed === true
        const autoArmed = !!autoCfg?.spaces?.[sp.space_id]
        if (isFreeTier(sp.plan_type) && !subscribed && !autoArmed) continue
        out.push({
          key: `${acc.user_id || acc.token_v2}:${sp.space_id}`,
          account: acc,
          spaceId: sp.space_id,
          spaceViewId: sp.space_view_id,
          spaceName: sp.name || sp.space_id,
          accountLabel,
        })
      }
    }
    return out
  }, [accounts, autoCfg])

  const activeSpace = useMemo(
    () => spaceOptions.find((s) => s.key === spaceKey) || null,
    [spaceOptions, spaceKey],
  )

  // Keep a valid space selected as the filtered list changes.
  useEffect(() => {
    if (spaceOptions.length === 0) {
      if (spaceKey !== '') setSpaceKey('')
      return
    }
    if (!spaceOptions.some((s) => s.key === spaceKey)) {
      setSpaceKey(spaceOptions[0].key)
    }
  }, [spaceOptions, spaceKey])

  // Load agents + threads whenever the active space changes.
  useEffect(() => {
    if (!activeSpace) {
      setAgents([])
      setThreads([])
      return
    }
    const ref = {
      token_v2: activeSpace.account.token_v2,
      user_id: activeSpace.account.user_id,
      space_id: activeSpace.spaceId,
    }
    let cancelled = false
    chatAgents(ref)
      .then((a) => {
        if (cancelled) return
        setAgents(a)
        setAgentId((prev) => (a.some((x) => x.id === prev) ? prev : 'default'))
      })
      .catch(() => {
        if (!cancelled) setAgents([{ id: 'default', name: 'Обычный агент', kind: 'default' }])
      })
    chatThreads(ref)
      .then((t) => {
        if (!cancelled) setThreads(t)
      })
      .catch(() => {
        if (!cancelled) setThreads([])
      })
    return () => {
      cancelled = true
    }
  }, [activeSpace])

  // Load the model list for the built-in assistant whenever the space changes,
  // defaulting to Opus 4.8 (ambrosia-tart-high) when available.
  useEffect(() => {
    if (!activeSpace) {
      setModels([])
      return
    }
    let cancelled = false
    chatModels({
      token_v2: activeSpace.account.token_v2,
      user_id: activeSpace.account.user_id,
      space_id: activeSpace.spaceId,
    })
      .then((m) => {
        if (cancelled) return
        setModels(m)
        const enabled = m.filter((x) => !x.disabled)
        setSelectedModel((prev) => {
          if (prev && enabled.some((x) => x.id === prev)) return prev
          const opus = enabled.find((x) => x.id === 'ambrosia-tart-high')
          return opus ? opus.id : enabled[0]?.id || ''
        })
      })
      .catch(() => {
        if (!cancelled) setModels([])
      })
    return () => {
      cancelled = true
    }
  }, [activeSpace])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, sending, historyLoading])

  // Only the tail of the conversation is rendered (lazy loading). Older
  // messages are revealed PAGE_SIZE at a time when the user scrolls up.
  const visibleMessages = useMemo(
    () => messages.slice(Math.max(0, messages.length - visibleCount)),
    [messages, visibleCount],
  )
  const hiddenCount = messages.length - visibleMessages.length

  const onLogScroll = useCallback(() => {
    const el = logRef.current
    if (!el || el.scrollTop >= 40) return
    setVisibleCount((c) => {
      if (c >= messages.length) return c
      const prevHeight = el.scrollHeight
      // Preserve the scroll position after the taller list renders so the view
      // doesn't jump when older messages are prepended.
      requestAnimationFrame(() => {
        if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight - prevHeight
      })
      return Math.min(messages.length, c + PAGE_SIZE)
    })
  }, [messages.length])

  const startNewChat = useCallback(() => {
    setActiveThreadId('')
    setMessages([])
    setVisibleCount(PAGE_SIZE)
    setError('')
  }, [])

  // Open an existing thread — load its real history instead of wiping it.
  const openThread = useCallback(
    async (t: ChatThread) => {
      if (!activeSpace) return
      setActiveThreadId(t.id)
      setError('')
      setMessages([])
      setVisibleCount(PAGE_SIZE)
      setHistoryLoading(true)
      try {
        const hist = await chatHistory({
          token_v2: activeSpace.account.token_v2,
          user_id: activeSpace.account.user_id,
          space_id: activeSpace.spaceId,
          thread_id: t.id,
        })
        setMessages(hist.map((m) => ({ role: m.role, text: m.text, steps: m.steps })))
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Не удалось загрузить историю чата')
      } finally {
        setHistoryLoading(false)
      }
    },
    [activeSpace],
  )

  // Delete (archive) a thread from the sidebar. Optimistically removes it from
  // the list; if it was the open thread, reset to a fresh chat.
  const deleteThread = useCallback(
    async (t: ChatThread, e: React.MouseEvent) => {
      e.stopPropagation()
      if (!activeSpace) return
      setThreads((prev) => prev.filter((x) => x.id !== t.id))
      if (t.id === activeThreadId) startNewChat()
      try {
        await chatDelete({
          token_v2: activeSpace.account.token_v2,
          user_id: activeSpace.account.user_id,
          space_id: activeSpace.spaceId,
          thread_id: t.id,
        })
      } catch {
        // Already removed from the UI; ignore backend failures.
      }
    },
    [activeSpace, activeThreadId, startNewChat],
  )

  const handleSend = useCallback(async () => {
    const msg = input.trim()
    if (!msg || !activeSpace || sending) return
    setError('')
    setInput('')
    setMessages((prev) => [...prev, { role: 'user', text: msg }])
    setSending(true)
    setStatus(null)
    try {
      const res = await chatStream(
        {
          token_v2: activeSpace.account.token_v2,
          user_id: activeSpace.account.user_id,
          user_name: activeSpace.account.user_name,
          user_email: activeSpace.account.user_email,
          space_id: activeSpace.spaceId,
          space_view_id: activeSpace.spaceViewId,
          space_name: activeSpace.spaceName,
          timezone: browserTimezone(),
          agent: agentId,
          model: agentId === 'default' ? selectedModel || undefined : undefined,
          thread_id: activeThreadId || undefined,
          message: msg,
        },
        (s) => setStatus(s),
      )
      if (res.thread_id && res.thread_id !== activeThreadId) {
        setActiveThreadId(res.thread_id)
        setThreads((prev) => {
          if (prev.some((t) => t.id === res.thread_id)) return prev
          return [{ id: res.thread_id, title: res.title || msg.slice(0, 40), type: 'workflow' }, ...prev]
        })
      }
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', text: res.text || '(пустой ответ)', steps: res.steps },
      ])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка отправки')
      setMessages((prev) => [...prev, { role: 'assistant', text: '⚠️ Не удалось получить ответ. Попробуйте ещё раз.' }])
    } finally {
      setSending(false)
      setStatus(null)
    }
  }, [input, activeSpace, sending, agentId, selectedModel, activeThreadId])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend],
  )

  if (accounts.length === 0) {
    return (
      <div className="p-8 text-center text-text-secondary">
        Сначала добавьте рабочие пространства на вкладке «Оплата», чтобы начать чат.
      </div>
    )
  }

  const showModelPicker = agentId === 'default' && models.filter((m) => !m.disabled).length > 0

  return (
    <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-4 overflow-hidden" style={gridStyle}>
      {/* Sidebar: space + agent pickers and the thread list */}
      <aside className="flex flex-col gap-3 overflow-hidden">
        <div className="space-y-1">
          <label className="text-[11px] uppercase tracking-wide text-text-muted">Пространство</label>
          <select
            value={spaceKey}
            onChange={(e) => setSpaceKey(e.target.value)}
            className="w-full px-2.5 py-2 rounded-lg bg-bg-input border border-border text-text-primary text-sm"
          >
            {spaceOptions.length === 0 ? (
              <option value="">Нет платных пространств</option>
            ) : (
              spaceOptions.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.spaceName} · {s.accountLabel}
                </option>
              ))
            )}
          </select>
        </div>

        <div className="space-y-1">
          <label className="text-[11px] uppercase tracking-wide text-text-muted">Агент</label>
          <select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            className="w-full px-2.5 py-2 rounded-lg bg-bg-input border border-border text-text-primary text-sm"
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}{a.kind === 'custom' ? ' · кастом' : ''}
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          onClick={startNewChat}
          className="w-full px-3 py-2 rounded-lg bg-notion-blue text-white text-sm font-medium hover:opacity-90 transition-opacity border-none cursor-pointer"
        >
          + Новый чат
        </button>

        <div className="text-[11px] uppercase tracking-wide text-text-muted pt-1">История</div>
        <div className="flex-1 min-h-0 overflow-y-auto space-y-1 pr-1">
          {threads.length === 0 ? (
            <div className="text-xs text-text-muted py-2">Пока нет чатов</div>
          ) : (
            threads.map((t) => (
              <div
                key={t.id}
                className={`group flex items-center rounded-lg transition-colors ${
                  t.id === activeThreadId ? 'bg-bg-card' : 'hover:bg-bg-secondary'
                }`}
              >
                <button
                  type="button"
                  onClick={() => openThread(t)}
                  className={`flex-1 min-w-0 text-left px-2.5 py-2 rounded-lg text-sm truncate bg-transparent border-none cursor-pointer ${
                    t.id === activeThreadId ? 'text-text-primary' : 'text-text-secondary'
                  }`}
                  title={t.title || 'Без названия'}
                >
                  {t.title || 'Без названия'}
                </button>
                <button
                  type="button"
                  onClick={(e) => deleteThread(t, e)}
                  title="Удалить чат"
                  className="shrink-0 mr-1 w-7 h-7 flex items-center justify-center rounded-md text-text-muted hover:text-err hover:bg-bg-secondary bg-transparent border-none cursor-pointer opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                >
                  <TrashIcon />
                </button>
              </div>
            ))
          )}
        </div>
      </aside>

      {/* Conversation pane: scrollable message log + pinned composer */}
      <section className="flex flex-col min-h-0 overflow-hidden rounded-xl border border-border bg-bg-secondary">
        <div ref={logRef} onScroll={onLogScroll} className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 && !historyLoading && !sending ? (
            <div className="h-full flex items-center justify-center text-center text-text-muted text-sm px-6">
              {activeSpace
                ? 'Напишите сообщение, чтобы начать диалог с агентом.'
                : 'Выберите пространство с платным планом или включённой автооплатой.'}
            </div>
          ) : null}

          {hiddenCount > 0 ? (
            <div className="text-center text-[11px] text-text-muted py-1">
              Прокрутите вверх, чтобы загрузить ещё · {hiddenCount}
            </div>
          ) : null}

          {historyLoading ? (
            <div className="flex items-center gap-2 text-text-muted text-sm">
              <span className="inline-block w-3 h-3 rounded-full border-2 border-text-muted border-t-transparent animate-spin" />
              Загружаю историю…
            </div>
          ) : null}

          {visibleMessages.map((msg, idx) => {
            const gi = hiddenCount + idx
            return (
              <div key={gi} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                <div
                  className={`max-w-[85%] px-3.5 py-2.5 rounded-2xl text-[14px] leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-white text-black rounded-br-sm'
                      : 'bg-bg-card border border-border text-text-primary rounded-bl-sm'
                  }`}
                >
                  {msg.role === 'assistant' && msg.steps && msg.steps.length > 0 ? <StepsBlock steps={msg.steps} /> : null}
                  <MessageBody text={msg.text} />
                </div>
                <CopyButton text={msg.text} />
              </div>
            )
          })}

          {sending ? (
            <div className="flex flex-col items-start w-full">
              <div className="max-w-[85%] w-full px-3.5 py-2.5 rounded-2xl rounded-bl-sm bg-bg-card border border-border">
                <div className="flex items-center gap-2 text-text-primary text-[13px] font-medium">
                  <span className="inline-block w-3 h-3 rounded-full border-2 border-text-muted border-t-transparent animate-spin" />
                  {status?.label || 'Агент работает…'}
                </div>
                {status?.detail ? (
                  <div className="mt-1.5 text-[12px] leading-snug text-text-muted whitespace-pre-wrap max-h-40 overflow-y-auto">
                    {status.detail}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          <div ref={messagesEndRef} />
        </div>

        {error ? (
          <div className="px-4 py-2 text-sm text-err border-t border-border bg-bg-secondary">{error}</div>
        ) : null}

        <div className="border-t border-border p-3 bg-bg-secondary">
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder={activeSpace ? 'Сообщение… (Enter — отправить, Shift+Enter — перенос)' : 'Сначала выберите пространство'}
              disabled={!activeSpace || sending}
              className="flex-1 resize-none max-h-32 px-3 py-2 rounded-lg bg-bg-input border border-border text-text-primary text-sm focus:outline-none focus:border-notion-blue disabled:opacity-50"
            />
            {showModelPicker ? (
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                disabled={sending}
                title="Модель агента"
                className="shrink-0 max-w-[150px] px-2 py-2 rounded-lg bg-bg-input border border-border text-text-primary text-[13px] focus:outline-none focus:border-notion-blue disabled:opacity-50 cursor-pointer"
              >
                {models
                  .filter((m) => !m.disabled)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
              </select>
            ) : null}
            <button
              type="button"
              onClick={handleSend}
              disabled={!activeSpace || sending || input.trim() === ''}
              className="px-4 py-2 rounded-lg bg-notion-blue text-white text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-40 border-none cursor-pointer shrink-0"
            >
              Отправить
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
