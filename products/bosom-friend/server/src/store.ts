/* oxlint-disable no-non-null-assertion, restrict-plus-operands, no-unnecessary-condition, no-unnecessary-type-conversion, no-unnecessary-type-assertion, no-unnecessary-type-parameters, require-await, @stylistic/max-len -- 结构保证型规则：路由段由匹配器确保存在、JSON 文件由 JsonFile 确保可读；中文文案/资源 URL 为长单串，属产品文案而非可拆分语句 */
/**
 * Bosom Friend后端文件持久层。全部状态落盘于 dataRoot/bosom-friend/ 下的 JSON 文件，
 * 写入经临时文件原子替换；进程内单实例使用，读路径常驻内存、写后即刷盘。
 * @module @deepseek-ai/dsh-bosom-friend-server/store
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import type {
  NotificationRecord,
  ReceptionPendingItem,
  ReceptionReplyRecord,
  ReceptionRule,
  ReceptionStatus,
  ShareLinkRecord,
  ZyAccountUser,
  ZyAccountGroup,
  ZyAgentTask,
  ZyContentRecord,
  ZyDigitalHuman,
  ZyDraftGenerationTask,
  ZyLongVideoTask,
  ZyMaterialGroup,
  ZyMetricRow,
  ZyPublishRecord,
  ZySocialAccount,
  ZySession,
  ZyUser,
} from './types.ts'

/** 存储信封版本号：预发布立场，旧格式无兼容承诺。 */
const STORE_SCHEMA_VERSION = 1

/**
 * 内容域默认素材组 id：内容创作只有一个持久化素材组，所有内容域写入的缺省归属都用它。
 *  **不可与账号分组 id 空间（`grp-default`）互换** —— 两者语义不同，混用会让写入的内容
 *  在「按当前素材组查询」的列表里不可见（上传成功却查不到）。
 */
export const DEFAULT_MATERIAL_GROUP_ID = 'mg-persist'

interface StoreEnvelope {
  schemaVersion: number
  value: unknown
}

function isEnvelope(value: unknown): value is StoreEnvelope {
  return typeof value === 'object' && value !== null && 'schemaVersion' in value && 'value' in value
}

/** 产品长任务记录（登录/发布/同步/客服等外部副作用任务）。 */
export interface ZyJobRecord {
  id: string
  kind: string
  params: Record<string, unknown>
  status: 'queued' | 'running' | 'success' | 'failed' | 'cancelled'
  attempt: number
  maxRetries: number
  lastError?: string
  result?: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

/**
 * 一个持久化 JSON 文件的读写封装：schema 信封 + fsync + 临时文件原子替换。
 * 旧平铺格式自动迁移（首次保存时写为新信封），读路径惰性加载。
 *
 * 同源保证（2026-09-07 账号线修复）：openStore 每次调用产生独立实例（server 与
 * kernel 各一套），纯内存缓存会让「A 实例写、B 实例永远读旧值」直到重启。
 * 因此 load() 以文件 mtime 为再校验键——磁盘变了就重读，磁盘没变才走缓存；
 * save() 写盘后记录新 mtime。磁盘文件是唯一事实源。
 */
export class JsonFile<T> {
  private cached: T | undefined
  /** 缓存对应的文件 mtime；-1 表示文件当时不存在。 */
  private cachedMtime = -2
  private readonly file: string
  private readonly fallback: () => T

  constructor(file: string, fallback: () => T) {
    this.file = file
    this.fallback = fallback
  }

  /** 当前文件 mtime；文件不存在返回 -1，stat 失败返回 -1（按缺失处理）。 */
  private fileMtime(): number {
    try {
      return statSync(this.file).mtimeMs
    }
    catch {
      return -1
    }
  }

  load(): T {
    const mtime = this.fileMtime()
    if (this.cached !== undefined && mtime === this.cachedMtime) return this.cached
    if (!existsSync(this.file)) {
      // 文件不存在且缓存曾以"不存在"建立时直接复用，避免每次请求重复落初始值。
      if (this.cached !== undefined && this.cachedMtime === -1) return this.cached
      this.cached = this.fallback()
      this.cachedMtime = -1
      return this.cached!
    }
    this.cachedMtime = mtime
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      if (isEnvelope(parsed)) {
        // 版本不符按空态重建：预发布立场，旧格式无兼容承诺。
        this.cached = parsed.schemaVersion === STORE_SCHEMA_VERSION ? parsed.value as T : this.fallback()
      } else {
        // 旧平铺格式：按当前数据读取，首次保存时升级为信封格式。
        this.cached = parsed as T
      }
    } catch (error) {
      // 损坏必须可见：静默按空态重建会让下一次 save 把空态写回，造成不可逆数据丢失
      // （2026-09-09 账号数据事故即此路径）。原地保留损坏文件并抛错，由调用方如实呈现。
      const detail = error instanceof Error ? error.message : String(error)
      this.cached = undefined
      this.cachedMtime = -2
      throw new Error(
        `数据文件损坏，拒绝按空态继续（继续会覆盖并永久丢失）：${this.file}；原因：${detail}。`
        + '损坏文件未被修改，请先备份再处理。',
      )
    }
    return this.cached!
  }

