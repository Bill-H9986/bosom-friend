# 发布记录 · Bosom Friend 0.2.43（2026-09-14）

> 本轮把「长视频产出」做成通用工作流，并补上数字人口播与字幕，出包供外部试用。
> 与 0.2.42 的区别：**新增功能**（长视频创作、我的数字人、字幕），不是只修启动。

## 安装包

| 项 | 值 |
| --- | --- |
| 文件 | `products/bosom-friend/desktop/release/0.2.43/BosomFriend-Setup-0.2.43.exe` |
| 桌面副本 | `C:\Users\Jay\Desktop\BosomFriend-Setup-0.2.43.exe` |
| 大小 | 976,605,443 字节（931.4 MB） |
| SHA256 | `ACC2A2A3F1C945B607695089989D78EDCDD2FFDC094992F5EF3CAD620A9A2634` |
| 构建时间 | 2026-09-14 18:15（electron-builder exit 0） |
| 版本权威 | `desktop/package.json` → 0.2.43（0.2.42 基础上仅升版本号） |

## 本轮内容

- **长视频产出通用工作流**（`server/src/long-video.ts`）：厂商单次只生成 4~12 秒，
  超过就必须「写稿 → 切段 → 逐段生成 → 统一画布拼接」。这条编排与业务无关，
  业务差别收在片段生成器里。
- **两个片段生成器**：`digital-human`（固定形象 + 配音 → 厂商 reference 模式）、
  `scene`（不出镜，每段一个画面）。新增内容形式只加一个生成器，编排与任务表都不动。
- **固定 AI 数字人形象库**：形象图 + 音色 + 固定种子，跨次生成是同一个人、同一个声音。
- **字幕**：按段落真实时长生成时间轴 → ASS → 随包 ffmpeg 烧进画面。
  中文没有空格，libass 不自动折行（实测 49 字长句会被画面左右切掉），
  因此断行与分页由我们自己算（每行 11 字、每条最多 2 行）。
- **前端**：「长视频创作」与「我的数字人」两个页面，只对接一个生成入口。

## 修复的缺陷

| 编号 | 内容 |
| --- | --- |
| DEF-043 | 用户加的参考图从头到尾没进媒体生成链路 → 图生视频形同虚设 |
| DEF-044 | 智能体没有发布指令也产出「去发布」动作卡，跟随模式自动发布 |
| DEF-050 | 厂商轮询预算写死 180 秒 < 厂商实际耗时（33s/125s/160s/4m07s）→ 超时静默降级成幻灯片 |

## 包内实测（拆包验证，非源码检查）

从安装器里取出 `$PLUGINSDIR/app-64.7z`（911.4 MB）再逐层核对，确认**打进去的是新代码**：

| 检查 | 结果 |
| --- | --- |
| 前端新页面 | `resources/frontend-dist/assets/` 内 `LongVideoPage-D7kvJIwk.js`、`DigitalHumansPage-9gOmF1hS.js`、`longVideo.api-CVJFThMb.js` 三个文件均在 |
| 内核运行时 | `resources/kernel-runtime.zip` 366.1 MB / **200,064 个条目** |
| 服务端新模块 | `long-video.js`、`video-compose.js`、`tts.js`、`ffmpeg.js`、`digital-human.js` 全部命中 |
| 随包 ffmpeg | `resources/runtime/ffmpeg.exe`（61.5 MB，含 libass/freetype/libx264/aac） |

## 未做的两项（如实记录）

- **未做装机实测**：本机装的是 0.2.42，直接安装会覆盖用户当前可用的环境；
  包内验证已做到"拆包核对新代码确实在"，但**"装上去能不能跑起来"尚未实测**。
- **未跑 `run-gate.mjs`**：知识库明确「构建与门禁不能并发」，且门禁的多项检查要求
  开发版在 31280 运行；出包占满机器期间没有并发执行。**发布前应补跑一次。**

## 出包过程中修复的打包链缺陷

这三条都不是产品代码，而是**打包链自己坏了**，一并留档：

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| `repack_kernel.py` 不存在，第 4 步必失败 | 脚本原先住在 `desktop/dist/`，而 `dist/` 是会被清理动作整目录删掉的（知识库 01 §46 正是这条教训） | 重写在仓库源码侧 `desktop/repack_kernel.py` 并改脚本引用，不再放回会被清掉的位置 |
| `desktop/dist/` 整个缺失（runtime / kernel-runtime-unpacked / zip 全没） | 同上，构建产物被清理 | `runtime` 从装机版 `resources/runtime` 回收；`kernel-runtime-unpacked` 从 `%APPDATA%\Bosom Friend\kernel-runtime` robocopy 回收（199,984 文件 / 1.09GB / 0 失败） |
| electron 33.4.11 下不下来、`node_modules/.bin` 为空 | 官方源走 github.com（被墙，日志 09-13 §13.2 记过）；另一次安装撞 EPERM 中断在链接阶段前 | 用 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`；重跑安装补齐 60 个 bin |
