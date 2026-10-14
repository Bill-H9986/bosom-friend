/**
 * 成片拼接：把逐镜生成的短视频拼成一条完整长视频，并做统一后期。
 *
 * 单次视频生成有 4~12 秒硬上限，长口播只能分段做再拼——拼接因此是这条产品线的关键工序，
 * 不是收尾的小工具。这里保证四件事：
 * 1. **各镜画布统一**：厂商不同模式/不同素材会返回 704x1280、720x1280 等不同尺寸（实测），
 *    直接 concat 会报错或花屏，所以每镜先缩放到目标画布再居中补边；
 * 2. **接缝不硬切**：镜与镜之间各做一次很短的淡出/淡入（{@link DIP_SECONDS}），接缝处是一次暗场剪辑点，
 *    不是一次跳变（交叉溶解用不了：随包 ffmpeg 没有 `xfade` 滤镜，且它会让成片时长小于各镜之和）；
 * 3. **后期统一**：全片同一套色调与响度（各镜独立生成必然色温/音量各飘各的）；
 * 4. **字幕跟着真实时间轴走**：字幕条给的是**成片时间轴上的绝对秒数**（口径与各镜真实时长累加一致）。
 *    黑场过渡不重叠——淡出与淡入各占本镜自己的时间——所以这一层只烧字幕、不挪时间轴。
 * @module @deepseek-ai/dsh-bosom-friend-server/video-compose
 */

import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pixelFor } from './image-ratio.ts'
import { probeDurationSeconds, runFfmpeg } from './ffmpeg.ts'
import { conformAction } from './video-duration.ts'

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
  /**
   * 要烧进画面的字幕；缺省不烧。
   *
   * 秒数是**成片时间轴**上的绝对时间（0 = 成片开头），与 {@link ComposeOptions.segmentDurations}
   * 的累加口径一致。这一层只按给定时间烧字幕、不做任何平移：黑场过渡不缩短任何一镜，
   * "各镜时长累加"本来就是成片时间轴。调用方若把相对某镜的秒数传进来，
   * {@link subtitleTimelineProblems} 会在拼接前报出来。
   */
  subtitles?: SubtitleCue[]
  /**
   * 各镜的真实时长（秒），与 segments 一一对应。
   *
   * 成片时间轴（以及字幕是否落在成片之内）都要用它；缺省时由本模块用 ffprobe 逐个读文件补上
   * （宁可多花一次探测，也不让调用方为了对齐而重复算时长）。
   */
  segmentDurations?: number[]
}

/**
 * 镜间过渡时长（秒）：每镜收尾淡出、下一镜起手淡入，中间形成一次很短的"黑场过渡"。
 *
 * 为什么不是交叉溶解（xfade）：**随包 ffmpeg 是 2018 年的构建，没有 xfade 这个滤镜**
 * （实测 `No such filter: 'xfade'`，该滤镜 2020 年才进入 ffmpeg）。这是必须跑真 ffmpeg 才能发现的事，
 * 纯单元测试（桩拼接）永远看不出来。
 *
 * 黑场过渡反而更适合逐镜拼接：它**不重叠**，所以成片时长等于各镜之和、字幕时间轴不用平移
 * （交叉溶解每次会吃掉一个过渡时长，字幕要按转场后的时间轴重算，误差会累计）。
 * 0.18 秒（约 4 帧）足够打断"同一张脸硬切"的突兀感，又短到不影响节奏。
 */
export const DIP_SECONDS = 0.18

/**
 * 后期色彩：**逐镜**先做一级校正，再走全片统一的一套轻度调色。
 *
 * 一级校正用 `normalize` 且 `independence=0`：按**整段**统计而不是逐帧，
 * 于是每镜各自的黑场/白场被拉到同一基准——各镜独立生成必然曝光与白平衡不齐
 * （同一场景有时冷有时暖、有时偏暗），跨镜色调跳跃是 AI 片最明显的"廉价感"来源。
 */
const COLOR_FILTER = 'normalize=blackpt=black:whitept=white:smoothing=10:independence=0,eq=contrast=1.06:saturation=1.04'

