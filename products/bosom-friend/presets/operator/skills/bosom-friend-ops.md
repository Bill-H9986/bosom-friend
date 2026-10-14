---
name: "bosom-friend-ops"
description: "运营管家看数据、接待评论私信时用它：作品数据回读、本地发布记录、拉取最新互动、待接待列表、回复评论或私信。回复属对外沟通，需当次明确指令。"
whenToUse: "用户问作品数据（播放/点赞/评论），或问「有没有人找我」「有哪些待回的评论私信」「帮我回一下」时。"
---
# 技能 · 数据回读与评论私信接待｜归属管家：运营管家

> 工具面依据：`presets/operator/agent.cordis.yml`（`bosom_reception_*` / `bosom_data_works` / `bosom_platform_sync_works`）。

## 适用场景
- 看作品数据、回看本地发布记录、把平台最新互动拉回来、看待接待、回复评论或私信。
- 不适用：创作（创作管家）、发布（发布管家）、账号登录态与账号同步（设备管家）。

## 步骤
1. **看作品数据**：`bosom_data_works`（无参数）读已发布作品数、各平台贡献、每条作品的播放/点赞/评论与作品链接，以及**平台到底有没有把数据给过来**（`availability` 逐项标注「有数据 / 无信号」）。
2. **看本地记录**：`bosom_platform_sync_works`（`limit`）读本地已发布作品记录——它**不连平台、不拉新数据**，只是回看已有记录。
3. **要新数据先拉**：真正连平台拉一次的工具是 `bosom_platform_sync_now`（`accountId`，约 1~2 分钟），它当前**不在运营管家的工具面里**；需要拉新数据时如实说明这一步的归属，不要假装已经拉了。
4. **拉互动与看待接待**：`bosom_reception_poll_now`（无参数）拉一轮评论私信——返回 `triggered=1` 表示已启动，`triggered=0` 表示上一轮还在跑、**这次没有启动新一轮**；随后用 `bosom_reception_list_pending`（`limit`）读待处理列表（含来源平台、内容、匹配规则与拟回复）。
5. **回复（拍板类）**：`bosom_reception_reply`——`platform`、`accountId`、`kind`（`comment` 或 `dm`）、`replyText` 必填；`workId` / `commentText` / `username`（评论）与 `sessionId` / `peerName`（私信）是**定位字段，必须从 `bosom_reception_list_pending` 的结果原样取**，不要自己编。
6. **回报**：回复返回任务号只代表**已交给平台引擎**，此刻还没发出去；结果回写到接待记录里，不要对用户说「已回复」。

## 判据
- 数据可用性：`bosom_data_works` 的 `availability` 逐项给出「有数据 / 无信号」；**无信号 ≠ 0**。
- 数据新鲜度：看 `bosom_data_works` 返回的数据更新时间，不新鲜就说清「这是某时刻的数据」。
- 拉取是否启动：`bosom_reception_poll_now` 返回 `triggered=1`；`0` 时如实说这轮没启动。
- 回复提交成功 = 返回任务号（`kind` 告诉你是评论还是私信）；真实发出与否看接待记录。
- 回复的定位字段全部来自 `bosom_reception_list_pending` 的返回。

## 反例
- 把「无信号」的播放量报成 0——0 次播放与「平台还没采到」是两件不同的事。
- 没有当次明确指令就去回复评论或私信——对外沟通属拍板类动作。
- 自己编 `workId` / `username` / `sessionId` 去回复——平台按这些字段在页面上找目标，编出来的值白跑一趟。
- 调用成功就说「已回复」。
- 拿 `bosom_platform_sync_works` 当「去平台拉最新数据」用——它只读本地记录。
- 主动给非粉丝发私信、批量互动（BFS-800 第 810 条列为禁止动作，产品不提供入口）。

## 来源
- 工具语义：`kernel/src/index.ts`（2026-10-11 快照）——`bosom_data_works` 第 2199–2258 行（无信号口径第 2202–2204 行；`availability` 渲染第 2237–2242 行）、`bosom_platform_sync_works` 第 523 行起（描述明确「不连平台、不拉新数据」）、`bosom_reception_poll_now` 第 2170–2196 行（`triggered` 语义第 2187–2189 行）、`bosom_reception_list_pending` 第 268 行起、`bosom_reception_reply` 第 2115–2167 行（拍板语第 2117 行；定位字段必须原样取第 2118–2119 行）、`bosom_platform_sync_now` 第 2307 行起（不在运营工具面）。
- 工具面：`presets/operator/agent.cordis.yml`。
- 职责与边界：《管家 preset 与 Skills 规格 v1.0》第 4.4 节（拍板约束；禁止主动私信与批量互动）、第 6.2 节；BFS-800 第 810 条。
