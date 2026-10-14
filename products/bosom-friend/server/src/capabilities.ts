/**
 * 能力注册表：Bosom Friend 服务端写操作 → 管家工具的**唯一登记处**。
 *
 * 登记对象是 `server/src/` 全部路由表里 **POST/PUT/PATCH/DELETE 语义**的 120 条路由
 * （源码实测：api.ts 54 / routes-content.ts 40 / routes-channels.ts 17 / routes-knowledge.ts 6 /
 * knowledge-distill.ts 2 / routes-skill-promotion.ts 1）。每条给出承接它的管家工具名：
 * 内核已有该工具时 `exists: true`，否则 `tool` 是**建议工具名**（下一批要补的内核工具）。
 *
 * `role` 判据（管家分工）：
 * - `creator`   创作管家：草稿、素材、生成、数字人、长视频、封面、提示词与选题；
 * - `publisher` 发布管家：平台账号与登录态、发布流程与任务、发布记录、发布前校验；
 * - `operator`  运营管家：作品数据、笔记与评论检索、导出、评论/私信接待；
 * - `device`    设备管家：远程访问、隧道、本机数据清理；
 * - `steward`   总管底座：对话任务、设置与大模型、个人资料、知识库与技能、登录鉴权。
 *
 * `kind` 判据：`write` 会改数据；`read` 虽用 POST 但只读（查询/检索/预览/校验）；
 * `reject` 是固定拒绝或已停用端点（不落任何数据）。把 read/reject 与 write 分开，
 * 是因为「写操作总数」这个口径过去把只读 POST 也算进去了。
 *
 * 覆盖率有两个口径，必须在同一处如实给出：
 * - **严格口径**（本表 `exists`）：这条路由的动作内核里**有没有工具能办成**；
 * - **既有粗口径**（历史一直引用的 42%）：内核工具数 ÷ 写路由数。它把 19 个只读工具
 *   （list/get/status/dashboard 之类）整个算进了分子，而其中 18 个不承接任何写路由，所以偏高。
 *
 * @module @deepseek-ai/dsh-bosom-friend-server/capabilities
 */

/** 管家角色：能力归哪个管家。 */
export type CapabilityRole = 'creator' | 'publisher' | 'operator' | 'device' | 'steward'

/** 路由语义：write 落数据 / read 只读 / reject 固定拒绝。 */
export type CapabilityKind = 'write' | 'read' | 'reject'

/** 一个入参的登记：模型按它传，门禁按它真跑（只读类能力必须逐条核过才登记）。 */
export interface CapabilityParam {
  /** 服务端 handler 读的字段名（body 里的键）。 */
  name: string
  /** 字段类型。 */
  type: 'string' | 'number' | 'boolean' | 'object'
  /** 必填：缺了服务端会拒绝或办不成（据此给模型强约束）。 */
  required: boolean
  /** 给模型看的说明。 */
  description: string
  /** 只读验证用的示例值：门禁拿它真跑一次（空串 = 走服务端默认/空值分支）。 */
  sample: string | number | boolean
  /** 该字段是路由模板里的 `:name` 占位符（服务端从 body 同名字段填进 URL）。 */
  inPath?: boolean
}

/** 一条能力的登记项。 */
export interface Capability {
  /** 能力标识，形如 `content.createDraft`（与 `tool` 一一对应）。 */
  id: string
  /** 承接该能力的工具名；`exists: false` 时是建议名。 */
  tool: string
  /** 归属管家。 */
  role: CapabilityRole
  /** 给模型看的描述，必须含「必须调用本工具，不要自己直接做」。 */
  description: string
  /** 内核里是否**已经**有这个工具（判定依据：`tool` 出现在 {@link KERNEL_TOOLS} 中）。 */
  exists: boolean
  /** 服务端出处：`METHOD 路由模板`。 */
  route: string
  /** 出处文件与行号（`server/src` 内相对路径）。 */
  source: string
  /** 路由语义。 */
  kind: CapabilityKind
  /** 是否建议补成内核工具；false = 固定拒绝、安全动作或系统内部协议，不建议给模型。 */
  toolizable: boolean
  /** 补充说明：缺失原因、与已有工具的分工、删除类/发布类的额外约束。 */
  note?: string
  /** 入参登记：已逐条核过服务端 handler 的字段名与必填；缺省 = 尚未核过（门禁只验注册）。 */
  params?: CapabilityParam[]
}

/** 内核已有工具（来自 `kernel/src/index.ts` 的 `name: 'bosom_...'` 定义，实测 52 个）。 */
export interface KernelTool {
  /** 工具名。 */
  name: string
  /** 写工具会改数据；只读工具不承接任何写路由。 */
  kind: 'write' | 'read'
}

/** 单个角色的覆盖情况。 */
export interface RoleCoverage {
  /** 该角色的能力条数。 */
  total: number
  /** 其中有工具承接的条数。 */
  existing: number
}

/** 注册表统计结果。 */
export interface CapabilitySummary {
  /** 写路由总条数。 */
  total: number
  /** 已工具化条数（`exists: true`）。 */
  existing: number
  /** 严格覆盖率 = existing / total。 */
  coverage: number
  /** 待补工具条数（`toolizable && !exists`）。 */
  toolizableMissing: number
  /** 不适合工具化的条数（固定拒绝 / 安全动作 / 系统内部协议）。 */
  notToolizable: number
  /** 内核工具总数。 */
  kernelTools: number
  /** 内核写工具数。 */
  kernelWriteTools: number
  /** 内核只读工具数（不承接任何写路由）。 */
  kernelReadTools: number
  /** 既有粗口径 = 内核工具总数 / 写路由总数（历史引用的 42% 就是它）。 */
  legacyToolCoverage: number
  /** 真正会改数据的路由条数（kind === 'write'）。 */
  writeKindTotal: number
  /** 其中已工具化的条数。 */
  writeKindExisting: number
  /** 写语义路由覆盖率 = writeKindExisting / writeKindTotal。 */
  writeKindCoverage: number
  /** 按角色统计。 */
  byRole: Record<CapabilityRole, RoleCoverage>
  /** 下一批要补的工具名（去重、升序）。 */
  missingTools: string[]
  /** 不适合工具化的能力 id（原因见登记项的 note）。 */
  notToolizableIds: string[]
  /** 没有独占写路由的内核工具：18 个只读工具 + 2 个共用/GET 发起的写工具。 */
  idleKernelTools: string[]
}

/** 描述里必须出现的固定句：模型不得绕过工具自己动手。 */
const REQUIRED_PHRASE = '必须调用本工具，不要自己直接做'

/** 内核已有工具清单（`kernel/src/index.ts` 实测 52 个）。 */
export const KERNEL_TOOLS: readonly KernelTool[] = [
  { name: 'bosom_kernel_ping', kind: 'read' },
  { name: 'bosom_platform_list_accounts', kind: 'read' },
  { name: 'bosom_reception_list_pending', kind: 'read' },
  { name: 'bosom_material_list', kind: 'read' },
  { name: 'bosom_data_dashboard', kind: 'read' },
  { name: 'bosom_platform_login_status', kind: 'read' },
  { name: 'bosom_platform_sync_works', kind: 'read' },
  { name: 'bosom_content_list_drafts', kind: 'read' },
  { name: 'bosom_content_generate_script', kind: 'read' },
  { name: 'bosom_job_list', kind: 'read' },
  { name: 'bosom_publish_content', kind: 'write' },
  { name: 'bosom_content_update_draft', kind: 'write' },
  { name: 'bosom_content_create_video', kind: 'write' },
  { name: 'bosom_content_create_short_media', kind: 'write' },
  { name: 'bosom_content_video_status', kind: 'read' },
  { name: 'bosom_content_resume_video', kind: 'write' },
  { name: 'bosom_learn_from_history', kind: 'write' },
  { name: 'bosom_knowledge_list_experiences', kind: 'read' },
  { name: 'bosom_knowledge_promote_skill', kind: 'write' },
  { name: 'bosom_content_create_draft', kind: 'write' },
  { name: 'bosom_content_enhance_prompt', kind: 'write' },
  { name: 'bosom_content_enhance_topic', kind: 'write' },
  { name: 'bosom_content_split_fourview', kind: 'write' },
  { name: 'bosom_content_make_cover', kind: 'write' },
  { name: 'bosom_material_import_video', kind: 'write' },
  { name: 'bosom_digital_human_list', kind: 'read' },
  { name: 'bosom_long_video_redo_shot', kind: 'write' },
  { name: 'bosom_long_video_extend_script', kind: 'write' },
  { name: 'bosom_long_video_stop', kind: 'write' },
  { name: 'bosom_digital_human_create', kind: 'write' },
  { name: 'bosom_settings_get_llm', kind: 'read' },
  { name: 'bosom_settings_set_llm', kind: 'write' },
  { name: 'bosom_settings_set_pref', kind: 'write' },
  { name: 'bosom_user_update_profile', kind: 'write' },
  { name: 'bosom_task_rate', kind: 'write' },
  { name: 'bosom_task_favorite', kind: 'write' },
  { name: 'bosom_task_share', kind: 'write' },
  { name: 'bosom_task_create', kind: 'write' },
  { name: 'bosom_task_follow_up', kind: 'write' },
  { name: 'bosom_task_abort', kind: 'write' },
  { name: 'bosom_publish_list_records', kind: 'read' },
  { name: 'bosom_steward_dispatch', kind: 'write' },
  { name: 'bosom_long_video_list', kind: 'read' },
  { name: 'bosom_publish_draft', kind: 'write' },
  { name: 'bosom_reception_reply', kind: 'write' },
  { name: 'bosom_reception_poll_now', kind: 'write' },
  { name: 'bosom_data_works', kind: 'read' },
  { name: 'bosom_content_get_draft', kind: 'read' },
  { name: 'bosom_content_generation_status', kind: 'read' },
  { name: 'bosom_content_delete_generation', kind: 'write' },
  { name: 'bosom_platform_sync_now', kind: 'write' },
  { name: 'bosom_platform_login_start', kind: 'write' },
]

