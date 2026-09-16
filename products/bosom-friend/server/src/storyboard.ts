/**
 * 分镜表：把"一段稿子"编排成"一组镜头"，这是通用工作流的核心中间层。
 *
 * 为什么要它：真人带货片里人只出镜一半时间，另一半在拍产品——**镜头交替**才是"像拍过的"的来源。
 * 旧的"写稿 → 按句切段 → 拼接"只会产出"一个人从头念到尾"，段与段之间硬切还在人脸上。
 *
 * 本模块只做三件事，全部是纯函数（可单测、不碰厂商与存储）：
 * 1. 生成给模型的分镜要求（{@link buildStoryboardPrompt}）；
 * 2. 解析并**夹紧**模型返回的分镜表（{@link parseShotPlan}）——模型输出不可信，越界一律夹回来；
 * 3. 模型不可用/输出不可解析时的确定性兜底（{@link fallbackShotPlan}），保证任何情况下都排得出片。
 *
 * 与内容形式无关：镜头卡片（ZyShot）里的 provider 只是字段，
 * 数字人口播、产品特写、场景空镜共用同一套编排。
 * @module @deepseek-ai/dsh-bosom-friend-server/storyboard
 */

import { SEGMENT_MAX_SECONDS, SEGMENT_MIN_SECONDS, estimateSeconds } from './long-video.ts'
import type { ZyShot, ZyShotKind, ZyShotRef } from './types.ts'

/** 全片镜头节奏的标定值：成熟带货片的平均镜头长度约 6 秒（见知识库条目 13）。 */
export const AVG_SHOT_SECONDS = 6

/** 单镜时长边界：与厂商单次生成上限同一口径，编排层不承诺厂商给不出的东西。 */
export const SHOT_MIN_SECONDS = SEGMENT_MIN_SECONDS
export const SHOT_MAX_SECONDS = SEGMENT_MAX_SECONDS

/** 产品镜在整条片里至少要占的镜头数下限（不足则画面会退化成"一个人念稿"）。 */
export const MIN_PRODUCT_SHOTS = 2

/**
 * 目标时长对应的镜头数。
 * @param targetSeconds - 目标成片时长（秒）。
 * @returns 镜头数（至少 2：一个开场、一个收尾）。
 */
export function planShotCount(targetSeconds: number): number {
  const seconds = Number.isFinite(targetSeconds) && targetSeconds > 0 ? targetSeconds : AVG_SHOT_SECONDS * 4
  return Math.max(2, Math.round(seconds / AVG_SHOT_SECONDS))
}

/**
 * 生成分镜要求（并进写稿提示词）。
 *
 * 三条硬约束不是风格偏好，都是实测结论：
 * - **产品镜必须占一定比例**：否则成片就是"一个人念稿"；
 * - **画面里不出现任何文字/logo**：文生图/文生视频会生成臆造品牌（实测出现过乱码标签），
 *   品牌文字一律走后期叠加；
 * - **连续性描述全片一致**：光线/背景/服装写在每一镜里，跨镜才不会各长一套。
 *
 * @param targetSeconds - 目标成片时长（秒）。
 * @param hasProductReference - 用户是否提供了产品参考图（决定产品镜走"照着产品"还是"纯描述"）。
 * @returns 并进提示词的分镜要求。
 */
export function buildStoryboardPrompt(targetSeconds: number, hasProductReference: boolean): string {
  const shots = planShotCount(targetSeconds)
  const productShots = Math.max(MIN_PRODUCT_SHOTS, Math.round(shots * 0.4))
  return [
    '把这条片排成 ' + String(shots) + ' 个镜头（口播镜与产品镜交替），输出 JSON：',
    '{"continuity":"全片统一的光线/背景/服装/景别描述","shots":[{"kind":"talking-head|product|scene","seconds":数字,"line":"口播文本","visual":"画面提示词","beat":"hook|pain|product|cta"}]}',
    '要求：',
    '1. 共 ' + String(shots) + ' 镜，其中**至少 ' + String(productShots) + ' 个 product 镜头**（画面主体是产品本身：特写、细节、使用演示），其余为 talking-head；',
    '2. 每个 talking-head 镜的 line 是可以直接念出来的口播文本；product/scene 镜的 line 留空，visual 写清主体、动作、环境、镜头运动；',
    '3. **所有 visual 与 line 里都不许出现任何文字、品牌名、logo、包装印刷内容**：画面里的文字一律由后期叠加，模型不要试图画字；',
    '4. continuity 写一次即可（光线、背景、服装、色调），全片共用；',
    '5. seconds 是这一镜的时长（4~12 秒之间），全部镜头相加要接近 ' + String(targetSeconds) + ' 秒；',
    hasProductReference
      ? '6. 用户提供了产品参考图：product 镜要描述"以参考图中的产品为主体"的动作（缓慢旋转、光带扫过、特写拉近），不要改变产品外形。'
      : '6. 没有产品参考图：product 镜只描述产品的形态与使用场景，不要编造包装上的文字或品牌。',
    '只输出 JSON，不要 Markdown 代码块、不要解释、不要多余文字。',
  ].join('\n')
}

