---
name: "bosom-friend-content"
description: "创作管家做内容时用它：写脚本、出片、做封面、改草稿、管素材与数字人形象、查进度、续跑没跑完的片子。Covers the whole creation flow from script to draft. 本技能从不发布——发布交给发布管家。"
whenToUse: "用户要在「内容创作」里做出一条能发的内容（脚本/文案、短视频、图文、长片、封面、素材、数字人形象），或者问片子跑到哪了、要不要接着跑时。"
---
# 技能 · 从选题到草稿箱（创作全链路）｜归属管家：创作管家

> 交付物是**草稿箱里的一条内容**，不是对话里的一段文本。
> 工具面依据：`presets/creator/agent.cordis.yml`（`bosom_content_*` / `bosom_material_*` / `bosom_digital_human_*` / `bosom_long_video_*`）。

## 适用场景
- 用户说「写一条…」「做一条视频」「做个图文」「配张封面」「这条改一下」「片子跑完了吗」「接着跑」。
- 用户给的是一个产品、卖点或一句大白话，希望最后看到能发的内容。
- 不适用：任何带发布意图的请求——那要交给发布管家（`bosom-friend-publish`），本技能**从不发布**。

## 步骤
1. **收敛需求**：把用户原话收成「讲什么产品、卖给谁、什么形式」。缺信息先问一句，不要自己编卖点。
2. **写稿**：`bosom_content_generate_script`（`prompt` 创作需求，`kind` 取 `video` 或 `image-text`）拿脚本正文与 `scriptId`。
3. **落库**：`bosom_content_create_draft`（`title` ≤30 字、`desc` 正文、`topics` 逗号分隔不带 #、`platform` 可空）存进草稿箱。**落库了才算交付**。
4. **出片**（要片子时二选一）：
   - 长片/分段：`bosom_content_create_video`（`topic` 必填；把定稿正文放进 `scriptText`、稿件编号放进 `scriptId`；`targetSeconds` 30~300 秒、默认 120；`aspectRatio` 默认 9:16；`producer` 不传默认「口播短视频」，出镜类形式用 `producerRef` 指数字人形象）。**拿到 `lv-` 开头的任务号才算发起成功**。
   - 短视频/图文（免费档优先走这条）：`bosom_content_create_short_media`（`prompt` 必填；`kind` 取 `video` 或 `image-text`；`duration` 4~12 秒、默认 5；`resolution` 默认 720p）。一次厂商调用出片，完成后自动进草稿箱。
5. **做封面**：`bosom_content_make_cover`（`draftId` 必填、`title` ≤20 字、`subtitle` ≤40 字、`count` 1~4 张）。结果里 `attached=1` 才算挂到草稿；`attached=0` 时如实说写回失败。
6. **盯进度**：`bosom_content_video_status`（`taskId`；不传则列最近几个任务）报真实「已完成 N/M 镜」；`bosom_long_video_list` 看全部长片任务。异步任务没结束就不要说「快好了」。
7. **改内容**：`bosom_content_update_draft`（`id` 必填；`title`/`desc` 不改的那项传空串）直接写回那一条草稿；要看全文先 `bosom_content_get_draft`（`id`）。
8. **素材与形象**：`bosom_material_list`（`limit`）看素材，外部视频链接入库用 `bosom_material_import_video`（`videoUrl` 必填、`title` 可空）；`bosom_digital_human_list` 看已有形象，新建用 `bosom_digital_human_create`（`name` ≤30 字、`avatarUrl` 必须是素材库里的图或视频、`images` 多角度图逗号分隔、`persona` 人设）。**形象 id 必须来自工具返回，不要自己编**。
9. **辅助工具**：提示词太散用 `bosom_content_enhance_prompt`（`prompt` ≤500 字、`kind` 取 `video` 或 `image`）；人物四视图拼图要拆开用 `bosom_content_split_fourview`（`imageUrl`，先用 `bosom_material_list` 取地址）。

## 判据
- 稿子：`bosom_content_generate_script` 返回正文与 `scriptId`；没落库之前不许说「已经做好」。
- 草稿：`bosom_content_create_draft` 成功，且 `bosom_content_list_drafts` 能查到这一条。
- 片子：`bosom_content_create_video` 返回 `lv-` 开头的任务号；进度以 `bosom_content_video_status` 的 N/M 镜为准。
- 短视频/图文：`bosom_content_create_short_media` 返回任务号（`kind` 字段告诉你是哪一类）。
- 封面：`bosom_content_make_cover` 返回 `attached=1`（写回草稿封面位成功）。
- 素材与形象：id 全部来自 `bosom_material_list` / `bosom_digital_human_create` / `bosom_digital_human_list` 的返回值。

## 反例
- 只在回复里贴一段文案就说「已经做好了」——草稿箱里没有它，等于没做。
- 没听到「发布」就自己发出去——越权，发布是发布管家的活。
- 出片报 HTTP 429 时连着重发好几次——把额度再花一遍；应如实说被厂商限流，等一会儿再 `bosom_content_resume_video`。
- 任务停在 N/M 镜时对用户说「卡住了」或「快好了」——两句都不是事实，事实是「已完成 N 镜、共 M 镜」。
- 拿素材文件名当内容（文件名里的「终版」「夜间」不是内容），或自己编产品卖点、价格、疗效。
- 承诺平台并不存在的字数/时长上限。

## 来源
- 工具名、参数与限制：`kernel/src/index.ts`（2026-10-11 快照）——`bosom_content_create_video` 第 1006–1110 行（`targetSeconds` 钳制 30~300 见第 1062–1063 行）、`bosom_content_create_short_media` 第 1119–1203 行（`duration` 4~12、默认 5 见第 1153–1154 行）、`bosom_content_make_cover` 第 1546–1624 行、`bosom_digital_human_create` 第 1785–1829 行、`bosom_content_update_draft` 第 937 行起、`bosom_content_create_draft` 第 1366 行起、`bosom_content_list_drafts` 第 580 行起、`bosom_content_get_draft` 第 2261 行起。
- 工具面：`presets/creator/agent.cordis.yml`。
- 职责与边界：《管家 preset 与 Skills 规格 v1.0》第 4.2 节（创作到草稿箱为止、NEVER publishes）、第 6.2 节（`bosom-friend-content` 覆盖写脚本 → 出片 → 存草稿）。
