import { useEffect, useRef, useState } from 'react'
import { DEFAULT_PARTICLES, saveParticleConfig, type ParticleConfig } from '../particleSettings'

// Шестерёнка рядом с кнопкой «Новый чат». Открывает компактную панель, где
// летающие частицы можно выключить целиком или подкрутить: плотность,
// скорость, радиус связей, прозрачность, реакцию на курсор и взрывы об края.
// Любое изменение применяется сразу и тут же пишется в localStorage — отдельной
// кнопки «Сохранить» нет намеренно, чтобы настройка не терялась.
export function GearIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

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
  const boxRef = useRef<HTMLDivElement>(null)

  // Клик мимо панели и Esc закрывают её — как у остальных поповеров дашборда.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const patch = (p: Partial<ParticleConfig>) => {
    const next = { ...cfg, ...p }
    saveParticleConfig(next)
    onChange(next)
  }

  return (
    <div ref={boxRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Настройки частиц"
        className={`h-full w-8 flex items-center justify-center rounded-lg border transition-colors bg-transparent cursor-pointer ${
          open
            ? 'border-white/[0.16] text-text-secondary bg-white/[0.05]'
            : 'border-white/[0.07] text-[#888] hover:text-text-secondary hover:border-white/[0.12] hover:bg-white/[0.04]'
        }`}
      >
        <GearIcon />
      </button>

      {open ? (
        <div className="absolute z-40 left-0 top-[calc(100%+6px)] w-[228px] rounded-lg border border-white/[0.10] bg-[#0b0b0b] p-3 shadow-xl">
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
        </div>
      ) : null}
    </div>
  )
}
