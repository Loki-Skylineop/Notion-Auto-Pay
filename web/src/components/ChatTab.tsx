import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  chatAgents,
  chatDelete,
  chatHistory,
  chatModels,
  chatStream,
  chatSurvey,
  chatThreads,
  type ChatAgent,
  type ChatModel,
  type ChatStatus,
  type ChatStep,
  type ChatSurvey,
  type ChatSurveyAnswer,
  type ChatThread,
} from '../api'
import { fetchAutoPayConfig, type ServerAutoPayConfig } from '../autopay'
import type { DiscoveredAccount } from './WorkspacePool'
import { ParticleField } from './ParticleField'
import { Dropdown } from './Dropdown'
import { chatSync, type ChatSyncResult } from '../chatSync'
import {
  shellStyle,
  PAGE_SIZE,
  NEW_KEY,
  THREAD_AGENT_KEY,
  loadThreadAgents,
  SIDEBAR_WIDTH_KEY,
  SIDEBAR_MIN,
  SIDEBAR_MAX,
  loadSidebarWidth,
  OUTER_WIDTH_KEY,
  OUTER_MIN,
  OUTER_MAX,
  loadOuterWidth,
  ACTIVE_SPACE_KEY,
  ACTIVE_THREAD_KEY,
  hashMessages,
  readCachedHistory,
  writeCachedHistory,
  browserTimezone,
  isFreeTier,
  TrashIcon,
  MenuIcon,
  PlusIcon,
  RefreshIcon,
  requestStopInference,
  CloseIcon,
  MessageRow,
  StreamingRow,
  Composer,
  SurveyCard,
  type SpaceOption,
  type ChatMessage,
} from './ChatTabParts'

