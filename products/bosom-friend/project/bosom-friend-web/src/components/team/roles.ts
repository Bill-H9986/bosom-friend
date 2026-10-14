/**
 * 管家团队视图的界面事实：五个管家的身份与"这个管家能做什么"。
 *
 * **事实源**：`products/bosom-friend/presets/roles.json`（键顺序即这里的数组顺序）。
 * 前端读不到那个文件——它在 `project/` 之外，vite 只用 `@web`（=`bosom-friend-web/src`）
 * 与 `@`（=`bosom-friend-electron/src`）两个别名指向 project 下的源码，没有把 `presets/`
 * 并进编译单元的通道。所以这里内联一份**与它同源**的映射（每条都留着 roles.json 的原始模式
 * `pattern` 便于逐条对账），而不是另编一套名字。
 *
 * **同步责任**：`roles.json` 增删角色、或调整某角色的工具面时，必须同步改本文件；
 * 反之亦然。管家中文名不在这里重复定义——一律走
 * `components/Chat/utils/agentRoles.ts` 的 `AGENT_ROLE_LABELS`，免得同一件事有两个家。
 *
 * `steward` 的工具面是 `*`（全量），它对应内核注册的全部 `bosom_*` 工具，
 * 不是"没有工具"；界面上要如实写成全量，不能显示成空。
 */

/** 一条工具面摘要：roles.json 里的原始模式 + 给人看的说法。 */
export interface IAgentToolSurfaceItem {
  /** roles.json 里该角色的原始模式，用于与事实源逐条对账。 */
  pattern: string
  /** 给人看的说法（界面展示用）。 */
  label: string
}

/** 一个管家的界面事实。 */
export interface ITeamAgentRole {
  /** 管家代号，与任务上的 `agentRole`、roles.json 的键一致。 */
  code: string
  /** 一句话职责（依据 ADR-005 与 roles.json 的工具面）。 */
  duty: string
  /** 工具面摘要：这个管家这次会话能看到哪些工具（工具面即权限边界）。 */
  toolSurface: IAgentToolSurfaceItem[]
}

/**
 * 五个管家（一个总管 + 四个管家），顺序与 `presets/roles.json` 的键顺序一致。
 *
 * 依据：ADR-005《产品形态改为 AI 管家》；`presets/roles.json`；呈现层改造方案 v1.0 的 4.5 节
 * （"显示这个管家能做什么"由 roles.json 生成只读提示）。
 */
export const TEAM_AGENT_ROLES: ITeamAgentRole[] = [
  {
    code: 'steward',
    duty: '对话入口的接收方；判不准归属时也归它',
    toolSurface: [
      { pattern: '*', label: '全部工具（内核注册的所有 bosom_* 工具）' },
    ],
  },
  {
    code: 'creator',
    duty: '写稿、出片、管素材',
    toolSurface: [
      { pattern: 'bosom_content_*', label: '内容脚本与草稿' },
      { pattern: 'bosom_material_*', label: '素材库' },
      { pattern: 'bosom_digital_human_*', label: '数字人形象' },
      { pattern: 'bosom_long_video_*', label: '长视频分段出片' },
    ],
  },
  {
    code: 'publisher',
    duty: '把内容发布到平台',
    toolSurface: [
      { pattern: 'bosom_publish_*', label: '发布' },
      { pattern: 'bosom_platform_list_accounts', label: '查平台账号' },
      { pattern: 'bosom_platform_login_status', label: '查登录状态' },
    ],
  },
  {
    code: 'operator',
    duty: '接待与数据（看评论、看私信、看作品数据）',
    toolSurface: [
      { pattern: 'bosom_reception_*', label: '评论与私信接待' },
      { pattern: 'bosom_data_works', label: '作品数据' },
      { pattern: 'bosom_platform_sync_works', label: '同步已发布作品' },
      { pattern: 'bosom_platform_sync_now', label: '立即同步' },
    ],
  },
  {
    code: 'device',
    duty: '账号与设置（登录、资料、系统设置）',
    toolSurface: [
      { pattern: 'bosom_settings_*', label: '设置' },
      { pattern: 'bosom_user_*', label: '用户资料' },
      { pattern: 'bosom_platform_list_accounts', label: '查平台账号' },
      { pattern: 'bosom_platform_login_status', label: '查登录状态' },
      { pattern: 'bosom_platform_login_start', label: '发起扫码登录' },
    ],
  },
]

/**
 * 任务状态里属于"这个管家正在办"的那些。
 *
 * 依据服务端任务状态值域（`server/src/types.ts` 的 ZyAgentTask.status）：
 * running = 正在跑；requires_action = 卡在等用户动作。其余（completed / error / aborted）
 * 都是已经收尾的，不算在办——把它们算进来会让"谁在干什么"永远答不准。
 */
export const TEAM_ACTIVE_TASK_STATUSES: string[] = ['running', 'requires_action']

/**
 * 这条任务算不算"在办"。
 *
 * @param status - 任务列表里的状态字符串（大小写不敏感）。
 * @returns 属于在办状态返回 true。
 */
export function isActiveTaskStatus(status?: string | null): boolean {
  return TEAM_ACTIVE_TASK_STATUSES.includes((status ?? '').trim().toLowerCase())
}
