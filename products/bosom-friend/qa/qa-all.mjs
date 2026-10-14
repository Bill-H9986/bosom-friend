/**
 * qa-all.mjs - QA 总入口（Guard 3.0 标准流程）
 * 固定步骤：1) qa-guard.mjs（21 项功能/品牌） 2) qa-guard2.mjs（26 项 a11y/视觉/性能）
 *          3) verify-drift.mjs（第二份事实漂移） 4) verify-preset-parity.mjs（工具面一致性）
  ['api 冻结增长', 'node qa/verify-api-size.mjs'],
 *          5) qa-docsync.mjs（自动同步报告）
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

// 2026-10-12 修：这一步原来跑 acceptance/frontend-supreme-gate.mjs —— 那属于
// 《S 级前端监考 v4》体系，qa/README.md:114 已声明该体系**废止**（由 BFS-104-R
// 「一句话端到端」取代），但总入口还在跑它，等于每天用废止口径判红绿。
// 换成现行口径的落点：一句话端到端只读用例（需要开发版在跑）。
const ok0 = step("verify-one-sentence-e2e.mjs (BFS-104-R 一句话端到端)", "verify-one-sentence-e2e.mjs")
// 跨步骤门禁：只读那 13 条验的是「一句话能问出一件事」（每条只调一个工具就答），
// 而产品负责人要的是「一句话 AI 把事情全干了」——**拆解 → 多步 → 落库真的变了**。
// 2026-10-12 实测它暴露的三个真 bug（update_draft 只登记不写库 / description 与实现相反 /
// list_drafts 按存储顺序列导致"最新"选错）只读用例一条都碰不到。约 3 分钟（3 个场景 × 间隔）。
const ok0b = step("verify-multistep.mjs (一句话跨步骤办事)", "verify-multistep.mjs")
const ok1 = step("qa-guard.mjs (21 项)", "qa-guard.mjs")
const ok2 = step("qa-guard2.mjs (26 项)", "qa-guard2.mjs")
// 第二份事实漂移门禁：静态、快速、无副作用（契约每次现提取）
const ok3 = step("verify-drift.mjs (第二份事实漂移)", "verify-drift.mjs")
// 管家工具面一致性命中：静态、快速、无副作用（唯一事实源 presets/roles.json）
const ok4 = step("verify-preset-parity.mjs (工具面一致性)", "verify-preset-parity.mjs")
// 分区纪律棘轮：能力只许长、旧形态只许缩（《项目分区图》第七节）
// 加它的原因：实测项目 694,062 行里管家形态只占 1.7%、旧形态占 60.9%——不设棘轮，每加一个页面按钮就再厚一层。
const ok5 = step("verify-zone-discipline.mjs (分区纪律)", "verify-zone-discipline.mjs")
// Marvis 对标进度（BFS-901）：五项目标的方向判红——覆盖率不许降、前端不许长、用例不许减、preset 不许退回。
// 它只判方向不判进度快慢：进度是渐进的，方向错了才是事故。
const ok6 = step("verify-marvis-progress.mjs (Marvis 对标进度)", "verify-marvis-progress.mjs")
// AI 智能体动作链路契约：三态（已申请/已执行/已核验）＋「助手回复不许无凭据声称完成」。
// 零联网、零写库（只读落库 + 读内核产物），很快，所以本来就该常跑。
// 2026-10-13 补接：此前它**一直不在总入口里**，于是「qa-all 全绿」掩盖了它 22 项里的 5 条红
// （Lead 当场点出：门禁没进总入口 = 等于没有这条门禁）。
const ok7 = step("verify-agent-workflow.mjs (AI 智能体动作链路契约)", "verify-agent-workflow.mjs")

// 前端类型门禁（DEF-297 收口，2026-10-13 接入）：此前 tsc 因配置错"看着在跑其实没跑"，
// 69 个类型错误长期潜伏。现在它是真门禁：零错误才过，TS5xxx 配置类错误单独判红。
// 内联而不新增 qa 顶层脚本——分区棘轮规定 qa/ 顶层脚本数只减不增（《项目分区图》）。
// 范围：include 只含活代码（src/commont/web-src）；归档 electron/ 除外（处置待负责人决定）。
const tscRun = spawnSync('npx', ['tsc', '--noEmit'], { cwd: join(BASE, '..', 'project', 'bosom-friend-electron'), shell: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
const tscLines = ((tscRun.stdout ?? '') + (tscRun.stderr ?? '')).split(/\r?\n/)
const tscErrors = tscLines.filter((line) => /error TS\d+/.test(line))
const tscConfigErrors = tscLines.filter((line) => /error TS5\d{3}/.test(line))
const ok8 = tscRun.status === 0 && tscErrors.length === 0
console.log('\n[verify-typecheck (前端类型门禁)] exit=' + String(tscRun.status) + ' errors=' + String(tscErrors.length) + (tscConfigErrors.length > 0 ? '（含配置类 TS5xxx：门禁没在检查代码）' : ''))
if (!ok8) for (const line of (tscConfigErrors.length > 0 ? tscConfigErrors : tscErrors).slice(0, 10)) console.log('  ' + line)

// 文档同步：必须在前两步产出结果后进行；无论成败都同步（报告如实记录）
step("qa-docsync.mjs (文档同步)", "qa-docsync.mjs")

if (!ok0 || !ok0b || !ok1 || !ok2 || !ok3 || !ok4 || !ok5 || !ok6 || !ok7 || !ok8) {
  console.log('\n=== QA-ALL: BLOCKED（先修失败项，文档已如实记录） ===')
  process.exit(1)
}
console.log('\n=== QA-ALL: 全部通过 + 文档已自动同步 ===')
