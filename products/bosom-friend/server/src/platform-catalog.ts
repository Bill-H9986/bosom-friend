/**
 * 平台目录自动发现：扫描 social-auto-upload 的 uploader/*_uploader 源码，
 * 通过函数/类命名推断 auth、video、image_text 能力，输出统一运行时清单。
 * 产品层不维护每平台硬编码分支；新增平台由开源引擎模块带入。
 * 引擎还没有模块的计划平台（见 PLANNED_PLATFORMS）以 coming_soon 一并列出，供「添加频道」标注即将支持。
 * @module @deepseek-ai/dsh-bosom-friend-server/platform-catalog
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { engineVendorRoot } from './engine-root.ts'

/** 平台可用性：引擎已带模块 = available；产品已列入清单但引擎模块未落地 = coming_soon。 */
export type PlatformAvailability = 'available' | 'coming_soon'

/**
 * 产品真实作为「频道」接入的平台（单一权威）。
 *
 * 引擎能做的平台比产品愿意暴露的多得多：目录接口若把引擎全量能力当成产品能力下发，
 * 就是在宣称尚未实现的能力。所以目录同时报告两件事——
 * 「引擎能做什么」（auth/publish 正则扫描）与「产品是否把它作为频道开放」（本清单，channel 字段）。
 * 前端只认 channel，不再自己维护第二份白名单。
 */
export const PRODUCT_CHANNEL_PLATFORMS: readonly string[] = [
  'xhs', 'douyin', 'KWAI', 'wxSph',
  // 2026-09-12 接通：这四个平台的登录回调只回 image_path（image_data_url 恒为空串），
  // worker 以前只读 image_data_url，于是永远停在「未获取到平台二维码」。
  // 修好后实测量到真二维码，且 sau CLI 已注册它们的发布动作。
  'alipay', 'baijiahao', 'weibo', 'hupu',
  // B 站：引擎只有 biliup CLI 包装、没有登录函数，扫码登录由 bilibili_uploader/login.py
  // 按 B 站 passport 接口补上（实测出真二维码）；发布走随包的 biliup 二进制。
  'bilibili',
]

export interface PlatformCatalogItem {
  platform: string
  engineKey: string
  name: string
  auth: boolean
  publish: Array<'video' | 'image_text'>
  data: boolean
  editor: 'normal' | 'text'
  status: PlatformAvailability
  /** 产品是否把它作为频道开放；引擎带模块但产品未接通的平台为 false。 */
  channel: boolean
}

const ENGINE_ROOT = engineVendorRoot()
const UPLOADER_ROOT = join(ENGINE_ROOT, 'uploader')

const PLATFORM_KEYS: Record<string, { platform: string; engineKey: string; name: string }> = {
  xiaohongshu_uploader: { platform: 'xhs', engineKey: 'xhs', name: '小红书' },
  xhs_uploader: { platform: 'xhs', engineKey: 'xhs', name: '小红书' },
  douyin_uploader: { platform: 'douyin', engineKey: 'douyin', name: '抖音' },
  ks_uploader: { platform: 'KWAI', engineKey: 'ks', name: '快手' },
  tencent_uploader: { platform: 'wxSph', engineKey: 'tencent', name: '视频号' },
  bilibili_uploader: { platform: 'bilibili', engineKey: 'bilibili', name: '哔哩哔哩' },
  baijiahao_uploader: { platform: 'baijiahao', engineKey: 'baijiahao', name: '百家号' },
  alipay_uploader: { platform: 'alipay', engineKey: 'alipay', name: '支付宝生活号' },
  weibo_uploader: { platform: 'weibo', engineKey: 'weibo', name: '微博' },
  hupu_uploader: { platform: 'hupu', engineKey: 'hupu', name: '虎扑' },
  // TikTok 与 YouTube 不在产品范围内：产品只做国内平台。引擎目录里仍有这两个
  // uploader 模块（vendored 上游代码），但不登记即不出现在目录接口与界面。
}

/**
 * 已列入产品清单、但引擎还没带 uploader 模块的平台。
 *
 * 它们照常出现在「添加频道」里并标注「即将支持」：用户能看到路线图，也不会因为
 * 点了却发不出去而以为产品坏了。引擎补上同名 uploader 目录后自动转为 available。
 */
const PLANNED_PLATFORMS: Array<{ dir: string; preset: { platform: string; engineKey: string; name: string } }> = [
  { dir: 'xianyu_uploader', preset: { platform: 'xianyu', engineKey: 'xianyu', name: '闲鱼' } },
]

/**
 * 引擎带模块、但产品确认尚不可用的平台：报 coming_soon，前端置灰并提示「即将支持」。
 *
 * 闲鱼：登录入口可用（playwright 1169 已随包），但 social-auto-upload 的统一发布 CLI
 * 没有注册 xianyu，登进去也发不出去。等上游补上 `sau xianyu upload-*` 后从这里移除。
 * （它原先的原因是随包只带 patchright 1208、缺 playwright 1169，已由
 * build-engine-portable.ps1 同时打包两套浏览器修掉。）
 */
const ENGINE_PRESENT_BUT_NOT_READY: readonly string[] = ['xianyu']

