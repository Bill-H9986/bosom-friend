/**
 * 产品语境的落盘家与每轮焦点块：稳定语境写 `$DSH_HOME/AGENTS.md`（官方上下文通道读它），
 * 易变的"用户正在看什么"作为每轮上下文随请求送入。
 *
 * 为什么走文件而不是每轮拼字符串（ADR-003 口径二）：
 * 拼接进 prompt 的文本在会话日志里看不出来源、用户也改不了；落在数据根的指令文件三条都成立——
 * 可读（用户能在自己的数据根里看到"APP 教了模型什么"）、可编辑（改文件即改行为）、
 * 可审计（内核把它作为一条带来源的 user/message 写进会话日志）。
 *
 * 承载四类语境里**稳定**的三类：领域（产品规则全文）、约束（硬数字）、历史（踩过的坑 +
 * 这台机器上真实的失败）。每轮都变的东西（当前焦点对象、本轮检索到的知识）仍走每轮请求，
 * 因为文件是在会话建立时读一次、会话活着期间不会重读。
 *
 * 领域语境从 `agent-rules.ts` 取**同一份常量**：单一事实源不变，变的只是投递方式
 * （从"每轮拼进提示词"改成"会话建立时经官方通道注入"）。
 *
 * @module @deepseek-ai/dsh-bosom-friend-server/agent-context
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { atomicReplace } from './store.ts'
import { AGENT_RULES } from './agent-rules.ts'
import { MAX_NOTE_CHARS, MAX_TITLE_CHARS, MAX_TOPICS } from './object-actions.ts'
import { SEGMENT_MAX_SECONDS, SEGMENT_MIN_SECONDS } from './speech.ts'
import { SHOT_MAX_SECONDS, SHOT_TARGET_SECONDS } from './storyboard.ts'
import { MAX_LONG_VIDEO_TOPIC_CHARS } from './long-video.ts'
import { declaredBodyLimits } from './platform-catalog.ts'

/** 语境里每条账号定位最多带多少字（语境是给模型看的，不是账本导出）。 */
const MAX_CONTEXT_POSITIONING_CHARS = 60

/** 自动维护区块的起止标记：区块之外的内容一律属于用户，任何时候都不覆盖。 */
export const MANAGED_BEGIN = '<!-- BOSOM-FRIEND-CONTEXT:BEGIN -->'
export const MANAGED_END = '<!-- BOSOM-FRIEND-CONTEXT:END -->'

