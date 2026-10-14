/**
 * ParticleField - 首页粒子特效背景
 *
 * 轻量 Canvas 粒子层：淡紫主题色粒子缓慢漂浮，近距离粒子间
 * 绘制极淡连线，形成呼吸感背景。不拦截任何鼠标事件，不参与布局。
 */
'use client'

import { useEffect, useRef } from 'react'
import { cn } from '@web/utils/className'

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  radius: number
  baseAlpha: number
  colorIndex: number
}

const PARTICLE_COLORS = [
  '139,124,246',
  '167,139,250',
  '196,181,253',
]

const LINK_DISTANCE = 110
const MAX_PARTICLES = 90

function getParticleCount(): number {
  const area = window.innerWidth * window.innerHeight
  return Math.max(24, Math.min(MAX_PARTICLES, Math.round(area / 22000)))
}

export function ParticleField({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas)
      return

    const ctx = canvas.getContext('2d')
    if (!ctx)
      return

    let particles: Particle[] = []
    let rafId = 0
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    let width = 0
    let height = 0

    const initParticles = () => {
      const count = getParticleCount()
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.28,
        vy: (Math.random() - 0.5) * 0.22,
        radius: 1 + Math.random() * 2.2,
        baseAlpha: 0.12 + Math.random() * 0.28,
        colorIndex: Math.floor(Math.random() * PARTICLE_COLORS.length),
      }))
    }

    const resize = () => {
      width = window.innerWidth
      height = window.innerHeight
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      initParticles()
    }

    const draw = () => {
      ctx.clearRect(0, 0, width, height)

      for (const p of particles) {
        p.x += p.vx
        p.y += p.vy

        if (p.x < -12)
          p.x = width + 12
        else if (p.x > width + 12)
          p.x = -12
        if (p.y < -12)
          p.y = height + 12
        else if (p.y > height + 12)
          p.y = -12

        const color = PARTICLE_COLORS[p.colorIndex]
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${color},${p.baseAlpha})`
        ctx.fill()
      }

      // 近距离连线（非常淡）
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const a = particles[i]
          const b = particles[j]
          const dx = a.x - b.x
          const dy = a.y - b.y
          const distSq = dx * dx + dy * dy
          if (distSq > LINK_DISTANCE * LINK_DISTANCE)
            continue
          const alpha = (1 - Math.sqrt(distSq) / LINK_DISTANCE) * 0.05
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.strokeStyle = `rgba(167,139,250,${alpha})`
          ctx.lineWidth = 1
          ctx.stroke()
        }
      }

      rafId = requestAnimationFrame(draw)
    }

    resize()
    draw()

    window.addEventListener('resize', resize)
    return () => {
      window.removeEventListener('resize', resize)
      cancelAnimationFrame(rafId)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={cn(
        'pointer-events-none fixed inset-0 z-0 opacity-80',
        className,
      )}
    />
  )
}
