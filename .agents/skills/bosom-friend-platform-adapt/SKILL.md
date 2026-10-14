---
name: "bosom-friend-platform-adapt"
description: "发布管家的平台适配口径：抖音与小红书的账号标识、登录态前置、标题长度与图片要求，以及哪些参数当前不在链路上。"
whenToUse: "要决定发到哪个平台账号、用户问「抖音和小红书有什么不一样」「为什么发不出去」时。"
---
# 发布管家 · 平台适配（抖音 / 小红书）

> 平台差异只讲**有实测依据**的部分；没有依据的数字不报。

## 适用场景
- 同一条内容要发到不同平台，需要确认账号标识、标题长度与图片要求。
- 发布失败时先判断是「平台要求不满足」还是「登录态失效」。
- 不适用：通用发布流程见 `bosom-friend-publish`；登录与账号本身归设备管家。

## 步骤
1. **平台标识从账号记录来**：`bosom_platform_list_accounts`（`limit`）返回的每个账号带 `platform`（如 `douyin`、`xhs`）与 `id`；发布时 `accountId` 与 `platform` 必须取自**同一条账号记录**，不要跨号拼。
2. **先看登录态**：同一条记录的 `loginState=invalid` 表示平台侧会话已失效——先用 `bosom_platform_login_status` 复核并如实说明（重新扫码由设备管家引导），不要提交发布。
3. **按平台压标题**：抖音标题上限 **20 字**（引擎实测口径，拒绝原文「标题不能超过20字符」）；`bosom_publish_draft` 与 `bosom_publish_content` 都会在提交前拦住超长标题并给出改法。小红书等其余平台的上限**当前没有实测依据，不要报数字**。
4. **图文必须有图**：`bosom_publish_draft` 用草稿的图或封面；两者都没有时工具直接报错——正确做法是请创作管家补封面（`bosom_content_make_cover`），不要凭空造图，也不要声称已发布。
5. **说清链路上没有的东西**：位置标签与「内容由 AI 生成」标注当前**不在发布参数里**（`bosom_publish_content` 只有 `accountId` / `materialId` / `title` / `body` / `topics` 五个参数），要对用户如实说明，不许承诺。
6. **失败照原文转述**：平台/引擎的错误原文（工具已去噪）就是结论，不要改写成别的原因。

## 判据
- 平台与账号一致：`platform` 与 `accountId` 来自同一条账号记录。
- 标题合规：抖音 ≤20 字（提交前由工具拦住）。
- 图片齐备：草稿有图或有封面，否则工具报错（不静默发空图）。
- 参数清单：`bosom_publish_content` 只有 5 个参数；用户提到的其它项就是不在链路上。

## 反例
- 给小红书编一个「上限 20 字」之类的数字——没有实测依据的数字不许报。
- 把 `platform` 传成账号昵称，或用另一个平台的 `accountId`。
- 登录态 `invalid` 时说成「网络问题」，把用户引到错误方向。
- 用户问「能不能设置位置 / 标注 AI 生成」时答「可以」——当前链路没有这两项。

## 来源
- 参数与限制：`kernel/src/index.ts`（2026-10-11 快照）——`bosom_publish_content` 参数表第 832–861 行（位置与标注被有意排除，注释第 858–860 行）、`bosom_publish_draft` 的 `platform` 与标题上限第 2016、2071–2080 行、`bosom_platform_list_accounts` 的 `loginState`/`loginNote` 字段第 226–229 行。
- 无源不报：`kernel/src/index.ts` 第 2074 行注释（其余平台的上限不报，依 platform-catalog 的「无源不报」原则）。
- 职责：《管家 preset 与 Skills 规格 v1.0》第 4.3 节、第 6.2 节「发布 · 待建：平台适配（抖音 / 小红书）」。
