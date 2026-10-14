/**
 * 盯一条长视频生成：每 20 秒读一次任务，只在**状态有变化**时留一行，直到终态。
 *
 * 为什么要独立脚本：真实生成要跑十几分钟到几小时（厂商限流、逐镜重试），
 * 靠人盯页面截图看不到"哪一镜什么时候成的、哪一镜重试过"。这个脚本把过程落成一行行日志，
 * 既能事后核对，也能在会话里随时读最新几行。
 *
 * 用法：node qa/probes/watch-long-video-run.mjs [基线任务数]
 * 环境：BF_QA_ORIGIN（默认 http://127.0.0.1:31280）
 */
import fs from 'node:fs'
import path from 'node:path'

const origin = process.env.BF_QA_ORIGIN ?? 'http://127.0.0.1:31280'
const api = origin + '/bosom-friend/api'
const baselineCount = Number(process.argv[2] ?? '5')
const logDir = path.join(process.cwd(), 'products', 'bosom-friend', 'qa', 'evidence', 'long-video-run-2026-09-17')
fs.mkdirSync(logDir, { recursive: true })
const logFile = path.join(logDir, 'progress.log')

const stamp = () => new Date().toISOString().slice(11, 19)
const write = (line) => {
  const text = '[' + stamp() + '] ' + line
  console.log(text)
  fs.appendFileSync(logFile, text + '\n', 'utf8')
}

const get = async (p) => {
  const res = await fetch(api + p)
  return await res.json()
}

write('开始盯：基线记录数=' + baselineCount + '，接口=' + api)

let taskId = ''
let lastLine = ''
let shotState = new Map()
const started = Date.now()
const HARD_CAP_MS = 4 * 60 * 60 * 1000

while (Date.now() - started < HARD_CAP_MS) {
  try {
    const list = (await get('/long-videos')).data?.list ?? []
    if (taskId === '' && list.length > baselineCount) {
      taskId = list[0].id
      write('新任务出现：' + taskId + '（' + String(list[0].topic ?? '').slice(0, 30) + '，目标 ' + list[0].targetSeconds + ' 秒）')
    }
    if (taskId !== '') {
      const t = (await get('/long-videos/' + taskId)).data
      const shots = Array.isArray(t.shots) ? t.shots : []
      const done = shots.filter((s) => s.status === 'success').length
      const failed = shots.filter((s) => s.status === 'failed').length
      const line = '状态=' + t.status + '  镜=' + done + '成/' + failed + '败/' + shots.length + '  脚本=' + String(t.scriptChars ?? 0) + '字  耗时=' + Math.round((Date.now() - Date.parse(t.createdAt)) / 60000) + ' 分'
      if (line !== lastLine) { write(line); lastLine = line }
      shots.forEach((s, i) => {
        const key = i + ':' + String(s.status)
        if (!shotState.has(i)) {
          shotState.set(i, String(s.status))
          write('  第 ' + (i + 1) + ' 镜 ' + s.kind + ' ' + s.seconds + 's provider=' + String(s.provider ?? '-') + ' 状态=' + s.status)
        } else if (shotState.get(i) !== String(s.status)) {
          shotState.set(i, String(s.status))
          write('  第 ' + (i + 1) + ' 镜 → ' + s.status)
        }
      })
      if (t.errorMessage) write('  错误：' + String(t.errorMessage).slice(0, 200))
      if (['success', 'failed', 'cancelled', 'aborted'].includes(String(t.status))) {
        write('终态：' + t.status + '（成片 ' + String(t.videoUrl ?? '(无)') + '）')
        break
      }
    }
  } catch (error) {
    write('读取失败（继续重试）：' + String(error && error.message ? error.message : error).slice(0, 160))
  }
  await new Promise((resolve) => setTimeout(resolve, 20000))
}
write('盯守结束')
