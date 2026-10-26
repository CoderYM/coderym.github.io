<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'

const canvas = ref<HTMLCanvasElement>()
let raf = 0
let cleanup = () => {}

onMounted(() => {
  const c = canvas.value!
  const x = c.getContext('2d')!
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches
  let W = 0, H = 0
  let ps: { x: number; y: number; vx: number; vy: number }[] = []
  const m = { x: -999, y: -999 }

  const resize = () => {
    W = c.width = innerWidth
    H = c.height = innerHeight
    ps = Array.from({ length: Math.min(110, Math.floor(W / 12)) }, () => ({
      x: Math.random() * W, y: Math.random() * H,
      vx: (Math.random() - 0.5) * 0.4, vy: (Math.random() - 0.5) * 0.4,
    }))
    if (still) draw()
  }
  const move = (e: MouseEvent) => { m.x = e.clientX; m.y = e.clientY }

  function draw() {
    x.clearRect(0, 0, W, H)
    for (const p of ps) {
      if (!still) { p.x += p.vx; p.y += p.vy }
      if (p.x < 0 || p.x > W) p.vx *= -1
      if (p.y < 0 || p.y > H) p.vy *= -1
      const dm = Math.hypot(p.x - m.x, p.y - m.y)
      if (dm < 160) {
        x.strokeStyle = `rgba(34,211,238,${1 - dm / 160})`
        x.beginPath(); x.moveTo(p.x, p.y); x.lineTo(m.x, m.y); x.stroke()
      }
      x.fillStyle = '#c4b5fd'
      x.beginPath(); x.arc(p.x, p.y, 1.6, 0, 7); x.fill()
    }
    for (let i = 0; i < ps.length; i++)
      for (let j = i + 1; j < ps.length; j++) {
        const d = Math.hypot(ps[i].x - ps[j].x, ps[i].y - ps[j].y)
        if (d < 110) {
          x.strokeStyle = `rgba(139,92,246,${0.5 - d / 220})`
          x.beginPath(); x.moveTo(ps[i].x, ps[i].y); x.lineTo(ps[j].x, ps[j].y); x.stroke()
        }
      }
  }
  // 标签页不可见时暂停动画，省电
  const loop = () => { if (!document.hidden) draw(); raf = requestAnimationFrame(loop) }

  addEventListener('resize', resize)
  addEventListener('mousemove', move)
  resize()
  if (!still) loop()
  cleanup = () => {
    cancelAnimationFrame(raf)
    removeEventListener('resize', resize)
    removeEventListener('mousemove', move)
  }
})

onBeforeUnmount(() => cleanup())
</script>

<template>
  <canvas ref="canvas" class="mx-particles" aria-hidden="true" />
  <div class="mx-glow g1" aria-hidden="true" />
  <div class="mx-glow g2" aria-hidden="true" />
</template>

<style scoped>
.mx-particles { position: fixed; inset: 0; z-index: 0; pointer-events: none; }
.mx-glow { position: fixed; width: 600px; height: 600px; border-radius: 50%; filter: blur(120px); opacity: .3; z-index: 0; pointer-events: none; }
.g1 { background: var(--mx-purple); top: -200px; left: -150px; }
.g2 { background: var(--mx-cyan); bottom: -250px; right: -150px; }
</style>
