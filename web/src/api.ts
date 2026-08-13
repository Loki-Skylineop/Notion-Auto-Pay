import type { DashboardData, JobStartResponse, ProviderInfo, RegisterJob, TokenStats } from './types'

// --- Auth API ---

const SHA256_INITIAL_HASH = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]

const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits))
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// В нестандартных контекстах (например, WSL2 Win10 с доступом по LAN IP через HTTP),
// браузер может отключить crypto.subtle — здесь чистый фронтенд SHA-256 fallback.
function sha256hexFallback(data: Uint8Array): string {
  const paddedLength = Math.ceil((data.length + 9) / 64) * 64
  const padded = new Uint8Array(paddedLength)
  padded.set(data)
  padded[data.length] = 0x80

  const bitLength = BigInt(data.length) * 8n
  for (let i = 0; i < 8; i += 1) {
    padded[padded.length - 1 - i] = Number((bitLength >> BigInt(i * 8)) & 0xffn)
  }

  const hash = SHA256_INITIAL_HASH.slice()
  const schedule = new Uint32Array(64)

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      const index = offset + i * 4
      schedule[i] = (
        (padded[index] << 24) |
        (padded[index + 1] << 16) |
        (padded[index + 2] << 8) |
        padded[index + 3]
      ) >>> 0
    }

    for (let i = 16; i < 64; i += 1) {
      const s0 = rotateRight(schedule[i - 15], 7) ^ rotateRight(schedule[i - 15], 18) ^ (schedule[i - 15] >>> 3)
      const s1 = rotateRight(schedule[i - 2], 17) ^ rotateRight(schedule[i - 2], 19) ^ (schedule[i - 2] >>> 10)
      schedule[i] = (schedule[i - 16] + s0 + schedule[i - 7] + s1) >>> 0
    }

    let [a, b, c, d, e, f, g, h] = hash

    for (let i = 0; i < 64; i += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choose = (e & f) ^ (~e & g)
      const temp1 = (h + s1 + choose + SHA256_ROUND_CONSTANTS[i] + schedule[i]) >>> 0
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (s0 + majority) >>> 0

      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }

    hash[0] = (hash[0] + a) >>> 0
    hash[1] = (hash[1] + b) >>> 0
    hash[2] = (hash[2] + c) >>> 0
    hash[3] = (hash[3] + d) >>> 0
    hash[4] = (hash[4] + e) >>> 0
    hash[5] = (hash[5] + f) >>> 0
    hash[6] = (hash[6] + g) >>> 0
    hash[7] = (hash[7] + h) >>> 0
  }

  return hash.map((value) => value.toString(16).padStart(8, '0')).join('')
}

async function sha256hex(message: string): Promise<string> {
  const data = new TextEncoder().encode(message)
  if (globalThis.crypto?.subtle) {
    try {
      const hash = await globalThis.crypto.subtle.digest('SHA-256', data)
      return toHex(new Uint8Array(hash))
    } catch {
      // Некоторые браузеры/контексы раскрывают subtle, но вызов всё равно блокируется политикой безопасности.
    }
  }
  return sha256hexFallback(data)
}

async function readJson<T>(resp: Response, fallbackMessage: string): Promise<T> {
  const text = await resp.text()
  if (!text) {
    throw new Error(fallbackMessage)
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(fallbackMessage)
  }
}

export interface AuthStatus {
  authenticated: boolean
  required: boolean
}

export async function checkAuth(): Promise<AuthStatus> {
  const resp = await fetch('/dashboard/auth/check', {
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
  })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return readJson<AuthStatus>(resp, 'Сервер авторизации вернул некорректный ответ')
}

export async function fetchSalt(): Promise<{ salt: string; required: boolean }> {
  const resp = await fetch('/dashboard/auth/salt', {
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
  })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return readJson<{ salt: string; required: boolean }>(resp, 'Конфигурация логина вернула некорректный ответ')
}

export async function login(password: string): Promise<{ ok: boolean; error?: string }> {
  const { salt } = await fetchSalt()
  const hash = await sha256hex(salt + password)
  const resp = await fetch('/dashboard/auth/login', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    credentials: 'same-origin',
    body: JSON.stringify({ hash }),
  })
  const data = await readJson<{ error?: string }>(resp, 'Сервер логина вернул некорректный ответ')
  if (!resp.ok) return { ok: false, error: data.error || 'Login failed' }
  return { ok: true }
}

export async function logout(): Promise<void> {
  await fetch('/dashboard/auth/logout', { method: 'POST', credentials: 'same-origin' })
}

// --- Dashboard API ---