/** 收集到的语境事实（全部来自产品真实数据，没有一条是推测）。 */
export interface AgentContextFacts {
  /** 已绑定的平台名（如 `小红书`/`抖音`）；空数组表示还没有任何账号。 */
  platforms: string[]
  /** 最近的真实失败原文（任务/发布/接待），越靠前越新。 */
  recentFailures: string[]
  /** 蒸馏账本里的成功样本条数（"第 N 次"的原料有多少）。 */
  successSamples: number
  /** 蒸馏账本里已评分的样本条数（评分 ≥4 的会成为下一次的成功样例）。 */
  ratedSamples: number
  /**
   * **用户此刻真正能做什么**（飞书那句「权限即上下文边界」在本产品里的落点）。
   *
   * 为什么必须有：语境里只写"你绑了小红书"是不够的——**掉了登录的号是做不到事的**，
   * 而产品规则又禁止模型说"我没有权限"。不知道边界，模型就会替用户答应一件做不到的事
   * （最糟的一种是声称已经发布）。这里的每一条都来自账号上的真实登录态。
   */
  /**
   * 账号级 AI 事实（定位 / 风险）：ADR-004 §2.1 把"账号定位与人设"列为**长期上下文**。
   *
   * 只带非空的，且每条截断——语境是给模型看的，不是账本导出。
   */
  accountFacts: Array<{ platform: string, nickname: string, positioning: string }>
  accountUsability: {
    /** 现在就能用的账号数（登录态正常、产品侧状态也正常）。 */
    usable: number
    /** 需要重新登录的账号：平台明说要重登，带着平台给的原因。 */
    relogin: Array<{ platform: string, nickname: string, note: string }>
    /** 产品侧状态不正常的账号（平台没明说要重登，但这条账号已经不是"正常"）。 */
    disabled: Array<{ platform: string, nickname: string }>
    /**
     * 登录态**很久没核实过**的账号。
     *
     * 为什么要有它：登录失效此前只在"发布/同步失败"那一刻才被发现，用户往往在正要用的
     * 时候才撞上；语境里带上"这个号 N 小时没验证过"，模型就会**主动建议先同步核实一次**。
     * 它不声称失效——只说"待核实"，这是事实边界。
     */
    stale: Array<{ platform: string, nickname: string, hours: number }>
  }
  /**
   * 记忆：**同一个平台反复失败**才是记忆（单次失败在 {@link recentFailures} 里）。
   *
   * 为什么按平台聚合：模型需要的是"哪里不能硬来"，而不是一串流水；三条来自同一个平台的
   * 失败，价值远大于三条互不相干的失败。
   */
  failuresByPlatform: Array<{ platform: string, count: number, lastMessage: string }>
  /**
   * 画像：**只统计这台机器上真实发生的事**（绑定几个号、发过什么、偏好哪类产出），
   * 不推断口味、不写"用户喜欢简洁风格"这种没有出处的判断。
   */
  profile: {
    /** 已绑定账号数。 */
    accountCount: number
    /** 发布条数按平台统计（降序）。 */
    publishesByPlatform: Array<{ platform: string, count: number }>
    /** 生成条数按类型统计（图文/视频，降序）。 */
    generationsByKind: Array<{ kind: string, count: number }>
    /** 用户打过 4 分以上的样本里最常见的任务类型；没有就是空串。 */
    topRatedTask: string
  }
  /**
   * 最近的内容创作：用户填的**产品与卖点**，以及那一版脚本的开头。
   *
   * 为什么必须有：发布文案跑偏的根因就在这里——内容创作时用户明明填了「产品与卖点」，
   * 发布环节却读不到它，模型只能拿素材文件名猜（2026-09-29 现场：文件名里的「夜间终版」
   * 被理解成夜景拍摄，写出来的发布文案全是"灯光美学"，真正的招生卖点一个字没提）。
   */
  recentCreations: Array<{ topic: string, scriptExcerpt: string, status: string }>
}

/** 写盘结果：文件路径与内容是否真的变了（没变就不落盘，避免无谓的 mtime 抖动）。 */
export interface AgentContextWriteResult {
  path: string
  changed: boolean
}

/**
 * 约束语境里那些**代码里有唯一出处**的硬数字。
 *
 * 为什么要把它们抽成一份"来源"再渲染：以前这些数字是**手抄**在文案里的
 * （标题 30、镜头 4~12 秒…），改代码不会改文案——2026-09-22 核对时发现两处已经对不上：
 * 文案说「单条视频按 4~12 秒一个镜头」，而代码里 4~12 秒是**段落**时长（SEGMENT_*），
 * 镜头目标 5 秒、上限 6 秒（SHOT_*）。模型照着文案排镜头，就会排出产品根本不会剪的片子。
 */
export interface ConstraintSources {
  /** 标题上限（字）。 */
  titleChars: number
  /** 笔记正文上限（字）。 */
  noteChars: number
  /** 话题上限（个）。 */
  topics: number
  /** 配音段落时长下限/上限（秒）。 */
  segmentMin: number
  segmentMax: number
  /** 单个镜头的目标/上限时长（秒）。 */
  shotTarget: number
  shotMax: number
  /** 长视频选题描述上限（字）。 */
  longVideoTopicChars: number
}

