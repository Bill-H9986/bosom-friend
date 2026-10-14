---
name: "bosom-friend-long-video"
description: "创作管家做长视频时用它：发起分段出片、查每一镜的进度、重做某一镜、补写稿件、停下任务、从断点续跑。"
whenToUse: "用户要做几十秒到 5 分钟的长片，或问「跑到第几镜了」「第 3 镜重做」「稿子太短」「停下」「接着跑」时。"
---
# 技能 · 长视频分镜与断点续跑｜归属管家：创作管家

> 长片是**分段生成**的：一条 90 秒的片是十几到二十几镜，每镜一次厂商调用。

## 适用场景
- 要做 30~300 秒的长片；要查「跑到第几镜了」；要重做某一镜；稿子不够长要扩写；要停下或从断点继续。
- 不适用：4~12 秒短视频与图文笔记（走 `bosom_content_create_short_media`，见 `bosom-friend-content`）；发布（发布管家）；登录态（设备管家）。

## 步骤
1. **发起**：`bosom_content_create_video`——`topic` 必填（要讲的产品与卖点，越具体成片越贴题）；已有定稿就传 `scriptText` 与 `scriptId`（编排层按这份稿子出片，不再另写一版）；`targetSeconds` 30~300 秒（默认 120）；`aspectRatio` 默认 9:16；出镜类形式用 `producerRef` 指形象 id（不传会用形象库里的第一个，结果里会写明用了哪个）。**拿到 `lv-` 开头的任务号才算发起成功**。
2. **看进度**：`bosom_content_video_status`（`taskId`；不传列最近几个）报真实「已完成 N/M 镜」与失败原因；全部任务用 `bosom_long_video_list`。
3. **单镜返工**：`bosom_long_video_redo_shot`（`taskId`、`index` 镜号从 1 开始；第 3 镜就传 3），只重出这一镜，完成后自动重新拼接。
4. **稿子太短**：`bosom_long_video_extend_script`（`taskId`）只扩写稿件、不花厂商调用出片；补完先让用户确认再继续生成。
5. **停下**：`bosom_long_video_stop`（`taskId`），已完成的镜头保留。
6. **接着跑**：`bosom_content_resume_video`（`taskId`）只补没跑成的镜，已生成的镜原样保留。
7. **交付**：成片自动进草稿箱，状态里给出的 `materialId` 就是发布时要引用的对象——把它记住并交给发布管家，不要凭标题去列表里找。

## 判据
- 发起成功 = 返回任务号（形如 `lv-xxxxxxxx`）。
- 进度 = `bosom_content_video_status` 的 N/M 镜与状态字段，不来自印象。
- 重做成功 = 返回镜号与本镜秒数，并已重新拼接。
- 续跑成功 = 只补没跑成的镜；已完成镜数在续跑前后不变。
- 停下 = `bosom_long_video_stop` 返回任务号；此时**不要**说片子已完成。

## 反例
- 被限流（HTTP 429）时反复重建任务——把免费档额度再花一遍；应如实说明、等窗口过去后 `bosom_content_resume_video`。
- 任务停着不动就说「卡死了」或「快好了」；应报真实 N/M 镜。
- 用户说「第 3 镜重做」，只在回复里答应而没调 `bosom_long_video_redo_shot`——**必须调用工具**，不要承诺换个说法就能重做。
- 稿子太短时直接重跑整片，而不用 `bosom_long_video_extend_script` 先补稿。
- 把「已停止」说成「已完成」。

## 来源
- 参数与限制：`kernel/src/index.ts`（2026-10-11 快照）——`bosom_content_create_video` 第 1006–1110 行（`targetSeconds` 钳制 30~300 见第 1062–1063 行）、`bosom_content_video_status` 第 1205 行起、`bosom_content_resume_video` 第 1257 行起（参数说明给出 `lv-xxxxxxxx` 形态）、`bosom_long_video_list` 第 1970 行起、`bosom_long_video_redo_shot` 第 1689 行起（`index` ≥1）、`bosom_long_video_extend_script` 第 1723 行起、`bosom_long_video_stop` 第 1757 行起。
- 免费档限流：`kernel/src/index.ts` 第 1114–1116 行注释（`freeTierRpm=1`；长片 18 镜会被限流打断）。
- 职责：《管家 preset 与 Skills 规格 v1.0》第 4.2 节、第 6.2 节「创作 · 待建：长视频分镜」。