export interface AccountListParams {
  page?: number
  pageSize?: number
  query?: string
}

export async function fetchDashboardData(params: AccountListParams = {}): Promise<DashboardData> {
  // Uses dashboard session cookie for auth (not API key).
  // Server-side pagination keeps the payload small for big pools — see
  // proxy.HandleAdminAccounts for the contract.
  const sp = new URLSearchParams()
  if (params.page !== undefined) sp.set('page', String(params.page))
  if (params.pageSize !== undefined) sp.set('page_size', String(params.pageSize))
  if (params.query && params.query.trim()) sp.set('q', params.query.trim())
  const qs = sp.toString()
  const url = qs ? `/admin/accounts?${qs}` : '/admin/accounts'
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return resp.json()
}

export async function triggerRefresh(): Promise<{ started: boolean; message?: string }> {
  // Uses dashboard session cookie for auth (not API key)
  const resp = await fetch('/admin/refresh', { method: 'POST' })
  return resp.json()
}

export async function fetchTokenStats(): Promise<TokenStats> {
  // Uses dashboard session cookie for auth (not API key)
  const resp = await fetch('/admin/stats')
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return resp.json()
}

export function openProxy(email: string) {
  window.open(`/proxy/start?email=${encodeURIComponent(email)}`, '_blank')
}

export function openBestProxy() {
  window.open('/proxy/start?best=true', '_blank')
}

// --- Account Management API ---

export interface AddAccountResult {
  status?: string
  error?: string
  filename?: string
  account?: {
    name: string
    email: string
    space: string
    plan_type: string
  }
}

export async function addAccount(tokenV2: string): Promise<AddAccountResult> {
  const resp = await fetch('/admin/accounts/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ token_v2: tokenV2 }),
  })
  const data = await readJson<AddAccountResult>(resp, 'Сервер добавления аккаунта вернул некорректный ответ')
  if (!resp.ok) return { error: data.error || `HTTP ${resp.status}` }
  return data
}

// --- Settings API ---

export interface SearchSettings {
  enable_web_search: boolean
  enable_workspace_search: boolean
  // ask_mode_default flips Notion's workflow useReadOnlyMode flag for
  // every chat request — model answers but skips edits, matching the
  // frontend "Ask" toggle. Per-request `-ask` model suffix still
  // overrides this default for a single call.
  ask_mode_default: boolean
  disable_notion_prompt: boolean
  debug_logging: boolean
  // notion_proxy is the global upstream proxy applied to every Notion-bound
  // outbound connection. Empty string means "direct dial". Editing this
  // field via /admin/settings PUT immediately drops idle pooled
  // connections so subsequent requests pick up the new upstream.
  notion_proxy: string
}

export async function fetchSettings(): Promise<SearchSettings> {
  // Uses dashboard session cookie for auth (not API key)
  const resp = await fetch('/admin/settings')
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return resp.json()
}