/** 当前生效的来源：全部 import 自各自模块，本文件不写字面量。 */
export const CONSTRAINT_SOURCES: ConstraintSources = {
  titleChars: MAX_TITLE_CHARS,
  noteChars: MAX_NOTE_CHARS,
  topics: MAX_TOPICS,
  segmentMin: SEGMENT_MIN_SECONDS,
  segmentMax: SEGMENT_MAX_SECONDS,
  shotTarget: SHOT_TARGET_SECONDS,
  shotMax: SHOT_MAX_SECONDS,
  longVideoTopicChars: MAX_LONG_VIDEO_TOPIC_CHARS,
}

/**
 * 渲染约束语境的正文行。
 *
 * 与领域语境（产品规则全文）的分工：**政策类**数字（发布限频、互动次数、间隔）写在宪章里，
 * 这里**不再重复**——同一份语境文件里同一个数字出现两次，改一处漏一处就是"教模型两套规矩"；
 * 这里只放**代码里真正会执行的**那些上限，它们是"产品实际会怎么做"的镜像。
 *
 * @param sources - 硬数字来源。
 * @returns 约束清单（每行一条 Markdown）。
 */
export function buildConstraintLines(sources: ConstraintSources): string[] {
  return [
    '- 标题不超过 ' + String(sources.titleChars) + ' 个字；标题里不要放表情符号。',
    '- 话题标签不超过 ' + String(sources.topics) + ' 个；给自己的笔记/长文写正文时不超过 '
      + String(sources.noteChars) + ' 个字'
      + (declaredBodyLimits().length === 0
        ? '。'
        : '；平台正文上限（按平台事实表）：'
          + declaredBodyLimits().map(item => item.name + ' ' + String(item.body) + ' 字').join('、') + '。'),
    '- 短视频配音按每段 ' + String(sources.segmentMin) + '~' + String(sources.segmentMax) + ' 秒切分；'
      + '一个镜头的目标时长是 ' + String(sources.shotTarget) + ' 秒、不超过 ' + String(sources.shotMax) + ' 秒。'
      + '长视频按用户选的目标时长排镜头。',
    '- 长视频的选题描述不超过 ' + String(sources.longVideoTopicChars) + ' 个字。',
    // 「成本」这一条是行为约束，不是数字：付钱的动作用户没说就不要做。
    '- 视频生成、配音合成、数字人这类动作会产生真实费用与额度消耗：用户没明确要求时不要主动触发，'
      + '失败也不要反复重试（同一动作连续失败两次就停下来报告）。',
    '- 没有配置大模型时不能生成内容；账号没有登录时不能发布或同步数据。',
    '- 平台的风控结果（限流、验证码、封禁）无法保证，只能按规则降低概率。',
  ]
}

/** 内置的约束语境：由 {@link CONSTRAINT_SOURCES} 渲染而来（数字不在这里手抄）。 */
const CONSTRAINT_LINES = buildConstraintLines(CONSTRAINT_SOURCES)

/**
 * 内置的历史语境：产品在真实使用中反复踩到的坑。
 * 只写"模型会因为不知道而犯错"的条目；能从数据里读到的走 {@link AgentContextFacts}。
 */
const HISTORY_LINES = [
  '- 不确定的数量、链接、作品 ID，一律先用只读工具查；查不到就说"目前没有"，不要补一个看起来合理的数字。',
  '- 用户没说"发布"时不要给发布入口，也不要声称已经发布；"写一篇/生成一条"只是创作请求。',
  '- 平台动作失败时如实转述平台给的原因，不要包装成"稍后会自动成功"。',
  '- 同一场景连续失败两次就停下来报告，不要继续重试。',
  // 发布文案的三段式是**硬约束**，不是排版偏好：服务端按这三段取发布内容，
  // 缺正文就不给「去发布」入口。2026-09-29 现场：模型只回了"已经准备完成。请点击下方
  // 「去发布」按钮…"这类对用户说的话，于是抖音收到的作品简介就是这段对话原文。
  '- 用户要求发布时，回复必须给全三段且各占一行：**标题**：… / **正文**：… / **话题标签**：#a #b。'
    + '正文是**给平台上的人看的内容本身**，不是对用户说的话——不要出现"已经准备完成""请点击下方'
    + '「去发布」按钮""我会带你完成发布"这类操作说明，也不要复述流程；'
    + '缺了正文段服务端不会给出发布入口。',
]

