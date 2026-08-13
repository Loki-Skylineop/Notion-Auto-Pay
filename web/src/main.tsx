import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'

// ErrorBoundary ловит только падения рендера. Ошибки из промисов, таймеров и
// обработчиков событий раньше уходили в никуда, поэтому логируем их отдельно с
// явной пометкой — иначе причину чёрного экрана в консоли не найти.
window.addEventListener('error', (e) => {
  console.error('[global error]', e.message, `${e.filename}:${e.lineno}:${e.colno}`, e.error)
})
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandled rejection]', e.reason)
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