export async function updateSettings(settings: Partial<Pick<SearchSettings, 'enable_web_search' | 'enable_workspace_search' | 'ask_mode_default' | 'debug_logging' | 'notion_proxy'>>): Promise<SearchSettings> {
  // Uses dashboard session cookie for auth (not API key)
  const resp = await fetch('/admin/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  })
  if (!resp.ok) {
    // Surface server-side validation errors (e.g. unsupported proxy
    // scheme) so the caller can show them in a toast and roll the input
    // back instead of silently saving.
    const text = await resp.text()
    let msg = `HTTP ${resp.status}`
    if (text) {
      try {
        const data = JSON.parse(text)
        if (data && typeof data.error === 'string') msg = data.error
      } catch { /* ignore */ }
    }
    throw new Error(msg)
  }
  return resp.json()
}

// --- Bulk Register Jobs API ---

async function jsonOrError(resp: Response): Promise<any> {
  const text = await resp.text()
  let data: any = null
  if (text) {
    try { data = JSON.parse(text) } catch { /* ignore */ }
  }
  if (!resp.ok) {
    const msg = (data && typeof data.error === 'string') ? data.error : `HTTP ${resp.status}`
    throw new Error(msg)
  }
  return data
}

export async function listProviders(): Promise<ProviderInfo[]> {
  const resp = await fetch('/admin/register/providers', {
    credentials: 'same-origin',
  })
  const data = await jsonOrError(resp)
  return Array.isArray(data?.providers) ? data.providers : []
}

export async function startRegisterJob(
  provider: string,
  input: string,
  concurrency: number,
  proxy?: string,
): Promise<JobStartResponse> {
  const body: Record<string, unknown> = { provider, input, concurrency }
  if (proxy && proxy.trim() !== '') body.proxy = proxy.trim()
  const resp = await fetch('/admin/register/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  })
  return jsonOrError(resp) as Promise<JobStartResponse>
}

export async function retryRegisterJob(id: string): Promise<JobStartResponse> {
  const resp = await fetch(`/admin/register/jobs/${encodeURIComponent(id)}/retry`, {
    method: 'POST',
    credentials: 'same-origin',
  })
  return jsonOrError(resp) as Promise<JobStartResponse>
}

export async function deleteRegisterJob(id: string): Promise<void> {
  const resp = await fetch(`/admin/register/jobs/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  })
  await jsonOrError(resp)
}

export async function listJobs(limit = 50): Promise<RegisterJob[]> {
  const resp = await fetch(`/admin/register/jobs?limit=${encodeURIComponent(String(limit))}`, {
    credentials: 'same-origin',
  })
  const data = await jsonOrError(resp)
  return Array.isArray(data) ? data : []
}

export async function getJob(id: string): Promise<RegisterJob> {
  const resp = await fetch(`/admin/register/jobs/${encodeURIComponent(id)}`, {
    credentials: 'same-origin',
  })
  return jsonOrError(resp) as Promise<RegisterJob>
}

export async function deleteAccount(email: string): Promise<void> {
  const resp = await fetch(`/admin/accounts/${encodeURIComponent(email)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  })
  await jsonOrError(resp)
}

export function jobEventsUrl(id: string): string {
  return `/admin/register/jobs/${encodeURIComponent(id)}/events`
}

export function openJobStream(id: string): EventSource {
  // EventSource always sends cookies on same-origin requests, no extra opts
  // are required for the dashboard session.
  return new EventSource(jobEventsUrl(id))
}

// --- Subscription API ---

export interface SubscribeResult {
  status?: string
  error?: string
  email?: string
  space_id?: string
  plan?: string
}

export async function subscribe(tokenV2: string, paymentMethodId: string, plan: string, country?: string): Promise<SubscribeResult> {
  const resp = await fetch('/admin/subscribe/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      token_v2: tokenV2,
      payment_method_id: paymentMethodId,
      plan: plan,
      country: country || 'DE',
    }),
  })
  const data = await readJson<SubscribeResult>(resp, '订阅接口返回了无效响应')
  if (!resp.ok) return { error: data.error || `HTTP ${resp.status}` }
  return data
}

// --- Trial API ---

export interface TrialResult {
  status?: string
  error?: string
  email?: string
  space_id?: string
  plan?: string
  days?: number
  trial_end?: string
  subscription_status?: string
  invoice_url?: string
  attempts?: number
}

export interface TrialInput {
  token_v2: string
  space_id?: string
  plan?: string
  days?: number
  captcha_token?: string
}

// Активация бесплатного триала для одного пространства — карта не нужна.
// Сервер повторяет запрос, снятый с веб-клиента Notion (HAR): тот же
// /api/v3/updateSubscription, но с trialData + trialEnd и без paymentMethodId.
// Успех выглядит как {"subscriptionStatus":"trialing", "invoiceUrl": "..."}.
export async function startTrial(input: TrialInput): Promise<TrialResult> {
  const resp = await fetch('/admin/subscribe/trial', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(input),
  })
  const text = await resp.text()
  let data: TrialResult = {}
  try { data = text ? JSON.parse(text) : {} } catch { data = {} }
  if (!resp.ok || data.error) return { error: data.error || `HTTP ${resp.status}` }
  return data
}

// --- Workspace Discovery API ---

// One MCP server integration attached to a workspace. The backend merges the
// /api/v3/listExternalConnections entry (status + URL) with its backing
// workflow_module record (name, icon, tool list).
export interface McpServerInfo {
  id: string
  name?: string
  icon?: string
  url?: string
  status?: string
  tools_count?: number
}

export interface WorkspaceInfo {
  space_id: string
  space_view_id: string
  name: string
  plan_type: string
  membership: string
  domain: string
  region: string
  cell: string
  is_subscribed: boolean
  // True when at least one MCP server is in the "connected" state. Drives the
  // indicator the pool draws next to the workspace name.
  mcp_connected?: boolean
  mcp_servers?: McpServerInfo[]
  // Notion's "use additional credits" switch, read from
  // space.settings.ai_credit_overage_policy: "disabled" when off,
  // "all_workspace_members" when on. overage_enabled is the ready-made boolean.
  overage_policy?: string
  overage_enabled?: boolean
}

