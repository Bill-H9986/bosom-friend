/* oxlint-disable no-non-null-assertion, restrict-plus-operands, no-unnecessary-condition, no-unnecessary-type-conversion, no-unnecessary-type-assertion, no-unnecessary-type-parameters, require-await, @stylistic/max-len -- 中文文案与笔记正文为长单串，属产品内容而非可拆分语句 */
/**
 * 知识库注入与蒸馏：让知识库不只是笔记编辑器。
 *
 * 两条链路：
 * 1. 注入（检索）：生成/对话前按相关度检索知识笔记，作为「已知知识」注入模型上下文，
 *    并记录本次注入了哪些笔记——知识库从「摆设」变成模型的可检索记忆。
 * 2. 蒸馏（沉淀）：每次生成留一条结构化样本（指令/输出/模型/注入来源/质量），
 *    可聚合成可导出的 JSONL 数据集（微调）与少样本示例（few-shot 直接喂回模型）。
 * @module @deepseek-ai/dsh-bosom-friend-server/knowledge-distill
 */

import type { Deps, RouteDef } from './api.ts'
import { writeOk } from './http.ts'
import { nowIso } from './store-helper.ts'

/** 单条知识笔记（knowledge.json.notes 的值）。 */
export interface KnowledgeNote {
  name: string
  content: string
  protected?: boolean
}

/** 知识库持久化状态（notes 之外还有 vault 与蒸馏样本）。 */
export interface KnowledgeState {
  notes: Record<string, KnowledgeNote>
  vault: { path: string; builtIn: boolean }
  distillations?: DistillationRecord[]
  injectedCount?: number
}

/** 一条蒸馏样本：可微调、可少样本、可复盘。 */
export interface DistillationRecord {
  id: string
  /** 任务类型：video / image-text / chat。 */
  task: string
  /** 用户指令原文。 */
  instruction: string
  /** 模型输出原文。 */
  output: string
  model: string
  /** 本次注入的知识笔记路径（空数组表示没有命中）。 */
  knowledgePaths: string[]
  /** 注入上下文字符数（0 表示未注入）。 */
  knowledgeChars: number
  status: 'success' | 'failed' | 'partial'
  /** 评分 1-5；未评分为 0。 */
  rating: number
  /**
   * 这个评分是谁给的：user=用户手点；engagement=按发布后的真实表现自动给的（见 sample-rating.ts）。
   *
   * 为什么要分开记：两者不是一回事——用户是**看过产出**之后的判断，
   * 机器只看得到数字（封面、发布时间、平台分发都掺在里面）。分开记才谈得上"用户的分不覆盖"，
   * 界面上也才有资格把两者区别对待。
   */
  ratingSource?: 'user' | 'engagement'
  createdAt: string
  /** 来源实体 id（生成任务 id 等）。 */
  sourceId: string
  /**
   * 这条样本改的是**哪一类**对象（对象级动作才有：draft / account / note / work）。
   *
   * 为什么不从 sourceId 里拆：来源 id 是拼接出来的（object-action-draft-cnt-abc123-draft-title），
   * 而草稿 id 自己就含连字符，动作 id 也含——按分隔符拆是猜，猜错就把分打到别的对象上。
   * 记成字段，判据与用法都一眼看得懂。
   */
  objectKind?: string
  /** 这条样本改的是**哪个**对象（与 {@link objectKind} 配对）。 */
  objectId?: string
  /**
   * 这一次注入的**质量语境样例 id**（见 {@link buildQualityContext}）。
   *
   * 为什么要留痕：自进化的判据是"第 N 次是否真的用上了前几次的经验"，
   * 没有这份记录就只能靠感觉。它与 knowledgePaths（知识笔记命中）是两件事，分别记账。
   */
  exampleIds?: string[]
  /**
   * 这条样例被升格成技能后写到哪个文件（`$DSH_HOME/skills/<file>`）。
   *
   * 为什么要记在账本上：技能目录是**账本的投影**——Curator 靠这个字段判断
   * "目录里哪些文件还有对应的合格样例"，没有它就只能靠文件名猜。
   */
  skillPath?: string
  /**
   * 这条样例在**人话里**是什么任务。
   *
   * 为什么需要它：`instruction` 是真正送进模型的那段提示词（对象级动作送的是带
   * 【要改的对象】脚手架的整段），拿它当技能名会得到"要改的对象-字段title-当前内容-…"
   * 这种谁也读不懂的名字——而技能名是模型在技能目录里**唯一**能看到的挑选依据。
   */
  instructionLabel?: string
  /**
   * 这一轮模型调了几次工具。
   *
   * 为什么它是"越用越省"的判据：耗时被模型与网络的抖动淹没，而**轮数**反映的是
   * "模型要不要反复试错"——同类任务第二次需要的轮数应当更少（样例/技能/记忆都在教它）。
   */
  toolCalls?: number
  /** 这一轮从开始到拿到正文的墙钟毫秒数（含工具往返）。仅供参考，噪声大。 */
  elapsedMs?: number
  /** 这一轮拼进提示词的上下文总字符数（知识 + 质量样例）。 */
  contextChars?: number
}