/**
 * 引擎真的有可用登录入口的平台（`worker.load_modern_login` 的 module_paths 镜像）。
 *
 * 目录扫描用 `cookie_gen(/_setup(` 正则推断 auth，会把只有上传代码的平台也算成能登录：
 * bilibili_uploader 走 biliup CLI、没有任何登录函数，正则却判它 auth=true，
 * 用户点进去只会拿到「不支持的登录平台」。这里以实际可用的登录入口为准。
 */
const ENGINE_LOGIN_PLATFORMS: readonly string[] = [
  'xhs', 'douyin', 'KWAI', 'wxSph', 'baijiahao', 'alipay', 'weibo', 'hupu', 'xianyu', 'bilibili',
]

/**
 * 引擎统一发布 CLI（social-auto-upload/sau_cli.py）已注册的平台。
 *
 * 不在内的平台只能登录、不能发布：tiktok 与 xianyu 尚未在 CLI 注册。
 */
const ENGINE_PUBLISH_PLATFORMS: readonly string[] = [
  'xhs', 'douyin', 'KWAI', 'wxSph', 'bilibili', 'baijiahao', 'alipay', 'weibo', 'hupu',
]

/** 引擎目录名 → 平台登记；计划平台也在这张表里，模块一落地就与既有平台走同一条发现路径。 */
function presetForDir(dir: string): { platform: string; engineKey: string; name: string } | undefined {
  return PLATFORM_KEYS[dir] ?? PLANNED_PLATFORMS.find(planned => planned.dir === dir)?.preset
}

const DATA_CAPABLE = new Set(['xhs', 'douyin'])
const ENGINE_KEY_BY_PLATFORM: Record<string, string> = {}

function readModuleText(dir: string): string {
  const files = ['main.py', 'main_chrome.py']
  for (const file of files) {
    const path = join(dir, file)
    if (existsSync(path))
      return readFileSync(path, 'utf8')
  }
  return ''
}

function dirPriority(name: string): number {
  if (name === 'xiaohongshu_uploader') return 0
  if (name === 'xhs_uploader') return 1
  return 2
}

export function discoverPlatformCatalog(): PlatformCatalogItem[] {
  const items: PlatformCatalogItem[] = []
  if (existsSync(UPLOADER_ROOT))
    collectEnginePlatforms(items)
  appendPlannedPlatforms(items)
  return items
}

/** 扫描引擎 uploader 目录，登记已落地的平台。 */
function collectEnginePlatforms(items: PlatformCatalogItem[]): void {
  const dirs = readdirSync(UPLOADER_ROOT, { withFileTypes: true })
    .filter(dir => dir.isDirectory())
    .sort((left, right) => dirPriority(left.name) - dirPriority(right.name))
  for (const dir of dirs) {
    if (!dir.isDirectory())
      continue
    const preset = presetForDir(dir.name)
    if (!preset)
      continue
    if (items.some(item => item.platform === preset.platform))
      continue
    const source = readModuleText(join(UPLOADER_ROOT, dir.name))
    const publish: Array<'video' | 'image_text'> = []
    if (/class\s+\w*Video/.test(source))
      publish.push('video')
    if (/class\s+\w*Note/.test(source) || /class\s+\w*Image/.test(source))
      publish.push('image_text')
    items.push({
      platform: preset.platform,
      engineKey: preset.engineKey,
      name: preset.name,
      auth: ENGINE_LOGIN_PLATFORMS.includes(preset.platform),
      // 扫描出的内容形态只在平台真的能发布时才有意义：xianyu/tiktok 扫描得到
      // video 类，但发布 CLI 没注册，报 supported 就是宣称做不到的能力。
      publish: ENGINE_PUBLISH_PLATFORMS.includes(preset.platform)
        ? (publish.length > 0 ? publish : ['video'])
        : [],
      data: DATA_CAPABLE.has(preset.platform),
      editor: preset.platform === 'xhs' ? 'text' : 'normal',
      status: ENGINE_PRESENT_BUT_NOT_READY.includes(preset.platform) ? 'coming_soon' : 'available',
      channel: PRODUCT_CHANNEL_PLATFORMS.includes(preset.platform),
    })
    ENGINE_KEY_BY_PLATFORM[preset.platform] = preset.engineKey
  }
}

/** 补齐引擎尚未提供模块的计划平台（去重后追加在已落地平台之后）。 */
function appendPlannedPlatforms(items: PlatformCatalogItem[]): void {
  for (const planned of PLANNED_PLATFORMS) {
    if (items.some(item => item.platform === planned.preset.platform))
      continue
    items.push({
      platform: planned.preset.platform,
      engineKey: planned.preset.engineKey,
      name: planned.preset.name,
      auth: false,
      publish: [],
      data: false,
      editor: 'normal',
      status: 'coming_soon',
      channel: PRODUCT_CHANNEL_PLATFORMS.includes(planned.preset.platform),
    })
  }
}

export function engineKeyForPlatform(platform: string): string | undefined {
  const item = discoverPlatformCatalog().find(entry => entry.platform === platform)
  return item?.engineKey
}

export function platformCatalog(): PlatformCatalogItem[] {
  return discoverPlatformCatalog()
}
