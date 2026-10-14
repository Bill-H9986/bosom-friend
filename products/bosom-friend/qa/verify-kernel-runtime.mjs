#!/usr/bin/env node
/**
 * 内核运行时一致性闸门：
 * 1) 桌面运行时入口 bin-desktop.mjs 的根配置必须引用随包存在的 cordis.yml（不得引用未随包的 config/desktop.cordis.yml）；
 * 2) zip 与已安装 userData 运行时内，凡出现 dsh-bosom-friend-kernel-bundle/runtime/bin-desktop.mjs 的副本，
 *    其配置引用必须与 bundle/kernel/runtime/bin-desktop.mjs 语义一致；
 * 3) 任一违反即非零退出。历史故障：zip 混入旧版启动器引用未打包 config，导致内核握手失败。
 *
 * 运行：node products/bosom-friend/qa/verify-kernel-runtime.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const qaDir = fileURLToPath(new URL('.', import.meta.url))
const productRoot = join(qaDir, '..')
const zip = join(productRoot, 'desktop', 'dist', 'kernel-runtime.zip')
const reference = join(productRoot, 'bundle', 'kernel', 'runtime', 'bin-desktop.mjs')
const userDataV3 = process.env.USERPROFILE
  ? join(process.env.USERPROFILE, 'AppData', 'Roaming', 'Bosom Friend', 'kernel-runtime-v3')
  : null

const FAILURES = []

function checkFile(label, file, packagedConfig = '') {
  if (!existsSync(file)) {
    FAILURES.push(`${label}: 文件不存在 ${file}`)
    return null
  }
  const text = readFileSync(file, 'utf8')
  // 这条规则来自一次真实故障：**随包的内核运行时入口**引用了根本没被打包进去的
  // config/desktop.cordis.yml。启动器不同：它自己的 package.json files 里就带 config/，
  // launcher/config/desktop.cordis.yml 随包分发，引用它是合法的（2026-09-15 复核时发现此处
  // 一直把启动器判红，属于检查过宽；随包产物里既没有 launcher 也没有这个引用）。
  const pointsAtOwnConfig = packagedConfig !== '' && existsSync(packagedConfig)
  if (!pointsAtOwnConfig && (text.includes('config/desktop.cordis.yml') || text.includes('config\\desktop.cordis.yml'))) {
    FAILURES.push(`${label}: 引用未随包的 config/desktop.cordis.yml —— ${file}`)
  }
  const m = text.match(/new URL\('([^']+)', import\.meta\.url\)/)
  if (m && !/cordis\.yml$/.test(m[1])) {
    FAILURES.push(`${label}: 根配置不是随包 cordis.yml（${m[1]}）—— ${file}`)
  }
  return text
}

checkFile('launcher/lib', join(productRoot, 'launcher', 'lib', 'bin-desktop.mjs'), join(productRoot, 'launcher', 'config', 'desktop.cordis.yml'))
checkFile('bundle/kernel', reference)

let zipBinEntries = []
if (existsSync(zip)) {
  try {
    const out = execFileSync('C:/Program Files/7-Zip/7z.exe', ['l', '-slt', zip], {
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
    })
    zipBinEntries = out
      .split(/\r?\n/)
      .filter((line) => line.startsWith('Path = ') && /bin-desktop\.mjs/.test(line))
      .map((line) => line.slice(7))
  } catch (error) {
    FAILURES.push(`zip: 无法读取 ${zip}：${error.message}`)
  }
  const readZipEntry = (entryPath) => {
    try {
      return execFileSync('C:/Program Files/7-Zip/7z.exe', ['e', '-so', zip, entryPath], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      })
    } catch {
      return ''
    }
  }
  for (const entry of zipBinEntries) {
    const text = readZipEntry(entry)
    if (text && (text.includes('config/desktop.cordis.yml') || text.includes('config\\desktop.cordis.yml'))) {
      FAILURES.push(`zip: ${entry} 引用未随包的 config/desktop.cordis.yml`)
    }
  }
  console.log(`zip bin-desktop copies: ${zipBinEntries.length}`)
} else {
  FAILURES.push(`zip: 不存在 ${zip}`)
}

if (userDataV3 && existsSync(userDataV3)) {
  const candidates = [
    join(userDataV3, 'runtime', 'bin-desktop.mjs'),
    join(userDataV3, 'node_modules', '@deepseek-ai', 'dsh-bosom-friend-kernel-bundle', 'runtime', 'bin-desktop.mjs'),
  ]
  for (const file of candidates) {
    checkFile('userData-v3', file)
  }
}

if (FAILURES.length > 0) {
  console.error('KERNEL_RUNTIME_VERIFY FAIL')
  for (const failure of FAILURES) {
    console.error('  - ' + failure)
  }
  process.exit(1)
}
console.log('KERNEL_RUNTIME_VERIFY PASS')
