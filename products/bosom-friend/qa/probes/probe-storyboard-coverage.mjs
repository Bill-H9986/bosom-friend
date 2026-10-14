#!/usr/bin/env node
/**
 * 长视频分镜的"台词够不够"探针（DEF-132 的证据生成器）。
 *
 * 问的是一个问题：**排分镜的模型自己写词时，写得够不够一条 N 秒的片子？**
 * 够不够的判据是目标时长折算出来的字数下限（与产品同一把尺子：去标点 + 产品语速 4.5 字/秒）。
 *
 * 为什么要单独一支探针：这是**要花钱的真实模型调用**，不能进每次都要跑的门禁；
 * 但"模型写得短"这件事只能靠真实调用看出来（桩永远按你给的写）。
 * 2026-09-22 的三轮结果：59% / 72% / 83%——三次都够不到，这就是"台词必须由稿件分配"的判据来源。
 *
 * 用法（需要 app 数据根里已配置对话模型）：
 *   node --import tsx/esm products/bosom-friend/qa/probes/probe-storyboard-coverage.mjs [目标秒数]
 *
 * 退出码：0 = 模型自己写词就够（提示词足够强）；1 = 不够（必须由稿件分配台词）。
 * @module qa/probes/probe-storyboard-coverage
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildStoryboardPrompt, fitScriptToShots, subjectFromTopic } from '../../server/src/storyboard.ts'
import { CHARS_PER_SECOND, minScriptChars, SPOKEN_STYLE_RULES, spokenCharCount } from '../../server/src/speech.ts'

const configPath = join(homedir(), '.bosom-friend', 'bosom-friend', 'llm-user.json')
const config = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''))
const targetSeconds = Number(process.argv[2] ?? 90)
const topic = process.argv[3] ?? '秋冬保湿面霜，主打干皮救急，成分温和不刺激，敏感肌也能用。今天直播间下单直降一百，前一百名送同款小样三件套。'
const pace = CHARS_PER_SECOND
const required = minScriptChars(targetSeconds, pace)
const segments = Math.ceil(targetSeconds / 12)

/** 调一次对话模型（与产品走同一个 OpenAI 兼容协议）。 */
async function callModel(prompt) {
  const response = await fetch(config.baseUrl.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + config.apiKey },
    body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: prompt }], temperature: 0.7 }),
  })
  const body = await response.json()
  if (!response.ok) throw new Error('HTTP ' + String(response.status) + ' ' + JSON.stringify(body).slice(0, 300))
  return body.choices?.[0]?.message?.content ?? ''
}

const brief = '写一段约 ' + String(targetSeconds) + ' 秒的中文带货口播稿：'
  + '口语化、开头有钩子、中间讲清卖点、结尾有行动号召。'
  + '全片按约 ' + String(segments) + ' 个镜头分段推进，内容要撑满整段时长，不要一句话就收尾。'
  + SPOKEN_STYLE_RULES
  + '只输出可以直接念出来的正文，不要标题、不要分镜、不要话题标签、不要任何说明。'
const instruction = '成片目标 ' + String(targetSeconds) + ' 秒，分成约 ' + String(segments) + ' 个镜头。'
  + '按这条音色每秒 ' + String(pace) + ' 个字算，全文不少于 ' + String(required) + ' 字（不含标点），'
  + '宁多不少：字数不够，配音就会拖长音，成片变成慢速念白。'
  + '写成连续的一整段口播，不要分点、不要小标题、不要场景说明、不要任何解释。'

const script = await callModel('你是短视频编剧。围绕「' + topic + '」' + brief + '\n' + instruction)
const scriptChars = spokenCharCount(script)
console.log('稿件 ' + String(scriptChars) + ' 字（目标 ' + String(targetSeconds) + ' 秒需要 ' + String(required) + ' 字）')

const prompt = '你是短视频导演。围绕「' + topic + '」' + brief + '\n' + instruction + '\n'
  + buildStoryboardPrompt(targetSeconds, false, {
    charsPerSecond: pace,
    personOnlyInTalkingHead: true,
    subject: subjectFromTopic(topic),
    allowBrollWithoutProduct: true,
    script,
  })
const planned = JSON.parse(await callModel(prompt).then(text => text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)))
const shots = planned.shots ?? []
const modelChars = shots.reduce((total, shot) => total + spokenCharCount(shot.line ?? ''), 0)
console.log('分镜 ' + String(shots.length) + ' 镜；模型自己写的台词合计 ' + String(modelChars) + ' 字 → 覆盖 '
  + String(Math.round((modelChars / required) * 100)) + '%')
const fitted = fitScriptToShots(shots.map((shot, index) => ({ ...shot, index })), script, pace)
const fittedChars = fitted.reduce((total, shot) => total + spokenCharCount(shot.line), 0)
console.log('按稿件分配后台词合计 ' + String(fittedChars) + ' 字 → 覆盖 ' + String(Math.round((fittedChars / required) * 100)) + '%'
  + '（折算成片 ' + (fittedChars / pace).toFixed(1) + ' 秒）')
process.exit(fittedChars >= required ? 0 : 1)
