/**
 * 平台数据同步适配器：以账号 Cookie 为输入，从平台真实接口拉取作品/互动数据，
 * 统一回写发布记录、指标行和账号 workCount。
 * 后续新增平台只需注册一个适配器函数，业务路由和数据看板无需重写。
 * @module @deepseek-ai/dsh-bosom-friend-server/platform-sync
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Deps } from './api.ts'
import { enginePythonExe, engineRoot } from './engine-root.ts'
import { PUBLISH_RECORD_STATUS, type ZyMetricRow, type ZyPublishRecord, type ZySocialAccount } from './types.ts'
import { nowIso, uid } from './store-helper.ts'
import { trackChild } from './platform-processes.ts'
import { applyAccountProfile, type AccountProfileUpdate } from './platform-login.ts'

export interface PlatformSyncOutcome {
  ok: boolean
  platform: string
  count: number
  message: string
  updatedAt: string
}

interface SyncWork {
  dataId: string
  title?: string
  coverUrl?: string
  workLink?: string
  publishTime?: string
  type?: string
  viewCount?: number
  likeCount?: number
  commentCount?: number
  shareCount?: number
  favoriteCount?: number
}

interface SyncState {
  status?: 'starting' | 'done' | 'failed'
  works?: SyncWork[]
  /** worker 同步任务顺带采集的账号资料（昵称/头像/粉丝数）。 */
  profile?: AccountProfileUpdate
  /** worker 是否拿全了该账号的作品列表（平台分页未截断）；只有完整列表才允许对账标记删除。 */
  complete?: boolean
  /**
   * 真实播放量的采集覆盖情况（抖音）：数据来自创作者中心投稿分析接口的
   * play_cnt，口径是「近 recentDays 天」。items 是接口给出的作品数，
   * matched 是能对上本地作品列表的条数，unmatched 是对不上、只上报不落库的条数。
   */
  analytics?: { recentDays?: number, items?: number, matched?: number, unmatched?: number }
  error?: string
}

/** 平台适配器注册表：之后新增平台只加这一项和对应的 worker 采集函数。 */
const SYNC_ADAPTERS: Record<string, { name: string; canSync: boolean }> = {
  douyin: { name: '抖音', canSync: true },
  xhs: { name: '小红书', canSync: true },
  wxSph: { name: '视频号', canSync: false },
  KWAI: { name: '快手', canSync: false },
}

function engineDir(): string {
  return engineRoot()
}

function pythonExe(): string {
  return enginePythonExe()
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  }
  catch {
    return undefined
  }
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function spawnSyncWorker(taskId: string, taskDir: string): ChildProcess | null {
  const exe = pythonExe()
  if (!existsSync(exe) || !existsSync(join(engineDir(), 'worker.py')))
    return null
  const child = trackChild(spawn(exe, [join(engineDir(), 'worker.py'), 'sync', taskId, taskDir], {
    cwd: engineDir(),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }))
  child.unref()
  return child
}

/**
 * 把一条平台作品写入发布记录（已存在则原位合并）。
 *
 * @param records 发布记录集合，命中 accountId + platformWorkId 时原位更新，否则前插新记录。
 * @param account 作品所属账号，决定记录归属。
 * @param work 平台返回的作品与计数；未提供的计数保持缺省，不得写成 0（要求二 R3 无源不显示）。
 * @param platform 平台标识，决定记录类型与默认标题。
 */