/**
 * 一组易混工具的选择指引：模型挑工具前照它纠偏。
 * 这些指引是**成对**的——只说「我用在哪」不够，必须同时说「别用我、该用谁」，
 * 否则模型仍会挑名字最像的那个（2026-10-12 端到端实测：问「最近有哪些生成记录」，
 * 模型调了长视频任务工具，还拿 gen-* 编了个回答——工具返回里根本没有 gen-*）。
 */
export interface ToolSelectionGuide {
  /** 这一组在纠什么（主题词，便于检索）。 */
  topic: string
  /** 必须用某工具的情形：工具名 → 一句判据。 */
  useWhen: Record<string, string>
  /** 不要用某工具的情形：工具名 → 该换用谁、为什么。 */
  avoidWhen: Record<string, string>
}

/**
 * 易混工具的选择指引（**唯一事实源**）。
 *
 * 消费方式：工具注册时按工具名把对应指引拼进 description。生成式工具由生成器拼（登记表 → 投影）；
 * 手写工具在 kernel/src/index.ts 的 defineTool description 里拼。本文件只登记，不做拼接——
 * 登记表是事实源，拼接是实现侧的事。
 */
export const TOOL_SELECTION_GUIDE: readonly ToolSelectionGuide[] = [
  {
    topic: '生成记录 vs 长视频任务',
    useWhen: {
      bosom_content_generation_status: '用户问「生成记录 / 生成任务 / 那条图文或短片跑完了没」时用它（任务号形如 gen-*）。',
      bosom_content_video_status: '用户问「长视频跑到第几镜了」时用它（任务号形如 lv-*，分段出片那条链路）。',
    },
    avoidWhen: {
      bosom_content_generation_status: '长视频（lv-*）不要用它，换 bosom_content_video_status。',
      bosom_content_video_status: 'gen-* 生成记录不要用它——它的返回里没有 gen-*，也不许据此编造记录。',
    },
  },
  {
    topic: '发布记录 vs 平台回执',
    useWhen: {
      bosom_publish_list_records: '用户问「这条发出去了没 / 平台作品 ID / 什么时候发的」时用它（本地发布记录）。',
      bosom_platform_sync_works: '用户问「本地记着哪些已发布作品」时用它（只读本地，不连平台）。',
    },
    avoidWhen: {
      bosom_publish_list_records: '用户要「现在去平台拉最新数据」不要用它，换 bosom_platform_sync_now。',
      bosom_platform_sync_works: '要平台真实回执不要用它，它只读本地记录。',
    },
  },
  {
    topic: '草稿 vs 素材',
    useWhen: {
      bosom_content_list_drafts: '用户问「草稿箱里有什么」时用它。',
      bosom_content_get_draft: '用户问某一条草稿的完整内容时用它。',
      bosom_material_list: '用户问「素材库有哪些图 / 视频」时用它。',
    },
    avoidWhen: {
      bosom_content_list_drafts: '素材不要用它——草稿是 content，素材是 asset，两个库不通用。',
      bosom_material_list: '草稿不要用它——它列的是素材库，不含草稿。',
    },
  },
  {
    topic: '待接待 vs 已处理互动',
    useWhen: {
      bosom_reception_list_pending: '用户问「有哪些待回复的评论 / 私信」时用它（待办清单）。',
      bosom_reception_list_interactions: '用户问「历史互动 / 已经回过哪些」时用它（会真去平台拉一次）。',
    },
    avoidWhen: {
      bosom_reception_list_pending: '翻历史记录不要用它，它只列待处理。',
      bosom_reception_list_interactions: '待办清单不要用它，换 bosom_reception_list_pending——它不会告诉你哪些还没回。',
    },
  },
  {
    topic: '数据中心概况 vs 作品数据',
    useWhen: {
      bosom_data_dashboard: '用户问「整体有多少账号 / 素材 / 待接待」时用它（概况）。',
      bosom_data_works: '用户问「每条作品的播放 / 点赞 / 评论」时用它（明细）。',
    },
    avoidWhen: {
      bosom_data_dashboard: '要看单条作品表现不要用它，它只给总数。',
      bosom_data_works: '只要总数概况不要用它，它给的是逐条明细。',
    },
  },
  {
    topic: '后台长任务 vs 长视频任务',
    useWhen: {
      bosom_job_list: '用户问「登录 / 发布 / 同步这些后台任务跑到哪了」时用它。',
      bosom_long_video_list: '用户问「长视频任务进度」时用它。',
    },
    avoidWhen: {
      bosom_job_list: '长视频进度不要用它，换 bosom_long_video_list。',
      bosom_long_video_list: '其它后台任务不要用它，换 bosom_job_list。',
    },
  },
  {
    topic: '真去平台同步 vs 只读本地记录',
    useWhen: {
      bosom_platform_sync_now: '用户说「同步最新数据」时用它（真连平台，约 1-2 分钟）。',
      bosom_platform_sync_works: '只想看本地已有记录、不惊动平台时用它。',
    },
    avoidWhen: {
      bosom_platform_sync_now: '只是查看、不该惊动平台时不要用它。',
      bosom_platform_sync_works: '用户明确要最新数据时不要用它——它不连平台，答不了「现在」。',
    },
  },
  {
    topic: '一次调用出片 / 图文 vs 长视频分段出片',
    useWhen: {
      bosom_content_create_short_media: '用户要一条短视频或一组图文（单次厂商调用，免费档也能跑通）时用它。',
      bosom_content_create_video: '用户要长视频、分段出片时用它。',
    },
    avoidWhen: {
      bosom_content_create_short_media: '长片不要用它，它会退化成一条短片。',
      bosom_content_create_video: '单条短片 / 图文不要用它——长片链路更慢、更贵。',
    },
  },
]

/**
 * 能力登记表（120 条写路由，逐条来自 `server/src` 的路由表）。
 * `exists` 与 {@link KERNEL_TOOLS} 的一致性由 {@link verifyRegistry} 守着。
 */
