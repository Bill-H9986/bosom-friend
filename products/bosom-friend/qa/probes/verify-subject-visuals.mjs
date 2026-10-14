#!/usr/bin/env node
/**
 * 题材进画面的对账（DEF-117 的证据生成器）：没有产品参考图时，排分镜这一步究竟给厂商写了什么画面。
 *
 * 为什么要有它：DEF-117 的现场是「无人机装调检修培训」的宣传片里出现手机充电、室内伸懒腰——
 * 厂商没有参考图，只能照文字画；文字里不写无人机与工位，画面自然与题材无关。修法落在提示词与兜底编排
 * （`buildStoryboardPrompt` 的 `subject` / `allowBrollWithoutProduct` 与 `ensureBrollShots`），
 * 而"这次到底写没写出题材物件"只有真调一次模型才知道（桩永远按你给的写）。
 *
 * 判据（只对这一层负责，整条编排由 `qa/probes/verify-long-video-e2e.mjs` 覆盖）：
 *   1. **看得见实物**：非口播镜（product/scene）至少 2 个——没有产品参考图也要排 B-roll；
 *   2. **画面点名题材物件**：每一个非口播镜的 visual 至少含一个题材词（无人机/工位/教室/维修/拆/装/
 *      螺旋桨/电机/遥控/实训/设备/工具/场地）；
 *   3. **不落回通用素材**：全片 visual 不出现 DEF-117 现场那类通用词（手机充电/伸懒腰/小黑盒）。
 *
 * 代价：一次真实模型调用（与产品排分镜同一个模型、同一条提示词装配路径），不调厂商出片。
 *
 * 用法：node --import tsx/esm products/bosom-friend/qa/probes/verify-subject-visuals.mjs [--topic <题材>] [--seconds 30]
 * 环境：BF_DSH_HOME 覆盖产品数据根（默认 ~/.bosom-friend）
 * 退出码：0 = 通过；1 = 判红；2 = 环境不满足（没配模型 / 模型调用失败 / 分镜解析不出来）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildStoryboardPrompt, ensureBrollShots, fitScriptToShots, parseShotPlan, subjectFromTopic } from '../../server/src/storyboard.ts'
import { CHARS_PER_SECOND } from '../../server/src/speech.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const QA = dirname(HERE)
const HOME = (process.env.BF_DSH_HOME ?? '').trim() !== '' ? process.env.BF_DSH_HOME.trim() : join(homedir(), '.bosom-friend')

const args = process.argv.slice(2)
const argValue = name => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}
/** 默认题材取自 DEF-117 的现场（用户口径：人社局 无人机「装调检修」就业免费培训）。 */
const TOPIC = argValue('--topic')
  ?? '人社局 无人机「装调检修」就业免费培训：零基础入学、考证上岗、推荐就业，培训期间免学费。'
const SECONDS = Math.max(12, Number(argValue('--seconds') ?? 30) || 30)

/** 题材词：非口播镜的 visual 必须点到其中一个。 */
const SUBJECT_WORDS = ['无人机', '工位', '教室', '维修', '拆', '装', '螺旋桨', '电机', '遥控', '实训', '培训', '设备', '工具', '台面', '场地']
/** DEF-117 现场出现过的通用素材词：画面写回这些就等于没修。 */
const GENERIC_WORDS = ['手机充电', '伸懒腰', '小黑盒', '黑色小盒']

const say = (...parts) => console.log(parts.join(' '))
const checks = []
const record = (name, ok, detail) => {
  checks.push({ name, ok, detail })
  say((ok ? 'PASS ' : 'FAIL ') + name + ' | ' + detail)
}

const configPath = join(HOME, 'bosom-friend', 'llm-user.json')
let config
try {
  config = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''))
}
catch (error) {
  say('SUBJECT_VISUALS SKIP 读不到模型配置 ' + configPath + '：' + String(error))
  process.exit(2)
}
const base = String(config.baseUrl ?? '').replace(/\/+$/, '')
const model = String(config.model ?? '')
if (base === '' || model === '') {
  say('SUBJECT_VISUALS SKIP 模型配置不全（baseUrl / model）')
  process.exit(2)
}

/**
 * 调一次对话模型（与产品同一个 OpenAI 兼容协议）。
 *
 * @param prompt - 完整提示词。
 * @returns 模型正文。
 */
