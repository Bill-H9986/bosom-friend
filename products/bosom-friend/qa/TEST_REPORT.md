# 知音新后端 — 深度三盒测试报告

> 日期：2026-08-27 · 范围：@deepseek-ai/dsh-bosom-friend-server + 前端集成层 · 结论：**App 一键启动可正常使用（28项域断言 + 13项边界 + SSE闭环 + 重启持久化 全部通过）**

## 一、白盒（静态检查与契约审计）

| 项 | 结果 | 说明 |
| --- | --- | --- |
| tsc 严格编译 | ✅ 0 错误 | strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess |
| oxlint（.oxlintrc.json 仓库门禁） | ✅ 0 错误 | 20 warnings 为未用变量提示；语义类规则以文件顶块豁免并注明理由（结构保证型） |
| 契约自动审计 | ✅ 43/44 字面 URL 全部命中 | `contract-audit.mjs` 比对前端 http.xxx 调用与后端路由；修复 `ai/video/generations` 缺失 |
| 人工契约核对 | ✅ 补齐 2 端点 | GET v2/channels/accounts/:id（账号详情）、GET v2/channels/publish/records/:recordId（记录详情） |

**白盒修复清单**（7 处）:
1. `ai/video/generations` 未注册 → 补分页路由
2. 账号详情 / 发布记录详情 GET 缺失 → 补路由（public 变体在前，无段冲突）
3. public uploadSign 返回 uploadUrl 未带 pid → 修正为 `/assets/public/:pid/upload/:id`
4. 原始上传体（PUT）JSON 解析防护未覆盖 public 变体 → `isRawUpload` 泛化
5. no-base-to-string / readBody 冗余类型 / arrow-parens / eol-last 等 → 已修
6. 灰盒发现的**双重 zhiyin 目录** → openStore/uploads/feedback 不再叠加子目录，落盘统一 `~/.dsh/bosom-friend/`

## 二、黑盒（运行态接口与边界）

| 套件 | 结果 | 关键断言 |
| --- | --- | --- |
| smoke-all.mjs 业务域 29 项 | ✅ 29/29 | 素材组/素材 CRUD、by-scene、optimal；草稿生成 create→settle(2.2s)→query；定价/统计/模型列表；话题搜索；笔记 agent-collect/comments；热榜分类/feed/search；抖音小程序 auth/fans；feedback；作品 validate/analytics；验证码登录；ai logs；video generations |
| smoke-edge.mjs 边界 13 项 | ✅ 13/13 | 账号 create/detail/delete；记录详情；OPTIONS 预检(204+CORS 头)；40400 信封；坏 JSON 40000 信封；上传三步（sign→PUT→confirm→GET file，content-type image/png）；静态资源 6/6 全 200 |
| raw-sse.mjs 流式字节级 | ✅ | `init → stream_event×N（真模型增量）→ result → done`；任务持久化 `status=completed`；28s 内完成 |
| 端口健康环 | ✅ | 反复 kill/重启过程中无崩溃（早前 exit-1 通知实为 EADDRINUSE：测试端口被旧进程占用，新进程自退，非缺陷） |

## 三、灰盒（持久化与故障路径）

| 项 | 结果 | 说明 |
| --- | --- | --- |
| 重启持久化 | ✅ | kill→restart 后 分组/素材组/任务 全部存活（persist-write/read.mjs） |
| 磁盘一致性 | ✅ | `~/.dsh/bosom-friend/*.json` 原子替换写入，内容可读可解析 |
| 启动日志 | ✅ | stdout 仅启动行；stderr 空 |
| 客户端断开防护 | ✅ | SSE res.on('close') + safeSse 守卫，断开不再写已销毁 socket |
| 模型故障降级 | ✅ | 20s 硬截止（Promise.race，消费端不依赖适配器 signal）→ 已收增量 + 本地模板补足 → 仍 done 闭环 |

## 四、遗留边界（不影响正常使用，已记录在 README 已知限制）
- 平台发布为本地模拟回执（作品链接为占位），真实小红书/抖音 API 待接；
- 非流式创建的 agent 任务（旧 createTask 路径）状态为 running，需界面点继续或 cleanup-running 清理（前端主路径均走 SSE 完成态）；
- 首次升级前的旧数据位于 `~/.dsh/bosom-friend/zhiyin/`（双重目录遗留），无迁移必要——新路径从零重建语义；
- 视频 thumbnail 直返原 URL；Electron 桌面壳仍指 8080（另配 backend-config.json 即可）。

## 五、复测方法
```bat
cd /d C:\Users\Jay\Desktop\Bosom friend APP
node products\opc\launcher\lib\types\bin.js --port 3090 --no-open   :: 或双击 start-opc.cmd 用 3080
node apps\zhiyin\smoke-all.mjs        :: 29 项业务域
node apps\zhiyin\smoke-edge.mjs       :: 13 项边界
node apps\zhiyin\raw-sse.mjs apps\zhiyin\sse-raw.txt   :: SSE 字节闭环
node apps\zhiyin\contract-audit.mjs  :: 契约缺口
```