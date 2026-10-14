/**
 * 主进程运行日志：按天写进 userData\logs\YYYY-MM-DD.log。
 *
 * 打包版此前没有任何落盘日志——安装后的 app.asar 里搜不到 logger / fs.appendFile /
 * electron-log，主进程与内核子进程的输出全部进了无人接收的管道。现场出现
 * "网络连接失败""生成失败"时，事后只能靠猜，连"内核是不是死了、什么时候死的"都无从判断。
 *
 * 两条设计约束：
 * 1) 写日志绝不影响 App 运行：任何一步失败（目录只读、磁盘满、并发改名）都把该实例
 *    标记为 disabled 后静默降级，绝不抛出。
 * 2) 日志会被用户发出来做现场支持，因此写入前统一遮蔽密钥形态的字符串。
 */

const fs = require('node:fs')
const path = require('node:path')

/** 单份日志上限；超过则续写 <日期>.<序号>.log，避免一次跑满整块盘。 */
const MAX_BYTES = 10 * 1024 * 1024
/** 保留天数：现场支持要求"最近一周随时可查"。 */
const KEEP_DAYS = 7
/** 单行截断上限：一个巨型 JSON 不应该把当天的日志挤掉。 */
const MAX_LINE_CHARS = 4000
/** 一天最多续写多少份，防御性上限。 */
const MAX_ROTATIONS = 50

/** API Key / Bearer 形态的字符串。 */
const SECRET_PATTERN = /\b(sk-[A-Za-z0-9_-]{6,}|Bearer\s+[A-Za-z0-9._-]{6,})/g

/** @param text - 原始文本。 @returns 遮蔽密钥后的文本。 */
function maskSecrets(text) {
  return text.replace(SECRET_PATTERN, (match) => (match.startsWith('Bearer') ? 'Bearer ***' : 'sk-***'))
}

/** @param value - 任意日志实参。 @returns 可写入文件的字符串。 */
function formatArg(value) {
  if (typeof value === 'string')
    return value
  if (value instanceof Error)
    return value.stack || value.message
  try {
    return JSON.stringify(value)
  }
  catch {
    return String(value)
  }
}

/**
 * 建一个按天滚动的运行日志写入器。
 *
 * @param options - 配置。
 * @param options.dir - 日志目录（通常是 userData\logs）。
 * @param options.now - 取当前时间的函数，便于测试注入。
 * @param options.maxBytes - 单份文件上限，默认 10MB。
 * @param options.keepDays - 保留天数，默认 7 天。
 * @returns 写入器：log/info/warn/error 写一行，path() 返回当前文件，dir 是目录。
 */
function createRunLog(options) {
  const dir = options.dir
  const now = options.now || (() => new Date())
  const maxBytes = options.maxBytes || MAX_BYTES
  const keepDays = options.keepDays || KEEP_DAYS
  let disabled = false
  let pruned = false
  let currentDay = ''
  let currentPath = ''
  let currentBytes = 0

  /** @param date - 时间。 @returns YYYY-MM-DD。 */
  function dayOf(date) {
    return date.toISOString().slice(0, 10)
  }

  /** @param date - 时间。 @param index - 第几份。 @returns 该份的绝对路径。 */
  function fileFor(date, index) {
    const base = dayOf(date) + '.log'
    return path.join(dir, index === 0 ? base : dayOf(date) + '.' + index + '.log')
  }

  /** @param date - 时间。 @returns 当前应写入的文件路径。 */
  function pickFile(date) {
    for (let index = 0; index < MAX_ROTATIONS; index += 1) {
      const file = fileFor(date, index)
      let size = 0
      try {
        size = fs.statSync(file).size
      }
      catch {
        return file
      }
      if (size < maxBytes)
        return file
    }
    return fileFor(date, MAX_ROTATIONS - 1)
  }

  /** @param file - 绝对路径。 @returns 文件当前字节数；不存在按 0。 */
  function sizeOf(file) {
    try {
      return fs.statSync(file).size
    }
    catch {
      return 0
    }
  }

  /** 删除超过保留期的日志文件。 */
  function prune() {
    if (pruned)
      return
    pruned = true
    const cutoff = now().getTime() - keepDays * 24 * 60 * 60 * 1000
    for (const name of fs.readdirSync(dir)) {
      if (!/^\d{4}-\d{2}-\d{2}(\.\d+)?\.log$/.test(name))
        continue
      const file = path.join(dir, name)
      if (fs.statSync(file).mtimeMs < cutoff)
        fs.rmSync(file, { force: true })
    }
  }

  /**
   * 写一行。
   *
   * @param level - info/warn/error。
   * @param message - 已拼好的正文。
   */
  function write(level, message) {
    if (disabled)
      return
    try {
      const date = now()
      const day = dayOf(date)
      if (day !== currentDay || currentPath === '') {
        fs.mkdirSync(dir, { recursive: true })
        if (!pruned)
          prune()
        currentDay = day
        currentPath = pickFile(date)
        currentBytes = sizeOf(currentPath)
      }
      else if (currentBytes >= maxBytes) {
        // 单份写满就续写下一份：一天跑满 10MB 不该把当天前半段的现场证据挤掉。
        currentPath = pickFile(date)
        currentBytes = sizeOf(currentPath)
      }
      const line = maskSecrets(String(message).slice(0, MAX_LINE_CHARS))
      const row = date.toISOString() + ' [' + level + '] ' + line + '\n'
      fs.appendFileSync(currentPath, row, 'utf8')
      currentBytes += Buffer.byteLength(row, 'utf8')
    }
    catch {
      // 目录只读、磁盘满、文件被占用：停写，不影响 App。
      disabled = true
    }
  }

  return {
    dir,
    /** @returns 当前日志文件绝对路径（文件可能尚未创建）。 */
    path: () => (currentPath !== '' ? currentPath : pickFile(now())),
    /** @param args - 任意实参。 */
    info: (...args) => write('info', args.map(formatArg).join(' ')),
    /** @param args - 任意实参。 */
    warn: (...args) => write('warn', args.map(formatArg).join(' ')),
    /** @param args - 任意实参。 */
    error: (...args) => write('error', args.map(formatArg).join(' ')),
  }
}

/**
 * 把 console 的输出同时抄进运行日志。
 *
 * 主进程与 SDK 客户端都只用 console 表达过程信息，GUI 启动时这些输出无人接收；
 * 接管 console 是唯一不用改动上游就能让它们落盘的位置。
 *
 * @param runLog - 运行日志写入器。
 * @param target - 被接管的 console，默认全局 console。
 */
function teeConsole(runLog, target) {
  const sink = target || console
  const levels = { log: 'info', info: 'info', warn: 'warn', error: 'error', debug: 'info' }
  for (const name of Object.keys(levels)) {
    const original = typeof sink[name] === 'function' ? sink[name].bind(sink) : null
    sink[name] = (...args) => {
      runLog[levels[name]](...args)
      if (original !== null)
        original(...args)
    }
  }
}

module.exports = { createRunLog, teeConsole, maskSecrets, formatArg }
