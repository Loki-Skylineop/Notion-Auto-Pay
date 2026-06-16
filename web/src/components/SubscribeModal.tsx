import { useState, useEffect, useRef } from 'react'
import { fetchAutoPayConfig, paySpaceWithSavedCard } from '../autopay'

declare global {
  interface Window {
    Stripe?: (key: string) => any
  }
}

export const STRIPE_KEY = 'pk_live_vuNO27XGTCbXjVwneiECILjT'

export interface PlanOption {
  id: string
  name: string
  price: string
  interval: string
}

export const PLANS: PlanOption[] = [
  { id: 'enterprise_monthly_eur_202505', name: 'Enterprise', price: '31.50 EUR', interval: '/мес' },
  { id: 'enterprise_yearly_eur_202505', name: 'Enterprise', price: '306 EUR', interval: '/год' },
  { id: 'business_monthly_eur_202505', name: 'Business', price: '23.50 EUR', interval: '/мес' },
  { id: 'business_yearly_eur_202505', name: 'Business', price: '234 EUR', interval: '/год' },
]

export function SubscribeModal({
  onClose,
  onSuccess,
  initialToken,
  spaceId,
  workspaceName,
}: {
  onClose: () => void
  onSuccess: () => void
  initialToken?: string
  spaceId?: string
  workspaceName?: string
}) {
  const [token, setToken] = useState(initialToken || '')
  const [plan, setPlan] = useState(PLANS[0].id)
  const [country, setCountry] = useState('DE')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const [stripeLoaded, setStripeLoaded] = useState(false)
  // Saved card (from the server-side auto-pay config / last payment). When
  // present and we're paying a specific workspace, we offer a one-click
  // "оплатить сохранённой картой" path that charges on the server without
  // re-typing the card.
  const [savedLast4, setSavedLast4] = useState('')
  const [savedLoading, setSavedLoading] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  // IMPORTANT: a single Stripe instance must be shared between the Card Element
  // and createPaymentMethod. Creating a second window.Stripe(...) for the
  // payment call triggers: "Please use the same instance of Stripe you used to
  // create this Element to create your Source or Token." So we cache it here.
  const stripeRef = useRef<any>(null)
  const elementsRef = useRef<any>(null)
  const cardElementRef = useRef<any>(null)
  const tokenRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { if (!initialToken) tokenRef.current?.focus() }, [initialToken])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // Load the server-saved card so we can show "···· 1234" and offer to pay with
  // it. Best-effort — if it fails we just hide the saved-card block.
  useEffect(() => {
    let cancelled = false
    fetchAutoPayConfig()
      .then(c => { if (!cancelled && c.has_card) setSavedLast4(c.card_last4 || '••••') })
      .catch(() => { /* ignore */ })
    return () => { cancelled = true }
  }, [])

  // Load Stripe.js and mount card element
  useEffect(() => {
    if (window.Stripe) {
      initStripeCard()
      return
    }
    const script = document.createElement('script')
    script.src = 'https://js.stripe.com/v3/'
    script.onload = () => initStripeCard()
    document.head.appendChild(script)
  }, [])

  function initStripeCard() {
    if (!window.Stripe || !cardRef.current) return
    // Reuse the cached instance if Stripe.js fires more than once.
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
    elementsRef.current = elements
    cardElementRef.current = card
    setStripeLoaded(true)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmedToken = token.trim()
    if (!trimmedToken) return
    const stripe = stripeRef.current
    if (!stripe || !cardElementRef.current) {
      setError('Stripe.js ещё не загрузился, подождите секунду и повторите')
      return
    }

    setLoading(true)
    setError('')
    setResult(null)

    try {
      // Use the SAME Stripe instance that created the Card Element.
      const { paymentMethod, error: pmError } = await stripe.createPaymentMethod({
        type: 'card',
        card: cardElementRef.current,
        billing_details: { address: { country } }
      })

      if (pmError) {
        setError('Ошибка карты: ' + pmError.message)
        setLoading(false)
        return
      }

      const resp = await fetch('/admin/subscribe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          token_v2: trimmedToken,
          payment_method_id: paymentMethod.id,
          plan,
          country: country || 'DE',
          space_id: spaceId || '',
        }),
      })
      const text = await resp.text()
      let data: { error?: string; email?: string; plan?: string } = {}
      try { data = text ? JSON.parse(text) : {} } catch { data = {} }

      if (!resp.ok || data.error) {
        setError(data.error || `HTTP ${resp.status}`)
      } else {
        setResult(`Подписка ${data.plan || ''} активирована${data.email ? ' для ' + data.email : ''}`)
        setTimeout(() => { onSuccess(); onClose() }, 2000)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка запроса')
    } finally {
      setLoading(false)
    }
  }

  // One-click pay with the card already saved on the server. Only available
  // when we're paying a specific workspace (we need its space_id) and a card
  // is saved. The server re-tokenizes the saved card for this space.
  const handlePaySaved = async () => {
    if (!spaceId) return
    const trimmedToken = token.trim()
    if (!trimmedToken) { setError('token_v2 пуст') ; return }
    setSavedLoading(true)
    setError('')
    setResult(null)
    try {
      const r = await paySpaceWithSavedCard({ token_v2: trimmedToken, space_id: spaceId, plan, country: country || 'DE' })
      if (r.error) {
        setError(r.error)
      } else {
        setResult(`Подписка ${r.plan || plan} активирована${r.email ? ' для ' + r.email : ''}`)
        setTimeout(() => { onSuccess(); onClose() }, 2000)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка запроса')
    } finally {
      setSavedLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-lg bg-bg-card border border-border rounded-2xl shadow-modal p-6 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[18px] font-semibold tracking-tight text-text-primary">{workspaceName ? `Оплатить · ${workspaceName}` : 'Оплатить подписку Notion'}</h2>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-full text-text-muted hover:text-text-primary hover:bg-bg-secondary bg-transparent border-none cursor-pointer text-lg leading-none">×</button>
        </div>

        <div className="text-[13px] text-text-secondary mb-4">
          {workspaceName
            ? <p>Оформление подписки для пространства <span className="text-text-primary font-medium">{workspaceName}</span>. Выберите план и введите данные карты.</p>
            : <p>Вставьте <code className="font-mono bg-bg-secondary px-1.5 py-0.5 rounded text-[12px] text-text-primary">token_v2</code>, выберите план и введите данные карты.</p>}
        </div>

        <form onSubmit={handleSubmit}>
          {!initialToken && (
            <>
              <label className="text-[11px] text-text-muted mb-1 block">Token v2</label>
              <textarea
                ref={tokenRef}
                value={token}
                onChange={e => setToken(e.target.value)}
                placeholder="v03%3AeyJhbGciOi..."
                rows={2}
                className="w-full py-2 px-3 bg-bg-input border border-border rounded-lg text-[13px] text-text-primary outline-none focus:border-notion-blue focus:ring-2 focus:ring-notion-blue/20 transition-all placeholder:text-text-muted resize-none font-mono mb-3"
              />
            </>
          )}

          <label className="text-[11px] text-text-muted mb-1 block">План</label>
          <div className="grid grid-cols-2 gap-2 mb-3">
            {PLANS.map(p => (
              <button
                key={p.id}
                type="button"
                onClick={() => setPlan(p.id)}
                className={`p-2.5 rounded-lg border text-left cursor-pointer transition-all ${
                  plan === p.id
                    ? 'border-text-primary bg-white/5'
                    : 'border-border bg-bg-card hover:border-hairline-strong'
                }`}
              >
                <div className="text-[12px] font-semibold text-text-primary">{p.name}</div>
                <div className="text-[11px] text-text-secondary">{p.price}<span className="text-text-muted">{p.interval}</span></div>
              </button>
            ))}
          </div>

          <label className="text-[11px] text-text-muted mb-1 block">Данные карты</label>
          <div ref={cardRef} className="py-2.5 px-3 bg-bg-input border border-border rounded-lg min-h-[40px] mb-3" />

          {spaceId && savedLast4 && (
            <div className="mb-3 p-3 bg-bg-secondary border border-border rounded-lg">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[11px] text-text-muted mb-0.5">Сохранённая карта</div>
                  <div className="text-[13px] text-text-primary font-medium">···· {savedLast4}</div>
                </div>
                <button
                  type="button"
                  onClick={handlePaySaved}
                  disabled={savedLoading || loading || !!result || !token.trim()}
                  className="shrink-0 px-3 h-9 bg-white hover:bg-white/90 text-black rounded-full text-[12px] font-medium cursor-pointer border-none disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {savedLoading ? 'Оплата...' : 'Оплатить сохранённой'}
                </button>
              </div>
              <div className="text-[10px] text-text-muted mt-1.5">Оплата на сервере выбранным планом — новую карту вводить не нужно.</div>
            </div>
          )}

          <label className="text-[11px] text-text-muted mb-1 block">Страна</label>
          <select
            value={country}
            onChange={e => setCountry(e.target.value)}
            className="w-full py-2 px-3 bg-bg-input border border-border rounded-lg text-[13px] text-text-primary outline-none focus:border-notion-blue transition-all mb-3"
          >
            <option value="DE">DE (Germany)</option>
            <option value="US">US (United States)</option>
            <option value="GB">GB (United Kingdom)</option>
            <option value="KR">KR (South Korea)</option>
            <option value="CN">CN (China)</option>
            <option value="RU">RU (Russia)</option>
          </select>

          {error && <div className="text-err text-[12px] mb-2 px-1">{error}</div>}
          {result && (
            <div className="mb-2 p-3 bg-ok/10 border border-ok/30 rounded-lg text-[12px]">
              <div className="text-ok font-medium">{result}</div>
            </div>
          )}

          <div className="flex gap-2.5 mt-2">
            <button type="button" onClick={onClose}
              className="flex-1 h-11 bg-bg-card hover:bg-bg-secondary text-text-primary rounded-full text-[14px] font-medium cursor-pointer transition-colors border border-border">
              Отмена
            </button>
            <button type="submit" disabled={loading || savedLoading || !token.trim() || !stripeLoaded || !!result}
              className="flex-1 h-11 bg-white hover:bg-white/90 text-black rounded-full text-[14px] font-medium cursor-pointer transition-colors border-none disabled:opacity-40 disabled:cursor-not-allowed">
              {loading ? 'Обработка...' : 'Оплатить новой картой'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
