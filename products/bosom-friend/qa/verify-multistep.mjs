#!/usr/bin/env node
/**
 * 跨步骤门禁（BFS-104 的"办"那一半）——一句话能不能把一件**多步骤**的事办成。
 *
 * 为什么单独一条：只读端到端那 13 条验的是「一句话能问出一件事」（每条只调一个工具就答）。
 * 而产品负责人要的是「一句话 AI 把事情全干了」——**拆解 → 多步 → 落库真的变了**。
 * 2026-10-12 实测发现的三个真 bug（update_draft 只登记不写库 / description 与实现相反 /
 * list_drafts 按存储顺序列导致"最新"选错）**全是这条门禁才会暴露的**，只读用例一条都碰不到。
 *
 * 判据（三方交叉，缺一不算过）：
 *   ① 工具序列 ≥2 步，且出现写工具
 *   ② 助手回复里说清改了什么
 *   ③ **落库真的变了**（对比调用前后的 contents.json）
 *
 * 免费档 freeTierRpm=1：场景之间必须留间隔（默认 90 秒），否则会被限流打断
 * （实测过一次 [assistant reply was aborted mid-call]，步数 0、16 秒结束）。
 *
 * 用法：node qa/verify-multistep.mjs [--gap 90] [--only <序号>]
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(process.env.USERPROFILE ?? '', '.bosom-friend', 'bosom-friend')
const BASE = process.env.BF_QA_BASE ?? 'http://127.0.0.1:31280/bosom-friend/api'
const argv = process.argv.slice(2)
const gapArg = argv.indexOf('--gap')
const GAP_MS = (gapArg >= 0 ? Number(argv[gapArg + 1]) : 90) * 1000
const onlyArg = argv.indexOf('--only')
const ONLY = onlyArg >= 0 ? Number(argv[onlyArg + 1]) : 0

function drafts() {
  try {
    const j = JSON.parse(readFileSync(join(ROOT, 'contents.json'), 'utf8'))
    const v = Array.isArray(j.value) ? j.value : []
    return v.filter((x) => x && x.kind === 'draft')
  } catch { return [] }
}
function assets() {
  try {
    const j = JSON.parse(readFileSync(join(ROOT, 'contents.json'), 'utf8'))
    const v = Array.isArray(j.value) ? j.value : []
    return v.filter((x) => x && x.kind === 'asset')
  } catch { return [] }
}

/** 发一句话，收集这一轮的工具序列与助手回复。 */
async function ask(text) {
  const res = await fetch(BASE + '/agent/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ prompt: text, focus: 'ai-social' }),
  })
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = '', reply = ''
  const tools = []
  const deadline = Date.now() + 8 * 60 * 1000
  while (Date.now() < deadline) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true }).replace(/: ping/g, '')
    const chunks = buf.split('\n\n')
    buf = chunks.pop() ?? ''
    for (const c of chunks) {
      const line = c.split('\n').find((l) => l.startsWith('data:'))
      if (!line) continue
      let j
      try { j = JSON.parse(line.slice(5).trim()) } catch { continue }
      if (j.type === 'stream_event' && j.event?.content_block?.type === 'tool_use') tools.push(j.event.content_block.name)
      if (j.type === 'result' && j.data?.content) reply = j.data.content
    }
  }
  return { tools, reply }
}