export const CAPABILITIES: readonly Capability[] = [
  {
    id: 'steward.loginMail', tool: 'bosom_steward_login_mail', role: 'steward', kind: 'reject',
    exists: false, toolizable: false, route: 'POST login/mail', source: 'api.ts:2554',
    description: '邮箱验证码登录（本产品固定拒绝，不落任何数据）。必须调用本工具，不要自己直接做。',
    note: '固定拒绝端点：handler 直接回错误，不产生数据；不建议补工具。',
  },
  {
    id: 'steward.loginPhone', tool: 'bosom_steward_login_phone', role: 'steward', kind: 'reject',
    exists: false, toolizable: false, route: 'POST login/phone', source: 'api.ts:2555',
    description: '手机验证码登录（本产品固定拒绝，不落任何数据）。必须调用本工具，不要自己直接做。',
    note: '固定拒绝端点；不建议补工具。',
  },
  {
    id: 'steward.loginMailVerify', tool: 'bosom_steward_login_mail_verify', role: 'steward', kind: 'reject',
    exists: false, toolizable: false, route: 'POST login/mail/verify', source: 'api.ts:2556',
    description: '邮箱验证码校验（本产品固定拒绝）。必须调用本工具，不要自己直接做。',
    note: '固定拒绝端点；不建议补工具。',
  },
  {
    id: 'steward.loginPhoneVerify', tool: 'bosom_steward_login_phone_verify', role: 'steward', kind: 'reject',
    exists: false, toolizable: false, route: 'POST login/phone/verify', source: 'api.ts:2557',
    description: '手机验证码校验（本产品固定拒绝）。必须调用本工具，不要自己直接做。',
    note: '固定拒绝端点；不建议补工具。',
  },
  {
    id: 'steward.loginGoogle', tool: 'bosom_steward_login_google', role: 'steward', kind: 'reject',
    exists: false, toolizable: false, route: 'POST login/google', source: 'api.ts:2558',
    description: 'Google 第三方登录（本产品固定拒绝）。必须调用本工具，不要自己直接做。',
    note: '固定拒绝端点；不建议补工具。',
  },
  {
    id: 'steward.register', tool: 'bosom_steward_register', role: 'steward', kind: 'write',
    exists: false, toolizable: false, route: 'POST auth/register', source: 'api.ts:2560',
    description: '注册产品账号（登录页动作）。必须调用本工具，不要自己直接做。',
    note: '登录页专属动作，管家运行在已登录会话内；安全动作不建议给模型。',
  },
  {
    id: 'steward.login', tool: 'bosom_steward_login', role: 'steward', kind: 'write',
    exists: false, toolizable: false, route: 'POST auth/login', source: 'api.ts:2596',
    description: '用账号密码登录产品（登录页动作）。必须调用本工具，不要自己直接做。',
    note: '登录页专属动作；安全动作不建议给模型。',
  },
  {
    id: 'steward.logout', tool: 'bosom_steward_logout', role: 'steward', kind: 'write',
    exists: false, toolizable: false, route: 'POST auth/logout', source: 'api.ts:2612',
    description: '退出登录并清掉会话。必须调用本工具，不要自己直接做。',
    note: '安全动作，建议由用户本人在界面上操作。',
  },
  {
    id: 'steward.changePassword', tool: 'bosom_steward_change_password', role: 'steward', kind: 'write',
    exists: false, toolizable: false, route: 'PUT auth/password', source: 'api.ts:2623',
    description: '修改登录密码。必须调用本工具，不要自己直接做。',
    note: '安全动作，建议由用户本人在界面上操作。',
  },
  {
    id: 'steward.updateProfile', tool: 'bosom_user_update_profile', role: 'steward', kind: 'write',
    exists: true, toolizable: true, route: 'PUT user/info/update', source: 'api.ts:2667',
    description: '改用户的个人资料（昵称与头像）。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'steward.createTask', tool: 'bosom_task_create', role: 'steward', kind: 'write',
    exists: true, toolizable: true, route: 'POST agent/tasks', source: 'api.ts:2696',
    description: '替用户开一条新任务并后台执行。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'steward.cleanupRunningTasks', tool: 'bosom_task_cleanup_running', role: 'steward', kind: 'write',
    exists: false, toolizable: true, route: 'POST agent/tasks/cleanup-running', source: 'api.ts:3432',
    params: [],
    description: '清理卡在进行中的僵尸任务。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'steward.followUpTask', tool: 'bosom_task_follow_up', role: 'steward', kind: 'write',
    exists: true, toolizable: true, route: 'POST agent/tasks/:taskId/messages', source: 'api.ts:3461',
    description: '在同一条任务里补一句话接着办。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'steward.updateTask', tool: 'bosom_task_update', role: 'steward', kind: 'write',
    exists: false, toolizable: true, route: 'PATCH agent/tasks/:taskId', source: 'api.ts:3527',
    params: [{ name: 'taskId', type: 'string', required: true, description: '任务号（路由变量）', sample: "task-verify", inPath: true }, { name: 'title', type: 'string', required: false, description: '新标题；空串不改', sample: "" }],
    description: '改一条任务的属性（标题、角色等）。必须调用本工具，不要自己直接做。',
    note: '另一条线（task-5 管家转交）正在加改判任务角色的接口，补工具前先对齐。',
  },
  {
    id: 'steward.clearTasks', tool: 'bosom_task_clear', role: 'steward', kind: 'write',
    exists: false, toolizable: true, route: 'DELETE agent/tasks', source: 'api.ts:3568',
    params: [{ name: 'taskIds', type: 'string', required: false, description: '要清空的任务号，逗号分隔；空串=清全部', sample: "" }],
    description: '清空任务列表。必须调用本工具，不要自己直接做。',
    note: '删除类动作：只接受用户明确指令。',
  },
  {
    id: 'steward.dispatch', tool: 'bosom_steward_dispatch', role: 'steward', kind: 'write',
    exists: true, toolizable: true, route: 'POST agent/tasks/:taskId/dispatch', source: 'api.ts:3540',
    description: '把一件事转交给专业管家去办（改判这条任务的归属管家并接着发起）。必须调用本工具，不要自己直接做。',
    note: 'task-5（管家转交）新增的服务端入口；内核已有手写工具 bosom_steward_dispatch（kernel/src/index.ts:2754）。',
  },
  {
    id: 'steward.deleteTask', tool: 'bosom_task_delete', role: 'steward', kind: 'write',
    exists: false, toolizable: true, route: 'DELETE agent/tasks/:taskId', source: 'api.ts:3584',
    params: [{ name: 'taskId', type: 'string', required: true, description: '任务号（路由变量）', sample: "task-verify", inPath: true }],
    description: '删掉一条任务记录。必须调用本工具，不要自己直接做。',
    note: '删除类动作：只接受用户明确指令；与 bosom_task_abort（只中断不删）分工不同。',
  },
  {
    id: 'steward.rateTask', tool: 'bosom_task_rate', role: 'steward', kind: 'write',
    exists: true, toolizable: true, route: 'POST agent/tasks/:taskId/rating', source: 'api.ts:3606',
    description: '给一条任务打分并附评语。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'steward.abortTask', tool: 'bosom_task_abort', role: 'steward', kind: 'write',
    exists: true, toolizable: true, route: 'POST agent/tasks/:taskId/abort', source: 'api.ts:3621',
    description: '中断一条正在办的任务（保留任务记录）。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'steward.reportActionResult', tool: 'bosom_task_report_action_result', role: 'steward', kind: 'write',
    exists: false, toolizable: false, route: 'POST agent/tasks/:taskId/action-result', source: 'api.ts:3649',
    description: '上报任务内动作的执行结果。必须调用本工具，不要自己直接做。',
    note: '内核与前端执行器之间的协议回调，不是用户动作；不建议补工具。',
  },
  {
    id: 'steward.shareTask', tool: 'bosom_task_share', role: 'steward', kind: 'write',
    exists: true, toolizable: true, route: 'POST agent/tasks/:taskId/share', source: 'api.ts:3677',
    description: '把一条任务生成对外只读分享链接。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'steward.favoriteTask', tool: 'bosom_task_favorite', role: 'steward', kind: 'write',
    exists: true, toolizable: true, route: 'POST agent/tasks/:taskId/favorite', source: 'api.ts:3687',
    description: '收藏一条任务。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'steward.unfavoriteTask', tool: 'bosom_task_favorite', role: 'steward', kind: 'write',
    exists: true, toolizable: true, route: 'DELETE agent/tasks/:taskId/favorite', source: 'api.ts:3700',
    description: '取消收藏一条任务。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'steward.setLlm', tool: 'bosom_settings_set_llm', role: 'steward', kind: 'write',
    exists: true, toolizable: true, route: 'PUT ai/user-llm', source: 'api.ts:3803',
    description: '改当前生效的大模型服务配置。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'steward.fetchModels', tool: 'bosom_settings_fetch_models', role: 'steward', kind: 'read',
    exists: false, toolizable: true, route: 'POST ai/models/fetch', source: 'api.ts:4015',
    params: [
      { name: 'baseUrl', type: 'string', required: false, description: '模型服务地址；空则用已保存配置', sample: '' },
      { name: 'apiKey', type: 'string', required: false, description: '密钥；空则用已保存配置', sample: '' },
    ],
    description: '从厂商拉取可用模型清单。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'creator.makeCover', tool: 'bosom_content_make_cover', role: 'creator', kind: 'write',
    exists: true, toolizable: true, route: 'POST ai/note-cover', source: 'api.ts:4062',
    description: '给草稿生成品牌封面卡并挂到草稿上。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'creator.reportLog', tool: 'bosom_steward_report_log', role: 'creator', kind: 'write',
    exists: false, toolizable: false, route: 'POST ai/logs', source: 'api.ts:4092',
    description: '上报前端运行日志。必须调用本工具，不要自己直接做。',
    note: '前端埋点通道，不是用户动作；不建议补工具。',
  },
  {
    id: 'creator.runObjectAction', tool: 'bosom_content_run_object_action', role: 'creator', kind: 'write',
    exists: false, toolizable: true, route: 'POST ai/object-action', source: 'api.ts:4160',
    params: [{ name: 'kind', type: 'string', required: true, description: '对象类型（draft / material 等）', sample: "draft" }, { name: 'id', type: 'string', required: true, description: '对象 id', sample: "dft-1" }, { name: 'action', type: 'string', required: true, description: '动作名（见 ai/object-actions 清单）', sample: "rewrite" }, { name: 'extra', type: 'string', required: false, description: '动作附加参数', sample: "" }],
    description: '对界面上的对象跑一次 AI 动作（按草稿改写等）。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'steward.chat', tool: 'bosom_steward_chat', role: 'steward', kind: 'write',
    exists: false, toolizable: false, route: 'POST ai/chat', source: 'api.ts:4184',
    description: '用户与管家对话的入口本身。必须调用本工具，不要自己直接做。',
    note: '对话入口不是管家要调的工具（管家就在这条链路上）；不建议补工具。',
  },
  {
    id: 'steward.setPref', tool: 'bosom_settings_set_pref', role: 'steward', kind: 'write',
    exists: true, toolizable: true, route: 'PUT v2/prefs/disclaimer', source: 'api.ts:4274',
    description: '写用户偏好与协议状态（免责声明同意等）。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'creator.generateShortMedia', tool: 'bosom_content_create_short_media', role: 'creator', kind: 'write',
    exists: true, toolizable: true, route: 'POST ai/draft-generation/v2', source: 'api.ts:4287',
    description: '一次厂商调用生成短视频（完成后进草稿箱）。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'creator.generateImageText', tool: 'bosom_content_create_short_media', role: 'creator', kind: 'write',
    exists: true, toolizable: true, route: 'POST ai/draft-generation/image-text', source: 'api.ts:4292',
    description: '一次厂商调用生成图文（完成后进草稿箱）。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'creator.importFromVideoUrl', tool: 'bosom_material_import_video', role: 'creator', kind: 'write',
    exists: true, toolizable: true, route: 'POST ai/draft-generation/from-video-url', source: 'api.ts:4419',
    description: '把一个视频链接存进素材库。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'creator.queryGeneration', tool: 'bosom_content_generation_status', role: 'creator', kind: 'read',
    exists: true, toolizable: true, route: 'POST ai/draft-generation/query', source: 'api.ts:4452',
    description: '查草稿生成任务（gen-*）的进度与结果。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'creator.deleteGenerations', tool: 'bosom_content_delete_generation', role: 'creator', kind: 'write',
    exists: true, toolizable: true, route: 'DELETE ai/draft-generation', source: 'api.ts:4505',
    description: '批量删除草稿生成记录。必须调用本工具，不要自己直接做。',
    note: '批量形式；现有工具按单条删，需要批量时先确认删除范围。',
  },
  {
    id: 'creator.deleteGeneration', tool: 'bosom_content_delete_generation', role: 'creator', kind: 'write',
    exists: true, toolizable: true, route: 'DELETE ai/draft-generation/:id', source: 'api.ts:4520',
    description: '删除一条草稿生成记录。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'device.cleanupData', tool: 'bosom_device_cleanup_data', role: 'device', kind: 'write',
    exists: false, toolizable: true, route: 'POST v2/data/cleanup', source: 'api.ts:6102',
    params: [{ name: 'scopes', type: 'string', required: false, description: '要清理的范围，逗号分隔', sample: "" }, { name: 'all', type: 'boolean', required: false, description: 'true = 清全部可清范围', sample: false }],
    description: '清空本机记录（保留账号、模型配置与权限）。必须调用本工具，不要自己直接做。',
    note: '删除类动作：只接受用户明确指令，并先说明会清掉哪些范围。',
  },
  {
    id: 'creator.createDigitalHuman', tool: 'bosom_digital_human_create', role: 'creator', kind: 'write',
    exists: true, toolizable: true, route: 'POST digital-humans', source: 'api.ts:7306',
    description: '用一张本机素材新建数字人形象。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'creator.importDigitalHumanSheet', tool: 'bosom_digital_human_import_sheet', role: 'creator', kind: 'write',
    exists: false, toolizable: true, route: 'POST digital-humans/from-sheet', source: 'api.ts:7351',
    params: [{ name: 'name', type: 'string', required: true, description: '形象名', sample: "验收形象" }, { name: 'imageUrl', type: 'string', required: true, description: '参考图地址或素材 id', sample: "assets/demo.png" }, { name: 'images', type: 'string', required: false, description: '多张参考图，逗号分隔', sample: "" }],
    description: '从表格批量导入数字人形象。必须调用本工具，不要自己直接做。',
    note: '（批量建形象会写库）必须用户明确指令才能调用。',
  },
  {
    id: 'creator.deleteDigitalHuman', tool: 'bosom_digital_human_delete', role: 'creator', kind: 'write',
    exists: false, toolizable: true, route: 'DELETE digital-humans/:id', source: 'api.ts:7431',
    params: [{ name: 'id', type: 'string', required: true, description: '形象 id（路由变量）', sample: "dh-verify", inPath: true }],
    description: '删除一个数字人形象。必须调用本工具，不要自己直接做。',
    note: '删除类动作：只接受用户明确指令。',
  },
  {
    id: 'creator.splitFourView', tool: 'bosom_content_split_fourview', role: 'creator', kind: 'write',
    exists: true, toolizable: true, route: 'POST ai/reference/fourview', source: 'api.ts:7525',
    description: '把人物四视图切成四张独立图片。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'creator.enhancePrompt', tool: 'bosom_content_enhance_prompt', role: 'creator', kind: 'write',
    exists: true, toolizable: true, route: 'POST ai/prompt/enhance', source: 'api.ts:7568',
    description: '把大白话整理成可喂模型的画面描述。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'creator.enhanceTopic', tool: 'bosom_content_enhance_topic', role: 'creator', kind: 'write',
    exists: true, toolizable: true, route: 'POST long-videos/enhance-topic', source: 'api.ts:7589',
    description: '把粗糙选题挖深成创作要求。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'creator.createLongVideo', tool: 'bosom_content_create_video', role: 'creator', kind: 'write',
    exists: true, toolizable: true, route: 'POST long-videos', source: 'api.ts:7643',
    description: '把写好的脚本做成视频（分段出片）。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'creator.deleteLongVideo', tool: 'bosom_long_video_delete', role: 'creator', kind: 'write',
    exists: false, toolizable: true, route: 'DELETE long-videos/:taskId', source: 'api.ts:7707',
    params: [{ name: 'taskId', type: 'string', required: true, description: '长视频任务号（路由变量）', sample: "lv-verify", inPath: true }],
    description: '删除一条长视频任务。必须调用本工具，不要自己直接做。',
    note: '删除类动作：只接受用户明确指令。',
  },
  {
    id: 'creator.clearLongVideos', tool: 'bosom_long_video_clear', role: 'creator', kind: 'write',
    exists: false, toolizable: true, route: 'DELETE long-videos', source: 'api.ts:7734',
    params: [],
    description: '清空长视频任务列表。必须调用本工具，不要自己直接做。',
    note: '删除类动作：只接受用户明确指令。',
  },
  {
    id: 'creator.redoShot', tool: 'bosom_long_video_redo_shot', role: 'creator', kind: 'write',
    exists: true, toolizable: true, route: 'POST long-videos/:taskId/shots/:index/redo', source: 'api.ts:7768',
    description: '重做长视频里的某一镜。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'creator.extendScript', tool: 'bosom_long_video_extend_script', role: 'creator', kind: 'write',
    exists: true, toolizable: true, route: 'POST long-videos/:taskId/extend-script', source: 'api.ts:7790',
    description: '把长视频稿件再补写一轮。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'creator.resumeLongVideo', tool: 'bosom_content_resume_video', role: 'creator', kind: 'write',
    exists: true, toolizable: true, route: 'POST long-videos/:taskId/resume', source: 'api.ts:7818',
    description: '长视频从断点继续（只补没跑成的镜）。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'creator.stopLongVideo', tool: 'bosom_long_video_stop', role: 'creator', kind: 'write',
    exists: true, toolizable: true, route: 'POST long-videos/:taskId/stop', source: 'api.ts:7856',
    description: '停下一条正在生成的长视频。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'steward.backfillDistill', tool: 'bosom_learn_from_history', role: 'steward', kind: 'write',
    exists: true, toolizable: true, route: 'POST knowledge/distill/backfill', source: 'api.ts:7881',
    description: '把历史成功经验提炼成可复用技能。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'device.setRemoteAccess', tool: 'bosom_device_set_remote_access', role: 'device', kind: 'write',
    exists: false, toolizable: true, route: 'POST remote-access', source: 'api.ts:8462',
    params: [{ name: 'enabled', type: 'boolean', required: false, description: '是否开启远程访问', sample: false }, { name: 'bindAll', type: 'boolean', required: false, description: '是否监听所有网卡', sample: false }, { name: 'tunnelCommand', type: 'string', required: false, description: '隧道命令；空串不改', sample: "" }, { name: 'rotateToken', type: 'boolean', required: false, description: '是否换新访问令牌', sample: false }],
    description: '改远程访问配置（开关、端口、令牌）。必须调用本工具，不要自己直接做。',
    note: '涉及对外通道：改动前必须向用户说明影响面。',
  },
  {
    id: 'device.startTunnel', tool: 'bosom_device_start_tunnel', role: 'device', kind: 'write',
    exists: false, toolizable: true, route: 'POST remote-access/tunnel/start', source: 'api.ts:8478',
    params: [],
    description: '开启对外隧道（把本机服务暴露出去）。必须调用本工具，不要自己直接做。',
    note: '对外通道属高风险动作：必须用户明确指令。',
  },
  {
    id: 'device.stopTunnel', tool: 'bosom_device_stop_tunnel', role: 'device', kind: 'write',
    exists: false, toolizable: true, route: 'POST remote-access/tunnel/stop', source: 'api.ts:8489',
    params: [],
    description: '关闭对外隧道。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'steward.rateExperience', tool: 'bosom_knowledge_rate_experience', role: 'steward', kind: 'write',
    exists: false, toolizable: true, route: 'POST knowledge/distill/rate', source: 'knowledge-distill.ts:590',
    params: [
      { name: 'id', type: 'string', required: false, description: '经验 id；空串不落库、只回 ok:false', sample: '' },
      { name: 'rating', type: 'number', required: false, description: '评分 1~5；id 为空时不生效', sample: 0 },
    ],
    description: '给一条经验打分（决定它够不够格变成技能）。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'steward.previewKnowledgeInjection', tool: 'bosom_knowledge_inject_preview', role: 'steward', kind: 'read',
    exists: false, toolizable: true, route: 'POST knowledge/inject-preview', source: 'knowledge-distill.ts:600',
    params: [{ name: 'query', type: 'string', required: false, description: '要预览的检索词；空串返回空上下文', sample: '验收' }],
    description: '预览这次任务会注入哪些知识。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'publisher.registerAccountByBrowser', tool: 'bosom_platform_register_account', role: 'publisher', kind: 'write',
    exists: false, toolizable: true, route: 'POST v2/channels/accounts/browser-register', source: 'routes-channels.ts:155',
    params: [{ name: 'type', type: 'string', required: false, description: '平台标识（xhs / douyin）', sample: "xhs" }, { name: 'uid', type: 'string', required: false, description: '平台账号 uid（建议必给，空账号不可用）', sample: "" }, { name: 'nickname', type: 'string', required: false, description: '昵称', sample: "" }, { name: 'avatar', type: 'string', required: false, description: '头像地址', sample: "" }, { name: 'loginCookie', type: 'string', required: false, description: '登录态 Cookie', sample: "" }, { name: 'groupId', type: 'string', required: false, description: '所属分组 id', sample: "" }],
    description: '把浏览器里已登录的账号登记进来。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'publisher.createAccount', tool: 'bosom_platform_create_account', role: 'publisher', kind: 'write',
    exists: false, toolizable: true, route: 'POST v2/channels/accounts', source: 'routes-channels.ts:241',
    params: [{ name: 'type', type: 'string', required: false, description: '平台标识（xhs / douyin）', sample: "xhs" }, { name: 'uid', type: 'string', required: false, description: '平台账号 uid（建议必给，空账号不可用）', sample: "" }, { name: 'nickname', type: 'string', required: false, description: '昵称', sample: "" }, { name: 'avatar', type: 'string', required: false, description: '头像地址', sample: "" }, { name: 'loginCookie', type: 'string', required: false, description: '登录态 Cookie', sample: "" }, { name: 'groupId', type: 'string', required: false, description: '所属分组 id', sample: "" }],
    description: '新增一个平台账号记录。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'publisher.refreshAccountAnalytics', tool: 'bosom_platform_refresh_account_analytics', role: 'publisher', kind: 'write',
    exists: false, toolizable: true, route: 'POST v2/channels/accounts/:id/analytics/refresh', source: 'routes-channels.ts:305',
    params: [{ name: 'id', type: 'string', required: true, description: '账号 id（路由变量）', sample: "acc-verify", inPath: true }, { name: 'confirm', type: 'boolean', required: false, description: 'true = 确认真的去平台拉一次', sample: false }],
    description: '刷新某个账号的粉丝与作品统计。必须调用本工具，不要自己直接做。',
    note: '（真去平台拉数据（对外动作））必须用户明确指令才能调用。',
  },
  {
    id: 'publisher.unbindAccount', tool: 'bosom_platform_unbind_account', role: 'publisher', kind: 'write',
    exists: false, toolizable: true, route: 'DELETE v2/channels/accounts/:id', source: 'routes-channels.ts:326',
    params: [{ name: 'id', type: 'string', required: true, description: '账号 id（路由变量）', sample: "acc-verify", inPath: true }],
    description: '解绑（删除）一个平台账号。必须调用本工具，不要自己直接做。',
    note: '删除类动作：只接受用户明确指令，并先说明会一并失去哪些数据。',
  },
  {
    id: 'publisher.logoutAccount', tool: 'bosom_platform_logout_account', role: 'publisher', kind: 'write',
    exists: false, toolizable: true, route: 'POST v2/channels/accounts/:id/logout', source: 'routes-channels.ts:360',
    params: [{ name: 'id', type: 'string', required: true, description: '账号 id（路由变量）', sample: "acc-verify", inPath: true }],
    description: '退出某个平台账号的登录态。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'publisher.syncAccount', tool: 'bosom_platform_sync_now', role: 'publisher', kind: 'write',
    exists: true, toolizable: true, route: 'POST v2/channels/accounts/:id/sync', source: 'routes-channels.ts:387',
    description: '去平台拉一次最新作品与数据。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'publisher.createAccountGroup', tool: 'bosom_platform_create_account_group', role: 'publisher', kind: 'write',
    exists: false, toolizable: true, route: 'POST v2/channels/account-groups', source: 'routes-channels.ts:422',
    params: [{ name: 'name', type: 'string', required: true, description: '分组名', sample: "验收分组" }, { name: 'rank', type: 'number', required: false, description: '排序值', sample: 0 }],
    description: '新建一个账号分组。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'publisher.updateAccountGroup', tool: 'bosom_platform_update_account_group', role: 'publisher', kind: 'write',
    exists: false, toolizable: true, route: 'PATCH v2/channels/account-groups/:id', source: 'routes-channels.ts:441',
    params: [{ name: 'id', type: 'string', required: true, description: '分组 id（路由变量）', sample: "grp-verify", inPath: true }, { name: 'name', type: 'string', required: false, description: '新分组名；空串不改', sample: "" }, { name: 'rank', type: 'number', required: false, description: '排序值', sample: 0 }],
    description: '改账号分组的名字或成员。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'publisher.deleteAccountGroup', tool: 'bosom_platform_delete_account_group', role: 'publisher', kind: 'write',
    exists: false, toolizable: true, route: 'DELETE v2/channels/account-groups', source: 'routes-channels.ts:456',
    params: [{ name: 'ids', type: 'string', required: true, description: '要删的分组 id，逗号分隔', sample: "grp-verify" }],
    description: '删除账号分组。必须调用本工具，不要自己直接做。',
    note: '删除类动作：只接受用户明确指令。',
  },
  {
    id: 'publisher.createPublishFlow', tool: 'bosom_publish_draft', role: 'publisher', kind: 'write',
    exists: true, toolizable: true, route: 'POST v2/channels/publish/flows', source: 'routes-channels.ts:498',
    description: '把草稿或素材发到指定平台账号（可立即发或定时发）。必须调用本工具，不要自己直接做。',
    note: '与 bosom_publish_content（素材发布）共用同一路由；没有用户明确发布指令不得调用。',
  },
  {
    id: 'publisher.deleteRecord', tool: 'bosom_publish_delete_record', role: 'publisher', kind: 'write',
    exists: false, toolizable: true, route: 'DELETE v2/channels/publish/records/:recordId', source: 'routes-channels.ts:657',
    params: [{ name: 'recordId', type: 'string', required: true, description: '发布记录 id（路由变量）', sample: "rec-verify", inPath: true }],
    description: '删除一条发布记录。必须调用本工具，不要自己直接做。',
    note: '删除类动作：只接受用户明确指令；删记录不等于删平台作品。',
  },
  {
    id: 'publisher.publishTaskNow', tool: 'bosom_publish_task_now', role: 'publisher', kind: 'write',
    exists: false, toolizable: true, route: 'POST v2/channels/publish/tasks/:taskId/publish-now', source: 'routes-channels.ts:700',
    params: [{ name: 'taskId', type: 'string', required: true, description: '发布任务号（路由变量）', sample: "pub-verify", inPath: true }, { name: 'accountId', type: 'string', required: false, description: '账号 id；空则用任务上原有的', sample: "" }],
    description: '把一条已排期的发布任务立刻发出去。必须调用本工具，不要自己直接做。',
    note: '发布动作：必须用户明确发布指令（硬约束 2），禁止自动触发。',
  },
  {
    id: 'publisher.abortCurrent', tool: 'bosom_publish_abort_current', role: 'publisher', kind: 'write',
    exists: false, toolizable: true, route: 'POST v2/channels/publish/abort-current', source: 'routes-channels.ts:713',
    params: [{ name: 'taskId', type: 'string', required: false, description: '要中止的发布任务号', sample: "" }, { name: 'accountId', type: 'string', required: false, description: '账号 id', sample: "" }],
    description: '中止当前正在跑的发布任务。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'publisher.retryTask', tool: 'bosom_publish_retry_task', role: 'publisher', kind: 'write',
    exists: false, toolizable: true, route: 'POST v2/channels/publish/tasks/:taskId/retry', source: 'routes-channels.ts:737',
    params: [{ name: 'taskId', type: 'string', required: true, description: '发布任务号（路由变量）', sample: "pub-verify", inPath: true }],
    description: '重试一条失败的发布任务。必须调用本工具，不要自己直接做。',
    note: '重试等于再发一次：必须用户明确指令（硬约束 2）。',
  },
  {
    id: 'publisher.rescheduleTask', tool: 'bosom_publish_reschedule', role: 'publisher', kind: 'write',
    exists: true, toolizable: true, route: 'PATCH v2/channels/publish/tasks/:taskId/publish-at', source: 'routes-channels.ts:749',
    params: [{ name: 'taskId', type: 'string', required: true, description: '发布任务号（路由变量）', sample: "pub-verify", inPath: true }, { name: 'publishAt', type: 'string', required: true, description: '新的排期时间（ISO 8601）', sample: "2026-10-13T10:00:00.000Z" }],
    description: '改一条发布任务的排期时间。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'publisher.deleteTask', tool: 'bosom_publish_delete_task', role: 'publisher', kind: 'write',
    exists: false, toolizable: true, route: 'DELETE v2/channels/publish/tasks/:taskId', source: 'routes-channels.ts:772',
    params: [{ name: 'taskId', type: 'string', required: true, description: '发布任务号（路由变量）', sample: "pub-verify", inPath: true }],
    description: '删除一条发布任务。必须调用本工具，不要自己直接做。',
    note: '删除类动作：只接受用户明确指令。',
  },
  {
    id: 'publisher.validateWork', tool: 'bosom_publish_validate_work', role: 'publisher', kind: 'reject',
    exists: false, toolizable: true, route: 'POST channel/work/validate', source: 'routes-channels.ts:815',
    params: [],
    description: '发布前校验作品参数（标题长度、图片数量等）。必须调用本工具，不要自己直接做。',
    note: '固定失败占位：handler 永远回 50100「尚未接入真实验证」，不是可办成的能力。',
  },
  {
    id: 'steward.createNote', tool: 'bosom_knowledge_create_note', role: 'steward', kind: 'write',
    exists: false, toolizable: true, route: 'POST knowledge/notes', source: 'routes-knowledge.ts:85',
    params: [{ name: 'name', type: 'string', required: true, description: '笔记名；空则服务端回 40000「笔记名称不能为空」', sample: "验收笔记" }, { name: 'folder', type: 'string', required: false, description: '子目录；空则放根', sample: "" }],
    description: '在知识库里新建一条笔记。必须调用本工具，不要自己直接做。',
    note: '（写用户知识库）必须用户明确指令才能调用。',
  },
  {
    id: 'steward.updateNote', tool: 'bosom_knowledge_update_note', role: 'steward', kind: 'write',
    exists: false, toolizable: true, route: 'PUT knowledge/notes/:path', source: 'routes-knowledge.ts:120',
    params: [{ name: 'path', type: 'string', required: true, description: '笔记路径（路由变量，可能含子目录，会整体编码）', sample: "验收笔记.md", inPath: true }, { name: 'content', type: 'string', required: false, description: '新正文（Markdown）；空串按服务端处理', sample: "" }],
    description: '改写知识库里的一条笔记。必须调用本工具，不要自己直接做。',
    note: '（覆盖用户笔记正文，不可逆）必须用户明确指令才能调用。',
  },
  {
    id: 'steward.deleteNote', tool: 'bosom_knowledge_delete_note', role: 'steward', kind: 'write',
    exists: false, toolizable: true, route: 'DELETE knowledge/notes/:path', source: 'routes-knowledge.ts:141',
    params: [{ name: 'path', type: 'string', required: true, description: '笔记路径（路由变量）', sample: "验收笔记.md", inPath: true }],
    description: '删除知识库里的一条笔记。必须调用本工具，不要自己直接做。',
    note: '删除类动作：只接受用户明确指令。',
  },
  {
    id: 'steward.searchNotes', tool: 'bosom_knowledge_search', role: 'steward', kind: 'read',
    exists: false, toolizable: true, route: 'POST knowledge/search', source: 'routes-knowledge.ts:161',
    params: [{ name: 'query', type: 'string', required: false, description: '检索词；空串直接返回 0 命中', sample: '验收' }],
    description: '在知识库里搜内容。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'steward.noteBacklinks', tool: 'bosom_knowledge_backlinks', role: 'steward', kind: 'read',
    exists: false, toolizable: true, route: 'POST knowledge/backlinks', source: 'routes-knowledge.ts:182',
    params: [{ name: 'path', type: 'string', required: false, description: '笔记路径或笔记名；空串按空名匹配', sample: '验收.md' }],
    description: '查一条笔记被哪些笔记引用。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'steward.chooseVault', tool: 'bosom_knowledge_choose_vault', role: 'steward', kind: 'read',
    exists: false, toolizable: true, route: 'POST knowledge/choose-vault', source: 'routes-knowledge.ts:197',
    params: [],
    description: '选一个知识库目录（Obsidian 库）。必须调用本工具，不要自己直接做。',
    note: '静态占位：返回内置库标识，不写任何配置。',
  },
  {
    id: 'steward.promoteSkill', tool: 'bosom_knowledge_promote_skill', role: 'steward', kind: 'write',
    exists: true, toolizable: true, route: 'POST knowledge/distill/promote', source: 'routes-skill-promotion.ts:85',
    description: '把一条被认可的经验升格成技能文件。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'creator.requestUploadSign', tool: 'bosom_material_request_upload_sign', role: 'creator', kind: 'write',
    exists: false, toolizable: true, route: 'POST assets/uploadSign', source: 'routes-content.ts:253',
    params: [{ name: 'filename', type: 'string', required: false, description: '原始文件名（决定素材扩展名）；空则叫 file', sample: "demo.png" }],
    description: '给上传素材申请一次直传签名。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'creator.requestPublicUploadSign', tool: 'bosom_material_request_public_upload_sign', role: 'creator', kind: 'write',
    exists: false, toolizable: true, route: 'POST assets/public/:publicUploadId/uploadSign', source: 'routes-content.ts:258',
    params: [{ name: 'publicUploadId', type: 'string', required: true, description: '公开上传会话 id（路由变量）', sample: "pu-verify", inPath: true }, { name: 'filename', type: 'string', required: false, description: '原始文件名；空则叫 file', sample: "demo.png" }],
    description: '给公开素材上传申请一次直传签名。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'creator.uploadAsset', tool: 'bosom_material_upload_asset', role: 'creator', kind: 'write',
    exists: false, toolizable: true, route: 'PUT assets/upload/:assetId', source: 'routes-content.ts:268',
    params: [{ name: 'assetId', type: 'string', required: true, description: '素材 id（路由变量）；二进制体由请求体直接承载', sample: "asset-verify", inPath: true }],
    description: '把素材二进制直传到本机素材库。必须调用本工具，不要自己直接做。',
    note: '（写入素材文件）必须用户明确指令才能调用。',
  },
  {
    id: 'creator.uploadPublicAsset', tool: 'bosom_material_upload_public_asset', role: 'creator', kind: 'write',
    exists: false, toolizable: true, route: 'PUT assets/public/:publicUploadId/upload/:assetId', source: 'routes-content.ts:277',
    params: [{ name: 'publicUploadId', type: 'string', required: true, description: '公开上传会话 id（路由变量）', sample: "pu-verify", inPath: true }, { name: 'assetId', type: 'string', required: true, description: '素材 id（路由变量）', sample: "asset-verify", inPath: true }],
    description: '把公开素材二进制直传进来。必须调用本工具，不要自己直接做。',
    note: '（写入素材文件）必须用户明确指令才能调用。',
  },
  {
    id: 'creator.confirmAsset', tool: 'bosom_material_confirm_asset', role: 'creator', kind: 'write',
    exists: false, toolizable: true, route: 'POST assets/:assetId/confirm', source: 'routes-content.ts:286',
    params: [{ name: 'assetId', type: 'string', required: true, description: '素材 id（路由变量）', sample: "asset-verify", inPath: true }],
    description: '确认素材上传完成并落库。必须调用本工具，不要自己直接做。',
    note: '（把素材登记进库）必须用户明确指令才能调用。',
  },
  {
    id: 'creator.confirmPublicAsset', tool: 'bosom_material_confirm_public_asset', role: 'creator', kind: 'write',
    exists: false, toolizable: true, route: 'POST assets/public/:publicUploadId/:assetId/confirm', source: 'routes-content.ts:295',
    params: [{ name: 'publicUploadId', type: 'string', required: true, description: '公开上传会话 id（路由变量）', sample: "pu-verify", inPath: true }, { name: 'assetId', type: 'string', required: true, description: '素材 id（路由变量）', sample: "asset-verify", inPath: true }],
    description: '确认公开素材上传完成并落库。必须调用本工具，不要自己直接做。',
    note: '（把素材登记进库）必须用户明确指令才能调用。',
  },
  {
    id: 'creator.createContentGroup', tool: 'bosom_content_create_group', role: 'creator', kind: 'write',
    exists: true, toolizable: true, route: 'POST contents/groups', source: 'routes-content.ts:415',
    params: [{ name: 'name', type: 'string', required: false, description: '分组名；空则服务端给「新素材组」', sample: "验收分组" }, { name: 'desc', type: 'string', required: false, description: '分组描述', sample: "" }],
    description: '新建一个内容分组。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'creator.deleteContentGroup', tool: 'bosom_content_delete_group', role: 'creator', kind: 'write',
    exists: true, toolizable: true, route: 'DELETE contents/groups/:id', source: 'routes-content.ts:449',
    params: [{ name: 'id', type: 'string', required: true, description: '分组 id（路由变量）', sample: "mg-verify", inPath: true }],
    description: '删除一个内容分组。必须调用本工具，不要自己直接做。',
    note: '删除类动作：只接受用户明确指令。',
  },
  {
    // 【2026-10-13 更正】这条路径有两个版本，**两条都要登记**（写路由总数必须与源码对账）：
    //   · POST（:471）**无条件改 updatedAt 并落盘**（body 为空也写）——是写能力，本行登记；
    //   · GET （:486）纯查且多回 mediaCount——是只读能力，由下一条 creator.contentGroupInfoRead 登记。
    // 手写工具 bosom_content_group_info 走的是 **GET**：用户问「这组里有什么」是只读问题，不该产生一次写。
    id: 'creator.contentGroupInfo', tool: 'bosom_content_group_info_write_via_post', role: 'creator', kind: 'write',
    exists: false, toolizable: false, route: 'POST contents/groups/info/:id', source: 'routes-content.ts:471',
    description: '（内部写路径：改分组名/刷 updatedAt，界面自己用）。必须调用本工具，不要自己直接做。',
    note: '界面内部写路径，不是用户动作；管家查分组走 GET 版（creator.contentGroupInfoRead），不建议这条补工具。',
  },
  {
    id: 'creator.contentGroupInfoRead', tool: 'bosom_content_group_info', role: 'creator', kind: 'read',
    exists: true, toolizable: true, route: 'GET contents/groups/info/:id', source: 'routes-content.ts:486',
    params: [{ name: 'id', type: 'string', required: true, description: '分组 id（路由变量）', sample: "mg-verify", inPath: true }, { name: 'name', type: 'string', required: false, description: '**传了就会改分组名并落盘**（不传则只读）', sample: "" }],
    description: '查一个内容分组的详情。必须调用本工具，不要自己直接做。',
    note: '真实行为是写库：分组存在时无条件改 updatedAt 并落盘（body 为空也写）；已加路径判据，无 order 时本地拒绝、零出站。',
  },
  {
    id: 'creator.createDraft', tool: 'bosom_content_create_draft', role: 'creator', kind: 'write',
    exists: true, toolizable: true, route: 'POST contents/drafts', source: 'routes-content.ts:520',
    description: '把写好的内容存进草稿箱。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'creator.deleteContents', tool: 'bosom_content_delete_many', role: 'creator', kind: 'write',
    exists: false, toolizable: true, route: 'DELETE contents', source: 'routes-content.ts:527',
    params: [{ name: 'ids', type: 'string', required: true, description: '要删的 id 列表（服务端收字符串数组）', sample: "dft-1" }, { name: 'kind', type: 'string', required: true, description: '**必填**：asset 或 draft（服务端不做隐式默认）', sample: "draft" }, { name: 'cascadeGenerations', type: 'boolean', required: false, description: 'kind=asset 时是否级联清理生成记录', sample: false }],
    description: '批量删除内容。必须调用本工具，不要自己直接做。',
    note: '删除类动作：只接受用户明确指令，并先确认删除范围。',
  },
  {
    id: 'creator.deleteDraftsByFilter', tool: 'bosom_content_delete_drafts_by_filter', role: 'creator', kind: 'write',
    exists: false, toolizable: true, route: 'DELETE contents/drafts/filter', source: 'routes-content.ts:549',
    params: [{ name: 'title', type: 'string', required: false, description: '按标题包含过滤（与 groupId 二选一，title 优先）', sample: "" }, { name: 'groupId', type: 'string', required: false, description: '按分组过滤', sample: "" }],
    description: '按条件批量删草稿。必须调用本工具，不要自己直接做。',
    note: '删除类动作：只接受用户明确指令，并先确认筛选条件命中多少条。',
  },
  {
    id: 'creator.transferContents', tool: 'bosom_content_transfer', role: 'creator', kind: 'write',
    exists: true, toolizable: true, route: 'POST contents/transfer', source: 'routes-content.ts:557',
    params: [{ name: 'kind', type: 'string', required: true, description: '**必填**：asset 或 draft（服务端不做隐式默认）', sample: "draft" }, { name: 'ids', type: 'string', required: true, description: '要转移的 id 列表', sample: "dft-1" }, { name: 'targetGroupId', type: 'string', required: false, description: '目标分组 id；空则放默认分组', sample: "" }],
    description: '把内容转移到别的分组。必须调用本工具，不要自己直接做。',
    note: '（批量改内容的归属分组）必须用户明确指令才能调用。',
  },
  {
    id: 'creator.deleteContent', tool: 'bosom_content_delete', role: 'creator', kind: 'write',
    exists: true, toolizable: true, route: 'DELETE contents/:id', source: 'routes-content.ts:569',
    params: [{ name: 'id', type: 'string', required: true, description: '草稿 id（路由变量）', sample: "dft-1", inPath: true }],
    description: '删除一条内容（草稿）。必须调用本工具，不要自己直接做。',
    note: '删除类动作：只接受用户明确指令；与 bosom_content_delete_generation（删生成记录）分工不同。',
  },
  {
    id: 'creator.updateDraft', tool: 'bosom_content_update_draft', role: 'creator', kind: 'write',
    exists: true, toolizable: true, route: 'PUT contents/:id', source: 'routes-content.ts:584',
    description: '改写一条草稿的标题或正文。必须调用本工具，不要自己直接做。',
    note: '现有工具是登记式：内核登记改写申请、落库由页面执行；描述与最终落库口径要对齐。',
  },
  {
    id: 'operator.searchDouyinTopic', tool: 'bosom_data_search_douyin_topic', role: 'operator', kind: 'read',
    exists: false, toolizable: true, route: 'POST statistics/channels/douyin/searchTopic', source: 'routes-content.ts:615',
    params: [],
    description: '按关键词搜抖音话题与热度。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'operator.commentSearchOptions', tool: 'bosom_data_comment_search_options', role: 'operator', kind: 'read',
    exists: false, toolizable: true, route: 'POST v2/statistics/note-comment-search/options', source: 'routes-content.ts:851',
    params: [],
    description: '取评论检索的可选项（平台、排序等）。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'operator.searchNotes', tool: 'bosom_data_search_notes', role: 'operator', kind: 'read',
    exists: false, toolizable: true, route: 'POST v2/statistics/note-comment-search/search', source: 'routes-content.ts:863',
    params: [
      { name: 'keyword', type: 'string', required: true, description: '搜索关键词；缺了服务端回 40000 业务错', sample: '护肤' },
      { name: 'page', type: 'number', required: false, description: '页码，默认 1', sample: 1 },
      { name: 'pageSize', type: 'number', required: false, description: '每页条数，默认 20', sample: 5 },
    ],
    description: '按关键词搜笔记。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'operator.collectNotes', tool: 'bosom_data_collect_notes', role: 'operator', kind: 'read',
    exists: false, toolizable: true, route: 'POST v2/statistics/note-comment-search/agent-collect', source: 'routes-content.ts:890',
    params: [{ name: 'keyword', type: 'string', required: false, description: '采集关键词；空串直接回空结论、不调外部服务', sample: '' }],
    description: '让管家采集一批笔记（会落库）。必须调用本工具，不要自己直接做。',
    note: '实现不落任何数据：空关键词短路直接返回，不写库。',
  },
  {
    id: 'operator.noteSimpleInfo', tool: 'bosom_data_note_simple_info', role: 'operator', kind: 'read',
    exists: false, toolizable: true, route: 'POST v2/statistics/note-comment-search/note-simple-info', source: 'routes-content.ts:913',
    params: [{ name: 'noteid', type: 'string', required: true, description: '笔记标识；缺了服务端回 40000 业务错', sample: 'demo' }],
    description: '读一条笔记的摘要信息。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'operator.analyseNote', tool: 'bosom_data_analyse_note', role: 'operator', kind: 'read',
    exists: false, toolizable: true, route: 'POST v2/statistics/note-comment-search/note-analyse', source: 'routes-content.ts:940',
    params: [],
    description: '分析一条笔记的内容与表现。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'operator.noteHotWords', tool: 'bosom_data_note_hot_words', role: 'operator', kind: 'read',
    exists: false, toolizable: true, route: 'POST v2/statistics/note-comment-search/note-hot-words', source: 'routes-content.ts:941',
    params: [],
    description: '提取一批笔记的热词。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'operator.commentStat', tool: 'bosom_data_comment_stat', role: 'operator', kind: 'read',
    exists: false, toolizable: true, route: 'POST v2/statistics/note-comment-search/comment-ment-stat', source: 'routes-content.ts:942',
    params: [],
    description: '统计评论量级与情绪分布。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'operator.noteComments', tool: 'bosom_data_note_comments', role: 'operator', kind: 'read',
    exists: false, toolizable: true, route: 'POST v2/statistics/note-comment-search/note-comments', source: 'routes-content.ts:944',
    params: [],
    description: '拉取一条笔记的评论列表。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'operator.parseXhsUrl', tool: 'bosom_data_parse_xhs_url', role: 'operator', kind: 'read',
    exists: false, toolizable: true, route: 'POST v2/statistics/note-comment-search/xhs-url', source: 'routes-content.ts:951',
    params: [{ name: 'noteId', type: 'string', required: false, description: '小红书笔记 id；空串只回域名前缀', sample: 'demo' }],
    description: '解析小红书链接拿到笔记信息。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'operator.exportNotes', tool: 'bosom_data_export_notes', role: 'operator', kind: 'read',
    exists: false, toolizable: true, route: 'POST v2/statistics/note-comment-search/export', source: 'routes-content.ts:957',
    params: [],
    description: '把检索结果导出成文件。必须调用本工具，不要自己直接做。',
    note: '静态占位：返回 available:false，不导出、不写盘。',
  },
  {
    id: 'publisher.completeDouyinAuth', tool: 'bosom_platform_complete_douyin_auth', role: 'publisher', kind: 'reject',
    exists: false, toolizable: true, route: 'POST plat/douyin/miniapp-auth/complete', source: 'routes-content.ts:1011',
    params: [],
    description: '完成抖音小程序授权（回填授权码）。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'steward.submitFeedback', tool: 'bosom_steward_submit_feedback', role: 'steward', kind: 'write',
    exists: false, toolizable: true, route: 'POST contact/feedback', source: 'routes-content.ts:1025',
    params: [],
    description: '提交一条用户反馈。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'operator.createReceptionRule', tool: 'bosom_reception_create_rule', role: 'operator', kind: 'write',
    exists: false, toolizable: true, route: 'POST v2/customer-reception/rules', source: 'routes-content.ts:1053',
    params: [{ name: 'name', type: 'string', required: false, description: '规则名；空则服务端叫「未命名规则」', sample: "验收规则" }, { name: 'accountId', type: 'string', required: false, description: '限定账号 id；空=全部账号', sample: "" }, { name: 'platforms', type: 'string', required: false, description: '限定平台（数组，xhs / douyin）', sample: "" }, { name: 'keywords', type: 'string', required: false, description: '命中关键词（数组）', sample: "" }, { name: 'matchMode', type: 'string', required: false, description: 'any（默认）或 all', sample: "any" }, { name: 'excludeKeywords', type: 'string', required: false, description: '排除关键词（数组）', sample: "" }, { name: 'cooldownMinutes', type: 'number', required: false, description: '同一对象冷却分钟数', sample: 0 }, { name: 'replyMode', type: 'string', required: false, description: 'ai 或 template（默认 template）', sample: "template" }, { name: 'template', type: 'string', required: false, description: '模板回复文案', sample: "" }, { name: 'enabled', type: 'boolean', required: false, description: '是否启用', sample: true }],
    description: '新建一条自动接待规则。必须调用本工具，不要自己直接做。',
    note: '（新增自动回复规则（对外行为））必须用户明确指令才能调用。',
  },
  {
    id: 'operator.updateReceptionRule', tool: 'bosom_reception_update_rule', role: 'operator', kind: 'write',
    exists: false, toolizable: true, route: 'PUT v2/customer-reception/rules/:ruleId', source: 'routes-content.ts:1082',
    params: [{ name: 'ruleId', type: 'string', required: true, description: '规则 id（路由变量）；找不到会回 40404', sample: "rule-verify", inPath: true }, { name: 'name', type: 'string', required: false, description: '新规则名', sample: "" }, { name: 'accountId', type: 'string', required: false, description: '限定账号；传空串=解除限定', sample: "" }, { name: 'platforms', type: 'string', required: false, description: '限定平台（数组）', sample: "" }, { name: 'keywords', type: 'string', required: false, description: '命中关键词（数组）', sample: "" }, { name: 'template', type: 'string', required: false, description: '模板回复文案', sample: "" }, { name: 'aiModel', type: 'string', required: false, description: 'AI 回复用的模型', sample: "" }, { name: 'systemPrompt', type: 'string', required: false, description: 'AI 回复的系统提示', sample: "" }],
    description: '改一条自动接待规则。必须调用本工具，不要自己直接做。',
    note: '（改自动回复规则（对外行为））必须用户明确指令才能调用。',
  },
  {
    id: 'operator.deleteReceptionRule', tool: 'bosom_reception_delete_rule', role: 'operator', kind: 'write',
    exists: false, toolizable: true, route: 'DELETE v2/customer-reception/rules/:ruleId', source: 'routes-content.ts:1108',
    params: [{ name: 'ruleId', type: 'string', required: true, description: '规则 id（路由变量）', sample: "rule-verify", inPath: true }],
    description: '删除一条自动接待规则。必须调用本工具，不要自己直接做。',
    note: '删除类动作：只接受用户明确指令。',
  },
  {
    id: 'operator.testReceptionRule', tool: 'bosom_reception_test_rule', role: 'operator', kind: 'read',
    exists: false, toolizable: true, route: 'POST v2/customer-reception/test', source: 'routes-content.ts:1117',
    params: [
      { name: 'message', type: 'string', required: false, description: '要试跑的一句话；空串匹配不到规则', sample: '这个多少钱？' },
      { name: 'platform', type: 'string', required: false, description: '限定平台（xhs / douyin）', sample: 'xhs' },
    ],
    description: '用一段样例内容试跑接待规则。必须调用本工具，不要自己直接做。',
  },
  {
    // 【2026-10-13 更正 kind】原标 write，实测服务端 handler（routes-content.ts:1129-1141）只调 matchReception
    // 生成建议、**不写日志、不发送**（源码注释原话），save 调用 0 次 —— 它是只读，混进写口径会把覆盖率分母抬高。
    id: 'operator.suggestReply', tool: 'bosom_reception_suggest_reply', role: 'operator', kind: 'read',
    exists: false, toolizable: true, route: 'POST v2/customer-reception/suggest', source: 'routes-content.ts:1129',
    params: [{ name: 'message', type: 'string', required: false, description: '要回复的评论或私信原文', sample: "这个多少钱？" }, { name: 'platform', type: 'string', required: false, description: '平台（xhs / douyin）', sample: "xhs" }, { name: 'accountId', type: 'string', required: false, description: '账号 id', sample: "" }],
    description: '给一条评论或私信生成回复建议。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'operator.listInteractions', tool: 'bosom_reception_list_interactions', role: 'operator', kind: 'write',
    exists: false, toolizable: true, route: 'POST v2/customer-reception/interactions/list', source: 'routes-content.ts:1218',
    params: [{ name: 'platform', type: 'string', required: true, description: '平台（xhs / douyin）；空则回 40000「缺少平台或账号」', sample: "xhs" }, { name: 'accountId', type: 'string', required: true, description: '账号 id；空则回 40000', sample: "acc-verify" }, { name: 'kind', type: 'string', required: false, description: 'comment（默认）或 dm', sample: "comment" }, { name: 'workId', type: 'string', required: false, description: '作品 id（评论场景）', sample: "" }, { name: 'workTitle', type: 'string', required: false, description: '作品标题', sample: "" }],
    description: '列出评论与私信互动记录（历史互动；会真去平台拉一次）。【什么时候必须用我】用户问「历史互动 / 已经回过哪些」时用它。【什么时候不要用我】待办清单不要用它——哪些还没回要用 bosom_reception_list_pending；它不会告诉你待处理。必须调用本工具，不要自己直接做。',
    note: '会发起真实平台读取任务（startPlatformInteraction），需要有效 accountId；不是零副作用。；（会发起真实平台读取任务）必须用户明确指令才能调用。',
  },
  {
    id: 'operator.replyInteraction', tool: 'bosom_reception_reply', role: 'operator', kind: 'write',
    exists: true, toolizable: true, route: 'POST v2/customer-reception/interactions/reply', source: 'routes-content.ts:1240',
    description: '回复平台上的评论或私信。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'operator.deleteReplies', tool: 'bosom_reception_delete_reply', role: 'operator', kind: 'write',
    exists: false, toolizable: true, route: 'DELETE v2/customer-reception/replies', source: 'routes-content.ts:1310',
    params: [],
    description: '删除已发出的回复记录。必须调用本工具，不要自己直接做。',
    note: '删除类动作：只接受用户明确指令；删本地记录不等于删平台回复。',
  },
  {
    id: 'operator.conversation', tool: 'bosom_reception_conversation', role: 'operator', kind: 'write',
    exists: false, toolizable: true, route: 'POST v2/customer-reception/conversation', source: 'routes-content.ts:1318',
    params: [{ name: 'platform', type: 'string', required: true, description: '平台（xhs / douyin）；空则回 40000「缺少平台或账号」', sample: "xhs" }, { name: 'accountId', type: 'string', required: true, description: '账号 id；空则回 40000', sample: "acc-verify" }, { name: 'kind', type: 'string', required: false, description: 'dm（默认）或 comment', sample: "dm" }, { name: 'sessionId', type: 'string', required: false, description: '私信会话 id', sample: "" }, { name: 'peerName', type: 'string', required: false, description: '对方昵称', sample: "" }, { name: 'workId', type: 'string', required: false, description: '作品 id（评论场景）', sample: "" }],
    description: '读一段接待会话的上下文。必须调用本工具，不要自己直接做。',
    note: '会发起真实平台读取任务（startPlatformInteraction），需要有效 accountId；不是零副作用。；（会发起真实平台读取任务）必须用户明确指令才能调用。',
  },
  {
    id: 'operator.setReceptionConfig', tool: 'bosom_reception_set_config', role: 'operator', kind: 'write',
    exists: false, toolizable: true, route: 'POST v2/customer-reception/config', source: 'routes-content.ts:1393',
    params: [{ name: 'intervalMinutes', type: 'number', required: false, description: '轮询间隔分钟', sample: 5 }, { name: 'seenWindowMinutes', type: 'number', required: false, description: '已读回看窗口分钟', sample: 60 }, { name: 'cooldownMinutes', type: 'number', required: false, description: '同一对象冷却分钟', sample: 30 }, { name: 'maxPendingPerRound', type: 'number', required: false, description: '每轮最多处理条数', sample: 10 }],
    description: '保存自动接待的总开关与配置。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'operator.setPendingStatus', tool: 'bosom_reception_set_pending_status', role: 'operator', kind: 'write',
    exists: false, toolizable: true, route: 'POST v2/customer-reception/pending/:pendingId/status', source: 'routes-content.ts:1414',
    params: [{ name: 'pendingId', type: 'string', required: true, description: '待办 id（路由变量）', sample: "pd-verify", inPath: true }, { name: 'status', type: 'string', required: true, description: '**必填**：processing / succeeded / failed / skipped', sample: "succeeded" }, { name: 'error', type: 'string', required: false, description: '失败原因（status=failed 时）', sample: "" }, { name: 'sentText', type: 'string', required: false, description: '实际发出的回复原文', sample: "" }],
    description: '改一条待接待事项的处理状态。必须调用本工具，不要自己直接做。',
  },
  {
    id: 'operator.pollNow', tool: 'bosom_reception_poll_now', role: 'operator', kind: 'write',
    exists: true, toolizable: true, route: 'POST v2/customer-reception/poll-now', source: 'routes-content.ts:1455',
    description: '立刻去平台拉一次最新评论与私信。必须调用本工具，不要自己直接做。',
  },
]