/** 一条带度量值的样本（`distillTrend` 的最小输入）。 */
export interface MeasuredSample {
  createdAt: string
  toolCalls?: number
  elapsedMs?: number
  contextChars?: number
}

/** 同类任务的"越用越省"摘要：第一条度量样本 vs 最近若干条的中位数。 */
export interface DistillTrend {
  /** 参与统计的度量样本条数（没有度量的老样本不计入）。 */
  measured: number
  /** 最早那条度量样本（"第 1 次"）；没有就是 null。 */
  first: { createdAt: string, toolCalls: number, elapsedMs: number, contextChars: number } | null
  /** 最近若干条的中位数；没有就是 null。 */
  recent: { samples: number, toolCalls: number, elapsedMs: number, contextChars: number } | null
}

/** 取中位数；空数组返回 0。 */
function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : Math.round(((sorted[middle - 1]! + sorted[middle]!) / 2) * 10) / 10
}

/**
 * 算同类任务的"越用越省"。
 *
 * 口径（写死在这里，避免每种用法各算一套）：
 * - 只统计**有度量值**的样本——老样本没有度量，拿 0 顶替会把结论做假；
 * - "第 1 次"取最早的度量样本；"最近"取最后 `recentLimit` 条并取**中位数**（中位数不被单次抖动带偏）；
 * - 样本不足 2 条时 `recent` 仍会给，但调用方不该拿它下结论（判据写在返回的 `measured` 上）。
 *
 * @param samples - 同类任务的样本（顺序不限）。
 * @param recentLimit - "最近"取几条。
 * @returns 摘要。
 */
export function distillTrend(samples: readonly MeasuredSample[], recentLimit = 5): DistillTrend {
  const measured = samples
    .filter(sample => typeof sample.toolCalls === 'number')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  if (measured.length === 0) return { measured: 0, first: null, recent: null }
  const toPoint = (sample: MeasuredSample) => ({
    createdAt: sample.createdAt,
    toolCalls: sample.toolCalls ?? 0,
    elapsedMs: sample.elapsedMs ?? 0,
    contextChars: sample.contextChars ?? 0,
  })
  const recentSlice = measured.slice(-Math.max(1, recentLimit))
  return {
    measured: measured.length,
    first: toPoint(measured[0]!),
    recent: {
      samples: recentSlice.length,
      toolCalls: median(recentSlice.map(sample => sample.toolCalls ?? 0)),
      elapsedMs: median(recentSlice.map(sample => sample.elapsedMs ?? 0)),
      contextChars: median(recentSlice.map(sample => sample.contextChars ?? 0)),
    },
  }
}

/** 检索命中片段。 */
interface Passage {
  path: string
  name: string
  text: string
  score: number
}

/** 注入结果：可直接拼进提示词的上下文块 + 本次命中来源。 */
export interface KnowledgeContext {
  block: string
  paths: string[]
  chars: number
  /** 命中但被排除的自动沉淀笔记（审计日志，不作为模型知识）。 */
  excluded: string[]
}