/**
 * 把收集到的事实渲染成自动维护区块的正文（不含起止标记）。
 *
 * @param facts - 语境事实。
 * @returns 区块正文（Markdown）。
 */
export function buildAgentContext(facts: AgentContextFacts): string {
  const lines: string[] = []
  // 领域语境放最前：身份与红线比任何补充说明都重要，长上下文里越靠前越不容易被冲淡。
  lines.push('## 领域语境（产品规则全文）')
  lines.push('')
  lines.push(AGENT_RULES)
  lines.push('')
  lines.push('## 约束语境')
  lines.push('')
  lines.push('下面是本产品的硬约束，直接按它们办事，不要用"一般来说"替代：')
  lines.push('')
  lines.push(...CONSTRAINT_LINES)
  lines.push('')
  lines.push('## 历史语境')
  lines.push('')
  lines.push('下面这些是已经踩过的坑，不要重复踩：')
  lines.push('')
  lines.push(...HISTORY_LINES)
  // 内容语境：创作的「产品与卖点 + 脚本开头」。发布文案必须以它为准，而不是从文件名猜。
  if (facts.recentCreations.length > 0) {
    lines.push('')
    lines.push('## 内容语境（这台机器上最近创作过的片子，写发布文案时以它为准）')
    lines.push('')
    for (const creation of facts.recentCreations) {
      if (creation.topic !== '') lines.push('- 产品与卖点（用户填的）：' + creation.topic)
      if (creation.scriptExcerpt !== '') lines.push('  脚本开头：' + creation.scriptExcerpt)
    }
  }
  if (facts.recentFailures.length > 0) {
    lines.push('')
    lines.push('这台机器上最近真实发生过的失败（来自本产品的任务与发布记录）：')
    lines.push('')
    for (const failure of facts.recentFailures) lines.push('- ' + failure)
  }
  // 记忆：反复失败的地方。与上面的"历史语境"分工不同——那边是产品级的通用坑，
  // 这边是**这台机器上真实反复发生的**。
  if (facts.failuresByPlatform.length > 0) {
    lines.push('')
    lines.push('## 记忆（这台机器上反复出问题的地方，别硬来）')
    lines.push('')
    for (const item of facts.failuresByPlatform) {
      lines.push('- ' + item.platform + '：' + String(item.count) + ' 次失败（最近一次：' + item.lastMessage + '）')
    }
  }
  // 画像：只写事实。模型可以据此调整语气与选题，但每一条都能在数据里查到出处。
  const profileLines: string[] = ['- 已绑定账号：' + String(facts.profile.accountCount) + ' 个']
  if (facts.profile.publishesByPlatform.length > 0) {
    profileLines.push('- 已发布：' + facts.profile.publishesByPlatform
      .map(item => item.platform + ' ' + String(item.count) + ' 条').join('、'))
  }
  if (facts.profile.generationsByKind.length > 0) {
    profileLines.push('- 生成过的内容：' + facts.profile.generationsByKind
      .map(item => item.kind + ' ' + String(item.count) + ' 条').join('、'))
  }
  if (facts.profile.topRatedTask !== '') {
    profileLines.push('- 用户打过高分（≥4）的任务类型：' + facts.profile.topRatedTask)
  }
  // 账号定位：长期上下文（ADR-004 §2.1）。它是 AI 先前的产出、被用户留在账号上的，
  // 所以放在"画像"里：写内容、想选题时它是最直接的依据。
  if (facts.accountFacts.length > 0) {
    profileLines.push('- 账号定位：')
    for (const item of facts.accountFacts)
      profileLines.push('  - ' + item.platform + '·' + item.nickname + '：' + item.positioning.slice(0, MAX_CONTEXT_POSITIONING_CHARS))
  }
  lines.push('')
  lines.push('## 用户画像（这台机器上真实发生的事，不是猜的）')
  lines.push('')
  lines.push(...profileLines)
  lines.push('')
  lines.push('## 当前家底')
  lines.push('')
  lines.push('- 已连接平台：' + (facts.platforms.length > 0 ? facts.platforms.join('、') : '暂无（还没有扫码绑定任何账号）'))
  // 权限边界：能做什么、不能做什么，只写账号上的真实登录态。
  const usability = facts.accountUsability
  const unusable = usability.relogin.length + usability.disabled.length
  if (usability.usable + unusable > 0) {
    const reasons: string[] = []
    if (usability.relogin.length > 0) {
      reasons.push(String(usability.relogin.length) + ' 个需要重新登录（'
        + usability.relogin.map(item => item.platform + '·' + item.nickname
          + (item.note === '' ? '' : '：' + item.note)).join('、') + '）')
    }
    if (usability.disabled.length > 0) {
      reasons.push(String(usability.disabled.length) + ' 个已失效（'
        + usability.disabled.map(item => item.platform + '·' + item.nickname).join('、') + '）')
    }
    // 时效提醒：不声称失效，只说"待核实"——让模型在动手前主动建议核实一次。
    if (usability.stale.length > 0) {
      lines.push('- 登录态待核实：' + usability.stale.map(item => item.platform + '·' + item.nickname
        + (item.hours < 0 ? '（从未在平台侧验证过）' : '（' + String(item.hours) + ' 小时未验证）')).join('、')
        + '——**发布或同步前先核实一次**（bosom_platform_sync_now），别等失败才知道')
    }
    lines.push('- 现在能用的账号：' + String(usability.usable) + ' 个'
      + (reasons.length === 0 ? '（全部正常）' : '；另外 ' + reasons.join('，')
        + '——**这些号现在发不出去也拿不到数据**'))
  }
  lines.push('- 已沉淀样本：成功 ' + String(facts.successSamples) + ' 条，其中已评分 ' + String(facts.ratedSamples) + ' 条（评分 ≥4 的会作为"同等水准交付"的样例进上下文）')
  return lines.join('\n')
}

