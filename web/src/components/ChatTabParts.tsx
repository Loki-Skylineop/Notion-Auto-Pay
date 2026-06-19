import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type ChatModel,
  type ChatPageRef,
  type ChatStatus,
  type ChatStep,
  type ChatSurvey,
  type ChatSurveyAnswer,
  type ChatSurveyQuestion,
} from '../api'
import type { DiscoveredAccount } from './WorkspacePool'
import { Dropdown } from './Dropdown'

export const shellStyle: React.CSSProperties = { height: 'calc(100dvh - 168px)', minHeight: '420px' }

// How many messages to render initially, and how many more to reveal each time
// the user scrolls to the top of the log (lazy loading keeps long threads fast).
export const PAGE_SIZE = 30

// Sentinel view-key for the "new chat" view (no thread id yet).
export const NEW_KEY = '__new__'

// localStorage key for remembering which agent was last used in each thread.
export const THREAD_AGENT_KEY = 'nmp_thread_agent'

export function loadThreadAgents(): Record<string, string> {
  try {
    const raw = localStorage.getItem(THREAD_AGENT_KEY)
    return raw ? (JSON.parse(raw) as Record<string, string>) : {}
  } catch {
    return {}
  }
}

// Desktop-only: the chat sidebar width is user-resizable via the splitter and
// remembered across sessions. Clamped so neither column can collapse.
export const SIDEBAR_WIDTH_KEY = 'nmp_chat_sidebar_w'
export const SIDEBAR_MIN = 180
export const SIDEBAR_MAX = 560
export const SIDEBAR_DEFAULT = 224

export function loadSidebarWidth(): number {
  try {
    const n = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY) || '', 10)
    if (Number.isFinite(n)) return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, n))
  } catch {
    // ignore privacy-mode / parse failures
  }
  return SIDEBAR_DEFAULT
}

// Desktop-only: the whole chat panel (both columns together) can be widened by
// dragging its right edge. Remembered across sessions, clamped, and centered.
export const OUTER_WIDTH_KEY = 'nmp_chat_outer_w'
export const OUTER_MIN = 640
export const OUTER_MAX = 2400
export const OUTER_DEFAULT = 896

export function loadOuterWidth(): number {
  try {
    const n = parseInt(localStorage.getItem(OUTER_WIDTH_KEY) || '', 10)
    if (Number.isFinite(n)) return Math.min(OUTER_MAX, Math.max(OUTER_MIN, n))
  } catch {
    // ignore privacy-mode / parse failures
  }
  return OUTER_DEFAULT
}

// Remember which space + thread the user was last viewing so a reload drops
// them right back where they were.
export const ACTIVE_SPACE_KEY = 'nmp_chat_active_space'
export const ACTIVE_THREAD_KEY = 'nmp_chat_active_thread'

// Per-view composer drafts: whatever the user typed but didn't send is kept
// locally per chat (keyed by thread id, or the "new chat" sentinel) so it
// survives switching chats and reloads. Clearing the box clears the draft.
export const CHAT_DRAFTS_KEY = 'nmp_chat_drafts'

export function loadDrafts(): Record<string, string> {
  try {
    const raw = localStorage.getItem(CHAT_DRAFTS_KEY)
    return raw ? (JSON.parse(raw) as Record<string, string>) : {}
  } catch {
    return {}
  }
}

export function getDraft(key: string): string {
  if (!key) return ''
  return loadDrafts()[key] || ''
}

export function saveDraft(key: string, text: string): void {
  if (!key) return
  try {
    const all = loadDrafts()
    if (text) all[key] = text
    else delete all[key]
    localStorage.setItem(CHAT_DRAFTS_KEY, JSON.stringify(all))
  } catch {
    // ignore quota / privacy-mode failures
  }
}

// Per-thread history cache. The rendered messages of each opened thread are
// stored in localStorage so re-opening a chat paints instantly instead of
// waiting on the network. A cheap content hash lets us skip a needless
// re-render when the freshly-fetched history matches the cache, and reconcile
// only when it actually changed.
export const HISTORY_CACHE_KEY = 'nmp_chat_hist_cache'
export const HISTORY_CACHE_MAX = 40

