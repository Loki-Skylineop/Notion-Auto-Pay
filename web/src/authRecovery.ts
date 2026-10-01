export const AUTH_EXPIRED_EVENT = 'nmp-auth-expired'
export const AUTH_RECOVERY_BLOCKED_EVENT = 'nmp-auth-recovery-blocked'
const RELOAD_KEY = 'nmp_unauthorized_reload_at_v1'
const COOLDOWN_MS = 120_000

interface RecoveryOptions {
  fetch: typeof fetch
  origin: string
  storage: Pick<Storage, 'getItem' | 'setItem'>
  reload: () => void
  onExpired: () => void
  onBlocked: () => void
  now?: () => number
}
// Observe failures, never replay requests: a payment, deletion or chat send may
// already have been processed. Login failures and external services are excluded.
export function createAuthRecovery(options: RecoveryOptions): typeof fetch {
  let recovery: Promise<void> | null = null
  let reloading = false
  const now = options.now || Date.now
  const recover = async () => {
    try {
      const response = await options.fetch('/dashboard/auth/check', { credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) { options.onBlocked(); return }
      const status = await response.json() as { authenticated?: boolean; required?: boolean }
      if (status.required === true && status.authenticated !== true) { options.onExpired(); return }
      if (status.authenticated !== true && status.required !== false) { options.onBlocked(); return }
      try {
        const last = Number(options.storage.getItem(RELOAD_KEY))
        if (last > 0 && now() - last < COOLDOWN_MS) { options.onBlocked(); return }
        const stamp = now()
        options.storage.setItem(RELOAD_KEY, String(stamp))
        // No persistent guard means reloads could loop in privacy mode.
        if (Number(options.storage.getItem(RELOAD_KEY)) !== stamp) { options.onBlocked(); return }
      } catch { options.onBlocked(); return }
      reloading = true
      options.reload()
    } catch { options.onBlocked() }
  }
  return async (input, init) => {
    const response = await options.fetch(input, init)
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(raw, options.origin)
    if (url.origin === options.origin && url.pathname.startsWith('/admin/') && response.status === 401 && !reloading && !recovery) {
      recovery = recover().finally(() => { recovery = null })
    }
    return response // Preserve the original body/stream for its caller.
  }
}

export function installAuthRecovery(): void {
  const original = window.fetch.bind(window)
  // Reading the sessionStorage getter itself can throw in restricted browsers.
  const storage = {
    getItem: (key: string) => window.sessionStorage.getItem(key),
    setItem: (key: string, value: string) => window.sessionStorage.setItem(key, value),
  }
  window.fetch = createAuthRecovery({
    fetch: original, origin: window.location.origin, storage,
    reload: () => window.location.reload(),
    onExpired: () => window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT)),
    onBlocked: () => window.dispatchEvent(new Event(AUTH_RECOVERY_BLOCKED_EVENT)),
  })
}
