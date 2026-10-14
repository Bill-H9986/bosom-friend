/**
 * Bosom Friend后端共享类型。字段名严格对齐Bosom Friend前端的 TS 接口（bosom-friend-web/src），
 * 保证 `{code, data, message}` 信封内的 data 满足前端类型而无需改造前端。
 * @module @deepseek-ai/dsh-bosom-friend-server/types
 */

/** 消息通知记录（对齐前端 store/notifications 的 NotificationItem）。 */
export interface NotificationRecord {
  id: string
  /**
   * `system` 是自动任务的主动汇报（见 `auto-tasks.ts`）：与运营公告共用同一个通知中心，
   * 但来源不同——公告是人写的，`system` 是这台机器上的自动检查发现的，id 统一以 `auto-` 开头。
   */
  type: 'announcement' | 'changelog' | 'system'
  title: string
  content: string
  time: string
  highlight?: boolean
}

/** 统一响应信封（前端 client.ts 判定 code===0 为成功；HTTP 状态不参与业务判断）。 */
export interface ZyEnvelope<T> {
  code: number | string
  data: T
  message: string
}

/** 用户档案（对齐 store/user 的 UserInfo）。 */
export interface ZyUser {
  createdAt: string
  id: string
  name: string
  password: string
  phone?: string
  mail: string
  salt: string
  status: number
  updateTime: string
  _id: string
  avatar?: string
  score?: number
  income?: number
  popularizeCode?: string
  placeId?: string
}

/** 渠道平台账号（对齐 SocialAccount）。 */
export interface ZySocialAccount {
  id: string
  type: string
  uid: string
  avatar: string
  nickname: string
  loginCookie?: string
  access_token?: string
  refresh_token?: string
  loginTime?: string
  fansCount?: number
  /** 最近一次平台操作判定的登录态：valid=平台接受该会话，invalid=平台已吊销（需重新扫码）。 */
  loginState?: 'valid' | 'invalid'
  /** loginState 的判定时间与备注，供界面提示与排查。 */
  loginCheckedAt?: string
  loginNote?: string
  /**
   * 疑似登录失效的累计次数与最近一次时间。
   *
   * 为什么需要它（2026-10-11 实测）：作品同步判定"登录失效"靠的是**页面上有没有登录框文字**，
   * 页面加载慢时会误报；而一次误报就把账号锁成 invalid、之后所有发布都被拦（用户的长期痛点）。
   * 现在软证据要**短时间内连续两次**才确认，单次只记疑似。
   */
  loginSuspectAt?: string
  loginSuspectCount?: number
  followingCount?: number
  workCount?: number
  income?: number
  /** 前端按数值判定状态（非枚举串）。 */
  status: number
  createTime?: string
  updateTime?: string
  createdAt?: string
  updatedAt?: string
  rank: number
  groupId: string
  channelId?: string
  clientType?: string
  /** 最近一次真实平台采集成功的时间；只由采集链路写入，读接口不改写。 */
  lastStatsTime?: string
  /** 最近一次真实平台采集的尝试时间（成功或失败都记）。 */
  lastStatsAttemptTime?: string
  /** 最近一次真实平台采集失败的原因，采集成功后清除；界面据此如实提示，不把失败说成已刷新。 */
  lastStatsError?: string
  /**
   * 这个号的**定位与人设**：一句话讲清"它是给谁看的、靠什么留住人"。
   *
   * 谁写：账号页上的「AI 定位」动作（`POST ai/object-action`，kind=account）。
   * 为什么值得有：它是账号级的长效上下文——写清之后，生成侧才知道该用什么口吻与选题，
   * 而不是每次都从"账号类型"猜。
   */
  aiPositioning?: string
  /**
   * AI 风险评估的结论（谁写：账号页的「AI 风险评估」）。
   *
   * 依据是这台机器上的真实事实：登录态 + 这个号的发布失败史 + 发布量。
   */
  aiRisk?: string
  /** 定位的生成时间；没写过就没有这个字段。 */
  aiPositioningAt?: string
  /** 最近一次写风险评估的时间。 */
  aiRiskAt?: string
}

/** 账号分组（对齐 AccountGroupItem）。 */
export interface ZyAccountGroup {
  id: string
  name: string
  rank: number
  isDefault: boolean
  proxyIp?: string
  ip?: string
  location?: string
  countryCode?: string
  hasBrowserConfig?: boolean
  createdAt?: string
  updatedAt?: string
}

/** 素材媒体项（对齐 MaterialMedia）。 */
export interface ZyMaterialMedia {
  url: string
  type: 'img' | 'video'
  content?: string
  thumbUrl?: string
}

/** 草稿素材（对齐 PromotionMaterial 的核心字段）。 */
export interface ZyPromotionMaterial {
  _id: string
  id: string
  groupId: string
  title: string
  desc?: string
  coverUrl?: string
  mediaList: ZyMaterialMedia[]
  type?: string
  status: 0 | 1
  location?: number[]
  option?: unknown
  createdAt?: string
  useCount?: number
  topics?: string[]
  accountTypes?: string[]
  metadata?: Record<string, unknown>
}

