#!/usr/bin/env node
/**
 * 平台引擎（dist/engine-portable）的输入指纹与复用判定。
 *
 * 流水线第 5 步每次重建 dist/engine-portable：robocopy 引擎 + .venv + python-base +
 * 四个浏览器目录，约 1.9 GB / 15,000 个文件。实测 2026-09-18 一次 13.5 分钟，而改 BUG 出包时
 * 引擎源码、浏览器、随包 Python 都不动——这 13.5 分钟全是白等。
 *
 * 复用判定必须保守：只有「全部输入逐条相同」且「上一轮产物仍然完整」才跳过重建。
 * 输入里任何一个文件的体积或修改时间变了、产物缺一条必需路径、指纹版本对不上，都判不匹配、
 * 照常重建。BF_FORCE_ENGINE=1 跳过判定直接重建。
 *
 * 用法：
 *   node desktop/engine-fingerprint.mjs --check dist/engine-portable   # 0=可复用 1=须重建
 *   node desktop/engine-fingerprint.mjs --write dist/engine-portable   # 写指纹戳
 *   node desktop/engine-fingerprint.mjs --selftest                     # 负向对照自检
 * @module bosom-friend/desktop/engine-fingerprint
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(desktopDir, '..', '..', '..')

/** 指纹戳文件名与格式版本：判定逻辑变了必须提版本，否则旧戳会被当成有效。 */
export const STAMP_NAME = '.bf-engine-stamp.json'
export const STAMP_VERSION = 1

/** 打包时不会进产物的目录名：引擎源里这几类要么是开发机运行残渣，要么被构建脚本显式删除。 */
const SKIP_NAMES = new Set(['__pycache__', '.pytest_cache', '.git', '_exam_evidence', '_probe_shots', 'cookies', 'logs', 'db'])

/** 随包 Python 里不进产物的相对路径（构建脚本的排除项与裁剪项，改它们不影响产物）。 */
const PYTHON_BASE_SKIP_PATHS = new Set([
  'Lib/site-packages', 'Scripts', 'Doc', 'tcl',
  'Lib/test', 'Lib/idlelib', 'Lib/tkinter', 'Lib/turtledemo', 'Lib/lib2to3',
  'Lib/ensurepip', 'Lib/distutils', 'Lib/pydoc_data', 'Lib/venv', 'Lib/unittest/test',
])

/** 产物必须存在的路径：缺任何一条，装机版的登录 / 发布 / 解压链路就断。 */
export const REQUIRED_OUTPUT = [
  'worker.py',
  'interactions.py',
  'social-auto-upload/uploader',
  '.venv/Scripts/python.exe',
  '.venv/Lib/site-packages/patchright',
  '.venv/Lib/site-packages/playwright',
  '.venv/Lib/site-packages/cv2',
  'python-base/python.exe',
  'python-base/Lib/zipfile/__init__.py',
  'browsers/chromium-1208',
  'browsers/chromium_headless_shell-1208',
  'browsers/chromium-1169',
  'browsers/chromium_headless_shell-1169',
  'tools/biliup/biliup.exe',
]

/**
 * 默认输入根目录（构建脚本用的同一批路径）。
 *
 * @returns 输入根目录集合。
 */
export function defaultRoots() {
  const local = process.env.LOCALAPPDATA ?? ''
  return {
    engine: join(repoRoot, 'products', 'bosom-friend', 'engine'),
    browsers: join(local, 'ms-playwright'),
    pythonBase: join(local, 'Programs', 'Python', 'Python312'),
    biliup: join(process.env.USERPROFILE ?? '', '.social-auto-upload', 'tools', 'biliup'),
  }
}

/** 浏览器目录白名单：只有随包的这几份算输入。 */
const BROWSER_DIRS = ['chromium-1208', 'chromium_headless_shell-1208', 'chromium-1169', 'chromium_headless_shell-1169', 'ffmpeg-1011', 'winldd-1007']

