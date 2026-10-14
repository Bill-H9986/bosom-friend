/**
 * Bosom Friend后端文件持久层。全部状态落盘于 dataRoot/bosom-friend/ 下的 JSON 文件，
 * 写入经临时文件原子替换；进程内单实例使用，读路径常驻内存、写后即刷盘。
 * @module @deepseek-ai/dsh-bosom-friend-server/store
 */

import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
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
import type { AccountFact } from './types.ts'
import type { KnowledgeState } from './knowledge-distill.ts'
import { defaultAutoTaskState, type AutoTaskState } from './auto-tasks.ts'

/** 存储信封版本号：预发布立场，旧格式无兼容承诺。 */
const STORE_SCHEMA_VERSION = 1

/** 平铺格式（没有 `{ schemaVersion, value }` 信封）的版本号。 */
const FLAT_LEGACY_VERSION = 0

/** 一步迁移：把「源版本」的值升到「源版本 + 1」。 */
type StoreMigration = (value: unknown) => unknown

/**
 * 版本迁移链：键 = 源版本号，值 = 升一级的迁移函数。
 *
 * 为什么必须有：`schemaVersion` 只有配上迁移链才算数。此前版本不符时直接「按空态重建」，
 * 用户看到的是**一夜之间变空的库**而不是一次升级；而降级安装（文件版本比程序新）更糟——
 * 空态被写回就永久丢了。现在：低版本逐级迁移，高版本抛错保留现场。
 */
const MIGRATIONS: Record<number, StoreMigration> = {
  // 0 → 1：v1 之前是平铺 JSON（值直接写在文件里）。值本身不变，只是补上信封。
  0: value => value,
}

/**
 * 把一份旧版本的值逐级迁移到 {@link STORE_SCHEMA_VERSION}。
 *
 * @param value - 旧版本的值。
 * @param from - 旧版本号。
 * @param file - 文件路径（只用于报错定位）。
 * @returns 当前版本的值。
 * @throws 迁移链上缺任何一级时（缺链就抛错，绝不退回空态）。
 */
function migrateToCurrent(value: unknown, from: number, file: string): unknown {
  let version = from
  let migrated = value
  while (version < STORE_SCHEMA_VERSION) {
    const step = MIGRATIONS[version]
    if (step === undefined) {
      throw new Error(
        `数据文件 ${file} 停在版本 ${String(version)}，缺少到版本 ${String(version + 1)} 的迁移：`
        + '拒绝按空态继续（那会让用户看到一个空库）。文件未被修改。',
      )
    }
    migrated = step(migrated)
    version += 1
  }
  return migrated
}

/** 事务里被登记的文件句柄：类型参数在事务层被擦除，提交/回滚不需要知道具体的值类型。 */
interface StagedFile {
  /** 把暂存值原子落盘。 */
  commitStaged(): void
  /** 把磁盘与内存恢复成提交之前的样子。 */
  rollbackStaged(): void
  /** 事务整体成功，清掉暂存与备份。 */
  finalizeStaged(): void
}

/** 一次批量事务的暂存区：按登记顺序记录待写文件，供整体提交或整体放弃。 */
interface StoreStaging {
  readonly order: StagedFile[]
}

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

/**
 * 去掉 JSON 文本开头的 UTF-8 BOM 再交给 JSON.parse。
 *
 * BOM 不是损坏，是编辑器/脚本的默认行为：PowerShell 的 `Set-Content`/`Out-File`、记事本另存为
 * "UTF-8" 都会在文件头写 EF BB BF。`JSON.parse` 见到它就整份拒绝，于是"内容完全正确、只是多了三个字节"
 * 的文件被当成损坏文件，整个域读不出数据（2026-09-17：脚本清理素材后 contents.json 带 BOM，
 * 素材组接口全线不可用）。
 *
 * @param raw - 文件原文。
 * @returns 去掉首个 BOM 字符的文本。
 */