export interface CachedHistory {
  hash: string
  messages: ChatMessage[]
  at: number
}

export function hashMessages(messages: ChatMessage[]): string {
  let h = 0
  const basis = messages
    .map(
      (m) =>
        `${m.role}|${m.text}|${m.steps?.length || 0}|${m.survey?.id || ''}|${m.survey?.submitted ? 1 : 0}|${(m.pages || []).map((p) => p.url).join(',')}`,
    )
    .join('\u0001')
  for (let i = 0; i < basis.length; i += 1) {
    h = (Math.imul(h, 31) + basis.charCodeAt(i)) | 0
  }
  return `${messages.length}:${(h >>> 0).toString(16)}`
}

export function loadHistoryCache(): Record<string, CachedHistory> {
  try {
    const raw = localStorage.getItem(HISTORY_CACHE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, CachedHistory>) : {}
  } catch {
    return {}
  }
}

export function readCachedHistory(threadId: string): CachedHistory | null {
  if (!threadId) return null
  return loadHistoryCache()[threadId] || null
}

export function writeCachedHistory(threadId: string, messages: ChatMessage[]): string {
  const hash = hashMessages(messages)
  if (!threadId) return hash
  try {
    const all = loadHistoryCache()
    all[threadId] = { hash, messages, at: Date.now() }
    const keys = Object.keys(all)
    if (keys.length > HISTORY_CACHE_MAX) {
      keys
        .sort((a, b) => (all[a].at || 0) - (all[b].at || 0))
        .slice(0, keys.length - HISTORY_CACHE_MAX)
        .forEach((k) => delete all[k])
    }
    localStorage.setItem(HISTORY_CACHE_KEY, JSON.stringify(all))
  } catch {
    // ignore quota / privacy-mode failures
  }
  return hash
}

export interface SpaceOption {
  key: string
  account: DiscoveredAccount
  spaceId: string
  spaceViewId: string
  spaceName: string
  accountLabel: string
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  steps?: ChatStep[]
  survey?: ChatSurvey
  pages?: ChatPageRef[]
}

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export function isFreeTier(planType: string | undefined): boolean {
  const tier = (planType || '').toLowerCase()
  return tier === '' || tier === 'free' || tier === 'personal'
}

// --- copy helper ---

export async function copyToClipboard(text: string): Promise<boolean> {
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

export function CopyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

export function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  )
}

export function MenuIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  )
}

export function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

export function SendIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4 20-7Z" />
    </svg>
  )
}

export function StopIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  )
}

// Ask the proxy to clear the thread's in-flight inference so the server stops
// the agent run (mirrors Notion's StopInference saveTransactionsFanout).
export async function requestStopInference(ref: {
  token_v2: string
  user_id?: string
  space_id: string
  thread_id: string
}): Promise<void> {
  try {
    await fetch('/admin/chat/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(ref),
    })
  } catch {
    // best-effort: the UI is already unblocked locally
  }
}

// Minimalist refresh glyph shown next to the chat history header to reload
// the thread list on demand.
export function RefreshIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <polyline points="21 3 21 9 15 9" />
    </svg>
  )
}

export function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

// GitHub octocat mark — shown for GitHub MCP tool calls.
export function GithubMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.37.5 0 5.78 0 12.29c0 5.2 3.44 9.6 8.21 11.16.6.11.82-.26.82-.58 0-.29-.01-1.04-.02-2.05-3.34.72-4.04-1.6-4.04-1.6-.55-1.38-1.34-1.75-1.34-1.75-1.09-.74.08-.73.08-.73 1.2.08 1.84 1.23 1.84 1.23 1.07 1.82 2.81 1.3 3.5.99.11-.77.42-1.3.76-1.6-2.67-.3-5.47-1.32-5.47-5.87 0-1.3.47-2.36 1.24-3.19-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.22.96-.26 1.98-.39 3-.4 1.02.01 2.04.14 3 .4 2.28-1.54 3.29-1.22 3.29-1.22.66 1.66.24 2.88.12 3.18.77.83 1.24 1.89 1.24 3.19 0 4.56-2.81 5.57-5.49 5.86.43.36.81 1.09.81 2.2 0 1.59-.01 2.87-.01 3.26 0 .32.22.7.83.58A12.01 12.01 0 0 0 24 12.29C24 5.78 18.63.5 12 .5z" />
    </svg>
  )
}