/**
 * 递归列出目录下所有文件的「相对路径 + 体积 + 修改时间」。
 *
 * @param root - 源根目录；不存在时返回空表。
 * @param skipNames - 按目录名跳过的集合。
 * @param skipPaths - 按相对路径跳过的集合（以 / 分隔）。
 * @returns 排序后的条目文本数组。
 */
function listEntries(root, skipNames, skipPaths) {
  const out = []
  if (!existsSync(root)) return out
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      const rel = relative(root, full).split(sep).join('/')
      if (entry.isDirectory()) {
        if (skipNames.has(entry.name) || skipPaths.has(rel)) continue
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      const info = statSync(full)
      out.push(rel + '|' + info.size + '|' + Math.round(info.mtimeMs))
    }
  }
  walk(root)
  return out.sort()
}

/**
 * 算一棵输入树的摘要。
 *
 * @param root - 源根目录。
 * @param skipNames - 按目录名跳过的集合。
 * @param skipPaths - 按相对路径跳过的集合。
 * @returns 文件数、总字节与摘要。
 */
export function digestOf(root, skipNames = SKIP_NAMES, skipPaths = new Set()) {
  const entries = listEntries(root, skipNames, skipPaths)
  const hash = createHash('sha256')
  let bytes = 0
  for (const line of entries) {
    hash.update(line)
    hash.update('\n')
    bytes += Number(line.split('|')[1])
  }
  return { root, exists: existsSync(root), files: entries.length, bytes, digest: hash.digest('hex') }
}

/**
 * 算脚本自身与关键构建脚本的摘要：构建逻辑改了必须重建，不能靠输入文件恰好没变糊过去。
 *
 * @returns 文件摘要表。
 */
function buildScripts() {
  const files = [
    join(desktopDir, 'build-engine-portable.ps1'),
    join(desktopDir, 'engine-fingerprint.mjs'),
  ]
  const out = {}
  for (const file of files) {
    out[file.split(sep).pop()] = existsSync(file)
      ? createHash('sha256').update(readFileSync(file)).digest('hex')
      : 'missing'
  }
  return out
}

/**
 * 收集所有输入摘要。
 *
 * @param roots - 输入根目录集合；缺省用 defaultRoots()。
 * @returns 输入摘要对象。
 */
export function collectSources(roots = defaultRoots()) {
  const browsers = {}
  for (const name of BROWSER_DIRS) browsers[name] = digestOf(join(roots.browsers, name))
  return {
    engine: digestOf(roots.engine),
    pythonBase: digestOf(roots.pythonBase, SKIP_NAMES, PYTHON_BASE_SKIP_PATHS),
    browsers,
    biliup: digestOf(roots.biliup),
    scripts: buildScripts(),
  }
}

/**
 * 由输入摘要算总指纹。
 *
 * @param sources - collectSources() 的结果。
 * @returns sha256 指纹（十六进制）。
 */
export function fingerprintOf(sources) {
  return createHash('sha256').update(JSON.stringify({ stampVersion: STAMP_VERSION, sources })).digest('hex')
}

/**
 * 判定产物能否复用。
 *
 * @param outDir - dist/engine-portable 目录。
 * @param sources - 输入摘要；缺省现算。
 * @returns 判定结果：ok 为真表示可复用，reason 说明判据。
 */
