# 浏览器控制中心

## 职责

「知音」自动化引擎的浏览器底座：同时支持 **内置浏览器（Electron）/ 谷歌 Chrome /
微软 Edge** 三种引擎，为发布、互动、评论回复、私信接待提供统一浏览器环境。

## 模块结构

| 文件 | 职责 |
| --- | --- |
| `detect.ts` | 检测本机 Chrome / Edge（注册表 App Paths + 常见目录） |
| `launcher.ts` | 启动外部浏览器实例（独立 Profile + CDP 端口） |
| `cdp.ts` | CDP 客户端（页面发现 / 新开网址 / 执行脚本） |
| `manager.ts` | 实例生命周期、端口分配、默认引擎配置、知识库自动记录 |
| `controller.ts` | 渲染进程 IPC 通道 |
| `module.ts` | 模块注册（app.ts 已挂载） |

## IPC 通道

- `zhiyin:browser:detect` —— 重新检测本机浏览器
- `zhiyin:browser:getState` —— 浏览器列表 + 实例列表 + 默认引擎
- `zhiyin:browser:launch`（kind, platform）—— 启动实例
- `zhiyin:browser:openUrl`（id, url）—— 实例内打开页面
- `zhiyin:browser:close`（id）—— 关闭实例
- `zhiyin:browser:isAlive`（id）—— 实例存活检测
- `zhiyin:browser:setDefaultEngine`（engine）—— 切换默认引擎

## 风控设计（对齐影刀 RPA / AdsPower）

- 每个实例独立 `--user-data-dir`（`userData/browserProfiles/<实例ID>`），
  Cookie / 登录态物理隔离，多账号不关联；
- 端口 9333-9666 动态分配，避免与内置引擎 9222 冲突；
- 应用退出时 `closeAll()` 清理全部实例进程树；
- 启动 / 关闭 / 切引擎自动写入知识库工作日志。

## 下一步

- 驱动层（评论 / 私信）弹性选择器多版本降级；
- 外部浏览器实例接入 7×24 接待轮询与会话看门狗；
- 官方 MV3 扩展经 `--load-extension` 原生加载（需重新获取 MV3 原版或自研等价实现）。