export interface DiscoverResult {
  user_id?: string
  user_name?: string
  user_email?: string
  token_v2?: string
  spaces?: WorkspaceInfo[]
  error?: string
}

export interface SetOverageParams {
  tokenV2: string
  userId?: string
  spaceId: string
  enabled: boolean
}

export interface SetOverageResult {
  ok?: boolean
  policy?: string
  enabled?: boolean
  error?: string
}

// setOverage flips a workspace's "use additional credits" switch. The server
// replays the same saveTransactionsFanout transaction the Notion web client
// sends from its AI settings page (AiSettings.toggleCreditOverage).
export async function setOverage(p: SetOverageParams): Promise<SetOverageResult> {
  const resp = await fetch('/admin/overage/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      token_v2: p.tokenV2,
      user_id: p.userId || '',
      space_id: p.spaceId,
      enabled: p.enabled,
    }),
  })
  const data = await resp.json().catch(() => null)
  if (!data || typeof data !== 'object') {
    return { error: 'Сервер вернул некорректный ответ' }
  }
  return data as SetOverageResult
}

export async function discoverWorkspaces(tokenV2: string): Promise<DiscoverResult> {
  const resp = await fetch('/admin/discover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ token_v2: tokenV2 }),
  })
  const data = await readJson<DiscoverResult>(resp, 'Discovery endpoint returned invalid response')
  if (!resp.ok) return { error: data.error || `HTTP ${resp.status}` }
  return data
}

// --- Workspace Creation API ---
// Создание новых пространств для одного аккаунта. Имена генерирует сервер
// (см. internal/proxy/workspace_create.go): каждый вызов /createSpace он
// дополняет транзакцией space_view, иначе пространство не попадает в сайдбар.

export interface CreatedWorkspace {
  space_id: string
  space_view_id?: string
  name: string
}

export interface CreateWorkspacesResult {
  user_id?: string
  requested?: number
  created: CreatedWorkspace[]
  errors?: string[]
  error?: string
}

// createWorkspaces создаёт count пространств со случайными именами. Сервер
// работает последовательно и возвращает частичный результат, поэтому created
// может быть короче запрошенного, а errors — содержать причины отказов.
// --- MCP connect API ---

export interface ConnectMcpParams {
  tokenV2: string
  userId: string
  spaceId: string
  spaceViewId: string
  serverUrl: string
  headerName?: string
  headerValue?: string
  name?: string
  icon?: string
}

export interface ConnectMcpResult {
  ok?: boolean
  module_id?: string
  name?: string
  icon?: string
  server_url?: string
  tools_count?: number
  error?: string
}

// connectMcp attaches an MCP server to one workspace. The server replays the
// same four calls the Notion web client makes when you add a server by hand.
export async function connectMcp(p: ConnectMcpParams): Promise<ConnectMcpResult> {
  const resp = await fetch('/admin/mcp/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      token_v2: p.tokenV2,
      user_id: p.userId,
      space_id: p.spaceId,
      space_view_id: p.spaceViewId,
      server_url: p.serverUrl,
      header_name: p.headerName || '',
      header_value: p.headerValue || '',
      name: p.name || '',
      icon: p.icon || '',
    }),
  })
  const data = await readJson<ConnectMcpResult>(resp, 'Сервер подключения MCP вернул некорректный ответ')
  if (!resp.ok) {
    return { ...data, ok: false, error: data.error || `HTTP ${resp.status}` }
  }
  return { ...data, ok: data.ok !== false }
}

// disconnectMcp отключает MCP-сервер от пространства. Сервер повторяет ровно
// одну транзакцию веб-клиента (ConnectionSurfaceTabs.disconnectPersonalMcpServer):
// убирает модуль из space_view.settings.agent_chat_modules и гасит сам
// workflow_module флагом alive:false. Отдельного delete-эндпоинта у Notion нет.
export interface DisconnectMcpParams {
  tokenV2: string
  userId: string
  spaceId: string
  spaceViewId?: string
  // Достаточно любого из двух: id модуля или URL сервера.
  moduleId?: string
  serverUrl?: string
}

export interface DisconnectMcpResult {
  ok?: boolean
  module_id?: string
  error?: string
}

export async function disconnectMcp(p: DisconnectMcpParams): Promise<DisconnectMcpResult> {
  const resp = await fetch('/admin/mcp/disconnect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      token_v2: p.tokenV2,
      user_id: p.userId,
      space_id: p.spaceId,
      space_view_id: p.spaceViewId || '',
      module_id: p.moduleId || '',
      server_url: p.serverUrl || '',
    }),
  })
  const data = await readJson<DisconnectMcpResult>(resp, 'Сервер отключения MCP вернул некорректный ответ')
  if (!resp.ok) {
    return { ...data, ok: false, error: data.error || `HTTP ${resp.status}` }
  }
  return { ...data, ok: data.ok !== false }
}

