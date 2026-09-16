# 发布记录 · Bosom Friend 0.2.42（2026-09-13）

## 发布位置（GitHub）

| 项 | 值 |
| --- | --- |
| 公开下载页 | https://github.com/Bill-H9986/zhiyin/releases/tag/v0.2.42 |
| 仓库 | `Bill-H9986/zhiyin`（公开下载仓库） |
| 源码仓库 | `Bill-H9986/zhiyin-app`（私有），提交 `8077de2`，2,502 个文件 |
| 旧版本 | 同仓库 15 个旧 release（v0.9.5 ~ v0.11.0，12.89GB）已清理，留档见 `cleanup-2026-09-13-github-old-releases.md` |

## 安装包

| 项 | 值 |
| --- | --- |
| 文件 | `products/bosom-friend/desktop/release/0.2.42/BosomFriend-Setup-0.2.42.exe` |
| 桌面副本 | `C:\Users\Jay\Desktop\BosomFriend-Setup-0.2.42.exe` |
| 大小 | 992,743,561 字节（946.8 MB） |
| SHA256 | `D717EABCAF281427500EF7D8A944C3AFA58BCE41FD5DE5EC771F7A816FA0EDF6` |
| 构建时间 | 2026-09-13（electron-builder exit 0；含卸载残留修复的最终版本） |
| 代码 | 提交 `27f7231`（构建使用的工作区与之内容一致） |
| 安装结果 | 静默安装 `/S` exit 0；注册表 `Bosom Friend 0.2.42`；`Bosom Friend.exe` 版本 0.2.42.0 |

## 本轮内容（详见 CHANGELOG [0.2.42]）

- **启动页启动进度条**：真实阶段（检查运行环境 → 清理旧版运行时残留 → 校验内核运行时 →
  启动内核服务 → 加载产品界面）+ 真实百分比 + 已用时；测不出长度的阶段走扫光不确定态并冻结百分比。
- **低配机型自动适配**：≤4 逻辑核心或 ≤8GB 内存判低配，降载内核堆上限 / 备份保留 / 轮询间隔 /
  前端重特效 / 启动等待，判定与理由落盘 `perf-profile.json`。
- **启动链路三修**：DEF-036 内核握手加预算、DEF-037 旧运行时清理改异步、DEF-038 不确定态显示诚实化。
- **DEF-040**：不再承诺做不到的"自解压兜底"，缺运行时的错误改成可执行动作（重新运行安装包修复安装）。

## 包内实测（安装版）

| 检查 | 结果 |
| --- | --- |
| 内核运行时（安装期解压） | `%APPDATA%\Bosom Friend\kernel-runtime` **199,984 个文件**，`runtime\bin-desktop.mjs` 存在 |
| 打包服务端含新代码 | `dsh-bosom-friend-server/lib/types/perf.js` 存在；`http.js` 含 `BF_PERF_TIER` 注入；`security.js` 用 `perfTier()` |
| 打包前端含低配标记 | `index-*.css` 含 `[data-perf=...]`；`index-*.js` 含 `dataset.perf` |
| 打包主进程含进度通道 | `app.asar` 内含 `bosom-kernel:progress` / `perf-profile.cjs` / `GPU_FALLBACK` |
| **安装版启动页实测（真机）** | `verify-splash-progress.mjs --packaged` **8/8 PASS**：进度条出现、百分比单调不减、留痕走完 `检查运行环境 2% → 6% → 清理旧版运行时残留 12% → 校验内核运行时 30% → 启动内核服务 80% → 加载产品界面 100%`、最终进入产品页 |
| 证据截图 | `qa/evidence/启动页-进度条-安装版启动中.png`（30% / 版本 v0.2.42）、`启动页-进度条-安装版进入产品页.png` |

## 门禁

`run-gate.mjs --full`：**24 绿 / 1 黄 / 0 红**（`qa/reports/gate-20260913-180503.md`）

- 绿：内核组合、内核入口、禁直连模型、依赖边界、追溯结构、功能完整性、缺陷闭环（39 条）、
  数据编码完整性、安装包只读保护、模型配置链路、CRUD 34/34、知识库蒸馏 12/12、
  AI 智能体任务动作 28/28、服务端功能测试 58/58、cordis 补丁一致性、
  **启动页进度条 14/14（新）**、**性能档位判定 15/15（新）**、**内核握手超时 3/3（新）**、
  抖音真实播放量、内核工具可执行（仓库产物与装机运行时各 14/14）、
  专业 E2E 50 passed、中断时序矩阵 24/24、S 级前端验收 7 文件 0 违规、产品版本单源一致。
- 黄：验收准则覆盖率 94.8%（覆盖 43 / 部分 5 / 总数 48）——发布前要求 100%。

## 安装版业务实测（真实大模型）

| 检查 | 结果 |
| --- | --- |
| 安装版 AI 业务（`qa/probes/verify-installed-ai-business.mjs`） | **7 passed (4.1m)**：AC-004-1 一句话真的调到大模型且非模板正文；AC-016-1 对话用的就是设置里保存的模型；AC-018-1 五条（对话→导航卡→真的跳转，含"没有导航意图不被误跳转"） |
| 首次使用逐页走查（`qa/probes/verify-installed-first-run.mjs`） | **4/4 PASS**：七页至少六页渲染（6/7）、无内部路径/命令行/堆栈、静态资源 0 个 404；截图落 `qa/evidence/安装版-首次使用-*.png` |
| 升级保数据 | 0.2.41→0.2.42 静默安装 exit 0；数据根 8,041 文件、`accounts.json` SHA256 `2CC05BDF…` 前后一致 |
| 卸载无残留 | 静默卸载 exit 0：安装目录 / 桌面快捷方式 / 开始菜单 / 注册表全部清零；`%APPDATA%\Bosom Friend` **整棵目录消失**（修复前留 127 个 Chromium profile 文件，卸载钩子已补 `rd /s /q`）；进程 0；数据根 8,075 文件且 `accounts.json` 哈希不变 |

## 未做（如实）

- 卸载实测未在本轮重跑（AC-020-2 的卸载证据属于 0.2.41，结论是数据保留 + 无残留）；
  0.2.42 的安装路径新增内容只有 `app.asar` 与 zip 内容，卸载逻辑未改动。
- 干净机器侧（AC-021-1/2/3）与自动更新（AC-021-4）仍无外部条件，见最终交付报告 §七。
