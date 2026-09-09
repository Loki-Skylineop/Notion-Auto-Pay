// Короткий сигнал в конце хода: агент домолчал — в чате раздаётся звук, как в
// CLI-агентах (opencode и подобных). Файлы лежат в web/public, поэтому Vite
// кладёт их в dist как есть, а Go отдаёт вместе с остальной сборкой.
const SOUNDS = ['s1.wav', 's2.mp3'] as const

export const CHAT_SOUND_KEY = 'chat_done_sound'

// Окно подавления. Конец одного хода видят два независимых источника — свой
// стрим (runningKeys) и опрос сервера (busyThreads), — и гаснут они не
// одновременно: опрос идёт с такта в секунду и подтверждает конец уже после
// того, как оборвался стрим. Без окна один ход отзвучал бы дважды.
const COOLDOWN_MS = 2500

// Громкость: сигнал должен быть заметен, но не пугать.
const VOLUME = 0.6

let lastPlayedAt = 0

// Элементы переиспользуются: иначе каждый ход создаёт новый <audio> и браузер
// снова тянет файл по сети.
const cache = new Map<string, HTMLAudioElement>()

function soundUrl(name: string): string {
  // base — '/dashboard/' и в dev, и в сборке (см. web/vite.config.ts), поэтому
  // путь берём из него, а не пишем руками.
  const base = import.meta.env.BASE_URL || '/'
  return base.endsWith('/') ? `${base}${name}` : `${base}/${name}`
}

function element(name: string): HTMLAudioElement | null {
  const cached = cache.get(name)
  if (cached) return cached
  try {
    const el = new Audio(soundUrl(name))
    el.preload = 'auto'
    el.volume = VOLUME
    cache.set(name, el)
    return el
  } catch {
    return null
  }
}

// Звук можно заглушить без пересборки фронта:
// localStorage.setItem('chat_done_sound', 'off')
export function isChatSoundEnabled(): boolean {
  try {
    return localStorage.getItem(CHAT_SOUND_KEY) !== 'off'
  } catch {
    return true
  }
}

export function setChatSoundEnabled(on: boolean): void {
  try {
    localStorage.setItem(CHAT_SOUND_KEY, on ? 'on' : 'off')
  } catch {
    /* приватный режим — просто не запоминаем выбор */
  }
}

// Прогрев на монтировании: первый сигнал не должен ждать загрузки файла.
export function primeChatSounds(): void {
  for (const name of SOUNDS) {
    try {
      element(name)?.load()
    } catch {
      /* ignore — прогрев необязателен */
    }
  }
}

// Случайный из двух: s1.wav либо s2.mp3.
export function playChatDoneSound(): void {
  if (!isChatSoundEnabled()) return
  const now = Date.now()
  if (now - lastPlayedAt < COOLDOWN_MS) return
  lastPlayedAt = now
  const name = SOUNDS[Math.floor(Math.random() * SOUNDS.length)]
  const el = element(name)
  if (!el) return
  try {
    el.currentTime = 0
    // Автовоспроизведение может быть запрещено, пока на странице не было
    // жеста пользователя, — тогда просто молчим.
    void el.play().catch(() => {})
  } catch {
    /* ignore — звук не критичен для работы чата */
  }
}