/** 素材分组（对齐 PromotionPlan 核心字段）。 */
export interface ZyMaterialGroup {
  id: string
  name: string
  title?: string
  type?: string
  platform?: string
  desc?: string
  createdAt?: string
  updatedAt?: string
  mediaCount?: number
  isDefault?: boolean
  useScene?: string
  useSceneRelId?: string
}

/**
 * 发布记录状态。数值即对外协议（HTTP 响应中的 `status` 字段），禁止改动既有取值。
 */
export const PUBLISH_RECORD_STATUS = {
  /** 发布失败。 */
  FAILED: -1,
  /** 待发布（已创建、未到发布时间）。 */
  PENDING: 0,
  /** 已发布成功。 */
  PUBLISHED: 1,
  /** 发布中（已拉起平台发布任务，等待结果）。 */
  PUBLISHING: 2,
  /** 排队中。 */
  QUEUED: 6,
  /** 已排期（修改了发布时间，等待到点）。 */
  SCHEDULED: 7,
  /** 已取消。 */
  CANCELED: 9,
} as const

/** {@link PUBLISH_RECORD_STATUS} 的取值联合。 */
export type PublishRecordStatus = typeof PUBLISH_RECORD_STATUS[keyof typeof PUBLISH_RECORD_STATUS]

/** 发布记录（对齐 ChannelPublishRecordItem）。 */
export interface ZyPublishRecord {
  id: string
  flowId?: string
  taskId?: string
  userTaskId?: string
  userId?: string
  accountId?: string
  /**
   * 这条内容来自哪条草稿（发布时由界面传来）。
   *
   * 为什么要留：没有它，"这条作品发得怎么样"与"当时 AI 是怎么改的"就对不上账——
   * 用真实表现给样本打分（ADR-004 附录 P1）整条链都断在这里。
   */
  draftId?: string
  /**
   * 这条发布来自哪张动作卡的工单号（服务端发放的 `requestId`）。
   *
   * 为什么要留：动作卡的"已申请"要有下文——发布真的成了要把 `verified` 与作品号回填到任务上
   * （DEF-247）。不回填的话，任务里那张卡永远停在"已申请"，用户与模型都判断不了这一步做完了没有。
   * 界面没带这个字段时为空：这条记录照常发布，只是没有工单可回填，不做任何猜测性配对。
   */
  requestId?: string
  accountType: string
  type: 'VIDEO' | 'ImageText'
  status: PublishRecordStatus
  title?: string
  desc?: string
  publishTime: string
  platformWorkId?: string
  workLink?: string
  videoUrl?: string
  coverUrl?: string
  imgUrlList?: string[]
  topics?: string[]
  /**
   * 内容标注（网信办 2026-05 起为发布必经环节）：抖音侧对应"自主声明"，
   * 引擎按这段文字在声明弹窗里点选（实测选项形如"内容由AI生成"/"内容为个人观点"）。
   *
   * 缺省按 {@link DEFAULT_CONTENT_DECLARATION}（"内容由AI生成"）——产品出的是 AI 内容。
   */
  declaration?: string
  /** 位置标签（可选）：发布时在平台「添加标签 → 位置」里点选的地名。 */
  location?: string
  source?: string
  errorMsg?: string
  publishedAt?: string
  createdAt?: string
  updatedAt?: string
  linkStatus?: 'pending' | 'ready' | 'failed'
  /** 平台侧已不存在该作品（同步对账标记）；为 true 时数据中心不再统计该记录。 */
  removedOnPlatform?: boolean
  /** AI 复盘结论（谁写：数据中心作品行上的「AI 复盘」）。复盘的是**这条已经发出去的作品**。 */
  aiReview?: string
  /** 最近一次写复盘的时间。 */
  aiReviewAt?: string
  /**
   * 平台侧互动计数。**字段缺省表示平台未提供（未采集），不得写成 0 冒充「数据是 0」**——
   * 界面必须把「未采集」与「0」分开显示（要求二 R3 无源不显示）。
   */
  engagement?: {
    viewCount?: number
    commentCount?: number
    likeCount?: number
    shareCount?: number
    clickCount?: number
    impressionCount?: number
    favoriteCount?: number
  }
}

/**
 * 账号级 AI 事实（定位 / 风险评估），按 **(platform, uid)** 寻址。
 *
 * 为什么不是写在账号行上（DEF-147）：账号这个实体在两个地方各有一份——服务端的
 * accounts.json 与**桌面端本机 SQLite**。而"这个号该怎么定位、现在能不能干活"是 AI 的产出，
 * 它必须只有一个家，且**服务端语境读得到**（模型要看见它）：
 * - 写在账号行上：桌面端本机账号没有服务端行，写了没人看得到；
 * - 写在本机 SQLite：服务端语境读不到，模型永远看不见。
 * 所以按 (平台, 账号 uid) 存在这里——两边都拿这个键来对账。
 */
export interface AccountFact {
  platform: string
  uid: string
  /** 账号定位（「AI 定位」的产出）。 */
  positioning?: string
  /** 最近一次写定位的时间。 */
  positioningAt?: string
  /** 风险评估（「AI 风险评估」的产出）。 */
  risk?: string
  /** 最近一次写风险评估的时间。 */
  riskAt?: string
}