/**
 * 后期响度：统一到 -16 LUFS。
 *
 * 各镜独立生成必然音量不齐（厂商每镜的配音与环境音电平不同），音量忽大忽小是廉价感最明显的来源之一。
 */
const LOUDNESS_FILTER = 'loudnorm=I=-16:TP=-1.5:LRA=11'

/** 烧字幕用的固定文件名：切到输出目录后按相对名引用，避开 Windows 路径在滤镜里的转义。 */
const SUBTITLE_FILENAME = 'long-video-subs.ass'

/** 字幕字体：复制到成片同目录，用 fontsdir 让 libass 直接读文件（不依赖用户装没装字体）。 */
const SUBTITLE_FONT_FILENAME = 'long-video-font.ttf'
/**
 * ASS 里写的字体名：必须与字体文件内部的 family name **逐字一致**，libass 才选得中。
 *
 * 实测踩过：写成 `Source Han Sans CN`（少了一个 ` Regular`）时 libass 不报错，
 * 而是**静默回退**到系统里的 Microsoft YaHei——字幕照常烧出来，只是字体悄悄换了。
 * 真名从字体文件的 name 表里读出（`Source Han Sans CN Regular`），不是猜的。
 */
const SUBTITLE_FONT = 'Source Han Sans CN Regular'
/** 随服务端分发的字幕字体文件名（思源黑体，SIL OFL；中文可读性明显好于系统默认黑体）。 */
const SUBTITLE_FONT_FILE = 'SourceHanSansCN-Regular.ttf'

/**
 * 字幕字体文件：**逐个候选查存在，不靠数点**。
 *
 * 为什么不用单一相对路径：源码态与编译态的目录深度不同——
 * 源码在 `server/src/`（字体同级的 `src/assets/`），编译产物在 `server/lib/types/`（构建钩子把字体
 * 放在 `lib/assets/`），两种位置的"相对层级"根本不一样。用一个 `'./assets'` 或 `'../assets'`
 * 必然在其中一种下算错，而算错的后果是**静默退化**（拿不到就改用系统字体，字幕照烧但观感变了）。
 * 实测：装机版就因为这个差一级，字幕字体没生效。
 *
 * 候选顺序：同级 assets（源码态）→ 上一级 assets（编译态，构建钩子放这里）→ 再上一级（打包布局兜底）。
 */
const BUNDLED_FONT = [
  './assets/',
  '../assets/',
  '../../assets/',
].map(prefix => fileURLToPath(new URL(prefix + SUBTITLE_FONT_FILE, import.meta.url)))
  .find(candidate => existsSync(candidate)) ?? ''

/** 单条字幕最多几行：多于此就拆成下一条，避免一条字幕糊满半个画面。 */
const SUBTITLE_MAX_LINES = 2