/**
 * 列出全部登记项。
 * @returns 登记项副本数组；调用方修改副本不影响登记表。
 */
export function listCapabilities(): Capability[] {
  return CAPABILITIES.map(item => ({ ...item }))
}

/**
 * 按管家角色列出登记项。
 * @param role - 管家角色。
 * @returns 该角色的登记项副本。
 */
export function capabilitiesOfRole(role: CapabilityRole): Capability[] {
  return listCapabilities().filter(item => item.role === role)
}

/** 求比值；分母为 0 时返回 0，避免出现 NaN 覆盖率。 */
function ratio(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole
}

/**
 * 统计覆盖率与缺口。
 * @returns 总条数 / 已工具化数 / 覆盖率 / 缺口清单 / 两种口径的对照。
 */
export function summary(): CapabilitySummary {
  const existing = CAPABILITIES.filter(item => item.exists).length
  const missing = CAPABILITIES.filter(item => item.toolizable && !item.exists)
  const writeItems = CAPABILITIES.filter(item => item.kind === 'write')
  const writeExisting = writeItems.filter(item => item.exists).length
  const kernelWrite = KERNEL_TOOLS.filter(item => item.kind === 'write').length
  const byRole: Record<CapabilityRole, RoleCoverage> = {
    creator: { total: 0, existing: 0 },
    publisher: { total: 0, existing: 0 },
    operator: { total: 0, existing: 0 },
    device: { total: 0, existing: 0 },
    steward: { total: 0, existing: 0 },
  }
  for (const item of CAPABILITIES) {
    byRole[item.role].total += 1
    if (item.exists) byRole[item.role].existing += 1
  }
  const used = new Set(CAPABILITIES.filter(item => item.exists).map(item => item.tool))
  return {
    total: CAPABILITIES.length,
    existing,
    coverage: ratio(existing, CAPABILITIES.length),
    toolizableMissing: missing.length,
    notToolizable: CAPABILITIES.filter(item => !item.toolizable).length,
    kernelTools: KERNEL_TOOLS.length,
    kernelWriteTools: kernelWrite,
    kernelReadTools: KERNEL_TOOLS.length - kernelWrite,
    legacyToolCoverage: ratio(KERNEL_TOOLS.length, CAPABILITIES.length),
    writeKindTotal: writeItems.length,
    writeKindExisting: writeExisting,
    writeKindCoverage: ratio(writeExisting, writeItems.length),
    byRole,
    missingTools: [...new Set(missing.map(item => item.tool))].sort(),
    notToolizableIds: CAPABILITIES.filter(item => !item.toolizable).map(item => item.id),
    idleKernelTools: KERNEL_TOOLS.filter(item => !used.has(item.name)).map(item => item.name),
  }
}