export function upsertRecord(records: ZyPublishRecord[], account: ZySocialAccount, work: SyncWork, platform: string): void {
  const workId = String(work.dataId ?? '')
  const defaultTitle = platform === 'xhs' ? '小红书作品' : platform === 'douyin' ? '抖音作品' : `${platform} 作品`
  const id = 'rec-real-' + workId
  const existing = records.find(r => r.accountId === account.id && r.platformWorkId === workId)
  const record = existing ?? {
    id,
    flowId: 'flow-real-' + workId,
    taskId: id,
    userId: 'zy-user-001',
    accountId: account.id,
    accountType: platform,
    type: work.type === 'ImageText' ? 'ImageText' : 'VIDEO',
    status: PUBLISH_RECORD_STATUS.PUBLISHED,
    title: work.title || defaultTitle,
    desc: '',
    publishTime: work.publishTime || nowIso(),
    videoUrl: '',
    coverUrl: work.coverUrl || '',
    imgUrlList: [],
    topics: [],
    source: 'platform-sync',
    errorMsg: '',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    linkStatus: 'ready',
    platformWorkId: workId,
    workLink: work.workLink || '',
    publishedAt: work.publishTime || nowIso(),
  } satisfies ZyPublishRecord

  record.status = PUBLISH_RECORD_STATUS.PUBLISHED
  record.title = work.title || record.title || defaultTitle
  record.coverUrl = work.coverUrl || record.coverUrl || ''
  record.workLink = work.workLink || record.workLink || ''
  record.updatedAt = nowIso()
  record.linkStatus = 'ready'
  record.errorMsg = ''
  // 平台没给的计数一律不写（缺省 = 未采集），绝不用 0 冒充「数据是 0」：
  // 0 与「没采到」在界面上必须区分（要求二 R3 无源不显示）。
  const num = (v: unknown): number | undefined => (v === undefined || v === null ? undefined : Number(v))
  const engagement: NonNullable<ZyPublishRecord['engagement']> = {}
  const viewCount = num(work.viewCount)
  const likeCount = num(work.likeCount)
  const commentCount = num(work.commentCount)
  const shareCount = num(work.shareCount)
  const favoriteCount = num(work.favoriteCount)
  if (viewCount !== undefined) engagement.viewCount = viewCount
  if (likeCount !== undefined) engagement.likeCount = likeCount
  if (commentCount !== undefined) engagement.commentCount = commentCount
  if (shareCount !== undefined) engagement.shareCount = shareCount
  if (favoriteCount !== undefined) engagement.favoriteCount = favoriteCount
  record.engagement = engagement
  if (existing === undefined)
    records.unshift(record)
}

/**
 * 把一条作品的互动计数写进数据中心指标行（同账号+作品+日期则原位更新）。
 *
 * @param metrics 指标行集合。
 * @param account 作品所属账号。
 * @param work 平台返回的作品与计数；未提供的计数整键缺省，不得写成 0。
 * @param platform 平台标识。
 */
export function upsertMetrics(metrics: ZyMetricRow[], account: ZySocialAccount, work: SyncWork, platform: string): void {
  const workId = String(work.dataId ?? '')
  const date = String(work.publishTime ?? nowIso()).slice(0, 10)
  const existing = metrics.find(m => m.accountId === account.id && m.workId === workId && m.date === date)
  const row = existing ?? { date, platform, accountId: account.id, workId }
  row.date = date
  row.platform = platform
  // 平台没给的计数一律不写（缺省 = 未采集）：写 0 会让数据中心把「没采到」显示成「真的是 0」。
  // 与 upsertRecord 的 engagement 同样处理——本次同步没给的字段要清掉，不留上一次的旧值。
  for (const key of ['viewCount', 'likeCount', 'commentCount', 'shareCount', 'favoriteCount'] as const) {
    const value = work[key]
    if (value === undefined) delete row[key]
    else row[key] = Number(value)
  }
  if (existing === undefined)
    metrics.unshift(row)
}

/**
 * 平台侧删除对账：worker 拿全作品列表时，把账号下带 platformWorkId 但不在列表里的记录
 * 标记为 removedOnPlatform，重新出现则清除标记。只标记不删除，平台列表不完整时不执行。
 */
function reconcileRemovedWorks(records: ZyPublishRecord[], account: ZySocialAccount, works: SyncWork[]): void {
  const alive = new Set(works.map(work => String(work.dataId ?? '')).filter(id => id !== ''))
  if (alive.size === 0) return
  for (const record of records) {
    if (record.accountId !== account.id) continue
    const workId = String(record.platformWorkId ?? '')
    if (workId === '') continue
    if (alive.has(workId)) delete record.removedOnPlatform
    else record.removedOnPlatform = true
  }
}

/**
 * 执行平台数据同步：拉起 worker -> 轮询结果 -> 回写记录/指标/账号资料。
 * 目前抖音适配器已可用；其他平台未接入时明确返回不支持，不伪造数据。
 */