/** 账号事实的键：平台 + uid（两边唯一的共同标识）。 */
export function accountFactKey(platform: string, uid: string): string {
  return platform + '|' + uid
}

/** 上传媒体条目（对齐 MediaItem）。 */
export interface ZyMaterial {
  _id: string
  userId: string
  groupId: string
  materialGroupId?: string
  type: 'img' | 'video'
  url: string
  thumbUrl: string
  title: string
  desc: string
  useCount: number
  metadata?: Record<string, unknown>
  createdAt: string
}

/** 内容域记录类型：asset=上传/生成的文件素材，draft=可发布草稿。 */
export type ZyContentKind = 'asset' | 'draft'

/**
 * 内容域唯一存储记录：asset 与 draft 共用一张表（contents.json）与一个 id 空间，由 `kind` 区分。
 * 字段沿用 ZyMaterial / ZyPromotionMaterial 的原名，两者专属字段均可选；
 * 这两个接口保留为按 kind 划分的字段视图，落盘一律使用本类型。
 */
export interface ZyContentRecord {
  kind: ZyContentKind
  _id: string
  /** 草稿对外 id（asset 无此字段）。 */
  id?: string
  /** 素材归属用户（asset 专属）。 */
  userId?: string
  groupId: string
  /** 素材组 id（asset 专属）。 */
  materialGroupId?: string
  /** 素材文件地址（asset 专属）。 */
  url?: string
  /** 素材缩略图（asset 专属）。 */
  thumbUrl?: string
  title: string
  desc?: string
  /** 草稿封面（draft 专属）。 */
  coverUrl?: string
  /** 草稿媒体列表（draft 专属）。 */
  mediaList?: ZyMaterialMedia[]
  /** 素材为 img/video；草稿为业务类型串（normal/video/image-text）。 */
  type?: string
  /** 草稿状态（draft 专属）。 */
  status?: 0 | 1
  location?: number[]
  option?: unknown
  createdAt?: string
  useCount?: number
  topics?: string[]
  accountTypes?: string[]
  /**
   * AI 合规检查的结论（谁写：草稿详情里的「AI 合规检查」）。
   *
   * 与其它动作不同，它不改内容、只给判断：**通过** 或 **问题清单 + 改法**。
   * 存在草稿上而不是别处：它是"这条内容"的属性，发布前就该看得见。
   */
  aiCompliance?: string
  /**
   * AI 配图建议（谁写：草稿详情里的「AI 配图建议」）。
   *
   * 与合规检查同类：不改内容、只给判断。建议落在**用户自己的素材库**上（看得见库里有什么）。
   */
  aiIllustration?: string
  /** AI 生成草稿的生成参数快照（草稿详情页复盘 + 「应用到当前输入」的数据源）。 */
  generationParams?: ZyDraftGenerationTask['request']
  metadata?: Record<string, unknown>
}

/** 数据中心指标行。 */
export interface ZyMetricRow {
  date: string
  platform: string
  accountId?: string | undefined
  workId?: string
  viewCount?: number
  likeCount?: number
  commentCount?: number
  shareCount?: number
  favoriteCount?: number
}

/** AI 任务消息（对齐 TaskMessage 子集）。 */
export interface ZyTaskMessage {
  type: 'user' | 'assistant' | 'result' | 'system' | 'error'
  uuid: string
  message?: unknown
  content?: string
  result?: unknown
  createdAt: string
}

/**
 * 归属管家代号（ADR-005：一个总管 + 四个管家）。
 *
 * 与 `presets/roles.json` 的五个键一一对应：工具面由它决定（`kernel-client.ts` 注入
 * `BF_AGENT_ROLE`），任务归属也用它表达——两边同一个词表，界面才敢照着念。
 */
export type ZyAgentRole = 'steward' | 'creator' | 'publisher' | 'operator' | 'device'

