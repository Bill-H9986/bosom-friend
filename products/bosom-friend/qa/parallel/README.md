# Bosom Friend 并行桌面测试（2026-09-04）

## 为什么这样做

Agnes 免费版每分钟只能生成一条视频，串行等待会浪费大量时间；同时模块之间不能共享数据，
否则账号、知识库、发布弹窗会互相污染。因此采用“并行 worker + 严格隔离”的方式：

1. 每个 worker 使用独立 Electron `userData`，单实例锁按目录隔离，可以同时启动；
2. 每个 worker 使用独立 `BF_DESKTOP_PORT`，避免本地 Web 服务端口冲突；
3. 每个 worker 使用独立 `BOSOM_FRIEND_HOME`，产品 JSON、知识库、账号、生成结果互不干扰；
4. 运行时装被只读复用，产品数据仍完全隔离；
5. 只通过真实页面点击/填写/等待，网络请求只做观察，不用接口结果冒充页面通过。

## 入口

```powershell
node products/bosom-friend/qa/parallel/run-parallel.mjs
node products/bosom-friend/qa/parallel/worker-content.mjs
node products/bosom-friend/qa/parallel/worker-ai-chat.mjs
```

证据目录：`products/bosom-friend/qa/evidence/parallel-2026-09-04/`

每个 worker 目录包含 `report.json` 与 `shots/`；视频生成任务由专用 worker 按每分钟限流提交，
其他 worker 并行测试 UI/知识库/监控/发布弹窗。
