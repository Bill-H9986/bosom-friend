# 第二份事实检测器（Drift Detector）

> 检测目标不是 bug，而是：**同一语义是否在两个地方各有一份定义。**
> 常驻门禁：`node products/bosom-friend/qa/verify-drift.mjs`（已接入 `qa-all.mjs`）

## 用法

```
node qa/verify-drift.mjs                    跑规则；有 DRIFT → exit 1
node qa/verify-drift.mjs --selftest         验证门禁自身 6 个条件
node qa/verify-drift.mjs --mutate <ruleId>  注入漂移，断言必须报 DRIFT
```

## 为什么必须分类

「两份事实是否一致」的判定关系**因实例而异**：映射 / 集合 / 数值 / 判据唯一性 / 蕴含 / 死代码。
不分类就无法机械化。

| 关系 | 说明 | 可机械化 |
| --- | --- | --- |
| 映射一致 | 平台 ID ↔ 引擎 ID ↔ parser 名 | ✓ |
| 集合相等/包含 | 平台级 vs 动作级 | ✓ |
| 数值/字符串相等 | 字数口径、显示名 | ✓ |
| 判据唯一性 | 同一语义的判据出现在几处 | ⚠ 降级实现 |
| 蕴含（类名 ⇒ 可用性） | **静态分析无法证明正向** | ✗ 只能找反例 |
| 死代码 | 一份从未被使用的定义 | ✓ 但**不是漂移** |

**两个关键判断**：
1. **不做「表达式等价」** —— 降级为**判据唯一性**。
2. **死代码单独结果码**（`DEAD_CODE`）—— 它是「从未被使用的第一份事实」，不是漂移。

## 结果码

`CONSISTENT` / `DRIFT` / `SINGLE_SOURCE` / `DECLARED_EXCEPTION` / `DEAD_CODE` / `EXTRACTION_FAILED`

**`EXTRACTION_FAILED` 是自我防御**：提取器返回空集时绝不报「一致」——
本仓库第一阶段就踩过（`.gitignore` 让 ripgrep 静默跳过 vendored 目录，0 命中被误读成「不存在」）。

## 例外表的纪律

`exceptions.mjs` 每条必须带 `category`，**只允许**：
- `cross-world`：两个世界本来就不同（产品 ID vs 引擎 ID）
- `planned`：后端已登记为「计划中」（coming_soon）

**禁止「为了让检测通过」的例外。** 这类必须报 DRIFT。
（本轮就发生过一次：作者一度把真漂移 `wxGzh` 写进例外表以使检测变绿。）

## CLI 契约的来源

**每次门禁运行时现提取**（`extract-contract.py` 用 ast 解析 vendored `sau_cli.py`），
写到临时文件、跑完删除。**不读快照** —— 快照本身会成为新的漂移源。

## 已知真阳性

| 规则 | 漂移 | 状态 |
| --- | --- | --- |
| `platform-keys` | **`wxGzh`**：前端 12 个文件在用，后端频道清单没有，引擎 14 个目录里完全没有 | **未修，门禁如实报红** |
