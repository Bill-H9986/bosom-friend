---
name: "bosom-friend-topic-selection"
description: "创作管家选题与写稿时用它：把用户一句话收敛成能出片的需求，定形式、定标题与话题，再落进草稿箱。"
whenToUse: "用户说「随便做一条」「你看着办」「最近发什么好」，或给的需求太空、要先把选题与脚本定下来时。"
---
# 技能 · 选题与写稿口径｜归属管家：创作管家

> 选题是**把一句话收敛成能出片的需求**，不是列一堆点子。

## 适用场景
- 用户的需求很虚（「随便做一条」「你看着办」「最近发什么好」），要先收敛成一个能出片的选题。
- 用户给了产品或卖点，要把它变成标题、正文与话题。
- 不适用：需求已经明确到「把这条草稿出片」——直接走 `bosom-friend-content` 与 `bosom-friend-long-video`。

## 步骤
1. **先看现成材料**：`bosom_material_list`（`limit`）看素材库里有什么、`bosom_digital_human_list` 看有哪些数字人形象、`bosom_content_list_drafts`（`limit`）看草稿箱里已有什么——别重复造一条已有的内容。
2. **把需求收成三件事**：讲什么（产品/卖点）、给谁看（人群）、什么形式。形式只在这 7 种里选：数字人口播 / 走动VLOG / 口播短视频 / 开箱测评 / 步骤教程 / 场景呈现 / 场景种草。缺哪件就补问一句。
3. **大白话先整形**：`bosom_content_enhance_prompt`（`prompt` ≤500 字、`kind` 取 `video` 或 `image`）把口语需求整理成能直接喂模型的画面描述。
4. **出脚本**：`bosom_content_generate_script`（`prompt` 写收敛后的需求、`kind` 取 `video` 或 `image-text`），拿正文与 `scriptId`。
5. **定标题与话题**：标题压到 30 字以内，话题 3~5 个精准词、不带 # 号。
6. **落库**：`bosom_content_create_draft`（`title`、`desc`、`topics`、`platform` 可空）存进草稿箱，让它变成看得见的东西。

## 判据
- 选题可执行 = 讲什么 / 给谁看 / 什么形式这三件事各能用一句话说清，且形式落在上面 7 种之内。
- 脚本到手 = `bosom_content_generate_script` 返回正文与 `scriptId`。
- 落库 = `bosom_content_list_drafts` 里查得到这一条。
- 硬约束：草稿标题 ≤30 字、话题不带 # 号（工具层面就会拦）。

## 反例
- 一次生成一堆选题却没有一条落库——用户要的是内容，不是点子列表。
- 把「最近发什么好」答成平台数据报告（那是运营管家的事，见 `bosom-friend-review`），或编造平台热点。
- 为了显得丰富，编出用户没说过的卖点、价格、疗效。
- 形式写成工具不认的值：`producer` 只认上面 7 种，`kind` 只认 `video` / `image-text`。

## 来源
- 参数与限制：`kernel/src/index.ts`（2026-10-11 快照）——`bosom_content_generate_script` 第 667 行起（`kind` 只收 `video` / `image-text`）、`bosom_content_enhance_prompt` 第 1436 行起（`prompt` ≤500 字）、`bosom_material_list` 第 340 行起、`bosom_digital_human_list` 第 1658 行起、`bosom_content_create_draft` 第 1366 行起、`bosom_content_create_video` 的 `producer` 取值第 1016 行。
- 职责：《管家 preset 与 Skills 规格 v1.0》第 6.2 节「创作 · 待建：选题」。
