# 启动页进度条验收

- 时间：2026-09-16T13:34:50.781Z
- 桌面壳：C:\Users\Jay\Desktop\Bosom friend APP\products\bosom-friend\desktop（开发态）
- 档位：未指定（按本机实测）；场景：both

| 场景 | 断言 | 结果 | 证据 |
| --- | --- | --- | --- |
| A | 接入既有服务后进入产品页 | FAIL | 60 秒内未进入产品页 |
| A | 主进程留痕记录了启动里程碑（≥2 步） | FAIL | （无留痕） |
| A | 留痕里百分比单调不减 | PASS | 最大 0% |
| A | 进度走到 100% 并停在同一界面阶段 | FAIL | {} |
| A | 接入路径没有报错 | PASS |  |
| B | 启动页在失败前一直显示进度条 | PASS | 采样 20 次 |
| B | 百分比单调不减 | PASS | 最大 80% |
| B | 不确定态下百分比不推进 | PASS | 未发现按时间爬升 |
| B | 阶段文案逐个推进（≥2 个不同阶段） | PASS | 启动内核服务 → 加载产品界面 |
| B | 显示已用时 | PASS | 已用时 3 秒 |
| B | 百分比文字与可访问值一致 | PASS | 全部一致 |
| B | 填充长度不超过真实进度 | PASS | 最大 80% |
| B | 内核不回应时给出可读原因 | PASS | bosom-friend desktop kernel: DeepSeek Harness runtime is not running |
| B | 失败后提供重试与退出 | PASS | actionsOpen=true |

## 场景 B 采样轨迹（每 5 次取 1 次）

| 时刻(ms) | 阶段 | 百分比 | 模式 | 说明 |
| --- | --- | --- | --- | --- |
| 194 | 启动内核服务 | 30% | indeterminate | 内核进程已启动，等待初始化握手 |
| 1108 | 启动内核服务 | 30% | indeterminate | 内核进程已启动，等待初始化握手 |
| 1908 | 启动内核服务 | 30% | indeterminate | 内核进程已启动，等待初始化握手 |
| 2704 | 加载产品界面 | 80% | indeterminate | 等待产品服务就绪（已等待 0 秒，最长 15 秒） |
