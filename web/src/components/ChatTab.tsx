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

// The chat grid is height-bounded to the viewport so a long thread list on the
// left can never push the message composer below the fold — instead each pane
// (thread list / message log) scrolls independently. See the min-h-0 children.
const gridStyle: React.CSSProperties = { height: 'calc(100vh - 190px)' }

// How many messages to render initially, and how many more to reveal each time
// the user scrolls to the top of the log. Keeping the rendered set small keeps
// very long threads snappy (lazy loading).
const PAGE_SIZE = 30

// Sentinel view-key for the "new chat" view (no thread id yet). Used to keep an
// in-flight stream's status bound to the chat it was started from.
const NEW_KEY = '__new__'

// localStorage key for remembering which agent was last used in each thread, so
// reopening a chat restores the agent it was created with.
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

// GitHub octocat mark — shown for GitHub MCP tool calls so the user can tell at a
// glance which connector the agent is hitting.
function GithubMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.37.5 0 5.78 0 12.29c0 5.2 3.44 9.6 8.21 11.16.6.11.82-.26.82-.58 0-.29-.01-1.04-.02-2.05-3.34.72-4.04-1.6-4.04-1.6-.55-1.38-1.34-1.75-1.34-1.75-1.09-.74.08-.73.08-.73 1.2.08 1.84 1.23 1.84 1.23 1.07 1.82 2.81 1.3 3.5.99.11-.77.42-1.3.76-1.6-2.67-.3-5.47-1.32-5.47-5.87 0-1.3.47-2.36 1.24-3.19-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.22.96-.26 1.98-.39 3-.4 1.02.01 2.04.14 3 .4 2.28-1.54 3.29-1.22 3.29-1.22.66 1.66.24 2.88.12 3.18.77.83 1.24 1.89 1.24 3.19 0 4.56-2.81 5.57-5.49 5.86.43.36.81 1.09.81 2.2 0 1.59-.01 2.87-.01 3.26 0 .32.22.7.83.58A12.01 12.01 0 0 0 24 12.29C24 5.78 18.63.5 12 .5z" />
    </svg>
  )
}

// Generic MCP / connector icon (a small stack) for non-GitHub MCP servers.
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

// parseTool turns a raw tool identifier (e.g. "connections.mcpServer_github.get_me")
// into a friendly label plus connector hints used to pick the icon.
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
    label = `${nice} · ${mcp[2]}`
  } else {
    const seg = t.split('.')
    label = seg.length >= 2 ? seg.slice(-2).join('.') : t
  }
  if (!server && lower.includes('github')) server = 'github'
  const isMcp = !!mcp || /mcp/i.test(lower)
  return { label, server, isMcp }
}

function ToolIcon({ tool }: { tool?: string }) {
  const info = parseTool(tool)
  if (info.server === 'github') return <GithubMark />
  if (info.isMcp) return <McpIcon />
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
      className="mt-1 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-text-muted hover:text-text-secondary hover:bg-bg-secondary transition-colors bg-transparent border-none cursor-pointer"
    >
      {copied ? <span className="text-ok">✓</span> : <CopyIcon />}
      <span>{copied ? 'Скопировано' : 'Копировать'}</span>
    </button>
  )
}

// --- agent steps (tree view) ---

function StepRow({ step }: { step: ChatStep }) {
  if (step.kind === 'tool') {
    const info = parseTool(step.tool || step.text)
    return (
      <div className="flex items-center gap-2 py-1">
        <span className="shrink-0 w-4 h-4 flex items-center justify-center text-text-secondary">
          <ToolIcon tool={step.tool || step.text} />
        </span>
        <span className="text-[12.5px] text-text-secondary truncate">{info.label}</span>
      </div>
    )
  }
  return (
    <div className="flex gap-2 py-1">
      <span className="shrink-0 mt-0.5">💡</span>
      <span className="text-[12.5px] text-text-muted whitespace-pre-wrap leading-snug">{step.text}</span>
    </div>
  )
}

// StepsTree renders a vertical "branch" of reasoning + tool steps, mirroring the
// agent thinking tree shown in the Notion AI client.
function StepsTree({ steps }: { steps: ChatStep[] }) {
  if (!steps || steps.length === 0) return null
  return (
    <div className="border-l border-border pl-3 ml-1 space-y-0.5">
      {steps.map((s, i) => (
        <StepRow key={i} step={s} />
      ))}
    </div>
  )
}

// StepsBlock is the collapsible "Шаги агента" panel attached to a finished
// assistant message. Collapsed by default — the user opens it on demand.
function StepsBlock({ steps }: { steps: ChatStep[] }) {
  const [open, setOpen] = useState(false)
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

// A fenced code block with a small copy button in the top-right corner so the
// user can grab e.g. a bash command the agent produced.
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
    <div className="relative my-2">
      <button
        type="button"
        onClick={onCopy}
        title="Скопировать код"
        className="absolute top-1.5 right-1.5 z-10 inline-flex items-center justify-center w-6 h-6 rounded-md text-text-muted hover:text-text-primary bg-bg-card border border-border cursor-pointer opacity-60 hover:opacity-100 transition-opacity"
      >
        {copied ? <span className="text-ok text-[11px]">✓</span> : <CopyIcon />}
      </button>
      <pre className="p-3 pr-9 rounded-lg bg-bg-secondary overflow-x-auto text-[12.5px] font-mono leading-relaxed">
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
      blocks.push(<CodeBlock key={key++} code={buf.join('\n')} lang={lang} />)
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
    const h = /^(#{1,4})\s+(