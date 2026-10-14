/**
 * 打印每个对象动作**真实送给模型的提示词**。
 *
 * 为什么要有这个探针：DEF-151 就是靠它定位的——「AI 生成话题」在真机上一直回
 * 「模型这次没有给出可用的内容」，看代码怎么看都对；把提示词打出来一眼就看到
 * 模型被要求"读标题与正文"、而标题与正文根本没给。
 *
 * 动作提示词是纯函数（buildObjectActionPrompt），所以这个探针**不需要服务在跑**、不花模型额度。
 *
 * 用法：node --import tsx/esm products/bosom-friend/qa/probes/probe-action-prompts.mjs [kind]
 */
import { OBJECT_ACTIONS, buildObjectActionPrompt } from '../../server/src/object-actions.ts'

/** 每种对象一份样例：字段要与真实数据同形（数组就是数组）。 */
const SAMPLES = {
  draft: { title: '夏日特调三种做法', desc: '三种在家就能做的夏日特调，材料楼下便利店就能买到。', topics: [] },
  account: { type: 'xhs', nickname: '深夜食堂研究所', fansCount: 1234 },
  work: {
    accountType: 'xhs',
    title: '探针作品：夏日特调三种做法',
    publishTime: '2026-09-20T10:00:00.000Z',
    engagement: { viewCount: 1200, likeCount: 88, commentCount: 7, favoriteCount: 31 },
  },
  note: { content: '# 投放经验\n\n- 选题先看评论' },
}

const wanted = process.argv[2]
let printed = 0
for (const spec of OBJECT_ACTIONS) {
  if (wanted !== undefined && spec.kind !== wanted) continue
  const record = SAMPLES[spec.kind]
  if (record === undefined) {
    console.log('=== ' + spec.id + ' ：没有样例数据，跳过 ===')
    continue
  }
  const prompt = buildObjectActionPrompt(spec, spec.current(record), '', spec.context?.(record) ?? '')
  console.log('=== ' + spec.id + '（' + spec.label + '，字段 ' + spec.field + '，' + prompt.length + ' 字）===')
  console.log(prompt)
  console.log('')
  printed += 1
}
console.log('printed=' + printed)
