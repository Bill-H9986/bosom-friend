/**
 * 内核运行时解压器：纯 Node 实现的 ZIP 解包。
 *
 * 为什么不用系统 tar.exe / 随包 Python（DEF-045 的修法）：两者在**默认设置的 Windows** 上
 * 都解不开这份 zip。真实运行时里最深相对路径 233 字符，落到
 * `%APPDATA%\Bosom Friend\kernel-runtime` 之后超过 260 —— 而
 * "Windows 长路径支持"默认关闭（注册表 HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\
 * LongPathsEnabled=0）：
 *   - Python 3.6+ 的 zipfile 只有在"进程 manifest 声明 longPathAware **且** 注册表开关打开"
 *     时才越过 MAX_PATH，注册表为 0 时解到第一个深路径就 FileNotFoundError（exit 1）；
 *   - libuv 同样依赖"longPathAware manifest + 注册表开关"（libuv PR #2789），所以 Node 自己
 *     也只有显式给出 \\?\ 前缀才能读写 >260 的路径；
 *   - bsdtar（系统 tar.exe）在长路径上同样不可靠。
 * 只有本文件这种"自己算偏移 + 自己显式加 \\?\ 前缀"的解压不依赖以上任何一项。
 *
 * 现场 0.2.47 的失败文案（PATH 上的 tar.exe ENOENT + 随包 Python Command failed）
 * 正是这条链路的末端：机器没有 System32\tar.exe，随包 Python 又撞上 MAX_PATH。
 *
 * 用法（CLI，供安装器与现场修复使用）：
 *   node kernel-unzip.cjs <zip> <target> [--quiet]
 * 进度行 `UNZIP_PROGRESS <已完成> <总数>`，成功行 `UNZIP_OK ...`，失败行 `UNZIP_FAIL <原因>`（stderr，exit 1）。
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const EOCD_SIG = 0x06054b50
const ZIP64_LOCATOR_SIG = 0x07064b50
const ZIP64_EOCD_SIG = 0x06064b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

/**
 * 超过这个长度就给路径加 \\?\ 前缀。
 *
 * 阈值不是 260：解压过程中还会派生临时名、以及 zip 里可能含更深的条目，
 * 留一段余量比"刚好卡在 259"稳。
 */
const LONG_PATH_THRESHOLD = 200

/**
 * Windows 长路径写法：\\?\ + 绝对路径（UNC 走 \\?\UNC\）。
 *
 * \\?\ 前缀绕过 Win32 的 MAX_PATH 检查与路径规范化，因此不依赖进程 manifest、
 * 也不依赖注册表 LongPathsEnabled —— 这正是随包 Python 缺的那一步。
 *
 * @param value - 绝对或相对路径。
 * @returns 可以直接交给 fs 的路径；长度不足阈值时原样返回。
 */
function toLongPath(value) {
  if (process.platform !== 'win32') return value
  const abs = path.resolve(value)
  if (abs.startsWith('\\\\?\\')) return abs
  if (abs.length < LONG_PATH_THRESHOLD) return abs
  if (abs.startsWith('\\\\')) return '\\\\?\\UNC\\' + abs.slice(2)
  return '\\\\?\\' + abs
}

/** 从 fd 指定偏移读满整段；ZIP 里的分片读常常短读，必须循环。 */
function readFully(fd, buffer, position) {
  let read = 0
  while (read < buffer.length) {
    const n = fs.readSync(fd, buffer, read, buffer.length - read, position + read)
    if (n <= 0) throw new Error('ZIP 文件被截断（在偏移 ' + (position + read) + ' 处提前结束）')
    read += n
  }
}

/**
 * 找中央目录结尾记录（EOCD）。
 *
 * 从尾部往前扫签名，并校验注释长度与实际剩余字节一致：zip 的压缩数据里也可能
 * 偶然出现同样的四字节，靠注释长度才能排除假阳性。
 */
function readEndOfCentralDirectory(fd, size) {
  const tailLength = Math.min(size, 66 * 1024)
  const tail = Buffer.allocUnsafe(tailLength)
  readFully(fd, tail, size - tailLength)
  for (let i = tailLength - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== EOCD_SIG) continue
    const commentLength = tail.readUInt16LE(i + 20)
    if (i + 22 + commentLength > tailLength) continue
    return {
      entries: tail.readUInt16LE(i + 10),
      cdSize: tail.readUInt32LE(i + 12),
      cdOffset: tail.readUInt32LE(i + 16),
      eocdOffset: size - tailLength + i,
    }
  }
  throw new Error('不是有效的 ZIP：找不到中央目录结尾记录')
}

