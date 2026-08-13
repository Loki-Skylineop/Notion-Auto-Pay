// Настройки фоновых частиц в чате. Живут в localStorage, поэтому переживают
// перезагрузку страницы, переключение вкладок «Чат» / «Оплата» и закрытие
// браузера. Шестерёнка рядом с кнопкой «Новый чат» правит именно этот объект.

export interface ParticleConfig {
  // Полностью выключить поле частиц: холст даже не монтируется.
  enabled: boolean
  // Множитель количества частиц (0.2…2) поверх расчёта от площади панели.
  density: number
  // Множитель скорости дрейфа (0.2…3).
  speed: number
  // Радиус связи между частицами в пикселях (40…260).
  link: number
  // Притяжение к курсору и линии до него.
  mouse: boolean
  // Взрыв на осколки при ударе о край панели.
  shatter: boolean
  // Общая непрозрачность поля (0.1…1).
  opacity: number
}

export const PARTICLES_KEY = 'nmp_particles'

export const DEFAULT_PARTICLES: ParticleConfig = {
  enabled: true,
  density: 1,
  speed: 1,
  link: 118,
  mouse: true,
  shatter: true,
  opacity: 1,
}

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

// loadParticleConfig никогда не бросает исключение: битый или устаревший JSON
// молча заменяется значениями по умолчанию. Один плохой ключ в localStorage не
// должен ронять весь чат.
export function loadParticleConfig(): ParticleConfig {
  try {
    const raw = localStorage.getItem(PARTICLES_KEY)
    if (!raw) return { ...DEFAULT_PARTICLES }
    const p = JSON.parse(raw) as Partial<ParticleConfig>
    return {
      enabled: p.enabled !== false,
      density: clampNum(p.density, 0.2, 2, DEFAULT_PARTICLES.density),
      speed: clampNum(p.speed, 0.2, 3, DEFAULT_PARTICLES.speed),
      link: clampNum(p.link, 40, 260, DEFAULT_PARTICLES.link),
      mouse: p.mouse !== false,
      shatter: p.shatter !== false,
      opacity: clampNum(p.opacity, 0.1, 1, DEFAULT_PARTICLES.opacity),
    }
  } catch {
    return { ...DEFAULT_PARTICLES }
  }
}

export function saveParticleConfig(cfg: ParticleConfig): void {
  try {
    localStorage.setItem(PARTICLES_KEY, JSON.stringify(cfg))
  } catch {
    // Приватный режим или переполненное хранилище: настройка просто не
    // переживёт перезагрузку, ломать из-за этого UI незачем.
  }
}
