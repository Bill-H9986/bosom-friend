/**
 * 知音 Harness 对话全链路冒烟测试
 *
 * 通过 CDP 让真实 Agent 跑一轮：监听事件流 → 发起对话 →
 * 等待 agent.done/agent.error，打印完整工具调用轨迹。
 *
 * 用法：node scripts/harness-chat-smoke.cjs
 */
async function main() {
  const targets = await fetch('http://127.0.0.1:9222/json').then((r) => r.json());
  const page = targets.find(
    (t) => t.type === 'page' && t.title === '知音AI内容营销系统',
  );
  if (!page) throw new Error('未找到知音桌面端页面，请先启动 APP');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const waiter = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
      else waiter.resolve(msg.result);
    }
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('CDP 连接失败'));
  });
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = (expression) =>
    send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }).then((r) => r.result.value);

  await evaluate(`(() => {
    window.__harnessEvents = [];
    window.__harnessUnsub = window.zhiyinHarness.onEvent(e => window.__harnessEvents.push(e));
    window.zhiyinHarness.chat('smoke-chat-1', '请调用系统工具查看运行状态与统计数据，然后用中文简要汇报。');
    return true;
  })()`);

  const deadline = Date.now() + 150_000;
  let done = false;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const events = JSON.parse(
      (await evaluate('JSON.stringify(window.__harnessEvents)')) || '[]',
    );
    const last = events[events.length - 1];
    if (last && (last.type === 'agent.done' || last.type === 'agent.error')) {
      console.log(JSON.stringify(events, null, 2));
      done = true;
      break;
    }
  }
  if (!done) {
    console.error('超时：Agent 未在 150 秒内完成');
    process.exitCode = 1;
  }
  await evaluate('window.__harnessUnsub?.()');
  ws.close();
}

main().catch((error) => {
  console.error('[harness-chat-smoke] 失败:', error.message);
  process.exitCode = 1;
});
