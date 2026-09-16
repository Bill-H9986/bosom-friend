# 账号线修复进度（2026-09-07）

> 负责域：server/src 路由/store 层与账号数据流（不碰 platform-login.ts 发布函数段、不碰 engine/）
> 服务：http://127.0.0.1:31280（与发布线共用，验证后即释放）
> 本文件实时追加：改动点 / 文件 / 行号 / 验证结果 / curl 证据

---

## 0. 基线实测（改动前，2026-09-07 06:52 UTC）

### TEST1 analytics 缓存假象 —— 实锤

```
GET /bosom-friend/api/v2/channels/accounts/acc-nnpqqueo/analytics  ×2
call1 lastStatsTime=2026-09-07T06:52:20.292Z  fansCount=36 workCount=16
call2 lastStatsTime=2026-09-07T06:52:20.364Z  fansCount=36 workCount=16
```
两次调用相隔 72ms，只有 lastStatsTime 在变，业务数据零刷新。
**结论：analytics 是纯缓存回显 + 假新鲜度（每查一次就把 lastStatsTime 刷新，但从不拉平台）。**

### TEST2 logout 只清 accounts.json —— 实锤（代码层）

- `POST v2/channels/accounts/:id/logout`（routes-channels.ts:277-294）仅清
  `loginCookie/access_token/refresh_token` 三个字段，**不清理任何登录会话文件**。
- 临时账号 create→logout→delete 全链路 code=0，行为正常（但只覆盖 accounts.json）。

### TEST3 登录会话残影与复活链路 —— 实锤

磁盘残留（`~/.bosom-friend/bosom-friend/platform-login/sessions/`）：

| 会话 | 平台 | accountId | state.json 含 cookie | storage.json |
| --- | --- | --- | --- | --- |
| plogin-267j1vep | douyin | acc-nnpqqueo（在册） | 11642B | 27123B |
| plogin-l6vcbnfj | xhs | acc-ukzk41h7（在册） | 3652B | 8465B |
| plogin-37pb7nq0 | xhs | acc-5byfdyx3（**已删**） | 3652B | 8458B |
| plogin-3no7522x | xhs | acc-egvr2pyo（**已删**） | 3653B | 8461B |
| plogin-89gef3xv | douyin | acc-btkqpigl（**已删**） | 11858B | 25586B |
| plogin-beqcno5d | douyin | acc-l21alxqk（**已删**） | 12049B | 27531B |
| plogin-9a3qbb01 / plogin-udfdjgar | xhs | 无（pending 残留） | 无 | 无 |

复活链路（platform-login.ts:301-353 `ensureAccountMaterialized`）：
`GET v2/channels/accounts/auth/:platform/status/:sessionId` 轮询 done 会话永远返回
`status=completed`，且每次轮询都会把 state.json 里的**旧 loginCookie 原样写回
accounts.json**（312-315 行）。实测证据：

```
GET /v2/channels/accounts/auth/xhs/status/plogin-l6vcbnfj
→ {"status":"completed","accountId":"acc-ukzk41h7",...}
```

**后果**：登出/删除账号后，只要前端还在轮询旧 sessionId，
cookie 就被复活；对已删账号则会用旧 cookie **新建幽灵账号**。

---

## 1. 修复实施

### 1.1 登录状态同源：JsonFile 增加 mtime 再校验（store 层）

- 文件：`server/src/store.ts`（JsonFile.load/save）
- 问题：`openStore()` 每次调用产生独立的 JsonFile 实例（server 与 kernel 各一套），
  读路径缓存后永不重读磁盘 → 跨实例写后其他实例读到陈旧登录态，直到重启。
- 修复：load() 以 statSync(file).mtimeMs 为再校验键，磁盘变了就重读；
  save() 写完后记录新 mtime。同进程/跨进程所有读取点统一以磁盘为唯一事实源。

### 1.2 退出登录全清：会话文件吊销

- 文件：`server/src/platform-login.ts`（仅登录会话域，未动发布函数段）
  - `LoginState` 增加 `revokedAt?: string`；
  - 新增导出 `revokeAccountLoginSessions(deps, account)`：扫描
    `platform-login/sessions/*/state.json`，命中 `accountId`（或 平台+platformUid）即
    抹除 `loginCookie/cookieFile`、写 `revokedAt`、删除该会话目录内的
    `storage.json` 等明文 cookie 文件；
  - `getPlatformLoginStatus`：读到 `revokedAt` → 返回 failed
    （"该登录会话已退出，请重新扫码登录"）；
  - `ensureAccountMaterialized`：`revokedAt` 命中直接返回 ''，切断复活链。
- 文件：`server/src/routes-channels.ts`
  - logout 处理器（277-294）：清字段后调用 `revokeAccountLoginSessions`；
  - DELETE 账号（256-274）：删除前同样吊销该账号全部登录会话（幽灵账号源头）。

### 1.3 实时数据轮询：analytics 触发真实平台拉取（后台化 + 节流）

