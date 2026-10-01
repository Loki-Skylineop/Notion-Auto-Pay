import { useCallback, useEffect, useRef, useState } from 'react'
import { chatThreads, chatHistory } from '../api'
import type { SpaceOption } from '../components/ChatTabParts'
import type { WorkspaceActivity } from '../chatNavigation'

export function useWorkspaceActivity(spaces: SpaceOption[], enabled: boolean) {
  const [activity, setActivity] = useState<Record<string, WorkspaceActivity>>({})
  const cache = useRef(activity)
  const spacesRef = useRef(spaces)
  spacesRef.current = spaces
  const inFlight = useRef(new Set<string>())
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const put = useCallback((key: string, value: WorkspaceActivity) => {
    cache.current = { ...cache.current, [key]: value }
    if (mounted.current) setActivity(cache.current)
  }, [])
  const scan = useCallback(async () => {
    if (!enabled || document.visibilityState === 'hidden') return
    const targets = spacesRef.current.filter(s => !inFlight.current.has(s.key) && Date.now() - (cache.current[s.key]?.checkedAt || 0) > 120000)
    for (const s of targets) inFlight.current.add(s.key)
    let cursor = 0
    const worker = async () => {
      while (cursor < targets.length && mounted.current) {
        const space = targets[cursor++]
        const startedAt = Date.now()
        const ref = { token_v2: space.account.token_v2, user_id: space.account.user_id, space_id: space.spaceId }
        try {
          const threads = (await chatThreads(ref)).sort((a,b) => (b.updated_at || b.created_at || 0) - (a.updated_at || a.created_at || 0))
          let lastMessageAt = 0
          let hasMessages = false
          let count = 0
          let incomplete = false
          let historyChecks = 0
          for (const t of threads) {
            let has = (t.message_count || 0) > 0
            if (t.message_count === undefined) {
              // One confirmed message proves membership in the first group.
              // Bound costly history reads; unverified tails remain UNKNOWN,
              // not empty. Known metadata still contributes recency below.
              if (hasMessages || historyChecks >= 12) { incomplete = true; continue }
              historyChecks++
              // Metadata can be absent; verify actual history rather than
              // treating a newly-created empty transcript as a message.
              try { has = (await chatHistory({ ...ref, thread_id: t.id })).messages.length > 0 }
              catch { incomplete = true; continue }
            }
            if (has) {
              hasMessages = true; count++
              lastMessageAt = Math.max(lastMessageAt, t.updated_at || t.created_at || 0)
            }
          }
          const previous = cache.current[space.key]
          if ((previous?.checkedAt || 0) > startedAt) continue // A new message won the race.
          // Failed requests are UNKNOWN, never proof that a space is empty.
          put(space.key, { hasMessages: hasMessages ? true : incomplete ? previous?.hasMessages ?? null : false, lastMessageAt: lastMessageAt || (incomplete ? previous?.lastMessageAt || 0 : 0), chatCount: count, checkedAt: Date.now() })
        } catch {
          const previous = cache.current[space.key]
          if ((previous?.checkedAt || 0) > startedAt) continue
          put(space.key, { hasMessages: previous?.hasMessages ?? null, lastMessageAt: previous?.lastMessageAt || 0, chatCount: previous?.chatCount || 0, checkedAt: Date.now() })
        } finally { inFlight.current.delete(space.key) }
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, targets.length) }, worker))
    for (const s of targets) inFlight.current.delete(s.key)
  }, [enabled, put])
  const signature = spaces.map(s => s.key).sort().join('|')
  useEffect(() => { void scan() }, [signature, scan])
  const markMessage = useCallback((key: string) => {
    const old = cache.current[key]
    put(key, { hasMessages: true, lastMessageAt: Date.now(), chatCount: Math.max(old?.chatCount || 0, 1), checkedAt: Date.now() })
  }, [put])
  return { activity, scan, markMessage }
}
