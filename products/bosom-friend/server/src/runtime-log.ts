/**
 * 内核运行日志：把内核进程的 stderr 与产品诊断行按天写进文件。
 *
 * 为什么必须由产品自己写：桌面内核的 **stdout 是 SDK 的 JSON-RPC 独占通道**（写日志会污染协议，
 * 且非 JSON 行会被对端静默丢弃），而 server 里 39 处业务 console.log/error 恰好都写在这里；
 * stderr 也只进 SDK 客户端的内存环（最近 400 行），只有内核"死掉"那一刻才随错误消息被主进程落盘。
 * 于是厂商 429、轮询超时、图片被拒这些行从来没有任何文件出口，现场只能靠猜（DEF-083）。
 *
 * 约束：
 * 1) 只接管 stderr，绝不碰 stdout；
 * 2) 任何写入失败立即停写，绝不影响业务；
 * 3) 单行截断、按天滚动、保留期清理，与桌面主进程 run-log.cjs 同一套策略；
 * 4) 日志会被用户发出来做现场支持，写入前统一遮蔽密钥形态字符串。
 *
 * @module @deepseek-ai/dsh-bosom-friend-server/runtime-log
 */

import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 单份日志上限；超过则续写 <前缀>-<日期>.<序号>.log。 */
const MAX_BYTES = 10 * 1024 * 1024
/** 保留天数。 */
const KEEP_DAYS = 7
/** 单行截断上限。 */
const MAX_LINE_CHARS = 4000
/** 一天最多续写多少份。 */
const MAX_ROTATIONS = 50
/** 未遇到换行符时，缓冲到这么多字符就先落盘，避免半行永远不写。 */
const MAX_PARTIAL_CHARS = 8000

/** API Key / Bearer 形态的字符串。 */
const SECRET_PATTERN = /\b(sk-[A-Za-z0-9_-]{6,}|Bearer\s+[A-Za-z0-9._-]{6,})/g

/** 运行日志句柄。 */
export interface RuntimeLogHandle {
  /** 日志目录。 */
  dir: string
  /** 当前日志文件绝对路径。 */
  path: () => string
  /** 直接写一行（不走 console）。 */
  line: (message: string) => void
  /** 当日志文件按天切换时调用，用于在文件开头写明是谁在写。 */
  close: () => void
}

/** 安装选项。 */
export interface RuntimeLogOptions {
  /** 日志目录；缺省 dataRoot/logs。 */
  dir: string
  /** 文件名前缀，默认 kernel。 */
  prefix?: string
  /** 取当前时间的函数，便于测试注入。 */
  now?: () => Date
  /** 单份上限，默认 10MB。 */
  maxBytes?: number
  /** 保留天数，默认 7 天。 */
  keepDays?: number
}

/** @param text - 原始文本。 @returns 遮蔽密钥后的文本。 */
function maskSecrets(text: string): string {
  return text.replace(SECRET_PATTERN, match => (match.startsWith('Bearer') ? 'Bearer ***' : 'sk-***'))
}

/** @param chunk - stderr 收到的分片。 @param encoding - 编码或回调。 @returns 分片文本；无法解释时返回空串。 */
function chunkText(chunk: unknown, encoding: unknown): string {
  if (typeof chunk === 'string')
    return chunk
  if (chunk instanceof Uint8Array)
    return Buffer.from(chunk).toString(typeof encoding === 'string' ? encoding as BufferEncoding : 'utf8')
  if (chunk === undefined || chunk === null)
    return ''
  return String(chunk)
}

/**
 * 安装内核运行日志。
 *
 * 重复安装会被忽略（返回已有句柄），避免多处 require 造成重复接管。
 *
 * @param options - 安装选项。
 * @returns 日志句柄。
 */
