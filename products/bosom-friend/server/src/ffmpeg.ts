/**
 * ffmpeg 定位与调用：媒体合成（拼接、字幕、缩略图、时长探测）共用的唯一出口。
 *
 * 产品把 ffmpeg 随包内置（装机版 `resources/runtime/ffmpeg.exe`，桌面壳经 `FFMPEG_PATH` 指定），
 * 因此一律不依赖用户机器装过 ffmpeg；开发态 `desktop/dist` 未构建时用 `FFMPEG_PATH` 覆盖。
 * @module @deepseek-ai/dsh-bosom-friend-server/ffmpeg
 */

import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { trackChild } from './platform-processes.ts'

/** 找可用的 ffmpeg：优先环境变量，其次本产品依赖/常见安装目录，最后 PATH。 */
export function ffmpegExecutable(): string {
  const candidates = [
    process.env.FFMPEG_PATH ?? '',
    // 编译产物位于 lib/types，层级以编译后位置为准（src 相对路径在 lib 下会错一级，9/7 实测修复）
    join(dirname(fileURLToPath(import.meta.url)), '../../../desktop/dist/runtime/ffmpeg.exe'),
    join(dirname(fileURLToPath(import.meta.url)), '../../../project/bosom-friend-electron/node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe'),
    join(dirname(fileURLToPath(import.meta.url)), '../../project/bosom-friend-electron/node_modules/@ffmpeg-installer/ffmpeg/ffmpeg.exe'),
    join(dirname(fileURLToPath(import.meta.url)), '../../project/bosom-friend-electron/node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe'),
    'C:/Users/Jay/.workbuddy/binaries/ffmpeg/ffmpeg.exe',
    'C:/Program Files/ffmpeg/bin/ffmpeg.exe',
    'ffmpeg',
  ]
  return candidates.find(candidate => candidate !== '' && (candidate === 'ffmpeg' || existsSync(candidate))) ?? 'ffmpeg'
}

/** 一次 ffmpeg 调用的结果：退出码与合并后的输出（ffmpeg 把绝大多数诊断写在 stderr）。 */
export interface FfmpegResult {
  ok: boolean
  output: string
  /** 进程没起来（找不到可执行文件）时为 true，调用方据此报「缺组件」而不是「转码失败」。 */
  spawnFailed: boolean
}

/** 一次 ffmpeg 调用的选项。 */
export interface FfmpegOptions {
  /** 超时毫秒数，超时按失败处理并杀掉进程。 */
  timeoutMs?: number
  /**
   * 进程工作目录。
   *
   * 主要给滤镜里的相对文件名用：Windows 绝对路径在 `subtitles`/`ass` 滤镜参数里要转义
   * 冒号与反斜杠，极易写错；把工作目录切到文件所在目录、只传文件名就没有这个问题。
   */
  cwd?: string
}

/**
 * 跑一次 ffmpeg 并回收输出。
 *
 * 与 `platform-login` 里那个丢弃输出的 `runCommand` 分开：诊断与时长探测都要读 stderr，
 * 把输出吞掉会让「转码失败」变成一句没有原因的黑箱。
 *
 * @param args - ffmpeg 参数（不含可执行文件本身）。
 * @param options - 超时与工作目录；只传数字时按超时处理（兼容旧调用）。
 * @returns 退出码、输出与「进程没起来」标记。
 */
export function runFfmpeg(args: string[], options: FfmpegOptions | number = {}): Promise<FfmpegResult> {
  const { timeoutMs = 180_000, cwd } = typeof options === 'number' ? { timeoutMs: options } : options
  return new Promise(resolve => {
    let output = ''
    let settled = false
    const done = (result: FfmpegResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = trackChild(spawn(ffmpegExecutable(), args, { windowsHide: true, ...(cwd !== undefined ? { cwd } : {}) }))
    }
    catch (error) {
      resolve({ ok: false, output: String(error), spawnFailed: true })
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      done({ ok: false, output: output + '\n[ffmpeg 超时 ' + String(timeoutMs) + 'ms]', spawnFailed: false })
    }, timeoutMs)
    child.stdout?.on('data', chunk => { output += String(chunk) })
    child.stderr?.on('data', chunk => { output += String(chunk) })
    child.on('error', error => done({ ok: false, output: output + '\n' + String(error), spawnFailed: true }))
    child.on('exit', code => done({ ok: code === 0, output, spawnFailed: false }))
  })
}

/**
 * 读媒体文件的真实时长（秒）。
 *
 * 时长以文件里的实际数据为准，不用字数估算：分段生成的 `seconds` 必须等于音频真实秒数，
 * 估算偏差会把口型和配音在段内拉开。
 *
 * @param file - 本地媒体文件路径。
 * @returns 真实时长（秒）；读不出来返回 0，调用方据此判失败而不是当成 0 秒继续。
 */
export async function probeDurationSeconds(file: string): Promise<number> {
  const result = await runFfmpeg(['-hide_banner', '-i', file], 30_000)
  const match = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(result.output)
  if (match === null) return 0
  const [, hours, minutes, seconds] = match
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)
}
