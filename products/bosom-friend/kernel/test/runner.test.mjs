/**
 * M5b 执行器单测：认领→处理器→成功/失败/重试，未注册处理器失败。
 * 运行：node --import tsx/esm products/bosom-friend/kernel/test/runner.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobQueue } from '../src/jobs.ts'
import { JobRunner } from '../src/runner.ts'

const tempRoot = mkdtempSync(join(tmpdir(), 'bf-runner-'))
let tick = 0
const clock = () => 't' + (++tick)

try {
  const queue = new JobQueue(tempRoot, clock)
  const calls = []
  const handlers = new Map([
    ['echo', async (params) => { calls.push(params); return { ok: true, echo: params.text } }],
    ['boom', async () => { calls.push('boom'); throw new Error('模拟平台失败') }],
  ])
  const runner = new JobRunner(queue, handlers, 10)

  const echoJob = queue.enqueue({ kind: 'echo', params: { text: 'hi' }, maxRetries: 1 }).job
  const echoResult = await runner.tick()
  assert.equal(echoResult?.job?.id, echoJob.id)
  assert.equal(echoResult?.job?.status, 'success')
  assert.equal(echoResult?.job?.result?.ok, true)
  assert.deepEqual(calls[0], { text: 'hi' })

  // 无处理器：失败并记录原因
  const unknownJob = queue.enqueue({ kind: 'missing', params: {}, maxRetries: 1 }).job
  await runner.tick()
  assert.equal(queue.list().find((j) => j.id === unknownJob.id)?.status, 'failed')
  assert.match(queue.list().find((j) => j.id === unknownJob.id)?.lastError ?? '', /没有注册任务处理器/)

  // 失败重试到上限后 failed
  const boomJob = queue.enqueue({ kind: 'boom', params: {}, maxRetries: 2 }).job
  await runner.tick()
  assert.equal(queue.list().find((j) => j.id === boomJob.id)?.status, 'queued')
  await runner.tick()
  assert.equal(queue.list().find((j) => j.id === boomJob.id)?.status, 'failed')
  assert.match(queue.list().find((j) => j.id === boomJob.id)?.lastError ?? '', /模拟平台失败/)

  console.log('JOB_RUNNER_OK')
}
finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
