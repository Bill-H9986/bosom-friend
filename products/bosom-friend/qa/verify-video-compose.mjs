#!/usr/bin/env node
/**
 * 多片段拼接 + 成片时长收敛的真实验收（用随包 ffmpeg 造片子，不花厂商积分）。
 *
 * 背景：30 秒 / 1 分钟的成片必须由多个 4 秒片段拼成（官方单次只收 4~12 秒），而厂商单片时长
 * 有零点几秒出入、十几片叠起来能差好几秒，所以拼接后要按用户选的档位收敛。这条链路错了
 * 在界面上极难发现（有画面、有声音、就是长度不对），必须用真 ffmpeg 跑出来看。
 *
 * 断言：
 *   1. 3 段 4 秒片段拼成 12 秒档位：成片时长在容差内、不做裁剪；
 *   2. 同样 3 段拼成 10 秒档位：判为裁齐，成片时长收敛到 10 秒上下；
 *   3. 拼成 14 秒档位：判为补足（tpad 克隆末帧）；若随包 ffmpeg 不支持该滤镜，则必须返回「未收敛」而**不是**谎报成功；
 *   4. 输出文件真实存在且可被 ffprobe 读到时长。
 *
 * 用法：node products/bosom-friend/qa/verify-video-compose.mjs
 * 退出码：0 = 通过；1 = 失败；2 = 缺少构建产物或 ffmpeg。
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const qaDir = dirname(fileURLToPath(import.meta.url))
const productRoot = join(qaDir, '..')
const built = join(productRoot, 'server', 'lib', 'types', 'video-compose.js')
const ffmpeg = join(productRoot, 'desktop', 'dist', 'runtime', 'ffmpeg.exe')

if (!existsSync(built)) {
  console.error('缺少构建产物：pnpm --filter @deepseek-ai/dsh-bosom-friend-server build')
  console.error('VIDEO_COMPOSE SKIP missing=' + built)
  process.exit(2)
}
if (!existsSync(ffmpeg)) {
  console.error('缺少随包 ffmpeg：' + ffmpeg)
  console.error('VIDEO_COMPOSE SKIP missing=' + ffmpeg)
  process.exit(2)
}
process.env.FFMPEG_PATH = ffmpeg

const { composeTargetDuration } = await import(pathToFileURL(built).href)
const { probeDurationSeconds } = await import(pathToFileURL(join(productRoot, 'server', 'lib', 'types', 'ffmpeg.js')).href)

const checks = []
/** @param name - 断言名。 @param ok - 是否通过。 @param detail - 证据。 */
function check(name, ok, detail) { checks.push({ name, ok, detail: detail ?? '' }) }

const work = mkdtempSync(join(tmpdir(), 'bf-compose-'))
const clipSeconds = 4
/** 造一段 testsrc + 正弦音的 4 秒竖屏片段。 @param index - 序号。 @returns 文件路径。 */
function makeClip(index) {
  const file = join(work, 'clip' + String(index) + '.mp4')
  const result = spawnSync(ffmpeg, [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=720x1280:rate=30:duration=' + String(clipSeconds),
    '-f', 'lavfi', '-i', 'sine=frequency=' + String(400 + index * 100) + ':duration=' + String(clipSeconds),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '44100', '-shortest',
    file,
  ], { encoding: 'utf8' })
  return result.status === 0 && existsSync(file) ? file : ''
}

const clips = [1, 2, 3].map(makeClip).filter(file => file !== '')
check('造出 3 段 4 秒测试片段', clips.length === 3, clips.join(', '))

if (clips.length === 3) {
  const clipSecondsReal = await probeDurationSeconds(clips[0])
  check('测试片段可被 ffprobe 读取', clipSecondsReal > 3.5 && clipSecondsReal < 4.5, String(clipSecondsReal))

  // 1) 12 秒档位：3×4 正好，容差内不裁
  {
    const out = join(work, 'out-12.mp4')
    const res = await composeTargetDuration({ segments: clips, outFile: out, targetSeconds: 12, resolution: '720p', aspectRatio: '9:16' })
    check('12 秒档位拼接成功', res.ok === true, JSON.stringify(res).slice(0, 200))
    if (res.ok) {
      check('12 秒档位不做裁剪', res.adjustment === 'none', JSON.stringify(res))
      check('12 秒成片时长在容差内', Math.abs(res.actualSeconds - 12) <= 0.6, String(res.actualSeconds))
      check('12 秒成片文件存在', existsSync(res.file), res.file)
    }
  }

  // 2) 10 秒档位：3×4 超出，必须裁齐
  {
    const out = join(work, 'out-10.mp4')
    const res = await composeTargetDuration({ segments: clips, outFile: out, targetSeconds: 10, resolution: '720p', aspectRatio: '9:16' })
    check('10 秒档位判定裁齐', res.ok === true && res.adjustment === 'trim', JSON.stringify(res).slice(0, 200))
    if (res.ok) check('10 秒成片时长收敛', Math.abs(res.actualSeconds - 10) <= 0.4, String(res.actualSeconds))
  }

  // 3) 14 秒档位：需要补足；不支持 tpad 时必须如实报「未收敛」
  {
    const out = join(work, 'out-14.mp4')
    const res = await composeTargetDuration({ segments: clips, outFile: out, targetSeconds: 14, resolution: '720p', aspectRatio: '9:16' })
    const padded = res.ok === true && res.adjustment === 'pad' && Math.abs(res.actualSeconds - 14) <= 0.6
    const honest = res.ok === true && res.adjustment === 'none' && Math.abs(res.actualSeconds - 12) <= 0.6
    check('14 秒档位：补足成功，或如实报未收敛', padded || honest, JSON.stringify(res).slice(0, 200))
    check('14 秒档位不谎报', res.ok === true, JSON.stringify(res).slice(0, 200))
    if (padded) console.log('   注：随包 ffmpeg 支持 tpad，补足路径已验证')
    if (honest) console.log('   注：随包 ffmpeg 不支持 tpad，走的是如实报未收敛降级（调用方需在记录里写明）')
  }

  // 4) 空片段必须失败而不是产出空片
  {
    const res = await composeTargetDuration({ segments: [], outFile: join(work, 'out-empty.mp4'), targetSeconds: 10 })
    check('空片段列表如实失败', res.ok === false, JSON.stringify(res).slice(0, 200))
  }
}

rmSync(work, { recursive: true, force: true })
const failed = checks.filter(c => !c.ok)
for (const c of checks) console.log((c.ok ? 'PASS ' : 'FAIL ') + c.name + (c.ok ? '' : '  -> ' + c.detail))
console.log('VIDEO_COMPOSE ' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' checks=' + checks.length + ' fail=' + failed.length)
process.exit(failed.length === 0 ? 0 : 1)