const MAX_PASSAGES = 3
const MAX_CONTEXT_CHARS = 1200
const MIN_SCORE = 3
/**
 * 检索要扫的笔记上限——**按"最相关"取舍，不按"最先写入"取舍**。
 *
 * 这里踩过一次：原先写的是 `Object.entries(notes).slice(0, 400)`，而 notes 的顺序是写入顺序，
 * 于是**知识库超过 400 篇之后新写的笔记永远不会被检索到**——用户刚记下的东西注不进对话，
 * 而且完全无声（没有命中、没有报错）。知识库现在 466 篇，正是这个状态。
 *
 * 现在按"查询与标题/正文的字符重合度"先粗排，再在预算内精排：既保住性能上限，
 * 也不再把新知识饿死。0 表示不限（小知识库直接全扫）。
 */
const MAX_NOTES_SCANNED = 2000
const CJK_RE = /[\u4e00-\u9fa5]/
/**
 * 自动沉淀目录：生成日志等审计记录，只供人看，不作为模型知识注入——
 * 它们天然包含大量业务关键词，注入会把无关的日志塞进上下文并稀释真正的知识。
 */
const AUDIT_FOLDER = '自动沉淀'

/** 小写化 + 去标点，供检索打分使用。 */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s\u3000]+/g, ' ')
}

/**
 * 提取检索词：拉丁词按空白切分，中文按 2 字滑窗（无需分词器即可召回中文短语）。
 * @param text - 查询或笔记正文。
 * @returns 去重后的检索词集合。
 */
export function extractTokens(text: string): Set<string> {
  const tokens = new Set<string>()
  const normalized = normalize(text)
  for (const word of normalized.split(/[^a-z0-9\u4e00-\u9fa5]+/)) {
    if (word === '') continue
    if (CJK_RE.test(word)) {
      for (let i = 0; i < word.length - 1; i += 1) tokens.add(word.slice(i, i + 2))
      if (word.length >= 3) tokens.add(word)
      continue
    }
    if (word.length >= 2) tokens.add(word)
  }
  return tokens
}

