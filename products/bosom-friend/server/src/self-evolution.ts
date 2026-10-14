/**
 * 自进化：让"干过的活"变成"下次的上下文"（ADR-003 口径四 / Hermes 形态）。
 *
 * 三个子系统各管一段：
 * - **记忆 / 画像** → {@link module:@deepseek-ai/dsh-bosom-friend-server/memory-store}（我知道什么、我懂你什么）
 * - **技能** → {@link module:@deepseek-ai/dsh-bosom-friend-server/agent-skills}（我会做什么）
 * - **Nudge（本文件）** → 谁来提醒"该回头想想了"
 *
 * 为什么 Nudge 必须存在（照 Hermes 的实测）：记忆与技能都是存储系统，**写入需要有人触发**。
 * 没有触发器的产品，经验只能靠用户想起来点"升格"——那就是"用了三个月还是懵懂"的成因。
 *
 * 与 Hermes 的差别（有意简化）：Hermes 在后台 fork 一个独立 Agent 去做审查（最多 8 次工具调用）；
 * 我们这边审查要看的材料（对话、任务步骤、样本）**已经在手上**，所以只需**一次模型调用**——
 * 少一层进程编排，少一份上下文拷贝，判据一样成立。
 *
 * 本文件只放**纯函数**（阈值、提示词、解析、计数落盘）：模型调用留在路由层，
 * 这样它可以在不拉起内核的情况下被单测，也不会让模块之间互相 import 成环。
 *
 * @module @deepseek-ai/dsh-bosom-friend-server/self-evolution
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeDataJson } from './store.ts'

/** 复盘计数：两种粒度分开计（照 Hermes——记忆来自对话回合，技能来自工具迭代）。 */
export interface EvolutionState {
  /** 距上次复盘又过了几个对话回合。 */
  turnsSinceReview: number
  /** 距上次复盘又发生了几次工具调用。 */
  iterationsSinceReview: number
  /** 上次复盘时间（ISO）；从未复盘过为空串。 */
  lastReviewAt: string
}

/** 空状态：首次运行的起点。 */
export const EMPTY_EVOLUTION_STATE: EvolutionState = { turnsSinceReview: 0, iterationsSinceReview: 0, lastReviewAt: '' }

/**
 * 触发阈值。
 *
 * 回合阈值给"聊了很久但没干什么活"的场景兜底；迭代阈值看的是**真的动了手**
 * （工具调用才是产生经验的地方）。两者任一达到就复盘一次。
 */
export const REVIEW_TURN_THRESHOLD = 8
export const REVIEW_ITERATION_THRESHOLD = 12

/**
 * 技能复盘的门槛：这一轮的工具调用超过多少次才值得固化成技能（照 Hermes 的 skill_manage 口径）。
 *
 * 为什么用"调用次数"而不是"成功与否"：一次问答、一次生成也是成功的，但它们没有**过程**可复用；
 * 真正值钱的是"摸索了几轮才走通"的那类任务——次数就是"摸索过"的可测代理。
 */
export const SKILL_REVIEW_MIN_TOOL_CALLS = 5

/** 单条记忆/画像的字数上限：一条是一句话，不是一段文档。 */
export const MAX_REVIEW_ENTRY_CHARS = 120

/** 一次复盘最多接受几条：宁少勿多，容量要留给以后。 */
export const MAX_REVIEW_ENTRIES = 3

/** 模型明确表示"没什么可记"时的输出（照 Hermes 的出口，防止它硬塞东西交差）。 */
export const NOTHING_TO_SAVE = 'nothing to save'

/** 复盘状态文件路径。 */
export function evolutionStatePath(dshHome: string): string {
  return join(dshHome, 'memory', 'evolution-state.json')
}

/**
 * 读出复盘计数；文件缺失或损坏时回到空状态。
 *
 * 为什么损坏也当作空：计数是**优化项**，不是事实源——丢了最多多复盘一次，
 * 绝不该因为一个坏掉的 JSON 让整轮对话失败。
 *
 * @param dshHome - 内核的 `DSH_HOME`。
 * @returns 复盘计数。
 */
export function readEvolutionState(dshHome: string): EvolutionState {
  const file = evolutionStatePath(dshHome)
  if (!existsSync(file)) return { ...EMPTY_EVOLUTION_STATE }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<EvolutionState>
    return {
      turnsSinceReview: Number.isFinite(parsed.turnsSinceReview) ? Number(parsed.turnsSinceReview) : 0,
      iterationsSinceReview: Number.isFinite(parsed.iterationsSinceReview) ? Number(parsed.iterationsSinceReview) : 0,
      lastReviewAt: typeof parsed.lastReviewAt === 'string' ? parsed.lastReviewAt : '',
    }
  }
  catch {
    return { ...EMPTY_EVOLUTION_STATE }
  }
}

