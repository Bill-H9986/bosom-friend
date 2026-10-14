/**
 * 工具名的用户可读标签。
 *
 * 为什么要有它：内核里的工具名是给程序看的（`bosom_platform_list_accounts`、
 * `mcp__ssh__ssh_exec`），而"过程"这一栏是**给人看**的——用户要知道的是"它在查我的账号"，
 * 不是"它在调 bosom_platform_list_accounts"。名字与说明书一一对应，不猜语义。
 *
 * 新增产品工具时在这里补一行；没有登记的工具按原名去掉 mcp 前缀展示（宁可露出原名，
 * 也不要编一个可能对不上的中文名）。
 */

/** 工具名 → 中文标签（产品业务工具在前，内核自带工具在后）。 */
const TOOL_LABELS: Record<string, string> = {
  // 产品业务工具（kernel/src/index.ts 注册的那些）
  bosom_kernel_ping: '自检内核',
  bosom_platform_list_accounts: '查平台账号',
  bosom_reception_list_pending: '查待接待评论',
  bosom_material_list: '查素材库',
  bosom_data_dashboard: '查数据看板',
  bosom_platform_login_start: '发起扫码登录',
  bosom_platform_login_status: '查登录状态',
  bosom_platform_sync_works: '查已发布作品',
  bosom_content_list_drafts: '查草稿箱',
  bosom_content_generate_script: '生成内容脚本',
  bosom_job_list: '查后台任务',
  // 内核自带工具（模型自己会用到的那些）
  read: '读文件',
  write: '写文件',
  edit: '改文件',
  glob: '找文件',
  grep: '搜内容',
  bash: '执行命令',
  pwsh: '执行命令',
  web_search: '联网搜索',
  web_fetch: '抓取网页',
  todo_write: '整理待办',
  run_code: '跑一段代码',
  skill: '加载技能',
  subagent: '派子任务',
}

/**
 * 把工具名翻译成中文标签。
 *
 * @param name - 内核事件里的工具名（可能带 `mcp__<服务>__` 前缀）。
 * @returns 中文标签；未登记的工具返回去掉 mcp 前缀的原名。
 */
export function toolDisplayName(name: string): string {
  const trimmed = (name ?? '').trim()
  if (trimmed === '') return ''
  if (TOOL_LABELS[trimmed] !== undefined) return TOOL_LABELS[trimmed]
  const withoutMcp = trimmed.replace(/^mcp__\w+__/, '')
  return TOOL_LABELS[withoutMcp] ?? withoutMcp
}
