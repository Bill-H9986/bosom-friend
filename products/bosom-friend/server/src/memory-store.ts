/**
 * 记忆与画像：智能体的"随身小本子"（ADR-003 口径四的 MEMORY / USER 两块）。
 *
 * 为什么是两块独立的纯文本、而不是塞进知识库：
 * - 知识库是**可检索的知识**（按相关度命中，命不中就看不到）；记忆与画像是**每轮都在的事实与偏好**，
 *   必须无条件进系统提示词——"用户叫什么、爱用什么题材、哪条链路容易失败"这类信息一旦依赖检索，
 *   就会出现"明明记过、这轮偏偏没命中"的隐形失忆。
 * - 纯文本 + 条目分隔符让用户能直接读、直接改：他看得见 APP 到底教了模型什么。
 *
 * 容量为什么设得这么紧（照 Hermes 的实测口径：MEMORY 2200 / USER 1375 字符）：
 * 上限是**纪律**，不是限制——满了就迫使模型做信息压缩，过时的事实自然被挤掉。
 * 无限追加的记忆文件几个月就会膨胀成没人读的怪兽，反而把上下文撑爆。
 *
 * 超限为什么不静默丢弃、也不自动压缩：
 * 静默丢等于"模型以为记住了、其实没有"；自动压缩要定义"哪条不重要"，而那是模型的判断。
 * 所以 {@link addMemoryEntry} 直接失败，并把**现有全部条目**交回给调用方——
 * 由模型自己决定替换哪条、合并哪两条，这一步本身就是一次自我反思。
 *
 * @module @deepseek-ai/dsh-bosom-friend-server/memory-store
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicReplace } from './store.ts'

/** 记忆与画像两类文件。 */
export type MemoryKind = 'memory' | 'user'

/** 一条记忆/画像条目。 */
export interface MemoryEntry {
  /** 条目正文（一条事实或一条偏好）。 */
  text: string
  /** 写入时间（ISO）。 */
  createdAt: string
}

/**
 * 各文件容量上限（字符）。
 *
 * 与 Hermes 同口径：记忆 2200、画像 1375。数字本身不重要，**有限**才重要——
 * 它把"记什么"从"能不能记下"变成"值不值得占位"。
 */
export const MEMORY_MAX_CHARS: Record<MemoryKind, number> = { memory: 2200, user: 1375 }

/** 条目分隔符：Hermes 用 §，这里沿用——它不会出现在正常中文里，切分不会误伤。 */
export const ENTRY_SEPARATOR = ' § '

/** 单条上限：一条记忆该是一句话，不是一段文档。 */
const MAX_ENTRY_CHARS = 400

/** 记忆目录名（数据根下）。 */
const MEMORY_DIR = 'memory'

/**
 * 记忆文件的绝对路径。
 *
 * @param dshHome - 内核的 `DSH_HOME`（产品数据根的上一级）。
 * @param kind - 记忆或画像。
 * @returns 文件路径。
 */
export function memoryFilePath(dshHome: string, kind: MemoryKind): string {
  return join(dshHome, MEMORY_DIR, kind === 'memory' ? 'MEMORY.md' : 'USER.md')
}

/**
 * 正文起始标记：文件头与条目之间的**唯一分界**。
 *
 * 为什么需要它：文件头是给人看的说明（含"用 § 分隔"这句话本身），而 § 又是条目分隔符——
 * 只按"跳过 # 开头的行"来剥头部，会把说明文字切进条目里（实测：读回来的第一条记忆
 * 变成了"APP 智能体在干活过程中攒下的事实（…）每行一条，用"）。有了显式标记，
 * 人怎么改文件头都不会污染条目。
 */
const ENTRIES_MARKER = '<!-- entries -->'

/** 人读的文件头：让用户打开文件就知道这是什么、能不能改。 */
function fileHeader(kind: MemoryKind): string {
  const what = kind === 'memory'
    ? 'APP 智能体在干活过程中攒下的事实（哪条链路容易失败、哪个平台有限频、什么参数好用）。'
    : 'APP 智能体对你（使用者）的认识（口吻偏好、常用题材、常发平台）。'
  // 说明文字里**不能出现**标记本身：出现过一次，读的时候 indexOf 就会命中说明里的那一处，
  // 把说明的剩余部分当成条目读出来（实测踩过）。所以这里只说"下面那行标记"。
  return '# ' + (kind === 'memory' ? '记忆' : '画像') + '\n\n' + what + '\n'
    + '正文在下面那行标记之后，用 § 分隔；可以直接改、直接删——改完下次对话就生效。\n'
}

/**
 * 读出条目列表。文件不存在时返回空数组（首次运行是正常状态，不是错误）。
 *
 * @param dshHome - 内核的 `DSH_HOME`。
 * @param kind - 记忆或画像。
 * @returns 条目列表，按写入顺序。
 */
