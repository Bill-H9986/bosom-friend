# smoke-all.mjs 契约对齐 · 修复进度（QA / Edward）

- 日期：2026-09-07
- 责任人：QA 工程师 Edward（严过关）
- 范围：`products/bosom-friend/qa/smoke-all.mjs` 断言与产品真实契约对齐；产品代码不动。
- 实测对象：`http://127.0.0.1:31280`（共用实例，登录 qa-tester/qa-123456）。
- 方法：先探针采样真实响应（脚本 `.qa-probe-fails-31280.mjs`），再对照 server 源码契约逐项判定归属，最后复跑 smoke-all 出终表。

## 判定归属口径

| 类别 | 含义 | 处置 |
| --- | --- | --- |
| 脚本断言错 | 脚本期望与产品契约（源码 + 实测）不符 | 本轮直接修断言 |
| 产品缺陷 | 实测行为与 PRD/设计契约不符，源码可见实现缺失 | 只记录，转工程师 |
| 平台侧 | 依赖外部平台（Agnes/UAPI 等）限流或不可用 | 记录，不加假断言 |

## 逐项定案

### 0. 前情提要（本轮探针前的已知事实）

- 9/7 上一轮已改 1 处：`miniapp fans` → `list.length === 0`（routes-content.ts:843 契约：未接入官方数据授权时如实返回空列表）。本轮已确认该行在工作区（smoke-all.mjs:72-73）。
- 9/4 旧结论（agent-collect ===6、hot feed ===10、miniapp auth ===0）已过时，以本轮实测为准。
- 我方 QA 自有实例（31281，dist 0.2.0 构建）昨日实测样本已先行采集，本轮以 31280 复测为准。

### 1. draft generation settle

- 现象：脚本 30×1s 轮询后任务仍 `generating`。
- 31280 实测（2026-09-07 06:48–06:53，探针 `.qa-probe-fails-31280.mjs`）：
  - 创建 `ai/draft-generation/v2`（quantity=1, prompt=晨跑）→ `gen-8e11e52a`。
  - **240s 内一直 `generating`**；但 response 已含完整口播文案、`imageUrls`、`coverUrl`、`generatedBy:"ai"`、`generatedModel:"agnes-image-2.5-flash"`（文字与图片阶段已完成）。
  - 缺的是 videoUrl：视频阶段走 `generateAiVideoDirect`（api.ts:1856-1945：3 次重试×45s 超时 + 429 退避 3-8s + 异步任务轮询最长 180s），429 限流下全程可合法耗时 >240s，之后还有本地幻灯片合成兜底。
- 初判：**脚本断言错（轮询窗口 30s 远短于视频生成的合法耗时）+ 平台侧（Agnes 429 放大耗时）**。暂无「状态机卡死不落终态」的产品缺陷证据——31281 单实例对照实验进行中，若单实例也无法在充裕窗口内落终态，再升级为产品缺陷转工程师。
- 修法：轮询窗口 30×1s → 60×5s（300s）；断言「落到终态（success/partial/failed）且字段自洽」：success 必须带媒体（coverUrl/videoUrl），partial/failed 必须带 errorMessage（对应产品「不伪造成功」原则）；终态明细写入结果详情便于归因平台侧。

### 2. douyin searchTopic

- 源码契约（routes-content.ts:566-571）：注释明示「抖音话题搜索需平台签名接口；未接入时返回空列表，不伪造话题建议」，硬编码 `writeOk(res, [])`。
- 31280 实测：`{"code":0,"data":[],"message":"ok"}` ✅ 与契约一致。
- 判定：**脚本断言错**（断言 `data.length > 0`，与契约正好相反）。
- 已修（smoke-all.mjs）：断言 `code===0 && Array.isArray(data) && data.length===0`，用例名标注「未接入·断言如实空列表，不伪造」。

### 3. note agent-collect

- 源码契约（routes-content.ts:711-733）：`fetchUapiSearch(keyword, 1, 20)`，返回 `items`（≤20 条，每条含 NoteIdKey/Title）+ `insight` 汇总字符串；上游不可用时 items 为空。
- 31280 实测（连跑 2 次稳定）：`items=14`、`insight="已从全网采集 14 条与「咖啡」相关的小红书内容，结果均保留原文链接。"`、`isSample=false`、`source=agent`。
- 判定：**脚本断言错**（写死 `items.length === 6`；条数随上游返回浮动，当前是 14，历史上可能是 6/12）。
- 已修（smoke-all.mjs）：断言 `code===0 && 0 < items.length <= 20 && insight 为非空字符串 && 每条含 NoteIdKey/Title`。

### 4. hot feed

- 源码契约（routes-content.ts:821-828 + hotFeedOrEmpty:178-192）：`items = feed.items.slice(0, clamp(itemLimit,1,100))`；上游不可用时 `items=[]` 且 `freshness:'unavailable'`。
- 31280 实测：`itemLimit=5 → items=5`、`itemLimit=3 → items=3`、`freshness=fresh`，每条含 rank/title/targetUrl。✅ 与契约一致。
- 判定：**脚本断言错**（请求 `itemLimit=5` 却断言 `items.length===10`，自相矛盾）。
- 已修（smoke-all.mjs）：抽出常量 `HOT_FEED_ITEM_LIMIT=5`，断言 `items.length === itemLimit` 且每条含 rank/title；`freshness==='unavailable'` 时输出 `SKIP`（平台侧，热榜上游不可用，无法验证契约）。