/**
 * 把长字幕条切成能完整显示的短条。
 *
 * 实测（720x1280, 字号 54）：libass 对纯中文长句**不自动换行**，49 字的口播会渲染成一整行
 * 并被画面左右切掉——这是「字幕看着有、内容却是残的」最典型的一种。所以断行由我们自己做：
 * 先按画布算出每行能放几个字，再按「每行字数 x 最多行数」把长条切成多条，时间按字数平均分配。
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
    // 按**屏数**均分，而不是每屏固定切满 perCue 个字：
    // 45 字的台词按 44 字切会剩下 1 个字的孤条（「。」「服。」这种），
    // 它单独占一段时间，观感就是"字幕突然只剩一个句号"。
    // 先按屏数均分，再**尽量把断点移到标点上**：字幕换屏换在句子中间（如「…保湿成」/「分，能钻进…」）
    // 读起来像被切断；断在「，。！？；」之后才是自然换气点，断得开也不影响理解。
    const chunks: string[] = []
    let cursor = 0
    while (cursor < text.length) {
      const remaining = text.length - cursor
      const pagesLeft = Math.max(1, Math.ceil(remaining / perCue))
      const target = cursor + Math.ceil(remaining / pagesLeft)
      chunks.push(text.slice(cursor, target))
      cursor = target
    }
    for (let i = 0; i < chunks.length - 1; i += 1) {
      const current = chunks[i]!
      const next = chunks[i + 1]!
      const window = Math.max(2, Math.round(current.length * 0.3))
      for (let back = 0; back <= window; back += 1) {
        const cut = current.length - back
        if (cut < 4) break
        if (!'，。！？；：、'.includes(current[cut - 1]!)) continue
        chunks[i] = current.slice(0, cut)
        chunks[i + 1] = current.slice(cut) + next
        break
      }
    }
    const slice = (cue.endSeconds - cue.startSeconds) / chunks.length
    chunks.forEach((chunk, index) => {
      // 手动断行：每 charsPerLine 个字插一个 ASS 换行符，libass 只负责画。
      const lines: string[] = []
      for (let i = 0; i < chunk.length; i += charsPerLine) lines.push(chunk.slice(i, i + charsPerLine))
      paginated.push({
        text: lines.join("\n")
        , startSeconds: cue.startSeconds + slice * index
        , endSeconds: cue.startSeconds + slice * (index + 1)
      })
    })
  }
  return paginated
}

/** 秒 转 ASS 时间戳 H:MM:SS.cc。 */
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
  // 描边与投影：口播片常见浅色背景（白墙、米色墙），纯白字不加描边会糊在背景里看不清。
  const outline = Math.max(2, Math.round(fontSize * 0.08))
  const shadow = Math.max(1, Math.round(fontSize * 0.04))
  return [
    '[Script Info]'
    , 'ScriptType: v4.00+'
    // 1 = 按行宽任意断行。中文没有空格：0（智能换行）只在空格处折行，一句 17 字的口播
    // 会整行顶到画面边框外；2（不换行）更糟。实测只有 1 能把中文折进左右边距里。
    , 'WrapStyle: 1'
    , 'ScaledBorderAndShadow: yes'
    , 'PlayResX: ' + String(canvas.width)
    , 'PlayResY: ' + String(canvas.height)
    , ''
    , '[V4+ Styles]'
    , 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding'
    , 'Style: Default,' + SUBTITLE_FONT + ',' + String(fontSize)
      + ',&H00FFFFFF,&H000000FF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,'
      + String(outline) + ',' + String(shadow) + ',2,'
      + String(marginH) + ',' + String(marginH) + ',' + String(marginV) + ',1'
    , ''
    , '[Events]'
    , 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
    , ...usable.map(cue => 'Dialogue: 0,' + assTime(cue.startSeconds) + ',' + assTime(cue.endSeconds)
      + ',Default,,0,0,0,,' + assText(cue.text))
    , ''
  ].join('\n')
}

/**
 * 拼接结果：成功给出成片路径与**实际使用的各镜时长**，失败给出可读原因。
 *
 * 为什么要把时长回给调用方：成片时间轴就是各镜真实时长的累加，
 * 调用方要拿它对账（字幕是否落在成片之内），各算一遍就会走岔。
 */
export type ComposeResult =
  | { ok: true, file: string, segmentDurations: number[] }
  | { ok: false, error: string }

/**
 * 允许的字幕越界容差（秒）：两条时长各自四舍五入到毫秒之后的误差，不该被当成时间轴走岔。
 *
 * 真走岔的量级完全不是这个量级——实测那条字幕比口播晚一整句（4.4 秒起），
 * 末尾十几条直接落在成片之外（DEF-131）。0.05 秒既能容下舍入，又抓得住任何真实错位。
 */
export const SUBTITLE_TIMELINE_TOLERANCE_SECONDS = 0.05

/**
 * 字幕时间轴与成片时间轴对不上的地方。
 *
 * 为什么要有一条判据：字幕烧错不会报错，**表现出来只是"看起来不对"**——
 * 用户看到的是字幕比口播晚一句、后半段干脆不出现，而日志里一切正常。
 * 实测根因是把"按各镜真实时长累加"的绝对秒数又平移了一次（等同于每条字幕都加上了它自己的起点），
 * 于是第 2 条起每晚一整句，末尾十几条落在成片之外（DEF-131）。
 *
 * 判据只认**确定错**的形态：时长非正、起点为负、结束时间超出成片——这些字幕谁都看不到，
 * 不可能是设计意图。成片内部的重叠或留白是合法的（那是排版与节奏），不在这里判。
 *
 * @param cues - 待烧的字幕条（成片时间轴上的绝对秒数）。
 * @param filmSeconds - 成片总时长（各镜真实时长之和）。
 * @returns 每条问题的可读描述；全部合法时为空数组。
 */