/** 从模型输出里抠出第一个完整 JSON 对象；抠不到返回空串。 */
function extractJsonObject(text: string): string {
  const cleaned = text.replace(/```(?:json)?/gi, ' ')
  const start = cleaned.indexOf('{')
  if (start < 0) return ''
  let depth = 0
  for (let i = start; i < cleaned.length; i++) {
    const char = cleaned[i]
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) return cleaned.slice(start, i + 1)
    }
  }
  return ''
}

const SHOT_KINDS: ZyShotKind[] = ['talking-head', 'product', 'scene', 'text-card']
const BEATS = ['hook', 'pain', 'product', 'cta'] as const

/** 把字符串夹到合法镜头类型；不认识的一律按 talking-head（有文本）或 scene（无文本）处理。 */
function toKind(value: unknown, hasLine: boolean): ZyShotKind {
  return typeof value === 'string' && (SHOT_KINDS as string[]).includes(value)
    ? value as ZyShotKind
    : (hasLine ? 'talking-head' : 'scene')
}

/** 夹紧时长：非数字按目标秒数处理，越界夹回厂商区间。 */
function toSeconds(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(SHOT_MAX_SECONDS, Math.max(SHOT_MIN_SECONDS, Math.round(parsed)))
}

/**
 * 解析模型返回的分镜表。
 *
 * 模型输出永远不可信：字段缺失、类型不对、时长越界、镜头类型瞎写都会发生。
 * 这里的原则是**能夹就夹、夹不了就丢**，绝不让一条脏数据把整条片带崩。
 *
 * @param raw - 模型返回的原始文本。
 * @param references - 这一次任务可用的参考图集（按角色挂到每一镜上）。
 * @param provider - 生成方标识（写入每一镜，便于逐镜覆盖）。
 * @returns 镜头数组；解析不出任何镜头时返回空数组（由调用方走兜底）。
 */
export function parseShotPlan(raw: string, references: ZyShotRef[], provider: string): ZyShot[] {
  const json = extractJsonObject(raw)
  if (json === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  }
  catch {
    return []
  }
  if (parsed === null || typeof parsed !== 'object') return []
  const record = parsed as { continuity?: unknown, shots?: unknown }
  const continuity = typeof record.continuity === 'string' ? record.continuity.trim().slice(0, 200) : ''
  if (!Array.isArray(record.shots)) return []
  const shots: ZyShot[] = []
  for (const item of record.shots) {
    if (item === null || typeof item !== 'object') continue
    const row = item as { kind?: unknown, seconds?: unknown, line?: unknown, visual?: unknown, beat?: unknown }
    const line = typeof row.line === 'string' ? row.line.trim() : ''
    const visual = typeof row.visual === 'string' ? row.visual.trim().slice(0, 500) : ''
    if (line === '' && visual === '') continue
    const kind = toKind(row.kind, line !== '')
    const beat = typeof row.beat === 'string' && (BEATS as readonly string[]).includes(row.beat)
      ? row.beat as ZyShot['beat']
      : undefined
    shots.push({
      index: shots.length,
      kind,
      // 口播镜以配音真实时长为准，这里的估值只用于排序与预算，执行时回填真实秒数。
      seconds: toSeconds(row.seconds, line === '' ? SHOT_MAX_SECONDS : estimateSeconds(line)),
      line,
      visual,
      continuity,
      // 纯文字卡不需要厂商画面，也就没有参考图；其余镜头共用同一套参考图（一致性的关键）。
      references: kind === 'text-card' ? [] : references,
      provider,
      ...(beat !== undefined ? { beat } : {}),
      status: 'planned',
    })
  }
  return shots
}

/**
 * 确定性兜底分镜：模型不可用或输出不可解析时用它，保证任何情况下都排得出片。
 *
 * 规则：口播文本按句切段（沿用 long-video 的切段口径），每 2 个口播镜后插 1 个产品镜。
 * **只有拿到产品参考图才会插产品镜**：没有产品图还去生成"产品特写"，等于凭空画一个产品，
 * 与"别让模型自由发挥包装"这条实测结论直接冲突——宁可如实退回"纯口播"，也不装作有产品画面。
 *
 * @param texts - 已经切好的口播段文本。
 * @param references - 这一次任务可用的参考图集。
 * @param provider - 生成方标识。
 * @param hasProductReference - 是否有产品参考图（没有则不插产品镜）。
 * @returns 镜头数组（有产品图时口播镜与产品镜交替）。
 */
export function fallbackShotPlan(
  texts: string[],
  references: ZyShotRef[],
  provider: string,
  hasProductReference: boolean,
): ZyShot[] {
  const productRefs = references.filter(item => item.role === 'product')
  const insertProductShots = hasProductReference && productRefs.length > 0
  const shots: ZyShot[] = []
  const productVisual = '以参考图中的产品为主体，缓慢旋转展示，柔和光带扫过，微距特写，浅景深，画面里不出现任何文字与品牌标识'
  texts.forEach((text, index) => {
    shots.push({
      index: shots.length,
      kind: 'talking-head',
      seconds: estimateSeconds(text),
      line: text,
      visual: '',
      continuity: '',
      references,
      provider,
      status: 'planned',
    })
    // 每两个口播镜后插一个产品镜，但不在开头插（开场要先把人立住）。
    if (insertProductShots && (index + 1) % 2 === 0) {
      shots.push({
        index: shots.length,
        kind: 'product',
        seconds: SHOT_MIN_SECONDS,
        line: '',
        visual: productVisual,
        continuity: '',
        references: productRefs,
        provider,
        status: 'planned',
      })
    }
  })
  return shots
}

/** 分镜表质量自检结果：用于生成前预校验与测试断言。 */
export interface ShotPlanAudit {
  total: number
  productShots: number
  talkingHeadShots: number
  /** 总时长（各镜之和），用于与目标时长对比。 */
  totalSeconds: number
  /** 是否满足"产品镜不少于下限"这条底线。 */
  hasEnoughProductShots: boolean
  /** 画面提示词里疑似出现文字/品牌要求的位置（命中即需要人看一眼）。 */
  suspiciousTextRequests: number[]
}

/**
 * 画面提示词是否在**要求模型把文字画出来**（而不是禁止它画）。
 *
 * @param visual - 该镜的画面提示词。
 * @returns 命中正向要求时返回 true。
 */
export function requestsRenderedText(visual: string): boolean {
  const subject = /文字|字幕|logo|LOGO|品牌名|品牌标识|包装上的|印刷/
  // 禁止令的常见写法：不出现 / 不要 / 不许 / 无需 / 避免 / 不能 / 禁止 / 别
  const negation = /(不出现|不要|不许|不用|不得|无需|避免|不能|禁止|别)([^，。；]{0,12})?(文字|字幕|logo|LOGO|品牌名|品牌标识|包装上的|印刷)/
  if (negation.test(visual)) return false
  return /(显示|写上|印着|印有|出现|展示|露出|带有|加上|叠加)[^，。；]{0,8}?(文字|字幕|logo|LOGO|品牌名|品牌标识|包装上的|印刷)/.test(visual)
    || /(文字|字幕|logo|LOGO|品牌名|品牌标识)[^，。；]{0,8}?(特写|清晰|显示|可见|露出)/.test(visual)
    || subject.test(visual) && /特写|清晰|可见/.test(visual)
}

/**
 * 分镜表自检：在花厂商的钱之前，先用它判断这张分镜表值不值得跑。
 *
 * @param shots - 待检查的镜头数组。
 * @returns 统计结果与可疑位置。
 */
export function auditShotPlan(shots: ZyShot[]): ShotPlanAudit {
  const suspicious: number[] = []
  let productShots = 0
  let talkingHeadShots = 0
  let totalSeconds = 0
  for (const shot of shots) {
    if (shot.kind === 'product') productShots++
    if (shot.kind === 'talking-head') talkingHeadShots++
    totalSeconds += shot.seconds
    // 提示词里主动要求模型"画文字"是实测会翻车的写法（会生成臆造品牌），命中要提示人工确认。
    // 判据只认**正向要求**："不许出现文字/不要 logo"这类禁止令是正确写法，不能当成可疑
    // （误报会让这条自检很快被无视，而它恰恰是唯一拦"画字"的闸门）。
    if (requestsRenderedText(shot.visual)) suspicious.push(shot.index)
  }
  return {
    total: shots.length,
    productShots,
    talkingHeadShots,
    totalSeconds,
    hasEnoughProductShots: productShots >= MIN_PRODUCT_SHOTS || shots.length < 3,
    suspiciousTextRequests: suspicious,
  }
}