/**
 * 落盘复盘计数（原子写）。
 *
 * @param dshHome - 内核的 `DSH_HOME`。
 * @param state - 新状态。
 */
export function writeEvolutionState(dshHome: string, state: EvolutionState): void {
  writeDataJson(evolutionStatePath(dshHome), state)
}

/**
 * 累加计数并判断这一轮要不要复盘。
 *
 * @param dshHome - 内核的 `DSH_HOME`。
 * @param delta - 本次新增的回合数与迭代数。
 * @returns 是否需要复盘，以及累加后的状态。
 */
export function bumpAndCheck(dshHome: string, delta: { turns?: number, iterations?: number }): { shouldReview: boolean, state: EvolutionState } {
  const current = readEvolutionState(dshHome)
  const state: EvolutionState = {
    turnsSinceReview: current.turnsSinceReview + (delta.turns ?? 0),
    iterationsSinceReview: current.iterationsSinceReview + (delta.iterations ?? 0),
    lastReviewAt: current.lastReviewAt,
  }
  const shouldReview = state.turnsSinceReview >= REVIEW_TURN_THRESHOLD || state.iterationsSinceReview >= REVIEW_ITERATION_THRESHOLD
  if (!shouldReview) writeEvolutionState(dshHome, state)
  return { shouldReview, state }
}

/**
 * 复盘完成后归零。
 *
 * @param dshHome - 内核的 `DSH_HOME`。
 * @param at - 本次复盘时间（ISO）。
 */
export function markReviewed(dshHome: string, at: string = new Date().toISOString()): void {
  writeEvolutionState(dshHome, { turnsSinceReview: 0, iterationsSinceReview: 0, lastReviewAt: at })
}

/**
 * 记忆复盘提示词：从最近的干活记录里挑出**值得长期记住的事实**。
 *
 * 为什么把"声明式事实"写死在提示词里（照 Hermes 的 MEMORY_GUIDANCE）：
 * 记成命令（"遇到验证码要停下"）会变成死规矩，压过当下的判断；
 * 记成事实（"抖音发布常弹短信验证码，真人输入窗口约 10 分钟"）才是可被当前情况覆盖的知识。
 *
 * @param recent - 最近的记录文本（对话要点或任务摘要）。
 * @returns 送给模型的提示词。
 */
export function buildMemoryReviewPrompt(recent: string): string {
  return [
    '下面是你（APP 智能体）最近几次干活的记录。请判断其中有没有**值得长期记住的事实**。',
    '',
    '【最近的记录】',
    recent,
    '',
    '【记什么】',
    '- 记**事实**，不记命令：写"抖音发布常弹短信验证码、等真人输入约 10 分钟"，',
    '  不要写"遇到验证码要停下"——前者可在当下被推翻，后者会变成死规矩。',
    '- 只记**能跨任务复用**的：平台行为、容易失败的链路、验证过好用的参数、用户反复提的要求。',
    '- 单条一句话，不超过 ' + String(MAX_REVIEW_ENTRY_CHARS) + ' 字；最多 ' + String(MAX_REVIEW_ENTRIES) + ' 条。',
    '- 不要记这次任务的具体题材、标题、数字。',
    '',
    '【输出】',
    '- 每行一条，不要编号、不要解释、不要 Markdown 标记。',
    '- 没有值得记的就只回一句：Nothing to save.',
  ].join('\n')
}

/**
 * 画像复盘提示词：从用户最近的指令里挑出**值得长期记住的偏好**。
 *
 * @param recent - 用户最近的指令原文（每行一条）。
 * @returns 送给模型的提示词。
 */
export function buildUserReviewPrompt(recent: string): string {
  return [
    '下面是用户最近对你说的话。请判断有没有**值得长期记住的偏好**。',
    '',
    '【用户最近说的话】',
    recent,
    '',
    '【记什么】',
    '- 记**稳定偏好**：常做的题材、惯用的形式与画幅、常发的平台、说话的口吻要求。',
    '- 不要记一次性的任务内容（"今天要做一条无人机视频"不是偏好）。',
    '- 单条一句话，不超过 ' + String(MAX_REVIEW_ENTRY_CHARS) + ' 字；最多 ' + String(MAX_REVIEW_ENTRIES) + ' 条。',
    '',
    '【输出】',
    '- 每行一条，不要编号、不要解释、不要 Markdown 标记。',
    '- 没有值得记的就只回一句：Nothing to save.',
  ].join('\n')
}

