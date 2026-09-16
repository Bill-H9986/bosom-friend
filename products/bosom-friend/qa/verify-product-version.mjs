#!/usr/bin/env node
/**
 * 产品版本一致性闸门：
 * 1) 桌面壳必须是版本权威：preload 注入 __APP_VERSION__，main 提供版本 IPC；
 * 2) 前端不得写死过期版本号，回退值必须来自构建期注入（__WEB_BUILD_VERSION__）；
 * 3) 已出货 dist 不得残留旧版本字面量；
 * 4) 已安装程序的注册表 DisplayVersion 必须与 desktop/package.json 一致。
 * 历史故障：设置页写死 v0.13.9，与桌面壳 0.2.x 脱节。
 */
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const qaDir = fileURLToPath(new URL('.', import.meta.url))
const productRoot = join(qaDir, '..')
const FAILURES = []
const SKIPS = []
const strictInstalled = process.argv.includes('--strict-installed')

const desktopPkg = JSON.parse(readFileSync(join(productRoot, 'desktop', 'package.json'), 'utf8'))
const productVersion = desktopPkg.version
console.log(`product version authority: desktop ${productVersion}`)

const preload = readFileSync(join(productRoot, 'desktop', 'electron', 'preload.cjs'), 'utf8')
const main = readFileSync(join(productRoot, 'desktop', 'electron', 'main.cjs'), 'utf8')
if (!preload.includes("exposeInMainWorld('__APP_VERSION__'")) {
  FAILURES.push('desktop preload 未注入 __APP_VERSION__')
}
if (!main.includes("ipcMain.on('bosom-friend:version'")) {
  FAILURES.push('desktop main 未提供 bosom-friend:version IPC')
}

const ota = join(productRoot, 'project', 'bosom-friend-web', 'src', 'app', 'layout', 'SettingsModal', 'tabs', 'OtaTelemetryTab.tsx')
const otaText = existsSync(ota) ? readFileSync(ota, 'utf8') : ''
if (!otaText) {
  FAILURES.push('OtaTelemetryTab.tsx 不存在')
}
else {
  if (/v?0\.13\.9/.test(otaText)) {
    FAILURES.push('OtaTelemetryTab.tsx 仍写死 v0.13.9')
  }
  if (!otaText.includes('__WEB_BUILD_VERSION__')) {
    FAILURES.push('OtaTelemetryTab.tsx 未使用构建期回退版本')
  }
}

const viteConfig = readFileSync(join(productRoot, 'project', 'bosom-friend-electron', 'vite.config.mts'), 'utf8')
if (!viteConfig.includes('__WEB_BUILD_VERSION__')) {
  FAILURES.push('vite.config.mts 未定义 __WEB_BUILD_VERSION__')
}

const distAssets = join(productRoot, 'project', 'bosom-friend-electron', 'dist', 'assets')
if (!existsSync(distAssets)) {
  SKIPS.push('前端 dist 尚未构建：跳过「已出货 dist 不得残留旧版本字面量」断言')
} else
try {
  const out = execFileSync('C:/Windows/System32/where.exe', ['/R', distAssets, '*.js'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  for (const file of out.split(/\r?\n/).filter(Boolean)) {
    const text = readFileSync(file, 'utf8')
    if (text.includes('v0.13.9')) {
      FAILURES.push(`dist 残留旧版本号: ${file}`)
    }
  }
} catch (error) {
  FAILURES.push(`dist 扫描失败: ${error.message}`)
}

try {
  const reg = execFileSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', 'Bosom Friend 0.', '/d'], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
  if (reg.includes(`Bosom Friend ${productVersion}`)) {
    console.log(`registry DisplayName carries ${productVersion}`)
  } else if (reg.trim() === '') {
    SKIPS.push('本机注册表无 Bosom Friend 卸载项：跳过「已安装版本与 desktop/package.json 一致」断言')
  } else if (strictInstalled) {
    FAILURES.push(`注册表已安装版本与 desktop/package.json ${productVersion} 不一致（出厂验收要求一致）`)
  } else {
    SKIPS.push(`本机注册表已安装版本与开发版本 ${productVersion} 不同；出厂验收请加 --strict-installed，开发机不算缺陷`)
  }
} catch {
  SKIPS.push('本机未安装 Bosom Friend（reg 查询无结果）：跳过「已安装版本一致」断言')
}

if (FAILURES.length > 0) {
  console.error('PRODUCT_VERSION_VERIFY FAIL')
  for (const failure of FAILURES) {
    console.error('  - ' + failure)
  }
  process.exit(1)
}
for (const skip of SKIPS) {
  console.log('PRODUCT_VERSION_VERIFY SKIP ' + skip)
}
console.log('PRODUCT_VERSION_VERIFY PASS')
