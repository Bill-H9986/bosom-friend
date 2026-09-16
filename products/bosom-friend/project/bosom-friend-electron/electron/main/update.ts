// [slim] 遥测已随精简移除，保留空实现以稳定更新链路
const telemetryCollector: any = { track: (): void => {} };
const TELEMETRY_EVENTS: any = new Proxy({}, { get: (_t, k: string): string => String(k) });
const getDeviceBucket: any = (): string => "default";
/*
 * 知音 OTA 升级中心
 *
 * 架构（对齐 electron-updater 行业标准 + 自研策略层）：
 *   1. 客户端启动后静默检查 → 拉取服务端策略清单 update.json；
 *   2. 策略清单决定：是否有新版 / 是否强制更新 / 是否进入灰度分桶；
 *   3. 通过 electron-updater（generic 源）下载 latest.yml 指向的安装包；
 *   4. 下载完成后提示重启安装，全程进度 / 错误 / 结果埋点上报。
 *
 * 服务端约定（详见 docs/OTA与遥测服务端接口规范.md）：
 *   GET  <更新源>/update.json    策略清单
 *   GET  <更新源>/latest.yml     electron-updater 元数据
 *   GET  <更新源>/<安装包>       安装包（哈希在 latest.yml 内）
 */
import { app, ipcMain, net } from 'electron'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type {
  ProgressInfo,
  UpdateDownloadedEvent,
  UpdateInfo,
} from 'electron-updater'
import { store } from '../global/store'
import { logger } from '../global/log'

const { autoUpdater } = createRequire(import.meta.url)('electron-updater')

const UPDATE_URL_KEY = 'zhiyin-update-url'
// 优先使用构建时注入的 GitHub Releases 更新源；未配置时跳过自动检查，
// 避免 electron-updater 在无更新源时异常退出。
const DEFAULT_UPDATE_URL = process.env.ZHIYIN_UPDATE_URL || ''

// 公开更新仓库（固定）：走 api.github.com（可访问）获取发布信息与资产下载地址。
const UPDATE_REPO = 'Bill-H9986/zhiyin'
const API_BASE = `https://api.github.com/repos/${UPDATE_REPO}`

// 已通过 API 下载完成的安装包路径，用于“现在安装”
let downloadedInstallerPath = ''
let lastGithubMeta: GithubReleaseMeta | null = null

// 最近一次检查得到的强制/说明，用于在 update-available 事件里还原展示信息
let lastUpdateForce = false
let lastUpdateNotes: string | undefined

/** 服务端策略清单 */
export interface UpdatePolicy {
  /** 最新版本号 */
  version: string
  /** 是否强制更新（弹窗不可关闭） */
  force: boolean
  /** 最低可用版本：低于它必须升级 */
  minVersion?: string
  /** 灰度放量百分比 0-100，缺省 100 全量 */
  rollout?: number
  /** 更新说明（Markdown） */
  notes?: string
  /** 发布日期（ISO） */
  releaseDate?: string
  /** 安装包直链（可覆盖 latest.yml，便于 CDN 分发） */
  url?: string
}

export interface UpdateCheckResult {
  update: boolean
  reason?: 'dev' | 'up-to-date' | 'rollout' | 'error'
  currentVersion: string
  newVersion?: string
  force?: boolean
  notes?: string
  policy?: UpdatePolicy
  message?: string
}

function updateUrl(): string {
  const saved = store.get(UPDATE_URL_KEY) as string | undefined
  return saved && /^https?:\/\//.test(saved) ? saved : DEFAULT_UPDATE_URL
}

/** 是否配置了可用的更新源 */
function hasUpdateSource(): boolean {
  // 自定义升级器固定使用 API 源，因此只要仓库名存在即视为有更新源。
  return /^https?:\/\//.test(updateUrl()) || Boolean(UPDATE_REPO);
}

function setFeedUrl(): void {
  autoUpdater.setFeedURL({ provider: 'generic', url: updateUrl() })
}

