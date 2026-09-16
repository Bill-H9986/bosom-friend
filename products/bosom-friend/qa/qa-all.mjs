/**
 * qa-all.mjs - QA 总入口（Guard 3.0 标准流程）
 * 固定步骤：1) qa-guard.mjs（21 项功能/品牌） 2) qa-guard2.mjs（25 项 a11y/视觉/性能） 3) qa-docsync.mjs（自动同步报告）
 * 任何一步失败即整体失败（文档不覆盖失败状态，报告如实反映 BLOCKED）。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const BASE = dirname(fileURLToPath(import.meta.url))

function step(name, file) {
  const r = spawnSync('node', [join(BASE, file)], { stdio: 'inherit', cwd: BASE })
  console.log('\n[' + name + '] exit=' + r.status)
  return r.status === 0
}

const ok0 = step("frontend-supreme-gate.mjs (S级前端门槛)", "acceptance/frontend-supreme-gate.mjs")
const ok1 = step("qa-guard.mjs (21 项)", "qa-guard.mjs")
const ok2 = step("qa-guard2.mjs (25 项)", "qa-guard2.mjs")

// 文档同步：必须在前两步产出结果后进行；无论成败都同步（报告如实记录）
step("qa-docsync.mjs (文档同步)", "qa-docsync.mjs")

if (!ok0 || !ok1 || !ok2) {
  console.log('\n=== QA-ALL: BLOCKED（先修失败项，文档已如实记录） ===')
  process.exit(1)
}
console.log('\n=== QA-ALL: 全部通过 + 文档已自动同步 ===')