export function installRuntimeLog(options: RuntimeLogOptions): RuntimeLogHandle {
  const dir = options.dir
  const prefix = options.prefix ?? 'kernel'
  const now = options.now ?? (() => new Date())
  const maxBytes = options.maxBytes ?? MAX_BYTES
  const keepDays = options.keepDays ?? KEEP_DAYS
  let disabled = false
  let pruned = false
  let currentDay = ''
  let currentPath = ''
  let currentBytes = 0
  let partial = ''

  /** @param date - 时间。 @returns YYYY-MM-DD（UTC，与主进程 run-log 一致）。 */
  function dayOf(date: Date): string {
    return date.toISOString().slice(0, 10)
  }

  /** @param date - 时间。 @param index - 第几份。 @returns 该份的绝对路径。 */
  function fileFor(date: Date, index: number): string {
    const base = prefix + '-' + dayOf(date) + '.log'
    return join(dir, index === 0 ? base : prefix + '-' + dayOf(date) + '.' + index + '.log')
  }

  /** @param file - 绝对路径。 @returns 字节数；不存在按 0。 */
  function sizeOf(file: string): number {
    try {
      return statSync(file).size
    }
    catch {
      return 0
    }
  }

  /** @param date - 时间。 @returns 当前可写文件。 */
  function pickFile(date: Date): string {
    for (let index = 0; index < MAX_ROTATIONS; index += 1) {
      const file = fileFor(date, index)
      const size = sizeOf(file)
      if (size === 0 || size < maxBytes)
        return file
    }
    return fileFor(date, MAX_ROTATIONS - 1)
  }

  /** 删除超过保留期的日志。 */
  function prune(): void {
    if (pruned)
      return
    pruned = true
    const cutoff = now().getTime() - keepDays * 24 * 60 * 60 * 1000
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix + '-') || !name.endsWith('.log'))
        continue
      const file = join(dir, name)
      if (statSync(file).mtimeMs < cutoff)
        rmSync(file, { force: true })
    }
  }

  /** @param message - 一行正文（不含换行）。 */
  function writeLine(message: string): void {
    if (disabled)
      return
    try {
      const date = now()
      const day = dayOf(date)
      if (day !== currentDay || currentPath === '') {
        mkdirSync(dir, { recursive: true })
        if (!pruned)
          prune()
        currentDay = day
        currentPath = pickFile(date)
        currentBytes = sizeOf(currentPath)
      }
      else if (currentBytes >= maxBytes) {
        currentPath = pickFile(date)
        currentBytes = sizeOf(currentPath)
      }
      const row = date.toISOString() + ' ' + maskSecrets(message.slice(0, MAX_LINE_CHARS)) + '\n'
      appendFileSync(currentPath, row, 'utf8')
      currentBytes += Buffer.byteLength(row, 'utf8')
    }
    catch {
      // 目录只读、磁盘满：停写，绝不影响业务。
      disabled = true
    }
  }

  /** @param text - 新到的 stderr 文本，按行切分后落盘。 */
  function capture(text: string): void {
    if (text === '')
      return
    partial += text
    let index = partial.indexOf('\n')
    while (index !== -1) {
      writeLine(partial.slice(0, index))
      partial = partial.slice(index + 1)
      index = partial.indexOf('\n')
    }
    if (partial.length > MAX_PARTIAL_CHARS) {
      writeLine(partial)
      partial = ''
    }
  }

  const original = process.stderr.write.bind(process.stderr) as unknown as (chunk: unknown, ...rest: unknown[]) => boolean
  const patched = (chunk: unknown, ...rest: unknown[]): boolean => {
    try {
      capture(chunkText(chunk, rest[0]))
    }
    catch {
      // 记录失败不影响原始写入。
    }
    return original(chunk, ...rest)
  }
  process.stderr.write = patched as unknown as typeof process.stderr.write

  return {
    dir,
    path: () => (currentPath !== '' ? currentPath : fileFor(now(), 0)),
    line: (message: string) => { writeLine(message) },
    close: () => {
      if (partial !== '') {
        writeLine(partial)
        partial = ''
      }
    },
  }
}
