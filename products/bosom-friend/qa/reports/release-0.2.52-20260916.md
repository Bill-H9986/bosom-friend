# 发布报告 0.2.52（2026-09-16）

## 一句话

把 P0–P3 四轮改造（厂商能力实测 → 通用分镜编排 → 成片质感 → 模板与情绪）出成装机包，
并在出包过程中抓出并修掉一个**只在装机版才会暴露**的缺陷（DEF-071 随包字幕字体没随包）。

## 产物

| 项 | 值 |
| --- | --- |
| 安装包 | `desktop/release/0.2.52/BosomFriend-Setup-0.2.52.exe`（1,053,026,097 B / 1,004.2 MB）；桌面同名副本 |
| SHA256 | `B0E6D5E3005603D672DAEB03B48EFAA9A0C6EDB89A05B717F9550A17E3FD9792` |
| 内核运行时 zip | 419.0 MB / 195,539 条目 |
| 版本号 | `desktop/package.json` 0.2.51 → **0.2.52**（含 description 同步） |

## 出包链（8 步全绿）

| 步骤 | 结果 |
| --- | --- |
| 1 构建 server + kernel | 通过 |
| 2 同步 lib 进内核运行时 | 通过（含新增的 `lib/assets/` 字体） |
| 3 依赖核对 + 配置漂移 | `runtime dependencies OK`；`RUNTIME_CONFIG_DRIFT PASS` |
| 4 组装便携平台引擎 | 17,240 文件 / 1,951.8 MB |
| 5 重打内核 zip | 195,539 条目 / 419.0 MB / 1,265 秒 |
| 6 **解压后真握手** | `HANDSHAKE PASS` → `{"name":"deepseek-harness-sdk-runtime","version":"0.0.1"}` |
| 7 换入新 zip | OK |
| 8 出 NSIS 安装包 | OK |

## 装机实测（13/13 PASS）

| 检查 | 结果 |
| --- | --- |
| 安装包存在与大小 | 1,004.2 MB |
| FileVersion 与 package.json 一致 | exe=0.2.52 |
| SHA256 记录 | `B0E6D5E3005603D6…` |
| 随包解压器与仓库一致 | 哈希相等 |
| 随包 node.exe | 在位 |
| 随包解压器解开随包 zip | exit 0 / 3.7 分钟 / 195,539 文件 |
| 静默安装 | exit 0 |
| 注册表版本 | `Bosom Friend 0.2.52` |
| 装机 exe 版本 | 0.2.52 |
| 装出来的运行时 | 195,539 文件，无解压失败日志 |

## 装机版专项验证（本轮新增探针）

`qa/probes/verify-installed-compose.mjs`：**用已安装运行时里的服务端代码 + 随包 ffmpeg 真跑一次拼接与字幕烧录**。

为什么必须单独做这一步：字体路径、ffmpeg 定位在"编译产物旁边"与"源码旁边"解析结果不同，
源码态全绿恰恰会掩盖装机版的退化——DEF-071 就是这么漏到出包前的。

```
装机版拼接 = true
字体随成片复制 = true          ← 修复前是 false（字幕静默退化）
成片规格 = h264 1080x1920 24fps
```

## 本次出包修掉的缺陷

| 编号 | 标题 | 处置 |
| --- | --- | --- |
| DEF-071 | 随包字幕字体没随包（`tsc` 不搬 `.ttf`、出包链只同步 `lib/`） | 字体移到 `src/assets/`；构建钩子复制到 `lib/assets/`；解析改成**逐个候选查存在**（源码态与编译态深度不同，写死一个相对路径必然算错） |

> 这条修了**两次**：第一次只把字体挪到 `src/assets/`、解析写死 `'./assets'`，
> 源码态绿、装机版仍找不到（编译产物在 `lib/types/`，字体在 `lib/assets/`，差一级）。
> 第二次改成`先查存在再决定`才对——**同一类错误在一轮里犯了两次**，教训写在知识库条目 12 第 63 条。

## 种子数据

| 项 | 值 |
| --- | --- |
| 安装位置 | `%LOCALAPPDATA%\Programs\Bosom Friend` |
| 内核运行时 | `%APPDATA%\Bosom Friend\kernel-runtime`（195,539 文件） |
| 用户数据 | 未动（`~/.bosom-friend`），版本升级不清数据 |

来源：`.dsh-build/release-0.2.52-r2.log`、`.dsh-build/install-0.2.52-r2.log`、
`qa/probes/verify-installed-compose.mjs` 实测输出、本机文件哈希。