export async function createWorkspaces(tokenV2: string, count: number): Promise<CreateWorkspacesResult> {
  const resp = await fetch('/admin/workspaces/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ token_v2: tokenV2, count }),
  })
  const data = await readJson<CreateWorkspacesResult>(resp, 'Сервер создания пространств вернул некорректный ответ')
  if (!resp.ok) {
    return {
      created: data.created || [],
      errors: data.errors,
      error: data.error || `HTTP ${resp.status}`,
    }
  }
  return { ...data, created: data.created || [] }
}

// --- Workspace deletion API ---
// Удаление пространства. Сервер повторяет то же, что делает веб-клиент Notion:
// один enqueueTask с eventName "deleteSpace", а затем опрос getTasks до
// состояния success (см. internal/proxy/workspace_delete.go). Операция
// необратима, подтверждение целиком на стороне интерфейса.

export interface DeletedWorkspace {
  space_id: string
  task_id?: string
  // Состояние задачи на стороне Notion: "success", "in_progress" или "failure".
  state?: string
}

export interface DeleteWorkspacesResult {
  user_id?: string
  requested?: number
  deleted: DeletedWorkspace[]
  errors?: string[]
  error?: string
}

// deleteWorkspaces удаляет перечисленные пространства одного аккаунта. Сервер
// работает последовательно и возвращает частичный результат, поэтому deleted
// может быть короче запроса, а errors — содержать причины отказов.
export async function deleteWorkspaces(
  tokenV2: string,
  spaceIds: string[],
  userId?: string,
): Promise<DeleteWorkspacesResult> {
  const resp = await fetch('/admin/workspaces/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ token_v2: tokenV2, user_id: userId || '', space_ids: spaceIds }),
  })
  const data = await readJson<DeleteWorkspacesResult>(resp, 'Сервер удаления пространств вернул некорректный ответ')
  if (!resp.ok) {
    return {
      deleted: data.deleted || [],
      errors: data.errors,
      error: data.error || `HTTP ${resp.status}`,
    }
  }
  return { ...data, deleted: data.deleted || [] }
}

// --- Chat API ---
// Proxies the private Notion AI chat protocol through the server (see
// internal/proxy/chat.go). Every call carries the selected workspace's
// token_v2 + ids so the server can act as that account.

export interface ChatAgent {
  id: string // "default" or a workflowId
  name: string
  icon?: string
  kind: string // "default" | "custom"
}

// One model available to the built-in assistant (from getAvailableModels).
export interface ChatModel {
  id: string // codename, e.g. "ambrosia-tart-high"
  label: string // human label, e.g. "Opus 4.8"
  family: string
  group: string // "fast" | "intelligent"
  disabled: boolean
  // Reasoning efforts this specific model accepts, mirrored from Notion's
  // modelConfiguration.supportedReasoningEfforts. The sets really do differ:
  // GPT-5.6 Sol -> none/low/medium/high/xhigh/max, Opus 5 -> low/medium/high/max,
  // Opus 4.7 -> high only, Haiku 4.5 -> [] (the effort picker hides itself).
  efforts?: string[]
  // Notion's own default effort for this model, used as a fallback when the
  // "strongest supported" rule cannot be applied.
  default_effort?: string
}

export interface ChatThread {
  id: string
  title: string
  created_at?: number
  updated_at?: number
  type?: string
  // The agent this thread belongs to, detected server-side from the thread's
  // workflow parent ("default" for the built-in assistant). Lets the UI
  // preselect the correct agent when an existing chat is opened.
  agent_id?: string
}

// A single visible reasoning/tool step of an assistant turn (mirrors the
// chatStep the Go backend extracts). For tool steps, `tool` is the friendly
// label (e.g. "GitHub / get_me"), `server` is the connector icon hint, and
// `input`/`result` are the pretty-printed request + response (shown on expand).
export interface ChatStep {
  kind: string // "thought" | "tool"
  text: string
  tool?: string
  server?: string
  input?: string
  result?: string
}

// One segment of an assistant turn: either a run of consecutive actions or a
// paragraph of answer text. A turn is the ordered ribbon of these blocks, so a
// log alternates action groups and paragraphs the way Notion does instead of
// showing one huge action list followed by every paragraph glued together.
export interface ChatBlock {
  kind: 'steps' | 'text'
  steps?: ChatStep[]
  text?: string
}

