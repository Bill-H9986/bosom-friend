/**
 * Bosom Friend后端共享类型。字段名严格对齐Bosom Friend前端的 TS 接口（bosom-friend-web/src），
 * 保证 `{code, data, message}` 信封内的 data 满足前端类型而无需改造前端。
 * @module @deepseek-ai/dsh-bosom-friend-server/types
 */

/** 消息通知记录（对齐前端 store/notifications 的 NotificationItem）。 */
export interface NotificationRecord {
  id: string
  type: 'announcement' | 'changelog'
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
  source?: string
  errorMsg?: string
  publishedAt?: string
  createdAt?: string
  updatedAt?: string
  linkStatus?: 'pending' | 'ready' | 'failed'
  /** 平台侧已不存在该作品（同步对账标记）；为 true 时数据中心不再统计该记录。 */
  removedOnPlatform?: boolean
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
  } | undefined)
  createdAt: string
  updatedAt: string
}

/**
 * 固定 AI 数字人形象（带货 IP）。
 *
 * 「固定」是这条产品线的全部意义：形象图与音色一次选定、长期复用，
 * 每次生成都拿同一张图 + 同一个种子去出片，成片里才是同一个人、同一个声音。
 */
export interface ZyDigitalHuman {
  id: string
  name: string
  /** 形象图素材 URL（`/bosom-friend/api/assets/file/...`）。 */
  avatarUrl: string
  /** 配音音色（Edge TTS 的 ShortName，如 `zh-CN-XiaoxiaoNeural`）。 */
  voice: string
  /** 固定随机种子：同一张图 + 同一个种子，跨次生成的形象才稳定。 */
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
  status: 'planned' | 'ready' | 'failed'
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
  /** 用于生成这条成片的稿件正文（长度校准后的最终稿）。 */
  scriptText?: string
  /** 稿件字数（含标点）：用户能看出"这条片讲了多少内容"。 */
  scriptChars?: number
  /** 成片素材 URL（全部段落拼接完成后才有）。 */
  videoUrl?: string
  errorMessage?: string
  createdAt: string
  updatedAt: string
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