export function McpIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="6" rx="1.5" />
      <rect x="3" y="14" width="18" height="6" rx="1.5" />
    </svg>
  )
}

export function ToolWrench() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.2-.6-.6-2.2 2.3-2.3z" />
    </svg>
  )
}

// parseTool turns a raw tool id (e.g. "connections.mcpServer_github.get_me")
// into a friendly label plus connector hints used to pick the icon. The Go
// backend now sends a ready-made label + server, but this stays as a fallback
// for older payloads and for the live status events.
export function parseTool(tool?: string): { label: string; server?: string; isMcp: boolean } {
  const raw = (tool || '').trim()
  if (!raw) return { label: 'Инструмент', isMcp: false }
  const t = raw
    .replace(/^adminUserConnections\./, '')
    .replace(/^userConnections\./, '')
    .replace(/^connections\./, '')
  const lower = t.toLowerCase()
  const mcp = /mcpServer[_.]([a-zA-Z0-9]+)\.(.+)$/.exec(t)
  let server: string | undefined
  let label: string
  if (mcp) {
    server = mcp[1].toLowerCase()
    const nice = server.charAt(0).toUpperCase() + server.slice(1)
    label = `${nice} / ${mcp[2]}`
  } else {
    const seg = t.split('.')
    label = seg.length >= 2 ? seg.slice(-2).join('.') : t
  }
  if (!server && lower.includes('github')) server = 'github'
  const isMcp = !!mcp || /mcp/i.test(lower)
  return { label, server, isMcp }
}

// ToolIcon picks the connector glyph. It prefers the explicit server hint from
// the backend (e.g. "github"), falling back to parsing the raw tool id.
export function ToolIcon({ tool, server }: { tool?: string; server?: string }) {
  const srv = (server || parseTool(tool).server || '').toLowerCase()
  if (srv === 'github') return <GithubMark />
  if (srv) return <McpIcon />
  return <ToolWrench />
}

export function CopyButton({ text }: { text: string }) {
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
      className="mt-2 inline-flex items-center gap-1.5 rounded-md text-[11px] text-[#454545] hover:text-[#888] transition-colors bg-transparent border-none cursor-pointer p-0"
    >
      {copied ? <span className="text-emerald-400">✓</span> : <CopyIcon />}
      <span>{copied ? 'Скопировано' : 'Копировать'}</span>
    </button>
  )
}

// --- agent steps (tree view) ---

// DetailBox renders the pretty-printed Input or Response payload of a tool call
// inside an expanded step row.
export function DetailBox({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-md border border-white/[0.07] bg-white/[0.02] overflow-hidden">
      <div className="px-2 py-1 border-b border-white/[0.06] text-[10px] uppercase tracking-wide text-text-muted">{title}</div>
      <pre className="px-2 py-1.5 text-[11.5px] font-mono leading-relaxed text-[#8a8a8a] whitespace-pre-wrap wrap-anywhere max-h-72 overflow-y-auto">{text}</pre>
    </div>
  )
}

