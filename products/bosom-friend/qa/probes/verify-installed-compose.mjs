/**
 * 装机版最终验证：用**已安装运行时**里的服务端代码 + 随包 ffmpeg 真跑一次拼接与字幕烧录。
 *
 * 为什么不能只用源码态测试：字体路径、ffmpeg 定位在"编译产物旁边"与"源码旁边"解析结果不同，
 * 源码态全绿恰恰掩盖了装机版的退化（DEF-071 就是这么漏到出包前的）。
 *
 * @module qa/probes/verify-installed-compose
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = process.env.APPDATA ?? ''
const runtime = join(home, 'Bosom Friend', 'kernel-runtime')
const installed = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Bosom Friend')
const server = join(runtime, 'node_modules', '@deepseek-ai', 'dsh-bosom-friend-server')
console.log('服务端代码 =', server, existsSync(server))
process.env.FFMPEG_PATH = join(installed, 'resources', 'runtime', 'ffmpeg.exe')
console.log('随包 ffmpeg =', process.env.FFMPEG_PATH, existsSync(process.env.FFMPEG_PATH))

// Windows 绝对路径要转成 file:// URL，ESM 才肯加载。
const { pathToFileURL } = await import('node:url')
const { runFfmpeg, ffmpegExecutable } = await import(pathToFileURL(join(server, 'lib', 'types', 'ffmpeg.js')).href)
const { composeSegments } = await import(pathToFileURL(join(server, 'lib', 'types', 'video-compose.js')).href)
console.log('解析到的 ffmpeg =', ffmpegExecutable())

const dir = mkdtempSync(join(tmpdir(), 'bf-installed-'))
const src = join(dir, 'src.mp4')
const made = await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc=size=720x1280:rate=24:duration=4',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src], 120000)
console.log('造素材 =', made.ok)
const out = join(dir, 'out.mp4')
const res = await composeSegments({
  segments: [src], outFile: out, resolution: '1080p', aspectRatio: '9:16',
  subtitles: [{ text: '装机版字幕验证', startSeconds: 0, endSeconds: 4 }],
  segmentDurations: [4],
})
console.log('装机版拼接 =', res.ok, res.ok ? '' : res.error)
console.log('字体随成片复制 =', existsSync(join(dir, 'long-video-font.ttf')))
if (res.ok) {
  const info = await runFfmpeg(['-hide_banner', '-i', out], 30000)
  const line = info.output.split('\n').find(l => l.includes('Video: h264')) ?? ''
  console.log('成片规格 =', line.trim())
}
rmSync(dir, { recursive: true, force: true })