/** AI 生成任务（对齐 TaskDetail/列表项字段）。 */
export interface ZyAgentTask {
  id: string
  userId: string
  title: string
  description: string
  tags: string[]
  status: 'running' | 'completed' | 'requires_action' | 'error' | 'aborted'
  medias: { type: string; url: string; coverUrl?: string }[]
  errorMessage: string
  prompt: string
  messages: ZyTaskMessage[]
  rating?: number | null
  ratingComment?: string | null
  favorite?: boolean
  favoritedAt?: string | null
  /**
   * 归属管家：这条任务由哪个管家在办（值域见 {@link ZyAgentRole}）。
   *
   * 为什么必须有它：界面要回答"这件事是谁在办的"（ADR-005 呈现层改造方案 v1.0 的 S1）。
   * 此前管家角色只注入内核进程（`api.ts` 的 `kernelOptionsOf({ role })` 传给 `BF_AGENT_ROLE`），
   * 落不进任务数据，于是任务列表与管家团队视图只能看到一个没有归属的任务。
   *
   * 写入规则：任务创建时按来源判定——对话入口（页面没送焦点对象）归 `steward`；
   * 页面带着焦点对象发起时按对象类型归对应管家；判不准一律 `steward`（不猜）。
   * 已经登记过归属的任务不因中途换页改判。
   *
   * 缺省（早于本字段落地的旧任务）= 未登记：调用方显示"未登记"，不要拿一个管家顶上。
   */
  agentRole?: ZyAgentRole
  /**
   * 工具轨迹：这条任务**真的调过哪些工具**，逐条记轮次、工具名、时间与成败。
   *
   * 为什么必须有它：「页面只做过程与结果的可视化」，而**过程就是工具轨迹**。此前每次工具调用
   * 只在内核回调里累计一个计数（api.ts 的 toolCalls），轮次、工具名、成败都不落盘——于是
   * 三方交叉与门禁只能看当前轮的 SSE；**转交之后的后续轮次彻底看不到**
   * （2026-10-12 门禁 case 5/7 实测：任务转给专业管家后，门禁无从核验「那一轮真的办了事」）。
   *
   * 写入规则：本轮每次 tool-call 追加一条（`isError` 初值 false），tool-result 到达时按 callId
   * 回填真实成败；随任务一起落盘（与 agent-tasks.json 同一次写，不另开文件）。
   * 空数组 = 这条任务确实没调过工具——**不是「缺字段」**，调用方别把两者混为一谈。
   */
  toolTrace?: Array<{
    /** 第几轮（该任务里用户消息的序号，从 1 起）。 */
    turn: number
    /** 内核工具名（如 bosom_content_list_drafts）。 */
    name: string
    /** 这次调用发生的时刻（ISO）。 */
    at: string
    /** 是否失败（tool-result 到达后回填；结果未到或成功均为 false）。 */
    isError: boolean
  }>
  /**
   * 动作回填台账：服务端发放的工单号 → 前端执行后的真实结果。
   *
   * "已申请"与"已执行/已核验"的区别就落在这里：没有它，任务里只剩那张动作卡，
   * 模型与用户都判断不了这一步到底做完了没有（DEF-201/239 的同源问题）。
   */
  actionResults?: Array<{
    requestId: string
    /**
     * 这条工单现在的真实结果：
     * - `executed`：执行方已经做完（例如草稿已建好），但还没有平台回执；
     * - `verified`：平台已回执可核验（发布记录里出现了真实作品号）；
     * - `failed`：执行方明确失败（例如发布没成功）。**动作卡上的 `requested` 不变**——
     *   这里记的是"这一步最后怎么了"，不是把申请改成执行。
     */
    state: 'executed' | 'verified' | 'failed'
    /** 执行后拿到的真实 id（草稿 id / 发布记录 id）；拿不到时为空串。 */
    realId: string
    note: string
    at: string
  }>
  createdAt: string
  updatedAt: string
}

/** 自动接待规则（对齐 reception.ts ReceptionRule）。 */
export interface ReceptionRule {
  id: string
  name: string
  /** 账号专属规则：仅在该账号命中；缺省为平台级通用规则。 */
  accountId?: string
  platforms: string[]
  keywords: string[]
  /** 关键词匹配方式：any 命中任一即触发；all 要求全部命中。 */
  matchMode?: 'any' | 'all'
  /** 排除词：命中任意一个时该规则立即跳过（黑名单语义）。 */
  excludeKeywords?: string[]
  /** 同一互动失败后重新登记的最小间隔（分钟）。 */
  cooldownMinutes?: number
  /**
   * 兜底规则：命中全部消息（关键词为空时不再视为不匹配）。
   * 用于 7×24 自动接待的 AI 兜底——没有它，未命中关键词的消息既无模板也无 AI 回复。
   */
  matchAll?: boolean
  replyMode: 'ai' | 'template'
  template?: string
  aiModel?: string
  systemPrompt?: string
  enabled: boolean
  priority: number
  createdAt: string
  updatedAt: string
}

/** 7×24 接待引擎的账号级真实轮询状态（前台监控页数据源，全部来自平台真实结果）。 */
export interface ReceptionAccountStatus {
  accountId: string
  platform: string
  nickname?: string
  status: 'scanned' | 'risk' | 'no-login' | 'unsupported' | 'error'
  message?: string
  commentsFound?: number
  commentsReplied?: number
  commentsPending?: number
  commentsFailed?: number
  dmsFound?: number
  dmsReplied?: number
  dmsPending?: number
  dmsFailed?: number
  at: number
}

/** 接待引擎总体状态（由轮询引擎真实回写，禁止前端伪造运行中）。 */
export interface ReceptionStatus {
  enabled: boolean
  running: boolean
  lastPollAt: string | null
  rounds: number
  accounts: ReceptionAccountStatus[]
  nextPollAt: string | null
  config: {
    intervalMinutes: number
    /** 兼容旧字段：保持为每账号每轮最多新登记待办数。 */
    maxRepliesPerRound: number
    /** 同一互动在窗口内不重复登记（分钟）。 */
    seenWindowMinutes?: number
    /** 失败后重新登记的最小间隔（分钟）。 */
    cooldownMinutes?: number
    /** 每账号每轮最多新登记待办数。 */
    maxPendingPerRound?: number
  }
}