// StepRow renders a single agent step. Tool steps show a connector icon + label
// (e.g. "GitHub / get_me") and, when input/result are present, expand on click
// to reveal the request and response. Thought steps collapse to a one-line
// preview and expand to the full reasoning text.
export function StepRow({ step }: { step: ChatStep }) {
  const [open, setOpen] = useState(false)

  if (step.kind === 'tool') {
    const label = (step.tool || step.text || 'Инструмент').trim()
    const hasDetail = !!(step.input || step.result)
    return (
      <div className="py-0.5 min-w-0">
        <button
          type="button"
          onClick={() => hasDetail && setOpen((v) => !v)}
          className={`w-full min-w-0 flex items-center gap-1.5 text-left bg-transparent border-none p-0 ${hasDetail ? 'cursor-pointer' : 'cursor-default'}`}
        >
          <span className="shrink-0 w-3 text-[10px] text-text-muted">{hasDetail ? (open ? '▾' : '▸') : ''}</span>
          <span className="shrink-0 w-4 h-4 flex items-center justify-center text-[#888]">
            <ToolIcon tool={step.tool || step.text} server={step.server} />
          </span>
          <span className="text-[12.5px] text-[#888] truncate">{label}</span>
        </button>
        {open && hasDetail ? (
          <div className="ml-[34px] mt-1 mb-1 space-y-1.5 min-w-0">
            {step.input ? <DetailBox title="Input" text={step.input} /> : null}
            {step.result ? <DetailBox title="Response" text={step.result} /> : null}
          </div>
        ) : null}
      </div>
    )
  }

  const thought = step.text || ''
  const oneLine = thought.replace(/\s+/g, ' ').trim()
  const preview = oneLine.length > 90 ? `${oneLine.slice(0, 90)}…` : oneLine
  return (
    <div className="py-0.5 min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full min-w-0 flex items-center gap-1.5 text-left bg-transparent border-none p-0 cursor-pointer"
      >
        <span className="shrink-0 w-3 text-[10px] text-text-muted">{open ? '▾' : '▸'}</span>
        <span className="shrink-0 w-4 h-4 flex items-center justify-center">💡</span>
        <span className="text-[12.5px] text-text-muted truncate italic">{open ? 'Размышление' : preview || 'Размышление'}</span>
      </button>
      {open ? (
        <div className="ml-[34px] mt-1 mb-1 text-[12px] text-text-muted whitespace-pre-wrap wrap-anywhere leading-snug">{thought}</div>
      ) : null}
    </div>
  )
}

// Tool steps that are framework-internal housekeeping (the agent reading its
// own files or loading Notion records to orient itself). Real Notion hides
// these from the visible step list, so we do too — leaving only meaningful
// actions like connector calls and web searches.
export function isInternalTool(step: ChatStep): boolean {
  if (step.kind !== 'tool') return false
  const t = (step.tool || step.text || '').toLowerCase().replace(/\s+/g, '')
  if (!t) return false
  if (t.startsWith('fs.') || t.includes('connections.fs.') || t.includes('.fs.read')) return true
  return /(listuserconnections|loadagent|loaduser|loadpage|loaddatabase|loaddatasource|readfiles|readdir|readfile)/.test(t)
}

// visibleSteps drops housekeeping tool calls so the rendered list reads like
// Notion's: one meaningful action per line.
export function visibleSteps(steps: ChatStep[]): ChatStep[] {
  return (steps || []).filter((s) => !isInternalTool(s))
}

export function stepCountWord(n: number): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return 'шаг'
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return 'шага'
  return 'шагов'
}

export function StepsTree({ steps }: { steps: ChatStep[] }) {
  const shown = visibleSteps(steps)
  if (shown.length === 0) return null
  return (
    <div className="border-l border-white/[0.08] pl-3 ml-1 space-y-0.5 min-w-0">
      {shown.map((s, i) => (
        <StepRow key={i} step={s} />
      ))}
    </div>
  )
}

// Agent steps as a clean vertical list — one action per line, shown between the
// user's turn and the answer, mirroring how Notion renders its steps. Expanded
// by default; the small header folds long lists away. (Replaces the old
// collapsed-by-default "Шаги агента · N" blob.)
export function StepsBlock({ steps }: { steps: ChatStep[] }) {
  const shown = visibleSteps(steps)
  const [open, setOpen] = useState(true)
  if (shown.length === 0) return null
  return (
    <div className="mb-2.5 min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 mb-1 text-[11px] font-medium text-text-muted hover:text-text-secondary bg-transparent border-none cursor-pointer p-0"
      >
        <span className="inline-block w-3 text-[10px]">{open ? '▾' : '▸'}</span>
        <span>{shown.length} {stepCountWord(shown.length)}</span>
      </button>
      {open ? <StepsTree steps={shown} /> : null}
    </div>
  )
}

// --- markdown rendering (inline + block, incl. tables) ---