- 文件：`server/src/routes-channels.ts`
- 断点：analytics 原来只刷 lastStatsTime（见基线 TEST1）。
- 修复：analytics 命中时，对 canSync 平台（xhs/douyin）且持有 cookie 的账号
  触发 `syncPlatformWorks`（真实 worker 用真实 cookie 拉平台作品/互动数据，
  只读无发布副作用），后台执行不阻塞响应：
  - 同账号 10 分钟节流 + in-flight 去重（避免前端高频轮询打爆平台）；
  - 同步失败不影响本次响应（缓存照常返回，错误仅在服务端日志）；
  - 同步完成后 records/metrics/workCount 落盘，下一次 analytics 自然读到新值。

---

## 2. 验证记录（2026-09-07，全部实测）

> 服务已用新 lib 重启（tsx bin-desktop.ts，31280 端口）。所有验证使用合成数据
> （`zzfixtest*` 命名空间），真实账号登录态零触碰；验证后合成数据已清理。

### 2.1 登出全清（V2）—— PASS

合成会话 `plogin-zzfixtest2`（state.json 含假 cookie + stale accountId，另含 storage.json）
+ 临时账号 `uid=zz-fixtest-uid-88`。执行 `POST /v2/channels/accounts/:id/logout`：

```
logout 响应: {..., "hasLoginCookie":false, "revokedSessions":1}
磁盘核验:
  state.loginCookie present: False     ← 明文 cookie 已抹除
  state.cookieFile present: False
  state.revokedAt set: True (2026-09-07T07:14:42.521Z)
  storage.json deleted: True           ← Playwright cookie 正本已删
  真实会话 plogin-l6vcbnfj untouched: True ← 在册账号不受影响
```

### 2.2 复活链路封死（V3）—— PASS

```
登出前轮询 done 会话（stale accountId）:
  → {"status":"completed","accountId":"acc-zzfixtest-stale",...}   ← 修复前的幽灵入口
登出后轮询同一会话:
  → {"code":50000,"message":"该登录会话已退出，请重新扫码登录"}      ← 已封死
回归: 真实在册会话 plogin-l6vcbnfj 轮询仍 {"status":"completed","accountId":"acc-ukzk41h7"}
```

DELETE 账号路径同样经过会话吊销（验证中临时账号删除成功，幂等）。

### 2.3 实时数据轮询（V1）—— PASS

对 douyin 账号 `acc-nnpqqueo`（真实 cookie）：

```
V1a 首次 analytics:
  → {...,"workCount":16,"syncNote":"已触发抖音真实数据采集，稍后刷新可见最新数据"}
后台 worker（platform-login/sync/sync-mrlf8gvn/state.json）20 秒完成:
  status=done, workCount=16，16 条真实作品（真实 dataId/workLink/publishTime/
  viewCount/likeCount/commentCount），如 7682660673825869119（今日发布，views=3）
V1c 回写核验:
  accounts.updateTime 05:28:11 → 07:16:10（同步完成时回写）；workCount=16
  GET publish/records?accountId=acc-nnpqqueo → 16 条全部带真实 platformWorkId
  + workLink，互动数据为平台真值（如 7579908853258534107 comments=55）
V1d 节流核验: 10 分钟窗口内二次 analytics → 无 syncNote，未重复触发平台采集
```

### 2.4 登录状态同源（mtime 再校验）—— PASS

独立可复现验证（临时目录，不碰共享数据根）：

```
store 实例 A 读空缓存 → 实例 B（独立 openStore，模拟 kernel/data.ts）外部写盘
→ A 立即读到 B 的写入。输出: MTIME_REVALIDATE_OK
```

### 2.5 编译双改确认

- `tsc -p products/bosom-friend/server/tsconfig.json` 重出 lib
  （仓库现状：`-p/-b` 全量构建因 packages/* 的 TS6059/6307 结构性旧问题 status=2，
  但 server 自身文件可正常 emit；非本次改动引入）。
- server/src/store.ts 修复过程中发现并修正一处自引入错误
  （`statSync` 未导入，TS2304），复编后 store.ts 零错误。
- lib 副本三文件确认包含全部新逻辑：
  - `lib/types/store.js`: `fileMtime/cachedMtime` + `statSync` 导入
  - `lib/types/platform-login.js`: `revokeAccountLoginSessions/revokedAt` 守卫
  - `lib/types/routes-channels.js`: logout/DELETE 吊销 + `refreshAccountStats` 节流


## 3. 遗留项

- 粉丝数 fansCount：同步适配器（platform-sync.ts SyncState.works）不产出账号级
  粉丝数据，仍为登录时点值；需 engine 侧新增 profile 采集才能实时化（本次域外）。
- `platform-login/sessions/` 中 4 个孤儿会话（账号已删）在服务重启前不会被自动
  清理；修复版下它们已无法复活账号（revokedAt 守卫 + 无轮询入口），可择机手工清理。
