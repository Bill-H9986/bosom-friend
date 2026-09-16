/**
 * 长视频产出通用工作流：任何工作类型/项目，只要成品超过厂商单次生成上限，都走这一条。
 *
 * 厂商单次只收 4~12 秒（超过直接 400），所以"长视频"在产品里只有一种正确做法：
 * 写稿 → 排分镜 → 逐镜生成 → 统一画布拼接。这条编排与业务无关——
 * 数字人口播、产品特写、场景呈现的区别只在「镜头怎么生成」，编排一行都不用改。
 *
 * 两条来自实测的硬约束（详见 docs/知识库/条目/13-AI视频生成工作流.md）：
 * 1. **镜头要交替**：人只出镜一半时间、另一半拍产品，才是"像拍过的"；一个人从头念到尾必然一眼 AI；
 * 2. **参考图集要固定**：同一套人物/产品参考图 + 固定 seed 跨镜复用，人和产品才不会每镜都换。
 *
 * 本模块不碰产品存储、不碰厂商接口：存储写回与模型调用由调用方经 {@link LongVideoDeps}
 * 注入，镜头怎么生成由 {@link LongVideoProducer} 决定。于是同一条工作流可以单测、
 * 也可以挂任意多个业务。
 * @module @deepseek-ai/dsh-bosom-friend-server/long-video
 */

import { mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { ZyLongVideoSegment, ZyLongVideoTask, ZyShot, ZyShotRef } from './types.ts'
import { fallbackShotPlan } from './storyboard.ts'
import { composeSegments } from './video-compose.ts'
import type { SubtitleCue } from './video-compose.ts'

/** 厂商单次生成的时长硬边界。 */
export const SEGMENT_MIN_SECONDS = 4
export const SEGMENT_MAX_SECONDS = 12

/**
 * 中文口播语速下限（字/秒）——把「秒数」折算成「最少要写多少字」时用它。
 *
 * 实测标定：edge-tts 的 zh-CN-XiaoxiaoNeural 念「姐妹们，这款产品我自己用了三个月，
 * 今天直播间直降一百。」（含标点 26 字）用 6.07 秒，约 4.3 字/秒。
 * 折算按较慢的一档（4.5）算，宁可要求多写一点：稿子写短了，配音撑不满目标时长，
 * 成片就成了慢速念白（用户口径的"语速太慢、讲解内容太少"）。
 */
export const CHARS_PER_SECOND = 4.5

/** 镜头生成器的产出：本地文件与它的真实时长（真实时长用于拼接对时与进度展示）。 */
export type SegmentOutcome =
  | { ok: true, file: string, seconds: number }
  | { ok: false, error: string }

/**
 * 一个镜头的生成请求：编排层给什么，生成器就照着做什么。
 *
 * 生成器按 `shot.kind` 决定怎么出画面（口播 / 产品特写 / 空镜），
 * 编排层不理解也不需要理解这些差别——新增一种镜头只加一个分支。
 */
export interface ShotRequest {
  /** 段序号（0 起，用于文件命名与逐镜定位）。 */
  index: number
  /** 镜头卡片本体（含类型、口播文本、画面提示词、参考图集、连续性约束）。 */
  shot: ZyShot
  /** 工作目录。 */
  workDir: string
  /** 目标画布（各镜必须一致，拼接才不会在接缝处花屏）。 */
  resolution: string
  aspectRatio: string
}

/**
 * 镜头生成器：业务的唯一接入点。
 *
 * 一种业务 = 一个生成器。数字人是「形象图 + 配音」，场景呈现是「每镜一个画面」，
 * 以后新增业务只写这一个接口的实现，编排与存储都不用动。
 */
export interface LongVideoProducer {
  /** 生成器标识，落盘留痕用（换业务不换表）。 */
  kind: string
  /**
   * 写稿体裁要求，并进模型提示词。
   * @param targetSeconds - 目标成片时长。
   * @param segments - 编排层按目标时长算出的段数，体裁要求可以据此分配画面。
   * @returns 描述这一体裁该怎么写的短句。
   */
  scriptBrief(targetSeconds: number, segments: number): string
  /**
   * 把一张镜头卡片变成一段视频。
   *
   * 画布由编排层给定、生成器照办：各镜尺寸必须一致，拼接才不会在接缝处花屏。
   *
   * @param input - 段序号、镜头卡片、工作目录与目标画布。
   * @returns 本地成片文件与真实秒数，或可读的失败原因。
   */
  produce(input: ShotRequest): Promise<SegmentOutcome>
  /**
   * 排分镜（可选）：由生成器决定这条片有哪些镜头、用哪套参考图。
   *
   * 为什么放在生成器而不是编排层：**参考图集是业务知识**（数字人的形象图、用户给的产品图），
   * 编排层不解读 `producerRef`，也就排不出正确的镜头。缺省时编排层走确定性兜底。
   *
   * @param input - 目标时长、体裁要求、长度要求、主题、已定稿稿件。
   * @returns 镜头数组与来源标记（模型排的 / 系统兜底排的）。
   */
  planShots?(input: {
    targetSeconds: number
    brief: string
    instruction: string
    topic: string
    script: string
  }): Promise<{ shots: ZyShot[], source: 'model' | 'fallback' }>
}

/** 工作流需要的外部能力：全部由调用方注入，编排层不依赖具体存储与厂商。 */
export interface LongVideoDeps {
  dataRoot: string
  /** 读全部长视频任务。 */
  loadTasks(): ZyLongVideoTask[]
  /** 写回全部长视频任务。 */
  saveTasks(tasks: ZyLongVideoTask[]): void
  /**
   * 用大模型写稿。
   * @param topic - 产品与卖点。
   * @param brief - 生成器给出的体裁要求（已含目标时长，编排层不重复拼提示词）。
   * @param instruction - 这一次写稿的硬性长度要求（字数下限与语气），编排层保证不为空。
   */
  writeScript(topic: string, brief: string, instruction: string): Promise<{ ok: true, text: string } | { ok: false, error: string }>
  /**
   * 用大模型排分镜（可选）：返回原始文本，由编排层解析。
   * 缺省或失败时走确定性兜底，**绝不因为分镜失败就让整条片跑不了**。
   * @param prompt - 已拼好的分镜要求。
   * @returns 模型原始输出，或失败原因。
   */
  planShots?(prompt: string): Promise<{ ok: true, text: string } | { ok: false, error: string }>
  /** 成片就绪后的登记（草稿/素材/封面），失败不得影响视频本身已产出的事实。 */
  registerVideo(task: ZyLongVideoTask, script: string): Promise<void>
}

/** 把模型写的稿子清成「能直接念」的文本：去掉 Markdown 装饰、话题标签与多余空白。 */
export function normalizeSpokenText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/[*_`>]/g, '')
    .replace(/#[^\s#，。！？；：]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 按估算语速把一个句子折算成秒数（至少 1 秒，避免空句被判成 0）。 */
export function estimateSeconds(text: string): number {
  return Math.max(1, Math.round(normalizeSpokenText(text).length / CHARS_PER_SECOND))
}

/**
 * 目标成片时长对应的稿件字数下限。
 *
 * 这是"语速太慢、内容太少"的正面解法：配音长度由字数决定，字数不够就只剩拖长音的念白。
 * @param targetSeconds - 目标成片时长（秒）。
 * @returns 稿件至少要写的字数（含标点）。
 */
export function minScriptChars(targetSeconds: number): number {
  return Math.ceil(targetSeconds * CHARS_PER_SECOND)
}

/**
 * 目标时长对应的段数。
 *
 * 于用户是"这条片大概几次生成"，于编排是场景分配的依据：段数在写稿前就要定下来，
 * 否则模型不知道这条片有几个画面可以铺，场景呈现会退化成几段雷同的画面。
 *
 * @param targetSeconds - 目标成片时长。
 * @returns 段数（至少 1；按厂商单段上限折算，向上取整）。
 */
export function planSegmentCount(targetSeconds: number): number {
  const seconds = Number.isFinite(targetSeconds) ? targetSeconds : SEGMENT_MAX_SECONDS
  return Math.max(1, Math.ceil(seconds / SEGMENT_MAX_SECONDS))
}

/**
 * 这一次写稿的长度要求：把"目标秒数"翻译成"最少写多少字"。
 *
 * 模型对"写 30 秒的稿子"没有可靠的尺度感，对"不少于 135 字"才有；而字数不够
 * 恰恰就是成片慢吞吞念白的来源，所以这里给下限、要求一句到底不留白。
 *
 * @param targetSeconds - 目标成片时长（秒）。
 * @param segments - 编排层算出的段数。
 * @returns 并进提示词的硬性要求。
 */
export function scriptLengthInstruction(targetSeconds: number, segments: number): string {
  return '成片目标 ' + String(targetSeconds) + ' 秒，分成约 ' + String(segments) + ' 个镜头。'
    + '按中文口播每秒 4.5 个字算，全文不少于 ' + String(minScriptChars(targetSeconds)) + ' 字（含标点），'
    + '宁多不少：字数不够，配音就会拖长音，成片变成慢速念白。'
    + '写成连续的一整段口播，不要分点、不要小标题、不要场景说明、不要任何解释。'
}

/**
 * 稿子明显短于目标时长时的补写要求。
 *
 * 只用来补长度，不重写体裁；提示词里带上实际字数与差多少，模型才知道要补多少。
 *
 * @param targetSeconds - 目标成片时长（秒）。
 * @param actualChars - 这一稿实际字数。
 * @returns 并进提示词的补写要求。
 */
export function rewriteInstruction(targetSeconds: number, actualChars: number): string {
  return '上一稿只有 ' + String(actualChars) + ' 字，不足 ' + String(targetSeconds) + ' 秒。'
    + '请在保留原意与卖点的前提下把它扩写到不少于 ' + String(minScriptChars(targetSeconds)) + ' 字，'
    + '补充具体细节、使用场景与行动号召，不要重复同一句话，不要分点、不要标题，直接给完整正文。'
}

/**
 * 提示词增强的写作要求。
 *
 * 用户写的是一句大白话（"秋冬保湿面霜，主打干皮救急，今天直播间直降一百"），
 * 这里要的是能直接拿去写稿的那一版：人群、场景、卖点、优惠都得在，且不得编造参数与功效。
 *
 * @param topic - 用户输入的产品与卖点。
 * @returns 并进模型提示词的写作要求。
 */
export function enhanceTopicInstruction(topic: string): string {
  return '把下面这句产品与卖点整理成写给短视频编剧的创作要求（供后续写口播稿用）：'
    + '1. 保留原有产品、卖点、价格与优惠，一个字都不许改动或编造；'
    + '2. 补齐目标人群、使用场景、用户痛点、差异卖点、行动号召，每条都要具体；'
    + '3. 用户没提到的功效、成分、参数、认证一律不要写，宁可留空；'
    + '4. 只输出整理后的创作要求本身，一整段或分点都可以，不要标题、不要解释、不要寒暄、不要反问。'
    + '用户原话：' + topic
}

/**
 * 把用户一句大白话整理成专业创作要求。
 *
 * 未接入大模型或调用失败时如实返回原因，由界面提示用户去「设置 → 配置大模型」，
 * 不拿本地模板冒充"AI 增强过的提示词"。
 *
 * @param topic - 用户输入的产品与卖点。
 * @param call - 调用大模型的函数（由 api 层注入，避免本模块依赖具体模型客户端）。
 * @returns 增强后的文本；失败时给出可读原因。
 */
export async function enhanceSpokenTopic(
  topic: string,
  call: (prompt: string) => Promise<{ ok: true, text: string } | { ok: false, error: string }>,
): Promise<{ ok: true, text: string } | { ok: false, error: string }> {
  const trimmed = topic.trim()
  if (trimmed === '') return { ok: false, error: '先写清楚要讲的产品与卖点' }
  const out = await call(enhanceTopicInstruction(trimmed))
  if (!out.ok) return out
  const text = out.text.trim()
  return text === ''
    ? { ok: false, error: '大模型没有返回可用的创作要求，请再试一次' }
    : { ok: true, text }
}

/** 把请求时长夹进厂商接受的区间；非数字按上限处理，避免把 `NaN` 发给厂商。 */
export function clampSegmentSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return SEGMENT_MAX_SECONDS
  return Math.min(SEGMENT_MAX_SECONDS, Math.max(SEGMENT_MIN_SECONDS, Math.round(seconds)))
}

/** 按句末标点切句，保留标点；纯空白片段丢弃。 */
function splitSentences(text: string): string[] {
  return normalizeSpokenText(text)
    .split(/(?<=[。！？!?；;…])/)
    .map(part => part.trim())
    .filter(part => part !== '')
}

/**
 * 把稿子切成可以逐段生成的片段。
 *
 * 规则两头的边界都由厂商约束反推，不是随手定的：
 * - 相邻短句合并到 ≥ {@link SEGMENT_MIN_SECONDS} 秒：一次生成最短 4 秒，太短的段会被拉长成慢速念白；
 * - 单段不超过 {@link SEGMENT_MAX_SECONDS} 秒：厂商只收 4~12 秒，超了直接拒收；
 * - 单句本身就超长时按逗号再切，仍超长才硬切，保证必然得到合法片段。
 *
 * @param text - 稿件正文。
 * @returns 段落文本数组；没有可朗读内容时为空数组。
 */
export function splitScript(text: string): string[] {
  const segments: string[] = []
  let buffer = ''
  const flush = (): void => {
    if (buffer.trim() !== '') segments.push(buffer.trim())
    buffer = ''
  }
  for (const sentence of splitSentences(text)) {
    const pieces: string[] = []
    for (const clause of sentence.split(/(?<=[，,、])/)) {
      if (estimateSeconds(clause) <= SEGMENT_MAX_SECONDS) { pieces.push(clause); continue }
      const chars = Math.floor(SEGMENT_MAX_SECONDS * CHARS_PER_SECOND)
      for (let i = 0; i < clause.length; i += chars) pieces.push(clause.slice(i, i + chars))
    }
    for (const piece of pieces) {
      const merged = buffer + piece
      if (estimateSeconds(merged) > SEGMENT_MAX_SECONDS) {
        flush()
        buffer = piece
        continue
      }
      buffer = merged
      if (estimateSeconds(buffer) >= SEGMENT_MIN_SECONDS) flush()
    }
  }
  flush()
  return segments
}

/**
 * 按镜头顺序累加出字幕时间轴。
 *
 * 每段的起止秒数就是前几段**真实时长**之和，不用"按字数估算"那一套：
 * 估算与成片实际长度一旦对不上，字幕就会越往后越飘，最后完全对不上口型。
 *
 * @param segments - 已完成的分段（含各自真实时长）。
 * @returns 与成片时间轴对齐的字幕条。
 */
export function buildSubtitleCues(segments: Array<{ text: string, audioSeconds: number }>): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  let cursor = 0
  for (const segment of segments) {
    const duration = segment.audioSeconds > 0 ? segment.audioSeconds : SEGMENT_MIN_SECONDS
    cues.push({ text: segment.text, startSeconds: cursor, endSeconds: cursor + duration })
    cursor += duration
  }
  return cues
}

/** 工作目录：分段音频与分段成片放这里，不对外提供服务。 */
export function longVideoWorkDir(dataRoot: string, taskId: string): string {
  return join(dataRoot, 'long-video', taskId)
}

/**
 * 确定性兜底分镜：生成器没提供 planShots（或它排不出来）时，编排层自己排。
 *
 * 兜底也保证"人 + 产品交替"，不是退回"一个人念完整条"——这条底线不能因为模型挂了就丢掉。
 *
 * @param script - 已定稿的稿件正文。
 * @param provider - 生成方标识。
 * @returns 镜头数组。
 */
export function fallbackShotsForScript(script: string, provider: string, references: ZyShotRef[] = []): ZyShot[] {
  return fallbackShotPlan(splitScript(script), references, provider, references.some(item => item.role === 'product'))
}

/**
 * 跑完一条长视频任务：写稿 → 排分镜 → 逐镜生成 → 拼接 → 登记。
 *
 * 镜头串行：厂商对免费档有速率限制，并发只会让所有镜一起撞 429。
 * 每完成一镜就把真实进度落盘，前端看到的是真实镜数，不是按时间假装出来的百分比。
 * 任何一镜失败都中止并如实记录原因与镜号（逐镜可见，便于只重做那一镜），
 * 不拿"部分镜头"冒充完整成片。
 *
 * @param deps - 注入的存储、模型与登记能力。
 * @param taskId - 任务 id。
 * @param producer - 本次使用的镜头生成器。
 */
export async function runLongVideoJob(deps: LongVideoDeps, taskId: string, producer: LongVideoProducer): Promise<void> {
  const workDir = longVideoWorkDir(deps.dataRoot, taskId)
  mkdirSync(workDir, { recursive: true })
  const segmentFiles: string[] = []
  const intermediateFiles: string[] = []
  const update = (mutate: (task: ZyLongVideoTask) => void): void => {
    const tasks = deps.loadTasks()
    const target = tasks.find(item => item.id === taskId)
    if (target === undefined) return
    mutate(target)
    target.updatedAt = new Date().toISOString()
    deps.saveTasks(tasks)
  }
  const fail = (message: string): void => {
    update(task => {
      task.status = 'failed'
      task.errorMessage = message
    })
  }
  try {
    const task = deps.loadTasks().find(item => item.id === taskId)
    if (task === undefined) return
    const planned = planSegmentCount(task.targetSeconds)
    const brief = producer.scriptBrief(task.targetSeconds, planned)
    const instruction = scriptLengthInstruction(task.targetSeconds, planned)
    const first = await deps.writeScript(task.topic, brief, instruction)
    if (!first.ok) {
      fail(first.error)
      return
    }
    // 长度校准：模型第一次常常写短，短稿就是成片慢下来的原因。
    // 只补写一次（不是循环）：够长就用，仍不够也如实生成，绝不拿"重试"当成功。
    const firstChars = normalizeSpokenText(first.text).length
    let scriptText = first.text
    if (firstChars < minScriptChars(task.targetSeconds)) {
      const retry = await deps.writeScript(task.topic, brief, rewriteInstruction(task.targetSeconds, firstChars))
      if (retry.ok) {
        const retryChars = normalizeSpokenText(retry.text).length
        if (retryChars > firstChars) scriptText = retry.text
      }
    }
    const spoken = normalizeSpokenText(scriptText)
    if (spoken === '') {
      fail('稿件切不出可生成的镜头')
      return
    }
    // 分镜由生成器排（它认识 producerRef：数字人的形象图、用户给的产品图都在它手里）；
    // 生成器没提供或排不出来时，编排层用自己的兜底排——**绝不因为分镜失败让整条片跑不了**。
    const planned2 = producer.planShots === undefined
      ? undefined
      : await producer.planShots({ targetSeconds: task.targetSeconds, brief, instruction, topic: task.topic, script: spoken })
    const shots = planned2 !== undefined && planned2.shots.length > 0
      ? planned2.shots
      : fallbackShotsForScript(spoken, producer.kind)
    update(target => {
      target.shots = shots
      target.segments = shots.map((shot, index) => ({ index, text: shot.line, audioSeconds: 0 }))
      target.totalSegments = shots.length
      target.doneSegments = 0
      // 稿件长度如实落盘：生成记录里能看到"这条片实际有多少字、折合多少秒"。
      target.scriptText = spoken
      target.scriptChars = spoken.length
      // 模型可能把稿子写长于目标时长：如实回报实际镜数，不按目标时长假装进度。
      target.status = 'generating'
      target.errorMessage = ''
    })

    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i]!
      const position = String(i + 1)
      const outcome = await producer.produce({
        index: i,
        shot,
        workDir,
        resolution: task.resolution,
        aspectRatio: task.aspectRatio,
      })
      if (!outcome.ok) {
        // 逐镜标记失败原因：用户只重做这一镜就能救，不必整条重跑。
        update(target => {
          const target_shot = target.shots?.[i]
          if (target_shot !== undefined) {
            target_shot.status = 'failed'
            target_shot.errorMessage = outcome.error
          }
          target.status = 'failed'
          target.errorMessage = '第 ' + position + ' 镜生成失败：' + outcome.error
        })
        return
      }
      segmentFiles.push(outcome.file)
      intermediateFiles.push(outcome.file)
      update(target => {
        const segment = target.segments[i]
        if (segment !== undefined) segment.audioSeconds = outcome.seconds
        const targetShot = target.shots?.[i]
        if (targetShot !== undefined) targetShot.status = 'ready'
        target.doneSegments = i + 1
      })
    }

    const assetId = 'lv-' + taskId + '.mp4'
    // 重新读一次：各镜真实时长是在循环里逐镜写回的，本地 task 还是建任务时的那份快照。
    const withTimings = deps.loadTasks().find(item => item.id === taskId) ?? task
    const composed = await composeSegments({
      segments: segmentFiles,
      outFile: join(deps.dataRoot, 'uploads', assetId),
      resolution: task.resolution,
      aspectRatio: task.aspectRatio,
      // 字幕只对口播镜有内容（产品镜没有台词），空文本不占字幕条。
      ...(withTimings.withSubtitles === false ? {} : { subtitles: buildSubtitleCues(withTimings.segments.filter(item => item.text.trim() !== '')) }),
    })
    if (!composed.ok) {
      fail(composed.error)
      return
    }
    const url = '/bosom-friend/api/assets/file/' + encodeURIComponent(assetId)
    update(target => {
      target.videoUrl = url
      target.status = 'success'
    })
    const finished = deps.loadTasks().find(item => item.id === taskId)
    if (finished !== undefined) await deps.registerVideo(finished, scriptText)
  }
  catch (error) {
    fail(error instanceof Error ? error.message : '长视频生成失败')
  }
  finally {
    // 分段成片已经拼进最终成片：中间文件清掉，避免 uploads 越堆越多。
    for (const file of intermediateFiles) {
      try { unlinkSync(file) } catch { /* 已被清理 */ }
    }
  }
}

/** 段落类型再导出，调用方不必同时 import 两个模块。 */
export type { ZyLongVideoSegment, ZyLongVideoTask }
