/**
import { join } from 'node:path'
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

/**
 * 相对本模块位置向上走 N 层目录。
 *
 * 不用 `join(here, '../../..')`：**join 会归一化路径**，从 `server/src` 出发的
 * `'../../..'` 只爬了两层（`..` 吃掉了 `src` 这一级），实测会算出
 * `products/desktop/...` 这种不存在的路径，于是随包 ffmpeg 永远找不到
 * （症状是拼接一路走 PATH，源码态直接判"本机没有 ffmpeg"）。逐级 `dirname` 才不会数错。
 *
 * @param start - 起始目录。
 * @param levels - 向上层数。
 * @returns 上溯后的目录。
 */
function up(start: string, levels: number): string {
  let current = start
  for (let i = 0; i < levels; i++) current = dirname(current)
  return current
}

/**
 * 本模块可能所在的两种位置对应的 `products/bosom-friend/`：源码态与编译态。
 *
 * 编译产物在 `server/lib/types/`（3 层），源码在 `server/src/`（2 层）——
 * 两处深度不同，各展开一次，于是**两种运行方式都能找到随包 ffmpeg**。
 *
 * @returns 候选产品根目录（源码态在前：开发机上优先）。
 */
function productRootCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url))
  return [up(here, 3), up(here, 2)]
}

/**
 * 从模块位置逐级上溯，找同一个仓库相对路径。
 *
 * 为什么不能只算固定层数：模块可能有好几套深度——源码态 server/src（2 层）、编译态
 * server/lib/types（3 层）、开发态真正加载的 pnpm 注入副本更深。固定层数一旦算错，
 * 开发态就报“本机缺少 ffmpeg”，长视频配音时长读不出来（实测 2026-09-17：开发端续跑
 * 长视频在第 16 镜停下，原因正是这句）。
 *
 * @param relative - 相对仓库根的路径，用斜杠分段。
 * @param levels - 最多上溯几层。
 * @returns 逐层候选路径（由近到远）。
 */
function upwardCandidates(relative: string, levels = 10): string[] {
  const out: string[] = []
  let current = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < levels; i++) {
    current = dirname(current)
    out.push(join(current, ...relative.split('/')))
  }
  return out
}

/** 找可用的 ffmpeg：优先环境变量，其次随包运行时/依赖目录，最后 PATH。 */
export function ffmpegExecutable(): string {
  const fromRoot = (suffix: string): string[] => productRootCandidates().map(root => join(root, suffix))
  const candidates = [
    process.env.FFMPEG_PATH ?? '',
    ...fromRoot('desktop/dist/runtime/ffmpeg.exe'),
    ...upwardCandidates('products/bosom-friend/desktop/dist/runtime/ffmpeg.exe'),
    ...fromRoot('project/bosom-friend-electron/node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe'),
    ...fromRoot('project/bosom-friend-electron/node_modules/@ffmpeg-installer/ffmpeg/ffmpeg.exe'),
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

/**
 * 探一镜成片的**画布与帧率**。
 *
 * 服务于 Agnes 官方 create-video 的「先验证再批量」：在重复一套昂贵的生成配置之前，
 * 先用**一镜代表性样本**确认返回时长、尺寸、帧率与运动，并把**观察到的结果当作权威**。
 * 我们逐镜串行，第一镜天然就是那个样本——把它的真实画布记下来，与请求的画布对不上就当场告警，
 * 而不是等十几镜生成完、拼接时才发现画幅不一致（拼接层在接缝处会花屏）。
 *
 * @param file - 成片文件路径。
 * @returns 宽高与帧率；解不出来时 width/height 为 0。
 */
export async function probeVideoGeometry(file: string): Promise<{ width: number, height: number, fps: number }> {
  const result = await runFfmpeg(['-hide_banner', '-i', file], 30_000)
  const m = /Video:.*?,\s*(\d{2,5})x(\d{2,5})/.exec(result.output)
  const f = /(\d+(?:\.\d+)?)\s*fps/.exec(result.output)
  return {
    width: m === null ? 0 : Number(m[1]),
    height: m === null ? 0 : Number(m[2]),
    fps: f === null ? 0 : Number(f[1]),
  }
}

/**
 * 抽一镜的**验收证据帧**：按官方 quality-review 的口径覆盖开头、中段、结尾，
 * 再各多抽一帧形成联系表，供人眼（或后续的视觉模型）核对这一镜是否真的拍出了目的。
 *
 * 为什么不能只 probe：`probe` 只能证明文件可解码，证明不了画面里有什么。
 * 官方原话是「A contact sheet does not prove motion, audio, timing, identity,
 * or cut-boundary quality」——但反过来说，**连联系表都不看就标 accepted 更没依据**。
 * 这里抽 3 帧（20% / 50% / 80%）落到 workDir，路径写进镜头的 evidence。
 *
 * @param input - 源视频路径。
 * @param workDir - 输出目录。
 * @param tag - 文件名前缀（通常是镜号）。
 * @param seconds - 视频时长（秒）；<=0 时按 5 秒估。
 * @returns 抽到的帧路径数组（可能少于 3 张：抽不出的位置直接跳过，不编造）。
 */
export async function extractEvidenceFrames(input: string, workDir: string, tag: string, seconds: number): Promise<string[]> {
  const total = seconds > 0 ? seconds : 5
  const ratios = [0.2, 0.5, 0.8]
  const out: string[] = []
  for (let i = 0; i < ratios.length; i += 1) {
    // 抽帧点夹在 [0.1, 总长-0.1]：太靠边会因为编码器首尾帧为空而拿到空图。
    const at = Math.min(Math.max(total * ratios[i]!, 0.1), Math.max(0.1, total - 0.1))
    const file = join(workDir, 'ev-' + tag + '-' + String(i + 1) + '.png')
    await runFfmpeg(['-hide_banner', '-y', '-ss', at.toFixed(2), '-i', input, '-frames:v', '1', file], 30_000)
    if (existsSync(file)) out.push(file)
  }
  return out
}

/**
 * 抽出视频的**最后一帧**并存成 PNG。
 *
 * 用途是 Agnes 官方 create-video 规范的连续性策略：相邻镜被标为 continuous（同一动作跨镜延续）时，
 * 把前一镜的尾帧作为下一镜的首帧参考送进厂商，画面才接得上——官方口径是
 * 「identity、composition、wardrobe、prop state、location 重要时，先接受一张首帧参考再做图生视频」。
 *
 * 为什么用 -sseof 而不是 -ss：-ss 是「定位到第 N 秒」，4~6 秒的短视频上取到的是中间帧；
 * -sseof 从**文件末尾**回退，才真的是尾帧。回退 0.1 秒是为了避开部分编码器为空的最后一帧
 * （与抽首帧时定位到 0.1 秒同一个道理）。
 *
 * @param input - 源视频路径。
 * @param outputFile - 成品 PNG 路径。
 * @returns 成功返回成品路径，失败返回空串（调用方退回不接帧的常规生成，不硬凑）。
 */
export async function extractTailFrame(input: string, outputFile: string): Promise<string> {
  await runFfmpeg(['-hide_banner', '-y', '-sseof', '-0.1', '-i', input, '-frames:v', '1', outputFile], 30_000)
  return existsSync(outputFile) ? outputFile : ''
}

export async function probeDurationSeconds(file: string): Promise<number> {
  const result = await runFfmpeg(['-hide_banner', '-i', file], 30_000)
  const match = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(result.output)
  if (match === null) return 0
  const [, hours, minutes, seconds] = match
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)
}
