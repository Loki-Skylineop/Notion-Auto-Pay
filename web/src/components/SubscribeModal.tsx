import { useState, useEffect, useRef } from 'react'
import { fetchAutoPayConfig, paySpaceWithSavedCard } from '../autopay'
import { fetchTrialDefaults, startTrial } from '../api'
import type { TrialMethod } from '../api'

declare global {
  interface Window {
    Stripe?: (key: string) => any
  }
}

export const STRIPE_KEY = 'pk_live_vuNO27XGTCbXjVwneiECILjT'

// Stripe.js с живым ключом (pk_live_) работает только по HTTPS; единственное
// исключение — localhost. На http://192.168.x.x он бросает IntegrationError прямо
// из window.Stripe(...), а до появления границы ошибок это гасило всю панель
// чёрным экраном. Проверяем окружение заранее.
export function stripeEnvOk(): boolean {
  if (typeof window === 'undefined') return false
  if (window.location.protocol === 'https:') return true
  const h = window.location.hostname
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]'
}

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

// Способы оплаты в модалке «Оплатить»: обычная карта и бесплатный триал,
// восстановленный из HAR-записи веб-клиента Notion (updateSubscription с
// trialData и trialEnd вместо paymentMethodId).
export type PayMethod = 'card' | 'trial'

// Длительность триала. В захваченной сессии Notion просил ровно 14 дней
// (custom_agents_business_reverse_14d), остальные значения — на пробу.
export const TRIAL_DAYS = [7, 14, 30]

// План, который улетал из веб-клиента вместе с триалом.
export const TRIAL_DEFAULT_PLAN = 'business_monthly_eur_202505'

