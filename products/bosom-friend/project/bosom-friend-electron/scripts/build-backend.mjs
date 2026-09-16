/**
 * 构建随包后端并同步编译产物。
 *
 * 后端工作区使用 pnpm + Nx，产物由 electron-builder 作为 extraResources 打进安装包。
 * 这里必须先运行后端 build，再把 dist/apps/<app>/src 镜像到 resources/backend/<app>/src，
 * 否则 release.mjs 只会把旧的编译产物装进安装包。
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const electronDir = path.resolve(scriptsDir, '..')
const backendDir = path.resolve(electronDir, '../aitoearn-backend')
const resourcesBackendDir = path.join(electronDir, 'resources', 'backend')

function run(command, cwd) {
  execSync(command, {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      NX_DAEMON: 'false',
      NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=4096',
    },
  })
}

function syncBundledApp(appName, distName) {
  const source = path.join(backendDir, 'dist', 'apps', distName, 'src')
  const target = path.join(resourcesBackendDir, appName, 'src')

  if (!fs.existsSync(source)) {
    throw new Error(`后端构建产物不存在: ${source}`)
  }

  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.rmSync(target, { recursive: true, force: true })
  fs.cpSync(source, target, { recursive: true })

  console.log(`[backend-bundle] 已同步 ${distName} 到 ${path.relative(electronDir, target)}`)
}

function syncBundledLibraries() {
  const distLibsDir = path.join(backendDir, 'dist', 'libs')
  if (!fs.existsSync(distLibsDir)) {
    return
  }

  for (const libraryName of fs.readdirSync(distLibsDir)) {
    const source = path.join(distLibsDir, libraryName)
    const target = path.join(resourcesBackendDir, 'node_modules', '@yikart', libraryName)
    if (!fs.existsSync(path.join(source, 'src'))) {
      continue
    }

    fs.rmSync(target, { recursive: true, force: true })
    fs.cpSync(source, target, { recursive: true })
    console.log(`[backend-bundle] 已同步依赖 @yikart/${libraryName}`)
  }
}

export function buildBundledBackend() {
  if (!fs.existsSync(backendDir)) {
    throw new Error(`后端工作区不存在: ${backendDir}`)
  }

  console.log('[backend-bundle] 开始构建并同步随包后端')
  run(
    'pnpm nx run-many --target=build --projects=aitoearn-ai,aitoearn-server --parallel=1 --verbose',
    backendDir,
  )
  syncBundledApp('ai', 'aitoearn-ai')
  syncBundledApp('server', 'aitoearn-server')
  syncBundledLibraries()
  console.log('[backend-bundle] 随包后端构建与同步完成')
}

// 直接运行时（node scripts/build-backend.mjs）也执行完整流程。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildBundledBackend()
}
