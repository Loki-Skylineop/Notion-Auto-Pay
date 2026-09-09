// Вкладка «Пользователи» — только для администратора.
//
// Здесь админ создаёт логины, задаёт пароли, роли, выдаёт аккаунты Notion и
// отдельные рабочие пространства. Сервер: /admin/users, /admin/users/password.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DiscoveredAccount } from './WorkspacePool'
import {
  createUser,
  deleteUser,
  fetchPoolWorkspaces,
  fetchUsers,
  setUserPassword,
  updateUser,
  type PoolAccountOption,
  type PoolWorkspaceAccount,
  type Role,
  type UserSpaceGrant,
  type UserView,
} from '../apiUsers'

interface SpaceOption {
  space_id: string
  name: string
  account_email: string
}

const INPUT =
  'w-full bg-[#0a0a0a] border border-white/[0.08] rounded-md px-3 py-1.5 text-[12px] text-text-primary focus:outline-none focus:border-white/[0.20] transition-colors'
const CARD = 'rounded-xl border border-white/[0.08] bg-[#0c0c0c]'
const BTN_GHOST =
  'px-3 py-1.5 rounded-lg border border-white/[0.09] text-[12px] text-text-secondary hover:border-white/[0.18] hover:text-text-primary transition-colors bg-transparent cursor-pointer disabled:opacity-40'
const BTN_PRIMARY =
  'px-3 py-1.5 rounded-lg bg-white text-black text-[12px] font-medium hover:bg-[#f0f0f0] transition-colors border-none cursor-pointer disabled:opacity-40'
