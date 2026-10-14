/**
 * 草稿标题策略（DEF-279）。
 *
 * 现象：生成链路把**用户指令原文**当成了草稿标题——用户说「生成 3 张无人机培训实训场景图…做成一条图文」，
 * 草稿箱里那条的标题就是这句话本身（cnt-057cc0cc / cnt-e557de9d 实测 3 条里 2 条如此）。
 * 用户看到的是自己说过的话，而不是内容标题。
 *
 * **为什么在这里修、而不是再调一次模型**：生成结果里其实**已经有真标题**——
 * 厂商把标题写进了正文首段，形如 `**标题**：零基础学无人机，真的不难！`，
 * 而落库只认 `response.title` 字段。所以这是一次本地解析就能修的事：零额外模型调用、零额度消耗。
 *
 * 判定「指令复述」的口径（任一命中即认为它不是内容标题）：
 *   ① 以「生成」开头（「生成一条小红书图文笔记…」）；
 *   ② 含「主题：」（指令模板的痕迹）；
 *   ③ 与本次 prompt 的前 20 字重合（指令被截断后当标题——实测最常见的就是这种）。
 * 命中后取值顺序：正文里的 `**标题**：` 段 → 正文首行 → 原值（都取不到就如实保留，不编）。
 *
 * @module @deepseek-ai/dsh-bosom-friend-server/draft-title
 */

/** 标题字符上限：与草稿卡片展示口径一致（原实现即 slice(0, 60)）。 */
const MAX_TITLE_CHARS = 60

/** 厂商与正文都取不到标题时的兜底值。 */
const FALLBACK_TITLE = 'AI 生成内容'

/** 识别指令复述时，与 prompt 比对的头部长度。 */
const PROMPT_HEAD_CHARS = 20

/** resolveDraftTitle 的输入：厂商返回的标题/正文与本次任务指令。 */
export interface DraftTitleInput {
  /** 厂商返回的标题字段（可能是指令原文）。 */
  title?: string | undefined
  /** 厂商返回的正文；真标题常以 `**标题**：X` 写在正文首段。 */
  description?: string | undefined
  /** 本次生成任务的 prompt（用户指令原文），用来识别「指令复述」。 */
  prompt?: string | undefined
}

/** resolveDraftTitle 的结果：最终标题与本次是否发生了替换（供日志与门禁核验）。 */
export interface DraftTitleResult {
  /** 最终用于落库的标题（已截断到上限）。 */
  title: string
  /** true = 原值被判为指令复述或为空，标题已被替换。 */
  replaced: boolean
  /** 替换原因（人话，写日志用）；未替换时为空串。 */
  reason: string
}

/**
 * 清洗一行文本：去 markdown 强调符、去首尾引号与空白、把连续空白压成一个空格。
 *
 * @param text - 原始文本。
 * @returns 清洗后的文本。
 */
function clean(text: string): string {
  return text
    .replace(/\*\*/g, '')
    .replace(/^[#>\s"'「『]+/, '')
    .replace(/["'」』\s]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 从正文里抽「标题」段：优先 `**标题**：X`，其次 `标题：X`。
 *
 * @param description - 厂商返回的正文。
 * @returns 抽到的标题；没有则空串。
 */
function titleFromBody(description: string): string {
  const matched = /^\s*(?:\*\*)?标题(?:\*\*)?\s*[:：]\s*(.+?)\s*$/m.exec(description)
  if (matched === null) return ''
  return clean(matched[1] ?? '')
}

/**
 * 取正文首行（跳过 `**正文**：` 这类标签行与纯符号行）。
 *
 * @param description - 厂商返回的正文。
 * @returns 首行内容；取不到则空串。
 */
function firstLineOfBody(description: string): string {
  for (const raw of description.split(/\r?\n/)) {
    const line = clean(raw)
    if (line.length < 4) continue
    if (/^(?:正文|标题|话题标签|标签)$/.test(line)) continue
    if (/^[#*\-=—]+$/.test(line)) continue
    return line
  }
  return ''
}

/**
 * 判断标题是不是「用户指令的复述」。
 *
 * @param title - 已清洗的标题。
 * @param prompt - 本次任务的用户指令原文。
 * @returns true = 它是指令复述，不能当内容标题用。
 */
function isInstructionEcho(title: string, prompt: string): boolean {
  if (title === '') return false
  if (/^生成/.test(title)) return true
  if (/主题\s*[:：]/.test(title)) return true
  const head = clean(prompt).slice(0, PROMPT_HEAD_CHARS)
  return head.length >= 8 && title.includes(head)
}

/**
 * 解析落库用的草稿标题：把「指令复述」换成正文里已有的真标题。
 *
 * @param input - 厂商返回的标题、正文与本次任务指令。
 * @returns 最终标题、是否替换过、替换原因。
 */
export function resolveDraftTitle(input: DraftTitleInput): DraftTitleResult {
  const raw = clean(input.title ?? '')
  const body = input.description ?? ''
  const fromBody = titleFromBody(body)

  if (raw === '') {
    const picked = fromBody !== '' ? fromBody : FALLBACK_TITLE
    return {
      title: picked.slice(0, MAX_TITLE_CHARS),
      replaced: true,
      reason: fromBody !== '' ? '厂商没给标题，改用正文里的标题' : '厂商没给标题，正文里也没有标题段',
    }
  }
  if (!isInstructionEcho(raw, input.prompt ?? '')) {
    return { title: raw.slice(0, MAX_TITLE_CHARS), replaced: false, reason: '' }
  }
  const candidate = fromBody !== '' && fromBody !== raw ? fromBody : firstLineOfBody(body)
  if (candidate === '' || candidate === raw) {
    return { title: raw.slice(0, MAX_TITLE_CHARS), replaced: false, reason: '标题是指令复述，但正文里没有可用的标题段' }
  }
  return { title: candidate.slice(0, MAX_TITLE_CHARS), replaced: true, reason: '原标题是用户指令的复述，改用正文里的标题' }
}