/**
 * ZIP64 补全。
 *
 * 内核运行时 zip 有 20 万个条目，超出经典 EOCD 的 65535 上限，所以条目数与偏移
 * 写在 ZIP64 记录里（Python 的 zipfile 会自动这么写）。不处理 ZIP64 就会把
 * "200537 个条目"读成 65535 个，解出来的运行时不完整。
 */
function readCentralDirectoryLocation(fd, eocd) {
  if (eocd.entries !== 0xffff && eocd.cdSize !== 0xffffffff && eocd.cdOffset !== 0xffffffff) return eocd
  const locator = Buffer.allocUnsafe(20)
  readFully(fd, locator, eocd.eocdOffset - 20)
  if (locator.readUInt32LE(0) !== ZIP64_LOCATOR_SIG) return eocd
  const zip64Offset = Number(locator.readBigUInt64LE(8))
  const record = Buffer.allocUnsafe(56)
  readFully(fd, record, zip64Offset)
  if (record.readUInt32LE(0) !== ZIP64_EOCD_SIG) return eocd
  return {
    entries: Number(record.readBigUInt64LE(32)),
    cdSize: Number(record.readBigUInt64LE(40)),
    cdOffset: Number(record.readBigUInt64LE(48)),
    eocdOffset: eocd.eocdOffset,
  }
}