/** 简易版本比较：大于返回 1，等于 0，小于 -1（支持 x.y.z 与 x.y.z-build） */
function compareVersion(a: string, b: string): number {
  const pa = (a || '').split(/[.-]/).map((n) => parseInt(n, 10) || 0)
  const pb = (b || '').split(/[.-]/).map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

interface GithubReleaseMeta {
  version: string
  notes?: string
  assetId?: number
  assetName?: string
  assetSize?: number
  browserUrl?: string
  force?: boolean
}

/** 通过 api.github.com（通常可达）拉取最新发布信息 */
async function fetchGithubReleaseViaApi(): Promise<GithubReleaseMeta | null> {
  try {
    const res = await net.fetch(`${API_BASE}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'ZhiYin-OTA',
      },
    })
    if (!res.ok) return null
    const data = await res.json()
    const exe = (data?.assets || []).find((a: any) => a?.name === 'zhiyin-latest.exe')
    return {
      version: String(data?.tag_name || '').replace(/^v/, ''),
      notes: typeof data?.body === 'string' ? data.body : undefined,
      assetId: exe?.id,
      assetName: exe?.name,
      assetSize: exe?.size,
      browserUrl: exe?.browser_download_url,
      force: false,
    }
  }
  catch (e) {
    logger.warn('[ota] API 获取发布信息失败:', e)
    return null
  }
}

/** 尝试从一个 URL 下载镜像；失败返回 false，并清理半成品文件 */
async function tryDownloadUrl(
  url: string,
  file: string,
  expectedSize: number,
  win: Electron.BrowserWindow,
): Promise<boolean> {
  try {
    let res: Response
    try {
      res = await net.fetch(url, {
        headers: {
          Accept: 'application/octet-stream',
          'User-Agent': 'ZhiYin-OTA',
        },
        signal: AbortSignal.timeout(20_000),
      })
    }
    catch {
      return false
    }
    if (!res.ok) return false

    const total = Number(res.headers.get('content-length') || expectedSize || 0)
    const stream = fs.createWriteStream(file)
    const reader = res.body?.getReader()
    let received = 0

    if (reader) {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.length
        stream.write(Buffer.from(value))
        win.webContents.send('download-progress', {
          percent: total ? Math.floor((received / total) * 100) : 0,
          transferred: received,
          total,
        })
      }
    }

    await new Promise<void>((resolve, reject) => {
      stream.end(() => resolve())
      stream.on('error', reject)
    })
    return true
  }
  catch {
    try { fs.rmSync(file, { force: true }) } catch { /* 忽略 */ }
    return false
  }
}

/** 依次尝试多个下载源（GitHub API / 官方直链 / 国内加速镜像），取第一个成功者 */
async function downloadInstallerViaApi(
  meta: GithubReleaseMeta,
  win: Electron.BrowserWindow,
): Promise<string> {
  if (!meta?.assetId && !meta?.browserUrl) throw new Error('未找到安装包资产')

  const dir = path.join(app.getPath('userData'), 'updates')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${meta.version}-zhiyin-latest.exe`)
  const mirrorBase = updateUrl()
  const candidates: string[] = []

  if (meta?.assetId) candidates.push(`${API_BASE}/releases/assets/${meta.assetId}`)
  if (meta?.browserUrl) {
    // 国内网络优先走加速镜像，最后才回退官方直链，避免在 GitHub 官方下载域上长时间卡死
    candidates.push(`https://gh-proxy.com/${meta.browserUrl}`)
    candidates.push(`https://ghfast.top/${meta.browserUrl}`)
    candidates.push(`https://ghproxy.net/${meta.browserUrl}`)
    candidates.push(meta.browserUrl)
  }
  if (
    /^https?:\/\//.test(mirrorBase)
    && !mirrorBase.includes('github.com')
    && meta?.assetName
  ) {
    candidates.push(`${mirrorBase}/${meta.assetName}`)
  }

  for (const url of candidates) {
    if (await tryDownloadUrl(url, file, meta?.assetSize || 0, win)) {
      downloadedInstallerPath = file
      win.webContents.send('update-downloaded')
      logger.info('[ota] 下载成功:', url)
      return file
    }
    logger.warn('[ota] 镜像失败，换下一个:', url)
  }
  throw new Error('所有更新镜像下载失败，请稍后重试')
}

/** 直接运行已下载的 NSIS 安装器（--updated 表示覆盖更新） */
function runInstallerAndQuit(installerPath: string): void {
  if (!installerPath || !fs.existsSync(installerPath)) return
  const child = spawn(installerPath, ['--updated'], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  app.quit()
}

/** 拉取服务端策略清单（10 秒超时，失败返回 null 表示走纯 latest.yml 全量检查） */
async function fetchUpdatePolicy(): Promise<UpdatePolicy | null> {
  try {
    const res = await fetch(`${updateUrl()}update.json`, {
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const raw = await res.json()
    if (!raw || typeof raw.version !== 'string') return null
    return {
      version: raw.version,
      force: !!raw.force,
      minVersion: typeof raw.minVersion === 'string' ? raw.minVersion : undefined,
      rollout:
        typeof raw.rollout === 'number' ? Math.max(0, Math.min(100, raw.rollout)) : 100,
      notes: typeof raw.notes === 'string' ? raw.notes : undefined,
      releaseDate: typeof raw.releaseDate === 'string' ? raw.releaseDate : undefined,
      url: typeof raw.url === 'string' ? raw.url : undefined,
    }
  } catch (e) {
    logger.warn('[ota] 拉取更新策略失败，降级为 latest.yml 检查:', e)
    return null
  }
}

async function checkUpdateInternal(): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion()
  const base: UpdateCheckResult = {
    update: false,
    currentVersion,
  }

  if (!app.isPackaged) {
    return { ...base, reason: 'dev' }
  }

  // 未配置更新源：跳过一切更新检查（内测包无更新服务器，占位地址会让更新器异常退出）
  if (!hasUpdateSource()) {
    return { ...base, reason: 'error', message: '未配置更新源' }
  }

  // 优先走 api.github.com：通常比 github.com 下载域更稳，且 Electron net 可吃系统代理
  try {
    const apiMeta = await fetchGithubReleaseViaApi()
    if (apiMeta?.version) {
      const hasNew = compareVersion(apiMeta.version, currentVersion) > 0
      telemetryCollector.track(TELEMETRY_EVENTS.UPDATE_CHECK, {
        result: hasNew ? 'available' : 'none',
        mode: 'github-api',
      })
      if (!hasNew) return { ...base, reason: 'up-to-date', newVersion: apiMeta.version }
      lastGithubMeta = apiMeta
      lastUpdateForce = apiMeta.force ?? false
      lastUpdateNotes = apiMeta.notes
      return {
        ...base,
        update: true,
        newVersion: apiMeta.version,
        force: lastUpdateForce,
        notes: apiMeta.notes,
      }
    }
  }
  catch (e) {
    logger.warn('[ota] GitHub API 检查降级:', e)
  }

  const policy = await fetchUpdatePolicy()

  // 策略清单不可用时回退到 electron-updater 原生检查
  if (!policy) {
    try {
      lastUpdateForce = false
      lastUpdateNotes = undefined
      setFeedUrl()
      const result = await autoUpdater.checkForUpdates()
      const hasUpdate = !!result?.updateInfo?.version &&
        compareVersion(result.updateInfo.version, currentVersion) > 0
      telemetryCollector.track(TELEMETRY_EVENTS.UPDATE_CHECK, {
        result: hasUpdate ? 'available' : 'none',
        mode: 'latest-yml',
      })
      return {
        ...base,
        update: hasUpdate,
        newVersion: result?.updateInfo?.version,
      }
    } catch (e) {
      telemetryCollector.track(TELEMETRY_EVENTS.UPDATE_CHECK, {
        result: 'error',
      })
      return {
        ...base,
        reason: 'error',
        message: (e as Error).message,
      }
    }
  }

  const hasNew = compareVersion(policy.version, currentVersion) > 0
  if (!hasNew) {
    telemetryCollector.track(TELEMETRY_EVENTS.UPDATE_CHECK, {
      result: 'up-to-date',
    })
    return { ...base, reason: 'up-to-date', newVersion: policy.version }
  }

  // 灰度分桶：rollout < 100 时按设备哈希决定是否放量
  const rollout = policy.rollout ?? 100
  if (rollout < 100 && getDeviceBucket() >= rollout) {
    telemetryCollector.track(TELEMETRY_EVENTS.UPDATE_CHECK, {
      result: 'rollout-skip',
      rollout,
    })
    return { ...base, reason: 'rollout', newVersion: policy.version, policy }
  }

  const force = policy.force ||
    (!!policy.minVersion && compareVersion(currentVersion, policy.minVersion) < 0)
  lastUpdateForce = force
  lastUpdateNotes = policy.notes

  try {
    setFeedUrl()
    await autoUpdater.checkForUpdates()
    telemetryCollector.track(TELEMETRY_EVENTS.UPDATE_CHECK, {
      result: 'available',
      force,
    })
    return {
      ...base,
      update: true,
      newVersion: policy.version,
      force,
      notes: policy.notes,
      policy,
    }
  } catch (e) {
    telemetryCollector.track(TELEMETRY_EVENTS.UPDATE_CHECK, {
      result: 'error',
      force,
    })
    return {
      ...base,
      update: true,
      newVersion: policy.version,
      force,
      notes: policy.notes,
      policy,
      reason: 'error',
      message: (e as Error).message,
    }
  }
}

export function update(win: Electron.BrowserWindow) {
  autoUpdater.autoDownload = false
  autoUpdater.disableWebInstaller = false
  autoUpdater.allowDowngrade = false

  autoUpdater.on('update-available', (arg: UpdateInfo) => {
    win.webContents.send('update-can-available', {
      update: true,
      version: app.getVersion(),
      newVersion: arg?.version,
      force: lastUpdateForce,
      notes: lastUpdateNotes,
      silent: !lastUpdateForce,
    })
  })
  autoUpdater.on('update-not-available', (arg: UpdateInfo) => {
    win.webContents.send('update-can-available', {
      update: false,
      version: app.getVersion(),
      newVersion: arg?.version,
    })
  })
  autoUpdater.on('download-progress', (info: ProgressInfo) => {
    win.webContents.send('download-progress', info)
    // 进度抽样上报（每 10% 一档，避免高频事件）
    const percent = Math.floor(info.percent / 10) * 10
    telemetryCollector.track(TELEMETRY_EVENTS.UPDATE_DOWNLOAD_PROGRESS, {
      percent,
    })
  })
  autoUpdater.on('update-downloaded', (event: UpdateDownloadedEvent) => {
    win.webContents.send('update-downloaded')
    telemetryCollector.track(TELEMETRY_EVENTS.UPDATE_DOWNLOADED, {
      version: event?.version,
    })
  })
  autoUpdater.on('error', (error: Error) => {
    win.webContents.send('update-error', { message: error.message, error })
    telemetryCollector.track(TELEMETRY_EVENTS.ERROR_MAIN, {
      source: 'updater',
    })
  })

  // 完整检查（带策略清单，供设置页使用）
  ipcMain.handle('zhiyin:update:check', async () => {
    const result = await checkUpdateInternal()
    if (result.update) {
      // 直接广播可更新事件（含 force / notes）
      win.webContents.send('update-can-available', {
        update: true,
        version: result.currentVersion,
        newVersion: result.newVersion,
        force: result.force,
        notes: result.notes,
      })
    }
    return result
  })

  // 兼容旧调用：check-update
  ipcMain.handle('check-update', async () => {
    try {
      return await checkUpdateInternal()
    } catch (error) {
      return { message: '网络错误', error }
    }
  })

  ipcMain.handle('start-download', async () => {
    try {
      const meta = lastGithubMeta || await fetchGithubReleaseViaApi()
      if (!meta?.assetId) throw new Error('未找到安装包资产')
      lastGithubMeta = meta
      await downloadInstallerViaApi(meta, win)
    }
    catch (e) {
      win.webContents.send('update-error', { message: (e as Error).message })
    }
  })

  ipcMain.handle('quit-and-install', () => {
    telemetryCollector.track(TELEMETRY_EVENTS.UPDATE_INSTALL, {})
    runInstallerAndQuit(downloadedInstallerPath)
  })

  // 启动后静默检查（打包环境，30 秒后）
  if (app.isPackaged) {
    setTimeout(() => {
      void checkUpdateInternal().then((result) => {
        if (result.update) {
          win.webContents.send('update-can-available', {
            update: true,
            version: result.currentVersion,
            newVersion: result.newVersion,
            force: result.force,
            notes: result.notes,
          })
          // 非强制更新：后台静默下载；强制更新由弹窗触发
          if (!result.force) {
            void (async () => {
              try {
                const meta = lastGithubMeta || await fetchGithubReleaseViaApi()
                if (meta?.assetId) {
                  lastGithubMeta = meta
                  await downloadInstallerViaApi(meta, win)
                }
              }
              catch (e) {
                win.webContents.send('update-error', { message: (e as Error).message })
              }
            })()
          }
        }
      })
    }, 30_000)
  }
}