/**
 * 技能复盘提示词：把"这次是怎么做成的"固化成可复用流程（Hermes 的 Skill Review）。
 *
 * 与记忆/画像复盘的分工：记忆记**事实**、画像记**偏好**、技能记**做法**。
 * 输出要求 JSON 而不是 Markdown：技能文件需要四个字段（名字/说明/何时用/正文），
 * 让模型一次给全比事后从散文里猜字段稳得多。
 *
 * @param instruction - 这次任务里用户的原始要求。
 * @param steps - 这次任务实际走过的工具调用序列。
 * @returns 送给模型的提示词。
 */
export function buildSkillReviewPrompt(instruction: string, steps: string): string {
  return [
    '下面是一次**成功但绕了几步**的任务。请判断：这套做法值不值得固化成一条可复用的流程？',
    '',
    '【用户当时的要求】',
    instruction,
    '',
    '【实际走过的步骤】',
    steps,
    '',
    '【判据】',
    '- 值得固化：步骤有先后依赖、中间踩过坑或纠正过、换一个同类任务还能照着走。',
    '- 不值得：一次问答、一次普通生成、或者步骤换个任务就不成立。',
    '- 拿不准就返回 {"skip": true}，**不要为了交差硬造一条流程**。',
    '',
    '【输出（只输出 JSON，不要代码围栏、不要解释）】',
    '{"skip": false, "name": "小写英文短名-用连字符", "description": "一句话说明这个技能是干什么的",',
    ' "whenToUse": "什么情况下该用它", "body": "分步骤的流程正文，Markdown 有序列表，8 步以内", "pitfalls": "这次踩到的坑，没有就留空"}',
  ].join('\n')
}

/**
 * 解析技能复盘的 JSON 输出。
 *
 * 容忍代码围栏与前后杂字：模型即使被要求"只输出 JSON"也常带围栏，
 * 为此丢掉整条经验不值得。解析不出来就返回 null（当作"这次不建技能"）。
 *
 * @param text - 模型输出。
 * @returns 技能草稿字段；不建或解析失败时为 null。
 */
export function parseSkillReview(text: string): { name: string, description: string, whenToUse: string, body: string, pitfalls: string } | null {
  const fenced = /\{[\s\S]*\}/.exec(text.trim())
  if (fenced === null) return null
  try {
    const parsed = JSON.parse(fenced[0]) as { skip?: unknown, name?: unknown, description?: unknown, whenToUse?: unknown, body?: unknown, pitfalls?: unknown }
    if (parsed.skip === true) return null
    const body = typeof parsed.body === 'string' ? parsed.body.trim() : ''
    if (body.length < 40) return null
    return {
      name: typeof parsed.name === 'string' ? parsed.name : '',
      description: typeof parsed.description === 'string' ? parsed.description : '',
      whenToUse: typeof parsed.whenToUse === 'string' ? parsed.whenToUse : '',
      body,
      pitfalls: typeof parsed.pitfalls === 'string' ? parsed.pitfalls : '',
    }
  }
  catch {
    return null
  }
}

/**
 * 解析模型给的复盘结果。
 *
 * 三条纪律：剥掉编号与项目符号、丢掉过长的行、识别"Nothing to save"。
 * 之所以要容忍编号：模型即使被要求"不要编号"也常带 `1. `，为此丢掉整条经验不值得。
 *
 * @param text - 模型输出。
 * @returns 可写入的条目（没有则空数组）。
 */
export function parseReviewEntries(text: string): string[] {
  const lines = text
    .split('\n')
    .map(line => line.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, '').trim())
    .filter(line => line !== '')
  const meaningful = lines.filter(line => !/^nothing to save[.。]?$/i.test(line))
  if (meaningful.length === 0) return []
  return meaningful
    .map(line => line.replace(/^["'“”]|["'“”]$/g, '').trim())
    .filter(line => line !== '' && line.length <= MAX_REVIEW_ENTRY_CHARS * 2)
    .slice(0, MAX_REVIEW_ENTRIES)
}

/**
 * 从任意文本里截出"最近的部分"。
 *
 * 复盘看的是最近发生的事：材料太长时**保尾部**（新的在后），
 * 而不是保头部——头部是最老的、也最可能已经被记过了。
 *
 * @param text - 原文。
 * @param maxChars - 上限字符数。
 * @returns 截取后的文本。
 */
export function tailOf(text: string, maxChars: number): string {
  const value = text.trim()
  if (value.length <= maxChars) return value
  return '…' + value.slice(value.length - maxChars)
}
