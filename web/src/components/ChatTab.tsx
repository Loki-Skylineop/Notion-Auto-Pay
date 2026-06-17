import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  chatAgents,
  chatSend,
  chatThreads,
  type ChatAgent,
  type ChatThread,
} from '../api'
import type { DiscoveredAccount } from './WorkspacePool'

// A single rendered message in the local conversation view. Past turns of an
// existing thread are not re-fetched (the server keeps the authoritative
// transcript); the UI only shows turns produced in the current session.
interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
}

// Flattened (account, space) pair so the user can pick “which workspace to sit
// in” regardless of which account owns it.
interface SpaceOption {
  key: string
  account: DiscoveredAccount
  spaceId: string
  spaceViewId: string
  spaceName: string
  accountLabel: string
}

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

// Minimal, dependency-free renderer: keeps line breaks and renders **bold**
// and *italic* without pulling in a markdown lib. Everything else is shown as
// plain text (escaped by React automatically).
function renderInline(text: string, keyPrefix: string) {
  const nodes: React.ReactNode[] = []
  const regex = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    if (m[1] !== undefined) nodes.push(<strong key={`${keyPrefix}-b${i}`}>{m[1]}</strong>)
    else if (m[2] !== undefined) nodes.push(<em key={`${keyPrefix}-i${i}`}>{m[2]}</em>)
    else if (m[3] !== undefined) nodes.push(<code key={`${keyPrefix}-c${i}`} className="font-mono bg-bg-secondary px-1 py-0.5 rounded text-[12px]">{m[3]}</code>)
    last = regex.lastIndex
    i += 1
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

function MessageBody({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <>
      {lines.map((line, idx) => (
        <p key={idx} className={line.trim() === '' ? 'h-2' : 'whitespace-pre-wrap break-words'}>
          {line.trim() === '' ? null : renderInline(line, `l${idx}`)}
        </p>
      ))}
    </>
  )
}

export function ChatTab({ accounts }: { accounts: DiscoveredAccount[] }) {
  // Build the flat list of selectable (account, space) options.
  const spaceOptions = useMemo<SpaceOption[]>(() => {
    const out: SpaceOption[] = []
    for (const acc of accounts) {
      const label = acc.user_email || acc.user_name || acc.token_v2.slice(0, 8)
      for (const sp of acc.spaces || []) {
        out.push({
          key: `${acc.token_v2}::${sp.space_id}`,
          account: acc,
          spaceId: sp.space_id,
          spaceViewId: sp.space_view_id,
          spaceName: sp.name,
          accountLabel: label,
        })
      }
    }
    return out
  }, [accounts])

  const [spaceKey, setSpaceKey] = useState<string>('')
  const activeSpace = useMemo(() => spaceOptions.find(s => s.key === spaceKey) || null, [spaceOptions, spaceKey])

  // Default to the first available space once options load.
  useEffect(() => {
    if (!spaceKey && spaceOptions.length > 0) setSpaceKey(spaceOptions[0].key)
  }, [spaceOptions, spaceKey])

  const [agents, setAgents] = useState<ChatAgent[]>([])
  const [agentId, setAgentId] = useState<string>('default')
  const [agentsLoading, setAgentsLoading] = useState(false)

  const [threads, setThreads] = useState<ChatThread[]>([])
  const [threadsLoading, setThreadsLoading] = useState(false)

  const [activeThreadId, setActiveThreadId] = useState<string>('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, sending])

  // Load agents + threads whenever the active space changes.
  const refreshSpaceData = useCallback((space: SpaceOption | null) => {
    if (!space) {
      setAgents([])
      setThreads([])
      return
    }
    const ref = { token_v2: space.account.token_v2, user_id: space.account.user_id, space_id: space.spaceId }
    setAgentsLoading(true)
    chatAgents(ref)
      .then(list => {
        setAgents(list)
        setAgentId(prev => (list.some(a => a.id === prev) ? prev : 'default'))
      })
      .catch(() => setAgents([{ id: 'default', name: 'Обычный агент', kind: 'default' }]))
      .finally(() => setAgentsLoading(false))
    setThreadsLoading(true)
    chatThreads(ref)
      .then(setThreads)
      .catch(() => setThreads([]))
      .finally(() => setThreadsLoading(false))
  }, [])

  useEffect(() => {
    refreshSpaceData(activeSpace)
    // Switching workspace resets the current conversation.
    setActiveThreadId('')
    setMessages([])
    setError('')
  }, [activeSpace, refreshSpaceData])

  const startNewChat = useCallback(() => {
    setActiveThreadId('')
    setMessages([])
    setError('')
  }, [])

  const openThread = useCallback((t: ChatThread) => {
    // The server holds the full transcript for this thread, so continuing it
    // keeps context even though we start the local view fresh.
    setActiveThreadId(t.id)
    setMessages([])
    setError('')
  }, [])

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || !activeSpace || sending) return
    setError('')
    setInput('')
    setMessages(prev => [...prev, { role: 'user', text }])
    setSending(true)
    try {
      const res = await chatSend({
        token_v2: activeSpace.account.token_v2,
        user_id: activeSpace.account.user_id,
        user_name: activeSpace.account.user_name,
        user_email: activeSpace.account.user_email,
        space_id: activeSpace.spaceId,
        space_view_id: activeSpace.spaceViewId,
        space_name: activeSpace.spaceName,
        timezone: browserTimezone(),
        agent: agentId,
        thread_id: activeThreadId || undefined,
        message: text,
      })
      setMessages(prev => [...prev, { role: 'assistant', text: res.text || '(пустой ответ)' }])
      const wasNew = !activeThreadId
      if (res.thread_id) setActiveThreadId(res.thread_id)
      // Refresh the thread list after the first turn so the new chat shows up.
      if (wasNew) {
        const ref = { token_v2: activeSpace.account.token_v2, user_id: activeSpace.account.user_id, space_id: activeSpace.spaceId }
        chatThreads(ref).then(setThreads).catch(() => {})
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка отправки')
    } finally {
      setSending(false)
    }
  }, [input, activeSpace, sending, agentId, activeThreadId])

  const onComposerKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  if (spaceOptions.length === 0) {
    return (
      <div className="text-center py-16 px-6 bg-bg-secondary border border-border rounded-2xl">
        <div className="text-[16px] font-medium text-text-primary mb-1">Нет доступных пространств</div>
        <p className="text-[13px] text-text-muted max-w-sm mx-auto">
          Добавьте аккаунт на вкладке «Оплата» — и выберите здесь пространство для чата.
        </p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-4" style= height: 'calc(100vh - 220px)', minHeight: '460px' >
      {/* Sidebar: space + agent pickers, thread history */}
      <aside className="flex flex-col gap-3 bg-bg-secondary border border-border rounded-2xl p-3 overflow-hidden">
        <div>
          <label className="block text-[11px] uppercase tracking-wide text-text-muted mb-1">Пространство</label>
          <select
            value={spaceKey}
            onChange={e => setSpaceKey(e.target.value)}
            className="w-full py-2 px-2.5 bg-bg-input border border-border rounded-lg text-[13px] text-text-primary outline-none focus:border-notion-blue"
          >
            {spaceOptions.map(s => (
              <option key={s.key} value={s.key}>{s.spaceName} · {s.accountLabel}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-[11px] uppercase tracking-wide text-text-muted mb-1">Агент</label>
          <select
            value={agentId}
            onChange={e => setAgentId(e.target.value)}
            disabled={agentsLoading}
            className="w-full py-2 px-2.5 bg-bg-input border border-border rounded-lg text-[13px] text-text-primary outline-none focus:border-notion-blue disabled:opacity-50"
          >
            {agents.length === 0 && <option value="default">Обычный агент</option>}
            {agents.map(a => (
              <option key={a.id} value={a.id}>{a.kind === 'custom' ? `🤖 ${a.name}` : a.name}</option>
            ))}
          </select>
        </div>

        <button
          onClick={startNewChat}
          className="h-9 px-3 bg-white hover:bg-white/90 text-black rounded-full text-[13px] font-medium cursor-pointer transition-colors border-none"
        >
          + Новый чат
        </button>

        <div className="flex items-center justify-between mt-1">
          <span className="text-[11px] uppercase tracking-wide text-text-muted">История</span>
          {threadsLoading && <span className="text-[11px] text-text-muted">…</span>}
        </div>
        <div className="flex-1 overflow-y-auto -mx-1 px-1 space-y-1">
          {threads.length === 0 && !threadsLoading && (
            <div className="text-[12px] text-text-muted px-1 py-2">Пока нет чатов</div>
          )}
          {threads.map(t => (
            <button
              key={t.id}
              onClick={() => openThread(t)}
              className={`w-full text-left px-2.5 py-2 rounded-lg text-[13px] truncate transition-colors border ${
                t.id === activeThreadId
                  ? 'bg-notion-blue/15 border-notion-blue/40 text-text-primary'
                  : 'bg-transparent border-transparent hover:bg-bg-card text-text-secondary'
              }`}
              title={t.title || 'Без названия'}
            >
              {t.title || 'Без названия'}
            </button>
          ))}
        </div>
      </aside>

      {/* Conversation */}
      <section className="flex flex-col bg-bg-secondary border border-border rounded-2xl overflow-hidden">
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.length === 0 && (
            <div className="h-full flex items-center justify-center text-center">
              <div className="text-text-muted text-[13px] max-w-sm">
                {activeThreadId
                  ? 'Продолжение выбранного чата — напишите сообщение. Контекст предыдущих сообщений сохранён на сервере.'
                  : 'Начните новый чат: выберите пространство и агента, затем задайте вопрос.'}
              </div>
            </div>
          )}
          {messages.map((msg, idx) => (
            <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[80%] px-3.5 py-2.5 rounded-2xl text-[14px] leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-white text-black rounded-br-sm'
                    : 'bg-bg-card border border-border text-text-primary rounded-bl-sm'
                }`}
              >
                <MessageBody text={msg.text} />
              </div>
            </div>
          ))}
          {sending && (
            <div className="flex justify-start">
              <div className="max-w-[80%] px-3.5 py-2.5 rounded-2xl rounded-bl-sm bg-bg-card border border-border text-text-muted text-[14px]">
                Агент печатает…
              </div>
            </div>
          )}
        </div>

        {error && (
          <div className="px-4 py-2 text-err text-[12px] border-t border-border">{error}</div>
        )}

        <div className="border-t border-border p-3">
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={onComposerKey}
              placeholder="Напишите сообщение… (Enter — отправить, Shift+Enter — новая строка)"
              rows={2}
              disabled={sending}
              className="flex-1 py-2.5 px-3 bg-bg-input border border-border rounded-xl text-[14px] text-text-primary outline-none focus:border-notion-blue focus:ring-2 focus:ring-notion-blue/20 transition-all placeholder:text-text-muted resize-none disabled:opacity-60"
            />
            <button
              onClick={handleSend}
              disabled={sending || !input.trim()}
              className="h-11 px-5 bg-white hover:bg-white/90 text-black rounded-full text-[14px] font-medium cursor-pointer transition-colors border-none disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {sending ? '…' : 'Отправить'}
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
