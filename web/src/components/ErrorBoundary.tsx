import { Component, type ErrorInfo, type ReactNode } from 'react'

// Кэши, которые имеет смысл снести, если интерфейс падает из-за мусора в
// localStorage (например, из-за старого формата списка аккаунтов).
const CACHE_KEYS = ['nmp_discovered_workspaces', 'nmp_chat_hist_cache']

/**
 * Без этой обёртки любое исключение в рендере размонтирует весь корень React:
 * DOM вычищается, и вместо интерфейса остаётся пустой чёрный экран без единого
 * намёка на причину. Здесь мы ошибку перехватываем, показываем её текст и стек
 * и даём два выхода — перезагрузить страницу или сбросить локальный кэш.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null; stack: string }
> {
  state: { error: Error | null; stack: string } = { error: null, stack: '' }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Дублируем в консоль: так ошибка видна, даже если разметка ниже сломается.
    console.error('[ui crash]', error, info.componentStack)
    this.setState({ stack: info.componentStack || '' })
  }

  private reload = () => { window.location.reload() }

  private resetCache = () => {
    try {
      for (const k of CACHE_KEYS) localStorage.removeItem(k)
    } catch { /* приватный режим — просто перезагружаемся */ }
    window.location.reload()
  }

  render() {
    const { error, stack } = this.state
    if (!error) return this.props.children
    return (
      <div className="min-h-screen bg-[#040404] p-6 flex items-start justify-center">
        <div className="w-full max-w-2xl rounded-xl border border-red-500/30 bg-red-500/[0.04] p-5">
          <div className="text-[15px] font-semibold text-red-400 mb-1">Интерфейс упал</div>
          <p className="text-[12px] text-text-secondary mb-4">
            Ошибка при отрисовке. Раньше на этом месте был просто чёрный экран — теперь видно, что именно сломалось (то же самое есть в консоли по F12).
          </p>
          <div className="text-[12px] font-mono text-red-300 break-words mb-3">
            {error.name}: {error.message}
          </div>
          <pre className="max-h-64 overflow-auto text-[11px] leading-relaxed text-text-muted whitespace-pre-wrap mb-4">
            {(error.stack || '') + (stack ? '\n--- component stack ---' + stack : '')}
          </pre>
          <div className="flex gap-2">
            <button
              onClick={this.reload}
              className="px-3 py-1.5 rounded-lg bg-white text-black text-[12px] font-medium border-none cursor-pointer"
            >
              Перезагрузить
            </button>
            <button
              onClick={this.resetCache}
              className="px-3 py-1.5 rounded-lg bg-white/[0.06] text-text-primary text-[12px] border border-white/[0.12] cursor-pointer"
            >
              Сбросить кэш и перезагрузить
            </button>
          </div>
        </div>
      </div>
    )
  }
}