export function subtitleTimelineProblems(cues: SubtitleCue[], filmSeconds: number): string[] {
  const problems: string[] = []
  const limit = Number.isFinite(filmSeconds) && filmSeconds > 0 ? filmSeconds : 0
  for (const [index, cue] of cues.entries()) {
    const label = '第 ' + String(index + 1) + ' 条字幕'
    if (!(cue.endSeconds > cue.startSeconds)) {
      problems.push(label + '时长非正（' + cue.startSeconds.toFixed(2) + '→' + cue.endSeconds.toFixed(2) + ' 秒）')
      continue
    }
    if (cue.startSeconds < -SUBTITLE_TIMELINE_TOLERANCE_SECONDS) {
      problems.push(label + '起点为负（' + cue.startSeconds.toFixed(2) + ' 秒）')
      continue
    }
    if (limit > 0 && cue.endSeconds > limit + SUBTITLE_TIMELINE_TOLERANCE_SECONDS) {
      problems.push(label + '落到成片之外（' + cue.startSeconds.toFixed(2) + '→' + cue.endSeconds.toFixed(2)
        + ' 秒，成片只有 ' + limit.toFixed(2) + ' 秒）')
    }
  }
  return problems
}

/**
 * 把字幕条裁到成片长度之内。
 *
 * 为什么要裁而不是只报错：成片长度由**厂商返回的每镜真实秒数**累加决定，而字幕条由编排层
 * 按各镜文件时长预先算好；两者在重做某一镜、或以目标档位裁齐之后会不一致。
 * 超出成片的字幕烧进去也没人看得到，裁剪让"能看到的都是对的"。
 *
 * 起点已经在片外的条整条丢弃：把它压成零长度会在成片上闪一帧字幕，比不显示更糟。
 * 结束时间刚好等于片长的条保留（合法：它在成片最后一帧结束）。
 *
 * @param cues - 待烧的字幕条（成片时间轴上的绝对秒数）。
 * @param filmSeconds - 成片总时长；读不出（0 / 非有限值）时原样返回，不做无依据的裁剪。
 * @returns 裁剪后的字幕条；没有被裁的条原样保留。
 */
export function clampCuesToFilm(cues: SubtitleCue[], filmSeconds: number): SubtitleCue[] {
  if (!Number.isFinite(filmSeconds) || filmSeconds <= 0) return cues
  const kept: SubtitleCue[] = []
  for (const cue of cues) {
    if (cue.startSeconds >= filmSeconds) continue
    kept.push(cue.endSeconds <= filmSeconds ? cue : { ...cue, endSeconds: filmSeconds })
  }
  return kept
}

/**
 * 视频独有的画幅尺寸（图片档位表里没有的那几档）。
 *
 * 21:9 是**视频模型支持、图片模型不支持**的一档：`IMAGE_RATIOS` 只有五种，
 * `pixelFor` 对未知画幅返回空串，于是拼装档位（30/60 秒）会回退成 720p 竖屏——
 * 用户选 21:9，七段 1470x630 的片段被压进 720x1280 的画布，成片画幅变成 9:16
 * （实测 2026-09-19：片段 1470x630、成片 720x1280）。
 *
 * 尺寸取厂商在 720p 下 21:9 的真实出片尺寸；1080p 按同一比例放大（2205x945 仍是精确的 21:9）。
 */
const VIDEO_ONLY_SIZES: Record<string, Record<string, string>> = {
  '720p': { '21:9': '1470x630' },
  '1080p': { '21:9': '2205x945' },
}

/**
 * 目标画布像素；档位/画幅不认识时回退 720p 竖屏（产品默认口径）。
 *
 * @param options - 成片参数（档位与画幅）。
 * @returns 画布宽高。
 */
