/**
 * 归属管家的界面映射。
 *
 * 为什么要有它：任务上的 `agentRole` 是给程序看的（`steward`、`creator`…），
 * 而用户要知道的是"这件事是哪个管家在办的"（ADR-005 呈现层改造方案 v1.0 的 S1）。
 * 名字与 ADR-005 的"一个总管 + 四个管家"一一对应，不猜语义。
 *
 * `null` / 缺失 = **未登记**：早于该字段落地的旧任务没有归属，服务端特意返回 `null`
 * 就是为了不拿一个管家顶上——界面显示"未登记"，不许回落成"总管"。
 *
 * 新增管家时在这里补一行；没登记的取值按原样展示（宁可露出原名，也不要编一个可能对不上的中文名）。
 */

/** 管家代号 → 中文名。 */
export const AGENT_ROLE_LABELS: Record<string, string> = {
  steward: '总管',
  creator: '创作管家',
  publisher: '发布管家',
  operator: '运营管家',
  device: '设备管家',
}

/** 归属未登记时的界面文案（旧任务没有 agentRole 字段）。 */
export const AGENT_ROLE_UNREGISTERED = '未登记'

/**
 * 把任务上的归属管家代号翻译成界面文案。
 *
 * @param role - 任务上的 `agentRole`；旧任务为 `null` 或缺失。
 * @returns 管家中文名；未登记返回 `null`（由调用方决定显示"未登记"还是不显示）；取值未登记在册时按原样返回。
 */
export function agentRoleLabel(role?: string | null): string | null {
  const trimmed = (role ?? '').trim()
  if (trimmed === '') return null
  return AGENT_ROLE_LABELS[trimmed] ?? trimmed
}
