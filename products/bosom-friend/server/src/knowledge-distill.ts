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
  /** 用户评分 1-5；未评分为 0。 */
  rating: number
  createdAt: string
  /** 来源实体 id（生成任务 id 等）。 */
  sourceId: string
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
const MAX_NOTES_SCANNED = 400
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
  const entries = Object.entries(knowledge.notes)
    .filter(([path]) => !path.startsWith(AUDIT_FOLDER + '/'))
    .slice(0, MAX_NOTES_SCANNED)
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

/** 记录一条蒸馏样本；同一来源 id 重复记录时覆盖。 */
export function recordDistillation(d: Deps, record: Omit<DistillationRecord, 'id' | 'createdAt'>): void {
  const knowledge = d.store.files.knowledge.load() as KnowledgeState
  const list = knowledge.distillations ?? []
  const entry: DistillationRecord = {
    ...record,
    id: 'dist-' + record.sourceId,
    createdAt: nowIso(),
  }
  const next = [entry, ...list.filter(item => item.sourceId !== record.sourceId)].slice(0, 2000)
  knowledge.distillations = next
  if (record.knowledgePaths.length > 0) knowledge.injectedCount = (knowledge.injectedCount ?? 0) + 1
  d.store.files.knowledge.save(knowledge)
}

/** 更新某条蒸馏样本的评分（0 表示取消评分）。 */
export function rateDistillation(d: Deps, id: string, rating: number): boolean {
  const knowledge = d.store.files.knowledge.load() as KnowledgeState
  const list = knowledge.distillations ?? []
  const target = list.find(item => item.id === id)
  if (target === undefined) return false
  target.rating = Math.max(0, Math.min(5, Math.round(rating)))
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

/** 少样本示例：评分 ≥4 或成功且注入了知识的样本，供直接喂回模型。 */
export function fewShotExamples(knowledge: KnowledgeState, task: string, limit = 2): DistillationRecord[] {
  const list = knowledge.distillations ?? []
  return list
    .filter(item => (task === '' || item.task === task) && item.status === 'success' && (item.rating >= 4 || item.knowledgePaths.length > 0))
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
            task: item.task,
            instruction: item.instruction.slice(0, 300),
            output: item.output.slice(0, 800),
            model: item.model,
            knowledgePaths: item.knowledgePaths,
            rating: item.rating,
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
      p: 'knowledge/distill/fewshot',
      h: ({ res, query }) => {
        const task = query.get('task') ?? ''
        const limit = Math.max(1, Math.min(5, Number(query.get('limit') ?? 2) || 2))
        writeOk(res, { list: fewShotExamples(state(), task, limit) })
      },
    },
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