export function canvasFor(options: Pick<ComposeOptions, 'resolution' | 'aspectRatio'>): { width: number, height: number } {
  const tier = options.resolution ?? '720p'
  const ratio = options.aspectRatio ?? '9:16'
  const size = VIDEO_ONLY_SIZES[tier]?.[ratio]
    ?? (pixelFor(tier, ratio) || pixelFor('720p', '9:16'))
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

/**
 * 拼接滤镜链：每镜各自规整并做短促淡出/淡入，再用 concat 顺序相接，最后统一调色/字幕/响度。
 *
 * 为什么不用 `-f concat` 直接硬拼：硬切落在人脸镜之间就是「一眼 AI」；
 * 这里给每镜首尾各加一次很短的淡入/淡出，接缝处形成一次暗场过渡，观感是一次剪辑点而不是一次跳变。
 *
 * 为什么每镜都要淡，而不是只淡全片首尾：每一镜都是独立生成的，起手与收尾那几帧最不稳
 * （模型刚起步/收尾容易抖），淡掉它们同时解决「跳变」与「抖动」两个问题。
 *
 * 声音不加淡入淡出：给每句话的头尾加淡会让人声发虚、听感像断线；
 * 各镜音量不齐由 {@link LOUDNESS_FILTER} 统一解决。
 *
 * @param options - 拼接参数与各镜真实时长。
 * @returns filter_complex 字符串与最终音视频标签。
 */
function buildFilterGraph(options: {
  segments: string[]
  durations: number[]
  canvas: { width: number, height: number }
  ass: boolean
  dip: number
}): { graph: string, videoLabel: string, audioLabel: string } {
  const { segments, canvas, ass, dip } = options
  const parts: string[] = []
  const videoLabels: string[] = []
  const audioLabels: string[] = []
  segments.forEach((_, index) => {
    const duration = options.durations[index] ?? 0
    // 淡入从 0 开始，淡出在「本镜时长 - 过渡时长」处开始；时长读不出来时整镜不淡（避免负偏移）。
    const useFade = dip > 0 && duration > dip * 2
    const fadeFilter = useFade
      ? ',fade=t=in:st=0:d=' + dip.toFixed(3) + ',fade=t=out:st=' + (duration - dip).toFixed(3) + ':d=' + dip.toFixed(3)
      : ''
    parts.push('[' + String(index) + ':v]' + canvasFilter(canvas) + ',setsar=1' + fadeFilter + '[v' + String(index) + ']')
    videoLabels.push('[v' + String(index) + ']')
    audioLabels.push('[' + String(index) + ':a]')
  })
  parts.push(videoLabels.join('') + 'concat=n=' + String(segments.length) + ':v=1:a=0[cv]')
  parts.push(audioLabels.join('') + 'concat=n=' + String(segments.length) + ':v=0:a=1[ca]')
  // 统一后期：调色 -> 字幕；响度单独一条链，避免把字幕处理算进音量统计。
  // 片尾收口：整片最后半秒淡出到黑。各镜之间已经有暗场剪辑点，但**整片结尾**此前是硬切，
  // 观感是"话没说完画面就没了"；收口是剪辑的常规收尾动作（片头不动，前 3 秒仍是钩子）。
  const totalSeconds = options.durations.reduce((sum, item) => sum + (Number.isFinite(item) && item > 0 ? item : 0), 0)
  const tailFade = totalSeconds > 1.2 ? ',fade=t=out:st=' + (totalSeconds - 0.4).toFixed(3) + ':d=0.4' : ''
  parts.push('[cv]' + COLOR_FILTER + tailFade + (ass ? ',' + subtitleFilter() : '') + '[vfinal]')
  parts.push('[ca]' + LOUDNESS_FILTER + '[afinal]')
  return { graph: parts.join(';'), videoLabel: 'vfinal', audioLabel: 'afinal' }
}

/** 字幕滤镜：按相对文件名引用成片同目录的 ASS 与字体目录（避开 Windows 路径转义）。 */
function subtitleFilter(): string {
  return 'ass=' + SUBTITLE_FILENAME + ':fontsdir=.'
}

/**
 * 把多镜拼成一条，并做统一后期。
 *
 * @param options - 分段文件、输出路径、目标画布与字幕。
 * @returns 成片路径或失败原因。
 */
export async function composeSegments(options: ComposeOptions): Promise<ComposeResult> {
  const { segments, outFile } = options
  if (segments.length === 0) return { ok: false, error: '没有可拼接的片段' }
  const canvas = canvasFor(options)
  const outDir = dirname(outFile)
  mkdirSync(outDir, { recursive: true })
  // 各镜真实时长先定下来：成片时间轴（字幕能不能被看到）与滤镜链全靠它。
  const durations = await segmentDurations(options)
  // 黑场过渡不重叠（淡出淡入各占本镜时间），所以各镜时长累加就是成片时间轴，字幕不需要平移。
  const dip = options.segments.length > 1 ? DIP_SECONDS : 0
  // 字幕落在成片之外时烧进去也没人能看到：先把结束时间裁到成片长度内，再如实报出裁掉了哪些。
  // 只裁不判失败：画面与声音是对的，字幕错位是叠加层的问题，失败只会让用户拿不到片子。
  const filmSeconds = durations.reduce((total, duration) => total + (Number.isFinite(duration) && duration > 0 ? duration : 0), 0)
  const rawCues = options.subtitles ?? []
  const cues = clampCuesToFilm(rawCues, filmSeconds)
  const timelineProblems = subtitleTimelineProblems(rawCues, filmSeconds)
  if (timelineProblems.length > 0) {
    console.error('[COMPOSE_ERR] 字幕时间轴与成片对不上（' + String(timelineProblems.length) + '/' + String(rawCues.length)
      + ' 条），已裁到成片长度内：' + timelineProblems.slice(0, 5).join('；'))
  }
  // 字幕与字体都复制到成片同目录，随后切到该目录用相对名引用。
  const ass = buildAssSubtitles(cues, canvas)
  if (ass !== '') writeFileSync(join(outDir, SUBTITLE_FILENAME), ass, 'utf8')
  const fontReady = ass !== '' && prepareSubtitleFont(outDir)
  if (ass !== '' && !fontReady) console.error('[COMPOSE_WARN] 缺少随包字幕字体，改用系统字体渲染')
  // 字体缺失时 ASS 里写的字体名找不到，libass 会回退系统字体——字幕仍然烧，只是观感差一点。
  const graph = buildFilterGraph({
    segments,
    durations,
    canvas,
    ass: ass !== '' && fontReady,
    dip,
  })
  const result = await runFfmpeg([
    '-y',
    ...segments.flatMap(file => ['-i', file]),
    '-filter_complex', graph.graph,
    '-map', '[' + graph.videoLabel + ']',
    '-map', '[' + graph.audioLabel + ']',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-ar', '44100',
    '-movflags', '+faststart',
    outFile,
  ], { timeoutMs: 60 * 60_000, cwd: outDir })
  if (!result.ok) return { ok: false, error: describeFfmpeg(result.output, result.spawnFailed) }
  return { ok: true, file: outFile, segmentDurations: durations }
}

/**
 * 多片段拼成成片，并把成片时长收敛到用户选的档位。
 *
 * 为什么需要这一层：官方单次下单只收 4~12 秒，30 秒 / 1 分钟必须多片下单再拼；
 * 而厂商返回的每片时长都有零点几秒的出入（实测要 10 秒拿到 10.14 秒），15 片叠起来能差好几秒。
 * 用户是按档位选的，所以拼接后必须按目标裁齐 / 补足，并把调整量如实交回调用方写进生成记录。
 *
 * 失败一律返回原因，绝不把「裁齐失败」当成成功——那会让用户拿到长度不对的成片而无人知晓。
 *
 * @param options - 片段文件、输出路径、目标时长与画布。
 * @returns 成片路径与时长收敛结果；失败返回原因。
 */
export async function composeTargetDuration(options: {
  segments: string[]
  outFile: string
  targetSeconds: number
  resolution?: string
  aspectRatio?: string
  segmentDurations?: number[]
}): Promise<
  | { ok: true, file: string, actualSeconds: number, adjustment: 'none' | 'trim' | 'pad', deltaSeconds: number }
  | { ok: false, error: string }
> {
  const composed = await composeSegments({
    segments: options.segments,
    outFile: options.outFile,
    ...(options.resolution !== undefined ? { resolution: options.resolution } : {}),
    ...(options.aspectRatio !== undefined ? { aspectRatio: options.aspectRatio } : {}),
    ...(options.segmentDurations !== undefined ? { segmentDurations: options.segmentDurations } : {}),
  })
  if (!composed.ok) return { ok: false, error: composed.error }
  const actualSeconds = await probeDurationSeconds(composed.file)
  if (actualSeconds <= 0) {
    // 读不到时长时不做裁剪：宁可如实报「未能读取」，也不要按猜的数字切坏成片。
    return { ok: true, file: composed.file, actualSeconds: 0, adjustment: 'none', deltaSeconds: 0 }
  }
  const { action, deltaSeconds } = conformAction(actualSeconds, options.targetSeconds)
  if (action === 'none') return { ok: true, file: composed.file, actualSeconds, adjustment: 'none', deltaSeconds: 0 }
  const outDir = dirname(composed.file)
  const tmp = join(outDir, 'bf-conform-' + String(Date.now()) + '.mp4')
  const conformed = action === 'trim'
    // 裁齐：重编码而不是 -c copy——stream copy 只能切在关键帧上，切出来的长度照样不准。
    ? await runFfmpeg([
        '-y', '-i', composed.file,
        '-t', options.targetSeconds.toFixed(3),
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-ar', '44100', '-movflags', '+faststart',
        tmp,
      ], { timeoutMs: 30 * 60_000, cwd: outDir })
    // 补足：克隆最后一帧把时长顶到目标（tpad 是 2013 年就有的滤镜，随包 ffmpeg 支持）。
    : await runFfmpeg([
        '-y', '-i', composed.file,
        '-vf', 'tpad=stop_mode=clone:stop_duration=' + deltaSeconds.toFixed(3),
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-ar', '44100', '-movflags', '+faststart',
        tmp,
      ], { timeoutMs: 30 * 60_000, cwd: outDir })
  if (!conformed.ok) {
    // 裁剪失败不推翻已经拼好的成片：如实回报「未收敛 + 原因」，由调用方写进生成记录。
    return { ok: true, file: composed.file, actualSeconds, adjustment: 'none', deltaSeconds }
  }
  try {
    rmSync(composed.file, { force: true })
    renameSync(tmp, composed.file)
  }
  catch (error) {
    return { ok: false, error: '成片时长收敛后替换文件失败：' + String(error) }
  }
  const finalSeconds = await probeDurationSeconds(composed.file)
  return { ok: true, file: composed.file, actualSeconds: finalSeconds > 0 ? finalSeconds : actualSeconds, adjustment: action, deltaSeconds }
}


/**
 * 各镜的真实时长（秒）。
 *
 * 转场偏移与字幕对齐都靠它，所以必须**真实**：用 ffprobe 读文件，读不出才退回调用方给的估算值
 * （宁可整片略有偏差，也不能因为一个读不出时长的文件让整条拼不出来）。
 *
 * @param options - 拼接参数。
 * @returns 与 segments 等长的时长数组。
 */
export async function segmentDurations(options: ComposeOptions): Promise<number[]> {
  const resolved: number[] = []
  for (const [index, file] of options.segments.entries()) {
    const given = options.segmentDurations?.[index]
    if (Number.isFinite(given) && (given ?? 0) > 0) { resolved.push(given!); continue }
    const probed = await probeDurationSeconds(file)
    resolved.push(probed > 0 ? probed : 0)
  }
  return resolved
}

/** 把随包字幕字体复制到成片目录；字体不在时返回 false（调用方退回系统字体）。 */
function prepareSubtitleFont(outDir: string): boolean {
  try {
    if (BUNDLED_FONT === '' || !existsSync(BUNDLED_FONT)) return false
    copyFileSync(BUNDLED_FONT, join(outDir, SUBTITLE_FONT_FILENAME))
    return true
  }
  catch {
    return false
  }
}
