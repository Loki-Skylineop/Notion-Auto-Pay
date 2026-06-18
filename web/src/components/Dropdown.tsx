import { useEffect, useRef, useState } from 'react'

export interface DropdownOption {
  value: string
  label: string
}

// A small custom select that matches the dark Vercel theme. Native <select>
// popups render with the OS' white background + gray text, which looks off-brand
// on the black UI. We render our own menu instead: a dark panel with translucent
// hairline borders, a highlighted active row and a soft pop-in animation. Closes
// on outside click / Escape and supports opening upward (for the composer) and
// right-aligning the menu.
export function Dropdown({
  value,
  options,
  onChange,
  disabled = false,
  title,
  ariaLabel,
  placeholder = '—',
  openUp = false,
  align = 'left',
  className = '',
  buttonClassName = '',
  menuClassName = 'w-full',
}: {
  value: string
  options: DropdownOption[]
  onChange: (value: string) => void
  disabled?: boolean
  title?: string
  ariaLabel?: string
  placeholder?: string
  openUp?: boolean
  align?: 'left' | 'right'
  className?: string
  buttonClassName?: string
  menuClassName?: string
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const selected = options.find((o) => o.value === value)
  const label = selected ? selected.label : placeholder
  const menuPos = openUp ? 'bottom-full mb-1' : 'top-full mt-1'
  const menuAlign = align === 'right' ? 'right-0' : 'left-0'

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => !disabled && setOpen((v) => !v)}
        className={`w-full flex items-center justify-between gap-2 bg-white/[0.03] border text-left transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${open ? 'border-white/[0.18]' : 'border-white/[0.07] hover:border-white/[0.12]'} ${buttonClassName}`}
      >
        <span className="truncate text-[#bdbdbd]">{label}</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`shrink-0 text-[#666] transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open ? (
        <div
          role="listbox"
          className={`dropdown-pop absolute z-50 ${menuPos} ${menuAlign} max-h-64 overflow-y-auto rounded-md border border-white/[0.1] bg-[#0c0c0c] py-1 shadow-float ${menuClassName}`}
        >
          {options.length === 0 ? (
            <div className="px-2.5 py-1.5 text-[12px] text-text-muted">Нет вариантов</div>
          ) : (
            options.map((o) => {
              const active = o.value === value
              return (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onChange(o.value)
                    setOpen(false)
                  }}
                  className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[12px] transition-colors bg-transparent border-none cursor-pointer ${active ? 'bg-white/[0.07] text-[#e8e8e8]' : 'text-[#999] hover:bg-white/[0.04] hover:text-[#ccc]'}`}
                >
                  <span className="flex-1 truncate">{o.label}</span>
                  {active ? <span className="shrink-0 text-[10px] text-notion-blue">✓</span> : null}
                </button>
              )
            })
          )}
        </div>
      ) : null}
    </div>
  )
}
