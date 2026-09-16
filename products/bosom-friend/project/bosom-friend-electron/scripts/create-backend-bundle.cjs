/**
 * 生成随包后端完整 bundle（不含密钥、本地开发数据）。
 *
 * 产物：release/backend-bundle/backend-bundle.zip
 * 用途：上传到 GitHub Releases 的 `backend-bundle` tag，
 * 供 release-electron.yml 在 GitHub Actions 中下载并恢复完整后端资源。
 */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const electronDir = path.resolve(__dirname, '..')
const resourcesDir = path.join(electronDir, 'resources')
const backendDir = path.join(resourcesDir, 'backend')
const outputDir = path.join(electronDir, 'release', 'backend-bundle')
const bundlePath = path.join(outputDir, 'backend-bundle.zip')
const sevenZipPath = path.join(backendDir, 'bin', '7za.exe')

if (!fs.existsSync(backendDir)) {
  throw new Error(`随包后端目录不存在: ${backendDir}`)
}
if (!fs.existsSync(sevenZipPath)) {
  throw new Error(`7-Zip 不存在: ${sevenZipPath}`)
}

fs.mkdirSync(outputDir, { recursive: true })
if (fs.existsSync(bundlePath)) {
  fs.rmSync(bundlePath, { force: true })
}

const args = [
  'a',
  '-tzip',
  bundlePath,
  'backend',
  '-r',
  '-mx=1',
  '-xr!secrets.env',
  '-xr!dev-data',
  '-xr!dump.rdb',
  '-xr!.claude-session',
  '-xr!_src_bak_*',
]

console.log('[backend-bundle] 正在打包随包后端（约 600MB，需要几分钟）...')
execFileSync(sevenZipPath, args, {
  cwd: resourcesDir,
  stdio: 'inherit',
})

const size = fs.statSync(bundlePath).size
console.log(`[backend-bundle] 完成: ${bundlePath}`)
console.log(`[backend-bundle] 大小: ${(size / 1024 / 1024).toFixed(1)} MB`)