// One option the user can pick in an agent survey.
export interface ChatSurveyOption {
  id: string
  label: string
  pageId?: string
}

// One question of an agent survey («Уточню пару деталей…»). The user picks an
// option, or types a free-text answer when allowOther is set («свой вариант»).
export interface ChatSurveyQuestion {
  id: string
  prompt: string
  options: ChatSurveyOption[]
  allowOther?: boolean
  allowMultiple?: boolean
}

// An agent survey attached to an assistant message: a set of questions the
// user answers to continue the same turn (see chatSurvey).
export interface ChatSurvey {
  id: string
  questions: ChatSurveyQuestion[]
  createdAt?: string
  submitted?: boolean
  responses?: Record<string, unknown>
}

// A page the agent created or shared this turn, rendered as a clickable
// open-page card (the agent references it via <edit_reference> in its text).
export interface ChatPageRef {
  name: string
  url: string
}

// One rendered message of a thread's history.
export interface ChatHistoryMessage {
  role: 'user' | 'assistant'
  text: string
  steps?: ChatStep[]
  blocks?: ChatBlock[]
  survey?: ChatSurvey
  pages?: ChatPageRef[]
}

export interface ChatAccountRef {
  token_v2: string
  user_id?: string
  user_name?: string
  user_email?: string
  space_id: string
  space_view_id?: string
  space_name?: string
}

export async function chatAgents(ref: { token_v2: string; user_id?: string; space_id: string }): Promise<ChatAgent[]> {
  const resp = await fetch('/admin/chat/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(ref),
  })
  const data = await jsonOrError(resp)
  return Array.isArray(data?.agents) ? data.agents : []
}

// chatModels lists the models the built-in assistant can use in this space so
// the UI can offer a picker (e.g. "Opus 4.8").
export async function chatModels(ref: { token_v2: string; user_id?: string; space_id: string }): Promise<ChatModel[]> {
  const resp = await fetch('/admin/chat/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(ref),
  })
  const data = await jsonOrError(resp)
  return Array.isArray(data?.models) ? data.models : []
}

export async function chatThreads(ref: { token_v2: string; user_id?: string; space_id: string }): Promise<ChatThread[]> {
  const resp = await fetch('/admin/chat/threads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(ref),
  })
  const data = await jsonOrError(resp)
  return Array.isArray(data?.threads) ? data.threads : []
}

// chatDelete soft-deletes (archives) a chat thread for this account.
export async function chatDelete(ref: { token_v2: string; user_id?: string; space_id: string; thread_id: string }): Promise<void> {
  const resp = await fetch('/admin/chat/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(ref),
  })
  await jsonOrError(resp)
}

// chatHistory loads a single thread's full message history (user turns +
// assistant turns with their visible steps) so the UI can show it when the
// user clicks a chat instead of starting from a blank view.
export interface ChatHistoryResult {
  messages: ChatHistoryMessage[]
  // Agent detected server-side for this thread ("default" or a custom agent id).
  agent_id?: string
  // Model codename this thread was last run with, read server-side from the
  // thread's own steps (config.model / agent-inference.model), plus the
  // reasoning effort recorded with it. Lets the picker show what was used here.
  model?: string
  reasoning_effort?: string
}

export async function chatHistory(ref: { token_v2: string; user_id?: string; space_id: string; thread_id: string }): Promise<ChatHistoryResult> {
  const resp = await fetch('/admin/chat/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(ref),
  })
  const data = await jsonOrError(resp)
  return {
    messages: Array.isArray(data?.messages) ? data.messages : [],
    agent_id: typeof data?.agent_id === 'string' ? data.agent_id : undefined,
    model: typeof data?.model === 'string' && data.model ? data.model : undefined,
    reasoning_effort:
      typeof data?.reasoning_effort === 'string' && data.reasoning_effort ? data.reasoning_effort : undefined,
  }
}

export interface ChatSendResult {
  thread_id: string
  title?: string
  text: string
  steps?: ChatStep[]
  blocks?: ChatBlock[]
  survey?: ChatSurvey
  pages?: ChatPageRef[]
}

// Live status emitted while the agent is working. `kind` distinguishes
// thought / tool / text events; tool events also carry the friendly label,
// connector hint and (when available) the pretty-printed input + result so the
// live tree can render the same rows as the finished message.
export interface ChatStatus {
  label: string
  detail: string
  kind?: string
  tool?: string
  server?: string
  input?: string
  result?: string
}