/** 平台互动待办：引擎只做只读采集并登记，发送必须由前端用户点击触发。 */
export interface ReceptionPendingItem {
  id: string
  kind: 'comment' | 'dm'
  platform: string
  accountId: string
  workId?: string
  workTitle?: string
  commentKey?: string
  commentText?: string
  username?: string
  sessionId?: string
  peerName?: string
  matched: boolean
  ruleName?: string
  reply?: string
  at: string
  /** 待办生命周期：pending 等待处理；processing 已由前端占用；succeeded/failed/skipped 记录处理结果。 */
  status?: 'pending' | 'processing' | 'succeeded' | 'failed' | 'skipped'
  handledAt?: string
  error?: string
  sentText?: string
}

/**
 * 只读分享链接：`token` 是对外凭证，`expiresAt` 为毫秒时间戳。
 * 落盘 `share-tokens.json`，重启后未过期的链接仍然可用，过期即失效。
 */
export interface ShareLinkRecord {
  token: string
  taskId: string
  expiresAt: number
  createdAt: string
}

/**
 * AI/规则实际回复记录：把「哪个客户说了什么 → AI 回了什么 → 平台结果」沉淀为可回溯历史。
 *
 * 主键 `id`；客户维度按 `customerKey` 聚合（评论 = 评论者，私信 = 会话），
 * 落盘文件 `reception-replies.json`，由 `reception-replies.ts` 写入与核对。
 */
export interface ReceptionReplyRecord {
  id: string
  /** 对应的平台互动任务 id；核对成功/失败时读取该任务的 state.json。 */
  taskId?: string
  at: string
  finishedAt?: string
  platform: string
  accountId: string
  accountNickname?: string
  kind: 'comment' | 'dm'
  /** 客户唯一键：评论为 `comment:<评论者>`，私信为 `dm:<会话 id 或昵称>`。 */
  customerKey: string
  customerName: string
  /** 客户原文（评论内容 / 私信最后一条）。 */
  sourceText: string
  workId?: string
  workTitle?: string
  /** AI 或规则实际发出的回复内容。 */
  replyText: string
  source?: 'ai' | 'rule' | 'manual'
  ruleName?: string
  /** sending 表示已发起、结果待平台任务回写；不接受前端上报的成功状态。 */
  status: 'sending' | 'succeeded' | 'failed'
  error?: string
  /** 从平台读回的原对话快照（私信整段会话 / 评论线程），供「查看原对话」离线回看。 */
  conversation?: ReceptionConversationSnapshot
}

/** 平台原对话快照：内容全部来自平台页面/接口，读不到时不留快照并如实报错。 */
export interface ReceptionConversationSnapshot {
  at: string
  source: 'platform'
  kind: 'comment' | 'dm'
  messages: {
    from: 'me' | 'customer' | 'unknown'
    text: string
    time?: string
  }[]
  /** 评论线程：平台侧该评论的回复数（读到才填）。 */
  replyCount?: number
  note?: string
}

/** AI 草稿生成任务（对齐 DraftGenerationTask 子集）。 */
export interface ZyDraftGenerationTask {
  id: string
  status: 'generating' | 'success' | 'partial' | 'failed'
  points: number
  errorMessage?: string
  /**
   * 效果提示（不是失败）：例如"只传了 1 张参考图，画面会被锁死"。
   *
   * 与 {@link errorMessage} 分开的理由：errorMessage 一有值，界面就按"出错/未完成"呈现；
   * 而这类提示说的是"这么做效果会打折"，成片本身是好的、状态仍是 success。
   */
  notice?: string
  request?: {
    groupId?: string
    kind?: 'video' | 'image-text'
    prompt?: string
    duration?: number
    resolution?: string
    aspectRatio?: string
    quantity?: number
    /** 视频/对话模型名（视频路径 model、图文路径 imageModel 各自独立留痕）。 */
    model?: string
    imageModel?: string
    /** 用户填写的文案要求（含目标平台标题/正文/话题上限），生成时作为最高优先级约束。 */
    captionPrompt?: string
    /** 画面风格；图片/视频生成以提示词约束落地。 */
    style?: string
    imageCount?: number
    imageSize?: string
    imageUrls?: string[]
    videoUrls?: string[]
    audioUrls?: string[]
    platforms?: string[]
    draftType?: string
    /**
     * 内容形式：`vlog`（走动 VLOG）/ `scene-seeding`（场景种草）/ `scene`（场景呈现）/ …。
     *
     * 缺省 `scene`。要 VLOG 必须显式给，否则编排层会排成"口播 + 产品特写"。
     */
    form?: string
    /** 出镜类形式需要的数字人形象 id。 */
    humanRef?: string
  }
  response?: ({
    title?: string
    description?: string
    topics?: string[]
    imageTexts?: { title: string; content: string }[]
      imageUrls?: string[]
      videoUrl?: string
      coverUrl?: string
      generatedImageCount?: number
      /** 媒体来源：ai=真实图片/视频模型生成；local-template=本地模板占位（如实标注）。 */
      generatedBy?: 'ai' | 'local-template'
      generatedModel?: string
      /**
       * 分段生成时长片时，内部那条分段任务的 id（>12 秒的档位才有）。
       *
       * 界面用它查实时进度（写稿 / 排分镜 / 逐镜生成 N/M），否则用户对着"生成中"三个字
       * 不知道跑到哪一步——一条 1 分钟片要 20~60 分钟。
       */
      longVideoTaskId?: string
      /**
       * 这条片子所有镜头共用的采样种子。
       *
       * 复现同一版画面、跨镜保持人物一致都靠它；不带 seed 重跑会重新抽一个。
       */
      seed?: number
      /**
       * 服务端在生成过程中给出的**前置提醒**，例如"只上传了 1 张参考图，厂商会把画面锁死
       * 在这张图上、提示词里的场景不会生效"。
       *
       * 生成是异步的，函数返回值到不了用户眼前，只有落进这里、轮询时带回去，界面才显示得出。
       */
      warning?: string
      /**
       * **效果提示**（不影响状态）：例如"只上传了 1 张参考图，画面会被锁死在这张图上"。
       *
       * 与 {@link warning} 的分工：warning 表示**降级产出**（厂商没出 AI 视频、用静止画面顶替），
       * 记录状态跟着降成 partial；notice 只是"这么做效果会打折"的提醒，成片是正常的、状态仍是 success。
       * 两者此前共用 warning，实测一条正常出片的 5 秒档因此显示成"未完成"。
       */
      notice?: string
  } | undefined)
  createdAt: string
  updatedAt: string
}

