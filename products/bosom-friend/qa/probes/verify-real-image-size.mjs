#!/usr/bin/env node
/**
 * 真机验证：图文 1080p + 9:16 的成品必须正好是 1080x1920（与视频同口径）。
 * 只读产物尺寸，验证完把本次生成的草稿与素材删掉，不在用户库里留垃圾。
 */
const BASE = process.env.BF_QA_ORIGIN ?? 'http://127.0.0.1:31280'
const API = BASE + '/bosom-friend/api/'
const TOKEN = process.env.BF_QA_TOKEN ?? 'bf-local-guest-token'

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  try { return JSON.parse(text) } catch { return { code: -1, message: text.slice(0, 200) } }
}

function pngSize(buffer) {
  if (buffer.length < 24) return null
  if (buffer.readUInt32BE(0) !== 0x89504e47) return { format: 'not-png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  return { format: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

const created = await call('POST', 'ai/draft-generation/image-text', {
  quantity: 1,
  groupId: 'mg-persist',
  prompt: '人社局的无人机装调检修工程师免费培训报名提醒',
  imageModel: process.env.BF_PROBE_IMAGE_MODEL ?? 'agnes-image-2.5-flash',
  imageSize: '1080p',
  aspectRatio: '9:16',
  imageCount: 1,
})
console.log('CREATE=' + JSON.stringify(created).slice(0, 200))
const taskId = created.data?.taskIds?.[0]
if (!taskId) { console.log('RESULT=NO_TASK'); process.exit(1) }

let task
const deadline = Date.now() + 300000
while (Date.now() < deadline) {
  const q = await call('POST', 'ai/draft-generation/query', { taskIds: [taskId] })
  task = (q.data ?? [])[0]
  if (task && task.status !== 'generating') break
  await new Promise(r => setTimeout(r, 5000))
}
console.log('STATUS=' + (task?.status ?? 'timeout'))
console.log('REQUEST=' + JSON.stringify(task?.request ?? {}))
console.log('GENERATED_BY=' + (task?.response?.generatedBy ?? '') + ' MODEL=' + (task?.response?.generatedModel ?? ''))
const url = task?.response?.imageUrls?.[0] ?? ''
console.log('IMAGE_URL=' + url)
if (url !== '') {
  const asset = await fetch(BASE + url.replace('/bosom-friend/api', '/bosom-friend/api'), { headers: { authorization: 'Bearer ' + TOKEN } })
  const buffer = Buffer.from(await asset.arrayBuffer())
  console.log('SIZE=' + JSON.stringify({ bytes: buffer.length, ...pngSize(buffer) }))
}
// 清理：删掉本次生成的草稿与素材
const ids = [taskId]
const cleanup = await call('DELETE', 'ai/draft-generation', { ids })
console.log('CLEANUP_GEN=' + cleanup.code)
const contents = await call('GET', 'contents/1/50?kind=draft')
const stray = (contents.data?.list ?? []).filter(item => JSON.stringify(item.metadata ?? {}).includes(taskId))
for (const item of stray) {
  await call('DELETE', 'contents', { ids: [item._id ?? item.id], kind: 'draft' })
}
console.log('CLEANUP_DRAFTS=' + stray.length)
