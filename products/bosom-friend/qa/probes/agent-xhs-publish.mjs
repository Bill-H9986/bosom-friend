// 业务全流程驱动器：APP 智能体创作 → 封面生成 → 真实发布到小红书。
// 本脚本只做「操作员」动作：全程调用 APP 自身接口，不手写任何内容。
const base = 'http://127.0.0.1:3080/bosom-friend/api/'
const log = (...args) => console.log('[FLOW]', ...args)

async function main() {
  // 1. 校验服务端已接管用户的大模型钥匙
  const llmCfg = await (await fetch(base + 'ai/user-llm')).json()
  if (llmCfg.code !== 0 || !llmCfg.data?.hasApiKey) {
    console.log('NO_KEY 服务端尚未拿到你的大模型配置，请先在页面刷新一次完成配置同步')
    process.exit(2)
  }
  log('大模型配置就绪:', llmCfg.data.model, '@', llmCfg.data.baseUrl)

  // 2. 取小红书真实账号
  const acc = await (await fetch(base + 'v2/channels/accounts')).json()
  const xhs = (acc.data?.list ?? []).find(a => a.type === 'xhs')
  if (!xhs) {
    console.log('NO_ACCOUNT 未找到小红书账号')
    process.exit(3)
  }
  log('小红书账号:', xhs.nickname, xhs.id)

  // 3. 驱动 APP 智能体创作（真实大模型生成，操作员不参与写作）
  const prompt = '请为我创作一篇发布到小红书的图文笔记，账号人设是「重庆机长 / 飞行日常」。要求：\n'
    + '1. 标题：20 字以内，有网感、有钩子；\n'
    + '2. 正文：250~400 字，分段、带适量 emoji，口语化，内容真实可信（飞行见闻 / 职业日常 / 旅客贴士均可），不要编造数据；\n'
    + '3. 话题标签：3~5 个。\n'
    + '请严格按下面三段格式输出，不要输出任何多余内容：\n'
    + '标题：……\n正文：……\n话题：#…… #……'
  log('正在驱动 APP 智能体创作…')
  const res = await fetch(base + 'agent/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ prompt, includePartialMessages: true }),
  })
  let text = ''
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      try {
        const payload = JSON.parse(trimmed.slice(5).trim())
        if (payload.type === 'stream_event' && payload.event?.delta?.text)
          text += payload.event.delta.text
      } catch { /* 忽略非 JSON 行 */ }
    }
  }
  if (text.trim() === '') {
    console.log('AGENT_EMPTY 智能体没有返回内容')
    process.exit(4)
  }
  log('智能体创作完成，共', text.length, '字')

  const titleMatch = text.match(/标题[：:]\s*(.+)/)
  const bodyMatch = text.match(/正文[：:]\s*([\s\S]*?)(?=\n\s*话题[：:]|$)/)
  const topicsMatch = text.match(/话题[：:]\s*(.+)/)
  const title = (titleMatch?.[1] ?? '').trim().slice(0, 20)
  const body = (bodyMatch?.[1] ?? text).trim().slice(0, 900)
  const topics = (topicsMatch?.[1] ?? '').split(/[#\s]+/).filter(Boolean).slice(0, 5)
  if (title === '' || body === '') {
    console.log('PARSE_FAIL 智能体输出无法解析:', JSON.stringify(text.slice(0, 200)))
    process.exit(5)
  }
  log('标题:', title)
  log('正文预览:', body.slice(0, 80).replace(/\n/g, ' '), '…')
  log('话题:', topics.join(', '))

  // 4. 由 APP 用标题生成笔记封面卡（图文笔记必须带图）
  const cover = await (await fetch(base + 'ai/note-cover', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, subtitle: topics.slice(0, 2).join(' '), count: 1 }),
  })).json()
  if (cover.code !== 0 || !cover.data?.urls?.length) {
    console.log('COVER_FAIL', cover.message)
    process.exit(6)
  }
  log('封面已生成:', cover.data.urls[0])

  // 5. 通过 APP 发布流程提交到真实小红书账号
  const flow = await (await fetch(base + 'v2/channels/publish/flows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: {
        title,
        body,
        topics,
        media: cover.data.urls.map(url => ({ url })),
        cover: { url: cover.data.urls[0] },
      },
      context: { type: 'IMAGE_TEXT' },
      items: [{ accountId: xhs.id, platform: 'xhs' }],
    }),
  })).json()
  if (flow.code !== 0) {
    console.log('FLOW_FAIL', flow.message)
    process.exit(7)
  }
  log('发布任务已提交, flowId=', flow.data.flowId)

  // 6. 轮询发布结果（真实引擎上传，最多 15 分钟）
  for (let round = 1; round <= 90; round++) {
    await new Promise(resolve => setTimeout(resolve, 10_000))
    const recs = await (await fetch(base + `v2/channels/publish/records?accountId=${xhs.id}`)).json()
    const rec = (recs.data?.records ?? []).find(r => r.flowId === flow.data.flowId)
    if (!rec) continue
    log(`第 ${round} 轮: status=${rec.status}${rec.errorMsg ? ' · ' + rec.errorMsg : ''}`)
    if (rec.status === 1) {
      log('✅ 发布成功', rec.platformWorkId ? 'platformWorkId=' + rec.platformWorkId : '', rec.workLink ? 'workLink=' + rec.workLink : '')
      process.exit(0)
    }
    if (rec.status === -1) {
      log('❌ 发布失败:', rec.errorMsg)
      process.exit(8)
    }
  }
  console.log('TIMEOUT 发布超时')
  process.exit(9)
}

main().catch((error) => {
  console.error('DRIVER_ERROR', error)
  process.exit(1)
})
