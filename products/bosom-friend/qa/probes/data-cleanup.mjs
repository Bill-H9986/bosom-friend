// 一次性数据清理：移除早期 QA 假发布记录/假指标，并回填真实发布记录的话题标签。
// 需在服务停止后运行，避免内存缓存覆盖磁盘文件。
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const dir = join(homedir(), '.bosom-friend', 'bosom-friend')

const records = JSON.parse(readFileSync(join(dir, 'publish-records.json'), 'utf8'))
const kept = records.filter(r => r.accountId !== 'a1')
const real = kept.find(r => r.id === 'rec-jh8m44r5')
if (real) real.topics = ['重庆', '飞行员', '飞行日常', '安全出行']
writeFileSync(join(dir, 'publish-records.json'), JSON.stringify(kept, null, 2), 'utf8')
console.log('records: before', records.length, 'after', kept.length)

const metrics = [{
  date: '2026-08-30',
  platform: 'xhs',
  accountId: 'acc-t6tegkq6',
  workId: 'rec-jh8m44r5',
  viewCount: 0,
  likeCount: 0,
  commentCount: 0,
  shareCount: 0,
  favoriteCount: 0,
}]
writeFileSync(join(dir, 'metrics.json'), JSON.stringify(metrics, null, 2), 'utf8')
console.log('metrics: reset to 1 real row')