export function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  const regex = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    if (m[1] !== undefined) {
      nodes.push(<strong key={`${keyPrefix}-b${i}`} className="text-[#e8e8e8] font-medium">{m[1]}</strong>)
    } else if (m[2] !== undefined) {
      nodes.push(<em key={`${keyPrefix}-i${i}`}>{m[2]}</em>)
    } else if (m[3] !== undefined) {
      nodes.push(
        <code key={`${keyPrefix}-c${i}`} className="px-1 py-0.5 rounded bg-white/[0.06] text-[#aaa] text-[0.85em] font-mono wrap-anywhere">
          {m[3]}
        </code>,
      )
    } else if (m[4] !== undefined) {
      nodes.push(
        <a key={`${keyPrefix}-l${i}`} href={m[5]} target="_blank" rel="noreferrer" className="text-notion-blue underline wrap-anywhere">
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

export function splitTableRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim())
}

export function isTableSeparator(line: string): boolean {
  const t = line.trim()
  return t.includes('-') && /^\|?[\s:|-]+\|?$/.test(t)
}

// Fenced code block with a copy button in the top-right corner.
export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false)
  const onCopy = useCallback(async () => {
    const ok = await copyToClipboard(code)
    if (ok) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    }
  }, [code])
  return (
    <div className="relative my-2 min-w-0">
      <button
        type="button"
        onClick={onCopy}
        title="Скопировать код"
        className="absolute top-1.5 right-1.5 z-10 inline-flex items-center justify-center w-6 h-6 rounded-md text-text-muted hover:text-text-primary bg-black border border-white/[0.08] cursor-pointer opacity-60 hover:opacity-100 transition-opacity"
      >
        {copied ? <span className="text-ok text-[11px]">✓</span> : <CopyIcon />}
      </button>
      <pre className="p-3 pr-9 rounded-lg bg-white/[0.03] border border-white/[0.06] overflow-x-auto max-w-full text-[12.5px] font-mono leading-relaxed text-[#cfcfcf]">
        {lang ? <div className="mb-1 text-[10px] uppercase tracking-wide text-text-muted">{lang}</div> : null}
        <code>{code}</code>
      </pre>
    </div>
  )
}

export function renderBlocks(text: string): React.ReactNode[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: React.ReactNode[] = []
  let i = 0
  let key = 0
  while (i < lines.length) {
    const line = lines[i]

    if (line.trim().startsWith('```')) {
      const lang = line.trim().slice(3).trim()
      const buf: string[] = []
      i += 1
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        buf.push(lines[i])
        i += 1
      }
      i += 1
      blocks.push(<CodeBlock key={key++} code={buf.join('\n')} lang={lang} />)
      continue
    }

    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitTableRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitTableRow(lines[i]))
        i += 1
      }
      blocks.push(
        <div key={key++} className="my-2 overflow-x-auto max-w-full">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                {header.map((c, ci) => (
                  <th key={ci} className="border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-left font-semibold text-[#cfcfcf]">
                    {renderInline(c, `th${key}-${ci}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {header.map((_, ci) => (
                    <td key={ci} className="border border-white/[0.08] px-2.5 py-1.5 align-top">
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

    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      const level = h[1].length
      const cls = level <= 1 ? 'text-lg font-semibold' : level === 2 ? 'text-base font-semibold' : 'text-sm font-semibold'
      blocks.push(
        <div key={key++} className={`mt-2 mb-1 text-[#d4d4d4] ${cls}`}>
          {renderInline(h[2], `h${key}`)}
        </div>,
      )
      i += 1
      continue
    }

    if (/^\s*---+\s*$/.test(line)) {
      blocks.push(<hr key={key++} className="my-2 border-white/[0.08]" />)
      i += 1
      continue
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''))
        i += 1
      }
      blocks.push(
        <ul key={key++} className="my-1.5 ml-4 list-disc space-y-0.5">
          {items.map((it, ii) => (
            <li key={ii} className="wrap-anywhere">{renderInline(it, `ul${key}-${ii}`)}</li>
          ))}
        </ul>,
      )
      continue
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''))
        i += 1
      }
      blocks.push(
        <ol key={key++} className="my-1.5 ml-4 list-decimal space-y-0.5">
          {items.map((it, ii) => (
            <li key={ii} className="wrap-anywhere">{renderInline(it, `ol${key}-${ii}`)}</li>
          ))}
        </ol>,
      )
      continue
    }

    if (line.trim() === '') {
      blocks.push(<div key={key++} className="h-2" />)
      i += 1
      continue
    }

    blocks.push(
      <p key={key++} className="whitespace-pre-wrap wrap-anywhere">
        {renderInline(line, `p${key}`)}
      </p>,
    )
    i += 1
  }
  return blocks
}

