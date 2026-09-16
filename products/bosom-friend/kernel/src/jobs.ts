/**
 * 产品长任务队列：登录/发布/同步/客服等外部副作用任务的状态机与持久化。
 * 状态：queued → running → success/failed/cancelled；失败且未超重试回 queued。
 * 重启恢复：running 一律回 queued（外部副作用可安全重放幂等任务）。
 * @module @deepseek-ai/dsh-bosom-friend-kernel/jobs
 */

import { randomUUID } from 'node:crypto'
import type { ZyJobRecord } from '@deepseek-ai/dsh-bosom-friend-server/src/store.ts'
import { openProductStore } from './data.ts'

export type { ZyJobRecord as JobRecord }

export interface EnqueueJob {
  kind: string
  params: Record<string, unknown>
  maxRetries?: number
}

export interface JobTransition {
  job: ZyJobRecord | undefined
  /** 本次转移是否触发了持久化（无变化时不写盘）。 */
  changed: boolean
}

/** 任务队列：共享产品数据店持久化，时钟可注入以便确定性测试。 */
export class JobQueue {
  private readonly dataRoot: string
  private readonly clock: () => string

  constructor(dataRoot: string, clock?: () => string) {
    this.dataRoot = dataRoot
    this.clock = clock ?? (() => new Date().toISOString())
  }

  private jobs() {
    return openProductStore(this.dataRoot).files.jobs
  }

  list(): ZyJobRecord[] {
    return this.jobs().load()
  }

  enqueue(input: EnqueueJob): JobTransition {
    const store = this.jobs()
    const list = store.load()
    const now = this.clock()
    const job: ZyJobRecord = {
      id: randomUUID(),
      kind: input.kind,
      params: input.params,
      status: 'queued',
      attempt: 0,
      maxRetries: input.maxRetries ?? 2,
      createdAt: now,
      updatedAt: now,
    }
    list.push(job)
    store.save(list)
    return { job, changed: true }
  }

  claim(kind?: string): JobTransition {
    const store = this.jobs()
    const list = store.load()
    const target = list.find((job) => job.status === 'queued' && (kind === undefined || job.kind === kind))
    if (target === undefined) return { job: undefined, changed: false }
    target.status = 'running'
    target.attempt += 1
    target.updatedAt = this.clock()
    store.save(list)
    return { job: target, changed: true }
  }

  succeed(id: string, result?: Record<string, unknown>): JobTransition {
    return this.finish(id, (job) => {
      job.status = 'success'
      job.result = result
    })
  }

  fail(id: string, error: string): JobTransition {
    return this.finish(id, (job) => {
      job.lastError = error
      if (job.attempt >= job.maxRetries) job.status = 'failed'
      else job.status = 'queued'
    })
  }

  cancel(id: string): JobTransition {
    return this.finish(id, (job) => {
      job.status = 'cancelled'
    })
  }

  /** 重启恢复：把遗留 running 回 queued；返回被恢复的任务。 */
  recover(): ZyJobRecord[] {
    const store = this.jobs()
    const list = store.load()
    const recovered: ZyJobRecord[] = []
    for (const job of list) {
      if (job.status === 'running') {
        job.status = 'queued'
        job.updatedAt = this.clock()
        recovered.push(job)
      }
    }
    if (recovered.length > 0) store.save(list)
    return recovered
  }

  private finish(id: string, mutate: (job: ZyJobRecord) => void): JobTransition {
    const store = this.jobs()
    const list = store.load()
    const target = list.find((job) => job.id === id)
    if (target === undefined) return { job: undefined, changed: false }
    mutate(target)
    target.updatedAt = this.clock()
    store.save(list)
    return { job: target, changed: true }
  }
}
