// measure-logo.mjs - 从 logo.png 提取笔画宽度轮廓（供粒子场按真实 Logo 形态还原）
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const sharp = require('C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/project/bosom-friend-electron/node_modules/sharp')
import { writeFileSync, mkdirSync } from 'node:fs'
const png = 'C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/project/bosom-friend-web/src/assets/images/logo.png'
const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
const W = info.width, H = info.height
const alpha = (x, y) => { const i = (y * W + x) * 4 + 3; return data[i] }
// 1) 掩码包围盒
let minX = W, minY = H, maxX = -1, maxY = -1
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (alpha(x, y) > 100) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }
const bw = maxX - minX + 1, bh = maxY - minY + 1
const cx = minX + bw / 2 - 0.5, cy = minY + bh / 2 - 0.5
console.log('bbox', JSON.stringify({ minX, minY, maxX, maxY, bw, bh, ratio: +(bw / bh).toFixed(3) }))
// 2) Bernoulli 拟合：求 ymax 系数
let ymaxF = 0
for (let i = 0; i < 1024; i++) { const t = i / 1024 * Math.PI * 2; const y = Math.sin(t) * Math.cos(t) / (1 + Math.sin(t) * Math.sin(t)); ymaxF = Math.max(ymaxF, Math.abs(y)) }
const A = bw / 2
const B = (bh / 2) / ymaxF
const curve = (t) => {
  const s2 = Math.sin(t) * Math.sin(t)
  const inv = 1 / (1 + s2)
  return { x: cx + A * Math.cos(t) * inv, y: cy + B * Math.sin(t) * Math.cos(t) * inv }
}
// 3) 弧长均匀表
const DENSE = 1200
const pts = []
const lens = [0]
for (let i = 0; i <= DENSE; i++) {
  const p = curve(i / DENSE * Math.PI * 2)
  if (i > 0) lens.push(lens[i - 1] + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y))
  pts.push(p)
}
const total = lens[DENSE]
const M = 200
const widths = []
for (let i = 0; i < M; i++) {
  const target = (i + 0.5) / M * total
  let lo = 0, hi = DENSE
  while (lo < hi) { const mid = (lo + hi) >> 1; if (lens[mid] < target) lo = mid + 1; else hi = mid }
  const k = Math.max(0, lo - 1)
  const g = pts[k], g2 = pts[Math.min(DENSE, k + 1)]
  let dx = g2.x - g.x, dy = g2.y - g.y
  const len = Math.hypot(dx, dy) || 1
  dx /= len; dy /= len
  const nx = -dy, ny = dx
  const ray = (sign) => {
    let step = 0
    for (; step < 96; step++) {
      const x = Math.round(g.x + nx * sign * step * 0.25)
      const y = Math.round(g.y + ny * sign * step * 0.25)
      if (x < 0 || y < 0 || x >= W || y >= H || alpha(x, y) <= 50) break
    }
    return step * 0.25
  }
  widths.push({ l: +ray(-1).toFixed(2), r: +ray(+1).toFixed(2) })
}
// 4) 平滑 + 钳位（去空洞、保留 logo 固有的粗细变化：交叉厚/瓣环薄），生成 TS 数据模块
const smooth = (i, axis) => {
  const mid = widths[i][axis]
  const prev = widths[(i - 1 + M) % M][axis]
  const next = widths[(i + 1) % M][axis]
  return (mid + prev + next) / 3
}
const cl = (v) => Math.max(0.9, Math.min(12, v))
const num = (v) => (Number.isFinite(v) ? +v.toFixed(2) : 0.9)
const rows = widths.map((_, i) => [num(cl(smooth(i, 0))), num(cl(smooth(i, 1)))])
mkdirSync('C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/project/bosom-friend-web/src/assets/brand', { recursive: true })
const ts = `/**
 * logo-thickness - 从 logo.png 实测的品牌笔画轮廓（自动生成，勿手改）
 * bw/bh = 掩码包围盒（logo 像素）；widths = 按弧长等距 200 采样点的左右半宽（logo 像素，3 点平滑 + 钳位）。
 */
export const LOGO_BB = { bw: ${bw}, bh: ${bh} }
export const LOGO_WIDTHS: Array<[number, number]> = ${JSON.stringify(rows)}
`
writeFileSync('C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/project/bosom-friend-web/src/assets/brand/logo-thickness.ts', ts)
console.log('widths raw Range: l[', Math.min(...widths.map(w => w.l)), '..', Math.max(...widths.map(w => w.l)), '] r[', Math.min(...widths.map(w => w.r)), '..', Math.max(...widths.map(w => w.r)), ']')
console.log('saved logo-thickness.ts, M=' + M)
console.log('median l', (() => { const a = widths.map(w => w.l).sort((x, y) => x - y); return a[Math.floor(a.length / 2)] })())
