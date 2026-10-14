#!/usr/bin/env node
/**
 * 记忆同步：把 Obsidian「活记忆」的当前状态，同步进 DSH 全局注入层 \`~/.dsh/AGENTS.md\`。
 *
 * 为什么必须有它（2026-10-10 产品负责人质问「你怎么保证新开会话一定会去读」）：
 * - 「让新会话去读文件」依赖自觉，靠不住；**只有内容本身进入自动注入层才是 100% 的**；
 * - 于是把当前状态写进全局注入层；但两处手写必然漂移，所以由本脚本单向生成：
 *   **Obsidian 活记忆是源，全局注入层是产物**，只改源、跑同步，产物永远一致。
 *
 * 安全：解析失败（格式不符 / 关键字段缺失）时**不写**，保留全局层原样并退出码 1。
 *
 * 用法：node products\\bosom-friend\\qa\\memory-sync.mjs [--check]
 *   --check 只比对不写入（有差异时退出码 2）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const MEMORY = 'C:/Users/Jay/Documents/Obsidian Vault/00-工作记忆（随时更新·新会话必读）.md'
const GLOBAL = 'C:/Users/Jay/.dsh/AGENTS.md'
const HEADING = '## 3. 活记忆'

/**
 * 从活记忆的「一、当前状态」表格里取一个字段。
 * 键名允许带括号补充（`**没做的（不许再忘）**`）：2026-10-12 实测严格匹配把该字段读成空串，
 * 那 6 条「不许再忘」因此从未进过自动注入层，而脚本不报错——防遗忘机制静默失效。
 * @param text 活记忆全文
 * @param key 字段名（不含 Markdown 粗体标记）
 * @returns 字段值；取不到时为空串
 */
function field(text, key) {
  const re = new RegExp('\\|\\s*\\*\\*' + key + '(?:（[^）]*）)?\\*\\*\\s*\\|([^|]*)\\|')
  const m = re.exec(text)
  return m === null ? '' : m[1].trim()
}

if (!existsSync(MEMORY)) { console.error('FAIL 找不到活记忆: ' + MEMORY); process.exit(1) }
if (!existsSync(GLOBAL)) { console.error('FAIL 找不到全局注入层: ' + GLOBAL); process.exit(1) }

const mem = readFileSync(MEMORY, 'utf8')
const doing = field(mem, '正在做')
const stuck = field(mem, '卡在哪')
const next = field(mem, '等用户决定')
const shipped = field(mem, '今天真实产出')
/**
 * 2026-10-11 补：产品负责人两次指出「条例和标准都立好了，你怎么还会跑偏」「你没有记忆的问题又出现了」。
 * 根因是文档只在被读的那一刻有效——读完就回到「按今天报上来的问题排优先级」，于是必然跑偏。
 * 所以把**重构进度本身**（六层架构 / 五期 / 还没做的）也注进自动层：
 * 这样「记忆层完全没动」这类事实，每个新会话第一眼就会看到，跑不掉。
 */
const layers = field(mem, '六层进度')
const phases = field(mem, '重构五期')
const missing = field(mem, '没做的')
/**
 * 2026-10-13 补：**目标口径**也必须进自动注入层。
 * 起因（实测）：把统一口径写进「已决策」后，本脚本报「无差异」——「已决策」不在注入字段里，
 * 决策写了也到不了新会话。「目标口径」是全部施工排序的依据，按「没做的」同级对待：缺了就不写，报红。
 */
const goal = field(mem, '目标口径')
if (doing === '' || stuck === '' || next === '' || missing === '' || goal === '') {
  console.error('FAIL 活记忆缺少关键字段（正在做/卡在哪/等用户决定/没做的/目标口径）——不写入，保持原样')
  process.exit(1)
}

const section = [
  HEADING + '（Bosom Friend 项目当前状态 · 随本文件每次会话自动注入）',
  '',
  '> 本节由 \`products/bosom-friend/qa/memory-sync.mjs\` 从 Obsidian 活记忆**自动生成**，不要手改。',
  '> 任何节点完成 / 新发现 / 决策 → 改活记忆的「一、当前状态」→ 跑一次同步。',
  '',
  '- **正在做**：' + doing,
  '- **目标口径**（2026-10-13 统一，全部施工排序以此为准）：' + goal,
  ...(layers === '' ? [] : ['- **六层进度**（总纲 L143-152）：' + layers]),
  ...(phases === '' ? [] : ['- **重构五期**（总纲 L220-230）：' + phases]),
  ...(missing === '' ? [] : ['- **没做的（不许再忘）**：' + missing]),
  '- **卡在哪**：' + stuck,
  '- **下一步（等用户选）**：' + next,
  '',
  '**已产出**：' + (shipped === '' ? '（未登记）' : shipped),
  '**详细活记忆**（未闭环清单 / 逐条流水）：\`' + MEMORY.replace(/\//g, '\\\\') + '\`',
  '**产品负责人全部要求**（9 大主题 / 4594 条发言归纳）：\`products\\\\bosom-friend\\\\docs\\\\规范\\\\需求台账-产品负责人指令.md\`',
  '',
].join('\n')

const globalText = readFileSync(GLOBAL, 'utf8')
const at = globalText.indexOf(HEADING)
if (at === -1) { console.error('FAIL 全局注入层里找不到 ' + HEADING + '——不写入'); process.exit(1) }
const head = globalText.slice(0, at)
const rest = globalText.slice(at)
const nextHeading = rest.indexOf('\n## ', 1)
const tail = nextHeading === -1 ? '' : rest.slice(nextHeading + 1)
const updated = head + section + (tail === '' ? '' : '\n' + tail)

if (updated === globalText) { console.log('OK 已是最新（无差异）'); process.exit(0) }
if (process.argv.includes('--check')) { console.log('DIFF 全局注入层与活记忆不一致'); process.exit(2) }
writeFileSync(GLOBAL, updated, 'utf8')

// 写完读回验证（结构化信号，不看"OK"二字）
const check = readFileSync(GLOBAL, 'utf8')
const ok = check.includes('- **正在做**：' + doing) && check.includes('- **卡在哪**：' + stuck)
  && check.includes('- **目标口径**（2026-10-13 统一，全部施工排序以此为准）：' + goal)
console.log((ok ? 'OK 同步完成' : 'FAIL 写回验证不通过') + ' | 正在做=' + doing.slice(0, 40))
process.exit(ok ? 0 : 1)
