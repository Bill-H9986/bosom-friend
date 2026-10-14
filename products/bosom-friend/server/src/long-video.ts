/**
 * 长视频产出通用工作流：任何工作类型/项目，只要成品超过厂商单次生成上限，都走这一条。
 *
 * 厂商单次只收 4~12 秒（超过直接 400），所以"长视频"在产品里只有一种正确做法：
 * 写稿 → 排分镜 → 逐镜生成 → 统一画布拼接。这条编排与业务无关——
 * 数字人口播、产品特写、场景呈现的区别只在「镜头怎么生成」，编排一行都不用改。
 *
 * 两条来自实测的硬约束（详见 docs/知识库/条目/13-AI视频生成工作流.md）：
 * 1. **镜头要交替**：人只出镜一半时间、另一半拍产品，才是"像拍过的"；一个人从头念到尾必然一眼 AI；
 * 2. **参考图集要固定**：同一套人物/产品参考图跨镜复用——"是不是同一个人"由它锚定（2026-09-23 真机对账：
 *    同一个形象、两镜各换随机种子，判官仍判"同一个人"，见 `qa/reports/vlog-consistency-2026-09-23.md`）；
 *    固定 seed 管的是**同一镜重跑复现同一版画面**，不是"每镜换人"的那根弦。
 *
 * 本模块不碰产品存储、不碰厂商接口：存储写回与模型调用由调用方经 {@link LongVideoDeps}
 * 注入，镜头怎么生成由 {@link LongVideoProducer} 决定。于是同一条工作流可以单测、
 * 也可以挂任意多个业务。
 * @module @deepseek-ai/dsh-bosom-friend-server/long-video
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { ZyLongVideoSegment, ZyLongVideoTask, ZyShot, ZyShotRef } from './types.ts'
import { enhanceImagePromptInstruction } from './agnes.ts'
import { fallbackShotPlan, shotsSpokenChars } from './storyboard.ts'
import { composeSegments } from './video-compose.ts'
import { extractEvidenceFrames, extractTailFrame, probeDurationSeconds, probeVideoGeometry } from './ffmpeg.ts'
import type { SubtitleCue } from './video-compose.ts'

// 口播基本量（语速、4~12 秒边界、文本清理、切段）住在 speech.ts：
// 它们是"语言单位"，分镜层也要用；放这里会让 long-video ↔ storyboard 形成循环依赖
// （实测导致 SHOT_MIN_SECONDS 在某些加载顺序下是 undefined）。这里只做重导出，对外契约不变。
export {
  CHARS_PER_SECOND,
  SEGMENT_MAX_SECONDS,
  SEGMENT_MIN_SECONDS,
  estimateSeconds,
  minScriptChars,
  normalizeSpokenText,
  spokenCharCount,
  splitScript,
} from './speech.ts'
import { CHARS_PER_SECOND, SEGMENT_MAX_SECONDS, SEGMENT_MIN_SECONDS, minScriptChars, normalizeSpokenText, spokenCharCount, splitScript } from './speech.ts'

/**
 * 「产品与卖点」的字符上限：长视频这条链路里它同时是**写稿的原料**，不是一句标题。
 *
 * 300 秒档按 4.5 字/秒折算要 1350 字成稿，原料上限只有 200 字时用户无论怎么写都够不到
 * （实测被拒两次，见 DEF-114）；800 字让"写详细一点"真的能跨过 90/120 秒档的门槛，
 * 更长的档位仍由后端自动补写兜底。前端输入框的 maxLength 与这里保持同一个数。
 */
export const MAX_LONG_VIDEO_TOPIC_CHARS = 800

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
  /**
   * 前一镜的**尾帧**（本机 PNG 路径）：这一镜要接住上一镜画面时带上它。
   *
   * 依据 Agnes 官方 create-video 规范的连续性策略：相邻镜标为 continuous（同一动作跨镜延续）时，
   * 先接受一张首帧参考再做图生视频，厂商才会把物理状态与视线方向接上；
   * 不标 continuous 的镜留空（官方明确要求「不要人为制造帧间连续」）。
   */
  tailFrameFile?: string
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
   * 这次生成用的口播语速（字/秒，可选）：编排层据此把"目标秒数"折算成"要写多少字"、
   * 兜底分镜据此估每一镜的时长。缺省用产品默认值。
   *
   * 为什么要由生成器给：只有它知道用的是哪条音色。实测各音色的语速差 53%
   * （2.98~4.55 字/秒），按统一语速折算时，选慢音色的用户拿到的成片会比目标时长长出一大截。
   */
  charsPerSecond?: number
  /**
   * 暂时性失败的原因前缀（可选）：失败原因以它开头时，编排层会按
   * {@link LongVideoProducer.retryPolicy} 自动重跑这一镜。
   *
   * 由生成器决定"什么算暂时"：只有它知道哪条路径对应厂商限流/超时。
   */
  retryOnFailure?: string
  /**
   * 重试策略（可选）；给了 {@link LongVideoProducer.retryOnFailure} 才生效。
   * 缺省用 {@link DEFAULT_RETRY_POLICY}。
   */
  retryPolicy?: LongVideoRetryPolicy
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
   * 先把全片每一镜的出片时长定下来（可选）：**这是母时钟**。
   *
   * 口播由厂商在这次出片时自己念（台词逐字写进提示词），真实秒数只有成片回来才知道，
   * 所以这里给的是按语速折算的预算。编排层靠它做两件事：按预算给厂商下单，
   * 以及在任何一次厂商调用之前先对账目标时长（偏差超容忍就补写一版稿子再估一次）。
   *
   * @param input - 镜头序列（含各自的台词）。
   * @returns 镜号（字符串）→ 这一镜的出片秒数；没有台词的镜不出现在结果里。
   */
  planShotSeconds?(input: { shots: ZyShot[] }): Promise<{ seconds: Record<string, number> }>
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

/**
 * 暂时性失败的重试策略（限流、5xx、超时、网络抖动）。
 *
 * 为什么产品必须有这一条：厂商限流（429）是**暂时**的，不是"这条片子不能做"。
 * 没有它时，一镜撞限流就把整条多镜任务判失败，用户要盯着点"从断点继续"——
 * 实测一条 18 镜的片子被限流打断了五六次，每次都要人工点一次。
 *
 * 默认值按**实测**的限流窗口给（退避 65s → 150s → 300s，共三次）；
 * 部署可变量由调用方注入（`BF_LONG_VIDEO_RETRY_*`），编排层不读环境变量。
 */
export interface LongVideoRetryPolicy {
  /** 每镜最多重试几次（不含首次）。0 表示不重试。 */
  attempts: number
  /** 第 n 次重试前等多久（毫秒）；数组比 attempts 短时用最后一项。 */
  delaysMs: number[]
}

/**
 * 默认重试策略：四次退避，合计约 30 分钟（2 → 5 → 10 → 15 分钟）。
 *
 * 为什么越等越久：2026-10-10 实测，免费档的**真实冷却窗口远大于「每分钟 1 镜」的说法**——
 * 一镜连续三次重试（20s → 45s → 90s）全撞 429；改成 65s → 150s → 300s 后仍然全 429。
 * 而历史证据表明长片本身是能跑通的（2026-09-30 `lv-d5b7dea0` 21/21 镜成片），
 * 所以问题在**退避不够长**，不在链路：一镜失败就判死整条 18 镜任务，人不在屏幕前就只能作废。
 * 现在首次退避就跨 2 分钟，最长等到 15 分钟，给厂商冷却留出足够窗口。
 */
export const DEFAULT_RETRY_POLICY: LongVideoRetryPolicy = { attempts: 10, delaysMs: [120_000, 300_000, 600_000, 900_000, 1_200_000] }

/** 单镜失败后自动从断点续跑的最大轮数（防无限循环）。 */
export const AUTO_RESUME_MAX_ROUNDS = 3

/** 自动续跑前的等待时间：5 分钟（给厂商冷却留窗口，又不必让用户干等）。 */
export const AUTO_RESUME_DELAY_MS = 5 * 60_000

/** 上一次向厂商下单的时刻（毫秒）：用于镜间主动间隔。 */
let lastShotSubmitAt = 0

/**
 * 镜间最小间隔（毫秒）。
 *
 * 为什么不能「一镜成了就立刻下单下一镜」：厂商免费档按分钟限流，2026-10-10 实测第 3 镜在 23:15
 * 通过验收后，第 4 镜**立刻**下单又撞 429——同一分钟内第二次下单必被拒。
 * 与其撞墙后退避几分钟，不如**主动等过一个窗口**再下单：这才是「每分钟 1 镜」该有的节奏。
 *
 * 部署级可调（与 `DEFAULT_RETRY_POLICY` 同族）：`BOSOM_SHOT_INTERVAL_MS` 覆盖本值。
 * 测试与本地回放用它把 90 秒的真实等待压到毫秒级——否则每条多镜用例都要真等 90 秒，
 * 定向套件会大面积 60 秒超时（DEF-265 的"4 条超时"实为 17 条）。生产不设该变量，保持 90 秒。
 */
export const MIN_INTERVAL_BETWEEN_SHOTS_MS = ((): number => {
  const override = Number(process.env.BOSOM_SHOT_INTERVAL_MS ?? '')
  return Number.isFinite(override) && override > 0 ? override : 90_000
})()

/** 厂商队列满时的重试间隔：等的是一个队列，不是一个速率窗口。 */
export const QUEUE_FULL_RETRY_MS = 30 * 60_000

/**
 * 限速（HTTP 429）的重试间隔：固定 90 秒。
 *
 * 为什么不是「越等越久」：厂商口径是每分钟真正执行 1 次，2026-10-11 实测等 20 分钟照样 429——
 * 卡点是**免费池被其他用户抢**，不是我们等得不够久；拉长到几十分钟只是把窗口一次次浪费掉，
 * 而 90 秒已能跨过一个配额窗口。同一天直连探针（单发一次）拿到 HTTP 200，也印证了这一点。
 *
 * 与 {@link MIN_INTERVAL_BETWEEN_SHOTS_MS} 同一族：`BOSOM_RATE_LIMIT_RETRY_MS` 可覆盖（测试用），
 * 生产不设该变量、保持 90 秒。
 */
export const RATE_LIMIT_RETRY_MS = ((): number => {
  const override = Number(process.env.BOSOM_RATE_LIMIT_RETRY_MS ?? '')
  return Number.isFinite(override) && override > 0 ? override : 90_000
})()

/** 厂商受理了但排队太久（轮询超时）时的重试间隔：提交是通的，等的是出片。 */
export const QUEUE_PENDING_RETRY_MS = 15 * 60_000

/**
 * "这一镜可以重试"的机器判据前缀。
 *
 * 为什么用前缀而不是中文关键词匹配：文案是给人看的、随时会改，编排层不该靠它做判断。
 * 生成器在**暂时性**失败（限流、5xx、超时、网络抖动）的原因前加上它，
 * 编排层据此自动重跑这一镜；确定性失败（参数被拒、密钥无效）不加，如实失败。
 */
export const RETRYABLE_FAILURE_PREFIX = '[可重试] '

/**
 * 这次失败是否值得重试。
 *
 * 判据是生成器给的**机器标记前缀**，不是关键词匹配中文文案：文案随时会改，
 * 编排层不该靠它做决定。确定性失败（参数被拒、密钥无效、文件读不出）不加前缀，
 * 重试只会白花额度，必须如实失败。
 *
 * @param producer - 本次使用的镜头生成器。
 * @param error - 生成器给出的失败原因。
 * @returns 值得重试时为 true。
 */
export function isRetryableShotFailure(producer: LongVideoProducer, error: string): boolean {
  const marker = producer.retryOnFailure ?? ''
  return marker !== '' && error.startsWith(marker)
}