export type ChatSendParams = ChatAccountRef & {
  timezone?: string
  agent: string // "default" or a workflowId
  model?: string // codename, only honoured for the built-in assistant
  reasoning_effort?: string // thinking budget, validated against the model's own set
  context_page_id?: string
  thread_id?: string
  message: string
  // Thread id minted by an earlier attachment upload. A brand-new chat has no
  // thread yet, so the file is bound to a client-side id that the very first
  // message has to reuse - otherwise the file and the text end up apart.
  pending_thread_id?: string
  // Files already uploaded with chatUpload. The server replays them as
  // "computer-file" transcript steps right in front of the text.
  attachments?: ChatAttachment[]
}

// Extra stream callbacks. The proxy emits two rows besides plain status/done,
// both of which exist because a turn can now grow while it runs.
export interface ChatStreamMeta {
  // Thread this turn runs in, emitted before the first answer byte. A brand-new
  // chat learns its server-minted id here, which is what makes it possible to
  // queue a message into the very first turn.
  onThread?: (threadId: string) => void
  // A message the user sent while the agent was working got appended to the
  // running transcript: the answer streamed so far is final, and what follows
  // is a NEW answer to that message.
  onUserMessage?: (text: string, queued: boolean) => void
}

export type ChatQueueParams = ChatAccountRef & {
  timezone?: string
  agent: string
  thread_id: string
  message: string
  attachments?: ChatAttachment[]
}

export interface ChatQueueResult {
  queued: boolean
  step_id?: string
  message_ids?: string[]
  error?: string
}

// chatQueue appends a message to a thread whose turn is STILL RUNNING
// (Notion's queueAgentChatMessage). The agent picks it up inside the inference
// that is already in flight, so nothing waits for the current answer to end.
// queued:false means Notion refused it (typically the turn finished a moment
// ago) and the caller should fall back to a normal chatStream turn.
export async function chatQueue(params: ChatQueueParams): Promise<ChatQueueResult> {
  const resp = await fetch('/admin/chat/queue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(params),
  })
  const data = (await resp.json().catch(() => null)) as ChatQueueResult | null
  if (!resp.ok || !data || !data.queued) {
    return { queued: false, error: (data && data.error) || `HTTP ${resp.status}` }
  }
  return data
}

export async function chatSend(params: ChatSendParams): Promise<ChatSendResult> {
  const resp = await fetch('/admin/chat/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(params),
  })
  return jsonOrError(resp) as Promise<ChatSendResult>
}

// chatStream runs one chat turn and streams live agent status. The server
// emits newline-delimited JSON events: {event:"status",…} while the agent
// works, then a final {event:"done",…} with the full answer. onStatus is
// called for every status event so the UI can show what the agent is doing
// right now.
export async function chatStream(params: ChatSendParams, onStatus: (s: ChatStatus) => void, meta?: ChatStreamMeta): Promise<ChatSendResult> {
  const resp = await fetch('/admin/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    credentials: 'same-origin',
    body: JSON.stringify(params),
  })
  if (!resp.ok || !resp.body) {
    // Fall back to the synchronous endpoint if streaming is unavailable.
    return chatSend(params)
  }
  return readChatNdjson(resp, onStatus, meta)
}

// readChatNdjson consumes the server's newline-delimited JSON event stream,
// shared by chatStream + chatSurvey: {event:"status"} rows drive the live
// agent step tree, the final {event:"done"} carries the answer plus any
// follow-up survey and the pages the agent created/shared this turn.
// One file already stored in Notion's bucket, ready to ride along with the
// next message. Mirrors the Go chatAttachment struct.
export interface ChatAttachment {
  file_url: string
  file_name: string
  content_type: string
  file_size: number
}

export interface ChatUploadResult {
  thread_id: string
  attachment: ChatAttachment
}

// chatUpload pushes one file through the proxy into Notion's S3 bucket
// (getUploadFileUrlForAssistantChatTranscriptUpload + presigned POST) and
// returns the attachment descriptor plus the thread the file was bound to.
// XMLHttpRequest is used instead of fetch purely for upload.onprogress, which
// drives the composer's progress animation.
export function chatUpload(
  file: File,
  ref: ChatAccountRef & { thread_id?: string },
  onProgress?: (ratio: number) => void,
): Promise<ChatUploadResult> {
  return new Promise<ChatUploadResult>((resolve, reject) => {
    const form = new FormData()
    form.append('token_v2', ref.token_v2)
    form.append('user_id', ref.user_id || '')
    form.append('space_id', ref.space_id)
    form.append('thread_id', ref.thread_id || '')
    form.append('file', file, file.name)
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/admin/chat/upload')
    xhr.withCredentials = true
    xhr.upload.onprogress = (e: ProgressEvent) => {
      if (onProgress && e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total)
    }
    xhr.onload = () => {
      let data: { error?: string; thread_id?: string; attachment?: ChatAttachment } | null = null
      try {
        data = JSON.parse(xhr.responseText)
      } catch {
        /* server returned a non-JSON error page */
      }
      if (xhr.status >= 200 && xhr.status < 300 && data && data.attachment) {
        if (onProgress) onProgress(1)
        resolve({ thread_id: data.thread_id || '', attachment: data.attachment })
        return
      }
      reject(new Error((data && data.error) || `HTTP ${xhr.status}`))
    }
    xhr.onerror = () => reject(new Error('Не удалось загрузить файл'))
    xhr.onabort = () => reject(new Error('Не удалось загрузить файл'))
    xhr.send(form)
  })
}