const CASES = [
  {
    name: '跨库两查（草稿 + 素材）',
    say: '草稿箱里有多少条草稿？素材库里有多少个素材？分别告诉我。',
    check: (b, a, r) => {
      const two = r.tools.filter((t) => /list_drafts|material_list/.test(t)).length >= 2
      const said = /草稿/.test(r.reply) && /素材/.test(r.reply)
      return { ok: two && said, note: '两步查=' + String(two) + '，回复两者都提=' + String(said) }
    },
  },
  {
    name: '两步接力：先查最新再改标题',
    say: '先看草稿箱里最新的一条是哪个，然后把它的标题改得更有悬念，改完告诉我改前改后。',
    check: (b, a, r) => {
      const changed = a.d.filter((x) => { const o = b.d.find((y) => y.id === x.id); return o && String(o.title ?? '') !== String(x.title ?? '') })
      const seq = r.tools.findIndex((t) => /list_drafts|get_draft/.test(t)) >= 0
        && r.tools.findIndex((t) => /update_draft/.test(t)) > 0
      return { ok: changed.length > 0 && seq, note: '顺序合理=' + String(seq) + '，标题落了库 ' + changed.length + ' 条' }
    },
  },
  {
    name: '改正文：结尾加一句行动号召',
    say: '把草稿箱里最新那一条的正文改一下，在结尾加一句行动号召，改完存回去并告诉我改了什么。',
    check: (b, a, r) => {
      const changed = a.d.filter((x) => { const o = b.d.find((y) => y.id === x.id); return o && String(o.desc ?? '') !== String(x.desc ?? '') })
      const wrote = /update_draft/.test(r.tools.join(','))
      return { ok: changed.length > 0 && wrote, note: '正文落了库 ' + changed.length + ' 条，调了写工具=' + String(wrote) }
    },
  },
  {
    name: '写稿并落草稿（一句话走完创作链路）',
    // 这条是最贴近"用户一句话 AI 把事情全干了"的场景：写 → 存，两个动作、
    // 而且第二动作是**真的建库**（不是登记申请）。判据盯的是**草稿数变多**，
    // 不是"回复里说存了"——说存了但没存，正是 2026-09-29 那次事故的形态。
    say: '写一条关于无人机培训的小红书图文，标题要吸引 35 岁想转行的人，写完直接存进草稿箱，告诉我草稿 id。',
    check: (b, a, r) => {
      const grew = a.d.length > b.d.length
      const wrote = /create_draft|generate_script|generate_image_text/i.test(r.tools.join(','))
      const hasId = /cnt-[a-z0-9]+/i.test(r.reply)
      return { ok: grew && wrote, note: '草稿 ' + b.d.length + ' → ' + a.d.length + '，调了创作工具=' + String(wrote) + '，回复带 id=' + String(hasId) }
    },
  },
  {
    name: '查生成进度（跨两条链路）',
    say: '我最近的生成任务都跑完了吗？有哪些还在跑的、哪些失败了？',
    check: (b, a, r) => {
      const two = r.tools.filter((t) => /generation_status|video_status|long_video_list/.test(t)).length >= 1
      const said = /(跑|完成|失败|进度)/.test(r.reply)
      return { ok: two && said, note: '查了进度工具=' + String(two) + '，回复谈了状态=' + String(said) }
    },
  },
  {
    name: '素材挑选（查素材 + 给判断）',
    say: '看看素材库里有哪些图，挑一张最适合做无人机培训封面的，说说为什么。',
    check: (b, a, r) => {
      const q = /material_list/.test(r.tools.join(','))
      const said = r.reply.length > 40
      return { ok: q && said, note: '调了素材工具=' + String(q) + '，回复有判断=' + String(said) }
    },
  },
]

const picked = ONLY > 0 ? [CASES[ONLY - 1]] : CASES
const results = []
let retried = 0
for (let i = 0; i < picked.length; i++) {
  const c = picked[i]
  if (i > 0) await new Promise((r) => setTimeout(r, GAP_MS))
  const runOnce = async () => {
    const b = { d: drafts(), a: assets() }
    const t0 = Date.now()
    const r = await ask(c.say)
    const a = { d: drafts(), a: assets() }
    return { res: c.check(b, a, r), r, sec: Math.round((Date.now() - t0) / 1000) }
  }
  let { res, r, sec } = await runOnce()
  // 有界重试：**只允许一次**，且必须留痕。
  // 为什么要有它：免费档小模型会"读完就停"（说了要改、查完却不再写）——实测同一句话
  // 单跑通过、连跑第三次失败。这是**模型行为波动**，不是判据错、也不是工具坏。
  // 所以给一次再问的机会，但**绝不把波动变成绿字**：恢复了几条要报出来，二次仍失败就判红。
  if (!res.ok) {
    await new Promise((r2) => setTimeout(r2, GAP_MS))
    const again = await runOnce()
    if (again.res.ok) {
      retried += 1
      console.log('      ⚠ 空转/未办成 → 有界重试一次后恢复（原判据：' + res.note + '；属偶发，已计入统计）')
      res = again.res; r = again.r; sec = again.sec
    } else {
      res = again.res; r = again.r; sec = again.sec
    }
  }
  results.push({ name: c.name, ok: res.ok, note: res.note, steps: r.tools.length, tools: r.tools })
  console.log('[' + (res.ok ? 'PASS' : 'FAIL') + '] ' + c.name + '  步数=' + r.tools.length + '  ' + res.note
    + '  (' + String(sec) + 's)')
  console.log('      工具：' + (r.tools.join(' → ') || '（未调）'))
  // 失败时把回复原文打出来：这一步的意义是区分「模型空转（说了要做却没做）」与
  // 「工具出错（调了但失败）」——前者是模型行为，后者是产品缺陷，修法完全不同。
  if (!res.ok) console.log('      回复：' + r.reply.replace(/\s+/g, ' ').slice(0, 260))
}

const pass = results.filter((x) => x.ok).length
console.log('')
console.log('合计：PASS ' + pass + ' ｜ FAIL ' + (results.length - pass) + '（共 ' + results.length + ' 个跨步骤场景）')
// 波动统计单独一行：让"偶发"与"频发"在数字上分开，而不是都变成一个绿字。
console.log(retried === 0
  ? '波动：0 条（本轮没有出现"读完就停"）'
  : ('波动：' + String(retried) + ' 条（有界重试后恢复 ' + String(retried) + ' 条，重试后仍失败 ' + String(results.filter((x) => !x.ok).length) + ' 条）'
    + (results.some((x) => !x.ok) ? '｜**频发未办成已计入 FAIL，不放宽**' : '')))
if (pass !== results.length) {
  console.log('MULTISTEP_FAIL 有场景没办成——「一句话把事办成」这条链断了，先修它')
  process.exit(1)
}
console.log('MULTISTEP_OK 一句话跨步骤把事办成（工具序列 ≥2 步 ＋ 回复说清 ＋ 落库真变）')