export function checkReuse(outDir, sources = collectSources()) {
  const missingInputs = Object.entries(sources)
    .filter(([key, value]) => key !== 'browsers' && key !== 'scripts' && value.exists === false)
    .map(([key]) => key)
  const missingBrowsers = Object.entries(sources.browsers).filter(([, value]) => value.exists === false).map(([key]) => key)
  if (missingInputs.length > 0 || missingBrowsers.length > 0)
    return { ok: false, reason: 'inputs missing: ' + [...missingInputs, ...missingBrowsers].join(',') }
  if (!existsSync(outDir)) return { ok: false, reason: 'no previous build at ' + outDir }
  const stampPath = join(outDir, STAMP_NAME)
  if (!existsSync(stampPath)) return { ok: false, reason: 'no stamp ' + STAMP_NAME }
  let stamp
  try {
    stamp = JSON.parse(readFileSync(stampPath, 'utf8'))
  } catch (error) {
    return { ok: false, reason: 'stamp unreadable: ' + String(error) }
  }
  if (stamp?.stampVersion !== STAMP_VERSION) return { ok: false, reason: 'stamp version ' + String(stamp?.stampVersion) + ' != ' + STAMP_VERSION }
  const current = fingerprintOf(sources)
  if (stamp.fingerprint !== current) return { ok: false, reason: 'inputs changed (stamp ' + String(stamp.fingerprint).slice(0, 12) + ', now ' + current.slice(0, 12) + ')' }
  const missing = REQUIRED_OUTPUT.filter(rel => !existsSync(join(outDir, rel.split('/').join(sep))))
  if (missing.length > 0) return { ok: false, reason: 'stale build, missing ' + missing.join(', ') }
  // 随包 Python 的 site-packages 是开发机全局安装的残渣：worker 解释器是 .venv（include-system-site-packages=false），
  // 看不到它，装机后白占 287 MB。它一旦重新出现，说明构建脚本的裁剪失效，必须重建。
  if (existsSync(join(outDir, 'python-base', 'Lib', 'site-packages')))
    return { ok: false, reason: 'python-base/Lib/site-packages came back (build would ship 287 MB of unreachable packages)' }
  return { ok: true, reason: 'inputs unchanged since ' + String(stamp.createdAt ?? 'unknown') + ' (' + current.slice(0, 12) + ')' }
}

/**
 * 写指纹戳。
 *
 * @param outDir - dist/engine-portable 目录。
 * @param sources - 输入摘要；缺省现算。
 * @returns 写出的戳内容。
 */
export function writeStamp(outDir, sources = collectSources()) {
  const stamp = {
    stampVersion: STAMP_VERSION,
    fingerprint: fingerprintOf(sources),
    createdAt: new Date().toISOString(),
    sources,
  }
  writeFileSync(join(outDir, STAMP_NAME), JSON.stringify(stamp, null, 2) + '\n', 'utf8')
  return stamp
}

/** 打印一行结论。 */
function say(line) {
  console.log(line)
}

/**
 * 负向对照：证明判定真的会拒绝「输入变了 / 产物残了 / 戳过期」三种情况，而不是恒真。
 *
 * @returns 断言通过返回 0，否则返回 1。
 */
