/**
 * 管家团队视图的共享类型。
 *
 * 这里只放"任务在团队视图里长什么样"的最小字段集：列表接口
 * （`GET agent/tasks`）已经返回这些字段，不需要新接口，也不必把整条任务塞进组件。
 */
import type { TaskActionResult } from '@web/api/ai/ai.types'
import type { IActionCard } from '@web/store/agent'

/** 一条任务在团队视图里的最小呈现。 */
export interface ITeamAgentTaskItem {
  id: string
  title: string
  /** 服务端原始状态字符串（running / completed / requires_action / error / aborted）。 */
  status?: string
  createdAt: string
  updatedAt: string
}

/** 一条待拍板动作：动作卡 + 它属于哪条任务。 */
export interface IPendingDecisionItem {
  /** 动作所在任务。 */
  taskId: string
  /** 任务标题，供清单上写清"这是哪件事"。 */
  taskTitle: string
  /** 任务归属管家；null = 未登记（旧任务），界面不猜。 */
  agentRole?: string | null
  /** 任务最后更新时间，用于排序。 */
  updatedAt: string
  /** 服务端发放的动作卡原文（含 requestId / explicitPublishIntent）。 */
  action: IActionCard
  /**
   * 这条任务的动作回填台账（`task.actionResults`）。
   *
   * 每张卡必须拿到**自己那条任务**的台账：混用会让卡片显示别人任务的状态
   * （`ActionStateRow` 按 requestId 在台账里查），所以逐项带上而不是全局一份。
   */
  actionResults: TaskActionResult[]
}

export type { IActionCard, TaskActionResult }
