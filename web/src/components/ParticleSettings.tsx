import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DEFAULT_PARTICLES, saveParticleConfig, type ParticleConfig } from '../particleSettings'

// Шестерёнка рядом с кнопкой «Новый чат». Открывает компактную панель, где
// летающие частицы можно выключить целиком или подкрутить: плотность,
// скорость, радиус связей, прозрачность, реакцию на курсор и взрывы об края.
// Любое изменение применяется сразу и тут же пишется в localStorage — отдельной
// кнопки «Сохранить» нет намеренно, чтобы настройка не терялась.
//
// Панель рендерится порталом в document.body и позиционируется fixed по месту
// шестерёнки. Раньше это был обычный absolute-поповер внутри сайдбара, и его
// резали overflow-hidden сайдбара и скруглённая оболочка чата.
export function GearIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

// Ширина панели и отступы от краёв экрана при автопозиционировании.
const PANEL_WIDTH = 236
const EDGE = 8
const GAP = 6

type PanelPos = { left: number; top?: number; bottom?: number; width: number; maxHeight: number }

function Slider({ label, value, min, max, step, suffix, onChange }: {
  label: string
  value: number
  min: number
  max: number
  step: number
  suffix?: string
  onChange: (v: number) => void
}) {
  return (
    <label className="block">
      <span className="flex items-center justify-between text-[10px] text-text-muted mb-1">
        <span>{label}</span>
        <span className="tabular-nums text-text-secondary">{value}{suffix || ''}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-1 accent-[#4c9aff] cursor-pointer"
      />
    </label>
  )
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-2 text-[11px] text-text-secondary cursor-pointer">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-[#4c9aff] w-3.5 h-3.5 cursor-pointer shrink-0"
      />
    </label>
  )
}

export function ParticleSettings({ cfg, onChange }: { cfg: ParticleConfig; onChange: (next: ParticleConfig) => void }) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<PanelPos | null>(null)

  // Считаем координаты относительно окна: панель прижимается к шестерёнке, но
  // не вылезает за края экрана и раскрывается вверх, если снизу мало места.
  const place = useCallback(() => {
    const el = anchorRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const width = Math.min(PANEL_WIDTH, vw - EDGE * 2)
    const left = Math.min(Math.max(EDGE, r.left), Math.max(EDGE, vw - width - EDGE))
    const spaceBelow = vh - r.bottom - GAP - EDGE
    const spaceAbove = r.top - GAP - EDGE
    const up = spaceBelow < 260 && spaceAbove > spaceBelow
    setPos(
      up
        ? { left, bottom: vh - r.top + GAP, width, maxHeight: Math.max(160, spaceAbove) }
        : { left, top: r.bottom + GAP, width, maxHeight: Math.max(160, spaceBelow) },
    )
  }, [])

  useLayoutEffect(() => {
    if (open) place()
  }, [open, place])

  // Клик мимо панели и Esc закрывают её — как у остальных поповеров дашборда.
  // Панель живёт в портале, поэтому «своими» считаем и шестерёнку, и панель.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (anchorRef.current && anchorRef.current.contains(t)) return
      if (panelRef.current && panelRef.current.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onReflow = () => place()
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onReflow)
    // scroll слушаем в capture-фазе, чтобы ловить прокрутку любого контейнера.
    window.addEventListener('scroll', onReflow, true)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onReflow)
      window.removeEventListener('scroll', onReflow, true)
    }
  }, [open, place])

  const patch = (p: Partial<ParticleConfig>) => {
    const next = { ...cfg, ...p }
    saveParticleConfig(next)
    onChange(next)
  }

  return (
    <div ref={anchorRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Настройки частиц"
        aria-expanded={open}
        className={`h-full w-8 flex items-center justify-center rounded-lg border transition-colors bg-transparent cursor-pointer ${
          open
            ? 'border-white/[0.16] text-text-secondary bg-white/[0.05]'
            : 'border-white/[0.07] text-[#888] hover:text-text-secondary hover:border-white/[0.12] hover:bg-white/[0.04]'
        }`}
      >
        <GearIcon />
      </button>

      {open && pos
        ? createPortal(
            <div
              ref={panelRef}
              style={{
                position: 'fixed',
                left: pos.left,
                top: pos.top,
                bottom: pos.bottom,
                width: pos.width,
                maxHeight: pos.maxHeight,
              }}
              className="no-scrollbar z-[70] overflow-y-auto overscroll-contain rounded-lg border border-white/[0.10] bg-[#0b0b0b] p-3 shadow-xl"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-[9px] uppercase tracking-widest text-text-muted">Частицы</span>
                <button
                  type="button"
                  onClick={() => patch({ ...DEFAULT_PARTICLES })}
                  className="text-[10px] text-text-muted hover:text-text-secondary bg-transparent border-none cursor-pointer p-0"
                >
                  сбросить
                </button>
              </div>

              <Toggle label="Показывать частицы" checked={cfg.enabled} onChange={(v) => patch({ enabled: v })} />

              <div className={`mt-2.5 space-y-2.5 ${cfg.enabled ? '' : 'opacity-40 pointer-events-none'}`}>
                <Slider label="Плотность" value={cfg.density} min={0.2} max={2} step={0.1} suffix="×" onChange={(v) => patch({ density: v })} />
                <Slider label="Скорость" value={cfg.speed} min={0.2} max={3} step={0.1} suffix="×" onChange={(v) => patch({ speed: v })} />
                <Slider label="Радиус связей" value={cfg.link} min={40} max={260} step={2} suffix=" px" onChange={(v) => patch({ link: v })} />
                <Slider label="Прозрачность" value={cfg.opacity} min={0.1} max={1} step={0.05} onChange={(v) => patch({ opacity: v })} />
                <Toggle label="Тянуться к курсору" checked={cfg.mouse} onChange={(v) => patch({ mouse: v })} />
                <Toggle label="Осколки об края" checked={cfg.shatter} onChange={(v) => patch({ shatter: v })} />
              </div>

              <p className="mt-2.5 text-[9px] text-text-muted leading-snug">Настройки сохраняются в этом браузере.</p>
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
