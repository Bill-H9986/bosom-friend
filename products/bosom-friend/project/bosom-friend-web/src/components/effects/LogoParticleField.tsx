/**
 * LogoParticleField - 首页新 LOGO 汇聚粒子背景（v6）
 *
 * 不再绘制巨大的粒子 Logo 点面，只保留散落粒子，并持续向页面中真正渲染的
 * 新 LOGO（`data-logo-flow-target`）聚拢。粒子每帧选择距离自己最近的线条点
 * 作为目标并低速吸附，抵达后淡出，再从画布四周/随机位置重生；不拦截事件，
 * 支持 prefers-reduced-motion（静态散点）。
 */
'use client'

import { useEffect, useRef } from 'react'
import { cn } from '@web/utils/className'

interface GatherParticle {
  x: number
  y: number
  vx: number
  vy: number
  targetIndex: number
  r: number
  color: string
  born: number
  alpha: number
}

// 浅紫 / 浅青，保持首页原有低饱和氛围
const PALETTE = ['167,139,250', '196,181,253', '221,214,254', '165,243,252', '139,124,246']
const MAX_PARTICLES = 68
const TARGET_SAMPLES = 96
const ARRIVE_DIST = 10
const FADE_ZONE = 24
const RASTER = 0.5

/** Bernoulli 双纽线点坐标（与品牌 ∞ 线条一致） */
function curvePoint(t: number, A: number, B: number): { x: number, y: number } {
  const s2 = Math.sin(t) * Math.sin(t)
  const inv = 1 / (1 + s2)
  return { x: A * Math.cos(t) * inv, y: B * Math.sin(t) * Math.cos(t) * inv }
}

export function LogoParticleField({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas)
      return
    const ctx = canvas.getContext('2d')
    if (!ctx)
      return

    const reduceMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    let rafId = 0
    let width = 0
    let height = 0
    let targets: Array<{ x: number, y: number }> = []
    let particles: GatherParticle[] = []

    const buildTargets = () => {
      const target = canvas.parentElement?.querySelector<HTMLElement>('[data-logo-flow-target]')
      const canvasRect = canvas.getBoundingClientRect()

      if (target && canvasRect.width > 0 && canvasRect.height > 0) {
        const rect = target.getBoundingClientRect()
        const cx = rect.left - canvasRect.left + rect.width / 2
        const cy = rect.top - canvasRect.top + rect.height / 2
        const A = rect.width / 2
        const B = rect.width * 0.55
        targets = Array.from({ length: TARGET_SAMPLES + 1 }, (_, i) => {
          const p = curvePoint((i / TARGET_SAMPLES) * Math.PI * 2, A, B)
          return { x: cx + p.x, y: cy + p.y }
        })
        return
      }

      const fallbackW = Math.min(Math.max(width * 0.34, 180), 420)
      const fallbackH = fallbackW * 0.4
      const cx = width / 2
      const cy = height / 2
      targets = Array.from({ length: TARGET_SAMPLES + 1 }, (_, i) => {
        const angle = (i / TARGET_SAMPLES) * Math.PI * 2
        return {
          x: cx + Math.cos(angle) * fallbackW / 2,
          y: cy + Math.sin(angle) * fallbackH / 2,
        }
      })
    }

    const nearestTargetIndex = (x: number, y: number): number => {
      let best = 0
      let bestDist = Infinity
      for (let i = 0; i < targets.length; i++) {
        const d = Math.hypot(targets[i].x - x, targets[i].y - y)
        if (d < bestDist) {
          bestDist = d
          best = i
        }
      }
      return best
    }

    const spawnParticle = (): GatherParticle => {
      const edgeSpawn = Math.random() < 0.55
      const margin = 14
      let x = width / 2
      let y = height / 2

      if (edgeSpawn) {
        const side = Math.floor(Math.random() * 4)
        if (side === 0) {
          x = margin + Math.random() * Math.max(1, width - margin * 2)
          y = margin
        }
        else if (side === 1) {
          x = margin + Math.random() * Math.max(1, width - margin * 2)
          y = height - margin
        }
        else if (side === 2) {
          x = margin
          y = margin + Math.random() * Math.max(1, height - margin * 2)
        }
        else {
          x = width - margin
          y = margin + Math.random() * Math.max(1, height - margin * 2)
        }
      }
      else {
        x = margin + Math.random() * Math.max(1, width - margin * 2)
        y = margin + Math.random() * Math.max(1, height - margin * 2)
      }

      return {
        x,
        y,
        vx: 0,
        vy: 0,
        targetIndex: targets.length > 0 ? nearestTargetIndex(x, y) : 0,
        r: 1.3 + Math.random() * 1.2,
        color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
        born: performance.now(),
        alpha: 0,
      }
    }

    const resetParticles = () => {
      particles = Array.from({ length: MAX_PARTICLES }, spawnParticle)
    }

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      width = Math.max(1, Math.floor(rect.width))
      height = Math.max(1, Math.floor(rect.height))
      canvas.width = Math.floor(width * RASTER)
      canvas.height = Math.floor(height * RASTER)
      canvas.style.width = width + 'px'
      canvas.style.height = height + 'px'
      ctx.setTransform(RASTER, 0, 0, RASTER, 0, 0)
      buildTargets()
      resetParticles()
    }

    const draw = (now: number) => {
      ctx.clearRect(0, 0, width, height)

      if (reduceMotion) {
        for (const p of particles) {
          ctx.beginPath()
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
          ctx.fillStyle = 'rgba(' + p.color + ',0.22)'
          ctx.fill()
        }
        return
      }

      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i]
        p.targetIndex = nearestTargetIndex(p.x, p.y)
        const target = targets[p.targetIndex]
        if (!target) {
          particles.splice(i, 1)
          particles.push(spawnParticle())
          continue
        }

        const dx = target.x - p.x
        const dy = target.y - p.y
        const dist = Math.hypot(dx, dy) || 1
        const speed = 0.12 + 0.3 * (1 - Math.min(1, dist / 240))

        p.vx += (dx / dist) * 0.05
        p.vy += (dy / dist) * 0.05
        p.vx *= 0.985
        p.vy *= 0.985

        const v = Math.hypot(p.vx, p.vy) || 1
        if (v > speed) {
          p.vx = (p.vx / v) * speed
          p.vy = (p.vy / v) * speed
        }
        p.x += p.vx
        p.y += p.vy

        const age = (now - p.born) / 1000
        const fadeIn = Math.min(1, age / 0.8)
        const fadeOut = Math.min(1, Math.max(0, dist / FADE_ZONE))
        p.alpha = 0.34 * fadeIn * fadeOut

        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(' + p.color + ',' + p.alpha.toFixed(3) + ')'
        ctx.fill()

        if (dist < ARRIVE_DIST) {
          particles.splice(i, 1)
          particles.push(spawnParticle())
        }
      }

      rafId = requestAnimationFrame(draw)
    }

    const start = () => {
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(draw)
    }

    resize()
    start()

    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    const onVisibility = () => {
      if (document.hidden)
        cancelAnimationFrame(rafId)
      else
        start()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      cancelAnimationFrame(rafId)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      data-testid="logo-particle-field"
      className={cn('pointer-events-none absolute inset-0 h-full w-full', className)}
    />
  )
}