/**
 * 固定 AI 数字人形象（带货 IP）。
 *
 * 「固定」是这条产品线的全部意义：形象素材与念法一次选定、长期复用，
 * 每次生成都拿同一份素材 + 同一个种子去出片，成片里才是同一个人、同一种声音。
 */
export interface ZyDigitalHuman {
  id: string
  name: string
  /** 形象图素材 URL（`/bosom-friend/api/assets/file/...`）：上传的照片本身，或从视频里抽出的首帧。 */
  avatarUrl: string
  /**
   * 视频建的才有的参考视频素材 URL：从上传的视频裁出的 2~12 秒片段。
   *
   * 它走厂商的**参考视频**通道（video-to-video）：动作、说话方式与声音从这段真实素材延续，
   * 而 {@link avatarUrl} 那张首帧锚定"长什么样"。照片建的数字人没有这个字段。
   */
  sourceVideoUrl?: string
  /**
   * 多角度参考图（正面 / 侧面 / 背面）。
   *
   * 为什么必须一起交出去：厂商按参考图**数量**切模式——1 张走 keyframe，把画面锁死在这一帧上
   * （提示词里的场景、光线、构图全部不生效）；≥3 张才走 reference，只锁"是谁"、场景自由。
   * 只传 {@link avatarUrl} 一张时，"同一个人 + 画面按提示词生成"这个预期就落空了。
   */
  images?: string[]
  /**
   * 念法 id（见 `digital-human.ts` 的 `DIGITAL_HUMAN_PERSONAS`）：写进厂商提示词的声音人设。
   *
   * 声音由厂商在出片时自己念，厂商侧没有"音色 id"这种概念——念法因此只是一段描述。
   * 可选：老数据没有这个字段，读取侧按它当初选的音色与演绎风格折算（见 `personaPrompt`）。
   */
  persona?: string
  /**
   * 老数据的音色 id（Edge TTS 的 ShortName）：**只读**，新数据不再写它。
   *
   * 留着是为了不让既有用户的形象失声：没有 {@link persona} 时按它折算成一条念法。
   */
  voice?: string
  /** 老数据的演绎风格 id：与 {@link voice} 同理，只在没有 {@link persona} 时参与折算。 */
  voiceStyle?: string
  /** 固定随机种子：同一张形象图 + 同一个种子，跨次生成的形象才稳定。 */
  seed: number
  createdAt: string
  updatedAt: string
}

/** 长视频成片的一段：文本 + 该段真实秒数 + 该段成片。 */
export interface ZyLongVideoSegment {
  index: number
  text: string
  /** 该段真实时长（配音秒数或厂商返回时长），拼接与字幕都以此为准。 */
  audioSeconds: number
  videoUrl?: string
}

/**
 * 镜头类型：决定这一镜"画面里是什么"，与"谁来生成"是两件事。
 *
 * - `talking-head`：有人出镜口播（数字人）；
 * - `product`：产品本身的特写/细节/使用演示（画面主体是产品，不是人）；
 * - `scene`：环境与氛围空镜；
 * - `text-card`：纯文字卡（价格、优惠、行动号召），不需要厂商生成画面。
 *
 * 带货片之所以像"拍过的"，靠的是**这几种镜头交替**，而不是一个人从头讲到尾。
 */
export type ZyShotKind = 'talking-head' | 'product' | 'scene' | 'text-card'

/** 参考图在这一次生成里扮演什么角色（厂商按数量与顺序解释图片，自己先记住语义）。 */
export type ZyShotRefRole = 'person' | 'product' | 'style'

/** 一张参考图：本机素材 URL + 它的角色。 */
export interface ZyShotRef {
  url: string
  role: ZyShotRefRole
}

