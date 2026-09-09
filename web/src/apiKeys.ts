export interface ApiRoutingConfig {
  mode: 'auto' | 'pinned'
  email: string
  space_id: string
  space_name: string
  space_view_id: string
  pin_resolved: boolean
  effective: string
  effective_email: string
  warning?: string
}

export interface ApiConfig {
  api_key: string
  api_key_preview: string
  base_path: string
  model_alias: string
  default_model: string
  models: string[]
  routing: ApiRoutingConfig
}

export interface ApiConfigUpdate {
  rotate_key?: boolean
  api_key?: string
  default_model?: string
  api_routing?: 'auto' | 'pinned'
  api_account?: string
  api_space?: string
  api_space_name?: string
  api_space_view_id?: string
}

async function readApiConfig(resp: Response): Promise<ApiConfig> {
  const text = await resp.text()
  let data: unknown
  try {
    data = text ? JSON.parse(text) : null
  }
  catch {
    throw new Error(`Некорректный ответ сервера (HTTP ${resp.status})`)
  }
  if (!resp.ok) {
    const message = data && typeof data === 'object' && 'error' in data
      ? String((data as { error?: unknown }).error || `HTTP ${resp.status}`)
      : `HTTP ${resp.status}`
    throw new Error(message)
  }
  return data as ApiConfig
}

export async function fetchApiConfig(): Promise<ApiConfig> {
  const resp = await fetch('/admin/api/config', {
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
  })
  return readApiConfig(resp)
}

export async function updateApiConfig(update: ApiConfigUpdate): Promise<ApiConfig> {
  const resp = await fetch('/admin/api/config', {
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(update),
  })
  return readApiConfig(resp)
}