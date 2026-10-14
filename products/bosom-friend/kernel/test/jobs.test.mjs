/**
 * M5a 任务队列单测：状态机、重试、取消、重启恢复、持久化。
 * 运行：node --import tsx/esm products/bosom-friend/kernel/test/jobs.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobQueue } from '../src/jobs.ts'

const tempRoot = mkdtempSync(join(tmpdir(), 'bf-jobs-'))
let tick = 0
const clock = () => 't' + (++tick)

try {
  const queue = new JobQueue(tempRoot, clock)

  const created = queue.enqueue({ kind: 'publish', params: { title: 'a' }, maxRetries: 2 }).job
  assert.equal(created.status, 'queued')
  assert.equal(created.attempt, 0)

  const claimed = queue.claim('publish')
  assert.ok(claimed.job)
  assert.equal(claimed.job.id, created.id)
  assert.equal(claimed.job.status, 'running')
  assert.equal(claimed.job.attempt, 1)

  const failedOnce = queue.fail(created.id, '平台风控')
  assert.equal(failedOnce.job.status, 'queued')
  assert.equal(failedOnce.job.lastError, '平台风控')

  const claimed2 = queue.claim('publish')
  assert.ok(claimed2.job)
  assert.equal(claimed2.job.attempt, 2)
  const failedFinal = queue.fail(created.id, '再次失败')
  assert.ok(failedFinal.job)
  assert.equal(failedFinal.job.status, 'failed')

  const cancelJob = queue.enqueue({ kind: 'sync', params: {}, maxRetries: 1 }).job
  queue.claim('sync')
  assert.equal(queue.cancel(cancelJob.id).job.status, 'cancelled')

  // 持久化：新实例读到同一批任务
  const reloaded = new JobQueue(tempRoot, clock)
  assert.equal(reloaded.list().length, 2)

  // 重启恢复：手工制造 running，recover 后回 queued
  const stuck = queue.enqueue({ kind: 'publish', params: {}, maxRetries: 2 }).job
  queue.claim('publish')
  const recovered = new JobQueue(tempRoot, clock).recover()
  assert.equal(recovered.some((job) => job.id === stuck.id && job.status === 'queued'), true)

  console.log('JOB_QUEUE_OK')
}
finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