/** 解析中央目录，得到每个条目的名称、压缩方式、大小与本地头偏移。 */
function readEntries(fd, cd) {
  const buffer = Buffer.allocUnsafe(cd.cdSize)
  readFully(fd, buffer, cd.cdOffset)
  const entries = []
  let at = 0
  while (at + 46 <= buffer.length && buffer.readUInt32LE(at) === CENTRAL_SIG) {
    const method = buffer.readUInt16LE(at + 10)
    const crc = buffer.readUInt32LE(at + 16)
    let compressedSize = buffer.readUInt32LE(at + 20)
    let uncompressedSize = buffer.readUInt32LE(at + 24)
    const nameLength = buffer.readUInt16LE(at + 28)
    const extraLength = buffer.readUInt16LE(at + 30)
    const commentLength = buffer.readUInt16LE(at + 32)
    let localOffset = buffer.readUInt32LE(at + 42)
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength)
    // ZIP64 扩展字段：只补被写成 0xFFFFFFFF 的字段，顺序固定为 原始大小 → 压缩大小 → 本地头偏移。
    let extra = at + 46 + nameLength
    const extraEnd = extra + extraLength
    while (extra + 4 <= extraEnd) {
      const id = buffer.readUInt16LE(extra)
      const size = buffer.readUInt16LE(extra + 2)
      if (id === 0x0001) {
        let field = extra + 4
        if (uncompressedSize === 0xffffffff) { uncompressedSize = Number(buffer.readBigUInt64LE(field)); field += 8 }
        if (compressedSize === 0xffffffff) { compressedSize = Number(buffer.readBigUInt64LE(field)); field += 8 }
        if (localOffset === 0xffffffff) { localOffset = Number(buffer.readBigUInt64LE(field)); field += 8 }
      }
      extra += 4 + size
    }
    entries.push({ name, method, crc, compressedSize, uncompressedSize, localOffset })
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * 把条目名拼到目标目录下，并挡掉 zip-slip（`..` 或绝对路径逃出目标目录）。
 *
 * @param root - 目标目录绝对路径。
 * @param name - zip 里的条目名。
 * @returns 目标绝对路径。
 */
function resolveEntryPath(root, name) {
  const relative = name.replace(/\\/g, '/')
  if (relative.startsWith('/') || /^[A-Za-z]:/.test(relative)) {
    throw new Error('ZIP 条目使用了绝对路径，拒绝解压：' + name)
  }
  const parts = relative.split('/').filter(part => part !== '' && part !== '.')
  if (parts.some(part => part === '..')) {
    throw new Error('ZIP 条目试图跳出目标目录，拒绝解压：' + name)
  }
  return path.join(root, ...parts)
}

/**
 * 解压整个 zip。
 *
 * @param zipPath - zip 绝对路径。
 * @param targetDir - 目标目录；不存在时创建。
 * @param options - `onProgress({ written, total, deepest })`、`verifyCrc`（默认 true）。
 * @returns `{ files, total, deepest, deepestName, bytes }`；`deepest` 是解出来的最长相对路径长度，
 *          长路径支持没开的机器上这个数字就是"为什么别的工具解不开"的答案。
 */
async function extractZipFile(zipPath, targetDir, options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {}
  const crc32 = typeof zlib.crc32 === 'function' ? zlib.crc32 : null
  const verifyCrc = options.verifyCrc !== false && crc32 !== null
  const root = path.resolve(targetDir)
  const fd = fs.openSync(zipPath, 'r')
  let written = 0
  let bytes = 0
  let deepest = 0
  let deepestName = ''
  try {
    const size = fs.fstatSync(fd).size
    const cd = readCentralDirectoryLocation(fd, readEndOfCentralDirectory(fd, size))
    const entries = readEntries(fd, cd)
    fs.mkdirSync(toLongPath(root), { recursive: true })
    const createdDirs = new Set([root])
    const localHeader = Buffer.allocUnsafe(30)
    for (const entry of entries) {
      if (entry.name.endsWith('/')) continue
      const outPath = resolveEntryPath(root, entry.name)
      const outDir = path.dirname(outPath)
      if (!createdDirs.has(outDir)) {
        fs.mkdirSync(toLongPath(outDir), { recursive: true })
        createdDirs.add(outDir)
      }
      readFully(fd, localHeader, entry.localOffset)
      if (localHeader.readUInt32LE(0) !== LOCAL_SIG) {
        throw new Error('ZIP 结构损坏：条目本地头签名不对（' + entry.name + '）')
      }
      const dataOffset = entry.localOffset + 30 + localHeader.readUInt16LE(26) + localHeader.readUInt16LE(28)
      const raw = Buffer.allocUnsafe(entry.compressedSize)
      readFully(fd, raw, dataOffset)
      let data = raw
      if (entry.method === 8) data = zlib.inflateRawSync(raw)
      else if (entry.method !== 0) throw new Error('不支持的压缩方式 ' + entry.method + '：' + entry.name)
      if (verifyCrc && crc32(data) !== (entry.crc >>> 0)) {
        throw new Error('解压内容校验失败（CRC 不一致）：' + entry.name)
      }
      fs.writeFileSync(toLongPath(outPath), data)
      written += 1
      bytes += data.length
      const relativeLength = entry.name.length
      if (relativeLength > deepest) {
        deepest = relativeLength
        deepestName = entry.name
      }
      if (written % 500 === 0) onProgress({ written, total: entries.length, deepest })
    }
    onProgress({ written, total: entries.length, deepest, done: true })
    return { files: written, total: entries.length, deepest, deepestName, bytes }
  }
  finally {
    fs.closeSync(fd)
  }
}

/** CLI：给安装器（resources\runtime\node.exe）与现场修复脚本用。 */
async function main(argv) {
  const args = argv.filter(arg => arg !== '--quiet')
  const quiet = argv.includes('--quiet')
  const [zip, target] = args
  if (!zip || !target) {
    process.stderr.write('UNZIP_FAIL 用法：node kernel-unzip.cjs <zip> <target> [--quiet]' + String.fromCharCode(10))
    return 2
  }
  const startedAt = Date.now()
  let lastReport = 0
  try {
    const result = await extractZipFile(zip, target, {
      onProgress: (progress) => {
        if (quiet) return
        if (!progress.done && progress.written - lastReport < 2000) return
        lastReport = progress.written
        process.stdout.write('UNZIP_PROGRESS ' + progress.written + ' ' + progress.total + String.fromCharCode(10))
      },
    })
    process.stdout.write('UNZIP_OK files=' + result.files + ' bytes=' + result.bytes
      + ' deepest=' + result.deepest + ' ms=' + (Date.now() - startedAt) + String.fromCharCode(10))
    return 0
  }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    process.stderr.write('UNZIP_FAIL ' + reason.split(/\r?\n/)[0] + String.fromCharCode(10))
    return 1
  }
}

module.exports = { toLongPath, extractZipFile, resolveEntryPath, LONG_PATH_THRESHOLD }

if (require.main === module) {
  main(process.argv.slice(2)).then(code => process.exit(code))
}
