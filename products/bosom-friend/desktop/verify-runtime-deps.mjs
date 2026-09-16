/**
 * 出包前核对：内核运行时里，服务端声明的运行时依赖是不是真的能从服务端解析到。
 *
 * 为什么需要这一步：出包流程第 2 步只把**代码**（lib）同步进运行时，**依赖**不会跟着走——
 * 运行时是更早一次 pnpm deploy 的产物。实测后果（2026-09-14）：服务端新增 msedge-tts 后
 * 没进运行时，内核加载直接抛 ERR_MODULE_NOT_FOUND，装出来的包**完全打不开**，
 * 而第 2 步看上去一切正常。这个脚本把该错误拦在出包之前。
 *
 * 为什么不能只看顶层 node_modules（2026-09-16 改写）：pnpm 11 的部署只在顶层挂
 * 「部署根的直接依赖」（实测 130 个 @deepseek-ai/*），第三方依赖都躺在 .pnpm 虚拟仓里，
 * 服务端包本身也不在顶层（它是 dsh-bosom-friend-kernel 的依赖）。所以这里改成按
 * **Node 的解析规则**核对：对运行时内服务端的每一份物理副本，从它所在目录逐级向上找
 * node_modules，逐个解析 package.json 的 dependencies。
 *
 * 用法：node verify-runtime-deps.mjs <仓库根>
 * 退出码：0 = 依赖齐全；1 = 有缺失（打印缺哪些、从哪份副本解析不到）。
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const repoRoot = process.argv[2] ?? process.cwd()
const serverName = 'dsh-bosom-friend-server'
const runtimeRoot = join(repoRoot, 'products/bosom-friend/desktop/dist/kernel-runtime-unpacked')
const runtimeNodeModules = join(runtimeRoot, 'node_modules')

/** 按 Node 的规则从一个目录向上找包：逐级尝试 <dir>/node_modules/<name>。 */
function resolveFrom(fromDir, name) {
  let current = fromDir
  while (true) {
    const candidate = join(current, 'node_modules', name)
    if (existsSync(candidate)) return candidate
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/** 列出运行时里服务端的每一份物理副本（顶层链接 + .pnpm 里的实体，去重）。 */
function serverCopies() {
  const candidates = []
  const topLevel = join(runtimeNodeModules, '@deepseek-ai', serverName)
  if (existsSync(topLevel)) candidates.push(topLevel)
  const pnpm = join(runtimeNodeModules, '.pnpm')
  if (existsSync(pnpm)) {
    for (const entry of readdirSync(pnpm, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const nested = join(pnpm, entry.name, 'node_modules', '@deepseek-ai', serverName)
      if (existsSync(nested)) candidates.push(nested)
    }
    const hoisted = join(pnpm, 'node_modules', '@deepseek-ai', serverName)
    if (existsSync(hoisted)) candidates.push(hoisted)
  }
  const seen = new Set()
  const copies = []
  for (const candidate of candidates) {
    const real = realpathSync(candidate)
    if (seen.has(real)) continue
    seen.add(real)
    copies.push(real)
  }
  return copies
}

if (!existsSync(runtimeRoot)) {
  console.error('kernel runtime is missing: ' + runtimeRoot)
  console.error('re-materialize the runtime (pnpm deploy) before repacking')
  process.exit(1)
}

const copies = serverCopies()
if (copies.length === 0) {
  console.error('kernel runtime holds no ' + serverName + ' copy; the deploy did not include the server')
  process.exit(1)
}

const serverPkg = JSON.parse(readFileSync(join(repoRoot, 'products/bosom-friend/server/package.json'), 'utf8'))
// 工作区包（@deepseek-ai/*）由运行时自己物化，不在这里核对；只核对第三方运行时依赖。
const expected = Object.keys(serverPkg.dependencies ?? {}).filter(name => !name.startsWith('@deepseek-ai/'))

const failures = []
let resolved = 0
for (const copy of copies) {
  for (const name of expected) {
    const found = resolveFrom(copy, name)
    if (found === null) failures.push(name + ' is not resolvable from ' + copy.replace(repoRoot, '.'))
    else resolved += 1
  }
}

if (failures.length > 0) {
  console.error('kernel runtime is missing server dependencies:')
  for (const failure of failures) console.error('  - ' + failure)
  console.error('re-materialize the runtime (pnpm deploy) before repacking')
  process.exit(1)
}
console.log('runtime dependencies OK (' + expected.length + ' deps x ' + copies.length + ' server copies = ' + resolved + ' resolutions)')