function stripBom(raw: string): string {
  return raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw
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
 * 因此 load() 每次都要确认"磁盘还是不是缓存里那一份"：同进程看写版本号、
 * 跨进程看时效窗（{@link FRESHNESS_MS}）、再看文件指纹，最后按**内容摘要**定案；
 * save() 写盘后记录新指纹与摘要。磁盘文件是唯一事实源。
 *
 * 为什么不能只信 mtime：Windows 上 NTFS 的元数据刷新有延迟，短时间反复 rename 覆盖时
 * mtime/size 会长时间保持旧值（实测 400 次交替读写里 329 次指纹未变而内容已变）。
 */
/**
 * 进程内的写版本号：任何一个 JsonFile 实例保存一次就 +1。
 *
 * 为什么需要它：同一进程里可能同时存在多套 openStore（server 与内核宿主各一套），
 * 它们靠文件交换数据。读方如果只看文件元数据，就会在"刚写完、元数据还没刷新"的窗口里
 * 读到旧缓存——实测 400 次交替读写里有 329 次读到旧值（这正是 store-integrity 用例偶发红的根因）。
 */
let storeWriteVersion = 0

/**
 * 缓存的最长免校验时间（毫秒）。
 *
 * 跨进程写入（内核宿主与 server 各一套 openStore）改不动本进程的版本号，只能靠时效兜住：
 * 至多每 {@link FRESHNESS_MS} 毫秒真读一次盘。取 250ms 是权衡：读写比约 4 次/秒/文件，
 * 而"另一个进程刚写完要立刻看到"的场景都能落在下一个窗口内。
 */
const FRESHNESS_MS = 250

/**
 * 数据根唯一的原子替换实现：临时文件 + fsync + rename + 目录 fsync + 写后回读。
 *
 * 为什么要有这一层：`store.ts` 的 JsonFile 之外，还有一批文件（`llm-user.json`、`settings.yaml`、
 * `remote-access.json`、long-video 任务目录…）由各模块直接 `writeFileSync` 到数据根。
 * 直接写意味着断电/崩溃/磁盘满时会留下**半截文件**，而 JSON 半截 = 整份读不出（store 的
 * 损坏守卫会拒绝启动该域）。所有落到数据根的写入都必须经过这里，只有一份实现。
 *
 * @param file - 目标文件绝对路径（目录不存在时自动创建）。
 * @param content - 要写入的完整文本。
 * @throws 写后回读与本次内容不一致时（假成功比失败更危险）。
 */
export function atomicReplace(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  const fd = openSync(tmp, 'w')
  try {
    writeFileSync(fd, content, 'utf8')
    fsyncSync(fd)
  }
  finally {
    closeSync(fd)
  }
  renameSync(tmp, file)
  // 目录 fsync：文件 fsync 只保证临时文件内容落盘，rename 本身是目录项的修改。
  // 不同步目录时，断电/崩溃后可能回到旧版本——用户看到"刚保存的数据没了"。
  // 目录无法打开或 fsync（部分平台对目录句柄不支持）时跳过：此时至少内容已落盘。
  let dirFd: number | undefined
  try {
    dirFd = openSync(dirname(file), 'r')
    fsyncSync(dirFd)
  }
  catch {
    // 目录 fsync 不受支持：内容已 fsync，仅 rename 的持久性无保证
  }
  finally {
    if (dirFd !== undefined) {
      try { closeSync(dirFd) }
      catch {
        // 已关闭或句柄无效，无后续动作
      }
    }
  }
  // 写后回读：rename 成功不等于内容正确（磁盘满、权限异常、并发覆盖都会出问题）。
  const readBack = readFileSync(file, 'utf8')
  if (readBack !== content) {
    throw new Error(
      `写后回读校验失败：${file} 的内容与本次写入不一致（可能被并发覆盖或磁盘异常）。`
      + '本次写操作未生效，请重试或检查磁盘与并发写入方。',
    )
  }
}

/**
 * 原子写一个数据根 JSON 文件，**不加** store 的 schema 信封。
 *
 * 用于 `llm-user.json` 这类由产品自己定义结构、不属于 store 实体的配置文件：
 * 它们原先各处直接 `writeFileSync`，断电时会写出半截 JSON。
 *
 * @param file - 目标文件绝对路径。
 * @param value - 要写入的值（按 2 空格缩进序列化，末尾补换行）。
 */
export function writeDataJson(file: string, value: unknown): void {
  atomicReplace(file, JSON.stringify(value, null, 2) + '\n')
}

/**
 * 原子写一个数据根文本文件（settings.yaml、.credentials.yaml、标记文件等）。
 *
 * @param file - 目标文件绝对路径。
 * @param content - 要写入的完整文本。
 */
export function writeDataText(file: string, content: string): void {
  atomicReplace(file, content)
}

export class JsonFile<T> {
  private cached: T | undefined
  /** 缓存对应的文件指纹；'-1' 表示文件当时不存在，'-2' 表示"从未成功读过"。 */
  private cachedFingerprint = '-2'
  /** 缓存对应的内容摘要（sha256 十六进制）；空串表示没有有效缓存。 */
  private cachedDigest = ''
  /** 上次校验磁盘的时间（毫秒）：跨进程写入只能靠时效窗兜住。 */
  private lastCheckAt = 0
  /** 缓存建立时的进程内写版本号：同进程别的实例一写就失效。 */
  private seenWriteVersion = -1
  private readonly file: string
  private readonly fallback: () => T
  /** 事务状态访问器：由 openStore 注入；返回非 undefined 时 save/saveEmpty 只登记不落盘。 */
  private stagingOf: (() => StoreStaging | undefined) | undefined
  /** 本文件是否已在当前事务里登记过暂存值。 */
  private staged = false
  /** 事务暂存值（`staged` 为 true 时有效）。 */
  private stagedValue: T | undefined
  /** 事务开始前的缓存三元组：事务放弃时原样恢复，避免内存里留着没落盘的值。 */
  private stagedCache: { cached: T | undefined; fingerprint: string; digest: string } | undefined
  /** 提交前的磁盘原文（null = 当时文件不存在）；undefined 表示本文件没有待定提交。 */
  private committedBackup: string | null | undefined

  constructor(file: string, fallback: () => T) {
    this.file = file
    this.fallback = fallback
  }

  /**
   * 注入事务状态访问器（openStore 专用）：让一次批量写入里的所有文件共享同一个事务。
   *
   * @param accessor - 返回当前事务的暂存区；不在事务中时返回 undefined。
   */
  attachTransaction(accessor: () => StoreStaging | undefined): void {
    this.stagingOf = accessor
  }

  /**
   * 当前文件的 `mtime:size` 指纹；读不到时返回 `-1`。
   *
   * 只当快筛用：Windows 上元数据会延迟，定案靠内容摘要（见 {@link readIfChanged}）。
   *
   * @returns 指纹字符串。
   */
  private fileFingerprint(): string {
    try {
      const info = statSync(this.file)
      return String(info.mtimeMs) + ':' + String(info.size)
    }
    catch {
      return '-1'
    }
  }

  /**
   * 判断磁盘内容是否还是缓存里那一份。
   *
   * 命中要同时满足三条（任何一条不成立就重新读盘并按内容比对）：
   * 1. 同进程内**没有别的实例写过**（模块级写版本号未变）；
   * 2. 距上次校验不超过 {@link FRESHNESS_MS}（跨进程写入只能靠时效兜住）；
   * 3. 文件 `mtime:size` 与缓存记录一致。
   *
   * 为什么不只信 `mtime:size`：**Windows 上 NTFS 的元数据刷新有延迟**，短时间内反复
   * rename 覆盖时 `mtimeMs`（甚至 `size`）会长时间保持旧值——实测 400 次交替读写里
   * 329 次指纹未变而内容已变（store-integrity 用例偶发红就是这个）。所以指纹只当快筛，
   * 真正的判据是**内容摘要**：读到的字节算 sha256 与缓存记录比对。
   *
   * @returns 命中、或读到的原始内容、或文件读不到。
   */
  private readIfChanged(): { hit: true } | { hit: false, raw: string } | { hit: false, raw: null } | { hit: false, error: Error } {
    const fresh = Date.now() - this.lastCheckAt < FRESHNESS_MS
    if (this.cached !== undefined && fresh && this.seenWriteVersion === storeWriteVersion) {
      if (this.fileFingerprint() === this.cachedFingerprint) return { hit: true }
    }
    let fingerprint = '-1'
    try {
      const info = statSync(this.file)
      fingerprint = String(info.mtimeMs) + ':' + String(info.size)
    }
    catch (error) {
      // "文件不存在"与"文件读不到"是两件事，绝不能混为一谈。
      // 混了的代价实测过：首次启动时一次 EPERM/EBUSY（杀软扫描、另一个进程正在原子写）
      // 就会被当成"没有数据文件"，内存里立起一个空数组；此后任何一次 save 都把这个空数组
      // 写回盘——用户的数据文件变成恰好 40 字节的空信封，且不可逆。
      // 只有 ENOENT 才算"没有这个文件"，其余一律抛错，由调用方如实呈现。
      if (isMissingFile(error)) {
        this.lastCheckAt = Date.now()
        return { hit: false, raw: null }
      }
      return { hit: false, error: asError(error) }
    }
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf8')
    }
    catch (error) {
      if (isMissingFile(error)) {
        this.lastCheckAt = Date.now()
        return { hit: false, raw: null }
      }
      return { hit: false, error: asError(error) }
    }
    this.lastCheckAt = Date.now()
    const digest = createHash('sha256').update(raw).digest('hex')
    if (this.cached !== undefined && digest === this.cachedDigest) {
      // 内容没变，只是元数据变了：按命中处理，不重复解析。
      this.cachedFingerprint = fingerprint
      this.seenWriteVersion = storeWriteVersion
      return { hit: true }
    }
    return { hit: false, raw }
  }

  load(): T {
    // 事务里磁盘还没写：暂存值才是本进程的真相，读盘只会读回旧内容、甚至读回空文件
    // （这会连带触发下面的"文件不存在"分支，把暂存值覆盖成 fallback）。
    if (this.staged) return this.stagedValue as T
    const verdict = this.readIfChanged()
    if (verdict.hit) return this.cached!
    if ('error' in verdict) {
      // 读不到 ≠ 没数据：抛错，让调用方如实失败，而不是把空态当成事实。
      this.cached = undefined
      this.cachedFingerprint = '-2'
      this.cachedDigest = ''
      throw new Error(
        `数据文件读不到，拒绝按空态继续（继续会覆盖并永久丢失）：${this.file}；原因：${verdict.error.message}。`
        + '文件未被修改，请稍后重试或先备份再处理。',
      )
    }
    if (verdict.raw === null) {
      // 文件不存在且缓存曾以"不存在"建立时直接复用，避免每次请求重复落初始值。
      if (this.cached !== undefined && this.cachedFingerprint === '-1') return this.cached
      this.cached = this.fallback()
      this.cachedFingerprint = '-1'
      this.cachedDigest = ''
      this.seenWriteVersion = storeWriteVersion
      return this.cached!
    }
    this.cachedFingerprint = this.fileFingerprint()
    this.cachedDigest = createHash('sha256').update(verdict.raw).digest('hex')
    this.seenWriteVersion = storeWriteVersion
    this.lastCheckAt = Date.now()
    try {
      const parsed = JSON.parse(stripBom(verdict.raw)) as unknown
      if (isEnvelope(parsed)) {
        if (parsed.schemaVersion > STORE_SCHEMA_VERSION) {
          // 文件比程序新（降级安装）：唯一安全的动作是拒绝。按空态重建会让用户看到一个空库，
          // 之后任何一次 save 都可能把空态写回；抛错则文件分毫未动，升级程序后即可继续用。
          throw new Error(
            `数据文件版本比本程序新，拒绝按空态继续：${this.file}（文件版本 ${String(parsed.schemaVersion)}，`
            + `本程序认识 ${String(STORE_SCHEMA_VERSION)}）。文件未被修改，请升级程序后再打开。`,
          )
        }
        this.cached = migrateToCurrent(parsed.value, parsed.schemaVersion, this.file) as T
      } else {
        // 平铺格式（版本 0）：走同一条迁移链，首次保存时写成当前版本的信封。
        this.cached = migrateToCurrent(parsed, FLAT_LEGACY_VERSION, this.file) as T
      }
    } catch (error) {
      // 版本相关的拒绝在上面抛出：现场没坏，原样透出，不要包装成"文件损坏"。
      if (error instanceof Error && error.message.includes('拒绝按空态继续')) throw error
      // 损坏必须可见：静默按空态重建会让下一次 save 把空态写回，造成不可逆数据丢失
      // （2026-09-09 账号数据事故即此路径）。原地保留损坏文件并抛错，由调用方如实呈现。
      const detail = error instanceof Error ? error.message : String(error)
      this.cached = undefined
      this.cachedFingerprint = '-2'
      this.cachedDigest = ''
      throw new Error(
        `数据文件损坏，拒绝按空态继续（继续会覆盖并永久丢失）：${this.file}；原因：${detail}。`
        + '损坏文件未被修改，请先备份再处理。',
      )
    }
    return this.cached!
  }

  /** 盘上那份文件此刻是否有内容（拿不到就当作"有内容"，宁可拒绝保存也不冒销毁数据的险）。 */
  private fileHasContent(): boolean {
    try {
      const info = statSync(this.file)
      if (info.size === 0) return false
      const parsed = JSON.parse(stripBom(readFileSync(this.file, 'utf8'))) as unknown
      const body = isEnvelope(parsed) ? parsed.value : parsed
      return !isEmptyValue(body)
    }
    catch (error) {
      // 文件不存在 = 没有内容可毁；其余（读不到/解析不了）按"有内容"处理，拒绝覆盖。
      return !isMissingFile(error)
    }
  }

  /**
   * 清空前把盘上那份复制到 `backups/pre-clear-<域>-<时间戳>/`（2026-10-13）。
   *
   * 为什么做成结构而不是"调用方自觉"：2026-10-13 10:35–10:36，四个数据文件被依次写成
   * 40 字节的空信封（draft-generations / contents / agent-tasks / share-tokens），
   * **是靠 backups/ 里的一份自动快照才恢复回来**。下面 saveEmpty 的注释一直写着
   * "调用方有责任在此之前留下快照"，但没有任何东西强制它——把责任交给调用方，就是交给运气。
   * 这里把快照绑在**唯一一个显式清空出口**上：谁清空，谁先留档。
   *
   * 失败不阻塞用户的清空操作（与删除账号前的 backupBeforeDestructive 同一口径）：
   * 备份盘写不进去时，用户仍然要能完成自己的操作。
   */
  private snapshotBeforeClear(): void {
    try {
      // 盘上本来就没内容（或文件不存在）时不产生空快照，免得 backups/ 被噪声塞满。
      if (!this.fileHasContent()) return
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const dir = join(dirname(this.file), 'backups', 'pre-clear-' + basename(this.file, '.json') + '-' + stamp)
      mkdirSync(dir, { recursive: true })
      copyFileSync(this.file, join(dir, basename(this.file)))
    }
    catch {
      // 快照失败不阻塞清空：用户的操作优先，丢失的只是一个回滚点。
    }
  }

  /**
   * 显式清空：只给"用户点了清空"这类路径用；**调用方不必再自己留快照**——
   * 本方法会先把盘上那份复制到 backups/pre-clear-*（见 {@link snapshotBeforeClear}）。
   *
   * @param value - 要写入的空值。
   */
  saveEmpty(value: T): void {
    const staging = this.stagingOf?.()
    if (staging !== undefined) { this.snapshotBeforeClear(); this.stage(staging, value); return }
    this.snapshotBeforeClear()
    storeWriteVersion += 1
    this.cached = value
    this.writeThrough(value)
  }

  save(value: T): void {
    // 空值守卫：**不允许用空数据把一份非空文件覆盖掉**。
    //
    // 为什么必须有：实测事故里 7 个数据文件被写成恰好 40 字节的空信封，起因就是"读失败被当成
    // 没有数据 -> 内存里是空数组 -> 任意一次 save 把空写回盘"。而且不只这一种起因：
    // 裸的清空接口、参数拼错导致的 save([])、读失败的滞后快照，最终都表现为同一个后果——
    // 用户的数据没了，且不可逆。真正要清空数据的路径必须走 {@link JsonFile.saveEmpty} 显式声明。
    if (isEmptyValue(value) && this.fileHasContent()) {
      throw new Error(
        `拒绝用空数据覆盖已有内容的文件：${this.file}。`
        + '清空用户数据必须走显式接口（saveEmpty），并在此之前留下快照。',
      )
    }
    const staging = this.stagingOf?.()
    if (staging !== undefined) { this.stage(staging, value); return }
    // 先登记版本号：同进程的其他实例下一次 load 必须重新读盘（不能只看元数据）。
    storeWriteVersion += 1
    this.cached = value
    this.writeThrough(value)
  }

  /**
   * 原子写入一份值：冲突守卫 + {@link atomicReplace}。保存与显式清空共用它，
   * 保证"怎么落盘"只有一份实现。
   *
   * @param value - 要写入的值。
   */
  private writeThrough(value: T): void {
    const serialized = JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION, value }, null, 2) + '\n'
    // 丢失更新守卫：本实例如果"读过盘"，就必须确认盘上那份还是它读到的那一份。
    //
    // 服务端与内核是两个进程、共用同一数据根，读-改-写（读列表 → 追加一条 → 整份写回）
    // 天然存在窗口：两个进程各自读到同一基线、各自写回，后写者会静默抹掉先写者的改动。
    // 静默丢数据比写失败危险得多，因此这里判红而不是照写。
    //
    // 只对"确实读过"的实例生效：cachedDigest 为空表示本次进程尚未从盘上读过该文件
    // （例如首次创建、或调用方直接 save 一个自己构造的值），此时没有可比对的基线，跳过。
    // 自己刚写过之后 cachedDigest 会被更新为本实例写入的内容摘要，因此连续 save 不受影响。
    if (this.cachedDigest !== '' && existsSync(this.file)) {
      const onDisk = createHash('sha256').update(readFileSync(this.file, 'utf8')).digest('hex')
      if (onDisk !== this.cachedDigest) {
        this.cached = undefined
        this.cachedFingerprint = '-2'
        this.cachedDigest = ''
        throw new Error(
          `写入被拒：${this.file} 在本实例读取之后已被其他写入方改过（并发写冲突）。`
          + '为避免静默覆盖对方的数据，本次写入未生效。请重新读取后再写入。',
        )
      }
    }
    // 落盘交给数据根唯一的原子替换实现（临时文件 + fsync + rename + 目录 fsync + 写后回读）。
    try {
      atomicReplace(this.file, serialized)
    }
    catch (error) {
      // 回读不一致：缓存必须作废，否则下一次 load 会把旧缓存当成盘上事实。
      this.cached = undefined
      this.cachedFingerprint = '-2'
      this.cachedDigest = ''
      throw error
    }
    // rename 后记录新指纹与内容摘要：下一次 load 先比指纹、再比内容，
    // 两者都一致才算"磁盘没变"（Windows 上指纹会延迟，见 readIfChanged）。
    this.cachedFingerprint = this.fileFingerprint()
    this.cachedDigest = createHash('sha256').update(serialized).digest('hex')
    this.seenWriteVersion = storeWriteVersion
    this.lastCheckAt = Date.now()
  }

  /**
   * 把一次写入登记进事务：只更新内存与暂存值，落盘由事务提交时统一完成。
   *
   * @param staging - 当前事务的暂存区。
   * @param value - 要写入的值。
   */
  private stage(staging: StoreStaging, value: T): void {
    if (!this.staged) {
      this.stagedCache = { cached: this.cached, fingerprint: this.cachedFingerprint, digest: this.cachedDigest }
      staging.order.push(this)
    }
    this.staged = true
    this.stagedValue = value
    this.cached = value
  }

  /**
   * 事务提交：把暂存值原子落盘。磁盘原文先留一份，供 {@link rollbackStaged} 恢复。
   */
  commitStaged(): void {
    if (!this.staged) return
    this.committedBackup = existsSync(this.file) ? readFileSync(this.file, 'utf8') : null
    storeWriteVersion += 1
    this.writeThrough(this.stagedValue as T)
  }

  /**
   * 事务回滚：磁盘恢复成提交之前的样子，内存缓存恢复成事务开始前的样子。
   */
  rollbackStaged(): void {
    if (this.committedBackup !== undefined) {
      if (this.committedBackup === null) rmSync(this.file, { force: true })
      else atomicReplace(this.file, this.committedBackup)
      this.committedBackup = undefined
    }
    if (this.stagedCache !== undefined) {
      this.cached = this.stagedCache.cached
      this.cachedFingerprint = this.stagedCache.fingerprint
      this.cachedDigest = this.stagedCache.digest
    }
    this.finishStaged()
  }

  /** 事务整体成功：清掉暂存与备份，本文件退出本次事务。 */
  finalizeStaged(): void {
    if (!this.staged && this.committedBackup === undefined) return
    this.committedBackup = undefined
    this.finishStaged()
  }

  /** 清空暂存状态（回滚与提交共用）。 */
  private finishStaged(): void {
    this.staged = false
    this.stagedValue = undefined
    this.stagedCache = undefined
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

/** 只有"文件不存在"才允许走缺失分支；其余（EPERM/EBUSY/EACCES/EISDIR…）都是读失败。 */
function isMissingFile(error: unknown): boolean {
  return (error as { code?: unknown } | undefined)?.code === 'ENOENT'
}

/** 把任意抛出物收成 Error，便于在原因里带上原文。 */
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** 一份值是"空"：空数组，或空对象——这类值覆盖非空文件就是数据销毁。 */
function isEmptyValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0
  if (value !== null && typeof value === 'object') return Object.keys(value as Record<string, unknown>).length === 0
  return false
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
    // 账号级 AI 事实（定位/风险）：按 (平台, uid) 寻址，与账号行分开存放（DEF-147）。
    accountFacts: new JsonFile<Record<string, AccountFact>>(f('account-facts.json'), () => ({})),
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
    // 自动任务（三类事自动检查 + 主动汇报）的配置、去重账本与自检记录：
    // 去重账本必须落盘——进程重启后不能把已经报过的事再报一遍。
    autoTasks: new JsonFile<AutoTaskState>(f('auto-task-state.json'), () => defaultAutoTaskState()),
    jobs: new JsonFile<ZyJobRecord[]>(f('job-queue.json'), () => []),
    // 形状只有 knowledge-distill.ts 一个家：这里内联抄过一份，于是"账本多一个字段"
    // （例如 ratingSource）要在两个地方各改一次，漏一处就是类型与落盘不一致。
    knowledge: new JsonFile<KnowledgeState>(f('knowledge.json'), () => ({
      notes: {
        '欢迎使用 Bosom Friend 知识库.md': {
          name: '欢迎使用 Bosom Friend 知识库',
          content: '# 欢迎使用 Bosom Friend 知识库\n\n这里用于保存你的项目知识、产品资料和运营素材。\n\n- 左侧搜索可快速查找笔记；\n- 中间支持 Markdown 编辑与预览；\n- 使用 `[[笔记名]]` 可建立双向链接。\n',
        },
      },
      vault: { path: '', builtIn: true },
    })),
  }

  /**
   * 当前事务的暂存区；undefined 表示不在事务中。
   */
  let staging: StoreStaging | undefined
  for (const file of Object.values(files)) file.attachTransaction(() => staging)

  /**
   * 一次请求内的批量写入：事务里的 save 先暂存，提交时按登记顺序统一原子落盘。
   *
   * 语义：
   *  - `work` 抛错 → 一个文件都没被写过，原样抛出（天然的"全不成"）；
   *  - 提交阶段任一步失败 → 本次涉及的文件全部恢复成提交前的内容，抛错；
   *  - 成功 → 所有文件都是新内容。
   *
   * 事务里再读同一文件会读到暂存值（缓存已更新），调用方不必自己传递中间结果。
   *
   * @param work - 事务体，在其中调用 `store.files.<name>.save(...)`。
   * @returns `work` 的返回值。
   * @throws 事务嵌套、事务体抛错，或提交/回滚失败时（消息带原文）。
   */
  function transact<T>(work: () => T): T {
    if (staging !== undefined) throw new Error('事务不可嵌套：一次 transact 里不能再开 transact。')
    const state: StoreStaging = { order: [] }
    staging = state
    let result: T
    try {
      result = work()
    }
    catch (error) {
      staging = undefined
      for (const file of [...state.order].reverse()) file.rollbackStaged()
      throw error
    }
    staging = undefined
    try {
      for (const file of state.order) file.commitStaged()
    }
    catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      for (const file of [...state.order].reverse()) file.rollbackStaged()
      throw new Error('批量写入没有全部生效，已回滚到写入前：' + detail)
    }
    for (const file of state.order) file.finalizeStaged()
    return result
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
    transact,
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