/**
 * 一个镜头：通用工作流的最小编排单位。
 *
 * 与内容形式无关——数字人口播、产品特写、场景空镜都落在这一个结构上，
 * 生成方（provider）只是它的一个字段。分镜表因此可以逐镜编辑、逐镜重做，
 * 而不需要为每种业务各写一套编排。
 */
export interface ZyShot {
  index: number
  kind: ZyShotKind
  /** 这一镜的目标时长（秒）；口播镜以配音真实时长为准，非口播镜按文案体量给。 */
  seconds: number
  /** 口播文本；非口播镜为空串。 */
  line: string
  /** 画面提示词：非口播镜必填，口播镜留空（用形象图即可）。 */
  visual: string
  /**
   * 连续性约束：光线/背景/景别/服装等全片统一的描述。
   * 每镜都带上它，跨镜才不会"每段自己长一套"。
   */
  continuity: string
  /** 这一镜要用的参考图集（人物/产品/风格）；缺省为空表示纯文生视频。 */
  references: ZyShotRef[]
  /** 生成方标识（与任务级 producer 同口径；P2 起支持逐镜覆盖）。 */
  provider: string
  /** 结构/情绪标记：钩子、痛点、卖点、行动号召——用来映射语气与镜头节奏。 */
  beat?: 'hook' | 'pain' | 'product' | 'cta'
  /**
   * 这一镜的状态，对齐 Agnes 官方 create-video 规范的 production record 状态机。
   *
   * 官方口径是**生成成功不等于可以用**：产出先标 `generated-uninspected`，
   * 只有看过画面（probe + 抽帧/联系表）并确认它符合这一镜的目的与硬约束之后，才标 `accepted`；
   * 明显不合格的标 `rejected`，被外部条件卡住的标 `blocked`。
   *
   * 早先只有 planned / ready / failed，`ready` 把"生成回来了"直接等同于"可以用"，
   * 于是"动作与台词对不上""人脸变形"这类只有人眼能发现的问题会一路带进成片。
   * `ready` / `failed` 保留用于读取历史记录（新写入一律用官方五态）。
   */
  status: 'planned' | 'generated-uninspected' | 'accepted' | 'rejected' | 'blocked' | 'ready' | 'failed'
  /** 这一镜的**目的**（官方要求：一个镜头只服务一个目的，写在生产记录里）。 */
  purpose?: string
  /**
   * 与**前一镜**的关系（官方对相邻镜的三分类，决定要不要锁连续性）：
   * continuous 连续动作 / scene 顺序场景 / montage 独立蒙太奇。
   */
  relationship?: 'continuous' | 'scene' | 'montage'
  /** 这一镜采用的生成策略（官方要求记录：文生视频 / 图生视频 / 关键帧起手）。 */
  strategy?: string
  /** 验收证据（官方要求：接受或拒绝都要留下看了什么）。 */
  evidence?: string
  /** 这一镜生成失败的可读原因（逐镜可见，不必整条重跑）。 */
  errorMessage?: string
}

/**
 * 长视频生成任务：任何业务只要成品超过厂商单次上限（4~12 秒）都落这张表。
 *
 * `producer` 是片段生成器标识（数字人口播 / 场景呈现 / …）。同一张表、同一套编排，
 * 换业务只换 producer，不为每种业务各建一张任务表。
 */