/**
 * 把区块正文并进现有文件内容：替换上一版自动区块，保留用户在区块外写的一切。
 *
 * 为什么不是整文件覆盖：用户可能把自己的偏好写在同一个文件里（这正是把它放在数据根的意义）。
 * 整覆盖会在用户不知情时删掉他的内容，那是数据丢失，不是"刷新语境"。
 *
 * @param existing - 文件现有内容；文件不存在时传 undefined。
 * @param block - {@link buildAgentContext} 产出的正文。
 * @returns 合并后的完整文件内容（以换行结尾）。
 */
export function mergeAgentContext(existing: string | undefined, block: string): string {
  const head = '# Bosom Friend 产品语境'
  const managed = [MANAGED_BEGIN, block, MANAGED_END].join('\n')
  const previous = existing ?? ''
  const start = previous.indexOf(MANAGED_BEGIN)
  const end = previous.indexOf(MANAGED_END)
  if (start >= 0 && end > start) {
    const before = previous.slice(0, start)
    const after = previous.slice(end + MANAGED_END.length)
    return (before + managed + after).replace(/^\n+/, '').replace(/\n+$/, '') + '\n'
  }
  const kept = previous.trim()
  if (kept === '') return head + '\n\n' + managed + '\n'
  // 首次接管一个已有内容的文件：自动区块插在最前，用户原文完整留在后面。
  return head + '\n\n' + managed + '\n\n' + kept + '\n'
}

