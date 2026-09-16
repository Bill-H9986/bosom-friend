// 智能体规则结构门禁：规则必须齐全、必须被服务端引用、红线必须存在。
// 用法：node products/bosom-friend/qa/verify-agent-rules.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const rulesFile = fileURLToPath(new URL('../server/src/agent-rules.ts', import.meta.url))
const apiFile = fileURLToPath(new URL('../server/src/api.ts', import.meta.url))
const rules = readFileSync(rulesFile, 'utf8')
const api = readFileSync(apiFile, 'utf8')

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
  '好的，内容已经准备完成。请点击下方「去发布」按钮',
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
if (!api.includes("from './agent-rules.ts'")) failures.push('api.ts 未引用 agent-rules.ts（规则未生效）')
if (rules.length < 2000) failures.push('规则过短（<2000 字符），不足以约束智能体')

// 光把"要用户明确要求才发布"写进规则不够：真正决定动作卡发不发的是 api.ts 里的发布闸门。
// 跟随模式会自动点掉发布动作卡，闸门被摘掉就等于智能体替用户按了发布。
if (!api.includes('detectPublishIntent(promptText)')) {
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