function selftest() {
  const box = mkdtempSync(join(tmpdir(), 'bf-engine-fingerprint-'))
  const roots = {
    engine: join(box, 'src', 'engine'),
    browsers: join(box, 'src', 'browsers'),
    pythonBase: join(box, 'src', 'python'),
    biliup: join(box, 'src', 'biliup'),
  }
  const out = join(box, 'out')
  const write = (file, body) => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, body, 'utf8')
  }
  let passed = 0
  const failures = []
  const expect = (name, actual, want) => {
    if (actual === want) passed += 1
    else failures.push(name + ': got ' + actual + ', want ' + want)
  }
  try {
    write(join(roots.engine, 'worker.py'), 'print(1)\n')
    write(join(roots.engine, '.venv', 'Scripts', 'python.exe'), 'stub\n')
    write(join(roots.engine, 'cookies', 'profile.bin'), 'ignored\n')
    write(join(roots.pythonBase, 'Lib', 'os.py'), 'stub\n')
    write(join(roots.pythonBase, 'Lib', 'site-packages', 'googleapiclient', '__init__.py'), 'dead\n')
    write(join(roots.biliup, 'biliup.exe'), 'stub\n')
    for (const name of BROWSER_DIRS) write(join(roots.browsers, name, 'chrome.exe'), 'stub\n')
    for (const rel of REQUIRED_OUTPUT) {
      const body = rel.endsWith('python.exe') || rel.endsWith('biliup.exe') ? 'stub\n' : ''
      mkdirSync(join(out, ...rel.split('/')), { recursive: true })
      if (body !== '') write(join(out, ...rel.split('/')), body)
    }
    const sources = collectSources(roots)
    expect('site-packages/img excluded from fingerprint', sources.pythonBase.files, 1)
    expect('engine cookies excluded from fingerprint', sources.engine.files, 2)
    expect('no stamp yet', checkReuse(out, sources).ok, false)
    writeStamp(out, sources)
    expect('stamp written -> reuse', checkReuse(out, sources).ok, true)
    appendFileSync(join(roots.engine, 'worker.py'), '# touched\n')
    expect('engine source grew -> rebuild', checkReuse(out, sources).ok, false)
    write(join(roots.engine, 'worker.py'), 'print(1)\n')
    expect('engine source restored -> reuse', checkReuse(out, sources).ok, true)
    rmSync(join(out, 'browsers', 'chromium-1169'), { recursive: true, force: true })
    expect('output lost a browser -> rebuild', checkReuse(out, sources).ok, false)
    write(join(out, 'browsers', 'chromium-1169', 'chrome.exe'), 'stub\n')
    expect('output restored -> reuse', checkReuse(out, sources).ok, true)
    const stampPath = join(out, STAMP_NAME)
    const stamp = JSON.parse(readFileSync(stampPath, 'utf8'))
    writeFileSync(stampPath, JSON.stringify({ ...stamp, stampVersion: STAMP_VERSION + 1 }), 'utf8')
    expect('stamp from another version -> rebuild', checkReuse(out, sources).ok, false)
    writeFileSync(stampPath, JSON.stringify({ ...stamp, fingerprint: 'deadbeef' }), 'utf8')
    expect('stamp fingerprint mismatch -> rebuild', checkReuse(out, sources).ok, false)
    writeStamp(out, sources)
    mkdirSync(join(out, 'python-base', 'Lib', 'site-packages'), { recursive: true })
    expect('python-base site-packages reappeared -> rebuild', checkReuse(out, sources).ok, false)
    rmSync(join(out, 'python-base', 'Lib', 'site-packages'), { recursive: true, force: true })
    expect('site-packages gone again -> reuse', checkReuse(out, sources).ok, true)
  } finally {
    rmSync(box, { recursive: true, force: true })
  }
  for (const failure of failures) console.error('ENGINE_FINGERPRINT SELFTEST FAIL ' + failure)
  say('ENGINE_FINGERPRINT SELFTEST ' + passed + '/' + (passed + failures.length) + (failures.length === 0 ? ' 全部通过' : ' 存在失败断言'))
  return failures.length === 0 ? 0 : 1
}

/** 入口。 */
function main() {
  const args = process.argv.slice(2)
  if (args.includes('--selftest')) return selftest()
  const target = args.find(item => !item.startsWith('--'))
  if (target === undefined) {
    console.error('usage: engine-fingerprint.mjs --check|--write <dist/engine-portable> | --selftest')
    return 1
  }
  const outDir = resolve(target)
  if (args.includes('--write')) {
    if (!existsSync(outDir)) {
      console.error('ENGINE_FINGERPRINT MISSING ' + outDir + ' (nothing to stamp)')
      return 1
    }
    const stamp = writeStamp(outDir)
    say('ENGINE_FINGERPRINT WRITE ' + stamp.fingerprint.slice(0, 12) + ' -> ' + join(outDir, STAMP_NAME))
    return 0
  }
  const verdict = checkReuse(outDir)
  if (verdict.ok) {
    say('ENGINE_FINGERPRINT REUSE ' + verdict.reason)
    return 0
  }
  say('ENGINE_FINGERPRINT REBUILD ' + verdict.reason)
  return 1
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main()
}