const BTN_DANGER =
  'px-3 py-1.5 rounded-lg border border-[#eb5757]/40 text-[12px] text-[#eb5757] hover:bg-[#eb5757]/10 transition-colors bg-transparent cursor-pointer disabled:opacity-40'

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function UsersTab({
  accounts,
  currentUsername,
  active = false,
}: {
  accounts: DiscoveredAccount[]
  currentUsername: string
  // Вкладка открыта: только тогда есть смысл дёргать /admin/workspaces.
  active?: boolean
}) {
  const [users, setUsers] = useState<UserView[]>([])
  const [poolAccounts, setPoolAccounts] = useState<PoolAccountOption[]>([])
  const [livePool, setLivePool] = useState<PoolWorkspaceAccount[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  // Форма создания.
  const [newLogin, setNewLogin] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newName, setNewName] = useState('')
  const [newRole, setNewRole] = useState<Role>('user')

  // Черновик открытого на редактирование пользователя.
  const [openUser, setOpenUser] = useState<string | null>(null)
  const [draftRole, setDraftRole] = useState<Role>('user')
  const [draftName, setDraftName] = useState('')
  const [draftDisabled, setDraftDisabled] = useState(false)
  const [draftAccounts, setDraftAccounts] = useState<string[]>([])
  const [draftSpaces, setDraftSpaces] = useState<UserSpaceGrant[]>([])
  const [resetPassword, setResetPassword] = useState('')

  // Пользователи + актуальный состав пула. Пул берём напрямую с сервера
  // (/admin/workspaces): именно он решает, какие аккаунты и пространства
  // сейчас видны на вкладке «Оплата». Кэш браузера здесь не участвует,
  // поэтому скрытые (не отдаваемые сервером) записи в выдачу не попадают.
  const load = useCallback(async () => {
    setLoading(true)
    const [usersRes, poolRes] = await Promise.allSettled([fetchUsers(), fetchPoolWorkspaces()])
    if (usersRes.status === 'fulfilled') {
      setUsers(usersRes.value.users)
      setPoolAccounts(usersRes.value.pool_accounts)
      setError('')
    } else {
      setError(errText(usersRes.reason))
    }
    if (poolRes.status === 'fulfilled') setLivePool(poolRes.value)
    setLoading(false)
  }, [])

  // Грузим только когда вкладку реально открыли: /admin/workspaces опрашивает
  // Notion по каждому аккаунту, дёргать его на каждой загрузке страницы незачем.
  const loadedRef = useRef(false)
  useEffect(() => {
    if (!active || loadedRef.current) return
    loadedRef.current = true
    void load()
  }, [active, load])

  // Источник истины по пулу: свежий ответ сервера, а пока его нет — то, что
  // уже показано на вкладке «Оплата».
  const poolSource = useMemo(() => {
    const src = livePool
      ? livePool.map(a => ({ user_email: a.user_email, spaces: a.spaces || [] }))
      : accounts.map(a => ({ user_email: a.user_email, spaces: a.spaces || [] }))
    return src
  }, [livePool, accounts])

  // Почты аккаунтов, которые реально есть в пуле прямо сейчас.
  const visibleEmails = useMemo(() => {
    const set = new Set<string>()
    for (const acc of poolSource) {
      const email = (acc.user_email || '').trim().toLowerCase()
      if (email) set.add(email)
    }
    return set
  }, [poolSource])

  // Пространства для выдачи: только те, что видны в пуле.
  const spaceOptions = useMemo<SpaceOption[]>(() => {
    const out: SpaceOption[] = []
    const seen = new Set<string>()
    for (const acc of poolSource) {
      const email = (acc.user_email || '').trim().toLowerCase()
      for (const space of acc.spaces || []) {
        if (!space.space_id || seen.has(space.space_id)) continue
        seen.add(space.space_id)
        out.push({
          space_id: space.space_id,
          name: space.name || space.space_id,
          account_email: email,
        })
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name, 'ru'))
    return out
  }, [poolSource])

  const openEditor = (u: UserView) => {
    setOpenUser(u.username)
    setDraftRole(u.role)
    setDraftName(u.display_name || '')
    setDraftDisabled(!!u.disabled)
    setDraftAccounts([...(u.accounts || [])])
    setDraftSpaces([...(u.spaces || [])])
    setResetPassword('')
    setError('')
    setNotice('')
  }

  const submitCreate = async () => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const created = await createUser({
        username: newLogin,
        password: newPassword,
        role: newRole,
        display_name: newName.trim() || undefined,
      })
      setNotice(`Создан пользователь «${created.username}». Пароль: ${newPassword}`)
      setNewLogin('')
      setNewPassword('')
      setNewName('')
      setNewRole('user')
      await load()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const saveDraft = async (username: string) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await updateUser({
        username,
        role: draftRole,
        display_name: draftName,
        disabled: draftDisabled,
        accounts: draftAccounts,
        spaces: draftSpaces,
      })
      setNotice(`Доступы для «${username}» сохранены`)
      await load()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const applyPassword = async (username: string) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await setUserPassword({ username, password: resetPassword })
      setNotice(`Новый пароль для «${username}»: ${resetPassword}`)
      setResetPassword('')
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const removeUser = async (username: string) => {
    if (!window.confirm(`Удалить пользователя «${username}»? Его сессии будут закрыты.`)) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await deleteUser(username)
      if (openUser === username) setOpenUser(null)
      setNotice(`Пользователь «${username}» удалён`)
      await load()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const toggleAccount = (email: string) => {
    setDraftAccounts(prev =>
      prev.includes(email) ? prev.filter(e => e !== email) : [...prev, email],
    )
  }

  const toggleSpace = (opt: SpaceOption) => {
    setDraftSpaces(prev =>
      prev.some(s => s.space_id === opt.space_id)
        ? prev.filter(s => s.space_id !== opt.space_id)
        : [
            ...prev,
            {
              space_id: opt.space_id,
              space_name: opt.name,
              account_email: opt.account_email || undefined,
            },
          ],
    )
  }

  const dropSpace = (spaceId: string) => {
    setDraftSpaces(prev => prev.filter(s => s.space_id !== spaceId))
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="text-[13px] text-text-secondary">
          Пользователи <span className="text-text-muted">({users.length})</span>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading} className={BTN_GHOST}>
          Обновить
        </button>
      </div>

      {error && <div className="text-[12px] text-[#eb5757] leading-snug break-words">{error}</div>}
      {notice && <div className="text-[12px] text-emerald-400 leading-snug break-words">{notice}</div>}

      <div className={`${CARD} p-4 space-y-3`}>
        <div className="text-[12px] font-medium text-text-primary">Новый пользователь</div>
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            className={INPUT}
            value={newLogin}
            onChange={e => setNewLogin(e.target.value)}
            placeholder="логин: a-z, 0-9, точка, дефис, _"
            autoComplete="off"
          />
          <input
            className={INPUT}
            value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
            placeholder="пароль, от 6 символов"
            autoComplete="new-password"
          />
          <input
            className={INPUT}
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="имя для отображения (необязательно)"
          />
          <select
            className={INPUT}
            value={newRole}
            onChange={e => setNewRole(e.target.value === 'admin' ? 'admin' : 'user')}
          >
            <option value="user">Пользователь</option>
            <option value="admin">Администратор</option>
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className={BTN_PRIMARY}
            disabled={busy || !newLogin.trim() || !newPassword}
            onClick={() => void submitCreate()}
          >
            Создать
          </button>
          <span className="text-[11px] text-text-muted leading-relaxed">
            Пароль хранится хешем (bcrypt) и больше не показывается — передайте его пользователю сразу.
          </span>
        </div>
      </div>

      {loading && users.length === 0 ? (
        <div className="text-[12px] text-text-muted">Загрузка…</div>
      ) : users.length === 0 ? (
        <div className="text-[12px] text-text-muted">
          Пользователей пока нет. Вы вошли по паролю из config.yaml — создайте первый логин.
        </div>
      ) : (
        <div className="space-y-2">
          {users.map(u => {
            const isOpen = openUser === u.username
            const isSelf = u.username === currentUsername
            const visiblePoolAccounts = poolAccounts.filter(
              acc => visibleEmails.has(acc.email) || (u.accounts || []).includes(acc.email),
            )
            const extraSpaces = isOpen
              ? draftSpaces.filter(s => !spaceOptions.some(o => o.space_id === s.space_id))
              : []
            return (
              <div key={u.username} className={`${CARD} p-4`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] text-text-primary font-medium">{u.username}</span>
                  {u.display_name && (
                    <span className="text-[11px] text-text-muted">· {u.display_name}</span>
                  )}
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider ${
                      u.role === 'admin'
                        ? 'bg-white/[0.10] text-text-primary'
                        : 'bg-white/[0.04] text-text-muted'
                    }`}
                  >
                    {u.role === 'admin' ? 'админ' : 'пользователь'}
                  </span>
                  {u.disabled && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider bg-[#eb5757]/15 text-[#eb5757]">
                      отключён
                    </span>
                  )}
                  {isSelf && <span className="text-[10px] text-text-muted">это вы</span>}
                  <span className="ml-auto text-[11px] text-text-muted">
                    аккаунтов: {u.accounts?.length || 0} · пространств: {u.spaces?.length || 0}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-2 mt-3">
                  <button
                    type="button"
                    className={BTN_GHOST}
                    onClick={() => (isOpen ? setOpenUser(null) : openEditor(u))}
                  >
                    {isOpen ? 'Свернуть' : 'Доступы и пароль'}
                  </button>
                  {!isSelf && (
                    <button
                      type="button"
                      className={BTN_DANGER}
                      disabled={busy}
                      onClick={() => void removeUser(u.username)}
                    >
                      Удалить
                    </button>
                  )}
                </div>

                {isOpen && (
                  <div className="mt-4 pt-4 border-t border-white/[0.07] space-y-4">
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div>
                        <label className="text-[11px] text-text-muted block mb-1.5 uppercase tracking-wider">
                          Имя
                        </label>
                        <input
                          className={INPUT}
                          value={draftName}
                          onChange={e => setDraftName(e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-text-muted block mb-1.5 uppercase tracking-wider">
                          Роль
                        </label>
                        <select
                          className={INPUT}
                          value={draftRole}
                          onChange={e => setDraftRole(e.target.value === 'admin' ? 'admin' : 'user')}
                        >
                          <option value="user">Пользователь</option>
                          <option value="admin">Администратор</option>
                        </select>
                      </div>
                    </div>

                    <label className="flex items-center gap-2 text-[12px] text-text-secondary cursor-pointer">
                      <input
                        type="checkbox"
                        checked={draftDisabled}
                        onChange={e => setDraftDisabled(e.target.checked)}
                      />
                      Вход запрещён (сессии закрываются на следующем запросе)
                    </label>

                    <div>
                      <div className="text-[11px] text-text-muted mb-2 uppercase tracking-wider">
                        Аккаунты Notion целиком
                      </div>
                      {visiblePoolAccounts.length === 0 ? (
                        <div className="text-[11px] text-text-muted">В пуле нет аккаунтов.</div>
                      ) : (
                        <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                          {visiblePoolAccounts.map(acc => {
                            const checked = draftAccounts.includes(acc.email)
                            const takenBy =
                              acc.assigned_to && acc.assigned_to !== u.username ? acc.assigned_to : ''
                            return (
                              <label
                                key={acc.email}
                                className="flex items-center gap-2 text-[12px] text-text-secondary cursor-pointer"
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => toggleAccount(acc.email)}
                                />
                                <span className="font-mono text-[11px]">{acc.email}</span>
                                {acc.name && <span className="text-text-muted">· {acc.name}</span>}
                                {takenBy && (
                                  <span className="text-[10px] text-amber-400/80">уже у {takenBy}</span>
                                )}
                              </label>
                            )
                          })}
                        </div>
                      )}
                    </div>

                    <div>
                      <div className="text-[11px] text-text-muted mb-2 uppercase tracking-wider">
                        Отдельные пространства
                      </div>
                      {spaceOptions.length === 0 ? (
                        <div className="text-[11px] text-text-muted">
                          Список пространств пуст — откройте вкладку «Оплата» и обновите пул.
                        </div>
                      ) : (
                        <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                          {spaceOptions.map(opt => (
                            <label
                              key={opt.space_id}
                              className="flex items-center gap-2 text-[12px] text-text-secondary cursor-pointer"
                            >
                              <input
                                type="checkbox"
                                checked={draftSpaces.some(s => s.space_id === opt.space_id)}
                                onChange={() => toggleSpace(opt)}
                              />
                              <span>{opt.name}</span>
                              {opt.account_email && (
                                <span className="text-[10px] text-text-muted font-mono">
                                  {opt.account_email}
                                </span>
                              )}
                            </label>
                          ))}
                        </div>
                      )}
                      {extraSpaces.length > 0 && (
                        <div className="mt-2 space-y-1.5">
                          <div className="text-[10px] text-text-muted">
                            Выдано, но сейчас не видно в пуле:
                          </div>
                          {extraSpaces.map(s => (
                            <div
                              key={s.space_id}
                              className="flex items-center gap-2 text-[12px] text-text-secondary"
                            >
                              <span>{s.space_name || s.space_id}</span>
                              <button
                                type="button"
                                className="text-[11px] text-[#eb5757] bg-transparent border-none cursor-pointer"
                                onClick={() => dropSpace(s.space_id)}
                              >
                                убрать
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className={BTN_PRIMARY}
                        disabled={busy}
                        onClick={() => void saveDraft(u.username)}
                      >
                        Сохранить доступы
                      </button>
                    </div>

                    <div className="pt-3 border-t border-white/[0.07] space-y-2">
                      <div className="text-[11px] text-text-muted uppercase tracking-wider">
                        Сбросить пароль
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          className={`${INPUT} sm:max-w-xs`}
                          value={resetPassword}
                          onChange={e => setResetPassword(e.target.value)}
                          placeholder="новый пароль, от 6 символов"
                          autoComplete="new-password"
                        />
                        <button
                          type="button"
                          className={BTN_GHOST}
                          disabled={busy || resetPassword.length < 6}
                          onClick={() => void applyPassword(u.username)}
                        >
                          Задать пароль
                        </button>
                      </div>
                      <div className="text-[11px] text-text-muted leading-relaxed">
                        Все другие сессии этого логина закроются, текущая — нет.
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
