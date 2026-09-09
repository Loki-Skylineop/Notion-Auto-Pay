// Многопользовательский слой поверх api.ts: вход по логину, «кто я» и
// управление пользователями. Вынесено в отдельный файл, чтобы не трогать
// исходный api.ts и легко видеть, что добавлено сверх оригинала.
//
// Серверная сторона: internal/proxy/users_session.go и users_api.go.

export type Role = 'admin' | 'user'

// Одно выданное админом пространство (UserSpace в Go).
export interface UserSpaceGrant {
  account_email?: string
  space_id: string
  space_name?: string
}

// UserView в Go: всё, кроме хеша пароля.
export interface UserView {
  username: string
  display_name?: string
  role: Role
  accounts: string[]
  spaces: UserSpaceGrant[]
  disabled: boolean
  created_at?: string
  updated_at?: string
  last_login_at?: string
}

// Аккаунт из пула для выбора в форме назначения.
export interface PoolAccountOption {
  email: string
  name?: string
  space_name?: string
  assigned_to?: string
}

// Аккаунт пула так, как его прямо сейчас отдаёт /admin/workspaces. Аккаунты,
// по которым discovery не прошёл, сервер в этот список не кладёт — значит их
// не должно быть и в списках выдачи доступов.
export interface PoolWorkspaceAccount {
  user_id?: string
  user_name?: string
  user_email?: string
  token_v2?: string
  spaces?: Array<{ space_id: string; name?: string; space_view_id?: string }>
}

export async function fetchPoolWorkspaces(): Promise<PoolWorkspaceAccount[]> {
  const data = await requestJson<PoolWorkspaceAccount[]>('/admin/workspaces')
  return Array.isArray(data) ? data : []
}

export interface MePermissions {
  manage_users: boolean
  manage_accounts: boolean
  manage_workspaces: boolean
  pay: boolean
  register: boolean
  settings: boolean
  chat: boolean
}

export interface Me {
  username: string
  role: Role
  is_admin: boolean
  auth_required: boolean
  display_name?: string
  accounts: string[]
  spaces: UserSpaceGrant[]
  can: MePermissions
}

// Сервер отвечает либо {error}, либо {error, message} — берём то, что понятнее
// человеку, и никогда не падаем на пустом или не-JSON теле.
async function readError(resp: Response): Promise<string> {
  try {
    const text = await resp.text()
    if (!text) return `HTTP ${resp.status}`
    const data = JSON.parse(text) as { error?: string; message?: string }
    return data.message || data.error || `HTTP ${resp.status}`
  } catch {
    return `HTTP ${resp.status}`
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, {
    credentials: 'same-origin',
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers || {}),
    },
  })
  if (!resp.ok) throw new Error(await readError(resp))
  const text = await resp.text()
  return (text ? JSON.parse(text) : {}) as T
}

export interface LoginResult {
  ok: boolean
  error?: string
  username?: string
  role?: Role
  is_admin?: boolean
}

// Вход по логину и паролю. Пароль уходит на сервер как есть: его нужно
// сравнить с bcrypt-хешем, а браузер bcrypt не умеет. При выносе на домен
// обязателен HTTPS — иначе пароль виден в сети.
export async function loginWithUsername(username: string, password: string): Promise<LoginResult> {
  const resp = await fetch('/dashboard/auth/login', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ username: username.trim(), password }),
  })
  if (!resp.ok) return { ok: false, error: await readError(resp) }
  const text = await resp.text()
  const data = (text ? JSON.parse(text) : {}) as { username?: string; role?: Role; is_admin?: boolean }
  return { ok: true, username: data.username, role: data.role, is_admin: data.is_admin }
}

export function fetchMe(): Promise<Me> {
  return requestJson<Me>('/admin/me')
}

export interface UsersResponse {
  users: UserView[]
  pool_accounts: PoolAccountOption[]
}

export async function fetchUsers(): Promise<UsersResponse> {
  const data = await requestJson<Partial<UsersResponse>>('/admin/users')
  return { users: data.users || [], pool_accounts: data.pool_accounts || [] }
}

export interface CreateUserInput {
  username: string
  password: string
  role: Role
  display_name?: string
}

export async function createUser(input: CreateUserInput): Promise<UserView> {
  const data = await requestJson<{ user: UserView }>('/admin/users', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return data.user
}

// Поля, которые не передали, на сервере не меняются (в Go это указатели).
export interface UpdateUserInput {
  username: string
  role?: Role
  display_name?: string
  disabled?: boolean
  accounts?: string[]
  spaces?: UserSpaceGrant[]
}

export async function updateUser(input: UpdateUserInput): Promise<UserView> {
  const data = await requestJson<{ user: UserView }>('/admin/users', {
    method: 'PUT',
    body: JSON.stringify(input),
  })
  return data.user
}

export async function deleteUser(username: string): Promise<void> {
  await requestJson<{ deleted: string }>(`/admin/users?username=${encodeURIComponent(username)}`, {
    method: 'DELETE',
  })
}

// Админ задаёт пароль любому; обычный пользователь — только себе и только
// с подтверждением текущего пароля.
export async function setUserPassword(input: {
  username?: string
  password: string
  current_password?: string
}): Promise<void> {
  await requestJson<{ ok: boolean }>('/admin/users/password', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}
