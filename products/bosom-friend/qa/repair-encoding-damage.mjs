#!/usr/bin/env node
/**
 * 编码损坏数据修复工具（配合 qa/check-data-integrity.mjs 使用）。
 *
 * 修复规则：
 * - publish-records.json：标题/正文/话题被替换字符污染时，从**同一 platformWorkId 的兄弟记录**恢复。
 * - material-groups.json：组名被污染时，从**组内素材标题**推导一个可读名（去括号与竖线后取首个）。
 * - 一律以 UTF-8 无 BOM 写回；无兄弟记录可恢复的条目不臆造，只打印 NO_SIBLING 待人工处理。
 *
 * 用法：node products/bosom-friend/qa/repair-encoding-damage.mjs [数据根] [--api http://127.0.0.1:31280]
 * 退出码：0 = 执行完毕（是否仍有残留看随后的 check-data-integrity）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const root = args.find(a => !a.startsWith('--')) ?? join(homedir(), '.bosom-friend', 'bosom-friend')
const apiIndex = args.indexOf('--api')
const api = apiIndex >= 0 ? args[apiIndex + 1] : 'http://127.0.0.1:31280'
const damaged = value => typeof value === 'string' && ((value.length > 1 && /^\?+$/.test(value)) || /\?{3,}/.test(value))

const recordFile = join(root, 'publish-records.json')
const recordEnv = JSON.parse(readFileSync(recordFile, 'utf8'))
let records = 0
for (const record of recordEnv.value) {
  if (!damaged(record.title) && !damaged(record.desc)) continue
  const sibling = recordEnv.value.find(item =>
    item !== record && item.platformWorkId && item.platformWorkId === record.platformWorkId && !damaged(item.title))
  if (sibling === undefined) {
    console.log('NO_SIBLING id=' + record.id + ' workId=' + record.platformWorkId)
    continue
  }
  if (damaged(record.title)) record.title = sibling.title
  if (damaged(record.desc)) record.desc = sibling.desc
  if (Array.isArray(record.topics) && record.topics.some(damaged) && Array.isArray(sibling.topics)) record.topics = sibling.topics
  record.updatedAt = new Date().toISOString()
  records++
  console.log('REC_FIXED ' + record.id + ' <- ' + sibling.id + ' title="' + record.title + '"')
}
if (records > 0) writeFileSync(recordFile, JSON.stringify(recordEnv, null, 2), 'utf8')

const groupFile = join(root, 'material-groups.json')
const groupEnv = JSON.parse(readFileSync(groupFile, 'utf8'))
let media = []
try {
  const res = await fetch(api + '/bosom-friend/api/media/list/1/200')
  media = (await res.json())?.data?.list ?? []
}
catch (error) {
  console.log('MEDIA_LIST_UNAVAILABLE ' + String(error))
}
let groups = 0
for (const group of groupEnv.value) {
  if (!damaged(group.name) && !damaged(group.title)) continue
  const inGroup = media.filter(item => item.groupId === group.id || item.materialGroupId === group.id)
  const titles = inGroup
    .map(item => String(item.title ?? '').split('｜')[0].split('|')[0].trim())
    .filter(title => title !== '' && !damaged(title))
  const derived = (titles[0] ?? ('素材组-' + group.id.replace(/^mg-/, ''))).slice(0, 40)
  group.name = derived
  group.title = derived
  group.updatedAt = new Date().toISOString()
  groups++
  console.log('GROUP_FIXED ' + group.id + ' -> "' + derived + '" (组内素材 ' + inGroup.length + ' 条)')
}
if (groups > 0) writeFileSync(groupFile, JSON.stringify(groupEnv, null, 2), 'utf8')
console.log('REPAIR_DONE records=' + records + ' groups=' + groups)
