// 智能体规则结构门禁：规则必须齐全、必须有**唯一投递点**、红线必须存在。
//
// 投递点在 2026-09-22 从"每轮拼进提示词"改成"`$DSH_HOME/AGENTS.md` 的自动区块，
// 经官方 agent-instructions 通道在会话建立时注入"（ADR-003 口径二）。
// 所以这里不再断言"api.ts 有没有 import 规则"（那是实现，不是事实），
// 而是断言两件真的事：规则有投递点，且**只有这一个**——两处投递必然漂移。
// 用法：node products/bosom-friend/qa/verify-agent-rules.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const rulesFile = fileURLToPath(new URL('../server/src/agent-rules.ts', import.meta.url))
const apiFile = fileURLToPath(new URL('../server/src/api.ts', import.meta.url))
const contextFile = fileURLToPath(new URL('../server/src/agent-context.ts', import.meta.url))
const rules = readFileSync(rulesFile, 'utf8')
const api = readFileSync(apiFile, 'utf8')
const context = readFileSync(contextFile, 'utf8')

const REQUIRED_SECTIONS = [
  '# 一、身份与目标',
  '# 二、最高原则',
  '# 三、能力边界',
  '# 四、工具使用规则',
  '# 五、标准业务流程',
  '# 六、输出契约',
  '# 七、失败与异常处理',
  '# 八、合规与风控',
  '# 九、自检清单',
  '# 十、红线',
]
const REQUIRED_REDLINES = [
  '泄露密钥',
  '伪造成功',
  '绕过前端',
  '编造数据',
  '违反平台规则',
  '无视限频',
]
const REQUIRED_PLAIN = [
  // 2026-09-29 语义反转：这句原本是"发布回复的固定开头"，现在是**规则明令禁止出现在正文里**的
  // 话术（旧文案被当成作品简介发到抖音过）。所以这里断言它仍被禁止，而不是断言它必须出现。
  '不得出现「已经准备完成」',
  '限频',
  '拟人化',
  // 发布闸门：规则必须写明"只有用户明确要求才发布"，否则跟随模式会把创作请求直接发出去。
  '只有用户在这一句话里明确要求发布',
]

const failures = []
for (const section of REQUIRED_SECTIONS) {
  if (!rules.includes(section)) failures.push('缺少章节：' + section)
}
for (const line of REQUIRED_REDLINES) {
  if (!rules.includes(line)) failures.push('缺少红线：' + line)
}
for (const text of REQUIRED_PLAIN) {
  if (!rules.includes(text)) failures.push('缺少关键约束：' + text)
}
if (!context.includes("from './agent-rules.ts'")) failures.push('agent-context.ts 未引用 agent-rules.ts（规则没有投递点）')
if (!context.includes('lines.push(AGENT_RULES)')) failures.push('buildAgentContext 没有把规则放进稳定语境文件（模型拿不到规则）')
if (api.includes('AGENT_RULES')) failures.push('api.ts 仍在拼规则：投递点必须唯一（稳定语境文件），两处投递必然漂移')
if (rules.length < 2000) failures.push('规则过短（<2000 字符），不足以约束智能体')

// 光把"要用户明确要求才发布"写进规则不够：真正决定动作卡发不发的是 api.ts 里的发布闸门。
// 跟随模式会自动点掉发布动作卡，闸门被摘掉就等于智能体替用户按了发布。
// 【2026-10-12 修正】原来只认字面量 `detectPublishIntent(promptText)`，于是闸门被收紧之后反而误报：
// 闸门在 DEF-240-IMPLEMENT-2 阶段四已改成
//   `detectPublishIntent(extractCurrentTurnText(params.prompt))`
// ——意图判定只看**当前轮用户消息**，不能拿历史文本当本轮的发布授权（比原版更严格）。
// 本条检查的本意是「闸门有没有被接上」，与参数怎么写在无关，所以改成匹配调用本身。
if (!/detectPublishIntent\s*\(/.test(api)) {
  failures.push('api.ts 未在对话链路上调用 detectPublishIntent（发布闸门未接上，创作请求会被直接发布）')
}
if (!/wantsAction && wantsPublish/.test(api)) {
  failures.push('api.ts 的发布动作卡未按 wantsPublish 收口（动作卡仍会在没有发布指令时产出）')
}

if (failures.length > 0) {
  console.log('AGENT_RULES_FAIL')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log(`AGENT_RULES_OK sections=${REQUIRED_SECTIONS.length} chars=${rules.length}`)