export function ChatTab({ accounts }: { accounts: DiscoveredAccount[] }) {
  const [autoCfg, setAutoCfg] = useState<ServerAutoPayConfig | null>(null)
  const [spaceKey, setSpaceKey] = useState(() => {
    try {
      return localStorage.getItem(ACTIVE_SPACE_KEY) || ''
    } catch {
      return ''
    }
  })
  const [agents, setAgents] = useState<ChatAgent[]>([])
  const [agentId, setAgentId] = useState('default')
  const [models, setModels] = useState<ChatModel[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [threads, setThreads] = useState<ChatThread[]>([])
  const [activeThreadId, setActiveThreadId] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sending, setSending] = useState(false)
  const [status, setStatus] = useState<ChatStatus | null>(null)
  const [liveSteps, setLiveSteps] = useState<ChatStep[]>([])
  const [liveText, setLiveText] = useState('')
  const [streamKey, setStreamKey] = useState<string | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [threadsLoading, setThreadsLoading] = useState(false)
  const [error, setError] = useState('')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  // Desktop splitter: track viewport class + the resizable sidebar width.
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches,
  )
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth)
  const [outerWidth, setOuterWidth] = useState(loadOuterWidth)
  // True when the server reports an in-flight turn for the open thread that
  // this client didn't start (e.g. after a reload, or a turn running on another
  // device) -- drives the "agent is working" indicator on reopen.
  const [remoteBusy, setRemoteBusy] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)
  const instantScrollRef = useRef(false)
  // While the user is lazily loading older messages (scrolling up) or a
  // background poll refreshes the list, suppress the auto-follow so the
  // view is never yanked back to the bottom mid-read.
  const suppressAutoScrollRef = useRef(false)
  const viewKeyRef = useRef(NEW_KEY)
  const threadAgentsRef = useRef<Record<string, string>>(loadThreadAgents())
  const stopRef = useRef(false)
  const streamThreadIdRef = useRef('')
  const turnSeqRef = useRef(0)
  // Poll-loop bookkeeping for the version-gated chatSync mirror of Notion's
  // ~1s record polling. pollTokenRef cancels a stale loop when the user
  // switches threads; pollVersionRef holds the last applied thread version.
  const pollTokenRef = useRef(0)
  const pollVersionRef = useRef(-1)
  // Guards the one-time "restore last open thread on reload" effect.
  const restoredThreadRef = useRef(false)

  useEffect(() => {
    viewKeyRef.current = activeThreadId || NEW_KEY
  }, [activeThreadId])

  const rememberThreadAgent = useCallback((threadId: string, agent: string) => {
    if (!threadId) return
    threadAgentsRef.current = { ...threadAgentsRef.current, [threadId]: agent }
    try {
      localStorage.setItem(THREAD_AGENT_KEY, JSON.stringify(threadAgentsRef.current))
    } catch {
      // ignore quota / privacy-mode failures
    }
  }, [])

  useEffect(() => {
    fetchAutoPayConfig().then(setAutoCfg).catch(() => {})
  }, [])

  // Keep isDesktop in sync so the sidebar width is only applied on PC (on
  // mobile the sidebar is a full-height drawer with a fixed width).
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const onChange = () => setIsDesktop(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // Persist the chosen sidebar width across sessions.
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth))
    } catch {
      // ignore quota / privacy-mode failures
    }
  }, [sidebarWidth])

  // Persist the chosen panel width across sessions.
  useEffect(() => {
    try {
      localStorage.setItem(OUTER_WIDTH_KEY, String(outerWidth))
    } catch {
      // ignore quota / privacy-mode failures
    }
  }, [outerWidth])

  // Remember the active space so a reload restores the same selection.
  useEffect(() => {
    try {
      if (spaceKey) localStorage.setItem(ACTIVE_SPACE_KEY, spaceKey)
    } catch {
      // ignore
    }
  }, [spaceKey])

  // Remember the active thread (cleared when on a new chat) for reload restore.
  useEffect(() => {
    try {
      if (activeThreadId) localStorage.setItem(ACTIVE_THREAD_KEY, activeThreadId)
      else localStorage.removeItem(ACTIVE_THREAD_KEY)
    } catch {
      // ignore
    }
  }, [activeThreadId])

  // Persist the active thread's settled messages so re-opening it is instant.
  // Skipped while a turn is in flight so we never cache a half-streamed state.
  useEffect(() => {
    if (!activeThreadId || sending || remoteBusy) return
    if (messages.length === 0) return
    writeCachedHistory(activeThreadId, messages)
  }, [activeThreadId, messages, sending, remoteBusy])

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

  useEffect(() => {
    if (spaceOptions.length === 0) {
      if (spaceKey !== '') setSpaceKey('')
      return
    }
    if (!spaceOptions.some((s) => s.key === spaceKey)) {
      setSpaceKey(spaceOptions[0].key)
    }
  }, [spaceOptions, spaceKey])

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

  // Keep the log pinned to the bottom. On thread open / new chat we jump
  // instantly to the end; during live updates we only follow if the user is
  // already near the bottom (so scrolling up to read history isn't hijacked).
  useLayoutEffect(() => {
    const el = logRef.current
    if (!el) return
    if (instantScrollRef.current) {
      instantScrollRef.current = false
      suppressAutoScrollRef.current = false
      el.scrollTop = el.scrollHeight
      return
    }
    // A lazy history load or a background poll refresh must not re-pin the
    // log to the bottom while the user is reading older messages.
    if (suppressAutoScrollRef.current) {
      suppressAutoScrollRef.current = false
      return
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [messages, sending, historyLoading, liveSteps, liveText, status])

  const visibleMessages = useMemo(
    () => messages.slice(Math.max(0, messages.length - visibleCount)),
    [messages, visibleCount],
  )
  const hiddenCount = messages.length - visibleMessages.length

  const onLogScroll = useCallback(() => {
    const el = logRef.current
    if (!el || el.scrollTop >= 40) return
    suppressAutoScrollRef.current = true
    setVisibleCount((c) => {
      if (c >= messages.length) return c
      const prevHeight = el.scrollHeight
      requestAnimationFrame(() => {
        if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight - prevHeight
      })
      return Math.min(messages.length, c + PAGE_SIZE)
    })
  }, [messages.length])

  // stopPolling cancels any live poll loop by advancing the token it checks.
  const stopPolling = useCallback(() => {
    pollTokenRef.current += 1
  }, [])

  // Desktop splitter drag: widen/narrow the chat sidebar by dragging the
  // divider between it and the conversation. Listeners live on document so the
  // drag keeps tracking even if the cursor outruns the 4px handle.
  const startSidebarResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = sidebarWidth
      const onMove = (ev: MouseEvent) => {
        const next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startW + (ev.clientX - startX)))
        setSidebarWidth(next)
      }
      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.body.style.userSelect = ''
        document.body.style.cursor = ''
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'
    },
    [sidebarWidth],
  )

  // Desktop: drag the right edge to widen/narrow the whole chat panel. It is
  // centered, so we grow it at twice the cursor delta to keep the dragged edge
  // under the pointer.
  const startOuterResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = outerWidth
      const onMove = (ev: MouseEvent) => {
        const next = Math.min(OUTER_MAX, Math.max(OUTER_MIN, startW + (ev.clientX - startX) * 2))
        setOuterWidth(next)
      }
      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.body.style.userSelect = ''
        document.body.style.cursor = ''
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'
    },
    [outerWidth],
  )

  // startPolling is the faithful port of the Notion web client's continuous
  // syncRecordValuesSpaceInitial polling. While a turn is in-flight -- whether
  // started here or on another device, and even if the stream connection has
  // dropped -- it folds in new/updated messages as soon as the thread version
  // advances, and stops once the server reports the turn is no longer running.
  const startPolling = useCallback((space: SpaceOption, threadId: string) => {
    if (!space || !threadId) return
    const myToken = ++pollTokenRef.current
    pollVersionRef.current = -1
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const loop = async () => {
      // Let the server persist the just-started turn before the first poll.
      await sleep(1500)
      while (pollTokenRef.current === myToken) {
        let res: ChatSyncResult | null = null
        try {
          res = await chatSync({
            token_v2: space.account.token_v2,
            user_id: space.account.user_id,
            space_id: space.spaceId,
            thread_id: threadId,
            since_version: pollVersionRef.current,
          })
        } catch {
          await sleep(1500)
          continue
        }
        if (pollTokenRef.current !== myToken) return
        if (!res) {
          await sleep(1500)
          continue
        }
        if (res.changed && res.messages && viewKeyRef.current === threadId) {
          setMessages(res.messages.map((m) => ({ role: m.role, text: m.text, steps: m.steps, survey: m.survey, pages: m.pages })))
        }
        if (res.version >= 0) pollVersionRef.current = res.version
        if (viewKeyRef.current === threadId) setRemoteBusy(!!res.running)
        if (!res.running) return
        await sleep(1500)
      }
    }
    void loop()
  }, [])

  // Reload the thread list for the active space on demand (the small refresh
  // icon next to the «История» header). Best-effort: leaves the current list
  // in place if the request fails.
  const refreshThreads = useCallback(async () => {
    if (!activeSpace || threadsLoading) return
    setThreadsLoading(true)
    try {
      const t = await chatThreads({
        token_v2: activeSpace.account.token_v2,
        user_id: activeSpace.account.user_id,
        space_id: activeSpace.spaceId,
      })
      setThreads(t)
    } catch {
      // ignore — keep the existing list on failure
    } finally {
      setThreadsLoading(false)
    }
  }, [activeSpace, threadsLoading])

  const startNewChat = useCallback(() => {
    stopPolling()
    setRemoteBusy(false)
    instantScrollRef.current = true
    setActiveThreadId('')
    setMessages([])
    setVisibleCount(PAGE_SIZE)
    setError('')
    setSidebarOpen(false)
  }, [stopPolling])

  const openThread = useCallback(
    async (t: ChatThread) => {
      if (!activeSpace) return
      stopPolling()
      setRemoteBusy(false)
      instantScrollRef.current = true
      setActiveThreadId(t.id)
      setSidebarOpen(false)
      // Old chats lock to the agent they were created with: restore the
      // remembered one (falling back to the default agent if unknown) instead
      // of carrying over whatever was selected for a new chat.
      const remembered = threadAgentsRef.current[t.id]
      setAgentId(remembered && agents.some((a) => a.id === remembered) ? remembered : 'default')
      setError('')
      // Cache-first: paint the last-seen history immediately so switching
      // chats is instant, then revalidate against the server in parallel and
      // reconcile only if the content hash actually changed.
      const cached = readCachedHistory(t.id)
      if (cached) {
        setMessages(cached.messages)
        setHistoryLoading(false)
      } else {
        setMessages([])
        setHistoryLoading(true)
      }
      setVisibleCount(PAGE_SIZE)
      try {
        const hist = await chatHistory({
          token_v2: activeSpace.account.token_v2,
          user_id: activeSpace.account.user_id,
          space_id: activeSpace.spaceId,
          thread_id: t.id,
        })
        const mapped: ChatMessage[] = hist.map((m) => ({ role: m.role, text: m.text, steps: m.steps, survey: m.survey, pages: m.pages }))
        if (viewKeyRef.current === t.id && (!cached || cached.hash !== hashMessages(mapped))) {
          setMessages(mapped)
        }
        writeCachedHistory(t.id, mapped)
        // Keep mirroring the server while the thread is open so a turn that is
        // still running (or was started elsewhere) streams in, and the final
        // state lands without a manual reopen. The loop stops itself once the
        // server reports no in-flight turn.
        startPolling(activeSpace, t.id)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Не удалось загрузить историю чата')
      } finally {
        instantScrollRef.current = true
        setHistoryLoading(false)
      }
    },
    [activeSpace, agents, startPolling, stopPolling],
  )

  // On first load, reopen the chat the user was last viewing -- restoring its
  // history and, through polling, whether the agent is still working there.
  useEffect(() => {
    if (restoredThreadRef.current) return
    if (!activeSpace || agents.length === 0 || threads.length === 0) return
    restoredThreadRef.current = true
    if (viewKeyRef.current !== NEW_KEY) return
    let saved = ''
    try {
      saved = localStorage.getItem(ACTIVE_THREAD_KEY) || ''
    } catch {
      saved = ''
    }
    if (!saved) return
    const t = threads.find((x) => x.id === saved)
    if (t) void openThread(t)
  }, [activeSpace, agents, threads, openThread])

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
        // already removed from the UI; ignore backend failures
      }
    },
    [activeSpace, activeThreadId, startNewChat],
  )

  // After a turn ends (or is stopped) pull the thread's latest persisted state
  // from the server so the last message reflects reality without a manual
  // reopen. This is the lightweight stand-in for Notion's ~1s record polling.
  const reconcileFromServer = useCallback(async (space: SpaceOption, threadId: string) => {
    if (!space || !threadId) return
    try {
      const hist = await chatHistory({
        token_v2: space.account.token_v2,
        user_id: space.account.user_id,
        space_id: space.spaceId,
        thread_id: threadId,
      })
      if (viewKeyRef.current !== threadId) return
      if (hist.length > 0 && hist[hist.length - 1].role === 'assistant') {
        setMessages(hist.map((m) => ({ role: m.role, text: m.text, steps: m.steps, survey: m.survey, pages: m.pages })))
      }
    } catch {
      // ignore — reconciliation is best-effort
    }
  }, [])

  const handleStop = useCallback(() => {
    if (!sending) return
    stopPolling()
    setRemoteBusy(false)
    stopRef.current = true
    const partial = liveText.trim()
    const carriedSteps = liveSteps
    setSending(false)
    setStatus(null)
    setStreamKey(null)
    setLiveSteps([])
    setLiveText('')
    setMessages((prev) => [
      ...prev,
      {
        role: 'assistant',
        text: partial ? `${partial}\n\n⏹ Остановлено` : '⏹ Остановлено',
        steps: carriedSteps,
      },
    ])
    const tid = streamThreadIdRef.current
    if (tid && activeSpace) {
      requestStopInference({
        token_v2: activeSpace.account.token_v2,
        user_id: activeSpace.account.user_id,
        space_id: activeSpace.spaceId,
        thread_id: tid,
      }).then(() => reconcileFromServer(activeSpace, tid))
    }
  }, [sending, liveText, liveSteps, activeSpace, reconcileFromServer, stopPolling])

  // Shared live-status reducer for both chatStream (handleSend) and chatSurvey
  // (handleSurveySubmit). The backend tags every event with a kind: "tool" (a
  // connector call, carrying label/server/input/result), "thought" (streamed
  // reasoning) or "text" (the answer itself, carrying the cumulative text as it
  // is written). We fold tool + thought events into liveSteps so the live tree
  // mirrors the finished message, and mirror text into liveText so the reply
  // types out in place.
  const onStatus = useCallback((s: ChatStatus) => {
    setStatus(s)
    if (s.kind === 'text') {
      if (s.detail) setLiveText(s.detail)
      return
    }
    setLiveSteps((prev) => {
      if (s.kind === 'tool') {
        const label = (s.tool || s.detail || '').trim()
        if (!label) return prev
        const next: ChatStep = {
          kind: 'tool',
          text: label,
          tool: label,
          server: s.server || '',
          input: s.input || '',
          result: s.result || '',
        }
        const last = prev[prev.length - 1]
        if (last && last.kind === 'tool' && last.tool === label) {
          return [
            ...prev.slice(0, -1),
            {
              ...last,
              server: next.server || last.server,
              input: next.input || last.input,
              result: next.result || last.result,
            },
          ]
        }
        return [...prev, next]
      }
      if (s.kind === 'thought') {
        const thought = s.detail || ''
        const last = prev[prev.length - 1]
        if (last && last.kind === 'thought') {
          return [...prev.slice(0, -1), { kind: 'thought', text: thought }]
        }
        if (thought.trim() === '') return prev
        return [...prev, { kind: 'thought', text: thought }]
      }
      return prev
    })
  }, [])

  const handleSend = useCallback(
    async (msg: string) => {
      const text = msg.trim()
      if (!text || !activeSpace || sending) return
      const originKey = activeThreadId || NEW_KEY
      const agentUsed = agentId
      const myTurn = ++turnSeqRef.current
      stopRef.current = false
      streamThreadIdRef.current = activeThreadId || ''
      instantScrollRef.current = true
      setError('')
      setMessages((prev) => [...prev, { role: 'user', text }])
      setSending(true)
      // Mirror Notion's live record polling for the duration of the turn so the
      // open chat keeps updating even if the stream stalls. A brand-new thread
      // has no id yet, so polling is (re)started below with res.thread_id.
      if (activeThreadId) startPolling(activeSpace, activeThreadId)
      setStreamKey(originKey)
      setStatus(null)
      setLiveSteps([])
      setLiveText('')

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
            agent: agentUsed,
            model: agentUsed === 'default' ? selectedModel || undefined : undefined,
            thread_id: activeThreadId || undefined,
            message: text,
          },
          onStatus,
        )
        if (res.thread_id) {
          streamThreadIdRef.current = res.thread_id
          rememberThreadAgent(res.thread_id, agentUsed)
          setThreads((prev) =>
            prev.some((t) => t.id === res.thread_id)
              ? prev
              : [{ id: res.thread_id, title: res.title || text.slice(0, 40), type: 'workflow' }, ...prev],
          )
        }
        // Only mutate the visible conversation if the user is still viewing the
        // chat this stream was started from, and the turn wasn't stopped.
        // Otherwise the reply is persisted server-side and shows up on reopen.
        if (viewKeyRef.current === originKey && !stopRef.current) {
          if (res.thread_id && res.thread_id !== activeThreadId) setActiveThreadId(res.thread_id)
          setMessages((prev) => [
            ...prev,
            { role: 'assistant', text: res.text || '(пустой ответ)', steps: res.steps, survey: res.survey, pages: res.pages },
          ])
        }
        // Keep polling the freshly persisted thread state so the message list
        // converges to the server without a manual reopen. The loop applies the
        // final history and then stops once the turn is no longer in-flight.
        if (res.thread_id) startPolling(activeSpace, res.thread_id)
      } catch (e) {
        if (viewKeyRef.current === originKey && !stopRef.current) {
          setError(e instanceof Error ? e.message : 'Ошибка отправки')
          setMessages((prev) => [...prev, { role: 'assistant', text: '⚠️ Не удалось получить ответ. Попробуйте ещё раз.' }])
        }
      } finally {
        // A stop (or a newer turn) may have already reset the live state; only
        // the turn that still owns the stream should clear it.
        if (turnSeqRef.current === myTurn) {
          setSending(false)
          setStatus(null)
          setLiveSteps([])
          setLiveText('')
          setStreamKey(null)
        }
      }
    },
    [activeSpace, sending, activeThreadId, agentId, selectedModel, onStatus, rememberThreadAgent, startPolling],
  )

  // Continue a turn by answering the agent's survey. Mirrors handleSend, but
  // posts the collected answers to chatSurvey instead of a free-text message.
  const handleSurveySubmit = useCallback(
    async (survey: ChatSurvey, answers: ChatSurveyAnswer[]) => {
      if (!activeSpace || sending) return
      const tid = activeThreadId
      if (!tid || !survey || survey.submitted) return
      const originKey = tid
      const agentUsed = agentId
      const myTurn = ++turnSeqRef.current
      stopRef.current = false
      streamThreadIdRef.current = tid
      instantScrollRef.current = true
      setError('')
      // Mark the survey answered and echo the chosen answers as a user turn.
      setMessages((prev) =>
        prev.map((m) =>
          m.survey && m.survey.id === survey.id ? { ...m, survey: { ...m.survey, submitted: true } } : m,
        ),
      )
      setMessages((prev) => [
        ...prev,
        { role: 'user', text: answers.map((a) => `${a.prompt}\n— ${a.label}`).join('\n\n') },
      ])
      setSending(true)
      setStreamKey(originKey)
      setStatus(null)
      setLiveSteps([])
      setLiveText('')
      startPolling(activeSpace, tid)
      try {
        const res = await chatSurvey(
          {
            token_v2: activeSpace.account.token_v2,
            user_id: activeSpace.account.user_id,
            user_name: activeSpace.account.user_name,
            user_email: activeSpace.account.user_email,
            space_id: activeSpace.spaceId,
            space_view_id: activeSpace.spaceViewId,
            space_name: activeSpace.spaceName,
            timezone: browserTimezone(),
            agent: agentUsed,
            model: agentUsed === 'default' ? selectedModel || undefined : undefined,
            thread_id: tid,
            survey_step_id: survey.id,
            questions: survey.questions,
            created_at: survey.createdAt,
            answers,
          },
          onStatus,
        )
        if (res.thread_id) {
          streamThreadIdRef.current = res.thread_id
          rememberThreadAgent(res.thread_id, agentUsed)
        }
        if (viewKeyRef.current === originKey && !stopRef.current) {
          setMessages((prev) => [
            ...prev,
            { role: 'assistant', text: res.text || '(пустой ответ)', steps: res.steps, survey: res.survey, pages: res.pages },
          ])
        }
        if (res.thread_id) startPolling(activeSpace, res.thread_id)
      } catch (e) {
        if (viewKeyRef.current === originKey && !stopRef.current) {
          setError(e instanceof Error ? e.message : 'Ошибка отправки')
          setMessages((prev) => [...prev, { role: 'assistant', text: '⚠️ Не удалось отправить ответы. Попробуйте ещё раз.' }])
        }
      } finally {
        if (turnSeqRef.current === myTurn) {
          setSending(false)
          setStatus(null)
          setLiveSteps([])
          setLiveText('')
          setStreamKey(null)
        }
      }
    },
    [activeSpace, sending, activeThreadId, agentId, selectedModel, onStatus, rememberThreadAgent, startPolling],
  )

  if (accounts.length === 0) {
    return (
      <div className="p-8 text-center text-text-secondary">
        Сначала добавьте рабочие пространства на вкладке «Оплата», чтобы начать чат.
      </div>
    )
  }

  const viewKey = activeThreadId || NEW_KEY
  const showThinking = (sending && streamKey === viewKey) || (remoteBusy && !sending)
  const showModelPicker = agentId === 'default' && models.filter((m) => !m.disabled).length > 0
  const activeThreadTitle = threads.find((t) => t.id === activeThreadId)?.title || 'Новый чат'
  const lastMessage = messages[messages.length - 1]
  const pendingSurvey =
    !showThinking && lastMessage && lastMessage.role === 'assistant' && lastMessage.survey && !lastMessage.survey.submitted
      ? lastMessage.survey
      : null

  return (
    <div className="relative mx-auto" style={isDesktop ? { width: outerWidth, maxWidth: '100%' } : undefined}>
    <div className="relative flex min-h-0 overflow-hidden rounded-xl border border-white/[0.08]" style={shellStyle}>
      {/* Mobile drawer backdrop */}
      {sidebarOpen ? (
        <div
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      ) : null}

      <aside
        style={isDesktop ? { width: sidebarWidth } : undefined}
        className={`fixed inset-y-0 left-0 z-40 w-[280px] max-w-[82vw] flex flex-col p-3 bg-[#030303] border-r border-white/[0.08] overflow-hidden transform transition-transform duration-200 md:static md:z-auto md:max-w-none md:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between mb-3 md:hidden">
          <span className="text-[12px] font-medium text-text-secondary">Чаты</span>
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-text-muted hover:text-text-primary hover:bg-white/[0.05] bg-transparent border-none cursor-pointer"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="space-y-3 mb-3">
          <div>
            <div className="text-[9px] text-text-muted uppercase tracking-widest mb-1 px-0.5">Пространство</div>
            <Dropdown
              value={spaceKey}
              onChange={setSpaceKey}
              disabled={spaceOptions.length === 0}
              ariaLabel="Пространство"
              placeholder="Нет платных пространств"
              buttonClassName="rounded-md px-2.5 py-1.5 text-[12px]"
              menuClassName="w-full"
              options={spaceOptions.map((s) => ({ value: s.key, label: `${s.spaceName} · ${s.accountLabel}` }))}
            />
          </div>

          <div>
            <div className="text-[9px] text-text-muted uppercase tracking-widest mb-1 px-0.5">Агент</div>
            <Dropdown
              value={agentId}
              onChange={setAgentId}
              disabled={!!activeThreadId}
              ariaLabel="Агент"
              buttonClassName="rounded-md px-2.5 py-1.5 text-[12px]"
              menuClassName="w-full"
              options={agents.map((a) => ({ value: a.id, label: `${a.name}${a.kind === 'custom' ? ' · кастом' : ''}` }))}
            />
            {activeThreadId ? (
              <div className="mt-1 px-0.5 text-[9px] text-text-muted leading-snug">
                Агент зафиксирован для этого чата. Создайте новый чат, чтобы выбрать другого.
              </div>
            ) : null}
          </div>
        </div>

        <button
          type="button"
          onClick={startNewChat}
          className="w-full flex items-center justify-center gap-1.5 py-2 mb-4 rounded-lg border border-white/[0.07] text-[11px] text-[#888] hover:bg-white/[0.04] hover:text-text-secondary hover:border-white/[0.12] transition-colors bg-transparent cursor-pointer"
        >
          <PlusIcon /> Новый чат
        </button>

        <div className="flex items-center justify-between mb-2 px-0.5">
          <span className="text-[9px] text-text-muted uppercase tracking-widest">История</span>
          <button
            type="button"
            onClick={refreshThreads}
            disabled={!activeSpace || threadsLoading}
            title="Обновить список чатов"
            className={`w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-text-secondary hover:bg-white/[0.05] bg-transparent border-none cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed transition-colors ${threadsLoading ? 'animate-spin' : ''}`}
          >
            <RefreshIcon />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto space-y-px pr-1">
          {threads.length === 0 ? (
            <div className="text-[11px] text-text-muted py-2 px-0.5">Пока нет чатов</div>
          ) : (
            threads.map((t) => (
              <div
                key={t.id}
                onClick={() => openThread(t)}
                className={`group flex items-center justify-between px-2.5 py-2 rounded-md cursor-pointer transition-colors ${
                  t.id === activeThreadId ? 'bg-white/[0.07] text-[#e8e8e8]' : 'text-[#666] hover:bg-white/[0.03] hover:text-[#999]'
                }`}
              >
                <span className="text-[11px] truncate" title={t.title || 'Без названия'}>
                  {t.title || 'Без названия'}
                </span>
                <button
                  type="button"
                  onClick={(e) => deleteThread(t, e)}
                  title="Удалить чат"
                  className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-0.5 ml-1 text-[#444] hover:text-red-400 transition-all shrink-0 bg-transparent border-none cursor-pointer"
                >
                  <TrashIcon />
                </button>
              </div>
            ))
          )}
        </div>
      </aside>

      {/* Desktop-only splitter: drag to resize the sidebar / chat columns. */}
      <div
        onMouseDown={startSidebarResize}
        title="Потяните, чтобы изменить ширину"
        className="hidden md:block shrink-0 w-1 cursor-col-resize bg-white/[0.04] hover:bg-white/[0.14] active:bg-notion-blue/50 transition-colors"
      />

      <section className="relative flex-1 min-w-0 flex flex-col min-h-0 overflow-hidden bg-black">
        <ParticleField active={showThinking} />

        {/* Top bar — mobile only: menu + current thread + new chat */}
        <div className="relative z-10 flex items-center gap-2 px-3 py-2 border-b border-white/[0.06] md:hidden">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            title="Чаты"
            className="shrink-0 w-9 h-9 flex items-center justify-center rounded-lg text-text-secondary hover:text-text-primary hover:bg-white/[0.05] bg-transparent border-none cursor-pointer"
          >
            <MenuIcon />
          </button>
          <div className="flex-1 min-w-0 truncate text-[12px] font-medium text-text-secondary">{activeThreadTitle}</div>
          <button
            type="button"
            onClick={startNewChat}
            title="Новый чат"
            className="shrink-0 w-9 h-9 flex items-center justify-center rounded-lg text-text-secondary hover:text-text-primary hover:bg-white/[0.05] bg-transparent border-none cursor-pointer"
          >
            <PlusIcon />
          </button>
        </div>

        <div ref={logRef} onScroll={onLogScroll} className="relative z-10 flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden px-5 md:px-8 py-6 space-y-6">
          {messages.length === 0 && !historyLoading && !showThinking ? (
            <div className="h-full flex items-center justify-center text-center text-[#444] text-[12px] px-6">
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
            <div className="flex items-center gap-2 text-text-muted text-[12px]">
              <span className="inline-block w-3 h-3 rounded-full border-2 border-text-muted border-t-transparent animate-spin" />
              Загружаю историю…
            </div>
          ) : null}

          {visibleMessages.map((msg, idx) => (
            <MessageRow key={hiddenCount + idx} role={msg.role} text={msg.text} steps={msg.steps} pages={msg.pages} />
          ))}

          {showThinking ? <StreamingRow status={status} steps={liveSteps} liveText={liveText} /> : null}
        </div>

        {error ? (
          <div className="relative z-10 px-4 py-2 text-[12px] text-red-400 border-t border-white/[0.06] bg-black/50">{error}</div>
        ) : null}

        {pendingSurvey ? (
          <SurveyCard survey={pendingSurvey} busy={sending} onSubmit={(answers) => handleSurveySubmit(pendingSurvey, answers)} />
        ) : null}

        <Composer
          hasSpace={!!activeSpace}
          sending={sending}
          showModelPicker={showModelPicker}
          models={models}
          selectedModel={selectedModel}
          onModelChange={setSelectedModel}
          onSend={handleSend}
          onStop={handleStop}
          draftKey={viewKey}
        />
      </section>
    </div>
      {/* Desktop-only outer splitter: drag to widen/narrow the whole panel. */}
      {isDesktop ? (
        <div
          onMouseDown={startOuterResize}
          title="Потяните, чтобы изменить ширину панели чата"
          className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize bg-transparent hover:bg-white/[0.10] active:bg-notion-blue/40 transition-colors"
        />
      ) : null}
    </div>
  )
}