// Strip the agent's <edit_reference …>…</edit_reference> open-page markers from
// the prose — the referenced pages are rendered as clickable cards instead.
export function stripEditReferences(text: string): string {
  return text
    .replace(/<edit_reference[^>]*>[\s\S]*?<\/edit_reference>/g, '')
    .replace(/<edit_reference[^>]*\/>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}

export function MessageBody({ text }: { text: string }) {
  return <div className="space-y-0.5 min-w-0">{renderBlocks(stripEditReferences(text))}</div>
}

// A clickable card linking to a page the agent created or shared this turn.
export function PageCards({ pages }: { pages: ChatPageRef[] }) {
  const items = (pages || []).filter((p) => p && p.url)
  if (items.length === 0) return null
  return (
    <div className="mt-2.5 space-y-1.5 min-w-0">
      {items.map((p, i) => (
        <a
          key={i}
          href={p.url}
          target="_blank"
          rel="noreferrer"
          className="group flex items-center gap-2.5 px-3 py-2 rounded-lg border border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.05] hover:border-white/[0.14] transition-colors no-underline min-w-0"
        >
          <span className="shrink-0 w-6 h-6 flex items-center justify-center rounded-md bg-white/[0.05] border border-white/[0.08] text-[13px]">📄</span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-[#d4d4d4]">{p.name || 'Страница Notion'}</span>
          <span className="shrink-0 text-[11px] text-text-muted group-hover:text-text-secondary">Открыть ↗</span>
        </a>
      ))}
    </div>
  )
}

// A single rendered message. Memoised so typing in the composer (which lives in
// its own component) never re-runs the markdown renderer for the whole log.
// Mockup layout: user turns sit in a compact right-aligned bubble, assistant
// turns are full-width with a small ✦ avatar and dimmed body text.
export const MessageRow = memo(function MessageRow({ role, text, steps, pages }: { role: 'user' | 'assistant'; text: string; steps?: ChatStep[]; pages?: ChatPageRef[] }) {
  if (role === 'user') {
    return (
      <div className="flex justify-end min-w-0">
        <div className="max-w-[80%] min-w-0 px-3.5 py-2.5 rounded-2xl rounded-tr-sm bg-[#141414] border border-white/[0.07] text-[#e8e8e8] text-[13.5px] leading-relaxed wrap-anywhere">
          <MessageBody text={text} />
        </div>
      </div>
    )
  }
  return (
    <div className="flex gap-3 min-w-0">
      <div className="shrink-0 mt-0.5 w-5 h-5 rounded-full bg-white/[0.05] border border-white/[0.09] flex items-center justify-center">
        <span className="text-[9px] text-white/60">✦</span>
      </div>
      <div className="min-w-0 flex-1">
        {steps && steps.length > 0 ? <StepsBlock steps={steps} /> : null}
        <div className="text-[13.5px] leading-relaxed text-[#8a8a8a]">
          <MessageBody text={text} />
        </div>
        {pages && pages.length > 0 ? <PageCards pages={pages} /> : null}
        <CopyButton text={text} />
      </div>
    </div>
  )
})

// The live assistant turn while the agent is still working. It makes the
// current state obvious: thinking dots before any text arrives, the agent's
// step tree, then the answer typing out with a blinking caret. When the turn
// finishes this is replaced by a normal (caret-free) MessageRow.
export function StreamingRow({ status, steps, liveText }: { status: ChatStatus | null; steps: ChatStep[]; liveText: string }) {
  const phase = liveText ? 'Печатает…' : status?.label || 'Думаю…'
  return (
    <div className="flex gap-3 min-w-0">
      <div className="shrink-0 mt-0.5 w-5 h-5 rounded-full bg-white/[0.05] border border-white/[0.09] flex items-center justify-center">
        <span className="inline-block w-2.5 h-2.5 rounded-full border-2 border-notion-blue border-t-transparent animate-spin" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 text-[12px] font-medium text-[#666]">{phase}</div>
        {steps.length > 0 ? <div className="mb-2"><StepsTree steps={steps} /></div> : null}
        {liveText ? (
          <div className="text-[13.5px] leading-relaxed text-[#8a8a8a]">
            <MessageBody text={liveText} />
            <span className="stream-caret" />
          </div>
        ) : (
          <div className="flex items-center gap-1.5 py-1">
            <span className="w-1.5 h-1.5 rounded-full bg-[#444] animate-bounce" style={dotDelay0} />
            <span className="w-1.5 h-1.5 rounded-full bg-[#444] animate-bounce" style={dotDelay1} />
            <span className="w-1.5 h-1.5 rounded-full bg-[#444] animate-bounce" style={dotDelay2} />
          </div>
        )}
      </div>
    </div>
  )
}

export const dotDelay0: React.CSSProperties = { animationDelay: '0ms' }
export const dotDelay1: React.CSSProperties = { animationDelay: '160ms' }
export const dotDelay2: React.CSSProperties = { animationDelay: '320ms' }

// The message composer owns its own input state so keystrokes don't re-render
// the (potentially long) message log — this fixes typing lag on big threads.
// The textarea auto-grows with the message (up to a cap) like the mockup.
export const Composer = memo(function Composer({
  hasSpace,
  sending,
  showModelPicker,
  models,
  selectedModel,
  onModelChange,
  onSend,
  onStop,
  draftKey,
}: {
  hasSpace: boolean
  sending: boolean
  showModelPicker: boolean
  models: ChatModel[]
  selectedModel: string
  onModelChange: (id: string) => void
  onSend: (text: string) => void
  onStop: () => void
  draftKey: string
}) {
  const [text, setText] = useState(() => getDraft(draftKey))
  const taRef = useRef<HTMLTextAreaElement>(null)

  const resize = useCallback(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [])

  useEffect(() => {
    resize()
  }, [text, resize])

  // Swap the composer to the active chat's saved draft whenever the chat
  // changes (switching threads, opening a new chat, or reloading the page).
  useEffect(() => {
    setText(getDraft(draftKey))
  }, [draftKey])

  const submit = useCallback(() => {
    const t = text.trim()
    if (!t || !hasSpace || sending) return
    onSend(t)
    setText('')
    saveDraft(draftKey, '')
    requestAnimationFrame(() => {
      const el = taRef.current
      if (el) el.style.height = 'auto'
    })
  }, [text, hasSpace, sending, onSend, draftKey])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        submit()
      }
    },
    [submit],
  )

  return (
    <div className="relative z-10 px-4 md:px-6 pb-4 pt-2">
      <div className="flex items-end gap-2.5 rounded-xl border border-white/[0.09] bg-[#080808] px-3.5 py-2.5 focus-within:border-white/[0.18] transition-colors">
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => {
            const v = e.target.value
            setText(v)
            saveDraft(draftKey, v)
          }}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder={hasSpace ? 'Напишите сообщение…' : 'Сначала выберите пространство'}
          disabled={!hasSpace}
          className="flex-1 min-w-0 resize-none max-h-[220px] overflow-y-auto bg-transparent border-none outline-none text-[#e8e8e8] text-[13.5px] placeholder-[#333] leading-relaxed py-0.5 disabled:opacity-50"
        />
        {showModelPicker ? (
          <Dropdown
            value={selectedModel}
            onChange={onModelChange}
            title="Модель агента"
            ariaLabel="Модель агента"
            openUp
            align="right"
            className="shrink-0 max-w-[120px] sm:max-w-[150px]"
            buttonClassName="rounded-lg px-2 py-1.5 text-[12px]"
            menuClassName="min-w-full w-max max-w-[240px]"
            options={models.filter((m) => !m.disabled).map((m) => ({ value: m.id, label: m.label }))}
          />
        ) : null}
        {sending ? (
          <button
            type="button"
            onClick={onStop}
            title="Остановить"
            className="shrink-0 w-7 h-7 flex items-center justify-center rounded-full bg-white/[0.1] text-white hover:bg-white/[0.18] transition-colors border border-white/[0.14] cursor-pointer"
          >
            <StopIcon />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!hasSpace || text.trim() === ''}
            title="Отправить"
            className="shrink-0 w-7 h-7 flex items-center justify-center rounded-full bg-white text-black hover:bg-[#f0f0f0] transition-colors disabled:opacity-25 disabled:cursor-not-allowed border-none cursor-pointer"
          >
            <SendIcon />
          </button>
        )}
      </div>
      <p className="text-center text-[10px] text-[#3a3a3a] mt-1.5">Enter — отправить · Shift+Enter — новая строка</p>
    </div>
  )
})

