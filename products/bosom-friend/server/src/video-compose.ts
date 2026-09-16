/**
 * 成片拼接：把逐段生成的数字人短视频拼成一条完整长视频。
 *
 * 单次视频生成有 4~12 秒硬上限，长口播只能分段做再拼——拼接因此是这条产品线的关键工序，
 * 不是收尾的小工具。两件事必须由这里保证：
 * 1. 各段画布统一：厂商不同模式/不同素材会返回 704x1280、720x1280 等不同尺寸（实测），
 *    直接 concat 会报错或花屏，所以每段先缩放到目标画布再居中补边；
 * 2. 各段编码统一：重编码而不是 `-c copy`，避免各段时间基差异在接缝处产生卡顿。
 * @module @deepseek-ai/dsh-bosom-friend-server/video-compose
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pixelFor } from './image-ratio.ts'
import { runFfmpeg } from './ffmpeg.ts'

/** 一条字幕：文本与它在成片时间轴上的起止秒数。 */
export interface SubtitleCue {
  text: string
  startSeconds: number
  endSeconds: number
}

/** 拼接参数。 */
export interface ComposeOptions {
  /** 按播放顺序排列的本地视频文件。 */
  segments: string[]
  /** 成片输出路径（绝对路径）。 */
  outFile: string
  /** 画布档位（720p / 1080p），与产品其它生成参数同一口径。 */
  resolution?: string
  /** 画布画幅（9:16 等）。 */
  aspectRatio?: string
  /** 要烧进画面的字幕；缺省不烧。 */
  subtitles?: SubtitleCue[]
}

/** 烧字幕用的固定文件名：切到输出目录后按相对名引用，避开 Windows 路径在滤镜里的转义。 */
const SUBTITLE_FILENAME = 'long-video-subs.ass'
/** 字幕字体：Windows 自带且中文覆盖完整；缺字体时由 fontconfig 回退。 */
const SUBTITLE_FONT = 'Microsoft YaHei'

/** 单条字幕最多几行：多于此就拆成下一条，避免一条字幕糊满半个画面。 */
const SUBTITLE_MAX_LINES = 2

/**
 * 把长字幕条切成能完整显示的短条。
 *
 * 实测（720x1280, 字号 54）：libass 对纯中文长句**不自动换行**，49 字的口播会渲染成一整行
 * 并被画面左右切掉——这是"字幕看着有、内容却是残的"最典型的一种。所以断行由我们自己做：
 * 先按画布算出每行能放几个字，再按"每行字数 × 最多行数"把长条切成多条，时间按字数平均分配。
 *
 * @param cues - 原始字幕条。
 * @param canvas - 成片画布像素。
 * @param fontSize - 字号（与样式同一口径）。
 * @param marginH - 左右边距。
 * @returns 每条都能完整放进画面的字幕条。
 */
export function paginateCues(cues: SubtitleCue[], canvas: { width: number, height: number }, fontSize: number, marginH: number): SubtitleCue[] {
  const charsPerLine = Math.max(4, Math.floor((canvas.width - marginH * 2) / fontSize))
  const perCue = charsPerLine * SUBTITLE_MAX_LINES
  const paginated: SubtitleCue[] = []
  for (const cue of cues) {
    const text = cue.text.trim()
    if (text === '' || cue.endSeconds <= cue.startSeconds) continue
    const chunks: string[] = []
    for (let i = 0; i < text.length; i += perCue) chunks.push(text.slice(i, i + perCue))
    const slice = (cue.endSeconds - cue.startSeconds) / chunks.length
    chunks.forEach((chunk, index) => {
      // 手动断行：每 charsPerLine 个字插一个 ASS 换行符，libass 只负责画。
      const lines: string[] = []
      for (let i = 0; i < chunk.length; i += charsPerLine) lines.push(chunk.slice(i, i + charsPerLine))
      paginated.push({
        text: lines.join('\n'),
        startSeconds: cue.startSeconds + slice * index,
        endSeconds: cue.startSeconds + slice * (index + 1),
      })
    })
  }
  return paginated
}

/** `秒` → ASS 时间戳 `H:MM:SS.cc`。 */
function assTime(seconds: number): string {
  const safe = Math.max(0, seconds)
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const rest = safe % 60
  return String(hours) + ':' + String(minutes).padStart(2, '0') + ':' + rest.toFixed(2).padStart(5, '0')
}

/** 文本进 ASS 前先清掉会被当作特效标签的大括号，并把换行折成 `\N`。 */
function assText(text: string): string {
  return text.replace(/[{}]/g, '').replace(/\r?\n/g, '\\N').trim()
}

/**
 * 生成 ASS 字幕。
 *
 * 不用 SRT + `subtitles` 滤镜：SRT 转 ASS 时的 PlayRes 与字号由 libass 自己决定，
 * 同一份字幕在不同分辨率成片上会忽大忽小；这里把 PlayRes 钉成成片画布，
 * 字号就是画布上的真实像素比例，720p 与 1080p 出来的观感一致。
 *
 * @param cues - 字幕条（起止秒数已换算到成片时间轴）。
 * @param canvas - 成片画布像素。
 * @returns ASS 文件全文；没有字幕条时返回空串。
 */
