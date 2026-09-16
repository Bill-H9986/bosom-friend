/**
 * 出包前核对：运行时里那几份**配置文件**是不是工作区的最新版。
 *
 * 为什么需要这一步（DEF-060 的教训）：injectWorkspacePackages 把工作区包按 (名字, 版本, peer 集合)
 * 物化到 .pnpm/<id>/，注入副本**不随文件内容变化刷新**。实测（2026-09-16）：改了
 * bundle/desktop/cordis.patch.yml 的端口后跑 pnpm install，注入副本还是旧内容 —— 于是运行时加载的
 * 仍是旧配置，「改了没生效」且没有任何提示。改这类非 lib 文件必须**提版本号**再 install。
 *
 * 本脚本把这条隐式规则变成显式红线：逐个比对运行时里加载的补丁/配置与工作区源文件的
 * 字节与所属包版本，不一致就判红并给出修法。
 *
 * 用法：node verify-runtime-config-drift.mjs <仓库根>
 * 退出码：0 = 无漂移；1 = 有漂移（打印是哪个文件、怎么修）。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = process.argv[2] ?? process.cwd()
const runtimeRoot = join(repoRoot, 'products/bosom-friend/desktop/dist/kernel-runtime-unpacked')
const runtimeNodeModules = join(runtimeRoot, 'node_modules')

// 运行时启动时会 require.resolve 的三个 bundle 补丁层，加上部署根自己的入口与根配置。
const LAYERS = [
  { pkg: '@deepseek-ai/dsh-base', workspace: join(repoRoot, 'packages/bundle/base') },
  { pkg: '@deepseek-ai/dsh-bosom-friend-kernel', workspace: join(repoRoot, 'products/bosom-friend/kernel') },
  { pkg: '@deepseek-ai/dsh-bosom-friend-desktop-bundle', workspace: join(repoRoot, 'products/bosom-friend/bundle/desktop') },
]
const ROOT_FILES = ['runtime/bin-kernel.mjs', 'runtime/bin-desktop.mjs', 'cordis.yml']

/** 一个文件的 sha256，读不到返回 null。 */
function hash(file) {
  return existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null
}

/** 找运行时里某个包的**真实**副本（跳过指向同一实体的联接点）。 */
function runtimeCopies(name) {
  const found = []
  const direct = join(runtimeNodeModules, name)
  if (existsSync(direct)) found.push(direct)
  const pnpm = join(runtimeNodeModules, '.pnpm')
  if (existsSync(pnpm)) {
    for (const entry of readdirSync(pnpm)) {
      const candidate = join(pnpm, entry, 'node_modules', name)
      if (existsSync(candidate)) found.push(candidate)
    }
  }
  return found
}

const failures = []
const runtimeVersionOf = (copy) => {
  try {
    return JSON.parse(readFileSync(join(copy, 'package.json'), 'utf8')).version
  }
  catch {
    return null
  }
}

for (const layer of LAYERS) {
  const workspaceManifest = JSON.parse(readFileSync(join(layer.workspace, 'package.json'), 'utf8'))
  const copies = runtimeCopies(layer.pkg)
  if (copies.length === 0) {
    failures.push(layer.pkg + ' 在运行时里不存在（先 pnpm deploy 物化）')
    continue
  }
  for (const copy of copies) {
    const runtimeVersion = runtimeVersionOf(copy)
    if (runtimeVersion !== workspaceManifest.version) {
      failures.push(
        layer.pkg + '（' + copy.replace(runtimeRoot, '.') + '）版本 ' + String(runtimeVersion)
        + ' ≠ 工作区 ' + String(workspaceManifest.version)
        + '：注入副本没刷新，改完包内容要提版本号再 pnpm install',
      )
    }
    for (const file of ['cordis.patch.yml', 'cordis.yml']) {
      const source = join(layer.workspace, file)
      if (!existsSync(source)) continue
      const target = join(copy, file)
      if (!existsSync(target)) {
        failures.push(layer.pkg + ' 运行时缺 ' + file)
        continue
      }
      if (hash(source) !== hash(target)) {
        failures.push(layer.pkg + '/' + file + '（' + copy.replace(runtimeRoot, '.') + '）与工作区不一致：注入副本是旧的')
      }
    }
  }
}

for (const file of ROOT_FILES) {
  const source = join(repoRoot, 'products/bosom-friend/bundle/kernel', file)
  const target = join(runtimeRoot, file)
  if (!existsSync(source)) continue
  if (!existsSync(target)) {
    failures.push('运行时缺部署根文件 ' + file)
    continue
  }
  if (hash(source) !== hash(target)) {
    failures.push('部署根文件 ' + file + ' 与 bundle/kernel 源文件不一致（重新 deploy）')
  }
}

if (failures.length > 0) {
  console.error('RUNTIME_CONFIG_DRIFT FAIL')
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}
console.log('RUNTIME_CONFIG_DRIFT PASS（三个补丁层 + 部署根入口，字节与版本都一致）')