  save(value: T): void {
    this.cached = value
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
    const serialized = JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION, value }, null, 2) + '\n'
    const fd = openSync(tmp, 'w')
    try {
      writeFileSync(fd, serialized, 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, this.file)
    // 写后回读：rename 成功不等于内容正确（磁盘满、权限异常、并发覆盖都会出问题）。
    // 逐字比对写入内容；校验失败必须抛错——假成功比失败更危险，它会让上层以为数据已安全落盘。
    const readBack = readFileSync(this.file, 'utf8')
    if (readBack !== serialized) {
      this.cached = undefined
      this.cachedMtime = -2
      throw new Error(
        `写后回读校验失败：${this.file} 的内容与本次写入不一致（可能被并发覆盖或磁盘异常）。`
        + '本次写操作未生效，请重试或检查磁盘与并发写入方。',
      )
    }
    // rename 后记录新 mtime，避免本实例下一次 load 误判磁盘变化。
    this.cachedMtime = this.fileMtime()
  }
}

/**
 * 按 generationId 过滤关联产物：删除生成记录时同步移除挂靠其下的推广与素材。
 * 纯函数，供 API 与单测共用，保证“三处一致”只有一份实现。
 */
export function filterGenerationArtifacts<T extends { metadata?: unknown }>(
  ids: ReadonlySet<string>,
  items: T[],
): T[] {
  return items.filter((item) => {
    const generationId = (item.metadata as { generationId?: unknown } | undefined)?.generationId
    return !(typeof generationId === 'string' && ids.has(generationId))
  })
}

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * 打开数据目录并返回共享状态仓。channels 为内置常量表（渠道元数据），
 * 其余各域持久化；token 随 user.json 持久化，重启后登录态不失效。
 * @param dataRoot - 数据根目录（插件 config.dataRoot）。
 */