export async function syncPlatformWorks(deps: Deps, account: ZySocialAccount): Promise<PlatformSyncOutcome> {
  const adapter = SYNC_ADAPTERS[account.type]
  const base: PlatformSyncOutcome = {
    ok: false,
    platform: account.type,
    count: 0,
    message: '',
    updatedAt: nowIso(),
  }
  if (!adapter) {
    return { ...base, message: `未注册的平台同步适配器: ${account.type}` }
  }
  if (!adapter.canSync) {
    return { ...base, message: `${adapter.name}数据同步适配器尚未接入，当前不会返回示例数据` }
  }
  if (!account.loginCookie) {
    return { ...base, message: `${adapter.name}账号缺少真实 Cookie，请先重新扫码登录` }
  }

  const taskId = uid('sync')
  const taskDir = join(deps.dataRoot, 'platform-login', 'sync', taskId)
  mkdirSync(taskDir, { recursive: true })
  try {
    const cookies = JSON.parse(account.loginCookie) as unknown[]
    writeJson(join(taskDir, 'storage.json'), { cookies: Array.isArray(cookies) ? cookies : [], origins: [] })
  }
  catch {
    return { ...base, message: `${adapter.name}账号 Cookie 格式损坏，请重新扫码登录` }
  }
  writeJson(join(taskDir, 'input.json'), { taskId, platform: account.type, accountId: account.id })
  writeJson(join(taskDir, 'state.json'), { taskId, status: 'starting', startedAt: nowIso() })

  if (!spawnSyncWorker(taskId, taskDir)) {
    return { ...base, message: '平台同步引擎无法启动' }
  }

  const deadline = Date.now() + 150_000
  while (Date.now() < deadline) {
    const state = readJson<SyncState>(join(taskDir, 'state.json'))
    if (state?.status === 'failed') {
      const message = state.error || `${adapter.name}数据同步失败`
      // 平台明确判定登录失效时，把账号标记为需重新登录（界面据此提示，不再假在线）。
      if (/登录已失效|未登录|重新扫码/.test(message)) {
        const accounts = deps.store.files.accounts.load()
        const target = accounts.find(a => a.id === account.id)
        if (target) {
          target.loginState = 'invalid'
          target.loginCheckedAt = nowIso()
          target.loginNote = message
          deps.store.files.accounts.save(accounts)
        }
      }
      return { ...base, message }
    }
    if (state?.status === 'done' && Array.isArray(state.works)) {
      const records = deps.store.files.records.load()
      const metrics = deps.store.files.metrics.load()
      for (const work of state.works) {
        upsertRecord(records, account, work, account.type)
        upsertMetrics(metrics, account, work, account.type)
      }
      // 平台侧删除对账（2026-09-09）：用户删除平台作品后数据中心要同步消失，
      // 仅在 worker 拿全列表时执行，避免分页截断把正常作品误判成已删除。
      if (state.complete === true) reconcileRemovedWorks(records, account, state.works)
      deps.store.files.records.save(records)
      deps.store.files.metrics.save(metrics)
      const accounts = deps.store.files.accounts.load()
      const target = accounts.find(a => a.id === account.id)
      if (target) {
        // 同步成功即证明平台接受了该会话：登录态置为有效（不再靠"有 cookie"猜在线）。
        target.loginState = 'valid'
        target.loginCheckedAt = nowIso()
        target.loginNote = ''
        target.workCount = records.filter(r => r.accountId === account.id).length
        // 同步顺带刷新账号资料：采集到的字段才覆盖，没采到的保留账号库现值。
        if (state.profile !== undefined) applyAccountProfile(target, account.type, state.profile)
        target.updateTime = nowIso()
        deps.store.files.accounts.save(accounts)
      }
      const analyticsNote = state.analytics === undefined
        ? ''
        : `；真实播放量来自创作者中心投稿分析接口（近 ${Number(state.analytics.recentDays ?? 0)} 天口径），本次匹配 ${Number(state.analytics.matched ?? 0)}/${Number(state.analytics.items ?? 0)} 篇`
      return {
        ok: true,
        platform: account.type,
        count: state.works.length,
        message: `${adapter.name}数据同步完成${analyticsNote}`,
        updatedAt: nowIso(),
      }
    }
    await sleep(500)
  }
  return { ...base, message: `${adapter.name}数据同步超时，请稍后重试` }
}

export function platformSyncCapabilities(): Array<{ platform: string; name: string; canSync: boolean }> {
  return Object.entries(SYNC_ADAPTERS).map(([platform, adapter]) => ({
    platform,
    name: adapter.name,
    canSync: adapter.canSync,
  }))
}