export type ChatEditParams = ChatSendParams & { thread_id: string; message_id?: string }

// chatEdit rewrites the last user message of a thread and re-runs the agent on
// it. The server drops the old answer first (listRemove) and streams the new
// one back as the very same ndjson protocol chatStream uses.
export async function chatEdit(params: ChatEditParams, onStatus: (s: ChatStatus) => void, meta?: ChatStreamMeta): Promise<ChatSendResult> {
  const resp = await fetch('/admin/chat/edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    credentials: 'same-origin',
    body: JSON.stringify(params),
  })
  if (!resp.ok || !resp.body) {
    const data = await resp.json().catch(() => null)
    throw new Error((data && data.error) || `HTTP ${resp.status}`)
  }
  return readChatNdjson(resp, onStatus, meta)
}

async function readChatNdjson(resp: Response, onStatus: (s: ChatStatus) => void, meta?: ChatStreamMeta): Promise<ChatSendResult> {
  if (!resp.body) throw new Error('Пустой ответ от сервера')
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result: ChatSendResult | null = null
  let streamError = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (value) buffer += decoder.decode(value, { stream: true })
    let nl = buffer.indexOf('\n')
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line) {
        try {
          const ev = JSON.parse(line)
          if (ev.event === 'status') {
            onStatus({
              label: ev.label || '',
              detail: ev.detail || '',
              kind: ev.kind || '',
              tool: ev.tool || '',
              server: ev.server || '',
              input: ev.input || '',
              result: ev.result || '',
            })
          } else if (ev.event === 'thread') {
            if (meta?.onThread && ev.thread_id) meta.onThread(ev.thread_id as string)
          } else if (ev.event === 'user') {
            // Sent while the agent was working: everything typed out so far is
            // the answer to the PREVIOUS message, what follows is a new answer.
            if (meta?.onUserMessage) meta.onUserMessage((ev.text as string) || '', !!ev.queued)
          } else if (ev.event === 'done') {
            result = { thread_id: ev.thread_id, title: ev.title, text: ev.text, steps: ev.steps, blocks: ev.blocks || undefined, survey: ev.survey || undefined, pages: ev.pages || undefined }
          } else if (ev.event === 'error') {
            streamError = ev.error || 'Ошибка потока'
          }
        } catch { /* ignore malformed line */ }
      }
      nl = buffer.indexOf('\n')
    }
    if (done) break
  }
  if (streamError && !result) throw new Error(streamError)
  if (!result) throw new Error('Пустой ответ от сервера')
  return result
}

// One answer to a survey question: the chosen option label, plus a free-text
// value when the user picked «свой вариант» (allowOther).
export interface ChatSurveyAnswer {
  qid: string
  prompt: string
  label: string
  value?: unknown
}

export type ChatSurveyParams = ChatAccountRef & {
  timezone?: string
  agent: string
  model?: string
  reasoning_effort?: string
  thread_id: string
  survey_step_id: string
  questions?: ChatSurveyQuestion[]
  created_at?: string
  answers: ChatSurveyAnswer[]
}

// chatSurvey submits the user's answers to an agent survey and continues the
// same turn, streaming the agent's reply exactly like chatStream.
export async function chatSurvey(params: ChatSurveyParams, onStatus: (s: ChatStatus) => void, meta?: ChatStreamMeta): Promise<ChatSendResult> {
  const resp = await fetch('/admin/chat/survey', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    credentials: 'same-origin',
    body: JSON.stringify(params),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    let msg = `HTTP ${resp.status}`
    if (text) { try { const d = JSON.parse(text); if (d?.error) msg = d.error } catch { /* ignore */ } }
    throw new Error(msg)
  }
  return readChatNdjson(resp, onStatus, meta)
}
