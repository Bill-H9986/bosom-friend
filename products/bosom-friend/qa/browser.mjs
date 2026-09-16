/**
 * qa/browser.mjs - 浏览器依赖解析。
 *
 * 历史问题：qa 脚本把 playwright 的安装路径写死成
 * `<repo>/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core`，
 * 依赖树一变（版本升级、pnpm 重新布局）整批脚本就 MODULE_NOT_FOUND，
 * 门禁链（qa-all → qa-guard/qa-guard2）跟着整条失效，而且失效方式看起来像"没跑"。
 *
 * 这里按"谁装了就用谁"的顺序解析：先 e2e 套件自带的 playwright，
 * 再仓库根，再产品前端的依赖。全都找不到时抛带路径清单的错误，而不是静默降级。
 *
 * @returns playwright 模块（含 chromium / _electron 等入口）。
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
// 本文件就在 qa/ 下：qa → products/bosom-friend → 仓库根。
const QA_DIR = dirname(fileURLToPath(import.meta.url))
const PRODUCT_DIR = dirname(QA_DIR)
const REPO_DIR = dirname(dirname(PRODUCT_DIR))

/** 候选安装位置：先 qa 自带，再仓库根，最后产品前端的依赖。 */
const CANDIDATES = [
  join(QA_DIR, 'e2e', 'node_modules', 'playwright'),
  join(REPO_DIR, 'node_modules', 'playwright'),
  join(REPO_DIR, 'node_modules', 'playwright-core'),
  join(PRODUCT_DIR, 'project', 'bosom-friend-electron', 'node_modules', 'playwright'),
  join(PRODUCT_DIR, 'project', 'bosom-friend-electron', 'node_modules', 'playwright-core'),
]

/**
 * 解析 playwright 模块。
 *
 * @returns playwright 模块对象。
 * @throws 所有候选位置都不存在时，报出实际找过的路径。
 */
export function loadPlaywright() {
  for (const candidate of CANDIDATES) {
    if (!existsSync(candidate)) continue
    try {
      return require(candidate)
    }
    catch {
      // 目录在但加载失败（例如半装的依赖）时继续试下一个候选。
    }
  }
  throw new Error('找不到 playwright：找过 ' + CANDIDATES.join(' | ') + '。请在 qa/e2e 里执行 npm install。')
}

/** 便捷入口：只要 chromium。 */
export function loadChromium() {
  return loadPlaywright().chromium
}