import { useEffect, useRef } from 'react'

// Interactive particle-network background. Particles drift, link to nearby
// neighbours and to the cursor with hairline strands, and are gently pulled
// toward the mouse. When `active` (the agent is working) the field speeds up
// and tints toward the accent blue. Edges fade out via a radial CSS mask so it
// reads as ambient texture rather than a hard rectangle. Honors
// prefers-reduced-motion by drawing a single static frame.
export function ParticleField({ active = false }: { active?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const activeRef = useRef(active)
  useEffect(() => { activeRef.current = active }, [active])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reduced = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const parent = canvas.parentElement || document.body

    let width = 0
    let height = 0

    type P = { x: number; y: number; vx: number; vy: number }
    let particles: P[] = []
    const mouse = { x: -9999, y: -9999, on: false }

    const seed = () => {
      const target = Math.min(72, Math.max(24, Math.round((width * height) / 17000)))
      particles = []
      for (let i = 0; i < target; i++) {
        particles.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (Math.random() - 0.5) * 0.22,
          vy: (Math.random() - 0.5) * 0.22,
        })
      }
    }

    const resize = () => {
      width = parent.clientWidth
      height = parent.clientHeight
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.max(1, Math.floor(width * dpr))
      canvas.height = Math.max(1, Math.floor(height * dpr))
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      seed()
    }

    const onMove = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect()
      mouse.x = e.clientX - r.left
      mouse.y = e.clientY - r.top
      mouse.on = mouse.x >= 0 && mouse.x <= width && mouse.y >= 0 && mouse.y <= height
    }
    const onLeave = () => { mouse.on = false; mouse.x = -9999; mouse.y = -9999 }

    const LINK = 118
    const MOUSE_LINK = 168
    let raf = 0

    const frame = () => {
      const hot = activeRef.current
      const speed = hot ? 1.8 : 1
      const rgb = hot ? '60,150,255' : '255,255,255'
      const lineBase = hot ? 0.42 : 0.16
      const mouseLineBase = hot ? 0.6 : 0.3
      const dotAlpha = hot ? 0.85 : 0.4
      const dotR = hot ? 1.8 : 1.4
      ctx.clearRect(0, 0, width, height)

      for (const p of particles) {
        p.x += p.vx * speed
        p.y += p.vy * speed
        if (p.x < 0 || p.x > width) p.vx *= -1
        if (p.y < 0 || p.y > height) p.vy *= -1
        p.x = Math.max(0, Math.min(width, p.x))
        p.y = Math.max(0, Math.min(height, p.y))
        if (mouse.on) {
          const dx = mouse.x - p.x
          const dy = mouse.y - p.y
          const d2 = dx * dx + dy * dy
          if (d2 < MOUSE_LINK * MOUSE_LINK && d2 > 1) {
            const f = (hot ? 0.03 : 0.016) / Math.sqrt(d2)
            p.vx += dx * f
            p.vy += dy * f
          }
        }
        p.vx = Math.max(-1.1, Math.min(1.1, p.vx * 0.99))
        p.vy = Math.max(-1.1, Math.min(1.1, p.vy * 0.99))
      }

      for (let i = 0; i < particles.length; i++) {
        const a = particles[i]
        for (let j = i + 1; j < particles.length; j++) {
          const b = particles[j]
          const dx = a.x - b.x
          const dy = a.y - b.y
          const d = Math.hypot(dx, dy)
          if (d < LINK) {
            const o = (1 - d / LINK) * lineBase
            ctx.strokeStyle = `rgba(${rgb},${o.toFixed(3)})`
            ctx.lineWidth = 1
            ctx.beginPath()
            ctx.moveTo(a.x, a.y)
            ctx.lineTo(b.x, b.y)
            ctx.stroke()
          }
        }
        if (mouse.on) {
          const dx = a.x - mouse.x
          const dy = a.y - mouse.y
          const d = Math.hypot(dx, dy)
          if (d < MOUSE_LINK) {
            const o = (1 - d / MOUSE_LINK) * mouseLineBase
            ctx.strokeStyle = `rgba(${rgb},${o.toFixed(3)})`
            ctx.lineWidth = 1
            ctx.beginPath()
            ctx.moveTo(a.x, a.y)
            ctx.lineTo(mouse.x, mouse.y)
            ctx.stroke()
          }
        }
      }

      ctx.fillStyle = `rgba(${rgb},${dotAlpha})`
      for (const p of particles) {
        ctx.beginPath()
        ctx.arc(p.x, p.y, dotR, 0, Math.PI * 2)
        ctx.fill()
      }

      raf = requestAnimationFrame(frame)
    }

    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(parent)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseout', onLeave)

    if (reduced) {
      frame()
      cancelAnimationFrame(raf)
    } else {
      raf = requestAnimationFrame(frame)
    }

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseout', onLeave)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="absolute inset-0 w-full h-full pointer-events-none"
      style={PARTICLE_MASK}
    />
  )
}

const PARTICLE_MASK: React.CSSProperties = {
  WebkitMaskImage: 'radial-gradient(ellipse 92% 88% at 50% 50%, #000 58%, transparent 100%)',
  maskImage: 'radial-gradient(ellipse 92% 88% at 50% 50%, #000 58%, transparent 100%)',
}
