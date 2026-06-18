import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  chatAgents,
  chatDelete,
  chatHistory,
  chatModels,
  chatStream,
  chatThreads,
  type ChatAgent,
  type ChatModel,
  type ChatStatus,
  type ChatStep,
  type ChatThread,
} from '../api'
import { fetchAutoPayConfig, type ServerAutoPayConfig } from '../autopay'
import type { DiscoveredAccount } from './WorkspacePool'

// The chat shell fills the viewport below the dashboard header. dvh keeps it
// honest on mobile where the browser chrome shrinks the visible area.
const shellStyle: React.CSSProperties = { height: 'calc(100dvh - 168px)', minHeight: '420px' }

// How many messages to render initially, and how many more to reveal each time
// the user scrolls to the top of the log (lazy loading keeps long threads fast).
const PAGE_SIZE = 30

// Sentinel view-key for the "new chat" view (no thread id yet).
const NEW_KEY = '__new__'

// localStorage key for remembering which agent was last used in each thread.
const THREAD_AGENT_KEY = 'nmp_thread_agent'

function loadThreadAgents(): Record<string, string> {
  try {
    const raw = localStorage.getItem(THREAD_AGENT_KEY)
    return raw ? (JSON.parse(raw) as Record<string, string>) : {}
  } catch {
    return {}
  }
}

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

function MenuIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4 20-7Z" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

// GitHub octocat mark — shown for GitHub MCP tool calls.
function GithubMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.37.5 0 5.78 0 12.29c0 5.2 3.44 9.6 8.21 11.16.6.11.82-.26.82-.58 0-.29-.01-1.04-.02-2.05-3.34.72-4.04-1.6-4.04-1.6-.55-1.38-1.34-1.75-1.34-1.75-1.09-.74.08-.73.08-.73 1.2.08 1.84 1.23 1.84 1.23 1.07 1.82 2.81 1.3 3.5.99.11-.77.42-1.3.76-1.6-2.67-.3-5.47-1.32-5.47-5.87 0-1.3.47-2.36 1.24-3.19-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.22.96-.26 1.98-.39 3-.4 1.02.01 2.04.14 3 .4 2.28-1.54 3.29-1.22 3.29-1.22.66 1.66.24 2.88.12 3.18.77.83 1.24 1.89 1.24 3.19 0 4.56-2.81 5.57-5.49 5.86.43.36.81 1.09.81 2.2 0 1.59-.01 2.87-.01 3.26 0 .32.22.7.83.58A12.01 12.01 0 0 0 24 12.29C24 5.78 18.63.5 12 .5z" />
    </svg>
  )
}

function McpIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="6" rx="1.5" />
      <rect x="3" y="14" width="18" height="6" rx="1.5" />
    </svg>
  )
}