/** 工作流需要的外部能力：全部由调用方注入，编排层不依赖具体存储与厂商。 */
export interface LongVideoDeps {
  dataRoot: string
  /** 读全部长视频任务。 */
  loadTasks(): ZyLongVideoTask[]
  /**
   * 读一张本机素材的字节（用于判断参考图是否还在）。
   * @param url - 素材 URL。
   * @returns 文件字节；读不到时为 null。
   */
  readAssetBytes(url: string): Buffer | null
  /** 写回全部长视频任务。 */
  saveTasks(tasks: ZyLongVideoTask[]): void
  /**
   * 用大模型写稿。
   * @param topic - 产品与卖点。
   * @param brief - 生成器给出的体裁要求（已含目标时长，编排层不重复拼提示词）。
   * @param instruction - 这一次写稿的硬性长度要求（字数下限与语气），编排层保证不为空。
   */
  writeScript(topic: string, brief: string, instruction: string, sourceId?: string): Promise<{ ok: true, text: string } | { ok: false, error: string }>
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
 * @param charsPerSecond - 这条音色的实测语速；缺省用产品默认值。
 * @returns 并进提示词的硬性要求。
 */
export function scriptLengthInstruction(
  targetSeconds: number,
  charsPerSecond = CHARS_PER_SECOND,
): string {
  // 不把"分成约 N 个镜头"写进写稿要求：模型看到镜头数会按"每镜一两句"写，总字数反而压在镜头数上
  // （实测 90 秒档要求 405 字、只交回 350 字；同一模型直接要求 450 字能写 564~888 字）。
  // 分镜是下一步的事，写稿这一步只认字数。
  // **必须同时给上下限**：早先只写「不少于 N 字」，模型当成「越多越好」——
  // 实测 2026-09-28：60 秒档要求 270 字，首轮交了 **563 字**，母时钟算出 126 秒、
  // 偏差 110%，于是触发补写重排，整条片子白烧一倍额度与时间（那条最终还失败了）。
  // 上下限都给，模型才知道「刚好」是目标而不是「越多越好」。
  const floor = minScriptChars(targetSeconds, charsPerSecond)
  const ceiling = Math.round(floor * 1.1)
  return '成片目标 ' + String(targetSeconds) + ' 秒（镜头划分稍后由分镜步骤处理，这一步只写稿）。'
    + '按这条音色每秒 ' + String(charsPerSecond) + ' 个字算，全文请控制在 **'
    + String(floor) + ' 字左右**（不含标点），**允许区间 ' + String(floor) + '~' + String(ceiling) + ' 字**：'
    + '少于下限，配音会拖长音、成片变成慢速念白；'
    + '**多于上限同样不合格**——成片会被拉到目标时长的一倍以上，整条片子必须重排重做，'
    + '额度与时间全白花。写得刚好就是最好的稿子，不要为了显得内容多而加长。'
    + '写成连续的一整段口播，不要分点、不要小标题、不要场景说明、不要任何解释。'
}

/**
 * 稿件补写的最大轮数。
 *
 * 实测（2026-09-26，agnes-3.0-flash）：60 秒档要求 270 字，模型首轮只给 142~219 字，
 * 三轮补写仍不达标，整条片子直接失败。补写每轮都能多写一点，轮数给足比"写不够就失败"更有用。
 */
export const MAX_SCRIPT_REWRITE_ROUNDS = 6

/**
 * 稿件比目标时长**差多少**就不再判死整条（比例，0.05 = 5%）。
 *
 * 为什么必须有这条降档线：实测一条 90 秒的片子只差 7 个字就判整条失败，
 * 用户拿到的是一次白跑与一句"请把卖点写细一些"（DEF-229）。差距在这个量级上时，
 * 成片只是略短于目标——按实际字数反推有效时长继续出片，比整条失败有用得多；
 * 超过这个量级才说明稿件真的没写够，那时如实失败并给出"降到约 N 秒"的选择。
 */
export const SCRIPT_SHORTFALL_TOLERANCE_RATIO = 0.05

/**
 * 稿件长度与目标时长的差距。
 *
 * 字数口径与 {@link minScriptChars}、{@link rewriteInstruction} 完全一致（每秒 4.5 字），
 * 否则"还差多少字"与"要写多少字"会互相矛盾。
 *
 * @param script - 待检查的稿件正文。
 * @param targetSeconds - 目标成片时长（秒）。
 * @param charsPerSecond - 这条音色的实测语速；缺省用产品默认值。
 * @returns chars 实际字数（不含标点）；required 目标时长折算的字数下限（同一口径）；
 *   deficit 还差多少字；seconds 这一稿按语速折算能撑多少秒（给用户"把时长降到哪里"的具体数字）。
 */
export function scriptLengthGap(
  script: string,
  targetSeconds: number,
  charsPerSecond = CHARS_PER_SECOND,
): { chars: number, required: number, deficit: number, seconds: number } {
  const pace = charsPerSecond > 0 ? charsPerSecond : CHARS_PER_SECOND
  // 与语速同一套单位：`charsPerSecond` 按去标点标定，这里数的也就是去标点的字数（DEF-113）。
  const chars = spokenCharCount(script)
  const required = minScriptChars(targetSeconds, pace)
  return {
    chars,
    required,
    deficit: Math.max(0, required - chars),
    seconds: Math.max(1, Math.round(chars / pace)),
  }
}

/**
 * 不是稿子本身的"稿件"长什么样：模型把自己的过程写进了正文。
 *
 * 实测（2026-09-20 无人机培训那条）：模型的写稿调用连续失败后，它在正文里写
 * "上一稿（353 字，供参考扩写基准）…"、"--- 模型接口连续两次调用失败…直接写好的成品…"，
 * 还附了一版"成品稿"。这些字全被当台词念了出来（稿件 1084 字 / 目标 90 秒，配音 242 秒）。
 *
 * 判据只认**明确的自述标记**：宁可漏掉一次可疑输出，也不能把正常文案误判成失败
 * （误判的代价是用户永远发不出这条片）。
 *
 * @param script - 归一化之后的稿件正文。
 * @returns 命中的标记；没有则空串。
 */
export function scriptNarrationMarker(script: string): string {
  const markers = [
    '模型接口连续',
    '调用失败',
    '供参考扩写基准',
    '可替换上一稿',
    '直接写好的成品',
    '下面这版',
  ]
  return markers.find(marker => script.includes(marker)) ?? ''
}

/**
 * 正文里混进模型自述时的失败原因：说清看到了什么、下一步怎么做，而不是笼统报"写稿失败"。
 *
 * @param marker - {@link scriptNarrationMarker} 命中的标记。
 * @returns 写进任务记录的失败原因。
 */
export function scriptNarratedReason(marker: string): string {
  return '写稿模型把自己的说明写进了正文（检测到「' + marker + '」），这段会被当台词念出来，所以这次没有出片；'
    + '请重试一次；若反复出现，说明写稿模型这段时间不稳定。'
}

/**
 * 补写用尽仍不达标的失败原因。
 *
 * 文案必须可执行：既报出实际字数与差多少，也给出"把目标时长降到约多少秒"这个具体选择，
 * 用户才知道下一步是补卖点还是改时长。
 *
 * @param script - 目前最长的一稿。
 * @param targetSeconds - 目标成片时长（秒）。
 * @param charsPerSecond - 这条音色的实测语速；缺省用产品默认值。
 * @returns 写进任务记录的失败原因。
 */
export function scriptTooShortReason(script: string, targetSeconds: number, charsPerSecond = CHARS_PER_SECOND): string {
  const gap = scriptLengthGap(script, targetSeconds, charsPerSecond)
  return '稿件只有 ' + String(gap.chars) + ' 字，不足 ' + String(targetSeconds) + ' 秒所需的 ' + String(gap.required)
    + ' 字；请把卖点写细一些，或把目标时长降到约 ' + String(gap.seconds) + ' 秒。'
}

/**
 * 重复段落的判定门槛（归一化后的字数）。
 *
 * 为什么要有门槛：口播里的短呼应句（"姐妹们注意了""真的很不错"）重复出现是修辞，不是凑字数；
 * 真正凑字数的是把**整段实质内容**复述一遍。门槛定在 10 字：短于它的句子一律不判重复，
 * 宁可漏判也不误伤正常口播——误判的代价是用户的稿子永远过不了闸。
 */
export const MIN_DUPLICATE_SEGMENT_CHARS = 10

/** 一段重复正文与它的出现次数。 */
export interface RepeatedScriptSegment {
  /** 这一段在稿件里的原文（第一次出现时的写法，用于写进提示词与失败原因）。 */
  text: string
  /** 它在稿件里出现了几次（≥2 才进结果）。 */
  count: number
}

/**
 * 段落级重复检测（DEF-228）。
 *
 * 为什么必须自己查：提示词里早就写了「不要重复、不要改写已有句子」，但**字数判据只认总数**——
 * 模型把同一段复述三遍，字数照样过闸，成片就是同一句话念三遍。提示词是软约束，
 * 判据才是闸门；两者缺一，稿子就会靠重复凑够字数。
 *
 * 口径：按句子边界切开（句号/问号/感叹号/分号/换行），去掉空白与标点后比较同一段是否出现多次；
 * 去标点是因为"同一句话"换个标点还是同一句话。长度不足 {@link MIN_DUPLICATE_SEGMENT_CHARS}
 * 的短句不纳入统计（见该常量的说明）。
 *
 * @param script - 待检查的稿件正文。
 * @returns 出现 ≥2 次且够长的段落，按出现次数从多到少排列；没有重复时为空数组。
 */
export function repeatedScriptSegments(script: string): RepeatedScriptSegment[] {
  const counts = new Map<string, { text: string, count: number }>()
  for (const part of script.split(/(?<=[。！？；!?;\n])/)) {
    const text = part.trim()
    if (text === '') continue
    const key = text.replace(/[\s，。！？；：、,.!?;:'"“”‘’（）()【】\[\]—-]/g, '')
    if (key.length < MIN_DUPLICATE_SEGMENT_CHARS) continue
    const hit = counts.get(key)
    if (hit === undefined) counts.set(key, { text, count: 1 })
    else hit.count += 1
  }
  return [...counts.values()]
    .filter(item => item.count >= 2)
    .sort((a, b) => b.count - a.count)
}

/**
 * 稿件重复且没有改正成功时的失败原因（DEF-228）。
 *
 * 文案要说清两件事：**重复在哪里**（把命中的那一段摆出来）与**下一步做什么**，
 * 而不是笼统报"稿件不合格"。
 *
 * @param repeated - 仍然重复的段落。
 * @param detail - 这次改正做到哪一步（重写调用失败 / 重写后仍重复）。
 * @returns 写进任务记录的失败原因。
 */
export function duplicatedScriptReason(repeated: readonly RepeatedScriptSegment[], detail: string): string {
  const first = repeated[0]
  const sample = first === undefined ? '' : '（「' + first.text.slice(0, 20) + '」出现了 ' + String(first.count) + ' 次）'
  return '稿件有重复段落' + sample + '，' + detail
    + '；重复的字数撑不起成片时长，所以这次没有出片。请把卖点写细一些（补新的使用场景与细节）后重试。'
}

/**
 * 把模型写的第一稿校准到目标时长所需的字数。
 *
 * 长度校准：模型第一次常常写短，短稿就是"文案太少、与目标时长严重不符"的来源。
 * 最多补写 {@link MAX_SCRIPT_REWRITE_ROUNDS} 轮，每轮都把"还差多少字"写进提示词、每轮取最长的一稿；
 * 三轮之后仍不达标就如实失败，不拿"跑出一条短稿成片"冒充成功。
 * 这段在任何厂商调用（排分镜、合成配音、逐镜生成）之前，短稿一分钱额度都不会花出去。
 *
 * @param deps - 注入的写稿能力。
 * @param topic - 用户填的产品与卖点。
 * @param brief - 体裁与卖点要求。
 * @param targetSeconds - 目标成片时长（秒）。
 * @param pace - 这条音色的实测语速（字/秒）。
 * @param remember - 每次拿到更长的一稿就落盘的回调。
 * @returns 最好的一稿与它是否达标；rewriteFailures 是补写调用失败的轮数
 *   （模型没配好/网络抖动时它与"稿件就是短"是两件事，调用方要分开报）；写稿调用本身失败时给可读原因。
 */
async function calibrateScript(
  deps: Pick<LongVideoDeps, 'writeScript'>,
  topic: string,
  brief: string,
  targetSeconds: number,
  pace: number,
  remember: (produce: { text: string, chars: number }) => void,
): Promise<{ ok: true, text: string, chars: number, meetsTarget: boolean, rewriteError: string, rewriteFailures: number } | { ok: false, error: string }> {
  const first = await deps.writeScript(topic, brief, scriptLengthInstruction(targetSeconds, pace))
  if (!first.ok)
    return { ok: false, error: first.error }
  const required = minScriptChars(targetSeconds, pace)
  // **写超了当场截断**：软约束试过三轮全部失守（528 → 908 → 1183 字），
  // 字数能自己算就别求模型。截断只发生在句子边界，不切半句话。
  let scriptText = clampScriptLength(first.text, targetSeconds, pace)
  // 口径与门槛一致：去标点（见 speech.ts 的 spokenCharCount）。
  let bestChars = spokenCharCount(scriptText)
  /** 补写调用自身的失败原因（模型没配好、网络抖动）：如实带到最终结果里，不吞掉。 */
  let rewriteError = ''
  /** 补写失败的轮数（DEF-227）：全部轮次都失败时，"稿件短"与"补写根本没跑成"要分开告诉用户。 */
  let rewriteFailures = 0
  // 循环条件从「短了就补」改成「不在允许区间就重写」：超长同样要压——
  // 只判下界时，写超一倍的稿子会直接过闸，把偏差留到母时钟对账才暴露（实测偏差 293%）。
  for (let round = 1; round <= MAX_SCRIPT_REWRITE_ROUNDS && (bestChars < required || bestChars > Math.round(required * 1.1)); round += 1) {
    const rewrite = await deps.writeScript(topic, brief, rewriteInstruction(targetSeconds, bestChars, pace, scriptText))
    if (!rewrite.ok) {
      rewriteError = rewrite.error
      rewriteFailures += 1
      console.error('[LONG_VIDEO_ERR] 第 ' + String(round) + ' 轮补写失败：' + rewrite.error)
      continue
    }
    // **长了两条路的合并方式完全不同**：
    // - 短了：模型只交「新增内容」，接在原稿后面（原逻辑）；
    // - 长了：模型交的是「压缩后的完整正文」，必须**替换**而不是拼接——
    //   拼上去等于把压缩稿当成新增内容，越长越离谱（实测 528 → 908 字，偏差 293% → 573%）。
    const ceiling = Math.round(required * 1.1)
    const tooLong = bestChars > ceiling
    const candidate = tooLong
      ? rewrite.text.trim()
      : scriptText.replace(/\s+$/, '') + rewrite.text.trim()
    const chars = spokenCharCount(candidate)
    // 取「**更接近允许区间**」的一稿，而不是「更长的一稿」：
    // 只认更长时，压缩稿永远进不来，整条链路只会单向往上涨（这正是字数失控的机制）。
    const distance = (n: number): number => n < required ? required - n : Math.max(0, n - ceiling)
    const improves = distance(chars) < distance(bestChars)
      || (chars > bestChars && bestChars < required && chars <= ceiling)
    if (improves) {
      scriptText = candidate
      bestChars = chars
      // 每轮的最好一稿都落盘：进程被杀（关软件/断电）时已经花掉的补写不会白花。
      remember({ text: scriptText, chars: bestChars })
    }
  }
  // 出口再截一次：补写循环可能又把稿子推过上限。
  const finalText = clampScriptLength(scriptText, targetSeconds, pace)
  return { ok: true, text: finalText, chars: spokenCharCount(finalText), meetsTarget: bestChars >= required, rewriteError, rewriteFailures }
}
/**
 * 稿子明显短于目标时长时的补写要求。
 *
 * 只用来补长度，不重写体裁；提示词里带上实际字数、还差多少字与最终下限，模型才知道要补多少。
 *
 * @param targetSeconds - 目标成片时长（秒）。
 * @param actualChars - 这一稿实际字数。
 * @param charsPerSecond - 这条音色的实测语速；缺省用产品默认值。
 * @returns 并进提示词的补写要求。
 */
/**
 * 把超长的稿件**按句子边界**压到目标字数。
 *
 * 为什么不再靠模型：这一轮实测下来，三道软约束全线失守——
 * 写稿要求给了上下限（135~149 字）→ 交回 528 字；补写指令加了「压缩」→ 908 字；
 * 取稿逻辑改成「取最接近区间的」→ **1183 字**。模型不但不听，而且**越写越长**。
 * 字数是我们自己能算的事（每秒 4.5 字）**不该交给不确定的模型**：写超了就按句子边界截，
 * 截到上限为止——这比再写一轮提示词可靠，也不额外花额度。
 *
 * 截断优先落在**句子边界**（句号/问号/感叹号/分号），不会把一句话切一半；但结果必须留在
 * **[下限, 上限]** 区间内——句子边界掉到下限以下时依次退让到逗号边界、再到逐字生长
 * （宁可句中截断，也不产出一条注定被长度闸门判死的稿子，DEF-265）。
 *
 * @param text - 模型交回的稿件。
 * @param targetSeconds - 目标成片时长（秒）。
 * @param charsPerSecond - 这条音色的语速；缺省用产品默认值。
 * @returns 压到上限以内的稿件；本来就没超就原样返回。
 */
export function clampScriptLength(text: string, targetSeconds: number, charsPerSecond = CHARS_PER_SECOND): string {
  const required = minScriptChars(targetSeconds, charsPerSecond)
  const ceiling = Math.round(required * 1.1)
  if (spokenCharCount(text) <= ceiling) return text
  // 按分隔符逐段累加，直到再加一段就越过上限。
  // 不再放行「第一段就超上限」：那条 `kept !== ''` 的短路让第一句无论多长都被收下，
  // 实测模型第一句就写 96 字、后面全被切断，成片只有目标时长的三分之一（96 / 135）。
  const takeBy = (separator: RegExp): string => {
    const parts = text.split(separator).map(part => part.trim()).filter(part => part !== '')
    let taken = ''
    for (const part of parts) {
      const next = taken + part
      if (spokenCharCount(next) > ceiling) break
      taken = next
    }
    return taken
  }
  // 截断必须落在 **[下限, 上限]** 内——掉到下限以下就是自伤：后面的长度闸门会把这条稿
  // 判死（DEF-265：12 秒档下限 54 字，按句子边界截成 48 字即判 script-too-short）。
  // 依次退让：句子边界（不切半句话）→ 逗号边界 → 逐字生长到下限（宁可句中截断）。
  let kept = takeBy(/(?<=[。！？；!?;])/)
  if (spokenCharCount(kept) < required) {
    const byClause = takeBy(/(?<=[，,])/)
    if (spokenCharCount(byClause) > spokenCharCount(kept)) kept = byClause
  }
  if (spokenCharCount(kept) < required) {
    let index = kept.length
    while (index < text.length && spokenCharCount(text.slice(0, index)) < required) index += 1
    kept = text.slice(0, index)
  }
  console.error('[LONG_VIDEO_ERR] 稿件 ' + String(spokenCharCount(text)) + ' 字超出 ' + String(targetSeconds)
    + ' 秒的上限 ' + String(ceiling) + ' 字，已截到 ' + String(spokenCharCount(kept)) + ' 字')
  return kept
}

export function rewriteInstruction(
  targetSeconds: number,
  actualChars: number,
  charsPerSecond = CHARS_PER_SECOND,
  baseScript = '',
): string {
  const required = minScriptChars(targetSeconds, charsPerSecond)
  // **写长了同样是废稿，必须重写**：早先三道闸门（写稿要求 / 补写循环 / 这条指令）
  // 全都只管「不够」，528 字 / 目标 30 秒（偏差 293%）这样的稿子一路无阻跑到母时钟对账，
  // 那时写稿与分镜两笔调用已经白花（实测 2026-09-28）。上限与下限一样是硬指标。
  const ceiling = Math.round(required * 1.1)
  if (actualChars > ceiling) {
    return '上一稿有 ' + String(actualChars) + ' 字，**超出** ' + String(targetSeconds) + ' 秒需要的 '
      + String(required) + ' 字（上限 ' + String(ceiling) + ' 字）。请把它**压缩**到 ' + String(required) + ' 字左右：'
      + '只删重复、铺陈与同义反复，保留原意、卖点与行动号召；不要新增内容、不要分点、不要标题，'
      + '直接给压缩后的完整正文。\n已有正文：' + baseScript
  }
  const gap = Math.max(0, required - actualChars)
  // 带原稿时只要**增量**：让模型"重写一版更长的"实测每轮都停在 250 字左右（那是它的舒适长度），
  // 接在原稿后面往下写才能真的把差额补上。
  if (baseScript.trim() !== '') {
    return '下面这段口播稿目前 ' + String(actualChars) + ' 字，还差 ' + String(gap) + ' 字才够 '
      + String(targetSeconds) + ' 秒。请**接着它往下写**把差额补足：'
      + '只输出新增的正文（约 ' + String(gap) + ' 字），不要重复、不要改写已有句子，'
      + '不要分点、不要标题、不要任何解释。\n已有正文：' + baseScript
  }
  return '上一稿只有 ' + String(actualChars) + ' 字，不足 ' + String(targetSeconds) + ' 秒，还差 '
    + String(gap) + ' 字。'
    + '请在保留原意与卖点的前提下把它扩写到不少于 ' + String(required) + ' 字，'
    + '补充具体细节、使用场景与行动号召，不要重复同一句话，不要分点、不要标题，直接给完整正文。'
}

/**
 * 稿件里有重复段落时的重写要求（DEF-228 给模型的一次改正机会）。
 *
 * 与 {@link rewriteInstruction} 只补长度不同：这条要的是**把重复的那些段换成新内容**，
 * 且总量仍要落在目标时长的允许区间里——只说"别重复"而不给字数区间，改完很容易又变成短稿。
 *
 * @param targetSeconds - 目标成片时长（秒）。
 * @param charsPerSecond - 这条音色的实测语速；缺省用产品默认值。
 * @param baseScript - 当前这一稿的正文。
 * @param repeated - {@link repeatedScriptSegments} 命中的重复段。
 * @returns 并进提示词的纠正要求。
 */
export function dedupeRewriteInstruction(
  targetSeconds: number,
  charsPerSecond: number,
  baseScript: string,
  repeated: readonly RepeatedScriptSegment[],
): string {
  const floor = minScriptChars(targetSeconds, charsPerSecond)
  const ceiling = Math.round(floor * 1.1)
  return '下面这段口播稿里有重复段落：'
    + repeated.map(item => '「' + item.text.slice(0, 30) + '」出现了 ' + String(item.count) + ' 次').join('；')
    + '。重复的字数不会被当成新内容。请在**不改动其它内容**的前提下把它们换掉：'
    + '改成新的具体内容（使用场景、细节、行动号召），全长仍控制在 ' + String(floor) + '~' + String(ceiling)
    + ' 字（不含标点），不要重复同一句话，不要分点、不要标题、不要解释，只输出完整正文。\n已有正文：' + baseScript
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
  // 为什么"逐字保留"必须是第 1 条：用户经常把**画面要求**（机位、光线、色调、声音、构图）
  // 一并写在这个框里，而早先的口径是"整理成创作要求"——模型据此把画面描述当润色素材重写，
  // 用户精心写的运镜与色调当场变形。增强只该**补**用户没写的，不该动用户已经写清的。
  return '把下面这段用户原话整理成写给短视频编剧的创作要求（供后续写口播稿用）：'
    + '1. **用户原话里的每一项内容都要逐字保留**——产品、卖点、价格与优惠，以及画面描述'
    + '（镜头语言、机位与运镜、光线、色调、质感、声音、构图、主体与动作）一律照抄，'
    + '不许改写、不许概括、不许换词、不许丢项；'
    + '2. 只**补充**用户没写、而写稿需要的：目标人群、使用场景、用户痛点、差异卖点、行动号召，每条都要具体；'
    + '3. 用户没提到的功效、成分、参数、认证一律不要写，宁可留空；'
    + '4. **画面描述原样保留**：那是用户对成片画面的硬要求，不是留给你润色的素材；'
    + '5. 只输出整理后的创作要求本身，一整段或分点都可以，不要标题、不要解释、不要寒暄、不要反问。'
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

/**
 * 画面提示词增强的写作要求。
 *
 * 与"写给编剧的选题增强"不同：这里要的是能直接喂给图片/视频模型的**画面描述**。
 * 实测用选题口径去增强，模型会交回 700~800 字的"创作要求文档"（编号、人群分析、免责声明），
 * 而生成侧只留 800 字符，用户真正想要的画面要素反而被挤掉。
 *
 * @param text - 用户写的原始提示词。
 * @returns 并进模型提示词的写作要求。
 */
export function enhanceVisualPromptInstruction(text: string): string {
  // 这套口径按"提示词增强器该管哪四件事"组织（Task Definition / Preservation Rules /
  // Output Structure / Style Guidelines）：腾讯 Hunyuan-PromptEnhancer 的官方文档把增强器的
  // 系统提示词拆成这四类，业界开源提示词优化器（prompt-optimizer 等）也是同一结构。
  //
  // 第 1 条必须是"逐字保留"：用户经常把**画面要求**整段写进这个框（机位、光线、色调、声音、构图），
  // 早先的口径只说"保持主体与场景不变"——实测原话里的"免费就业培训"这类点名信息被当成卖点删掉。
  //
  // 第 2 条是 2026-09-28 补的 **Output Structure**：用户说"四视图 / 三视图 / 角色参考图 / 九宫格"
  // 时，他要的是**一张按行列排好的版面图**，不是一张单幅画面。只扩写形容词的话，模型会画一张
  // 普通人物图（实测：用户要"人物建模四视图（大头照+站立三视图）"，出来是一张站立全身照）。
  // 版面图必须写清**几列几行、每格画什么、格的顺序、对齐与间距**，模型才排得出来。
  return '把下面这段用户原话整理成一段可直接用于 AI 生成图片/视频的画面提示词：'
    + '1. **用户原话里的每一项都要保留**——主体、场景、动作、镜头语言、光线色调、声音、构图，'
    + '以及原话点名的机构、工种、主题词（例如"无人机装调检修操作工""免费就业培训"），'
    + '一律照抄，不许改写、不许概括、不许丢项；同时不得编造用户没提到的品牌、参数、功效与人物身份；'
    + '2. **先判断他要的是单幅画面还是"版面图"**：原话出现"四视图 / 三视图 / 五视图 / 多视图 / '
    + '角色参考图 / 角色表 / 建模图 / 三面图 / 九宫格 / 拼图 / 对比图 / 分镜图"这类词时，'
    + '他要的是**一张按行列排好、每格一个角度的版面图**，这时必须写清四件事：'
    + '① 几列几行（例如"四列两行"）；② 每一格画什么、格的先后顺序；'
    + '③ 格与格之间的对齐与间距（等宽、等距、同一人物同一服装同一光线）；'
    + '④ 版面图的通用约束（轮廓清晰、对齐一致、面板分隔干净、无文字、细边框、平光）。'
    + '例如"人物建模四视图（大头照+站立三视图）"要展开成：四列，每列一个视角，'
    + '上排是站立全身、正下方是同一视角的特写头像；从左到右依次为正面、左侧、右侧、背面；'
    + '四格是同一个人、同一套服装、同一光线；无文字、细边框、平光、构图均匀。'
    + '不是版面图时，按单幅画面写；'
    // 按 Agnes 官方《Agnes Video 2.5 · 提示词建议》的六段顺序补：主体与场景、动作与变化、
    // 镜头语言、视觉风格、声音与节奏、一致性要求。此前只笼统写"补齐画面要素"，
    // 模型交回的多是形容词堆砌（"温馨、治愈、高级感"），缺的正是官方要的那几件具体的事。
    // 2026-09-28 补的第 3 条，依据两份业界权威口径：
    // ① FastVideo（LTX-2.3）的 prompt_extension_system_prompt：用电影语言、明确空间布局、
    //    用动词描述运动、情绪用身体表演表现而不是抽象标签；
    // ② MiniMax H3 的 prompt-standardizer：把「震撼 / 高级 / 电影感」这类模糊词**替换成**
    //    具体的构图、运动、色彩、光线、节奏、质感。
    // 用户的原话是「照专业角度做能让 AI 更理解的扩充，不是乱改编」——这一条就是那句话的落点：
    // 改动只发生在**表达层**（把感觉翻成可拍的指令），不发生在**意思层**。
    + '3. **把「感觉词」翻译成专业摄制语言——这是本次整理的重点**：'
    + '用户若写了「震撼 / 高级 / 大气 / 有电影感 / 温馨 / 治愈 / 专业」这类词，'
    + '**不许原样保留、更不许再堆同类形容词**，必须换成具体可执行的画面指令：'
    + '① 镜型与景别（特写 / 近景 / 中景 / 全景 / 过肩 / 低角度仰拍 / 俯拍）；'
    + '② 运镜（固定机位 / 缓慢推近 / 横移 / 跟拍 / 环绕 / 升降）；'
    + '③ 光线（方向：左上侧逆光 / 顶光 / 窗侧光；色温：冷白约 5600K / 暖黄；质感：硬光还是柔光）；'
    + '④ 景深与焦点（浅景深虚化背景 / 深焦全清晰）；'
    + '⑤ 空间布局（主体在画面左三分之一 / 前景有操作台 / 背景是玻璃隔断 / 主体朝向镜头或侧身）；'
    + '⑥ 情绪**用看得见的身体表现**写，不许用抽象标签——'
    + '写「停顿半秒、视线移向手里的零件、下颌微收」，而不是写「专注」「自信」；'
    + '⑦ 材质与质感（不锈钢的冷硬反光 / 防滑垫的哑光颗粒 / 工装布料的织纹）；'
    + '⑧ 运动要用动词写清谁在动、怎么动、动到哪里（「右手把机臂抬到胸前停住」），不要写「进行检修操作」；'
    + '2. 按厂商官方给的六段顺序补全（顺序照写，每一段都要有具体内容，不许用形容词堆砌）：'
    + '① 主体与场景：画面里是谁／什么物体、在什么环境里、什么时间；'
    + '② 动作与变化：主体在做什么动作、场景怎么变化；'
    + '③ 镜头语言：推／拉／摇／移／跟拍／固定镜头，以及景别（特写／近景／中景／全景）；'
    + '④ 视觉风格：光线方向与色温、色彩倾向、材质质感、写实程度、氛围；'
    + '⑤ 声音与节奏：需要时写环境声或动作声（没有人声就不要写人声）；'
    + '⑥ 一致性要求：这一段里必须保持不变的主体外观、产品细节或构图；'
    + '每一镜都要有看得见的实体（镜头对着谁或什么物体），抽象意象必须落在一个具体物件上；'
    // 版面图（四视图/九宫格）要写清行列与每格内容，200 字装不下；放宽到 300 字。
    + '4. 写成**一整段中文**，不超过 320 字（专业指令比形容词长，放宽到 320），不要分点、不要编号、不要标题、不要解释；'
    + '5. 不写营销文案、不写价格与优惠口号，只描述画面里能看到什么；'
    + '6. 结尾补一句稳定与排除项：这一段里必须保持不变的是什么（人物外观 / 产品外形 / 场地布局），'
    + '以及画面里**不出现**什么（不出现文字与 logo、不出现第二个人、不出现用户没提到的道具）。'
    + '用户原话：' + text
}

/**
 * 把用户一句话增强成可直接出片的画面提示词。
 *
 * @param text - 用户写的原始提示词。
 * @param call - 调用大模型的函数（由 api 层注入）。
 * @returns 增强后的画面提示词；失败时给出可读原因。
 */
export async function enhanceVisualPrompt(
  text: string,
  call: (prompt: string) => Promise<{ ok: true, text: string } | { ok: false, error: string }>,
  options: { kind?: 'video' | 'image', referenceCount?: number } = {},
): Promise<{ ok: true, text: string } | { ok: false, error: string }> {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: false, error: '先写一句要做什么（一句话就够）' }
  // 图片与视频各走官方那一套：图像按输入形态（文生图 / 图生图 / 多图合成）选结构，
  // 视频走官方六段（含声音与节奏）；用错口径会交回一份对图像没用的要求。
  const instruction = options.kind === 'image'
    ? enhanceImagePromptInstruction(trimmed, options.referenceCount ?? 0)
    : enhanceVisualPromptInstruction(trimmed)
  const out = await call(instruction)
  if (!out.ok) return out
  const result = out.text.trim()
  return result === ''
    ? { ok: false, error: '大模型没有返回可用的提示词，请再试一次' }
    : { ok: true, text: result }
}

/** 把请求时长夹进厂商接受的区间；非数字按上限处理，避免把 `NaN` 发给厂商。 */
export function clampSegmentSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return SEGMENT_MAX_SECONDS
  return Math.min(SEGMENT_MAX_SECONDS, Math.max(SEGMENT_MIN_SECONDS, Math.round(seconds)))
}

/**
 * 一条字幕的字数上限。
 *
 * 取 11 是**一行放得下的量**，不是随手定的：字幕字号 = 画布高 × 4.2%（720p 竖屏 = 54px），
 * 左右边距各 6%（720 → 43px），可用宽度 634px ÷ 54px ≈ 11.7 字。超过就会折成两行，
 * 而 ASS 的 `WrapStyle: 1` 是**按行宽任意断行**，实测把"我现在端着这架无人机往／外走"、
 * "外场试飞风里带点响真的／特别爽"这种词中间切断的两行摆到画面上——读起来是断的。
 */
const CUE_MAX_CHARS = 11

/**
 * 把一镜的台词切成适合做字幕的短句。
 *
 * 一镜的台词是一整段话（模型按行写稿），整段做成一条字幕会堆满画面、连标点一起上屏；
 * 这里按句末与句中标点断开、去掉标点，并把过短的碎片并回相邻句，让每条约 6~14 字。
 *
 * @param text - 一镜的台词（可含换行与标点）。
 * @returns 按顺序排列的字幕短句；没有可用内容时为空数组。
 */
export function splitCuePhrases(text: string): string[] {
  const cleaned = text.replace(/\s+/g, '').trim()
  if (cleaned === '') return []
  const parts = cleaned
    .split(/[。！？；，、,.!?;:：…—～~"'“”‘’《》()（）\[\]【】]/)
    .filter(part => part !== '')
  const merged: string[] = []
  for (const part of parts) {
    const last = merged[merged.length - 1]
    const shortEnough = last !== undefined && (last.length < 6 || part.length < 6)
    // 合并要同时满足「有一边是碎片」与「合起来还是短句」：只看碎片会把四五个短语串成
    // 一条 20 多字的字幕，上屏时又退化成"整段糊满画面"（实测 30 秒档一镜一条 21 字、跨 5 秒不换）。
    if (last !== undefined && shortEnough && last.length + part.length <= CUE_MAX_CHARS) {
      merged[merged.length - 1] = last + part
      continue
    }
    merged.push(part)
  }
  // 单段本身就超长（模型写了没有标点的长句）时硬切：宁可切在两个词之间，
  // 也不让一条字幕占满画面。
  const out: string[] = []
  for (const phrase of merged) {
    if (phrase.length <= CUE_MAX_CHARS) { out.push(phrase); continue }
    for (let i = 0; i < phrase.length; i += CUE_MAX_CHARS) out.push(phrase.slice(i, i + CUE_MAX_CHARS))
  }
  return out.length === 0 ? [cleaned] : out
}

/**
 * 按镜头顺序累加出字幕时间轴（时长由调用方给）。
 *
 * @param segments - 按镜头顺序排列的分段（含台词）。
 * @param durationOf - 第 index 段在成片里的真实秒数；读不出时返回 0（回退到最短段）。
 * @returns 与成片时间轴对齐的字幕条。
 */
export function buildSubtitleCuesFromDurations(
  segments: Array<{ text: string }>,
  durationOf: (index: number) => number,
): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  let cursor = 0
  for (const [index, segment] of segments.entries()) {
    const given = durationOf(index)
    // 真实时长照用（不夹进厂商区间：这里算的是**成片时间轴**，夹了字幕就会飘）；
    // 只有真的量不出来（0 / 负数 / NaN）才兜底到最短段，绝不产生 0 秒或倒序的字幕条。
    const duration = Number.isFinite(given) && given > 0 ? given : SEGMENT_MIN_SECONDS
    cues.push({ text: segment.text, startSeconds: cursor, endSeconds: cursor + duration })
    cursor += duration
  }
  return cues
}

/**
 * 按镜头顺序取每镜的成片文件与**文件真实时长**。
 *
 * 为什么以文件为准：厂商出片时会重新配音，成片长度与母时钟给的配音长度常常不同
 * （实测差 0.2~1 秒，逐镜累加就能让字幕飘出几秒）。拼接与字幕都该跟成片走。
 *
 * @param shotFiles - 镜号 → 本地文件路径。
 * @param shots - 按镜头顺序排列的分镜。
 * @returns 播放顺序的文件与各自真实秒数（读不出时为 0，由调用方兜底）。
 */
export async function orderedSegmentFilesWithDurations(
  shotFiles: Record<string, string> | undefined,
  shots: ZyShot[],
): Promise<{ files: string[], durations: number[] }> {
  const files: string[] = []
  const durations: number[] = []
  for (const shot of shots) {
    const file = shotFiles?.[String(shot.index)]
    if (typeof file !== 'string' || file === '') continue
    files.push(file)
    durations.push(await probeDurationSeconds(file))
  }
  return { files, durations }
}

/** 工作目录：分段音频与分段成片放这里，不对外提供服务。 */
export function longVideoWorkDir(dataRoot: string, taskId: string): string {
  return join(dataRoot, 'long-video', taskId)
}

/**
 * 清掉一条长视频记录的**中间产物**：工作目录（配音 mp3 与贴音后的分镜）与各镜成片。
 *
 * 记录被删掉之后，这些文件没有任何人再用：分镜成片只在"重做某一镜 / 重新拼接"时被读，
 * 而那两个入口都要求任务记录还在。
 *
 * **合成好的成片（`uploads/lv-<taskId>.mp4`）不删**：它已经作为草稿进了内容库
 * （见 `registerLongVideoDraft`），删掉等于让那条草稿变成一个打不开的视频——
 * 用户删的是"生成记录"，不是他发布用的成片。
 *
 * 越界路径一律不碰：记录里的路径原则上都在数据根里，但这份 JSON 是可以被手改的，
 * 所以只删 `uploads/` 与这条任务的工作目录下的文件。
 *
 * @param dataRoot - 产品数据根。
 * @param task - 要清理的任务记录。
 * @returns 真的删掉的文件/目录个数（用于日志与如实回报）。
 */
export function removeLongVideoArtifacts(dataRoot: string, task: ZyLongVideoTask): number {
  let removed = 0
  const workDir = longVideoWorkDir(dataRoot, task.id)
  try {
    rmSync(workDir, { recursive: true, force: true })
    removed += 1
  }
  catch {
    // 目录本来就不在（已被清理过）或正被别的进程占用：清理失败不该让"删除记录"这件事失败。
  }
  const uploads = join(dataRoot, 'uploads')
  const composed = join(uploads, 'lv-' + task.id + '.mp4')
  for (const file of Object.values(task.shotFiles ?? {})) {
    if (typeof file !== 'string' || file === '') continue
    if (file === composed) continue
    if (!file.startsWith(uploads) && !file.startsWith(workDir)) continue
    try {
      unlinkSync(file)
      removed += 1
    }
    catch {
      // 文件已经不在了：目标状态已达成，不必报错。
    }
  }
  return removed
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
export function fallbackShotsForScript(
  script: string,
  provider: string,
  references: ZyShotRef[] = [],
  charsPerSecond = CHARS_PER_SECOND,
): ZyShot[] {
  return fallbackShotPlan(
    splitScript(script, charsPerSecond),
    references,
    provider,
    references.some(item => item.role === 'product'),
    charsPerSecond,
  )
}

/**
 * 把一个镜头的参考图收成"真的读得到"的那几张。
 *
 * 为什么要收：分镜表落盘后会被存进任务记录（数组里的 URL 是 JSON 字符串，类型系统看不出来），
 * 素材也可能被用户在生成期间删掉。这里逐个确认能读，读不到的丢掉并把原因写进日志——
 * 绝不拿一张读不出的图去发请求（那会整镜失败，用户还不知道为什么）。
 *
 * @param deps - 注入的数据根与文件读取能力。
 * @param shot - 待收的镜头。
 * @returns 可安全使用的镜头（参考图已过滤）。
 */
export function sanitizeShotReferences(
  deps: Pick<LongVideoDeps, 'readAssetBytes'>,
  shot: ZyShot,
): ZyShot {
  const kept = shot.references.filter((item) => {
    if (item === null || typeof item !== 'object' || typeof item.url !== 'string' || item.url === '') return false
    if (/^https?:\/\//i.test(item.url)) return true
    const readable = deps.readAssetBytes(item.url) !== null
    if (!readable) console.error('[LONG_VIDEO_ERR] 参考图读不出来，已丢弃：' + item.url)
    return readable
  })
  return kept.length === shot.references.length ? shot : { ...shot, references: kept }
}

/**
 * 成片的时间轴：按镜头顺序把"有文件的"排进去。
 *
 * 逐镜重做会替换其中一镜的文件，成片必须按同一顺序重新拼——编排层因此只认这张表，
 * 不再依赖"生成顺序恰好等于镜头顺序"这种巧合（重做之后就不成立了）。
 *
 * @param task - 任务记录（含 segments 与 shotFiles）。
 * @returns 按镜头顺序排列的本地文件路径；缺文件的镜头被跳过。
 */
export function orderedSegmentFiles(task: ZyLongVideoTask): string[] {
  const files: string[] = []
  for (const segment of task.segments) {
    const file = task.shotFiles?.[String(segment.index)]
    if (typeof file === 'string' && file !== '') files.push(file)
  }
  return files
}

/**
 * 进程重启后的收尾：把上一条进程遗留的「生成中」任务定格为失败。
 *
 * 为什么必须在启动时做：任务的推进是**进程内**的（`runLongVideoJob` 的 Promise），
 * 没有任何落盘的"正在跑"标记。进程一中断（关软件、断电、重启），记录永远停在
 * `generating`——用户界面会一直转圈，既等不到成片，也点不了逐镜重做
 * （重做对生成中的任务是拒绝的），实际已经跑完的那几镜也永远拼不成片。
 *
 * 判据只用了"状态"这一条：本函数**只能在注册路由之前的启动阶段调用**，
 * 那时进程内必然没有任何在跑的任务，所以凡是 `generating` 都是遗留的。
 * 已生成的镜数取自任务记录的 `shotFiles`（不逐个查文件在不在）：文件是否还可用
 * 由续跑时的 {@link resumeStartIndex} 决定，收尾这一层不该猜。
 *
 * @param deps - 注入的存储能力。
 * @returns 被收尾的任务数与它们已经跑完的镜数之和（用于日志与启动报告）。
 */
export function recoverInterruptedLongVideoTasks(deps: Pick<LongVideoDeps, 'loadTasks' | 'saveTasks'>): { tasks: number, readyShots: number } {
  const tasks = deps.loadTasks()
  let interrupted = 0
  let readyShots = 0
  for (const task of tasks) {
    if (task.status !== 'generating') continue
    const ready = Object.keys(task.shotFiles ?? {}).length
    task.status = 'failed'
    task.errorMessage = ready > 0
      ? '生成被中断（应用退出或重启）：已生成 ' + String(ready) + ' 镜，可从中断处继续'
      : '生成被中断（应用退出或重启）：请重新生成'
    task.updatedAt = new Date().toISOString()
    interrupted += 1
    readyShots += ready
  }
  if (interrupted > 0) deps.saveTasks(tasks)
  return { tasks: interrupted, readyShots }
}


/**
 * 正在跑的编排：taskId → 停止信号。
 *
 * 生成是一条**进程内**的 Promise 链，没有可中断的句柄；「停止」能做的是置一个信号，
 * 让编排在**下一镜开始前**收手。正在飞的那一次厂商调用追不回来（厂商已经受理），
 * 但不会再下下一单——额度就停在这儿。
 */
const runningJobs = new Map<string, { stopped: boolean }>()

/**
 * 停止一条正在生成的长视频任务。
 *
 * 两种情形都要能停：
 * - 编排还在本进程里跑：置信号，并**立刻**把记录定格为失败，用户点完就看到终态，
 *   不必等正在飞的那一镜回来（那一镜回来后只写它自己的成片，不再改状态）；
 * - 编排已经不在了（进程重启后遗留的生成中记录）：直接把记录定格。
 *
 * 已跑成的镜**保留**在 shotFiles 里，所以停完还能走「从断点继续」——停止不等于白花。
 *
 * @param deps - 注入的存储能力。
 * @param taskId - 任务 id。
 * @returns 停止是否生效；任务不存在或本来就不在生成时为 false。
 */
export function stopLongVideoTask(deps: Pick<LongVideoDeps, 'loadTasks' | 'saveTasks'>, taskId: string): boolean {
  const control = runningJobs.get(taskId)
  if (control !== undefined) control.stopped = true
  const tasks = deps.loadTasks()
  const task = tasks.find(item => item.id === taskId)
  if (task === undefined || task.status !== 'generating') return false
  const ready = Object.keys(task.shotFiles ?? {}).length
  task.status = 'failed'
  task.errorCode = 'stopped'
  task.errorMessage = ready > 0
    ? '已手动停止：已生成 ' + String(ready) + ' 镜，可从中断处继续'
    : '已手动停止'
  task.updatedAt = new Date().toISOString()
  deps.saveTasks(tasks)
  return true
}

/**
 * 按数据根拼出参考图对应的本地字节。
 *
 * 编排层不解释 producerRef，但要能判断"这张参考图还在不在"——所以由调用方注入这一条读取能力，
 * 而不是把存储知识塞进编排层。
 *
 * @param dataRoot - 产品数据根。
 * @param url - 素材 URL（`/bosom-friend/api/assets/file/<id>`）。
 * @returns 文件字节；读不到或 URL 不合法时为 null。
 */
export function readUploadedAsset(dataRoot: string, url: string): Buffer | null {
  const prefix = '/bosom-friend/api/assets/file/'
  // 运行时防御：编排层可能拿到 undefined（某镜没有参考素材），直接 indexOf 会抛错并把整条片子判死。
  if (typeof url !== 'string' || url === '') return null
  const index = url.indexOf(prefix)
  if (index < 0) return null
  const id = decodeURIComponent(url.slice(index + prefix.length).split('?')[0] ?? '')
  // 素材 id 是文件名：带路径分隔符的请求一律不认，避免越出 uploads 目录。
  if (id === '' || id.includes('/') || id.includes('\\') || id.includes('..')) return null
  try {
    return readFileSync(join(dataRoot, 'uploads', id))
  }
  catch {
    return null
  }
}

/**
 * 上一镜留下的成片文件是否还在。
 *
 * 只看记录不够：文件可能被用户清掉或被清理工具删掉（`.mp4` 在 uploads 里，
 * 不是不可再生资源）。续跑要用它决定"这一镜是接着用，还是重新生成"。
 *
 * @param file - 记录里的本地文件路径。
 * @returns 文件存在且不是空文件时为 true。
 */
function usableShotFile(file: unknown): boolean {
  if (typeof file !== 'string' || file === '') return false
  try {
    return statSync(file).size > 0
  }
  catch {
    return false
  }
}

/**
 * 续跑前必须挡住的四种情况：任务不存在、还在跑、没有分镜表、一镜都没跑成。
 *
 * 为什么要有这条守卫：续跑的语义是"接着跑剩下的"，只有终态任务才谈得上接着跑。
 * 对生成中的任务放行，就会有两个循环同时写同一批成片文件。
 *
 * @param task - 任务记录（不存在时为 undefined）。
 * @returns 可以续跑时为 null，否则是可读的拒绝原因。
 */
export function resumeBlockedReason(task: ZyLongVideoTask | undefined): string | null {
  if (task === undefined) return '任务不存在'
  // 只有**本进程里真的在跑**才挡得住续跑。
  //
  // 为什么必须看 runningJobs 而不是落盘状态：任务的推进是进程内的 Promise，进程一中断
  // （关软件、断电、重启）记录就永远停在 generating；只看状态的话，这种**僵尸任务**
  // 会被这句永久挡死——2026-09-30 实测：一条 18/21 镜的片卡在 generating 6.6 小时，
  // 用户要的那条视频既等不到成片也续不了跑，只能看着。
  if (task.status === 'generating' && runningJobs.has(task.id)) return '这条片还在生成，等它跑完再说'
  // 稿件已定稿、只是还没排分镜（用户刚补写完的那条）：也允许继续——
  // 它接着走的就是"按存稿排分镜"这条路，不会重复写稿（DEF-108）。
  if ((task.shots ?? []).length === 0 && normalizeSpokenText(task.scriptText ?? '') === '')
    return '这条任务没有分镜表，无法从中断处继续'
  // 判据与续跑起点同一份事实源：文件还在才叫"跑成过"。
  const usable = (task.shots ?? []).filter(shot => usableShotFile(task.shotFiles?.[String(shot.index)])).length
  if (usable === 0) return '这条任务还没有任何生成好的镜头，请重新生成'
  return null
}

/**
 * 续跑的起点：第一条"还没跑成"的镜头。
 *
 * 为什么不是"已跑成的镜数"：中断可能发生在某一镜跑到一半时（文件没落地），
 * 也可能中间某镜失败而后面还有跑成的。按序号找第一处空洞，才能既不重复生成
 * 也不跳过任何一镜。
 *
 * @param task - 任务记录。
 * @param fileIsUsable - 判"这一镜的文件还能不能用"；缺省按文件真实存在且非空。
 * @returns 起点镜号；全部跑成时为镜头总数。
 */
export function resumeStartIndex(task: ZyLongVideoTask, fileIsUsable: (file: unknown) => boolean = usableShotFile): number {
  const shots = task.shots ?? []
  for (let i = 0; i < shots.length; i += 1) {
    if (!fileIsUsable(task.shotFiles?.[String(i)])) return i
  }
  return shots.length
}

/**
 * 按任务现有稿件再补写一轮（用户点"继续补写"时走这条）。
 *
 * 与任务里那条自动补写同一口径（同一个提示词构造、同一个语速折算），区别只有两点：
 * 起点是任务里已经存下的最长一稿，且结果落盘不回滚——用户的点按是显式的，不该被一次更短的返回抹掉。
 *
 * @param deps - 注入的读写与写稿能力。
 * @param taskId - 任务 id。
 * @param producer - 这条任务的生成器（取体裁要求与实测语速）。
 * @returns 补写后的稿件与字数；模型没产出或任务不存在时给可读原因。
 */
export async function extendLongVideoScript(
  deps: LongVideoDeps,
  taskId: string,
  producer: LongVideoProducer,
): Promise<{ ok: true, text: string, chars: number, required: number } | { ok: false, error: string }> {
  const task = deps.loadTasks().find(item => item.id === taskId)
  if (task === undefined) return { ok: false, error: '任务不存在' }
  const base = normalizeSpokenText(task.scriptText ?? '')
  if (base === '') return { ok: false, error: '这条任务没有可补写的稿件' }
  const pace = producer.charsPerSecond !== undefined && producer.charsPerSecond > 0
    ? producer.charsPerSecond
    : CHARS_PER_SECOND
  const required = minScriptChars(task.targetSeconds, pace)
  const brief = producer.scriptBrief(task.targetSeconds, planSegmentCount(task.targetSeconds))
  // "还差多少字"与门槛判定的口径必须一致，否则模型按含标点补、门槛按去标点判，永远差一点。
  const extended = await deps.writeScript(task.topic, brief, rewriteInstruction(task.targetSeconds, spokenCharCount(base), pace), taskId)
  if (!extended.ok) return { ok: false, error: extended.error }
  const text = normalizeSpokenText(extended.text)
  if (text === '') return { ok: false, error: '模型没有返回可用的稿件' }
  const chars = spokenCharCount(text)
  const tasks = deps.loadTasks()
  const target = tasks.find(item => item.id === taskId)
  if (target !== undefined) {
    target.scriptText = text
    target.scriptChars = chars
    target.updatedAt = new Date().toISOString()
    deps.saveTasks(tasks)
  }
  return { ok: true, text, chars, required }
}
/**
 * 下单节流闸门**已下线**（2026-09-28）。
 *
 * 它服务的是「按官方 RPM 连续下单 + 并行等待」的流水线：厂商是异步任务，理论上不必等上一镜
 * 出完再下下一镜。但实测该流水线会在「母时钟对账」之后整体卡死——任务停在 0/12 镜、
 * 11 分钟零媒体调用，连第一镜都没下单。逐镜生成已回退成串行；闸门留在这里只会误导下一个人。
 * 要重做流水线，先查清那次卡死的原因（对账分支与 Promise.all 的交互），再动这里。
 */

/**
 * 验收一镜的产出，给出官方口径的状态与证据。
 *
 * 对齐 Agnes 官方 create-video 规范的 production record：**生成成功不等于可以用**——
 * 产出先记 `generated-uninspected`，看过画面、确认它符合这一镜的目的与硬约束之后才标 `accepted`。
 * 这里做**机器能做的第一层**：文件真的存在、非空、能被 ffprobe 解出正时长；
 * 人眼那一层（动作与台词对不对得上、脸有没有变形）仍交给用户的「重做这一镜」。
 *
 * @param outcome - 生成器返回的结果。
 * @returns state 官方状态；evidence 验收证据或拒绝原因。
 */
async function inspectShotOutcome(
  outcome: SegmentOutcome,
  workDir = '',
  tag = '0',
): Promise<{ state: 'accepted' | 'rejected', evidence: string }> {
  if (!outcome.ok) return { state: 'rejected', evidence: outcome.error }
  const file = outcome.file ?? ''
  if (file === '') return { state: 'rejected', evidence: '生成器没有返回成片文件' }
  if (!existsSync(file)) return { state: 'rejected', evidence: '生成器返回的文件不存在：' + file }
  const size = statSync(file).size
  if (size <= 0) return { state: 'rejected', evidence: '生成器返回的文件是空的（0 字节）' }
  const seconds = await probeDurationSeconds(file)
  if (seconds <= 0) return { state: 'rejected', evidence: '成片解不出时长，文件可能损坏：' + file }
  // 官方 quality-review 的第二步：**看画面**才算验收。probe 只能证明文件可解码，
  // 证明不了画面里有什么；这里按 20%/50%/80% 抽三帧留证（覆盖开头、中段、结尾），
  // 路径写进 evidence —— 人眼（用户）据此判断这一镜要不要「重做这一镜」。
  const frames = workDir === '' ? [] : await extractEvidenceFrames(file, workDir, tag, seconds)
  // 先验证再批量（官方口径）：把这一镜的**真实画布与帧率**记下来。
  // 第一镜就是那个代表性样本——它的实测值就是这次生成能力的权威事实，
  // 与请求的画布对不上时，拼接层会在接缝处花屏，越早看见越好。
  const geo = await probeVideoGeometry(file)
  const geoNote = geo.width === 0 ? '' : '、画布 ' + String(geo.width) + 'x' + String(geo.height) + ' @' + String(geo.fps) + 'fps'
  const frameNote = frames.length === 0
    ? ''
    : '；证据帧 ' + String(frames.length) + ' 张：' + frames.map(item => item.slice(item.lastIndexOf('\\') + 1)).join(' ')
  return {
    state: 'accepted',
    evidence: '文件 ' + String(Math.round(size / 1024)) + 'KB、时长 ' + seconds.toFixed(1) + ' 秒、可解码' + geoNote + frameNote,
  }
}

/**
 * 生成一镜，暂时性失败按策略自动重跑。
 *
 * 这是"厂商限流不该让整条片子失败"的落点：
 * - 只重试生成器标记为**暂时**的失败（限流/5xx/超时/网络抖动）；
 * - 每次重试前把"第 N 镜限流，X 秒后自动重试"写进任务记录，界面照实显示，不假装在正常推进；
 * - 重试用尽仍失败就如实失败（逐镜标记），交给"从断点继续"或"重做这一镜"。
 *
 * @param producer - 镜头生成器。
 * @param request - 这一镜的生成请求。
 * @param retryable - 这一镜的失败算不算暂时（由生成器给前缀）。
 * @param onNotice - 重试前的通知（写进任务记录给人看）。
 * @returns 生成结果（成功或最终失败）。
 */
/**
 * 单镜失败后的**唯一**收尾口：还能自动续跑就排一轮，轮次用尽才如实失败。
 *
 * 为什么必须是唯一入口：2026-10-10 夜里踩过——「新任务」与「续跑」两条路径各写了一份失败分支，
 * 只改了其中一处，结果夜里跑的续跑路径**整夜没触发自动续跑**：3 镜跑成的任务在 02:00 判死后空等 6 小时。
 *
 * @returns 已经安排好自动续跑时返回 true（调用方直接 return）；false 表示该如实失败了。
 */
function scheduleAutoResumeOrFail(
  update: (mutate: (task: ZyLongVideoTask) => void) => void,
  deps: LongVideoDeps,
  taskId: string,
  producer: LongVideoProducer,
  prefix: string,
): boolean {
  const rounds = deps.loadTasks().find(item => item.id === taskId)?.autoResumeRounds ?? 0
  if (rounds >= AUTO_RESUME_MAX_ROUNDS) return false
  update(target => {
    target.autoResumeRounds = rounds + 1
    target.status = 'generating'
    target.errorMessage = prefix + '；' + String(Math.round(AUTO_RESUME_DELAY_MS / 60000))
      + ' 分钟后自动从断点续跑（第 ' + String(rounds + 1) + '/' + String(AUTO_RESUME_MAX_ROUNDS)
      + ' 轮），已跑成的镜保留。'
  })
  setTimeout(() => {
    void runLongVideoJob(deps, taskId, producer, { resume: true }).catch(() => {})
  }, AUTO_RESUME_DELAY_MS)
  return true
}
async function produceShot(
  producer: LongVideoProducer,
  request: ShotRequest,
  retryable: string,
  onNotice: (notice: string) => void,
  beforeSubmit?: () => Promise<void>,
): Promise<SegmentOutcome> {
  const policy = producer.retryPolicy ?? DEFAULT_RETRY_POLICY
  // 镜间主动间隔：下单**之前**先让过一个限流窗口，而不是撞了再退避（重试由 policy 的 delay 管）。
  if (lastShotSubmitAt > 0) {
    const gap = MIN_INTERVAL_BETWEEN_SHOTS_MS - (Date.now() - lastShotSubmitAt)
    if (gap > 0) await new Promise(resolve => setTimeout(resolve, gap))
  }
  let attempt = 0
  for (;;) {
    // 每一次真正下单都过同一道闸门——**重试也要过**。
    // 实测踩过（2026-09-28）：只拦首次下单时，重试直接打出去撞上厂商 RPM，拿到 429。
    if (beforeSubmit !== undefined) await beforeSubmit()
    lastShotSubmitAt = Date.now()
    const outcome = await producer.produce(request)
    if (outcome.ok || attempt >= policy.attempts || !outcome.error.startsWith(retryable)) return outcome
    let delay = policy.delaysMs[Math.min(attempt, policy.delaysMs.length - 1)] ?? 0
    // 队列满不是速率问题：厂商自己的队列堵着，几分钟的退避没有意义（2026-10-11 实测，
    // 同一分钟内交替回 video_queue_full 与 rate_limit_exceeded）。按小时级等，等的是一个队列而不是一个窗口。
    // 按厂商拒绝的**类别**决定等多久：限速按窗口（90 秒），队列满按队列（30 分钟）。
    // 判别靠 {@link describeMediaFailure} 写进 error 的那句话（队列满 / 限速），不再一刀切地越等越久。
    // 匹配的是编排层**实际写出来的文案**（api.ts 的 videoFailureReason 与 poll 超时出口）：
    // 「队列已满」「排队过久」「限流」三种，等待量级完全不同。只匹配一种会静默退回默认退避。
    if (outcome.error.includes('队列已满')) delay = Math.max(delay, QUEUE_FULL_RETRY_MS)
    else if (outcome.error.includes('排队过久')) delay = Math.max(delay, QUEUE_PENDING_RETRY_MS)
    else if (outcome.error.includes('限流')) delay = RATE_LIMIT_RETRY_MS
    attempt += 1
    console.error('[LONG_VIDEO_RETRY] 第 ' + String(request.index + 1) + ' 镜暂时性失败（'
      + String(attempt) + '/' + String(policy.attempts) + '）：' + outcome.error + '；' + String(Math.round(delay / 1000)) + ' 秒后重试')
    onNotice('第 ' + String(request.index + 1) + ' 镜暂时性失败（' + String(attempt) + '/'
      + String(policy.attempts) + ' 次重试），' + String(Math.round(delay / 1000)) + ' 秒后自动重试：'
      + outcome.error.replace(retryable, ''))
    await new Promise(resolve => setTimeout(resolve, delay))
  }
}

/**
 * 成片时长与目标时长的容忍偏差（相对值）：母时钟量出来的真实秒数偏离超过它才动手纠正。
 *
 * 10% 不是随手定的：厂商单镜出片本身有零点几秒的出入（实测选 4 秒出 4.5s），
 * 一条 18 镜的片子光这一项就能累出三四秒；而用户对"90 秒的片子"的感知精度也就是这个量级。
 * 收得更紧只会让每次生成都多跑一轮补写与配音，换不到可感知的收益。
 */
export const DURATION_TOLERANCE_RATIO = 0.1

/**
 * 母时钟算出来的口播合计秒数与目标时长的差距。
 *
 * @param voice - 母时钟的产出；没有口播预算的体裁（如空镜）为 undefined。
 * @param shots - 本次的镜头序列（秒数已被母时钟回填）。
 * @param targetSeconds - 目标成片时长（秒）。
 * @returns seconds 有台词各镜的预算合计秒数；drift 相对偏差（0.13 = 长 13%）；
 *   measured 母时钟给到秒数的镜数；expected 有台词、本该给到的镜数。
 */
export function voiceDurationGap(
  voice: { seconds: Record<string, number> } | undefined,
  shots: ZyShot[],
  targetSeconds: number,
): { seconds: number, drift: number, measured: number, expected: number } {
  let seconds = 0
  let measured = 0
  let expected = 0
  for (const shot of shots) {
    if (shot.line === '') continue
    expected += 1
    const value = voice?.seconds[String(shot.index)]
    if (typeof value !== 'number' || value <= 0) continue
    measured += 1
    seconds += value
  }
  const drift = targetSeconds > 0 ? Math.abs(seconds - targetSeconds) / targetSeconds : 0
  return { seconds, drift, measured, expected }
}

/**
 * 这份预算合计够不够格参与对账：给到秒数的镜数太少时不动手。
 *
 * 为什么要有这条守卫：分镜里总有几镜是画面文案（没有台词）或没排到预算，
 * 合计就成了"一部分镜的秒数"，拿它去补写稿件等于照着半份数改稿。给到八成以上才认为可用。
 *
 * @param gap - {@link voiceDurationGap} 的结果。
 * @returns 可以据此判断偏差时为 true。
 */
function voiceGapIsUsable(gap: { seconds: number, measured: number, expected: number }): boolean {
  return gap.seconds > 0 && gap.expected > 0 && gap.measured >= Math.ceil(gap.expected * 0.8)
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
 * @param options - 执行选项。
 * @param options.resume - 断点续跑：分镜表、稿件与已生成的镜头都取自任务记录，只跑剩下的镜，
 *   最后按镜头顺序重新拼整条。缺省为全新执行（重新写稿、重新排分镜）。
 */
export async function runLongVideoJob(
  deps: LongVideoDeps,
  taskId: string,
  producer: LongVideoProducer,
  options: { resume?: boolean } = {},
): Promise<void> {
  const workDir = longVideoWorkDir(deps.dataRoot, taskId)
  mkdirSync(workDir, { recursive: true })
  // 停止信号：用户点「停止」时只置这个标记（见 stopLongVideoTask）。
  // 正在飞的那一次厂商调用追不回来，但每一镜开始前都会检查它，不会再下下一单。
  const control = { stopped: false }
  runningJobs.set(taskId, control)
  /** 本次从第几镜开始跑：全新任务是 0，续跑是第一条还没跑成的镜。 */
  let startIndex = 0
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
    // 这次生成的口播语速：写稿字数与兜底分镜的时长都按它折算（选慢音色时成片才不会被拖长）。
    const pace = producer.charsPerSecond !== undefined && producer.charsPerSecond > 0
      ? producer.charsPerSecond
      : CHARS_PER_SECOND
    const planned = planSegmentCount(task.targetSeconds)
    const brief = producer.scriptBrief(task.targetSeconds, planned)
    const instruction = scriptLengthInstruction(task.targetSeconds, pace)
    // 续跑：分镜表与稿件都已在盘上，直接接着用——重排一次会得到另一套镜头，
    // 已经花厂商调用跑出来的那几镜就对不上了。
    const resumeShots = options.resume === true ? (task.shots ?? []) : []
    if (resumeShots.length > 0) {
      startIndex = resumeStartIndex(task)
      const spoken = task.scriptText ?? ''
      if (spoken === '') {
        fail('这条任务没有留存稿件，无法从中断处继续')
        return
      }
      if (startIndex >= resumeShots.length) {
        // 中断发生在"最后一镜跑成、还没来得及拼接"时：不必再调厂商，直接拼。
        if (control.stopped) return
        const composed = await composeLongVideo(deps, task, resumeShots, spoken)
        if (!composed.ok) fail(composed.error)
        return
      }
      // 母时钟只补还没跑成的镜：已跑成的镜由它自己的成片文件承载画面与声音，
      // 重估只会把那一镜已经定下来的时长改掉。
      const budget = producer.planShotSeconds === undefined
        ? undefined
        : await producer.planShotSeconds({ shots: resumeShots.slice(startIndex) })
      if (budget !== undefined) {
        for (const shot of resumeShots) {
          const seconds = budget.seconds[String(shot.index)]
          if (typeof seconds === 'number' && seconds > 0) shot.seconds = seconds
        }
      }
      update(target => {
        target.status = 'generating'
        target.errorMessage = ''
      })
      for (let i = startIndex; i < resumeShots.length; i += 1) {
        if (control.stopped) return
        const shot = resumeShots[i]!
        const outcome = await produceShot(producer, {
          index: i,
          shot,
          workDir,
          resolution: task.resolution,
          aspectRatio: task.aspectRatio,
        }, producer.retryOnFailure ?? '', notice => {
          // 重试期间如实告知：面板上写清"哪一镜、第几次、还有多久"，而不是干等。
          update(target => { target.errorMessage = notice })
        })
        if (control.stopped) return
        if (!outcome.ok) {
          update(target => {
            const targetShot = target.shots?.[i]
            if (targetShot !== undefined) {
              targetShot.status = 'failed'
              targetShot.errorMessage = outcome.error
            }
          })
          // 走公共收尾口：能续就续，续不动才判死（就是这里昨晚漏了，白等 6 小时）。
          if (scheduleAutoResumeOrFail(update, deps, taskId, producer, '续跑在第 ' + String(i + 1) + ' 镜遇到厂商限流')) return
          update(target => {
            target.status = 'failed'
            target.errorMessage = '续跑在第 ' + String(i + 1) + ' 镜停下（已自动续跑 '
              + String(AUTO_RESUME_MAX_ROUNDS) + ' 轮仍未成）：' + outcome.error
          })
          return
        }
        // 官方口径：生成回来先记「未检查」，机器验收通过才算 accepted。
        const verdict = await inspectShotOutcome(outcome, workDir, String(i))
        update(target => {
          const segment = target.segments[i]
          if (segment !== undefined) segment.audioSeconds = outcome.seconds
          const targetShot = target.shots?.[i]
          if (targetShot !== undefined) {
            targetShot.status = verdict.state
            targetShot.evidence = verdict.evidence
            if (verdict.state === 'rejected') targetShot.errorMessage = verdict.evidence
          }
          target.shotFiles = { ...(target.shotFiles ?? {}), [String(i)]: outcome.file }
          // 进度是"这一条片已经跑成几镜"，不是"本次跑了几镜"。
          target.doneSegments = Object.keys(target.shotFiles).length
        })
      }
      if (control.stopped) return
      const resumed = deps.loadTasks().find(item => item.id === taskId) ?? task
      await composeLongVideo(deps, resumed, resumeShots, spoken)
      return
    }
    const stored = task.scriptText === undefined ? '' : normalizeSpokenText(task.scriptText)
    const calibrated = stored === ''
      ? await calibrateScript(deps, task.topic, brief, task.targetSeconds, pace, produce => update(target => {
        target.scriptText = produce.text
        target.scriptChars = produce.chars
      }))
      : { ok: true as const, text: stored, chars: spokenCharCount(stored), meetsTarget: spokenCharCount(stored) >= minScriptChars(task.targetSeconds, pace), rewriteError: '', rewriteFailures: 0 }
    if (!calibrated.ok) {
      fail(calibrated.error)
      return
    }
    // 这两份在 DEF-228 的重写里会被替换：重写后的稿子必须与写稿出口过同一把尺子
    // （先截断、再自述检测、再长度判定），否则"改完一句"就能绕过前面所有闸门。
    let scriptText = calibrated.text
    let bestChars = calibrated.chars
    // 模型的"自述"混进正文时**不出片**：那些字会被当台词念出来（实测 1084 字 / 目标 90 秒，
    // 配音 242 秒），成片里会出现"模型接口连续两次调用失败"这种句子——宁可如实失败让用户重试。
    const narration = scriptNarrationMarker(scriptText)
    if (narration !== '') {
      update(target => {
        target.scriptText = scriptText
        target.scriptChars = bestChars
        target.errorCode = 'script-narrated'
      })
      fail(scriptNarratedReason(narration))
      return
    }
    // 段落级重复检测（DEF-228）：提示词里早就写了「不要重复」，但**字数判据只认总数**——
    // 把同一段复述几遍凑出来的字数同样过闸，成片于是变成同一句话念好几遍。
    // 命中先给模型一次带原文的改正机会（只一次）；仍重复就如实失败，不拿"字数够了"冒充合格稿。
    const repeated = repeatedScriptSegments(scriptText)
    if (repeated.length > 0) {
      console.error('[LONG_VIDEO_DUP] 稿件有 ' + String(repeated.length) + ' 处重复段落：'
        + repeated.map(item => item.text.slice(0, 20) + ' ×' + String(item.count)).join('；'))
      const deduped = await deps.writeScript(task.topic, brief, dedupeRewriteInstruction(task.targetSeconds, pace, scriptText, repeated))
      if (!deduped.ok) {
        update(target => {
          target.scriptText = scriptText
          target.scriptChars = bestChars
          target.errorCode = 'script-duplicated'
        })
        fail(duplicatedScriptReason(repeated, '这次没能重写（' + deduped.error + '）'))
        return
      }
      const candidate = clampScriptLength(normalizeSpokenText(deduped.text), task.targetSeconds, pace)
      const stillRepeated = repeatedScriptSegments(candidate)
      if (stillRepeated.length > 0) {
        update(target => {
          target.scriptText = candidate
          target.scriptChars = spokenCharCount(candidate)
          target.errorCode = 'script-duplicated'
        })
        fail(duplicatedScriptReason(stillRepeated, '已按「不得重复」重写过一次'))
        return
      }
      // 重写稿同样要过自述检测：模型可能借这次重写把自己的说明写进正文。
      const rewrittenNarration = scriptNarrationMarker(candidate)
      if (rewrittenNarration !== '') {
        update(target => {
          target.scriptText = candidate
          target.scriptChars = spokenCharCount(candidate)
          target.errorCode = 'script-narrated'
        })
        fail(scriptNarratedReason(rewrittenNarration))
        return
      }
      scriptText = candidate
      bestChars = spokenCharCount(candidate)
      update(target => {
        target.scriptText = scriptText
        target.scriptChars = bestChars
        // 重写成功后清掉失败码：可选字段"没有"就是不存在，不写空串冒充一个值。
        delete target.errorCode
      })
    }
    // 长度判定以**当下这一稿**为准（可能是刚重写过的）：拿重写前的结论放行，等于给重写开了后门。
    const meetsTarget = bestChars >= minScriptChars(task.targetSeconds, pace)
    if (!meetsTarget) {
      // 差多少：口径与门槛完全一致（都按去标点字数与这条音色的语速折算）。
      const shortfall = scriptLengthGap(scriptText, task.targetSeconds, pace)
      const shortfallRatio = shortfall.required > 0 ? shortfall.deficit / shortfall.required : 0
      // 补写整轮都失败（模型没配好/网络抖动）：这与"稿件就是短"是两件事，文案要分开（DEF-227）。
      const rewriteExhausted = calibrated.rewriteFailures >= MAX_SCRIPT_REWRITE_ROUNDS
      // DEF-229 降档：只差一点点（≤5%）时不再判死整条——实测一条 90 秒的片子只差 7 个字就整条失败，
      // 用户白等一场、什么都没拿到。按实际字数反推有效时长继续出片，成片只是略短于目标，
      // 且有效时长如实落盘（前端据此写「按这版稿子成片约 N 秒」），比"什么都不产出"有用得多。
      if (shortfallRatio <= SCRIPT_SHORTFALL_TOLERANCE_RATIO) {
        console.error('[LONG_VIDEO_DOWNGRADE] 稿件 ' + String(shortfall.chars) + ' 字 / 目标 '
          + String(task.targetSeconds) + ' 秒需 ' + String(shortfall.required) + ' 字（差 '
          + String(shortfall.deficit) + ' 字，' + String(Math.round(shortfallRatio * 100)) + '% ≤ '
          + String(Math.round(SCRIPT_SHORTFALL_TOLERANCE_RATIO * 100)) + '%）：按这版稿子成片约 '
          + String(shortfall.seconds) + ' 秒，继续排分镜')
        update(target => {
          target.scriptText = scriptText
          target.scriptChars = bestChars
          // 降档后的"这条片实际多长"：字数 ÷ 语速，与字数门槛同一把尺子。
          target.effectiveSeconds = shortfall.seconds
          // 清掉可能残留的失败码：这一次不是失败，是主动降档。
          delete target.errorCode
        })
      }
      else {
        // 把最长的一稿与分类码一并落盘：用户能看见"写了多少字、差多少字"，
        // 补写接口也才有依据接着扩写（DEF-108）。
        update(target => {
          target.scriptText = scriptText
          target.scriptChars = bestChars
          target.errorCode = rewriteExhausted ? 'script-rewrite-failed' : 'script-too-short'
        })
        // 两条原因分开写：稿件不足是一个事实，补写根本没用上是另一个事实（DEF-227），
        // 拼成一句会让用户以为是自己的卖点没写够，实际是写稿模型这段时间不可用。
        fail(scriptTooShortReason(scriptText, task.targetSeconds, pace)
          + (rewriteExhausted
              ? '另外：自动补写连续 ' + String(calibrated.rewriteFailures) + ' 轮全部失败'
                + (calibrated.rewriteError === '' ? '，' : '（' + calibrated.rewriteError + '），')
                + '这条稿子没有被补过；请检查写稿模型是否可用后重试。'
              : (calibrated.rewriteError === '' ? '' : '（补写调用失败：' + calibrated.rewriteError + '）')))
        return
      }
    }
    const spoken = normalizeSpokenText(scriptText)
    if (spoken === '') {
      fail('稿件切不出可生成的镜头')
      return
    }
    // 分镜由生成器排（它认识 producerRef：数字人的形象图、用户给的产品图都在它手里）；
    // 生成器没提供或排不出来时，编排层用自己的兜底排——**绝不因为分镜失败让整条片跑不了**。
    // 这一步与配音合成一起收进 placedVoice：偏离目标时长时要用补写后的稿件重排一次（见下）。
    const placeShotsAndVoice = async (script: string, lengthInstruction: string):
    Promise<{ shots: ZyShot[], gap: ReturnType<typeof voiceDurationGap> }> => {
      const planned2 = producer.planShots === undefined
        ? undefined
        : await producer.planShots({ targetSeconds: task.targetSeconds, brief, instruction: lengthInstruction, topic: task.topic, script })
      const placed = planned2 !== undefined && planned2.shots.length > 0
        ? planned2.shots
        : fallbackShotsForScript(script, producer.kind, [], pace)
      // 母时钟：**先把全片每一镜的出片时长定下来**，用预算秒数写回每一镜，再开始生成画面。
      // 顺序很重要——厂商按"你给的秒数"出片，而这份秒数是在这一次调用之前算出来的。
      const budget = producer.planShotSeconds === undefined
        ? undefined
        : await producer.planShotSeconds({ shots: placed })
      if (budget !== undefined) {
        for (const shot of placed) {
          const seconds = budget.seconds[String(shot.index)]
          if (typeof seconds === 'number' && seconds > 0) shot.seconds = seconds
        }
      }
      return {
        shots: placed,
        gap: voiceDurationGap(budget, placed, task.targetSeconds),
      }
    }
    let shotInstruction = instruction
    let placedResult = await placeShotsAndVoice(spoken, shotInstruction)
    let shots = placedResult.shots
    let gap = placedResult.gap
    /** 实际拿去出片的这一版稿件（对账重合成会换成补写后的那一版）。 */
    let approvedScript = spoken
    // 母时钟对账：每一镜的出片时长都是本次估算出来的（Σ 预算秒数），而**一分钱厂商额度都还没花**。
    // 此刻偏差超容忍就按实际用词补写一版稿子重估一遍——这两步都不花钱，纠正的却是用户真正在乎的那个数。
    // 只补一轮：第二轮仍偏离说明分镜没把稿件讲完（或讲超了），如实告诉用户比无限补写更有用（DEF-113）。
    if (producer.planShotSeconds !== undefined && voiceGapIsUsable(gap) && gap.drift > DURATION_TOLERANCE_RATIO) {
      // 分子必须是**分镜真正要念的那份文本**：秒数按分镜的 line 折算，而分镜可能没把稿件讲完。
      // 拿整篇稿件的字数去除以分镜的秒数，得出的语速会偏快，补写于是把稿子越补越长、
      // 成片却一点都不变长（实测稿件 448 字 / 分镜只念了 335 字 → 算出 5.98 字/秒，而真实语速是 4.47）。
      const voicedChars = shotsSpokenChars(shots)
      const measuredPace = voicedChars / gap.seconds
      console.error('[LONG_VIDEO_ERR] 母时钟对账：出片时长合计 ' + gap.seconds.toFixed(1) + ' 秒 / 目标 ' + String(task.targetSeconds)
        + ' 秒（偏差 ' + String(Math.round(gap.drift * 100)) + '%，折算语速 ' + pace.toFixed(2) + ' → 按分镜实际用词 ' + measuredPace.toFixed(2)
        + ' 字/秒，共 ' + String(voicedChars) + ' 字），按这个语速补写一版稿件后重新分镜')
      const corrected = await calibrateScript(deps, task.topic, brief, task.targetSeconds, measuredPace, produce => update(target => {
        target.scriptText = produce.text
        target.scriptChars = produce.chars
      }))
      if (!corrected.ok) {
        // 补写调用本身失败：不中止整条，用已经定好时长的那一版分镜照常出片（它至少是能看的）。
        console.error('[LONG_VIDEO_ERR] 对账后补写失败，按现有稿件出片：' + corrected.error)
      }
      else if (corrected.chars > spokenCharCount(spoken)) {
        // 对账后的补写**同样要过截断**：这条支路绕开了写稿出口的 clamp，
      // 实测把 30 秒档从 149 又推回 177 字（超 19%）——出口不统一，前面截得再准也会被这里补回去。
      const respoken = clampScriptLength(normalizeSpokenText(corrected.text), task.targetSeconds, measuredPace)
        shotInstruction = scriptLengthInstruction(task.targetSeconds, measuredPace)
        const replanned = await placeShotsAndVoice(respoken, shotInstruction)
        // 补写与重排只可能让这份稿子更贴目标时长；更差就保留第一版，不拿"照着偏差改坏"当真。
        if (voiceGapIsUsable(replanned.gap) && replanned.gap.drift < gap.drift) {
          placedResult = replanned
          shots = replanned.shots
          gap = replanned.gap
          approvedScript = respoken
        }
        else {
          console.error('[LONG_VIDEO_ERR] 对账后重排仍偏离 ' + String(Math.round(replanned.gap.drift * 100)) + '%，保留第一版分镜')
        }
      }
    }
    update(target => {
      target.shots = shots
      // 各镜时长此时已是**母时钟给的出片秒数**，前端进度面板显示的就是它。
      target.segments = shots.map((shot, index) => ({ index, text: shot.line, audioSeconds: shot.line === '' ? 0 : shot.seconds }))
      target.totalSegments = shots.length
      target.doneSegments = 0
      // 稿件长度如实落盘：生成记录里能看到"这条片实际有多少字、折合多少秒"。
      target.scriptText = approvedScript
      target.scriptChars = spokenCharCount(approvedScript)
      // 母时钟算出的成片时长：与目标的差距在任何画面调用之前就已确定，进度面板据此如实回报。
      if (gap.seconds > 0) target.voicedSeconds = gap.seconds
      // 模型可能把稿子写长于目标时长：如实回报实际镜数，不按目标时长假装进度。
      target.status = 'generating'
      target.errorMessage = ''
    })

    // 官方 create-video 的节奏 + 厂商异步任务的事实：**不必等上一镜出完再下下一镜**。
    // 厂商下单返回任务 id、后台自己生成，我们轮询取结果——只要按官方 RPM 把每一镜的
    // 启动时刻错开，多个镜头就能同时处于生成中。实测（2026-09-28）：12 镜串行 48 分钟，
    // 按 RPM 放行后理论下限约 12 分钟。
    // **串行**：每一镜跑完再跑下一镜。
    // 流水线版本（Promise.all + 错峰闸门）实测会在「母时钟对账」之后卡死——
    // 任务停在 0/12 镜、11 分钟零媒体调用、连第一镜都没下单（2026-09-28 现场）。
    // 串行慢，但它确定能出片；流水线要先把卡死原因查清再上，不拿用户的任务当试验田。
    const shootResults: string[] = []
    for (let i = 0; i < shots.length; i += 1) {
      if (control.stopped) return
      const shot = shots[i]!
      // 连续性：这一镜要接住上一镜时，先抽出上一镜的**尾帧**当首帧参考。
      // 依据官方 create-video 的相邻镜三分类——只有 continuous（同一动作跨镜延续）才接，
      // 其余两类官方明确要求「不要人为制造帧间连续」。抽帧失败就留空退回常规生成，不硬凑。
      let tailFrameFile: string | undefined
      if (shot.relationship === 'continuous' && i > 0) {
        const prevFile = String((deps.loadTasks().find(item => item.id === taskId)?.shotFiles ?? {})[String(i - 1)] ?? '')
        if (prevFile !== '') {
          const frameOut = join(workDir, 'tail-' + String(i - 1) + '.png')
          const got = await extractTailFrame(prevFile, frameOut)
          if (got !== '') {
            tailFrameFile = got
            console.error('[CONTINUITY] 第 ' + String(i + 1) + ' 镜标为 continuous，已接住第 ' + String(i) + ' 镜尾帧')
          }
        }
      }
      const outcome = await produceShot(producer, {
        index: i,
        shot,
        workDir,
        resolution: task.resolution,
        aspectRatio: task.aspectRatio,
        ...(tailFrameFile === undefined ? {} : { tailFrameFile }),
      }, producer.retryOnFailure ?? '', notice => {
        update(target => { target.errorMessage = notice })
      })
      if (control.stopped) return
      if (!outcome.ok) {
        // 逐镜标记失败原因：用户只重做这一镜就能救，不必整条重跑。
        update(target => {
          const target_shot = target.shots?.[i]
          if (target_shot !== undefined) {
            target_shot.status = 'rejected'
            target_shot.errorMessage = outcome.error
          }
        })
        shootResults.push('failed')
        break
      }
      // 官方口径：生成回来先记「未检查」，机器验收通过才算 accepted。
      const verdictMain = await inspectShotOutcome(outcome, workDir, String(i))
      update(target => {
        const segment = target.segments[i]
        if (segment !== undefined) segment.audioSeconds = outcome.seconds
        const targetShot = target.shots?.[i]
        if (targetShot !== undefined) {
          targetShot.status = verdictMain.state
          targetShot.evidence = verdictMain.evidence
          if (verdictMain.state === 'rejected') targetShot.errorMessage = verdictMain.evidence
        }
        // 记住这一镜对应哪个文件：逐镜重做要替换它，重新拼接要按镜头顺序取。
        target.shotFiles = { ...(target.shotFiles ?? {}), [String(i)]: outcome.file }
        // 进度口径是「这条片已经跑成几镜」，不是「本次跑了几镜」——续跑时两者不一样。
        target.doneSegments = Object.keys(target.shotFiles).length
      })
      shootResults.push('ok')
    }
    if (control.stopped) return
    // 有镜失败：如实收尾。已跑成的镜都留在 shotFiles 里，走「从断点继续」就能接着跑，
    // 不必从头再花一遍额度。
    const failedAt = shootResults.findIndex(state => state === 'failed')
    if (failedAt >= 0) {
      // 单镜撞限流不再直接判死整条：自动等一会儿从断点续跑，续满 AUTO_RESUME_MAX_ROUNDS 轮才如实失败。
      // 为什么（2026-10-10 实测）：免费档限流是「过一会儿就好」，旧行为一镜失败就判死，
      // 用户得自己守在屏幕前点「从断点继续」——人不在就整条白跑。这条链路本身跑得通（历史 21/21 镜成片），
      // 缺的是「失败了自动再试」，不是「让人盯着」。
      if (scheduleAutoResumeOrFail(update, deps, taskId, producer, '第 ' + String(failedAt + 1) + ' 镜遇到厂商限流')) return
      update(target => {
        target.status = 'failed'
        target.errorMessage = '第 ' + String(failedAt + 1) + ' 镜生成失败（已自动续跑 '
          + String(AUTO_RESUME_MAX_ROUNDS) + ' 轮仍未成）；已跑成的镜都保留着，可「从断点继续」。'
      })
      return
    }

    // 重新读一次：各镜真实时长是在循环里逐镜写回的，本地 task 还是建任务时的那份快照。
    if (control.stopped) return
    const withTimings = deps.loadTasks().find(item => item.id === taskId) ?? task
    await composeLongVideo(deps, withTimings, shots, scriptText)
  }
  catch (error) {
    fail(error instanceof Error ? error.message : '长视频生成失败')
  }
  finally {
    if (runningJobs.get(taskId) === control) runningJobs.delete(taskId)
  }
  // 各镜成片**故意保留**（原先当"中间文件"删掉）：
  // 逐镜重做要替换其中一镜再重新拼接，原文件删了重做就无从可做（实测踩过：ENOENT）。
  // 代价是 uploads 里会留 n 份分镜成片——与"某镜不满意只重跑一镜"相比，这个代价可以接受；
  // 真正被替换掉的那一镜会在 {@link redoShot} 里删掉，避免无效堆积。
}

/**
 * 收尾：把各镜成片拼成一条、置为成功并登记。
 *
 * 主流程（`runLongVideoJob`）、断点续跑与逐镜重做都走这一条——三处各写一份的话，
 * 字幕口径、镜头顺序、登记行为迟早会走岔（重做那条原先就是复制粘贴出来的）。
 *
 * 状态语义：拼接失败时置 `failed` 并留原因；成功时清掉上一次的失败原因再置 `success`。
 * 登记失败不回退成片——视频已经在盘上、用户已经能放，登记只是侧账。
 *
 * @param deps - 注入的存储与登记能力。
 * @param task - 当前任务记录（含各镜成片路径与真实时长）。
 * @param shots - 按镜头顺序排列的分镜；`task.shotFiles` 里有文件的镜才会进成片。
 * @param script - 这条成片的稿件正文（登记草稿时一并留存）。
 * @returns 成功时给成片 URL；失败时给可读原因（状态已落盘为 failed）。
 */
async function composeLongVideo(
  deps: LongVideoDeps,
  task: ZyLongVideoTask,
  shots: ZyShot[],
  script: string,
): Promise<{ ok: true, url: string } | { ok: false, error: string }> {
  // 官方 create-video 规范：只组装**已接受**的有序清单——被拒绝或被卡住的镜不能进成片。
  // 此前只检查"文件在不在"，于是验收没过（文件损坏、解不出时长）的镜照样被拼进去，
  // 用户拿到一条"看着成功、其实中间有一镜是坏的"片子。历史记录的 ready 等同 accepted
  // （旧口径没有验收环节，不能因为读旧数据就把老任务判死）。
  const notAccepted = shots.filter(shot => {
    const file = task.shotFiles?.[String(shot.index)]
    if (typeof file !== 'string' || file === '') return false
    return shot.status !== 'accepted' && shot.status !== 'ready'
  })
  if (notAccepted.length > 0) {
    const first = notAccepted[0]!
    return {
      ok: false,
      error: '第 ' + String(first.index + 1) + ' 镜没有通过验收（'
        + String(first.evidence ?? first.errorMessage ?? first.status)
        + '），已停止拼接：成片里不允许出现没验收过的镜头。请「重做这一镜」后重试。',
    }
  }
  const assetId = 'lv-' + task.id + '.mp4'
  // 按**镜头顺序**取文件与**文件真实时长**：拼接层按同一个下标取时长，
  // 顺序错了字幕与转场就会整体前移或后移（重做替换过某一镜之后尤其容易踩）。
  // 时长取自文件而不是记录：厂商出片时会重新配音，成片长度与母时钟给的配音长度常常不同，
  // 用记录里的配音时长算字幕，逐镜累加就会飘（实测逐镜重做后字幕串到下一镜的产品画面上）。
  const { files: segments, durations: segmentDurations } = await orderedSegmentFilesWithDurations(task.shotFiles, shots)
  // 字幕按**镜头**建（一镜一条），时长取该镜成片文件的真实秒数：
  // 画面与字幕因此共用同一份事实，不需要"哪条字幕属于哪一镜"的映射，也就不会串镜。
  const cueDurations: number[] = []
  const cueTexts: Array<{ text: string }> = []
  {
    let position = 0
    for (const shot of shots) {
      const file = task.shotFiles?.[String(shot.index)]
      if (typeof file !== 'string' || file === '') continue
      // 台词里的换行只是剧本的排版（模型常按行写稿）：一条字幕就是**一镜的说的话**，
      // 换行折成一行，绝不能因为折行把一句话拆成两条字幕、各占一段时间。
      const line = shot.line.replace(/\s+/g, ' ').trim()
      // 一条字幕 = 一句话（不是一镜的整段台词）：整段上屏会糊满画面，标点也会一起显示。
      // 这一镜的时长按字数分给切出来的每条短句，字幕与画面仍然同一份时间轴。
      const phrases = splitCuePhrases(line)
      const shotSeconds = segmentDurations[position] ?? 0
      const totalChars = phrases.reduce((sum, phrase) => sum + phrase.length, 0)
      for (const phrase of phrases) {
        cueTexts.push({ text: phrase })
        cueDurations.push(totalChars === 0 ? 0 : shotSeconds * (phrase.length / totalChars))
      }
      position += 1
    }
  }
  const composed = await composeSegments({
    segments,
    segmentDurations,
    outFile: join(deps.dataRoot, 'uploads', assetId),
    resolution: task.resolution,
    aspectRatio: task.aspectRatio,
    ...(task.withSubtitles === false ? {} : {
      subtitles: buildSubtitleCuesFromDurations(cueTexts, index => cueDurations[index] ?? 0),
    }),
  })
  if (!composed.ok) {
    const tasks = deps.loadTasks()
    const target = tasks.find(item => item.id === task.id)
    if (target !== undefined) {
      target.status = 'failed'
      target.errorMessage = composed.error
      target.updatedAt = new Date().toISOString()
      deps.saveTasks(tasks)
    }
    return { ok: false, error: composed.error }
  }
  const url = '/bosom-friend/api/assets/file/' + encodeURIComponent(assetId)
  // 成片时长**量一次**再落盘：记录里的 voicedSeconds 是母时钟按稿件估算的（62 秒），
  // 而厂商实际出片 67 秒——界面拿估算值当"成片多长"会与用户看到的成片对不上，
  // 所以这里用 ffprobe 读成片文件，把**实测值**单独记在 actualSeconds 上。
  const actualSeconds = await probeDurationSeconds(join(deps.dataRoot, 'uploads', assetId))
  const tasks = deps.loadTasks()
  const target = tasks.find(item => item.id === task.id)
  if (target !== undefined) {
    target.videoUrl = url
    target.status = 'success'
    target.errorMessage = ''
    if (actualSeconds > 0) target.actualSeconds = Math.round(actualSeconds * 10) / 10
    target.updatedAt = new Date().toISOString()
    deps.saveTasks(tasks)
  }
  const finished = deps.loadTasks().find(item => item.id === task.id)
  if (finished !== undefined) await deps.registerVideo(finished, script)
  return { ok: true, url }
}

/**
 * 重做某一镜：只重跑这一镜，然后把整条按镜头顺序重新拼一遍。
 *
 * 为什么不是"整条重跑"：一条 120 秒的片子有 20 多镜，重跑要十几分钟；
 * 某一镜不满意就整条重来，用户等不起也花不起积分——这是"可返工"这条能力的落点。
 *
 * 依赖一个前提：**各镜成片要留在盘上**（见 {@link runLongVideoJob} 收尾处的说明）。
 *
 * 三处边界都由调用方先判、这里再判一次（不信任调用顺序）：
 * 任务必须在跑完/失败的终态（生成中重做会与主流程抢同一份文件）、镜号必须存在、那一镜必须已生成过。
 *
 * @param deps - 注入的存储与登记能力。
 * @param taskId - 任务 id。
 * @param index - 要重做的镜号（0 起）。
 * @param producer - 本次使用的镜头生成器。
 * @returns 这一镜的新真实时长；失败给出可读原因。
 */
export async function redoShot(
  deps: LongVideoDeps,
  taskId: string,
  index: number,
  producer: LongVideoProducer,
): Promise<{ ok: true, seconds: number } | { ok: false, error: string }> {
  const task = deps.loadTasks().find(item => item.id === taskId)
  if (task === undefined) return { ok: false, error: '任务不存在' }
  if (task.status === 'generating') return { ok: false, error: '这条片还在生成，等它跑完再重做某一镜' }
  const shot = task.shots?.[index]
  if (shot === undefined) return { ok: false, error: '没有这一镜' }
  if (typeof task.shotFiles?.[String(index)] !== 'string') return { ok: false, error: '这一镜还没有生成过，无法重做' }
  const workDir = longVideoWorkDir(deps.dataRoot, taskId)
  mkdirSync(workDir, { recursive: true })
  const previousFile = task.shotFiles[String(index)] ?? ''
  const outcome = await producer.produce({
    index,
    // 参考图先收一遍：素材可能已被删除，读不出的图不能让整镜白跑。
    shot: sanitizeShotReferences(deps, shot),
    workDir,
    resolution: task.resolution,
    aspectRatio: task.aspectRatio,
  })
  if (!outcome.ok) {
    const tasks = deps.loadTasks()
    const target = tasks.find(item => item.id === taskId)
    if (target !== undefined) {
      const targetShot = target.shots?.[index]
      if (targetShot !== undefined) {
        targetShot.status = 'failed'
        targetShot.errorMessage = outcome.error
      }
      target.errorMessage = '第 ' + String(index + 1) + ' 镜重做失败：' + outcome.error
      target.updatedAt = new Date().toISOString()
      deps.saveTasks(tasks)
    }
    return { ok: false, error: outcome.error }
  }

  const tasks = deps.loadTasks()
  const target = tasks.find(item => item.id === taskId)
  if (target === undefined) return { ok: false, error: '任务不存在' }
  target.shotFiles = { ...(target.shotFiles ?? {}), [String(index)]: outcome.file }
  const segment = target.segments[index]
  // 记录里存**成片文件**的真实时长（不是配音时长）：字幕时间轴按它累加，
  // 存配音时长会让重做后的整条字幕相对画面平移。
  if (segment !== undefined) {
    const probed = await probeDurationSeconds(outcome.file)
    segment.audioSeconds = probed > 0 ? probed : outcome.seconds
  }
  const targetShot = target.shots?.[index]
  if (targetShot !== undefined) {
    // 重做这一镜同样要走官方验收：文件存在、非空、可解码才算 accepted。
    const verdict = await inspectShotOutcome(outcome, workDir, String(index))
    targetShot.status = verdict.state
    targetShot.evidence = verdict.evidence
    if (verdict.state === 'rejected') targetShot.errorMessage = verdict.evidence
    else delete targetShot.errorMessage
  }
  target.errorMessage = ''
  target.updatedAt = new Date().toISOString()
  // 先落盘再拼接：拼接失败时"这一镜已重做"这个事实不能丢。
  deps.saveTasks(tasks)

  const composed = await composeLongVideo(deps, target, target.shots ?? [], task.scriptText ?? '')
  // 旧的那一镜文件没人再引用了，删掉避免 uploads 越堆越多。
  if (previousFile !== '' && previousFile !== outcome.file) {
    try { unlinkSync(previousFile) } catch { /* 已被清理 */ }
  }
  return composed.ok ? { ok: true, seconds: outcome.seconds } : { ok: false, error: composed.error }
}

/** 段落类型再导出，调用方不必同时 import 两个模块。 */
export type { ZyLongVideoSegment, ZyLongVideoTask }