/**
 * 登记表自检：只报登记表内部的矛盾，不判断覆盖率高低。
 * @returns 问题清单；空数组表示登记表自洽。
 */
export function verifyRegistry(): string[] {
  const problems: string[] = []
  const ids = new Set<string>()
  const known = new Set(KERNEL_TOOLS.map(item => item.name))
  for (const item of CAPABILITIES) {
    if (ids.has(item.id)) problems.push('id 重复：' + item.id)
    ids.add(item.id)
    if (!item.description.includes(REQUIRED_PHRASE)) problems.push('description 缺少固定句：' + item.id)
    if (!item.tool.startsWith('bosom_')) problems.push('工具名不合规范：' + item.id + ' → ' + item.tool)
    if (item.exists !== known.has(item.tool)) problems.push('exists 与内核工具清单不一致：' + item.id + ' → ' + item.tool)
    if (!item.toolizable && item.exists) problems.push('不适合工具化却标了 exists：' + item.id)
  }
  return problems
}

/** 覆盖率转百分比文本（一位小数）。 */
function percent(value: number): string {
  return (value * 100).toFixed(1) + '%'
}

/**
 * 一页纸报告：总条数 / 已工具化 / 覆盖率 / 两种口径对照 / 按角色 / 待补工具清单。
 * @returns 多行中文文本；直接打印即可。
 */
