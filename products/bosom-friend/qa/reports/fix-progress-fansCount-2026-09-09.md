# 粉丝数（fansCount）修复进度（2026-09-09）

> 负责域：engine 账号资料采集（worker.py）+ server 账号资料回写（platform-login.ts / platform-sync.ts）
> 关联：工作日志-2026-09-09「剩余未完成」第 3 项；账号线遗留项「粉丝数 fansCount 仍为登录时点值」
> 提交：741e4c2

---

## 1. 缺口（改动前实测）

### 1.1 engine 侧 xhs 资料采集缺失 —— 实锤

真实登录会话 `plogin-l6vcbnfj`（xhs，账号 acc-ukzk41h7）的 state.json：

```
platform=xhs status=done
nickname=""  avatar=""  platformUid=""  fansCount=0
```

对照抖音 `plogin-xrhf7hkq`：`nickname="No name" avatar=https://p26.douyinpic.com/... platformUid=XchanM520 fansCount=36`。

根因：`run_login` 在登录结果没有 `user_info` 时**无条件**调用 `fetch_douyin_profile`，
xhs 会话被拿去做抖音接口请求 → 全部字段为空。

### 1.2 同步适配器不产出账号级粉丝数 —— 实锤

`platform-sync.ts` 的 `SyncState` 只有 `works`，同步完成后只回写 records/metrics/workCount，
fansCount 永远停在登录时点。前端「频道管理 → 刷新粉丝数」调 analytics 触发同步，
但同步不产出粉丝数，所以刷新也刷不动。

---

## 2. 修复

### 2.1 engine/worker.py

- 新增 `fetch_xhs_profile`：用创作者 cookie 读
  `https://creator.xiaohongshu.com/api/galaxy/creator/home/personal_info`
  （只认 cookie、无需签名参数），取 `data.fans_count/name/avatar`。
- 抽 `_storage_cookie_pairs`（cookie 头拼装复用）与 `fetch_platform_profile`（按平台分发）。
- `run_login` 改用 `fetch_platform_profile(platform, ...)`：xhs 走 xhs 接口。
- `run_profile` 落盘 `fansCount`（仅资料接口给出时写，避免 DOM 兜底把真实值抹成 0）。
- `run_sync` 顺带采集账号资料写入 `state.profile`，粉丝数随每次同步刷新。
- **不回填 platformUid**：服务端 xhs 账号身份取自登录 cookie 的
  `x-user-id-creator.xiaohongshu.com`（`xhsUidFromLoginCookie`）；若回填小红书号，
  同一账号下次登录会匹配不上而新建重复账号。

### 2.2 server

- `platform-login.ts` 抽出 `applyAccountProfile(account, platform, update)`：
  只覆盖确实采集到的字段；`enrichAccountProfile` 用它一并回写粉丝数。
- `platform-sync.ts` 用同一条规则回写同步采到的昵称/头像/粉丝数。
- 新增 `server/test/account-profile.test.mjs`：空值不覆盖、非法粉丝数忽略、昵称占位值兜底。

---

## 3. 验证记录（2026-09-09，全部实测）

### 3.1 真实 xhs 会话接口实测 —— PASS

```
fetch_xhs_profile(plogin-l6vcbnfj/storage.json)
→ keys=[avatar, fansCount, nickname]  nickname='SKYC-重庆机长'  fansCount=7
   platformUid 不在返回里（身份仍由登录 cookie 决定）
```

### 3.2 真实同步 worker 端到端 —— PASS

```
python worker.py sync <taskId> <taskDir>   （platform=xhs，真实 cookie）
→ state.json: status=done  workCount=11  profile.fansCount=7
   profile.nickname=SKYC-重庆机长（9 字）
```

### 3.3 应用实测（127.0.0.1:31280）—— PASS

服务用新 lib 重启（`tsc -p products/bosom-friend/server/tsconfig.json` 后
`node --import tsx/esm products/bosom-friend/launcher/src/bin-desktop.ts`，
带 `CODEBUDDY_SAFE_DELETE_ENABLED=0`）。

改动前（accounts.json 回读）：

```
{"id":"acc-ukzk41h7","type":"xhs","uid":"683596e1000000001b020e5c",
 "avatar":"","nickname":"小红书","fansCount":0,"workCount":15,"hasLoginCookie":true}
```

触发同步：

```
POST /bosom-friend/api/v2/channels/accounts/acc-ukzk41h7/sync
→ {"code":0,"data":{"ok":true,"platform":"xhs","count":11,
    "message":"小红书数据同步完成","updatedAt":"2026-09-09T04:42:07.834Z"},"message":"ok"}
```

同步后：

```
{"id":"acc-ukzk41h7","type":"xhs","uid":"683596e1000000001b020e5c",
 "avatar":"/bosom-friend/api/assets/avatar/acc-ukzk41h7",
 "nickname":"SKYC-重庆机长","fansCount":7,"workCount":14,"hasLoginCookie":true}
```

- fansCount 0 → 7（平台真值）✅
- nickname「小红书」（兜底显示名）→「SKYC-重庆机长」✅
- avatar 空 → 头像代理地址 ✅
- uid 不变 → 不产生重复账号 ✅

### 3.4 前端 S 级证据（用户可见）—— PASS

真实前端（`http://127.0.0.1:31280/bosom-friend/`）点「添加频道」打开「频道管理」，
可访问性快照：

```
SKYC-重庆机长
  img "小红书"  小红书
  check-circle  在线
  "粉丝: 7"
  button "刷新粉丝"
抖音 ... "粉丝: 36"
```

截图：`qa/evidence/fanscount-xhs-channel-manager-2026-09-09.png`

### 3.5 门禁与单测

- `tsc -p products/bosom-friend/server/tsconfig.json --noEmit`：0 错误。
- `oxlint --config .oxlintrc.json` 改动的两个文件：0 错误。
- `node --import tsx/esm server/test/account-profile.test.mjs` → `ACCOUNT_PROFILE_OK`。
- `node --import tsx/esm server/test/store-consistency.test.mjs` → `STORE_CONSISTENCY_OK`。
- `node products/bosom-friend/qa/run-gate.mjs`：黄灯无红灯（与改前一致）。

---

## 4. 遗留

- 粉丝数刷新有节流：服务端同账号 10 分钟内至多一次真实采集
  （`ANALYTICS_SYNC_MIN_INTERVAL_MS`），前端「刷新粉丝数」另有每平台 1 小时冷却；
  两者都是防打爆平台的既有设计，未改动。
- `followingCount`（关注数）接口同样能取到（`follow_count`），本次未纳入（保持改动范围）。
- 其余平台（快手/视频号）仍无同步适配器（`SYNC_ADAPTERS.canSync=false`），不返回示例数据。
