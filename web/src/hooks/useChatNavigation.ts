import { useCallback, useEffect, useRef, useState } from 'react'
import { locationKey, type ChatLocation, type ChatNavigation } from '../chatNavigation'

const empty = (): ChatNavigation => ({ revision: 0, active: null, threads: {} })
export function useChatNavigation(owner: string) {
  const cacheKey = `nmp_chat_navigation_v2:${owner}`
  const [data, setData] = useState<ChatNavigation>(empty)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const latest = useRef(data)
  const revision = useRef<number | null>(null)
  const queue = useRef(Promise.resolve())
  const mounted = useRef(true)
  const update = useCallback((next: ChatNavigation) => {
    latest.current = next
    if (mounted.current) setData(next)
    try { localStorage.setItem(cacheKey, JSON.stringify(next)) } catch { /* private-mode cache is optional */ }
  }, [cacheKey])
  useEffect(() => {
    let cancelled = false
    mounted.current = true
    const load = async () => {
      try {
        const resp = await fetch('/admin/chat/navigation', { credentials: 'same-origin', cache: 'no-store' })
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        const next = await resp.json() as ChatNavigation
        if (cancelled) return
        revision.current = next.revision
        update({ ...next, threads: next.threads || {} })
      } catch {
        if (cancelled) return
        try {
          const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null') as ChatNavigation | null
          if (cached?.threads) update(cached)
        } catch { /* no cache for THIS dashboard login */ }
        setError('Выбор чата не загружен с сервера. Локальная копия не синхронизируется с другими устройствами.')
      } finally { if (!cancelled) setReady(true) }
    }
    void load()
    return () => { cancelled = true; mounted.current = false }
  }, [cacheKey, update])

  // Only explicit user navigation calls this. No mount/fallback/background
  // effect writes empty IDs over a saved selection. Requests are serialized.
  const remember = useCallback((location: ChatLocation) => {
    const key = locationKey(location)
    update({ ...latest.current, unavailable: false, active: location, threads: { ...latest.current.threads, [key]: location.thread_id } })
    queue.current = queue.current.catch(() => {}).then(async () => {
      if (!mounted.current) return // Never send a queued choice under a later login's cookie.
      try {
        if (revision.current === null) {
          const resp = await fetch('/admin/chat/navigation', { credentials: 'same-origin', cache: 'no-store' })
          if (!resp.ok) throw new Error('Не удалось получить версию выбора')
          revision.current = (await resp.json() as ChatNavigation).revision
        }
        for (let attempt = 0; attempt < 3; attempt++) {
          const resp = await fetch('/admin/chat/navigation', {
            method: 'PUT', credentials: 'same-origin', keepalive: true,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ revision: revision.current, location }),
          })
          const next = await resp.json() as ChatNavigation
          if (resp.status === 409) { revision.current = next.revision; continue }
          if (!resp.ok) throw new Error('Сервер не сохранил выбор чата')
          revision.current = next.revision
          // Do not undo a newer choice already made while this write was in flight.
          update({ ...latest.current, revision: next.revision })
          if (mounted.current) setError('')
          return
        }
        throw new Error('Выбор одновременно изменяется на другом устройстве')
      } catch (e) {
        revision.current = null
        if (mounted.current) setError(`${e instanceof Error ? e.message : 'Ошибка синхронизации'}. Выбор сохранён только на этом устройстве.`)
      }
    })
  }, [update])
  return { data, ready, error, remember }
}