export interface ZyLongVideoTask {
  id: string
  /** 片段生成器标识。 */
  producer: string
  /** 生成器自己的引用（如数字人 id）；编排层不解释它的含义。 */
  producerRef?: string
  /**
   * 可选的产品参考图（本机素材 URL）。
   *
   * 专业用户传了它，产品镜就以真实产品为主体；业余用户不传，产品镜退化为纯描述。
   * 两种都能出片——这正是"不逼用户做选择"的落点。
   */
  productImageUrl?: string
  /** 用户输入的产品/卖点要求，稿件由它生成。 */
  topic: string
  /** 目标成片时长（秒）。实际时长由逐段真实秒数决定。 */
  targetSeconds: number
  /** 目标画布，各段统一到这个尺寸后拼接。 */
  resolution: string
  aspectRatio: string
  /** 是否把口播文本烧成画面字幕；缺省烧。 */
  withSubtitles?: boolean
  status: 'generating' | 'success' | 'failed'
  /** 已完成段数 / 总段数，前端据此显示真实进度。 */
  doneSegments: number
  totalSegments: number
  segments: ZyLongVideoSegment[]
  /**
   * 分镜表：这条成片的镜头序列（口播镜与产品镜交替）。
   *
   * 落盘而不是留在内存里，是两个能力的共同前提：**逐镜重做**（某一镜不满意只重跑那一镜）
   * 与**画面一致性**（每镜带同一套参考图与连续性约束）。缺省为空时按旧的"文案切段"路径跑。
   */
  shots?: ZyShot[]
  /**
   * 每一镜对应的成片文件（镜号 → 本地绝对路径）。
   *
   * 逐镜重做会替换其中一镜，重新拼接必须按**镜头顺序**取文件——不能再依赖"生成顺序恰好等于镜头顺序"
   * 这种巧合（重做之后就不成立了）。
   */
  shotFiles?: Record<string, string>
  /** 用于生成这条成片的稿件正文（长度校准后的最终稿）。 */
  scriptText?: string
  /**
   * 成片登记进内容库后那条草稿的 id（"出片 → 发布"的交接件）。
   *
   * 由登记方回写、由进度查询与发布申请消费：有了它，下游不必凭标题去草稿箱里翻。
   * 登记失败时为空——成片仍在盘上，只是还没进内容库，此时如实说"还没有"而不是编一个 id。
   */
  materialId?: string
  /**
   * 稿件字数（**不含标点**）：用户能看出"这条片讲了多少内容"。
   *
   * 去标点是硬要求：字数门槛与音色语速共用这一把尺子，含标点的字数会让门槛被算低约 15%
   * （实测 90 秒档放行 396 字含标点 / 337 字去标点的稿子，成片只有 77.97 秒，见 DEF-113）。
   */
  scriptChars?: number
  /**
   * 降档后的有效时长（秒，DEF-229）：稿件比目标时长差一点点（≤5%）时不再判死整条，
   * 而是按"这版稿子实际能讲多久"继续出片，这个值就是那个时长。
   *
   * 与 {@link ZyLongVideoTask.targetSeconds} 的关系要说清：目标时长是用户选的档位，
   * 有效时长是**这条片实际按哪一档跑的**。缺省（未降档）表示就按目标档跑，界面据此
   * 如实写"按这版稿子成片约 N 秒"，而不是假装还是原来那个档位。
   */
  effectiveSeconds?: number
  /**
   * 母时钟量到的成片时长（秒）：全片配音第一次合成完的真实合计。
   *
   * 它与 {@link ZyLongVideoTask.targetSeconds} 的差距在**任何厂商画面调用之前**就已确定——
   * 界面据此如实告诉用户"按这版稿子成片约 N 秒"，而不是等跑完 18 镜再让用户发现短了 13 秒。
   */
  voicedSeconds?: number
  /**
   * 成片**实测**时长（秒）：拼接完成后用 ffprobe 读成片文件得到的事实。
   *
   * 与 {@link voicedSeconds} 的分工必须说清：那个是母时钟按稿件字数**估算**的（用于在花钱之前
   * 告诉用户大概多长），这个是**量出来的**。实测第六轮估算 62 秒、成片 67.2 秒——
   * 界面要展示时长时用这个，展示"预计多长"时才用那个，两者不能混。
   */
  actualSeconds?: number
  /** 成片素材 URL（全部段落拼接完成后才有）。 */
  videoUrl?: string
  errorMessage?: string
  /**
   * 已经自动从断点续跑过几轮。
   *
   * 单镜撞厂商限流时不再直接判死整条任务，而是等一会儿自动续跑；这个计数是防无限循环的闸门。
   */
  autoResumeRounds?: number
  /**
   * 失败原因的分类码：界面据此把"去补卖点"变成可执行的一步（显示还差多少字、给补写按钮），
   * 而不是只把一句中文原因摆在那里让用户自己猜。
   *
   * - `script-too-short`：稿件字数不足（与目标时长差 5% 以上才走到这里，小差距会自动降档）；
   * - `script-rewrite-failed`：自动补写连续多轮全部失败（写稿模型不可用），稿件根本没被补过；
   * - `script-duplicated`：稿件靠重复段落凑字数，按"不得重复"重写一次后仍然重复；
   * - `script-narrated`：模型把自己的说明写进了正文（那些字会被当台词念出来）。
   */
  errorCode?: string
  createdAt: string
  updatedAt: string
}

/**
 * 起任务前的预估：镜数、厂商调用次数与耗时区间。
 *
 * 三个值都是**量级**而不是承诺：厂商排队慢时耗时只会更长，
 * 所以界面文案写"约"，真实进度以逐镜回报的段数为准。
 */
export interface LongVideoEstimate {
  /** 预计镜数（短时长多片段口径：目标时长 ÷ 5 秒，向上取整）。 */
  shots: number
  /** 厂商生成调用次数下限。 */
  callsMin: number
  /** 厂商生成调用次数上限。 */
  callsMax: number
  /** 预计耗时下限（分钟）。 */
  minutesMin: number
  /** 预计耗时上限（分钟）。 */
  minutesMax: number
  /** 这条片要多少字的口播稿（**不含标点**，按所选音色的实测语速折算）。 */
  requiredChars: number
  /** 折算用的语速（字/秒，去标点口径）。 */
  charsPerSecond: number
  /** 写稿模型的字数口径（产品默认 4.5 字/秒，去标点口径）。 */
  writerPaceCharsPerSecond: number
}

/** 本地账号（用户名+密码，scrypt 加盐哈希，多账号并存）。 */
export interface ZyAccountUser {
  id: string
  _id: string
  username: string
  name: string
  mail: string
  phone: string
  passwordHash: string
  salt: string
  status: number
  avatar: string
  score: number
  income: number
  createdAt: string
  updateTime: string
}

/** 登录会话（token 持久化，重启后登录态不失效）。 */
export interface ZySession {
  token: string
  userId: string
  createdAt: string
  lastSeenAt: string
}
