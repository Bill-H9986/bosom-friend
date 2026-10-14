/**
 * 知音 Harness 真机冒烟测试
 *
 * 通过 CDP（9222）连接运行中的桌面端，调用 preload 暴露的 zhiyinHarness 桥，
 * 验证：桥存在 → status → statistics 两条真实通路。
 *
 * 用法：node scripts/harness-smoke.cjs
 */
async function main() {
  const targets = await fetch('http://127.0.0.1:9222/json').then((r) => r.json());
  const page = targets.find(
    (t) => t.type === 'page' && t.title === '知音AI内容营销系统',
  );
  if (!page) {
    throw new Error('未找到知音桌面端页面，请先启动 APP');
  }

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

  const expression = `(async () => {
    const bridge = window.zhiyinHarness;
    if (!bridge) return JSON.stringify({ error: 'zhiyinHarness 桥未加载' });
    const status = await bridge.invoke('status');
    const stats = await bridge.invoke('statistics');
    const tasks = await bridge.invoke('tasks.list');
    return JSON.stringify({ bridge: true, status, stats, tasks });
  })()`;

  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log(result.result.value);
  ws.close();
}

main().catch((error) => {
  console.error('[harness-smoke] 失败:', error.message);
  process.exitCode = 1;
});