/** 按 Markdown 标题切段；无标题时整篇作为一段。 */
function splitPassages(content: string): string[] {
  const chunks = content.split(/\n(?=#{1,6}\s)/)
  const passages = chunks.map(chunk => chunk.trim()).filter(chunk => chunk !== '')
  return passages.length > 0 ? passages : [content.trim()]
}

/** 命中片段：以首个命中词为中心截取上下文，便于模型直接引用。 */
function snippetAround(text: string, tokens: Set<string>, limit = 420): string {
  const lower = normalize(text)
  let at = -1
  for (const token of tokens) {
    const index = lower.indexOf(token)
    if (index >= 0 && (at < 0 || index < at)) at = index
  }
  if (at < 0) return text.slice(0, limit).trim()
  const start = Math.max(0, at - Math.floor(limit / 3))
  return text.slice(start, start + limit).trim()
}

/** 单段得分：标题命中加权 + 检索词覆盖数。 */
function scorePassage(passage: string, name: string, tokens: Set<string>): number {
  const haystack = normalize(passage)
  const title = normalize(name)
  let score = 0
  for (const token of tokens) {
    if (title.includes(token)) score += 2
    else if (haystack.includes(token)) score += 1
  }
  return score
}

/**
 * 检索与查询最相关的知识片段。
 * @param knowledge - 知识库状态。
 * @param query - 用户指令或提示词。
 * @returns 按得分降序的片段（不含低于阈值的段）。
 */
export function retrieveKnowledge(knowledge: KnowledgeState, query: string): Passage[] {
  const tokens = extractTokens(query)
  if (tokens.size === 0) return []
  const hits: Passage[] = []
  const scanned = Object.entries(knowledge.notes).filter(([path]) => !path.startsWith(AUDIT_FOLDER + '/'))
  // 预算超了就先粗排：按"标题命中 + 正文命中次数"挑最像的若干篇再精排。
  // 粗排只为了不把 CPU 花在明显无关的笔记上，它不改变最终判据（精排仍是 scorePassage）。
  const entries = scanned.length <= MAX_NOTES_SCANNED
    ? scanned
    : scanned
        .map(([path, note]) => {
          const head = normalize((note.name || path) + ' ' + note.content.slice(0, 400))
          let rough = 0
          for (const token of tokens) if (head.includes(token)) rough += 1
          return { path, note, rough }
        })
        .sort((a, b) => b.rough - a.rough)
        .slice(0, MAX_NOTES_SCANNED)
        .map(item => [item.path, item.note] as [string, typeof item.note])
  for (const [path, note] of entries) {
    for (const passage of splitPassages(note.content)) {
      const score = scorePassage(passage, note.name || path, tokens)
      if (score >= MIN_SCORE) hits.push({ path, name: note.name || path, text: snippetAround(passage, tokens), score })
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, MAX_PASSAGES)
}

/**
 * 构建注入上下文：命中片段拼成模型可直接引用的「已知知识」块。
 * @param knowledge - 知识库状态。
 * @param query - 用户指令或提示词。
 * @returns 上下文块与本次命中来源；无命中时 block 为空串。
 */
export function buildKnowledgeContext(knowledge: KnowledgeState, query: string): KnowledgeContext {
  const tokens = extractTokens(query)
  const excluded = tokens.size === 0
    ? []
    : Object.keys(knowledge.notes).filter(path => path.startsWith(AUDIT_FOLDER + '/'))
  const passages = retrieveKnowledge(knowledge, query)
  if (passages.length === 0) return { block: '', paths: [], chars: 0, excluded }
  const parts: string[] = []
  let chars = 0
  for (const passage of passages) {
    const piece = '【' + passage.name + '】\n' + passage.text
    if (chars + piece.length > MAX_CONTEXT_CHARS && parts.length > 0) break
    parts.push(piece)
    chars += piece.length
  }
  return {
    block: '\n\n[已知知识（来自用户知识库，优先使用这些事实与风格）]\n' + parts.join('\n\n') + '\n[已知知识结束]',
    paths: [...new Set(passages.slice(0, parts.length).map(p => p.path))],
    chars,
    excluded,
  }
}


/** 质量语境的单条样例上限（字）：两条样例加起来不该压过本次任务本身的描述。 */
const MAX_EXAMPLE_CHARS = 400
/** 质量语境里最多放几条样例。 */
const MAX_EXAMPLE_COUNT = 2

/**
 * 质量语境：把**用户自己认可过的同类产出**作为上下文。
 *
 * 为什么需要它（2026-09-22 研究"语境才是真正的护城河"之后的落地）：
 * 那篇方法论把语境分四类——领域 / 历史 / **质量** / 约束，并指出复利来自
 * "好的语境 → 更好的输出 → 学到哪些语境重要 → 改进语境文档"这个飞轮。
 * 本产品**已经攒下了质量语境的原料**（`recordDistillation` 每条生成都留了样本，用户还能评分），
 * 却只把它当导出数据集用：`fewShotExamples` 写出来只被一个只读接口调用，**从未进过任何一次模型上下文**。
 * 结果就是"永远停在第一次"——用户评了五分的稿子，下一次生成看不到。
 *
 * 选取口径与 {@link fewShotExamples} 保持一致（成功 + 评分 ≥4 或注入过知识），不另立标准。
 *
 * @param knowledge - 知识库状态（含蒸馏账本）。
 * @param task - 任务类型（chat / video / image-text）。
 * @param limit - 最多几条；缺省 2。
 * @returns 可拼进提示词的上下文块与本次用到的样例 id；没有可用样例时 block 为空串。
 */
export function buildQualityContext(
  knowledge: KnowledgeState,
  task: string,
  limit = MAX_EXAMPLE_COUNT,
): { block: string, ids: string[] } {
  const examples = fewShotExamples(knowledge, task, Math.max(1, Math.min(limit, MAX_EXAMPLE_COUNT)))
  if (examples.length === 0) return { block: '', ids: [] }
  const parts: string[] = []
  const ids: string[] = []
  for (const example of examples) {
    const output = example.output.trim().replace(/\s+/g, ' ')
    if (output === '') continue
    parts.push('【你自己的同类产出｜' + (example.rating > 0 ? '用户评分 ' + String(example.rating) + '/5' : '已被采用') + '】\n'
      + '当时的要求：' + example.instruction.replace(/\s+/g, ' ').slice(0, 120) + '\n'
      + '当时的产出：' + output.slice(0, MAX_EXAMPLE_CHARS))
    ids.push(example.id)
  }
  if (parts.length === 0) return { block: '', ids: [] }
  return {
    block: '\n\n[你自己的成功样例（同等水准交付；可借用结构与口吻，不要照抄其中的事实与数字）]\n'
      // 为什么还要单独说「因果结论不作为依据」（2026-10-11 实测）：模型会把自己上一轮对失败原因的
      // **推测**当成经验复述，并升级成「某某是老毛病」——真实原因（标题超 20 字）反倒被它编的
      // 「封面生成超时」盖住。样例是产出，不是事实；失败原因只认结构化记录。
      + '**这些是往期的模型产出，不是核验过的事实**：其中的因果结论（「因为 X 所以失败」「某某是老毛病」）'
      + '一律不作为依据；失败原因只认结构化记录（发布记录里的 errorMsg、引擎回执原文）。\n'
      + parts.join('\n\n') + '\n[成功样例结束]',
    ids,
  }
}

/**
 * 记录一条蒸馏样本。
 *
 * 同一个来源 id 重复记录时**默认覆盖**（同一条对象的同一个动作，留下最新那次就够了）。
 * 但有一条例外：**已经被用户认可过（评分 ≥{@link MIN_SKILL_RATING}）或已升格成技能的样本不覆盖**，
 * 新的一次另起一条记下去。
 *
 * 为什么必须有这个例外（2026-09-22 判据实测）：对象动作的来源 id 是**稳定**的
 * （`object-action-<kind>-<id>-<action>`），于是"再点一次同一个按钮"就会把上一条样本连同用户的评分一起冲掉——
 * 用户刚打过的 5 分没了，下一次的上下文里也就不再有那条成功样例：**飞轮转一次就停**。
 * 评分是用户对**那一次产出**的判断，不能被后来的一次重跑静默作废。
 */
export function recordDistillation(d: Deps, record: Omit<DistillationRecord, 'id' | 'createdAt'>): void {
  const knowledge = d.store.files.knowledge.load() as KnowledgeState
  const list = knowledge.distillations ?? []
  const previous = list.find(item => item.sourceId === record.sourceId)
  const approved = previous !== undefined
    && (previous.rating >= MIN_SKILL_RATING || previous.skillPath !== undefined)
  const sameSource = list.filter(item => item.sourceId === record.sourceId)
  const entry: DistillationRecord = {
    ...record,
    // 保留旧样本时 id 不能撞车：评分与升格都是按 id 找那条样本的。
    id: approved ? 'dist-' + record.sourceId + '-' + String(sameSource.length + 1) : 'dist-' + record.sourceId,
    createdAt: nowIso(),
  }
  const next = (approved ? [entry, ...list] : [entry, ...list.filter(item => item.sourceId !== record.sourceId)])
    .slice(0, 2000)
  knowledge.distillations = next
  if (record.knowledgePaths.length > 0) knowledge.injectedCount = (knowledge.injectedCount ?? 0) + 1
  d.store.files.knowledge.save(knowledge)
}

/**
 * 按来源 id 删除蒸馏样本；返回实际删除条数。
 *
 * 为什么需要：{@link recordDistillation} 为每条生成记录追加一条样本（sourceId = 生成记录 id），
 * 但删除生成记录时只级联清了素材与草稿——样本留在 set 里最多 2000 条，
 * 于是"删掉的记录"仍以提示词形式留在用户知识库（2026-09-22 实测：E2E 靶子的提示词在
 * 用户 knowledge.json 里累积了 47 次，且删除生成记录无法回收）。
 * 删除源记录时必须把它的样本一起带走。
 *
 * @param d - 依赖（数据根）。
 * @param sourceIds - 要清理的来源 id 集合（生成记录 id）。
 * @returns 实际删除的样本条数。
 */
export function removeDistillationsBySource(d: Deps, sourceIds: ReadonlySet<string>): number {
  if (sourceIds.size === 0) return 0
  const knowledge = d.store.files.knowledge.load() as KnowledgeState
  const list = knowledge.distillations ?? []
  if (list.length === 0) return 0
  const next = list.filter(item => !sourceIds.has(item.sourceId))
  const removed = list.length - next.length
  if (removed === 0) return 0
  knowledge.distillations = next
  d.store.files.knowledge.save(knowledge)
  return removed
}

/** 更新某条蒸馏样本的评分（0 表示取消评分）。走这条路的都是**用户手点**。 */
export function rateDistillation(d: Deps, id: string, rating: number): boolean {
  const knowledge = d.store.files.knowledge.load() as KnowledgeState
  const list = knowledge.distillations ?? []
  const target = list.find(item => item.id === id)
  if (target === undefined) return false
  target.rating = Math.max(0, Math.min(5, Math.round(rating)))
  target.ratingSource = 'user'
  knowledge.distillations = list
  d.store.files.knowledge.save(knowledge)
  return true
}

/** 蒸馏数据集统计：总量、成功量、注入命中量、平均评分。 */
export function distillStats(knowledge: KnowledgeState) {
  const list = knowledge.distillations ?? []
  const success = list.filter(item => item.status === 'success')
  const injected = list.filter(item => item.knowledgePaths.length > 0)
  const rated = list.filter(item => item.rating > 0)
  return {
    total: list.length,
    success: success.length,
    injected: injected.length,
    rated: rated.length,
    avgRating: rated.length === 0 ? 0 : Math.round((rated.reduce((acc, item) => acc + item.rating, 0) / rated.length) * 10) / 10,
    notes: Object.keys(knowledge.notes).length,
  }
}

/** 认可门槛：用户打到这里及以上的样本才算「被认可过」（升格技能、作为成功样例都用它）。 */
export const MIN_SKILL_RATING = 4

/** 少样本示例：被评为成功且「用户认可或注入过知识」的样本，供直接喂回模型。 */
export function fewShotExamples(knowledge: KnowledgeState, task: string, limit = 2): DistillationRecord[] {
  const list = knowledge.distillations ?? []
  return list
    .filter(item => (task === '' || item.task === task) && item.status === 'success'
      && (item.rating >= MIN_SKILL_RATING || item.knowledgePaths.length > 0))
    .slice(0, limit)
}

/** 可导出为微调数据集的样本（成功且输出非空）。 */
export function datasetRecords(knowledge: KnowledgeState, task: string): DistillationRecord[] {
  const list = knowledge.distillations ?? []
  return list.filter(item => (task === '' || item.task === task) && item.status === 'success' && item.output.trim() !== '')
}

/** JSONL 一行：OpenAI 微调兼容的 messages 结构 + 可追溯元数据。 */
function toJsonlLine(record: DistillationRecord): string {
  return JSON.stringify({
    messages: [
      { role: 'user', content: record.instruction },
      { role: 'assistant', content: record.output },
    ],
    metadata: {
      id: record.id,
      task: record.task,
      model: record.model,
      knowledgePaths: record.knowledgePaths,
      exampleIds: record.exampleIds ?? [],
      rating: record.rating,
      createdAt: record.createdAt,
    },
  })
}

/** 追加知识库蒸馏路由。 */
export function appendKnowledgeDistillRoutes(deps: Deps, routes: RouteDef[]): void {
  const state = (): KnowledgeState => deps.store.files.knowledge.load() as KnowledgeState

  routes.push(
    {
      m: 'GET',
      p: 'knowledge/distill/stats',
      h: ({ res }) => {
        const knowledge = state()
        writeOk(res, {
          ...distillStats(knowledge),
          injectedCount: knowledge.injectedCount ?? 0,
          taskBreakdown: Object.entries(
            (knowledge.distillations ?? []).reduce<Record<string, number>>((acc, item) => {
              acc[item.task] = (acc[item.task] ?? 0) + 1
              return acc
            }, {}),
          ).map(([task, count]) => ({ task, count })),
        })
      },
    },
    {
      m: 'GET',
      p: 'knowledge/distill/dataset',
      h: ({ res, query }) => {
        const task = query.get('task') ?? ''
        const limit = Math.max(1, Math.min(500, Number(query.get('limit') ?? 100) || 100))
        const records = datasetRecords(state(), task).slice(0, limit)
        writeOk(res, {
          list: records.map(item => ({
            id: item.id,
            // sourceId 是"升格为技能"要用的那把钥匙（POST knowledge/distill/promote 认它），
            // 投影掉它，界面就没法把一条样例变成技能。
            sourceId: item.sourceId,
            ...(item.skillPath === undefined ? {} : { skillPath: item.skillPath }),
            task: item.task,
            instruction: item.instruction.slice(0, 300),
            output: item.output.slice(0, 800),
            model: item.model,
            knowledgePaths: item.knowledgePaths,
            rating: item.rating,
            // 这个分是谁给的：界面上要能区分"我评的"与"按发布表现自动给的"——
            // 不投影出去，用户就会以为机器给的分是他自己打的（投影是白名单，漏一个字段界面就少一个事实）。
            ...(item.ratingSource === undefined ? {} : { ratingSource: item.ratingSource }),
            // 这一次用了哪条质量语境样例：自进化的判据靠它（"第 N 次真的用上了前几次的经验"）。
            exampleIds: item.exampleIds ?? [],
            // 度量：没有它们，"越用越省"就只能靠感觉说。老样本没有度量，如实缺省而不是补 0。
            ...(item.toolCalls === undefined ? {} : { toolCalls: item.toolCalls }),
            ...(item.elapsedMs === undefined ? {} : { elapsedMs: item.elapsedMs }),
            ...(item.contextChars === undefined ? {} : { contextChars: item.contextChars }),
            createdAt: item.createdAt,
          })),
          total: records.length,
        })
      },
    },
    {
      m: 'GET',
      p: 'knowledge/distill/export',
      h: ({ res, query }) => {
        const task = query.get('task') ?? ''
        const records = datasetRecords(state(), task)
        const body = records.map(toJsonlLine).join('\n') + (records.length > 0 ? '\n' : '')
        res.writeHead(200, {
          'content-type': 'application/jsonl; charset=utf-8',
          'content-disposition': 'attachment; filename="bosom-friend-distill' + (task === '' ? '' : '-' + task) + '.jsonl"',
        })
        res.end(body)
      },
    },
    {
      m: 'GET',
      p: 'knowledge/distill/trend',
      h: ({ res, query }) => {
        // "越用越省"的裁判：第一条度量样本 vs 最近若干条的中位数。度量口径见 distillTrend。
        const task = query.get('task') ?? ''
        const recent = Math.max(1, Math.min(20, Number(query.get('recent') ?? 5) || 5))
        const list = state().distillations ?? []
        writeOk(res, distillTrend(task === '' ? list : list.filter(item => item.task === task), recent))
      },
    },
    // 2026-10-12 删：`GET knowledge/distill/fewshot` 零调用方。复核明确「接口死、函数活」：
    // 选取函数 fewShotExamples 仍由上下文注入使用（DEF-138 修复后真的进模型上下文），
    // 这里只删掉那层没人读的只读 HTTP 面。
    {
      m: 'POST',
      p: 'knowledge/distill/rate',
      h: ({ res, body }) => {
        const params = (body ?? {}) as { id?: unknown; rating?: unknown }
        const id = typeof params.id === 'string' ? params.id : ''
        const rating = Number(params.rating ?? 0) || 0
        writeOk(res, { ok: id !== '' && rateDistillation(deps, id, rating) })
      },
    },
    {
      m: 'POST',
      p: 'knowledge/inject-preview',
      h: ({ res, body }) => {
        const query = typeof (body as { query?: unknown })?.query === 'string' ? String((body as { query: string }).query) : ''
        const context = buildKnowledgeContext(state(), query)
        writeOk(res, { paths: context.paths, chars: context.chars, block: context.block, excluded: context.excluded })
      },
    },
  )
}