/**
 * 写语境文件到 `$DSH_HOME/AGENTS.md`。
 *
 * 内容没变时不落盘：内核会话建立时都会读这个文件，无谓的 mtime 抖动没有好处。
 *
 * @param dshHome - 内核的 `DSH_HOME`（产品数据根的上一级）。
 * @param block - {@link buildAgentContext} 产出的正文。
 * @returns 写入路径与是否真的发生了变化。
 */
export function writeAgentContext(dshHome: string, block: string): AgentContextWriteResult {
  const path = join(dshHome, 'AGENTS.md')
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : undefined
  const next = mergeAgentContext(existing, block)
  if (existing === next) return { path, changed: false }
  // 内核可能正在读这个文件，半截内容不能被读到：走数据根统一的原子替换。
  atomicReplace(path, next)
  return { path, changed: true }
}

/**
 * 产品数据根的上一级就是内核的 `DSH_HOME`（`bin-kernel.ts` 把 `DSH_HOME` 设成产品根，
 * 插件的 `dataRoot` 是它下面的 `bosom-friend/`）。
 *
 * @param dataRoot - 插件的 `dataRoot` 配置。
 * @returns 应当写 `AGENTS.md` 的目录。
 */
export function dshHomeOf(dataRoot: string): string {
  return dirname(dataRoot)
}

/**
 * 前端送来的"用户此刻正在看的对象"。
 *
 * 每一项都是**页面自己知道的**事实（路由、选中项、标题、正文），服务端不推断也不补全：
 * 助手要能回答"这条怎么改"，靠的不是猜，而是页面把正在看的那一条告诉它。
 *
 * 它同时是**任务归属管家**的判定依据（`api.ts` 的 `agentRoleOfFocus`）：页面与对象种类
 * 决定这条任务归哪个管家办。所以这里只收页面知道的事实，服务端不补写、不猜测。
 */
export interface AgentFocus {
  /** 页面标识（如 `draft-box`）。 */
  page: string
  /** 对象种类（如 `草稿`/`账号`/`发布记录`）；页面没有具体对象时为空串。 */
  objectKind: string
  /** 对象 id。 */
  objectId: string
  /** 对象标题（页面当前显示的那一个）。 */
  title: string
  /** 对象正文摘要；长度由页面自行截断。 */
  excerpt: string
}

/** 摘要进上下文前的硬上限：焦点是"引子"，正文该由工具去读，不该整篇塞进提示词。 */
const MAX_FOCUS_EXCERPT_CHARS = 600
/** 标题类字段进上下文前的硬上限。 */
const MAX_FOCUS_TITLE_CHARS = 120

/** 取一个字段的字符串值；非字符串按空串处理（请求体是前端边界，必须校验）。 */
function textOf(value: unknown, limit: number): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed
}

/**
 * 解析前端送来的焦点对象；没有可用信息时返回 undefined。
 *
 * @param raw - 请求体里的 `focus` 字段（未知类型）。
 * @returns 归一化后的焦点；连页面都认不出来时为 undefined。
 */
export function parseAgentFocus(raw: unknown): AgentFocus | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const page = textOf(record.page, MAX_FOCUS_TITLE_CHARS)
  if (page === '') return undefined
  return {
    page,
    objectKind: textOf(record.objectKind, MAX_FOCUS_TITLE_CHARS),
    objectId: textOf(record.objectId, MAX_FOCUS_TITLE_CHARS),
    title: textOf(record.title, MAX_FOCUS_TITLE_CHARS),
    excerpt: textOf(record.excerpt, MAX_FOCUS_EXCERPT_CHARS),
  }
}

