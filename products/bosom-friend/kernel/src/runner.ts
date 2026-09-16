/**
 * 长任务执行器：单线程认领队列任务，调用处理器，按结果推进状态机。
 * 真实平台引擎（登录/发布/同步/客服）以后作为处理器注册进来；
 * 本轮用可注入的处理器与时钟做确定性验证。
 * @module @deepseek-ai/dsh-bosom-friend-kernel/runner
 */

import { JobQueue, type JobRecord, type JobTransition } from './jobs.ts'

export type JobHandler = (params: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>

/** 单任务执行器：pollMs 仅用于 start() 的自动循环；tick() 可同步调用。 */
export class JobRunner {
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly queue: JobQueue,
    private readonly handlers: ReadonlyMap<string, JobHandler>,
    private readonly pollMs = 200,
  ) {}

  /** 处理一轮：认领一个排队任务并执行；无任务返回 undefined。 */
  async tick(): Promise<JobTransition | undefined> {
    const claimed = this.queue.claim()
    if (claimed.job === undefined) return undefined
    const handler = this.handlers.get(claimed.job.kind)
    if (handler === undefined) {
      return this.queue.fail(claimed.job.id, `没有注册任务处理器：${claimed.job.kind}`)
    }
    try {
      const result = await handler(claimed.job.params)
      return this.queue.succeed(claimed.job.id, result)
    } catch (error) {
      return this.queue.fail(claimed.job.id, error instanceof Error ? error.message : String(error))
    }
  }

  /** 启动自动循环（用于运行时进程）。 */
  start(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => {
      void this.tick().catch(() => {})
    }, this.pollMs)
  }

  stop(): void {
    if (this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
  }
}

export type { JobRecord }