// --- agent survey (todo-list style follow-up questions) ---

// SurveyCard renders an agent survey near the composer: one question at a time
// («1 / 3»), each with its option buttons plus a «свой вариант» free-text box.
// Answering the final question calls onSubmit with every collected answer,
// which continues the same agent turn (see chatSurvey).
export function SurveyCard({
  survey,
  busy,
  onSubmit,
}: {
  survey: ChatSurvey
  busy: boolean
  onSubmit: (answers: ChatSurveyAnswer[]) => void
}) {
  const questions = useMemo(() => survey.questions || [], [survey])
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState<ChatSurveyAnswer[]>([])
  const [other, setOther] = useState('')

  // Restart from the first question whenever a different survey arrives.
  useEffect(() => {
    setStep(0)
    setAnswers([])
    setOther('')
  }, [survey.id])

  const total = questions.length
  const q: ChatSurveyQuestion | undefined = questions[step]
  if (!q || total === 0) return null

  const commit = (label: string, value?: unknown) => {
    const clean = label.trim()
    if (!clean || busy) return
    const ans: ChatSurveyAnswer = { qid: q.id, prompt: q.prompt, label: clean, value }
    const next = [...answers.filter((a) => a.qid !== q.id), ans]
    setAnswers(next)
    setOther('')
    if (step + 1 < total) setStep(step + 1)
    else onSubmit(next)
  }

  return (
    <div className="relative z-10 mx-4 md:mx-6 mb-2 rounded-xl border border-white/[0.10] bg-[#0c0c0c] p-3.5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Уточню пару деталей</span>
        <span className="text-[11px] text-text-muted">{step + 1} / {total}</span>
      </div>
      <div className="text-[13.5px] text-[#e8e8e8] mb-2.5 leading-snug">{q.prompt}</div>
      <div className="space-y-1.5">
        {q.options.map((opt) => (
          <button
            key={opt.id}
            type="button"
            disabled={busy}
            onClick={() => commit(opt.label, opt.pageId ? { pageId: opt.pageId } : undefined)}
            className="w-full text-left px-3 py-2 rounded-lg border border-white/[0.08] bg-white/[0.02] text-[13px] text-[#d4d4d4] hover:bg-white/[0.06] hover:border-white/[0.16] transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {opt.label}
          </button>
        ))}
      </div>
      {q.allowOther ? (
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-white/[0.08] bg-[#080808] px-3 py-2 focus-within:border-white/[0.18] transition-colors">
          <input
            type="text"
            value={other}
            disabled={busy}
            onChange={(e) => setOther(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commit(other)
              }
            }}
            placeholder="свой вариант…"
            className="flex-1 min-w-0 bg-transparent border-none outline-none text-[#e8e8e8] text-[13px] placeholder-[#444]"
          />
          <button
            type="button"
            disabled={busy || other.trim() === ''}
            onClick={() => commit(other)}
            title="Ответить"
            className="shrink-0 w-6 h-6 flex items-center justify-center rounded-full bg-white text-black hover:bg-[#f0f0f0] transition-colors disabled:opacity-25 disabled:cursor-not-allowed border-none cursor-pointer"
          >
            <SendIcon />
          </button>
        </div>
      ) : null}
      {step > 0 ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => setStep(step - 1)}
          className="mt-2 text-[11px] text-text-muted hover:text-text-secondary bg-transparent border-none cursor-pointer p-0"
        >
          ← Назад
        </button>
      ) : null}
    </div>
  )
}

// --- main component ---