export function formatSummary(): string {
  const stat = summary()
  const lines: string[] = []
  lines.push('=== Bosom Friend 能力注册表（服务端侧） ===')
  lines.push('写路由总条数              : ' + String(stat.total))
  lines.push('已工具化（exists=true）   : ' + String(stat.existing))
  lines.push('覆盖率（严格口径）        : ' + percent(stat.coverage))
  lines.push('待补工具（toolizable）    : ' + String(stat.toolizableMissing))
  lines.push('不适合工具化              : ' + String(stat.notToolizable))
  lines.push('内核工具总数              : ' + String(stat.kernelTools) + '（写 ' + String(stat.kernelWriteTools) + ' / 只读 ' + String(stat.kernelReadTools) + '）')
  lines.push('既有粗口径（工具/写路由） : ' + percent(stat.legacyToolCoverage) + '（' + String(stat.kernelTools) + '/' + String(stat.total) + '）')
  lines.push('写语义路由口径            : ' + String(stat.writeKindExisting) + '/' + String(stat.writeKindTotal) + ' = ' + percent(stat.writeKindCoverage))
  lines.push('按角色（已工具化/总数）   :')
  for (const role of ['creator', 'publisher', 'operator', 'device', 'steward'] as const) {
    lines.push('  - ' + role.padEnd(10) + String(stat.byRole[role].existing) + '/' + String(stat.byRole[role].total))
  }
  lines.push('口径说明                  : 严格口径 = 这条路由有没有工具能办成；既有粗口径把 19 个只读工具也算进了分子。')
  lines.push('没有独占写路由的内核工具  : ' + String(stat.idleKernelTools.length) + ' 个（18 个只读工具 + bosom_publish_content 与 bosom_publish_draft 共用发布路由 + bosom_platform_login_start 走 GET 发起）')
  lines.push('待补工具清单（' + String(stat.missingTools.length) + ' 个）:')
  for (const tool of stat.missingTools) lines.push('  - ' + tool)
  lines.push('不适合工具化的能力（' + String(stat.notToolizableIds.length) + ' 条）: ' + stat.notToolizableIds.join(', '))
  const problems = verifyRegistry()
  lines.push('登记表自检                : ' + (problems.length === 0 ? 'PASS（0 个矛盾）' : 'FAIL（' + String(problems.length) + ' 个）'))
  for (const problem of problems) lines.push('  ! ' + problem)
  return lines.join(String.fromCharCode(10))
}

// 自检入口：直接跑这个文件时打印一页纸报告（被 import 时不打印）。
const invokedDirectly = /capabilities(\.[jt]s)?$/.test(process.argv[1] ?? '')
if (invokedDirectly) {
  console.log(formatSummary())
}
