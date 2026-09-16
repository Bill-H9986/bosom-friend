#!/usr/bin/env node
/**
 * 知识库蒸馏链路门禁（铁律 #14）：检索 → 注入 → 蒸馏 → 导出 四步真跑。
 *
 * 1. 写入一篇带专属事实的笔记；
 * 2. 注入预览：相关指令命中该笔记，无关指令不命中，自动沉淀审计笔记被排除；
 * 3. 产生一次真实蒸馏样本（对话），断言样本结构完整、状态正确；
 * 4. 导出 JSONL：首行可解析为 OpenAI messages 结构。
 * 结束时清理自检笔记，不触碰用户真实数据。
 *
 * 用法：node products/bosom-friend/qa/knowledge-distill.mjs
 * 退出码：0 = 全绿；1 = 存在失败；2 = 应用未运行
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const ORIGIN = process.env.BF_QA_ORIGIN ?? 'http://127.0.0.1:31280'
const BASE = ORIGIN + '/bosom-friend/api/'
const TOKEN = process.env.BF_QA_TOKEN ?? 'bf-local-guest-token'
const DATA_ROOT = process.env.BOSOM_FRIEND_HOME ?? join(homedir(), '.bosom-friend', 'bosom-friend')
const STAMP = String(Date.now()).slice(-6)
const NOTE_NAME = '自检知识-' + STAMP
const FACT = '自检专属事实' + STAMP
const results = []

function check(ok, id, detail) {
  results.push({ ok, id, detail })
  console.log((ok ? 'PASS ' : 'FAIL ') + id + ' | ' + detail)
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { code: -1, message: text.slice(0, 200) } }
  return { status: res.status, code: json.code, data: json.data, message: json.message, raw: text }
}

async function main() {
  try {
    const probe = await api('GET', 'knowledge/distill/stats')
    if (probe.code !== 0) throw new Error('code=' + probe.code)
  } catch (error) {
    console.log('KNOWLEDGE_DISTILL SKIP 应用未运行（' + ORIGIN + '）：' + (error instanceof Error ? error.message : String(error)))
    process.exit(2)
  }

  let notePath = ''
  try {
    // 1. 写入专属知识笔记
    const created = await api('POST', 'knowledge/notes', { name: NOTE_NAME, folder: '' })
    notePath = created.data?.path ?? ''
    check(notePath !== '', '检索·写入知识笔记', 'path=' + notePath)
    await api('PUT', 'knowledge/notes/' + encodeURIComponent(notePath), {
      content: '# ' + NOTE_NAME + '\n\n重庆夜景内容必须带口号：' + FACT + '。',
    })

    // 2. 相关指令必须命中；无关指令不得命中；审计笔记必须被排除
    const hit = await api('POST', 'knowledge/inject-preview', { query: '写一条重庆夜景口播脚本' })
    const hitPaths = hit.data?.paths ?? []
    check(hitPaths.includes(notePath), '注入·相关指令命中笔记', 'paths=' + JSON.stringify(hitPaths))
    check((hit.data?.block ?? '').includes(FACT), '注入·上下文包含专属事实', 'chars=' + (hit.data?.chars ?? 0))
    const miss = await api('POST', 'knowledge/inject-preview', { query: '帮我报销这个月的房租发票' })
    check((miss.data?.paths ?? []).length === 0, '注入·无关指令不命中', 'paths=' + JSON.stringify(miss.data?.paths ?? []))
    const excluded = hit.data?.excluded ?? []
    check(!hitPaths.some(p => String(p).startsWith('自动沉淀/')), '注入·审计笔记被排除', 'excluded=' + JSON.stringify(excluded.slice(0, 3)))

    // 3. 真实产生一条蒸馏样本（对话）
    const before = (await api('GET', 'knowledge/distill/stats')).data?.total ?? 0
    const chat = await api('POST', 'ai/chat', { messages: [{ role: 'user', content: '用一句话说明重庆夜景口播的要求' }] })
    // ai/chat 是 OpenAI 兼容格式（choices/model 在顶层），不是产品信封 {code,data}。
    let chatBody
    try { chatBody = JSON.parse(chat.raw) } catch { chatBody = undefined }
    const chatText = chatBody?.choices?.[0]?.message?.content ?? ''
    check(chatText !== '', '蒸馏·对话返回内容', 'model=' + (chatBody?.model ?? '') + ' 字数=' + chatText.length)
    const after = (await api('GET', 'knowledge/distill/stats')).data?.total ?? 0
    check(after > before, '蒸馏·样本已入账', 'total ' + before + ' → ' + after)
    const dataset = await api('GET', 'knowledge/distill/dataset?limit=5')
    const sample = (dataset.data?.list ?? [])[0]
    check(sample !== undefined, '蒸馏·数据集可读', 'total=' + (dataset.data?.total ?? 0))
    if (sample !== undefined) {
      check(sample.task === 'chat' && sample.instruction !== '' && sample.output !== '', '蒸馏·样本结构完整', JSON.stringify({ task: sample.task, model: sample.model, injected: (sample.knowledgePaths ?? []).length }))
      const rated = await api('POST', 'knowledge/distill/rate', { id: sample.id, rating: 5 })
      const dataset2 = await api('GET', 'knowledge/distill/dataset?limit=5')
      const sample2 = (dataset2.data?.list ?? []).find(item => item.id === sample.id)
      check(rated.data?.ok === true && sample2?.rating === 5, '蒸馏·评分可回写', 'rating=' + (sample2?.rating ?? 'n/a'))
      await api('POST', 'knowledge/distill/rate', { id: sample.id, rating: 0 })
    }

    // 4. JSONL 导出
    const exported = await api('GET', 'knowledge/distill/export?task=chat')
    const firstLine = exported.raw.split('\n').find(line => line.trim() !== '') ?? ''
    let parsed
    try { parsed = JSON.parse(firstLine) } catch { parsed = undefined }
    const isMessages = Array.isArray(parsed?.messages) && parsed.messages.length === 2 && parsed.messages[0].role === 'user' && parsed.messages[1].role === 'assistant'
    check(isMessages, '导出·JSONL 为 messages 结构', '首行=' + firstLine.slice(0, 120))

    // 5. 落盘：蒸馏样本写在 knowledge.json
    const disk = JSON.parse(readFileSync(join(DATA_ROOT, 'knowledge.json'), 'utf8'))
    const value = disk !== null && typeof disk === 'object' && 'value' in disk ? disk.value : disk
    check(Array.isArray(value?.distillations) && value.distillations.length > 0, '蒸馏·落盘 knowledge.json', '样本数=' + (value?.distillations?.length ?? 0))
  }
  finally {
    if (notePath !== '') await api('DELETE', 'knowledge/notes/' + encodeURIComponent(notePath))
  }

  const pass = results.filter(item => item.ok).length
  const fail = results.length - pass
  console.log('')
  console.log('KNOWLEDGE_DISTILL ' + (fail === 0 ? 'PASS' : 'FAIL') + ' checks=' + results.length + ' pass=' + pass + ' fail=' + fail)
  if (fail > 0) console.log('FAILED: ' + results.filter(item => !item.ok).map(item => item.id).join('、'))
  process.exit(fail === 0 ? 0 : 1)
}

await main()
