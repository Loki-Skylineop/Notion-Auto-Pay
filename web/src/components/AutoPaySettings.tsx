import { useState, useEffect, useRef } from 'react'
import { PLANS, STRIPE_KEY } from './SubscribeModal'
import { loadAutoPayConfig, saveAutoPayConfig, type AutoPayConfig } from '../autopay'

declare global {
  interface Window {
    Stripe?: (key: string) => any
  }
}

// Settings modal for unattended auto-pay. The user enters a card once; we
// tokenize it with Stripe into a PaymentMethod (pm_...) and store the id plus
// the chosen plan/country. The WorkspacePool refresh loop reuses that pm to pay
// free workspaces. NOTE: a single saved card reliably covers one workspace —
// Stripe rejects reusing the same PaymentMethod across different customers, so
// multi-workspace auto-pay is best-effort and surfaces per-space errors.
export function AutoPaySettings({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [cfg, setCfg] = useState<AutoPayConfig>(() => loadAutoPayConfig())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [stripeLoaded, setStripeLoaded] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const stripeRef = useRef<any>(null)
  const cardElementRef = useRef<any>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  useEffect(() => {
    if (window.Stripe) { initCard(); return }
    const script = document.createElement('script')
    script.src = 'https://js.stripe.com/v3/'
    script.onload = () => initCard()
    document.head.appendChild(script)
  }, [])

  function initCard() {
    if (!window.Stripe || !cardRef.current) return
    const stripe = stripeRef.current || window.Stripe(STRIPE_KEY)
    stripeRef.current = stripe
    const elements = stripe.elements({ locale: 'ru' })
    const card = elements.create('card', {
      style: {
        base: { color: '#ededed', fontSize: '13px', fontFamily: 'system-ui, sans-serif', '::placeholder': { color: '#707070' } },
        invalid: { color: '#ff5c5c' }
      }
    })
    card.mount(cardRef.current)
    cardElementRef.current = card
    setStripeLoaded(true)
  }

  const update = (patch: Partial<AutoPayConfig>) => {
    setCfg(prev => {
      const next = { ...prev, ...patch }
      saveAutoPayConfig(next)
      return next
    })
  }

  const handleSaveCard = async () => {
    const stripe = stripeRef.current
    if (!stripe || !cardElementRef.current) {
      setError('Stripe.js ещё не загрузился, подождите секунду')
      return
    }
    setLoading(true)
    setError('')
    setSaved(false)
    try {
      const { paymentMethod, error: pmError } = await stripe.createPaymentMethod({
        type: 'card',
        card: cardElementRef.current,
        billing_details: { address: { country: cfg.country } }
      })
      if (pmError) {
        setError('Ошибка карты: ' + pmError.message)
        setLoading(false)
        return
      }
      const card = paymentMethod.card || {}
      update({
        pmId: paymentMethod.id,
        brand: card.brand || 'card',
        last4: card.last4 || '••••',
        savedAt: Date.now(),
      })
      setSaved(true)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения карты')
    } finally {
      setLoading(false)
    }
  }

  const removeCard = () => {
    update({ pmId: '', brand: '', last4: '', savedAt: 0 })
    setSaved(false)
  }

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-lg bg-bg-card border border-border rounded-2xl shadow-modal p-6 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[18px] font-semibold tracking-tight text-text-primary">Автооплата · карта и план</h2>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-full text-text-muted hover:text-text-primary hover:bg-bg-secondary bg-transparent border-none cursor-pointer text-lg leading-none">×</button>
        </div>

        <div className="text-[13px] text-text-secondary mb-4">
          <p>Карта вводится один раз и сохраняется как токен Stripe (сам номер карты не хранится). При включённой автооплате Free‑пространства с галочкой «Авто» будут оплачиваться на выбранный план.</p>
        </div>

        <label className="text-[11px] text-text-muted mb-1 block">План для автооплаты</label>
        <div className="grid grid-cols-2 gap-2 mb-3">
          {PLANS.map(p => (
            <button
              key={p.id}
              type="button"
              onClick={() => update({ plan: p.id })}
              className={`p-2.5 rounded-lg border text-left cursor-pointer transition-all ${
                cfg.plan === p.id
                  ? 'border-text-primary bg-white/5'
                  : 'border-border bg-bg-card hover:border-hairline-strong'
              }`}
            >
              <div className="text-[12px] font-semibold text-text-primary">{p.name}</div>
              <div className="text-[11px] text-text-secondary">{p.price}<span className="text-text-muted">{p.interval}</span></div>
            </button>
          ))}
        </div>

        <label className="text-[11px] text-text-muted mb-1 block">Страна</label>
        <select
          value={cfg.country}
          onChange={e => update({ country: e.target.value })}
          className="w-full py-2 px-3 bg-bg-input border border-border rounded-lg text-[13px] text-text-primary outline-none focus:border-notion-blue transition-all mb-3"
        >
          <option value="DE">DE (Germany)</option>
          <option value="US">US (United States)</option>
          <option value="GB">GB (United Kingdom)</option>
          <option value="KR">KR (South Korea)</option>
          <option value="CN">CN (China)</option>
          <option value="RU">RU (Russia)</option>
        </select>

        <label className="text-[11px] text-text-muted mb-1 block">Данные карты</label>
        <div ref={cardRef} className="py-2.5 px-3 bg-bg-input border border-border rounded-lg min-h-[40px] mb-2" />

        {cfg.pmId && (
          <div className="flex items-center justify-between mb-3 px-3 py-2 bg-ok/10 border border-ok/30 rounded-lg">
            <span className="text-[12px] text-ok">Сохранённая карта: {cfg.brand} •••• {cfg.last4}</span>
            <button onClick={removeCard} className="text-[11px] text-err hover:text-err/70 bg-transparent border-none cursor-pointer">Удалить</button>
          </div>
        )}

        {error && <div className="text-err text-[12px] mb-2 px-1">{error}</div>}
        {saved && <div className="text-ok text-[12px] mb-2 px-1">Карта сохранена</div>}

        <div className="text-[10px] text-text-muted mb-3 leading-relaxed">
          Внимание: при автооплате списываются реальные деньги. Одна сохранённая карта надёжно работает для одного пространства; для остальных Stripe может потребовать повторный ввод карты.
        </div>

        <div className="flex gap-2.5">
          <button type="button" onClick={onClose}
            className="flex-1 h-11 bg-bg-card hover:bg-bg-secondary text-text-primary rounded-full text-[14px] font-medium cursor-pointer transition-colors border border-border">
            Закрыть
          </button>
          <button type="button" onClick={handleSaveCard} disabled={loading || !stripeLoaded}
            className="flex-1 h-11 bg-white hover:bg-white/90 text-black rounded-full text-[14px] font-medium cursor-pointer transition-colors border-none disabled:opacity-40 disabled:cursor-not-allowed">
            {loading ? 'Сохранение...' : (cfg.pmId ? 'Заменить карту' : 'Сохранить карту')}
          </button>
        </div>
      </div>
    </div>
  )
}
