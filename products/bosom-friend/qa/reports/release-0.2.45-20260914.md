# 发布记录 · Bosom Friend 0.2.45（2026-09-14）

> **这一版是第一个真正装得上、打得开的包。** 0.2.43 与 0.2.44 都因为内核运行时缺依赖而完全打不开
> （见 DEF-052），请勿分发那两个文件。

## 安装包

| 项 | 值 |
| --- | --- |
| 文件 | `products/bosom-friend/desktop/release/0.2.45/BosomFriend-Setup-0.2.45.exe` |
| 桌面副本 | `C:\Users\Jay\Desktop\BosomFriend-Setup-0.2.45.exe` |
| 大小 | 977,403,135 字节（932.1 MB） |
| SHA256 | `56B90EAD45BFFBD54FA638806E727285A4F5BAB1F64F4CC94873E0B737F172EB` |
| 构建时间 | 2026-09-14 21:2x（`rebuild-kernel-and-installer.ps1` 六步全部走完，输出 DONE） |

## 装机实测（本机真实安装，非拆包）

| 检查 | 结果 |
| --- | --- |
| 静默安装 | `/S` exit 0；`Bosom Friend.exe` 版本 **0.2.45** |
| 注册表 | `Bosom Friend 0.2.45` |
| 内核运行时 | `%APPDATA%\Bosom Friend\kernel-runtime` 解压 **200,080 个文件**，`resources\kernel-runtime.zip` 已删（成功才删） |
| **产品服务就绪** | **34 秒**（对照：0.2.44 等 653 秒仍失败、只有"产品服务未就绪"） |
| 更新日志 | 通知接口返回 **4 条**：0.2.42 / 0.2.43 / 0.2.44 / 0.2.45 |
| 内容形式注册表 | `digital-human`（数字人口播）、`scene`（场景呈现）均在 |
| 数字人形象库 / 音色 | 形象库空（新装）；音色 **8 个**，默认 `zh-CN-XiaoxiaoNeural` |
| 任务批量删除 | 空选择被如实拒绝：`code=40000 没有选择要删除的任务` |
| 界面 | 左侧导航出现「**长视频创作**」「**我的数字人**」（截图 `qa/evidence/` 可补存） |

## 本版修复（DEF-052，P0）

**现象**：0.2.44 装上后停在启动页 80%，只有一句「DeepSeek Harness runtime is not running；产品服务未就绪」。

**根因**：出包流程第 2 步只把**代码**（`server/lib`）同步进内核运行时，**依赖**不会跟着走——
运行时是更早一次 `pnpm deploy` 的产物。本版给服务端新增了 `msedge-tts`（数字人配音用），
它没进运行时，内核加载直接抛：

```
Cannot find package 'msedge-tts' imported from
  ...\kernel-runtime\node_modules\@deepseek-ai\dsh-bomom-friend-server\lib\types\tts.js
```

而第 2 步看上去一切正常，所以拆包验证（只核对了文件名）也没拦住。

**修复**：
1. 把缺的 32 个包补进 `kernel-runtime-unpacked/node_modules`；
2. 新增 `desktop/verify-runtime-deps.mjs`，接进流程第 **2b** 步：按 server 的 `dependencies`
   逐条核对运行时，缺一个就在出包前 `throw`，不再等到用户装完才发现。

## 同时修掉的打包链缺陷（DEF-051 的续）

`rebuild-kernel-and-installer.ps1` 第 4 步连续两次"没产出文件"，真因不是路径，而是
**我往这个 .ps1 里插了中文注释**——脚本开头就写着：Windows PowerShell 5.1 把无 BOM 的 .ps1
按 ANSI 读，非 ASCII 字节会静默破坏解析（`$repoRoot` 因此变 null）。已把全部注释改为英文，
并用脚本核对 `非 ASCII 字节 = 0`。

## 闭环实测（装机版，真实厂商，2026-09-14 21:5x）

全程真实 HTTP 打到装机版，未触碰内部 store：

| 步骤 | 结果 |
| --- | --- |
| 1. 上传形象图 | `PUT assets/upload/<id>` HTTP 200 → `POST assets/<id>/confirm` 入库，返回素材 URL |
| 2. 建数字人 | `POST digital-humans` → 雅姐，固定种子落盘，音色 zh-CN-XiaoxiaoNeural |
| 3. 起长视频任务 | `POST long-videos`（producer=digital-human、12 秒、9:16、烧字幕）→ 切出 **4 段** |
| 4. 逐段真实生成 | 真实进度 0→4/4 段，终态 **success**，无错误 |
| 5. 成片 | `lv-lv-8a21e410.mp4`，**19.36 秒 / 720x1280 / 4.08 MB**，HTTP 200 可下载 |
| 6. 草稿箱 | 共 1 条，本条在：「雅姐｜秋冬保湿面霜，主打干皮救急，今天直播间直降一百」 |

成片内容（抽帧核验，见 `qa/evidence/0.2.45-闭环成片-数字人+字幕.png`）：

- **同一个数字人形象贯穿全片**（固定 IP 成立）；
- **字幕按段落真实时长烧在画面底部**，中文分页正确（每行 11 字、最多 2 行）；
- 中间自动插入产品特写镜头（面霜瓶、涂抹画面），由厂商按文案生成；
- 四段文案由大模型生成且贴合卖点：「干皮姐妹看过来！秋冬脸干到起皮？」「这瓶面霜来救场了——深层补水、一秒化水，」…

证据：`qa/evidence/0.2.45-闭环成片.mp4`（成片原件）、`0.2.45-长视频创作页-装机版.png`（界面）、
`0.2.45-安装版启动后-新导航.png`（导航出现「长视频创作」「我的数字人」）。

## 已知未闭环

- **发布环节未实测**：本机账号库为空（`accounts.json` 是 `[]`），没有已登录的平台账号，
  发布要么走扫码登录（需真人），要么无账号可发。成片已进草稿箱，发布入口与链路复用 0.2.42 已验证的那条。
- **仍未跑 `run-gate.mjs`**：门禁要求开发版在 31280 运行，而装机版占着这个端口。
- **"删除草稿要切换页面"仍未复现**：需要用户补齐触发路径（哪个删除入口、有无提示、提示内容）。
