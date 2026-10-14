# ⚠️ 本目录的 `electron/` 不参与构建，请勿重新接入

**状态**：归档（遗留实现）。最后实质性提交为 "目录整理第一批——根目录清空、知识库归档化、冗余目录归位"。

## 当前仍在使用的部分

`project/bosom-friend-electron` 只有两样东西进入发布产物，**均不涉及 `electron/`**：

| 产物 | 来源 | 引用位置 |
|---|---|---|
| 前端界面 | `project/bosom-friend-electron/dist/` | `desktop/electron-builder.yml` → `extraResources` → `frontend-dist` |
| Electron 运行时二进制 | `node_modules/electron/dist` | `desktop/electron-builder.yml` → `electronDist` |

发布版的主进程与 preload 来自 **`products/bosom-friend/desktop/electron/`**（`main.cjs` + `preload.cjs`），构建脚本见 `desktop/build-win.sh`。

## 为什么标注警告

`electron/` 下这套主进程实现存在**已知且严重**的安全缺陷，它没有被修复，只是不参与发布：

| 缺陷 | 位置 |
|---|---|
| 无条件开放 `remote-debugging-port=9222`（本机任意进程可经 CDP 接管） | `electron/main/index.ts:59` |
| `open-win` 创建子窗口时 `nodeIntegration:true` + `contextIsolation:false` | `electron/main/index.ts:342` |
| preload 透传原始 `ipcRenderer`（`invoke`/`send`/`on`/`off` 无通道白名单） | `electron/preload/index.ts:24-51` |
| `ICP_VIEWS_GET_FILE_STREAM` 读取渲染层传入的任意路径 | `electron/main/views.ts:104` |
| `ICP_VIEWS_SAVE_FILE` 字符串拼接路径 + 失败分支不 `resolve`（Promise 永久挂起） | `electron/main/views.ts:86-98` |
| 硬编码小红书 `esec_token` | `electron/plat/xiaohongshu/index.ts:51` |
| 硬编码百度 cookie 与内网 IP | `electron/main/views.ts:52`、`electron/plat/xiaohongshu/index.ts:1438` |
| WebView `disablewebsecurity={'true'}`（关闭同源策略） | `src/components/WebView/index.tsx:89` |
| OTA 从第三方镜像下载后无哈希校验直接执行 | `electron/main/update.ts:228-249` |
| `on`/`off` 包装不匹配导致监听器无法移除 | `electron/preload/index.ts:25-34` |

**一旦有人把 `electron/` 重新接入 `electron-builder` 的 `files` 或 `main` 字段，上述缺陷会立刻在发布版生效。**

## 处置建议

二选一（需负责人决定，勿擅自执行）：

1. **删除** `electron/` 子目录 —— 已确认无任何构建路径引用它，前端 `dist/` 由 `src/` 独立产出，删除不影响发布；
2. **移入** `products/bosom-friend/legacy-archive/`，与既有归档约定保持一致。

在决定之前，请保持本文件与 `electron/` 目录同在。
