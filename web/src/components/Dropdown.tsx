import { Fragment, useEffect, useRef, useState } from 'react'

export interface DropdownOption {
  value: string
  label: string
  description?: string
  group?: string
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
  searchable = false,
  onOpen,
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
  searchable?: boolean
  onOpen?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleOptions = options.filter(o => !normalizedQuery || `${o.label} ${o.description || ''}`.toLocaleLowerCase().includes(normalizedQuery))
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
        onClick={() => {
          if (disabled) return
          if (!open) { setQuery(''); onOpen?.() }
          setOpen((v) => !v)
        }}
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
          className={`dropdown-pop no-scrollbar absolute z-50 ${menuPos} ${menuAlign} max-h-64 overflow-y-auto rounded-md border border-white/[0.1] bg-[#0c0c0c] py-1 shadow-float ${menuClassName}`}
        >
          {searchable && <div className="sticky top-0 bg-[#0c0c0c] px-2 pb-1 z-10">
            <input autoFocus value={query} onChange={e => setQuery(e.target.value)} aria-label="Поиск пространства или аккаунта" placeholder="Поиск пространства / аккаунта" className="w-full rounded border border-white/[0.1] bg-black px-2 py-1.5 text-[11px] text-text-primary outline-none" />
          </div>}
          {visibleOptions.length === 0 ? (
            <div className="px-2.5 py-1.5 text-[12px] text-text-muted">Нет вариантов</div>
          ) : (
            visibleOptions.map((o, index) => {
              const active = o.value === value
              return (
                <Fragment key={o.value}>
                {o.group && (index === 0 || visibleOptions[index - 1].group !== o.group) && <div className="px-2.5 pt-2 pb-1 text-[9px] uppercase tracking-wider text-text-muted border-t border-white/[0.04]">{o.group}</div>}
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onChange(o.value)
                    setOpen(false)
                  }}
                  className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[12px] transition-colors bg-transparent border-none cursor-pointer ${active ? 'bg-white/[0.07] text-[#e8e8e8]' : 'text-[#999] hover:bg-white/[0.04] hover:text-[#ccc]'}`}
                >
                  <span className="flex-1 min-w-0">
                    <span className="block truncate">{o.label}</span>
                    {o.description && <span className="block truncate text-[10px] text-text-muted mt-0.5">{o.description}</span>}
                  </span>
                  {active ? <span className="shrink-0 text-[10px] text-notion-blue">✓</span> : null}
                </button>
                </Fragment>
              )
            })
          )}
        </div>
      ) : null}
    </div>
  )
}