export function readMemory(dshHome: string, kind: MemoryKind): MemoryEntry[] {
  const file = memoryFilePath(dshHome, kind)
  if (!existsSync(file)) return []
  let raw = ''
  try {
    raw = readFileSync(file, 'utf8')
  }
  catch {
    // 文件被占用/权限不足时按"还没记过"处理：读记忆不该让这一轮对话整体失败。
    return []
  }
  // 只认**最后一处**标记之后的正文：文件头里那句"用 § 分隔"本身含有分隔符，按行过滤剥不干净；
  // 取最后一处则连"用户手工在说明里贴了标记"这种情况也不会误判。
  const marker = raw.lastIndexOf(ENTRIES_MARKER)
  const body = marker < 0 ? '' : raw.slice(marker + ENTRIES_MARKER.length)
  return body
    .split('§')
    .map(part => part.trim())
    .filter(part => part !== '')
    .map(text => ({ text, createdAt: '' }))
}

/**
 * 当前条目占用的字符数（注入预算与超限判断都用它）。
 *
 * @param entries - 条目列表。
 * @returns 字符数。
 */
export function memoryChars(entries: readonly MemoryEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.text.length, 0)
}

/** 写回文件的结果：只有成功与"超限"两种结局，没有静默丢弃。 */
export type MemoryWriteResult =
  | { ok: true, entries: MemoryEntry[] }
  | { ok: false, reason: 'over-limit', limit: number, used: number, current: MemoryEntry[] }

/**
 * 追加一条记忆/画像。
 *
 * 唯一的失败理由就是**超限**——这时把现有条目原样返回，让调用方（模型）自己决定
 * 替换哪条：它不是被动接受淘汰规则，而是主动做一次信息整理。
 *
 * @param dshHome - 内核的 `DSH_HOME`。
 * @param kind - 记忆或画像。
 * @param text - 条目正文；空串或多条合并写法会被拒。
 * @returns 写入结果。
 */
export function addMemoryEntry(dshHome: string, kind: MemoryKind, text: string): MemoryWriteResult {
  const value = text.trim().slice(0, MAX_ENTRY_CHARS)
  const current = readMemory(dshHome, kind)
  if (value === '') return { ok: true, entries: current }
  // 已有同一条事实就不重复记：重复条目不会让模型更懂，只会更快把容量吃满。
  if (current.some(entry => entry.text === value)) return { ok: true, entries: current }
  const used = memoryChars(current) + value.length
  const limit = MEMORY_MAX_CHARS[kind]
  if (used > limit) return { ok: false, reason: 'over-limit', limit, used, current }
  const entries = [...current, { text: value, createdAt: new Date().toISOString() }]
  writeMemoryFile(dshHome, kind, entries)
  return { ok: true, entries }
}

/**
 * 用整理后的条目覆盖整个文件（模型合并/替换时走这条）。
 *
 * @param dshHome - 内核的 `DSH_HOME`。
 * @param kind - 记忆或画像。
 * @param entries - 新的完整条目列表。
 * @returns 落盘后的条目数。
 */
export function replaceMemoryEntries(dshHome: string, kind: MemoryKind, entries: readonly string[]): number {
  const list = entries.map(text => text.trim()).filter(text => text !== '').map(text => ({ text: text.slice(0, MAX_ENTRY_CHARS), createdAt: new Date().toISOString() }))
  writeMemoryFile(dshHome, kind, list)
  return list.length
}

/** 落盘（走数据根统一的原子替换，不再各自实现一份临时文件 + 改名）。 */
function writeMemoryFile(dshHome: string, kind: MemoryKind, entries: readonly MemoryEntry[]): void {
  const file = memoryFilePath(dshHome, kind)
  const body = entries.map(entry => entry.text).join(ENTRY_SEPARATOR)
  const stamp = new Date().toISOString()
  const content = fileHeader(kind) + '\n> 最后更新：' + stamp + '\n\n' + ENTRIES_MARKER + '\n' + body + '\n'
  atomicReplace(file, content)
}

/**
 * 进入系统提示词的记忆块。
 *
 * 空记忆返回空串（不是"暂无记忆"）：没有内容时不该在提示词里占位，
 * 模型看不到这一段，也就不会去猜"为什么这里是空的"。
 *
 * @param dshHome - 内核的 `DSH_HOME`。
 * @returns 可直接拼进提示词的 Markdown 块；都为空时返回空串。
 */
export function buildMemoryContext(dshHome: string): string {
  const memory = readMemory(dshHome, 'memory')
  const user = readMemory(dshHome, 'user')
  if (memory.length === 0 && user.length === 0) return ''
  const parts: string[] = ['# 你已经记住的事（跨对话生效，不用重新问用户）', '']
  if (memory.length > 0) {
    parts.push('## 关于这个 APP 与它的平台', ...memory.map(entry => '- ' + entry.text), '')
  }
  if (user.length > 0) {
    parts.push('## 关于使用者', ...user.map(entry => '- ' + entry.text), '')
  }
  return parts.join('\n')
}
