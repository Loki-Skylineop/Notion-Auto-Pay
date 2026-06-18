// chatSync polls a single thread's live state through the server
// (/admin/chat/sync -> proxy.HandleChatSync). It mirrors how the real Notion
// web client continuously polls syncRecordValuesSpaceInitial so an open chat
// keeps updating (new messages, finished turn) even after the streaming
// connection for a turn has ended or dropped. `running` reflects the thread's
// current_inference_id + lease, i.e. whether a turn is still in-flight; the
// poll loop in ChatTab stops once it flips to false.
import type { ChatHistoryMessage } from './api'

export interface ChatSyncResult {
  running: boolean
  version: number
  changed: boolean
  outcome?: string
  messages?: ChatHistoryMessage[]
}

export interface ChatSyncRef {
  token_v2: string
  user_id?: string
  space_id: string
  thread_id: string
  since_version?: number
}

export async function chatSync(ref: ChatSyncRef): Promise<ChatSyncResult> {
  const resp = await fetch('/admin/chat/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(ref),
  })
  const text = await resp.text()
  let data: any = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      /* ignore malformed body */
    }
  }
  if (!resp.ok) {
    const msg = data && typeof data.error === 'string' ? data.error : `HTTP ${resp.status}`
    throw new Error(msg)
  }
  return {
    running: !!(data && data.running),
    version: data && typeof data.version === 'number' ? data.version : -1,
    changed: !!(data && data.changed),
    outcome: data && typeof data.outcome === 'string' ? data.outcome : undefined,
    messages: data && Array.isArray(data.messages) ? (data.messages as ChatHistoryMessage[]) : undefined,
  }
}