async function callModel(prompt) {
  const response = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(String(config.apiKey ?? '') === '' ? {} : { authorization: 'Bearer ' + String(config.apiKey) }) },
    body: JSON.stringify({ model, temperature: 0.7, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(180_000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error('HTTP ' + String(response.status) + '：' + text.slice(0, 200))
  const body = JSON.parse(text)
  return String(body?.choices?.[0]?.message?.content ?? '')
}

/** 这一条片的口播稿（约 `SECONDS` 秒）：分镜模型只负责画面，台词由稿件分配（与产品同口径）。 */
const SCRIPT = '想学无人机装调检修，却不知道从哪下手？人社局的就业免费培训，零基础也能报名。'
  + '课上讲的是真机：多旋翼怎么拆、机臂怎么装、电机与电调怎么接线，老师手把手带你在工位上练。'
  + '学完考取技能等级证书，学校对接企业推荐就业，培训期间免学费。名额按批次开放，想学的先点下方报名，到校先看真机再决定。'

/** 折算语速用产品口径常量：本机不再合成配音，语速是写稿与排分镜的工程估算值。 */
const pace = CHARS_PER_SECOND
const subject = subjectFromTopic(TOPIC)
say('SUBJECT_VISUALS topic=' + TOPIC)
say('  subject=' + subject + ' seconds=' + String(SECONDS) + ' model=' + model)

// 与 api.ts 的数字人口播路径同一套选项：personOnlyInTalkingHead + subject + allowBrollWithoutProduct + script + 镜头模板。
const prompt = '你是短视频导演。围绕「' + TOPIC + '」写一条 ' + String(SECONDS) + ' 秒的中文带货口播片的分镜。'
  + '\n' + buildStoryboardPrompt(SECONDS, false, {
    charsPerSecond: pace,
    personOnlyInTalkingHead: true,
    subject,
    allowBrollWithoutProduct: true,
    script: SCRIPT,
    cameraMoves: ['固定机位（人物坐/站在镜头前）', '缓慢推近', '半身近景切到产品特写'],
    visualStructure: '人物在画面中的位置与动作 + 身后的环境 + 景别',
    shotSeconds: { min: 4, max: 6 },
  })

let planned = ''
try {
  planned = await callModel(prompt)
}
catch (error) {
  say('SUBJECT_VISUALS SKIP 模型调用失败：' + String(error))
  process.exit(2)
}
const parsed = parseShotPlan(planned, [], 'digital-human')
if (parsed.length === 0) {
  say('SUBJECT_VISUALS SKIP 这次的分镜解析不出镜头（模型输出：' + planned.slice(0, 300).replace(/\s+/g, ' ') + '）')
  process.exit(2)
}
const shots = ensureBrollShots(fitScriptToShots(parsed, SCRIPT, pace), subject)

const broll = shots.filter(shot => shot.kind !== 'talking-head' && shot.kind !== 'text-card')
const visuals = shots.map(shot => shot.visual)
for (const shot of shots)
  say('  [' + String(shot.index + 1).padStart(2, '0') + '] ' + shot.kind + ' ' + String(shot.seconds) + 's ' + shot.visual.slice(0, 110))

const missing = broll.filter(shot => !SUBJECT_WORDS.some(word => shot.visual.includes(word)))
const generic = shots.filter(shot => GENERIC_WORDS.some(word => shot.visual.includes(word)))

record('没有产品参考图也排出了看得见实物的镜头（非口播镜 ≥ 2）', broll.length >= 2,
  '非口播 ' + String(broll.length) + ' / 共 ' + String(shots.length) + ' 镜，题材=' + subject)
record('每一个非口播镜的画面都点名了题材物件', missing.length === 0,
  missing.length === 0 ? '全部命中' : '没点到题材的镜：' + missing.map(shot => String(shot.index + 1) + '（' + shot.visual.slice(0, 40) + '）').join('；'))
record('没有落回 DEF-117 现场那类通用素材', generic.length === 0,
  generic.length === 0 ? '无' : generic.map(shot => String(shot.index + 1) + '：' + shot.visual.slice(0, 60)).join('；'))

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const reportDir = join(QA, 'reports')
mkdirSync(reportDir, { recursive: true })
const reportPath = join(reportDir, 'subject-visuals-' + stamp + '.md')
writeFileSync(reportPath, [
  '# 题材进画面对账（DEF-117）',
  '',
  '- 时间：' + new Date().toISOString(),
  '- 题材：' + TOPIC,
  '- 题材关键词（subject）：' + subject,
  '- 目标时长：' + String(SECONDS) + ' 秒；模型：' + model + '（一次真实调用，不出片）',
  '- 参考图：**没有**（与 DEF-117 现场同条件）',
  '',
  '## 分镜（' + String(shots.length) + ' 镜）',
  '',
  '| # | 类型 | 秒 | 画面 |',
  '| --- | --- | --- | --- |',
  ...shots.map(shot => '| ' + String(shot.index + 1) + ' | ' + shot.kind + ' | ' + String(shot.seconds) + ' | ' + shot.visual.replace(/\|/g, '\\|') + ' |'),
  '',
  '## 判定',
  '',
  ...checks.map(item => '- ' + (item.ok ? 'PASS' : 'FAIL') + ' ' + item.name + '：' + item.detail),
  '',
].join(String.fromCharCode(10)), 'utf8')

const fails = checks.filter(item => !item.ok)
say('SUBJECT_VISUALS ' + (fails.length === 0 ? 'PASS' : 'FAIL') + ' checks=' + String(checks.length) + ' fail=' + String(fails.length) + ' report=' + reportPath)
process.exit(fails.length === 0 ? 0 : 1)