export function openStore(dataRoot: string) {
  // dataRoot 由产品独立根（组合层 DSH_HOME=~/.bosom-friend）解析 dshHomePath('bosom-friend') 提供，不再叠加子目录。产品不读 ~/.dsh。
  const dir = dataRoot
  mkdirSync(dir, { recursive: true })
  const f = (name: string): string => join(dir, name)

  const files = {
    user: new JsonFile<ZyUser & { token: string }>(f('user.json'), () => ({
      createdAt: nowIso(),
      id: 'zy-user-001',
      _id: 'zy-user-001',
      name: 'Bosom Friend客户端',
      mail: 'dev@bosomfriend.local',
      phone: '13800000000',
      password: '',
      salt: '',
      status: 1,
      avatar: '',
      score: 1000,
      income: 0,
      updateTime: nowIso(),
      token: randomUUID().replaceAll('-', ''),
    })),
    users: new JsonFile<ZyAccountUser[]>(f('users.json'), () => []),
    sessions: new JsonFile<ZySession[]>(f('sessions.json'), () => []),
    accounts: new JsonFile<ZySocialAccount[]>(f('accounts.json'), () => []),
    groups: new JsonFile<ZyAccountGroup[]>(f('account-groups.json'), () => [
      { id: 'grp-default', name: '默认分组', rank: 0, isDefault: true, createdAt: nowIso() },
    ]),
    tasks: new JsonFile<ZyAgentTask[]>(f('agent-tasks.json'), () => []),
    contents: new JsonFile<ZyContentRecord[]>(f('contents.json'), () => []),
    materialGroups: new JsonFile<ZyMaterialGroup[]>(f('material-groups.json'), () => []),
    metrics: new JsonFile<ZyMetricRow[]>(f('metrics.json'), () => []),
    records: new JsonFile<ZyPublishRecord[]>(f('publish-records.json'), () => []),
    generations: new JsonFile<ZyDraftGenerationTask[]>(f('draft-generations.json'), () => []),
    digitalHumans: new JsonFile<ZyDigitalHuman[]>(f('digital-humans.json'), () => []),
    longVideoTasks: new JsonFile<ZyLongVideoTask[]>(f('long-video-tasks.json'), () => []),
    receptionRules: new JsonFile<ReceptionRule[]>(f('reception-rules.json'), () => [
      { id: 'rule-default-1', name: '发货规则', platforms: ['douyin', 'xhs'], keywords: ['发货', '物流', '什么时候到'], replyMode: 'template', template: '您好，您的订单通常在 48 小时内发出，可在订单详情查看物流；超时可联系人工客服。', enabled: true, priority: 10, createdAt: nowIso(), updatedAt: nowIso() },
      { id: 'rule-default-2', name: '价格规则', platforms: ['douyin', 'xhs'], keywords: ['价格', '多少钱', '优惠'], replyMode: 'template', template: '当前价格与优惠以商品页为准，新客关注店铺可领专属券～', enabled: true, priority: 20, createdAt: nowIso(), updatedAt: nowIso() },
    ]),
    receptionSeen: new JsonFile<Record<string, string>>(f('reception-seen.json'), () => ({})),
    receptionPending: new JsonFile<ReceptionPendingItem[]>(f('reception-pending.json'), () => []),
    receptionReplies: new JsonFile<ReceptionReplyRecord[]>(f('reception-replies.json'), () => []),
    shareLinks: new JsonFile<ShareLinkRecord[]>(f('share-tokens.json'), () => []),
    receptionStatus: new JsonFile<ReceptionStatus>(f('reception-status.json'), () => ({
      enabled: true,
      running: false,
      lastPollAt: null,
      rounds: 0,
      accounts: [],
      nextPollAt: null,
      config: {
        intervalMinutes: 10,
        maxRepliesPerRound: 3,
        seenWindowMinutes: 7 * 24 * 60,
        cooldownMinutes: 30,
        maxPendingPerRound: 3,
      },
    })),
    prefs: new JsonFile<{ disclaimerAccepted?: boolean }>(f('prefs.json'), () => ({})),
    logs: new JsonFile<{ date: string; kind: string; detail: string }[]>(f('ai-logs.json'), () => []),
    notifications: new JsonFile<NotificationRecord[]>(f('notifications.json'), () => []),
    jobs: new JsonFile<ZyJobRecord[]>(f('job-queue.json'), () => []),
    knowledge: new JsonFile<{
      notes: Record<string, { name: string; content: string; protected?: boolean }>
      vault: { path: string; builtIn: boolean }
      /** 蒸馏样本：每次生成留一条可微调 / 可少样本 / 可复盘的记录。 */
      distillations?: {
        id: string
        task: string
        instruction: string
        output: string
        model: string
        knowledgePaths: string[]
        knowledgeChars: number
        status: 'success' | 'failed' | 'partial'
        rating: number
        createdAt: string
        sourceId: string
      }[]
      /** 累计命中知识注入的生成次数（知识库是否真被用上的观测值）。 */
      injectedCount?: number
    }>(f('knowledge.json'), () => ({
      notes: {
        '欢迎使用 Bosom Friend 知识库.md': {
          name: '欢迎使用 Bosom Friend 知识库',
          content: '# 欢迎使用 Bosom Friend 知识库\n\n这里用于保存你的项目知识、产品资料和运营素材。\n\n- 左侧搜索可快速查找笔记；\n- 中间支持 Markdown 编辑与预览；\n- 使用 `[[笔记名]]` 可建立双向链接。\n',
        },
      },
      vault: { path: '', builtIn: true },
    })),
  }

  /** 初始账号分组存在性保证（删除最后一个分组时前端列表页仍可用）。 */
  function ensureDefaultGroup(): void {
    const groups = files.groups.load()
    if (!groups.some(g => g.isDefault)) {
      groups.unshift({ id: 'grp-default', name: '默认分组', rank: 0, isDefault: true, createdAt: nowIso() })
      files.groups.save(groups)
    }
  }

  ensureDefaultGroup()

  /** 唯一素材组种子：内容创作仅保留一个「持久化素材组」，清空数据后自动重建。 */
  function ensurePersistentMaterialGroup(): void {
    const groups = files.materialGroups.load()
    if (groups.length === 0) {
      groups.unshift({
        id: DEFAULT_MATERIAL_GROUP_ID,
        name: '持久化素材组',
        title: '持久化素材组',
        desc: '',
        platform: '',
        useScene: '',
        useSceneRelId: '',
        createdAt: nowIso(),
        updatedAt: nowIso(),
        mediaCount: 0,
      })
      files.materialGroups.save(groups)
    }
  }

  ensurePersistentMaterialGroup()

  return {
    files,
    channels: [
      {
        platform: 'xhs',
        displayName: '小红书',
        authType: 'browser',
        editor: 'text',
      },
      {
        platform: 'douyin',
        displayName: '抖音',
        authType: 'browser',
        editor: 'text',
      },
      {
        platform: 'wxSph',
        displayName: '视频号',
        authType: 'browser',
        editor: 'text',
      },
      {
        platform: 'wxGzh',
        displayName: '公众号',
        authType: 'browser',
        editor: 'markdown',
      },
      {
        platform: 'bilibili',
        displayName: 'B站',
        authType: 'browser',
        editor: 'text',
      },
      {
        platform: 'KWAI',
        displayName: '快手',
        authType: 'browser',
        editor: 'text',
      },
    ],
    nowIso,
  }
}

export type ZyStore = ReturnType<typeof openStore>
