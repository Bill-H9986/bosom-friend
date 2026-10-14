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

/**
 * 平台内容上限：**只登记有出处的数字**，没有出处的宁可不报。
 *
 * 这里此前是"所有平台同一套"（正文 5000、图片 9、话题 10）——谁也不是真的：
 * 模型侧的约束语境写的是「小红书正文不超过 1000 字」，而界面按 5000 放开，
 * **用户按 5000 写、平台按 1000 收**（缺陷台账 DEF-153）。
 * 引擎源码里根本没有这些常量，所以从今天起：有据可查的写在这里，其余的**不报**——
 * 让界面显示"未声明"，而不是显示一个用户会照着写的假上限。
 */
export const PLATFORM_CONTENT_LIMITS: Record<string, {
  /**
   * 平台显示名。
   *
   * 与平台目录里的名字**会漂移**（目录来自引擎扫描），所以判据里有一条：
   * 两边同平台的名字必须一致——不一致就判红，而不是等用户看到两个名字。
   */
  name?: string
  /** 正文上限（字）。 */
  body?: number
  /** 话题数量上限（个）。 */
  topics?: number
  /**
   * 标题上限（字）。
   *
   * 只登记**有实测或权威出处**的数字。抖音 20 字来自引擎拒绝原文
   * （2026-10-11 任务 pub-xdo2q1qx：「标题不能超过20字符，当前: 21字符」）。
   *
   * 注意这是**同一事实的第二处呈现**：《站内规则表》（agent-rules.ts）里也曾写过一个数字，
   * 而且写错了（≤30 字，无出处），于是模型照着 30 写、引擎按 20 拒收（DEF-253）。
   * 两处的一致性由 qa/verify-platform-rules.mjs 校验——数字可以有第二处，但不能有两个真相。
   */
  title?: number
}> = {
  // 小红书：**两个数字的来源性质不同，不能一概而论**（2026-10-09 来源审查，缺陷台账 DEF-238）：
  //   - body 1000 字：产品口径（来源含 agent-rules.ts 的站内规则表），**不是平台官方限制**；
  //   - topics：**已于 2026-10-09 退役**（产品决策）。原值 10 是来源未定的历史遗留值 ——
  //     DEF-153 曾判定旧「所有平台同一套」常量「谁也不是真的」，把它迁进本表不会自动获得可信度。
  //     它曾同时影响**发布前校验、AI 批量生成提示词与 UI 展示**三条路径，现已退出当前有效限制配置；
  //     历史证据保留在缺陷台账 DEF-238（不在此处留值，避免被再次当作现行上限）。
  //     **平台是否真有话题数量限制，仍需权威规则或受控实测确认——本表的移除不等于平台接受任意数量。**
  xhs: { name: '小红书', body: 1000 },
  // 抖音：标题 20 字来自**引擎实测拒绝原文**（非官方文档），见 title 字段说明。
  // 其余项（正文/话题）平台未声明，故不登记——宁可显示"未声明"，也不给一个用户会照着写的假上限。
  douyin: { name: '抖音', title: 20 },
}

/** 取某平台已声明的上限；未登记时返回空对象（调用方据此"不报"，而不是编一个）。 */
export function platformContentLimits(platform: string): { name?: string, body?: number, topics?: number, title?: number } {
  return PLATFORM_CONTENT_LIMITS[platform] ?? {}
}

/** 取某平台已声明的**标题**上限；未登记时返回 undefined（调用方据此"不报"，而不是编一个）。 */
export function platformTitleLimit(platform: string): number | undefined {
  return PLATFORM_CONTENT_LIMITS[platform]?.title
}

/** 已声明正文上限的平台（给约束语境渲染用；顺序按平台 id 稳定）。 */
export function declaredBodyLimits(): Array<{ platform: string, name: string, body: number }> {
  return Object.entries(PLATFORM_CONTENT_LIMITS)
    .filter(([, item]) => typeof item.body === 'number')
    .map(([platform, item]) => ({ platform, name: item.name ?? platform, body: item.body as number }))
}

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
const CLI_ACTIONS = readCliActions()
const ENGINE_TO_CLI = readEngineToCli()
const ENGINE_KEY_BY_PLATFORM: Record<string, string> = {}

/**
 * engineKey → 统一发布 CLI 的 parser 名。
 *
 * `sau_cli.py` 注册的是 `xiaohongshu`/`kuaishou`，而产品侧 engineKey 是 `xhs`/`KWAI` ——
 * 不做这层转换就会查不到 action，从而**误判平台不支持某内容形态**。
 * 映射的权威定义在 `engine/worker.py` 的 `CLI_PLATFORM_MAP`，本函数只读取它。
 *
 * @returns engineKey → CLI parser 名
 */
function readEngineToCli(): Record<string, string> {
  const out: Record<string, string> = {}
  const workerPath = join(UPLOADER_ROOT, '..', '..', 'worker.py')
  if (!existsSync(workerPath))
    return out
  const src = readFileSync(workerPath, 'utf8')
  const block = /CLI_PLATFORM_MAP\s*=\s*\{([^}]*)\}/s.exec(src)?.[1]
  if (block === undefined)
    return out
  for (const m of block.matchAll(/"([\w]+)"\s*:\s*"([\w]+)"/g)) {
    const from = m[1] ?? ''
    const to = m[2] ?? ''
    if (from !== '' && to !== '')
      out[from] = to
  }
  return out
}
/**
 * 统一发布 CLI 实际注册的 action（平台 → action 名）。
 *
 * 内容形态的**唯一机器事实来源**：`sau_cli.py` 里 `X_actions.add_parser("...")` 的注册结果。
 * 类名（如 `TencentNote`）只能作为实现线索——它有骨架但 CLI 未注册 `upload-note`，
 * 就不该被宣称为可发布的图文能力。
 *
 * @returns engineKey → action 名数组
 */
function readCliActions(): Record<string, string[]> {
  const actions: Record<string, string[]> = {}
  const cliPath = join(UPLOADER_ROOT, '..', 'sau_cli.py')
  if (!existsSync(cliPath))
    return actions
  let current: string | null = null
  for (const line of readFileSync(cliPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*[\w]+\s*=\s*([\w.]+)\.add_parser\(\s*["']([\w-]+)["']/.exec(line)
    if (!m)
      continue
    const base = m[1] ?? ''
    const name = m[2] ?? ''
    if (base === '' || name === '')
      continue
    if (base === 'platform_parsers') { current = name; actions[current] = []; continue }
    const ownerName = /^(\w+)_actions$/.exec(base)?.[1]
    if (ownerName !== undefined && actions[ownerName] !== undefined && /^(upload|post|publish)/.test(name))
      actions[ownerName].push(name)
  }
  return actions
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
    // 内容形态取自**统一发布 CLI 实际注册的 action**（机器事实），不再用类名推导：
    // `TencentNote` 有骨架但 CLI 未注册 `upload-note`，宣称图文就是承诺做不到的能力。
    const cliName = ENGINE_TO_CLI[preset.engineKey] ?? preset.engineKey
    const actions = CLI_ACTIONS[cliName] ?? []
    const publish: Array<'video' | 'image_text'> = []
    if (actions.some(action => /video/i.test(action)))
      publish.push('video')
    if (actions.some(action => /note|image/i.test(action)))
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