/**
 * 把「现在几点」渲染成每轮进模型的一段上下文。
 *
 * 为什么必须有：模型没有可靠的时间基准时会把相对时间算错——2026-10-11 实测，用户说
 * 「明天早上 9 点发」，模型把「明天」算成 2026-06-05（过去），而排期链路对过去时间取
 * delay = Math.max(0, …) = 0，于是「明天发」变成**当场真实发布**（DEF-257）。
 *
 * 时区取**本机**：用户说的「明天早上 9 点」是他这台机器上的 9 点。写死某个时区时，
 * 机器换到别的时区就会把用户的 9 点换算成另一个时刻。换算样板也在这里算好——
 * 模型自己推偏移推错过一次，照着改比照着推稳。
 *
 * 时间每轮都在变，所以走每轮请求，不写进会话建立时读一次的指令文件（ADR-003 口径二）。
 *
 * @returns 上下文块：本地时间给人看，带偏移的 ISO 给排期与日志用。
 */
export function buildNowContext(): string {
  const now = new Date()
  const local = now.toLocaleString('zh-CN', { hour12: false })
  const offset = localUtcOffset(now)
  const tomorrowMorning = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0, 0)
  return '\n\n[当前时间]\n- 本地时间（本机时区 ' + offset + '）：' + local
    + '\n- ISO（UTC）：' + now.toISOString()
    + '\n- 「明天早上 9 点」按本机时区写作：' + stampWithOffset(tomorrowMorning, offset)
    + '\n涉及「今天 / 明天 / 后天」「几点」这类时间说法时，一律以上面这几行为基准换算；'
    + '排期参数写成**带本机偏移**的 ISO（样板见上）；只有日期的字符串（如 2026-10-13）会被当成 UTC 零点，别拿它当排期时刻；'
    + '排期类参数必须传**未来**时间。\n[当前时间结束]'
}

/**
 * 本机相对 UTC 的偏移，形如 +08:00。
 *
 * @param at - 取样时刻（夏令时地区不同日期偏移可能不同）。
 * @returns 带符号的时分偏移。
 */
function localUtcOffset(at: Date): string {
  const minutes = -at.getTimezoneOffset()
  const abs = Math.abs(minutes)
  return (minutes < 0 ? '-' : '+') + String(Math.floor(abs / 60)).padStart(2, '0') + ':' + String(abs % 60).padStart(2, '0')
}

/**
 * 把本机时刻写成带偏移的 ISO 8601——排期参数要的就是这个形态，用 UTC 格式会差一个时区。
 *
 * @param at - 本机时刻。
 * @param offset - {@link localUtcOffset} 的结果。
 * @returns 形如 2026-10-13T09:00:00+08:00 的字符串。
 */
function stampWithOffset(at: Date, offset: string): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return String(at.getFullYear()) + '-' + pad(at.getMonth() + 1) + '-' + pad(at.getDate())
    + 'T' + pad(at.getHours()) + ':' + pad(at.getMinutes()) + ':' + pad(at.getSeconds()) + offset
}

/**
 * 把焦点对象渲染成每轮进模型的一段上下文。
 *
 * 为什么每轮都要送、而不是写进 {@link writeAgentContext} 的那份文件：焦点每轮都在变，
 * 而指令文件只在会话建立时读一次。稳定语境走文件，易变语境走每轮请求，这条界线不能混。
 *
 * @param focus - {@link parseAgentFocus} 的结果。
 * @returns 上下文块；页面没有具体对象时也要说清"他在哪一页"。
 */
export function buildFocusContext(focus: AgentFocus): string {
  const lines: string[] = ['- 页面：' + focus.page]
  if (focus.objectKind !== '' || focus.title !== '' || focus.objectId !== '') {
    const label = focus.objectKind === '' ? '' : focus.objectKind
    const name = focus.title === '' ? '' : '《' + focus.title + '》'
    lines.push('- 正在看的对象：' + (label + name === '' ? focus.objectId : label + name))
  }
  if (focus.excerpt !== '') {
    lines.push('- 对象内容摘要：')
    lines.push(focus.excerpt)
  }
  return '\n\n[用户正在看的对象（回答时以它为准，不要让用户复述；需要完整内容时用工具去读）]\n'
    + lines.join('\n')
    + '\n[当前对象信息结束]'
}