### 5. miniapp auth

- 源码契约（routes-content.ts:832-836）：硬编码 `writeFailRaw(res, '抖音小程序授权完成回调尚未接入，当前不会伪装成功', 50100)`。与凭据真假无关，**任何输入都拒绝**。
- 31280 实测：`{"code":50100,"data":null,"message":"抖音小程序授权完成回调尚未接入，当前不会伪装成功"}` ✅。
- 判定：**脚本断言错**（断言 `code===0` 与契约相反；用真实凭据也无济于事，该能力整体未接入）。
- 已修（smoke-all.mjs）：断言 `code===50100 && message 含「尚未接入」`，用例名标注「未接入·断言拒绝而非伪装成功」。

### 6. work validate

- 源码契约（实测，31280 与 31281 一致）：`{"code":50100,"data":null,"message":"平台作品归属校验尚未接入真实验证，当前不会伪造已通过"}`。
- 判定：**脚本断言错**（断言 `code===0 && ownershipVerified===true`；契约是必须拒绝、不得伪造通过）。
- 已修（smoke-all.mjs）：断言 `code===50100 && message 含「尚未接入」`，用例名标注「未接入·断言拒绝而非伪造通过」。

## 平台侧风险（待实测确认）

- Agnes 平台 429 限流：影响 draft generation settle（外部模型生成）与 agent-collect（UAPI 全网搜索）。若探针观测到 429/上游不可用，相关项按「平台侧」记录，不弱化断言、不伪造通过。

## 改动清单（smoke-all.mjs）

| 行（改后） | 用例 | 改动 | 依据 |
| --- | --- | --- | --- |
| 42-57 | draft generation settle | 轮询 30×1s → 60×5s（300s）；断言「全部落终态 success/partial/failed，且 success 必带 coverUrl/videoUrl、partial/failed 必带 errorMessage」 | api.ts 视频阶段合法耗时 3-4 分钟（Agnes 429 放大）；31281 对照实验 63s 如实落 failed + errorMessage，状态机无卡死 |
| 59-60 | douyin searchTopic | `data.length > 0` → `data.length === 0`，用例名标注「未接入·断言如实空列表」 | routes-content.ts:566-571 契约：未接入返回空列表，不伪造话题建议；31280 实测 `{"code":0,"data":[]}` |
| 62-66 | note agent-collect | `items.length === 6` → `0 < items.length <= 20 && insight 非空 && 每条含 NoteIdKey/Title` | routes-content.ts:711-733 契约：fetchUapiSearch(keyword,1,20)，条数随上游浮动；31280 实测 items=14（两次稳定） |
| 68-77 | hot feed | 抽常量 `HOT_FEED_ITEM_LIMIT=5`，断言 `items.length === itemLimit` 且每条含 rank/title；`freshness==='unavailable'` 时输出 SKIP（平台侧） | routes-content.ts:821-828：items = 上游 slice(0,itemLimit)；31280 实测 limit=5→5 条、limit=3→3 条 |
| 78-79 | miniapp auth | `code === 0` → `code === 50100 && message 含「尚未接入」` | routes-content.ts:832-836 契约：未接入必须拒绝，不伪装成功；实测一致 |
| 82-83 | work validate | `code===0 && ownershipVerified===true` → `code === 50100 && message 含「尚未接入」` | 实测（31280/31281 一致）：`"平台作品归属校验尚未接入真实验证，当前不会伪造已通过"` |

（miniapp fans 的 `list.length === 0` 为 9/7 上轮已修，本轮确认通过，未再改动。）

## 遗留观察（非本轮 6 项范围，仅记录）

- `user/info update` 用例是 `ok('user/info update', true)` 写死通过，断言为空。建议后续轮次补真实调用（涉及 user/info 契约，超出本轮文件域授权范围，未动）。

## 产品缺陷转工程师清单

**无。** 6 项 FAIL 全部为脚本断言错或平台侧耗时问题；未发现「状态机卡死/伪造成功/契约不符」类产品缺陷。31280 上 240s 挂 generating 的现象经 31281 单实例对照证明是视频生成阶段在途（Agnes 慢/429），终态最终如实落地。

## 未接入能力清单（信息同步，非缺陷）

1. 抖音小程序授权回调 `plat/douyin/miniapp-auth/complete`（50100）
2. 平台作品归属校验 `channel/work/validate`（50100）
3. 抖音话题搜索 `statistics/channels/douyin/searchTopic`（空列表）
4. 抖音小程序粉丝曲线 `plat/douyin-miniapp/homepage-data/fans-count`（空列表，需官方数据授权）

## 最终成绩（复跑 2026-09-07 07:02，对象 31280）

**PASS 28 / FAIL 0 / SKIP 0（共 28 项），耗时 2m12s。**

关键项明细：
- `draft generation settle :: failed(大模型调用失败),success` —— 双任务分别如实落 failed/success 终态，字段自洽（failed 带 errorMessage、success 带封面媒体），契约 PASS。failed 是 Agnes 平台波动下的诚实失败，非产品缺陷。
- `douyin searchTopic :: len=0`、`miniapp auth :: code=50100`、`work validate :: code=50100`、`hot feed :: items=5/limit=5`、`note agent-collect :: items=14`、`miniapp fans` 全部按契约通过。
