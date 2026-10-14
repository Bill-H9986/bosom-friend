/**
 * 版本清单检查（最小更新检查）：只做「发现新版本 + 给出下载地址」，不下载、不安装。
 *
 * 为什么独立成模块：main.cjs 是 Electron 主进程入口，里面全是流水线编排，塞不进纯逻辑；
 * 而版本比较是纯函数，必须能单独测（见 packages 侧的同款约定：默认值是显式的 resolve 步骤）。
 *
 * 清单格式（发布方放在任意静态地址上，例如 GitHub Release 的 version.json）：
 *   { "version": "0.2.60", "url": "https://…/BosomFriend-Setup-0.2.60.exe", "notes": "可选", "minimum": "0.2.50" }
 */
'use strict'

/** 版本号里允许出现的形态：0.2.59 / 0.2.59-rc.1 / v0.2.59。 */
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-.]([0-9A-Za-z.-]+))?$/

/**
 * 解析版本号。
 *
 * @param {unknown} text - 待解析的版本字符串。
 * @returns {{ major: number, minor: number, patch: number, prerelease: string } | null} 解析结果；非法返回 null。
 */
function parseVersion(text) {
  const raw = String(text ?? '').trim()
  const match = VERSION_RE.exec(raw)
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? '',
  }
}

/**
 * 比较两个版本号。
 *
 * 规则按 semver 的实用子集：先比三段数字，数字相同再看预发布标签——**有预发布标签的更小**
 * （0.2.59-rc.1 < 0.2.59），这是"发布候选不能被当成正式版"那条口径。
 *
 * @param {unknown} a - 左侧版本。
 * @param {unknown} b - 右侧版本。
 * @returns {number} a>b 返回 1，a<b 返回 -1，相等返回 0；任一无法解析时返回 0（宁可说"没有更新"，也不误报）。
 */
function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) return 0
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1
  }
  if (left.prerelease === right.prerelease) return 0
  if (left.prerelease === '') return 1
  if (right.prerelease === '') return -1
  return left.prerelease > right.prerelease ? 1 : -1
}

/**
 * 拉取并核对版本清单。
 *
 * 失败一律**如实回报**（网络错误、非 2xx、JSON 不合法、清单缺 version），绝不假装"已是最新版本"——
 * "假成功"比失败更糟：用户会以为更新检查过、其实什么都没查。当前版本比清单里的还新时同样说清楚
 * （本地跑的是未发布的构建），而不是含糊地报"有更新"。
 *
 * @param {{ currentVersion: string, manifestUrl: string, fetchImpl?: typeof fetch, timeoutMs?: number }} options - 检查参数。
 * @returns {Promise<object>} { update, currentVersion, newVersion?, url?, notes?, force?, reason?, message? }。
 */
async function checkForUpdate(options) {
  const currentVersion = String(options.currentVersion ?? '')
  const manifestUrl = String(options.manifestUrl ?? '').trim()
  const doFetch = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 8000
  if (manifestUrl === '') {
    return { update: false, currentVersion, reason: 'error', message: '没有配置版本清单地址' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await doFetch(manifestUrl, { signal: controller.signal, headers: { accept: 'application/json' } })
  }
  catch (error) {
    clearTimeout(timer)
    const reason = error instanceof Error && error.name === 'AbortError' ? '超时' : '网络不可达'
    return { update: false, currentVersion, reason: 'error', message: '检查更新失败：' + reason }
  }
  finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    return { update: false, currentVersion, reason: 'error', message: '检查更新失败：版本清单返回 HTTP ' + String(response.status) }
  }
  let manifest
  try {
    manifest = await response.json()
  }
  catch {
    return { update: false, currentVersion, reason: 'error', message: '检查更新失败：版本清单不是合法 JSON' }
  }
  const latest = String(manifest?.version ?? '').trim()
  if (parseVersion(latest) === null) {
    return { update: false, currentVersion, reason: 'error', message: '检查更新失败：版本清单缺少合法版本号' }
  }
  const url = String(manifest?.url ?? '').trim()
  const comparison = compareVersions(latest, currentVersion)
  if (comparison > 0) {
    const minimum = String(manifest?.minimum ?? '').trim()
    return {
      update: true,
      currentVersion,
      newVersion: latest.replace(/^v/, ''),
      url,
      notes: String(manifest?.notes ?? '').trim(),
      force: minimum !== '' && compareVersions(currentVersion, minimum) < 0,
      reason: 'update-available',
    }
  }
  if (comparison < 0) {
    return { update: false, currentVersion, newVersion: latest.replace(/^v/, ''), reason: 'ahead', message: '本地版本（' + currentVersion + '）比版本清单还新，可能跑的是未发布的构建' }
  }
  return { update: false, currentVersion, newVersion: latest.replace(/^v/, ''), reason: 'up-to-date' }
}

module.exports = { compareVersions, parseVersion, checkForUpdate }
