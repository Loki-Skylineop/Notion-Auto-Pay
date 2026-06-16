import { useState, useEffect } from 'react'
import { PLANS } from './SubscribeModal'
import {
  fetchAutoPayConfig, updateAutoPayConfig, clampIntervalSeconds,
  type ServerAutoPayConfig,
} from '../autopay'

// Settings modal for unattended, server-side auto-pay.
//
// The card is entered once and stored on the SERVER (accounts/.autopay.json).
// The Go scheduler re-tokenizes it into a fresh Stripe PaymentMethod for every
// workspace it charges — a single pm_ can't be reused across Notion's
// per-workspace Stripe customers, which is why the old browser-side reuse
// "didn't pay". Storing the raw card server-side also means auto-pay runs with
// the browser closed.
export function AutoPaySettings({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [cfg, setCfg] = useState<ServerAutoPayConfig | null>(null)
  const [plan, setPlan] = useState('business_monthly_eur_202505')
  const [country, setCountry] = useState('DE')
  const [intervalSec, setIntervalSec] = useState(60)
  const [number, setNumber] = useState('')
  const [exp, setExp] = useState('')
  const [cvc, setCvc] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  useEffect(() => {
    fetchAutoPayConfig()
      .then(c => {
        setCfg(c)
        setPlan(c.plan)
        setCountry(c.country)
        setIntervalSec(c.interval_seconds)
      })
      .catch(() => { /* defaults stay */ })
  }, [])

  const handleSave = async () => {
    setLoading(true)
    setError('')
    setSaved(false)
    try {
      const patch: Record<string, unknown> = {
        plan,
        country,
        interval_seconds: clampIntervalSeconds(intervalSec),
      }
      const digits = number.replace(/\s+/g, '')
      if (digits) {
        const parts = exp.split(/[\/\-\s.]+/).map(s => s.trim()).filter(Boolean)
        const mm = parts[0] || ''
        let yy = parts[1] || ''
        if (yy.length === 4) yy = yy.slice(2)
        if (!mm || !yy || !cvc.trim()) {
          setError('Заполните срок (ММ/ГГ) и CVC')
          setLoading(false)
          return
        }
        patch.card = { number: digits, exp_month: mm, exp_year: yy, cvc: cvc.trim() }
      }
      const next = await updateAutoPayConfig(patch)
      setCfg(next)
      setSaved(true)
      setNumber('')
      setCvc('')
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения')
    } finally {
      setLoading(false)
    }
  }

  const removeCard = async () => {
    try {
      const next = await updateAutoPayConfig({ clear_card: true })
      setCfg(next)
      setSaved(false)
    } catch { /* ignore */ }
  }

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-lg bg-bg-card border border-border rounded-2xl shadow-modal p-6 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[18px] font-semibold tracking-tight text-text-primary">Автооплата · карта и план</h2>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-full text-text-muted hover:text-text-primary hover:bg-bg-secondary bg-transparent border-none cursor-pointer text-lg leading-none">×</button>
        </div>

        <div className="text-[13px] text-text-secondary mb-4">
          <p>Карта сохраняется на сервере и используется фоновым процессом — <span className="text-text-primary font-medium">браузер можно закрыть</span>. На каждый платёж создаётся новый токен Stripe, поэтому одна карта работает для любого количества пространств.</p>
        </div>

        <label className="text-[11px] text-text-muted mb-1 block">План для автооплаты</label>
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

        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="text-[11px] text-text-muted mb-1 block">Страна</label>
            <select
              value={country}
              onChange={e => setCountry(e.target.value)}
              className="w-full py-2 px-3 bg-bg-input border border-border rounded-lg text-[13px] text-text-primary outline-none focus:border-notion-blue transition-all"
            >
              <option value="DE">DE (Germany)</option>
              <option value="US">US (United States)</option>
              <option value="GB">GB (United Kingdom)</option>
              <option value="KR">KR (South Korea)</option>
              <option value="CN">CN (China)</option>
              <option value="RU">RU (Russia)</option>
            </select>
          </div>
          <div>
            <label className="text-[11px] text-text-muted mb-1 block">Интервал проверки, сек</label>
            <input
              type="number"
              min={5}
              max={86400}
              value={intervalSec}
              onChange={e => setIntervalSec(clampIntervalSeconds(e.target.value))}
              className="w-full py-2 px-3 bg-bg-input border border-border rounded-lg text-[13px] text-text-primary outline-none focus:border-notion-blue transition-all text-right"
            />
          </div>
        </div>

        <label className="text-[11px] text-text-muted mb-1 block">Номер карты</label>
        <input
          inputMode="numeric"
          autoComplete="cc-number"
          value={number}
          onChange={e => setNumber(e.target.value)}
          placeholder={cfg?.has_card ? `Сохранена ···· ${cfg.card_last4} — введите новую, чтобы заменить` : '1234 5678 9012 3456'}
          className="w-full py-2.5 px-3 bg-bg-input border border-border rounded-lg text-[13px] text-text-primary outline-none focus:border-notion-blue transition-all mb-2 font-mono"
        />
        <div className="grid grid-cols-2 gap-3 mb-2">
          <div>
            <label className="text-[11px] text-text-muted mb-1 block">Срок (ММ/ГГ)</label>
            <input
              inputMode="numeric"
              autoComplete="cc-exp"
              value={exp}
              onChange={e => setExp(e.target.value)}
              placeholder="04/31"
              className="w-full py-2.5 px-3 bg-bg-input border border-border rounded-lg text-[13px] text-text-primary outline-none focus:border-notion-blue transition-all font-mono"
            />
          </div>
          <div>
            <label className="text-[11px] text-text-muted mb-1 block">CVC</label>
            <input
              inputMode="numeric"
              autoComplete="cc-csc"
              value={cvc}
              onChange={e => setCvc(e.target.value)}
              placeholder="123"
              className="w-full py-2.5 px-3 bg-bg-input border border-border rounded-lg text-[13px] text-text-primary outline-none focus:border-notion-blue transition-all font-mono"
            />
          </div>
        </div>

        {cfg?.has_card && (
          <div className="flex items-center justify-between mb-3 px-3 py-2 bg-ok/10 border border-ok/30 rounded-lg">
            <span className="text-[12px] text-ok">Сохранённая карта: ···· {cfg.card_last4}</span>
            <button onClick={removeCard} className="text-[11px] text-err hover:text-err/70 bg-transparent border-none cursor-pointer">Удалить</button>
          </div>
        )}

        {error && <div className="text-err text-[12px] mb-2 px-1">{error}</div>}
        {saved && <div className="text-ok text-[12px] mb-2 px-1">Сохранено</div>}

        <div className="text-[10px] text-text-muted mb-3 leading-relaxed">
          Внимание: при автооплате списываются реальные деньги. Номер карты хранится локально на вашем сервере (accounts/.autopay.json).
        </div>

        <div className="flex gap-2.5">
          <button type="button" onClick={onClose}
            className="flex-1 h-11 bg-bg-card hover:bg-bg-secondary text-text-primary rounded-full text-[14px] font-medium cursor-pointer transition-colors border border-border">
            Закрыть
          </button>
          <button type="button" onClick={handleSave} disabled={loading}
            className="flex-1 h-11 bg-white hover:bg-white/90 text-black rounded-full text-[14px] font-medium cursor-pointer transition-colors border-none disabled:opacity-40 disabled:cursor-not-allowed">
            {loading ? 'Сохранение...' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  )
}
