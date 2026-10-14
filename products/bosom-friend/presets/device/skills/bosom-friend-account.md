---
name: "bosom-friend-account"
description: "设备管家管账号时用它：账号列表、登录态、登录失效判断、重新登录引导，以及同步数据这一步的归属说明。不创作、不发布。"
whenToUse: "用户问「我的号还在吗」「登录失效了吗」「怎么重新登录」「有哪些账号」时。"
---
# 技能 · 账号与登录态｜归属管家：设备管家

> 工具面依据：`presets/device/agent.cordis.yml`（`bosom_settings_*` / `bosom_user_*` / `bosom_platform_list_accounts` / `bosom_platform_login_status`）。

## 适用场景
- 查有哪些账号、各自登录态如何、要不要重新登录；解释「为什么发不出去 / 拉不到数据」里的账号原因。
- 不适用：创作（创作管家）、发布（发布管家）、数据解读（运营管家）、改模型配置与资料（本管家的 `bosom-friend-setup`）。

## 步骤
1. **先查再答**：`bosom_platform_list_accounts`（`limit` 1–50）读账号列表——每条含 `id`、`platform`、`nickname`、`fansCount`、`status`、`loginState`（`valid` 可用 / `invalid` 需重新扫码 / 缺失表示尚未判定）与 `loginNote`（登录失效时平台给的原因原文）。
2. **看汇总**：`bosom_platform_login_status`（无参数）给出已绑定账号数与各平台数量分布。
3. **判断能不能干活**：`loginState=invalid` 的账号要如实说明「登录已失效 + 平台给的原因」，不要说成「网络问题」；能用的账号照实列出来。
4. **重新登录是真人动作**：请用户在 App 的「添加频道 / 重新登录」入口扫码，扫完让他回话，再用 `bosom_platform_list_accounts` / `bosom_platform_login_status` 回读**真实结果**——**在他确认之前不要声称已经登录成功**。
5. **说清自己的能力边界**：内核里存在发起扫码的工具 `bosom_platform_login_start`（`platform`，返回会话号与二维码地址），但它**当前不在设备管家的工具面里**；这一步你只能引导与回读，不要把「我来发起」说成已完成。
6. **同步数据的归属**：真正连平台拉一次数据的是 `bosom_platform_sync_now`（`accountId`，约 1~2 分钟），它同样**不在设备管家工具面里**；运营侧的 `bosom_platform_sync_works` 只读本地记录。用户要「同步一下数据」时，如实说明这一步归谁做。

## 判据
- 账号可用性以 `loginState` 为准（`valid` 可用；`invalid` 需重新扫码），配合 `loginNote` 原文。
- 重新登录成功 = 回读后该账号 `loginState` 变为 `valid`；用户说「扫完了」不等于登录成功。
- 账号标识：`accountId` 一律用列表返回的 `id` 原样引用，不要用昵称或序号。

## 反例
- 用户说「扫完了」就说已登录成功——必须回读工具结果。
- 把登录失效说成「网络问题」，或含糊成「稍后重试」。
- 代持密码、代替用户扫码、承诺「后台自动重登」（BFS-800 第 805 条禁止）。
- 承诺自己发起扫码或自己同步数据——这两个工具不在本管家工具面里。
- 在回复里回显 cookie、token 或内部路径。

## 来源
- 工具与字段：`kernel/src/index.ts`（2026-10-11 快照）——`bosom_platform_list_accounts` 第 198–265 行（`loginState` / `loginNote` 字段第 226–229 行）、`bosom_platform_login_status` 第 480 行起、`bosom_platform_login_start` 第 2349–2393 行（当前不在设备工具面）、`bosom_platform_sync_now` 第 2307 行起（当前不在设备工具面）、`bosom_platform_sync_works` 第 523 行起（只读本地记录）。
- 工具面：`presets/device/agent.cordis.yml`。
- 职责与边界：《管家 preset 与 Skills 规格 v1.0》第 4.5 节（账号列表与登录态、重登引导；不得代持密码、代替扫码、后台自动重登）、第 6.2 节；BFS-800 第 805 条。