const SCRIPT_TRIAL_PLAN = 'business_monthly_usd_202505'
export const SCRIPT_TRIAL_PLANS: PlanOption[] = [
  { id: SCRIPT_TRIAL_PLAN, name: 'Business · 14 дней', price: '24 USD', interval: '/мес после триала' },
]
export const TRIAL_PRESETS: { id: TrialMethod; title: string; description: string }[] = [
  { id: 'sidebar', title: 'Способ 1 · Без карты', description: 'Прежний вариант: карта не передаётся.' },
  { id: 'script33', title: 'Способ 2 · notion_trial (2)', description: 'Без выбранного пространства — самое новое Free.' },
  { id: 'script33_v2', title: 'Способ 3 · notion_trial_14_v2', description: 'Без выбранного пространства — самое новое. Платное не изменяется.' },
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
  const [plan, setPlan] = useState(stripeEnvOk() ? PLANS[0].id : TRIAL_DEFAULT_PLAN)
  const [country, setCountry] = useState('DE')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const [stripeLoaded, setStripeLoaded] = useState(false)
  // Новая карта вводится только по HTTPS или с localhost. В остальных
  // случаях показываем причину и оставляем рабочими триал и оплату
  // сохранённой картой (она считается на сервере и Stripe.js не требует).
  const cardOk = stripeEnvOk()
  const [stripeError, setStripeError] = useState(
    cardOk
      ? ''
      : 'Живой ключ Stripe требует HTTPS, а панель открыта по HTTP. Откройте её на http://localhost:8081/dashboard/ или по HTTPS — тогда появится поле карты. Триал и оплата сохранённой картой работают и здесь.',
  )
  // Saved card (from the server-side auto-pay config / last payment). When
  // present and we're paying a specific workspace, we offer a one-click
  // "оплатить сохранённой картой" path that charges on the server without
  // re-typing the card.
  const [savedLast4, setSavedLast4] = useState('')
  const [savedLoading, setSavedLoading] = useState(false)
  // Метод оплаты: карта через Stripe или триал вообще без карты.
  const [method, setMethod] = useState<PayMethod>(cardOk ? 'card' : 'trial')
  const [trialDays, setTrialDays] = useState(14)
  const [trialCaptcha, setTrialCaptcha] = useState('')
  const [trialLoading, setTrialLoading] = useState(false)
  const [trialMethod, setTrialMethod] = useState<TrialMethod>('sidebar')
  const [trialPaymentID, setTrialPaymentID] = useState('')
  const [trialCountry, setTrialCountry] = useState('')
  const [trialRenewalConfirmed, setTrialRenewalConfirmed] = useState(false)
  const trialDefaultsEdited = useRef({ payment: false, country: false })
  useEffect(() => {
    let active = true
    fetchTrialDefaults().then(defaults => {
      if (!active) return
      if (!trialDefaultsEdited.current.payment && defaults.payment_method_id) setTrialPaymentID(defaults.payment_method_id)
      if (!trialDefaultsEdited.current.country && defaults.country) setTrialCountry(defaults.country)
    }).catch(() => { /* Defaults are optional; manual entry remains available. */ })
    return () => { active = false }
  }, [])
  const trialNeedsPayment = trialMethod !== 'sidebar'
  const trialPaymentValid = /^pm_[A-Za-z0-9]{1,128}$/.test(trialPaymentID.trim())
  const trialCountryValid = /^[A-Z]{2}$/.test(trialCountry)
  const requestedTrialDays = trialNeedsPayment ? 14 : trialDays
  const busy = loading || savedLoading || trialLoading
  const trialInFlight = useRef(false)
  const cardRef = useRef<HTMLDivElement>(null)
  // IMPORTANT: a single Stripe instance must be shared between the Card Element
  // and createPaymentMethod. Creating a second window.Stripe(...) for the
  // payment call triggers: "Please use the same instance of Stripe you used to
  // create this Element to create your Source or Token." So we cache it here.
  const stripeRef = useRef<any>(null)
  const elementsRef = useRef<any>(null)
  const cardElementRef = useRef<any>(null)
  const tokenRef = useRef<HTMLTextAreaElement>(null)

  function selectTrialPreset(next: TrialMethod) {
    if (busy || result) return
    setTrialMethod(next)
    setPlan(next === 'sidebar' ? TRIAL_DEFAULT_PLAN : SCRIPT_TRIAL_PLAN)
    setTrialDays(14)
    setTrialRenewalConfirmed(false)
    setError('')
  }

  useEffect(() => { if (!initialToken) tokenRef.current?.focus() }, [initialToken])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, busy])

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
    // По HTTP с живым ключом Stripe.js грузить бессмысленно: любой вызов
    // window.Stripe(...) закончится IntegrationError.
    if (!cardOk) return
    if (window.Stripe) {
      initStripeCard()
      return
    }
    const script = document.createElement('script')
    script.src = 'https://js.stripe.com/v3/'
    script.onload = () => initStripeCard()
    script.onerror = () => setStripeError('Не удалось загрузить Stripe.js — проверьте интернет и блокировщики.')
    document.head.appendChild(script)
  }, [cardOk])

  // Любая ошибка Stripe обязана оставаться внутри модалки: исключение из
  // эффекта ловит граница ошибок и сносит всё дерево — раньше это был
  // тот самый чёрный экран после открытия окна оплаты.
  function initStripeCard() {
    if (!window.Stripe || !cardRef.current) return
    try {
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
    setStripeError('')
    } catch (err) {
      stripeRef.current = null
      cardElementRef.current = null
      setStripeLoaded(false)
      setStripeError(err instanceof Error ? err.message : 'Stripe.js не инициализировался')
      console.error('[stripe init]', err)
    }
  }

  // Each preset is submitted once by the UI; card-upfront presets require consent.
  const handleTrial = async () => {
    if (trialInFlight.current) return
    const trimmedToken = token.trim()
    if (!trimmedToken) { setError('token_v2 пуст'); return }
    if (trialNeedsPayment && (!trialPaymentValid || !trialCountryValid || !trialRenewalConfirmed)) {
      setError('Укажите свой paymentMethodId, реальную страну плательщика и подтвердите условия продления.')
      return
    }
    trialInFlight.current = true
    setTrialLoading(true)
    setError('')
    setResult(null)
    try {
      const r = await startTrial({
        token_v2: trimmedToken,
        space_id: spaceId || '',
        plan: trialNeedsPayment ? SCRIPT_TRIAL_PLAN : plan,
        days: requestedTrialDays,
        captcha_token: trialCaptcha.trim(),
        trial_method: trialMethod,
        ...(trialNeedsPayment ? {
          payment_method_id: trialPaymentID.trim(),
          country: trialCountry,
          confirm_auto_renew: trialRenewalConfirmed,
        } : {}),
      })
      if (r.error) {
        setError(r.error)
      } else {
        const until = r.trial_end ? new Date(r.trial_end).toLocaleDateString('ru-RU') : ''
        setResult(`Триал активирован (${r.subscription_status || 'trialing'})${until ? ' до ' + until : ''}`)
        setTimeout(() => { onSuccess(); onClose() }, 2000)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка запроса')
    } finally {
      trialInFlight.current = false
      setTrialLoading(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (method === 'trial') { await handleTrial(); return }
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
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => { if (!busy) onClose() }}>
      <div className="w-full max-w-lg bg-bg-card border border-border rounded-2xl shadow-modal p-6 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[18px] font-semibold tracking-tight text-text-primary">{workspaceName ? `Оплатить · ${workspaceName}` : 'Оплатить подписку Notion'}</h2>
          <button onClick={onClose} disabled={busy} aria-label="Закрыть окно оплаты" className="w-7 h-7 flex items-center justify-center rounded-full text-text-muted hover:text-text-primary hover:bg-bg-secondary bg-transparent border-none cursor-pointer text-lg leading-none">×</button>
        </div>

        <div className="text-[13px] text-text-secondary mb-4">
          {workspaceName
            ? <p>Оформление подписки для пространства <span className="text-text-primary font-medium">{workspaceName}</span>. Выберите оплату картой или один из вариантов триала.</p>
            : <p>Вставьте <code className="font-mono bg-bg-secondary px-1.5 py-0.5 rounded text-[12px] text-text-primary">token_v2</code>, выберите способ оплаты или вариант триала.</p>}
        </div>

        <div className="flex gap-2 mb-4">
          <button
            type="button"
            disabled={busy || !!result}
            aria-pressed={method === 'card'}
            onClick={() => { setMethod('card'); if (!PLANS.some(p => p.id === plan)) setPlan(PLANS[0].id); setError('') }}
            className={`flex-1 min-h-11 px-3 py-2 rounded-lg border text-sm font-medium cursor-pointer transition-all ${method === 'card' ? 'border-text-primary bg-white/5 text-text-primary' : 'border-border bg-bg-card text-text-secondary hover:border-hairline-strong'}`}
          >
            Картой
          </button>
          <button
            type="button"
            disabled={busy || !!result}
            aria-pressed={method === 'trial'}
            onClick={() => { setMethod('trial'); setPlan(trialNeedsPayment ? SCRIPT_TRIAL_PLAN : TRIAL_DEFAULT_PLAN); setError('') }}
            className={`flex-1 min-h-11 px-3 py-2 rounded-lg border text-sm font-medium cursor-pointer transition-all ${method === 'trial' ? 'border-text-primary bg-white/5 text-text-primary' : 'border-border bg-bg-card text-text-secondary hover:border-hairline-strong'}`}
          >
            Триал · 3 способа
          </button>
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
          <div className={`grid ${method === 'trial' && trialNeedsPayment ? 'grid-cols-1' : 'grid-cols-2'} gap-2 mb-3`}>
            {(method === 'trial' && trialNeedsPayment ? SCRIPT_TRIAL_PLANS : PLANS).map(p => (
              <button
                key={p.id}
                type="button"
                disabled={busy || !!result}
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

          {method === 'card' && stripeError && (
            <div className="mb-3 p-3 bg-bg-secondary border border-border rounded-lg">
              <div className="text-err text-[12px] font-medium mb-1">Оплата новой картой недоступна</div>
              <div className="text-[12px] text-text-secondary">{stripeError}</div>
            </div>
          )}

          {/* Карточный блок НЕ размонтируем при переходе на триал: внутри живёт
              Stripe Element, поэтому просто прячем его через hidden. */}
          <div className={method === 'card' ? '' : 'hidden'}>
            <label className="text-[11px] text-text-muted mb-1 block" hidden={!!stripeError}>Данные карты</label>
            <div ref={cardRef} className="py-2.5 px-3 bg-bg-input border border-border rounded-lg min-h-[40px] mb-3" hidden={!!stripeError} />
          </div>

          {method === 'trial' && (
            <div className="mb-3 p-3 bg-bg-secondary border border-border rounded-lg">
              <label htmlFor="trial-method" className="block text-sm text-text-primary font-medium mb-2">Способ триала</label>
              <select id="trial-method" value={trialMethod} onChange={e => selectTrialPreset(e.target.value as TrialMethod)} disabled={busy || !!result}
                className="w-full min-h-11 py-2 px-3 bg-bg-input border border-border rounded-lg text-sm text-text-primary outline-none focus:border-notion-blue">
                {TRIAL_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.title}</option>)}
              </select>
              <p className="text-sm text-text-secondary mt-2 mb-3">{TRIAL_PRESETS.find(preset => preset.id === trialMethod)?.description}</p>
              {spaceId && <p className="text-sm text-text-secondary mb-3">Применяется только к выбранному пространству.</p>}
              {trialNeedsPayment ? (
                <div className="mb-4 space-y-3">
                  <p className="text-sm text-text-primary leading-relaxed">Business на 14 дней с платёжным методом. После триала возможно продление: 24 USD за место в месяц до налогов. Окончательные условия определяет Notion.</p>
                  <div>
                    <label htmlFor="trial-payment-id" className="block text-sm text-text-primary mb-1">Ваш paymentMethodId</label>
                    <input id="trial-payment-id" value={trialPaymentID} onChange={e => { trialDefaultsEdited.current.payment = true; setTrialPaymentID(e.target.value) }}
                      required disabled={busy} autoComplete="off" spellCheck={false} maxLength={131} pattern="pm_[A-Za-z0-9]{1,128}" placeholder="pm_..."
                      className="w-full min-h-11 py-2 px-3 bg-bg-input border border-border rounded-lg text-sm text-text-primary font-mono outline-none focus:border-notion-blue" />
                    <p className="text-sm text-text-secondary mt-1">Свой разрешённый метод оплаты для этого аккаунта. Идентификатор из примеров не подставляется.</p>
                  </div>
                  <div>
                    <label htmlFor="trial-country" className="block text-sm text-text-primary mb-1">Реальная страна плательщика</label>
                    <input id="trial-country" value={trialCountry} onChange={e => { trialDefaultsEdited.current.country = true; setTrialCountry(e.target.value.replace(/[^a-z]/gi, '').toUpperCase()) }}
                      required disabled={busy} autoComplete="off" minLength={2} maxLength={2} pattern="[A-Z]{2}" placeholder="Например, DE"
                      className="w-full min-h-11 py-2 px-3 bg-bg-input border border-border rounded-lg text-sm text-text-primary outline-none focus:border-notion-blue" />
                  </div>
                  <label className="flex min-h-11 gap-3 items-start text-sm text-text-primary cursor-pointer">
                    <input type="checkbox" checked={trialRenewalConfirmed} onChange={e => setTrialRenewalConfirmed(e.target.checked)} required disabled={busy} className="mt-1 shrink-0" />
                    <span>Подтверждаю, что платёжный метод мой, и понимаю возможность платного автопродления после 14 дней.</span>
                  </label>
                </div>
              ) : <p className="text-sm text-text-secondary mb-3">Прежний вариант без передачи карты. Доступность триала проверяет Notion.</p>}
              <div className="text-sm text-text-primary mb-1">Длительность</div>
              <div className="flex gap-2 mb-3">
                {(trialNeedsPayment ? [14] : TRIAL_DAYS).map(d => (
                  <button key={d} type="button" disabled={busy || !!result} onClick={() => setTrialDays(d)}
                    aria-pressed={requestedTrialDays === d}
                    className={`flex-1 min-h-11 rounded-lg border text-sm cursor-pointer ${requestedTrialDays === d ? 'border-text-primary bg-white/5 text-text-primary' : 'border-border text-text-secondary'}`}>
                    {d} дней
                  </button>
                ))}
              </div>
              <label htmlFor="trial-captcha" className="text-sm text-text-primary mb-1 block">captchaToken, если требуется</label>
              <textarea id="trial-captcha" value={trialCaptcha} onChange={e => setTrialCaptcha(e.target.value)} disabled={busy}
                placeholder="P1_eyJ..." rows={2}
                className="w-full py-2 px-3 bg-bg-input border border-border rounded-lg text-sm text-text-primary outline-none focus:border-notion-blue resize-none font-mono" />
              <p className="text-sm text-text-secondary mt-2">Доступность подтверждает Notion. Новые варианты не повторяются автоматически.</p>
            </div>
          )}

          {method === 'card' && spaceId && savedLast4 && (
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

          <div className={method === 'card' ? '' : 'hidden'}>
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
          </div>

          {error && <div role="alert" className="text-err text-sm mb-2 px-1 break-words">{error}</div>}
          {result && (
            <div className="mb-2 p-3 bg-ok/10 border border-ok/30 rounded-lg text-[12px]">
              <div className="text-ok font-medium">{result}</div>
            </div>
          )}

          <div className="flex flex-col-reverse sm:flex-row gap-2.5 mt-2">
            <button type="button" onClick={onClose} disabled={busy}
              className="flex-1 h-11 min-h-11 shrink-0 bg-bg-card hover:bg-bg-secondary text-text-primary rounded-full text-[14px] font-medium cursor-pointer transition-colors border border-border">
              Отмена
            </button>
            <button type="submit" disabled={busy || !token.trim() || !!result || (method === 'card' && !stripeLoaded) || (method === 'trial' && trialNeedsPayment && (!trialPaymentValid || !trialCountryValid || !trialRenewalConfirmed))}
              className="flex-1 h-11 min-h-11 shrink-0 bg-white hover:bg-white/90 text-black rounded-full text-[14px] font-medium cursor-pointer transition-colors border-none disabled:opacity-40 disabled:cursor-not-allowed">
              {method === 'trial'
                ? (trialLoading ? 'Активирую триал...' : `Запросить триал на ${requestedTrialDays} дней`)
                : (loading ? 'Обработка...' : 'Оплатить новой картой')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
