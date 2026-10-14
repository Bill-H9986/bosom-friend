import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, statSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'

const FF = process.env.FFMPEG_PATH ?? 'C:/Users/Jay/bosom-out/ffmpeg.exe'
const FFPROBE = FF.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1')
const film = process.argv[2]
if (!film || !existsSync(film)) { console.error('用法: node analyze-film.mjs <成片路径> [帧间隔秒]'); process.exit(2) }
const step = Number(process.argv[3] ?? 1)
const tag = basename(film).replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 36)
const OUT = 'C:/Users/Jay/Desktop/Bosom friend APP/products/bosom-friend/qa/acceptance/content-creation/analysis-' + tag
mkdirSync(OUT, { recursive: true })

function run(args, bin = FF) {
  const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
  return String(r.stdout ?? '') + String(r.stderr ?? '')
}
const notes = []
const probe = run(['-hide_banner', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', film], FFPROBE)
let info = {}
try { info = JSON.parse(probe) } catch {}
const v = (info.streams ?? []).find(s => s.codec_type === 'video') ?? {}
const a = (info.streams ?? []).find(s => s.codec_type === 'audio') ?? {}
const seconds = Number(info.format?.duration ?? 0)
notes.push('时长=' + seconds.toFixed(2) + 's 画布=' + String(v.width) + 'x' + String(v.height) + ' 帧率=' + String(v.r_frame_rate) + ' 音轨=' + (a.codec_name ?? '无') + '/' + String(a.sample_rate ?? '') + 'Hz/' + String(a.channels ?? '') + 'ch 提交字幕轨=' + String((info.streams ?? []).filter(s => s.codec_type === 'subtitle').length))

const black = run(['-hide_banner', '-i', film, '-vf', 'blackdetect=d=0.1:pic_th=0.98', '-an', '-f', 'null', '-'])
const blackHits = [...black.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map(m => m[1] + '~' + m[2])
const freeze = run(['-hide_banner', '-i', film, '-vf', 'freezedetect=n=-60dB:d=1.2', '-an', '-f', 'null', '-'])
const freezeHits = [...freeze.matchAll(/freeze_start: ([\d.]+)/g)].map(m => m[1])
const vol = run(['-hide_banner', '-i', film, '-af', 'volumedetect', '-f', 'null', '-'])
const mean = /mean_volume: ([\-\d.]+) dB/.exec(vol)?.[1] ?? '?'
const maxv = /max_volume: ([\-\d.]+) dB/.exec(vol)?.[1] ?? '?'
const silence = run(['-hide_banner', '-i', film, '-af', 'silencedetect=n=-45dB:d=0.8', '-f', 'null', '-'])
const sil = [...silence.matchAll(/silence_start: ([\d.]+)/g)].map(m => Number(m[1]).toFixed(1))
notes.push('黑帧=' + (blackHits.length === 0 ? '无' : blackHits.join(',')) + ' 冻结=' + (freezeHits.length === 0 ? '无' : freezeHits.join(',')) + ' 静音起点=' + (sil.length === 0 ? '无' : sil.join(',')))
notes.push('音量 平均=' + mean + 'dB 峰值=' + maxv + 'dB')

// 场景切换（cut）检测：找出镜头边界
const scene = run(['-hide_banner', '-i', film, '-vf', "select='gt(scene,0.35)',showinfo", '-an', '-f', 'null', '-'])
const cuts = [...scene.matchAll(/pts_time:([\d.]+)/g)].map(m => Number(m[1]))
notes.push('场景切换点(' + String(cuts.length) + '): ' + cuts.map(c => c.toFixed(2)).join(' '))

// 全片联系表（每 step 秒 1 帧，6x6 一张）
const per = 36
const count = Math.max(1, Math.ceil(seconds / step))
const sheets = Math.ceil(count / per)
for (let s = 0; s < sheets; s++) {
  const from = s * per * step
  const out = join(OUT, 'sheet-' + String(s + 1).padStart(2, '0') + '-t' + String(from) + 's.png')
  run(['-hide_banner', '-y', '-ss', String(from), '-t', String(per * step), '-i', film, '-vf', 'fps=1/' + String(step) + ',scale=240:-1,tile=6x6:padding=4:margin=4', '-frames:v', '1', out])
  if (existsSync(out)) notes.push('联系表 ' + basename(out) + ' ' + String(Math.round(statSync(out).size / 1024)) + 'KB')
}
// 底部字幕带（裁下方 28%，每 step 秒 1 帧，3x6 一张，专门看字幕）
const subSheets = Math.ceil(count / 18)
for (let s = 0; s < subSheets; s++) {
  const from = s * 18 * step
  const out = join(OUT, 'subs-' + String(s + 1).padStart(2, '0') + '-t' + String(from) + 's.png')
  run(['-hide_banner', '-y', '-ss', String(from), '-t', String(18 * step), '-i', film, '-vf', 'fps=1/' + String(step) + ',crop=iw:ih*0.28:0:ih*0.68,scale=420:-1,tile=3x6:padding=3:margin=3', '-frames:v', '1', out])
  if (existsSync(out)) notes.push('字幕带 ' + basename(out) + ' ' + String(Math.round(statSync(out).size / 1024)) + 'KB')
}
// 接缝帧：每个 cut 前后各 1 帧
for (const c of cuts.slice(0, 40)) {
  for (const [side, at] of [['out', Math.max(0, c - 0.12)], ['in', c + 0.12]]) {
    const out = join(OUT, 'cut-' + c.toFixed(2) + '-' + side + '.png')
    run(['-hide_banner', '-y', '-ss', at.toFixed(3), '-i', film, '-frames:v', '1', out])
  }
}
notes.push('接缝帧已导出 ' + String(Math.min(cuts.length, 40)) + ' 个切点 ×2')
writeFileSync(join(OUT, 'report.txt'), notes.join('\n'), 'utf8')
console.log(notes.join('\n'))
console.log('OUT=' + OUT)