function ToolWrench() {
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
function parseTool(tool?: string): { label: string; server?: string; isMcp: boolean } {
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
function ToolIcon({ tool, server }: { tool?: string; server?: string }) {
  const srv = (server || parseTool(tool).server || '').toLowerCase()
  if (srv === 'github') return <GithubMark />
  if (srv) return <McpIcon />
  return <ToolWrench />
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
      className="mt-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-text-muted hover:text-text-secondary hover:bg-bg-secondary transition-colors bg-transparent border-none cursor-pointer"
    >
      {copied ? <span className="text-ok">✓</span> : <CopyIcon />}
      <span>{copied ? 'Скопировано' : 'Копировать'}</span>
    </button>
  )
}

// --- agent steps (tree view) ---

// DetailBox renders the pretty-printed Input or Response payload of a tool call
// inside an expanded step row.
function DetailBox({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-md border border-border bg-bg-secondary overflow-hidden">
      <div className="px-2 py-1 border-b border-border text-[10px] uppercase tracking-wide text-text-muted">{title}</div>
      <pre className="px-2 py-1.5 text-[11.5px] font-mono leading-relaxed text-text-secondary whitespace-pre-wrap wrap-anywhere max-h-72 overflow-y-auto">{text}</pre>
    </div>
  )
}

// StepRow renders a single agent step. Tool steps show a connector icon + label
// (e.g. "GitHub / get_me") and, when input/result are present, expand on click
// to reveal the request and response. Thought steps collapse to a one-line
// preview and expand to the full reasoning text.
function StepRow({ step }: { step: ChatStep }) {
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
          <span className="shrink-0 w-4 h-4 flex items-center justify-center text-text-secondary">
            <ToolIcon tool={step.tool || step.text} server={step.server} />
          </span>
          <span className="text-[12.5px] text-text-secondary truncate">{label}</span>
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

function StepsTree({ steps }: { steps: ChatStep[] }) {
  if (!steps || steps.length === 0) return null
  return (
    <div className="border-l border-border pl-3 ml-1 space-y-0.5 min-w-0">
      {steps.map((s, i) => (
        <StepRow key={i} step={s} />
      ))}
    </div>
  )
}

// Collapsible "Шаги агента" panel — collapsed by default.
function StepsBlock({ steps }: { steps: ChatStep[] }) {
  const [open, setOpen] = useState(false)
  if (!steps || steps.length === 0) return null
  return (
    <div className="mb-2 rounded-lg border border-border bg-bg-secondary overflow-hidden min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-wide text-text-muted hover:text-text-secondary bg-transparent border-none cursor-pointer"
      >
        <span>Шаги агента · {steps.length}</span>
        <span>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="px-2.5 pb-2 pt-1">
          <StepsTree steps={steps} />
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
        <code key={`${keyPrefix}-c${i}`} className="px-1 py-0.5 rounded bg-bg-secondary text-[0.85em] font-mono wrap-anywhere">
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

// Fenced code block with a copy button in the top-right corner.
function CodeBlock({ code, lang }: { code: string; lang?: string }) {
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
        className="absolute top-1.5 right-1.5 z-10 inline-flex items-center justify-center w-6 h-6 rounded-md text-text-muted hover:text-text-primary bg-bg-card border border-border cursor-pointer opacity-60 hover:opacity-100 transition-opacity"
      >
        {copied ? <span className="text-ok text-[11px]">✓</span> : <CopyIcon />}
      </button>
      <pre className="p-3 pr-9 rounded-lg bg-bg-secondary overflow-x-auto max-w-full text-[12.5px] font-mono leading-relaxed">
        {lang ? <div className="mb-1 text-[10px] uppercase tracking-wide text-text-muted">{lang}</div> : null}
        <code>{code}</code>
      </pre>
    </div>
  )
}

function renderBlocks(text: string): React.ReactNode[] {
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

    if (/^\s*---+\s*$/.test(line)) {
      blocks.push(<hr key={key++} className="my-2 border-border" />)
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

function MessageBody({ text }: { text: string }) {
  return <div className="space-y-0.5 min-w-0">{renderBlocks(text)}</div>
}

// A single rendered message. Memoised so typing in the composer (which lives in
// its own component) never re-runs the markdown renderer for the whole log.
// DeepSeek-style layout: user turns sit in a compact right-aligned bubble,
// assistant turns are full-width with an avatar and no heavy bubble so long
// answers, code and tables read comfortably.
const MessageRow = memo(function MessageRow({ role, text, steps }: { role: 'user' | 'assistant'; text: string; steps?: ChatStep[] }) {
  if (role === 'user') {
    return (
      <div className="flex justify-end min-w-0">
        <div className="max-w-[85%] min-w-0 px-3.5 py-2.5 rounded-2xl rounded-br-md bg-bg-card border border-border text-text-primary text-[14.5px] leading-relaxed wrap-anywhere">
          <MessageBody text={text} />
        </div>
      </div>
    )
  }
  return (
    <div className="flex gap-2.5 min-w-0">
      <div className="shrink-0 mt-0.5 w-7 h-7 rounded-full bg-bg-card border border-border flex items-center justify-center text-[13px] text-notion-blue">✦</div>
      <div className="min-w-0 flex-1">
        {steps && steps.length > 0 ? <StepsBlock steps={steps} /> : null}
        <div className="text-[14.5px] leading-relaxed text-text-primary">
          <MessageBody text={text} />
        </div>
        <CopyButton text={text} />
      </div>
    </div>
  )
})

// The live assistant turn while the agent is still working. It makes the
// current state obvious: thinking dots before any text arrives, the agent's
// step tree, then the answer typing out with a blinking caret. When the turn
// finishes this is replaced by a normal (caret-free) MessageRow.
function StreamingRow({ status, steps, liveText }: { status: ChatStatus | null; steps: ChatStep[]; liveText: string }) {
  const phase = liveText ? 'Печатает…' : status?.label || 'Думаю…'
  return (
    <div className="flex gap-2.5 min-w-0">
      <div className="shrink-0 mt-0.5 w-7 h-7 rounded-full bg-bg-card border border-border flex items-center justify-center">
        <span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-notion-blue border-t-transparent animate-spin" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 text-[12px] font-medium text-text-muted">{phase}</div>
        {steps.length > 0 ? <div className="mb-2"><StepsTree steps={steps} /></div> : null}
        {liveText ? (
          <div className="text-[14.5px] leading-relaxed text-text-primary">
            <MessageBody text={liveText} />
            <span className="stream-caret" />
          </div>
        ) : (
          <div className="flex items-center gap-1 text-text-muted">
            <span className="dot-flash" style={dotDelay0} />
            <span className="dot-flash" style={dotDelay1} />
            <span className="dot-flash" style={dotDelay2} />
          </div>
        )}
      </div>
    </div>
  )
}

const dotDelay0: React.CSSProperties = { animationDelay: '0ms' }
const dotDelay1: React.CSSProperties = { animationDelay: '160ms' }
const dotDelay2: React.CSSProperties = { animationDelay: '320ms' }

// The message composer owns its own input state so keystrokes don't re-render
// the (potentially long) message log — this fixes typing lag on big threads.
// The textarea auto-grows with the message (up to a cap) like DeepSeek/ChatGPT.
const Composer = memo(function Composer({
  hasSpace,
  sending,
  showModelPicker,
  models,
  selectedModel,
  onModelChange,
  onSend,
}: {
  hasSpace: boolean
  sending: boolean
  showModelPicker: boolean
  models: ChatModel[]
  selectedModel: string
  onModelChange: (id: string) => void
  onSend: (text: string) => void
}) {
  const [text, setText] = useState('')
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

  const submit = useCallback(() => {
    const t = text.trim()
    if (!t || !hasSpace || sending) return
    onSend(t)
    setText('')
    requestAnimationFrame(() => {
      const el = taRef.current
      if (el) el.style.height = 'auto'
    })
  }, [text, hasSpace, sending, onSend])

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
    <div className="border-t border-border p-3 bg-bg-secondary">
      <div className="flex items-end gap-2 rounded-2xl border border-border bg-bg-input px-2.5 py-2 focus-within:border-notion-blue transition-colors">
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder={hasSpace ? 'Сообщение…' : 'Сначала выберите пространство'}
          disabled={!hasSpace || sending}
          className="flex-1 min-w-0 resize-none max-h-[220px] overflow-y-auto bg-transparent border-none outline-none text-text-primary text-[14.5px] leading-relaxed py-1 disabled:opacity-50"
        />
        {showModelPicker ? (
          <select
            value={selectedModel}
            onChange={(e) => onModelChange(e.target.value)}
            disabled={sending}
            title="Модель агента"
            className="shrink-0 max-w-[120px] sm:max-w-[150px] px-2 py-1.5 rounded-lg bg-bg-secondary border border-border text-text-secondary text-[12.5px] focus:outline-none focus:border-notion-blue disabled:opacity-50 cursor-pointer"
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
          onClick={submit}
          disabled={!hasSpace || sending || text.trim() === ''}
          title="Отправить"
          className="shrink-0 w-9 h-9 flex items-center justify-center rounded-xl bg-notion-blue text-white hover:opacity-90 transition-opacity disabled:opacity-40 border-none cursor-pointer"
        >
          <SendIcon />
        </button>
      </div>
      <div className="mt-1.5 px-1 text-[11px] text-text-muted">Enter — отправить · Shift+Enter — новая строка</div>
    </div>
  )
})

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
  const [sending, setSending] = useState(false)
  const [status, setStatus] = useState<ChatStatus | null>(null)
  const [liveSteps, setLiveSteps] = useState<ChatStep[]>([])
  const [liveText, setLiveText] = useState('')
  const [streamKey, setStreamKey] = useState<string | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [error, setError] = useState('')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)
  const instantScrollRef = useRef(false)
  const viewKeyRef = useRef(NEW_KEY)
  const threadAgentsRef = useRef<Record<string, string>>(loadThreadAgents())

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
      el.scrollTop = el.scrollHeight
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
    setVisibleCount((c) => {
      if (c >= messages.length) return c
      const prevHeight = el.scrollHeight
      requestAnimationFrame(() => {
        if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight - prevHeight
      })
      return Math.min(messages.length, c + PAGE_SIZE)
    })
  }, [messages.length])

  const startNewChat = useCallback(() => {
    instantScrollRef.current = true
    setActiveThreadId('')
    setMessages([])
    setVisibleCount(PAGE_SIZE)
    setError('')
    setSidebarOpen(false)
  }, [])

  const openThread = useCallback(
    async (t: ChatThread) => {
      if (!activeSpace) return
      instantScrollRef.current = true
      setActiveThreadId(t.id)
      setSidebarOpen(false)
      const remembered = threadAgentsRef.current[t.id]
      if (remembered && agents.some((a) => a.id === remembered)) setAgentId(remembered)
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
        instantScrollRef.current = true
        setHistoryLoading(false)
      }
    },
    [activeSpace, agents],
  )

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

  const handleSend = useCallback(
    async (msg: string) => {
      const text = msg.trim()
      if (!text || !activeSpace || sending) return
      const originKey = activeThreadId || NEW_KEY
      const agentUsed = agentId
      instantScrollRef.current = true
      setError('')
      setMessages((prev) => [...prev, { role: 'user', text }])
      setSending(true)
      setStreamKey(originKey)
      setStatus(null)
      setLiveSteps([])
      setLiveText('')

      // Live status reducer. The backend tags every event with a kind:
      // "tool" (a connector call, carrying label/server/input/result),
      // "thought" (streamed reasoning) or "text" (the answer itself, now
      // carrying the cumulative text as it is written). We fold tool + thought
      // events into liveSteps so the live tree mirrors the finished message,
      // and mirror text into liveText so the reply types out in place.
      const onStatus = (s: ChatStatus) => {
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
      }

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
          rememberThreadAgent(res.thread_id, agentUsed)
          setThreads((prev) =>
            prev.some((t) => t.id === res.thread_id)
              ? prev
              : [{ id: res.thread_id, title: res.title || text.slice(0, 40), type: 'workflow' }, ...prev],
          )
        }
        // Only mutate the visible conversation if the user is still viewing the
        // chat this stream was started from. Otherwise the reply is persisted
        // server-side and shows up when they reopen the thread.
        if (viewKeyRef.current === originKey) {
          if (res.thread_id && res.thread_id !== activeThreadId) setActiveThreadId(res.thread_id)
          setMessages((prev) => [
            ...prev,
            { role: 'assistant', text: res.text || '(пустой ответ)', steps: res.steps },
          ])
        }
      } catch (e) {
        if (viewKeyRef.current === originKey) {
          setError(e instanceof Error ? e.message : 'Ошибка отправки')
          setMessages((prev) => [...prev, { role: 'assistant', text: '⚠️ Не удалось получить ответ. Попробуйте ещё раз.' }])
        }
      } finally {
        setSending(false)
        setStatus(null)
        setLiveSteps([])
        setLiveText('')
        setStreamKey(null)
      }
    },
    [activeSpace, sending, activeThreadId, agentId, selectedModel, rememberThreadAgent],
  )

  if (accounts.length === 0) {
    return (
      <div className="p-8 text-center text-text-secondary">
        Сначала добавьте рабочие пространства на вкладке «Оплата», чтобы начать чат.
      </div>
    )
  }

  const viewKey = activeThreadId || NEW_KEY
  const showThinking = sending && streamKey === viewKey
  const showModelPicker = agentId === 'default' && models.filter((m) => !m.disabled).length > 0
  const activeThreadTitle = threads.find((t) => t.id === activeThreadId)?.title || 'Новый чат'

  return (
    <div className="relative flex gap-4 min-h-0 overflow-hidden" style={shellStyle}>
      {/* Mobile drawer backdrop */}
      {sidebarOpen ? (
        <div
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      ) : null}

      <aside
        className={`fixed inset-y-0 left-0 z-40 w-[280px] max-w-[82vw] flex flex-col gap-3 p-4 bg-bg-primary border-r border-border overflow-hidden transform transition-transform duration-200 md:static md:z-auto md:w-[280px] md:max-w-none md:p-0 md:bg-transparent md:border-r-0 md:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between md:hidden">
          <span className="text-sm font-semibold text-text-primary">Чаты</span>
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-secondary bg-transparent border-none cursor-pointer"
          >
            <CloseIcon />
          </button>
        </div>

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
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-notion-blue text-white text-sm font-medium hover:opacity-90 transition-opacity border-none cursor-pointer"
        >
          <PlusIcon /> Новый чат
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

      <section className="flex-1 min-w-0 flex flex-col min-h-0 overflow-hidden rounded-xl border border-border bg-bg-secondary">
        {/* Top bar — mobile only: menu + current thread + new chat */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border md:hidden">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            title="Чаты"
            className="shrink-0 w-9 h-9 flex items-center justify-center rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-card bg-transparent border-none cursor-pointer"
          >
            <MenuIcon />
          </button>
          <div className="flex-1 min-w-0 truncate text-sm font-medium text-text-primary">{activeThreadTitle}</div>
          <button
            type="button"
            onClick={startNewChat}
            title="Новый чат"
            className="shrink-0 w-9 h-9 flex items-center justify-center rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-card bg-transparent border-none cursor-pointer"
          >
            <PlusIcon />
          </button>
        </div>

        <div ref={logRef} onScroll={onLogScroll} className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden p-4 space-y-4">
          {messages.length === 0 && !historyLoading && !showThinking ? (
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

          {visibleMessages.map((msg, idx) => (
            <MessageRow key={hiddenCount + idx} role={msg.role} text={msg.text} steps={msg.steps} />
          ))}

          {showThinking ? <StreamingRow status={status} steps={liveSteps} liveText={liveText} /> : null}
        </div>

        {error ? (
          <div className="px-4 py-2 text-sm text-err border-t border-border bg-bg-secondary">{error}</div>
        ) : null}

        <Composer
          hasSpace={!!activeSpace}
          sending={sending}
          showModelPicker={showModelPicker}
          models={models}
          selectedModel={selectedModel}
          onModelChange={setSelectedModel}
          onSend={handleSend}
        />
      </section>
    </div>
  )
}