export function buildAssSubtitles(cues: SubtitleCue[], canvas: { width: number, height: number }): string {
  // 字号按画布高的 4.2% 定：竖屏短视频的常见可读尺寸，且随档位等比变化。
  const fontSize = Math.max(18, Math.round(canvas.height * 0.042))
  const marginV = Math.round(canvas.height * 0.08)
  const marginH = Math.round(canvas.width * 0.06)
  const usable = paginateCues(cues, canvas, fontSize, marginH)
  if (usable.length === 0) return ''
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    // 1 = 按行宽任意断行。中文没有空格：0（智能换行）只在空格处折行，一句 17 字的口播
    // 会整行顶到画面边框外；2（不换行）更糟。实测只有 1 能把中文折进左右边距里。
    'WrapStyle: 1',
    'ScaledBorderAndShadow: yes',
    'PlayResX: ' + String(canvas.width),
    'PlayResY: ' + String(canvas.height),
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,' + SUBTITLE_FONT + ',' + String(fontSize)
      + ',&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,'
      + String(Math.max(2, Math.round(fontSize * 0.06))) + ',0,2,'
      + String(marginH) + ',' + String(marginH) + ',' + String(marginV) + ',1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...usable.map(cue => 'Dialogue: 0,' + assTime(cue.startSeconds) + ',' + assTime(cue.endSeconds)
      + ',Default,,0,0,0,,' + assText(cue.text)),
    '',
  ].join('\n')
}

/** 拼接结果：成功给出成片路径，失败给出可读原因。 */
export type ComposeResult = { ok: true, file: string } | { ok: false, error: string }

/**
 * 把多段视频拼成一条。
 *
 * @param options - 分段文件、输出路径与目标画布。
 * @returns 成片路径或失败原因。
 */
export async function composeSegments(options: ComposeOptions): Promise<ComposeResult> {
  const { segments, outFile } = options
  if (segments.length === 0) return { ok: false, error: '没有可拼接的片段' }
  const canvas = canvasFor(options)
  const outDir = dirname(outFile)
  mkdirSync(outDir, { recursive: true })
  // 字幕落在成片同目录，随后切到该目录用相对名引用（避开 Windows 路径在滤镜里的转义）。
  const ass = buildAssSubtitles(options.subtitles ?? [], canvas)
  if (ass !== '') writeFileSync(join(outDir, SUBTITLE_FILENAME), ass, 'utf8')
  // 两条路径（单段转码与多段拼接）共用同一条滤镜链，产出规格与字幕效果一致。
  const filter = canvasFilter(canvas) + (ass === '' ? '' : ',' + subtitleFilter())
  const encode = [
    '-vf', filter,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-ar', '32000',
    '-movflags', '+faststart',
    outFile,
  ]
  const result = segments.length === 1
    ? await runFfmpeg(['-y', '-i', segments[0]!, ...encode], { timeoutMs: 30 * 60_000, cwd: outDir })
    : await runFfmpeg([
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatListFile(outDir, segments),
      ...encode,
    ], { timeoutMs: 30 * 60_000, cwd: outDir })
  if (!result.ok) return { ok: false, error: describeFfmpeg(result.output, result.spawnFailed) }
  return { ok: true, file: outFile }
}

/** 写 concat demuxer 清单并返回其路径；路径里的单引号按该格式要求转义。 */
function concatListFile(outDir: string, segments: string[]): string {
  const listFile = join(outDir, 'concat-list.txt')
  writeFileSync(listFile, segments.map(file => "file '" + file.replaceAll("'", "'\\''") + "'").join('\n') + '\n', 'utf8')
  return listFile
}

/** 字幕滤镜：按相对文件名引用成片同目录的 ASS。 */
function subtitleFilter(): string {
  return 'ass=' + SUBTITLE_FILENAME
}

/** 目标画布像素；档位/画幅不认识时回退 720p 竖屏（产品默认口径）。 */
function canvasFor(options: ComposeOptions): { width: number, height: number } {
  const size = pixelFor(options.resolution ?? '720p', options.aspectRatio ?? '9:16')
    || pixelFor('720p', '9:16')
  const [width, height] = size.split('x').map(Number)
  return { width: width ?? 720, height: height ?? 1280 }
}

/** 等比缩放 + 居中补边，保证任意输入尺寸都能落到同一画布。 */
function canvasFilter(canvas: { width: number, height: number }): string {
  return 'scale=' + String(canvas.width) + ':' + String(canvas.height)
    + ':force_original_aspect_ratio=decrease,'
    + 'pad=' + String(canvas.width) + ':' + String(canvas.height) + ':(ow-iw)/2:(oh-ih)/2'
}

/** 把 ffmpeg 输出压成一句人话，并区分「本机没有 ffmpeg」与「转码失败」。 */
function describeFfmpeg(output: string, spawnFailed: boolean): string {
  if (spawnFailed) return '本机找不到 ffmpeg，无法合成视频（请重新运行安装包完成修复安装）'
  const lastLine = output.trim().split('\n').filter(Boolean).slice(-1)[0] ?? ''
  return '视频合成失败：' + lastLine.slice(0, 200)
}
