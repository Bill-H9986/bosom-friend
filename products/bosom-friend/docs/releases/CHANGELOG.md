# 变更日志

本文件遵循 Keep a Changelog 格式，版本号遵循 SemVer。每个版本必须有日期，按时间倒序排列。
## [0.2.49] - 2026-09-15

> 安装包已构建：`products/bosom-friend/desktop/release/0.2.49/BosomFriend-Setup-0.2.49.exe`
> （932.2 MB，SHA256 `6178380A…`）。包内实测 `qa/probes/verify-installed-package.ps1 -Install` **13/13 PASS**；
> 长路径这一步另有三层验证（makensis 编译 / NSIS 逻辑实测不挂死——拒绝分支 30 秒终止 / 真注册表 0→1），详见
> `qa/reports/release-0.2.49-20260915.md`。

### Changed

- **安装期自动开启 Windows 长路径支持**（一次 UAC，非静默安装才弹）：0.2.48 已经让"解压"不再依赖系统设置
  （自带解压器自己加 `\\?\\` 前缀），但内核进程**读取**运行时里超过 260 字符的路径仍需要
  `LongPathsEnabled=1`。此前这一步要用户自己跑修复包或手动 `reg add`；现在安装器检测到开关为 0 时，
  用 `ExecShell "runas"` 起一个提权的 `reg.exe` 打开它，**并轮询注册表直到真的读到 1 才算成功**——
  拒绝授权不会被当成成功，会写进安装日志并给出下一步（重跑安装包 / 以管理员开启）。
- 静默安装（`/S`）不弹 UAC，只留一行日志（自动化安装不打扰，也不假装做过）。

### Added

- 探针新增两条安装器不变量：长路径这一步必须存在（含静默跳过分支）、必须"轮询到真值"才算成功。

## [0.2.48] - 2026-09-15

> 安装包已构建：`products/bosom-friend/desktop/release/0.2.48/BosomFriend-Setup-0.2.48.exe`
> （932.2 MB，SHA256 `C1F8BF59…`）。包内实测 `qa/probes/verify-installed-package.ps1 -Install` **13/13 PASS**
> （包内解压器解包内 zip 200,537 文件 / 静默安装 exit 0 / 注册表 0.2.48 / 安装器把运行时解到位），
> 详见 `qa/reports/release-0.2.48-20260915.md`。

> 0.2.43~0.2.47 的发布记录只写在应用内「更新日志」的单一事实源 `server/src/changelog.ts`（用户可见），
> 本文件当时漏记；从 0.2.48 起恢复逐版记录。

### Fixed

- **装好的应用打不开：内核运行时解压不再依赖系统工具与系统设置**（DEF-055）。现场（4 核 / 7.9GB，v0.2.47）
  的错误框是「内核运行时解压失败（PATH 上的 tar.exe 失败（spawn tar.exe ENOENT）；随包 Python 失败（Command failed: …））」：
  这台机器没有 `System32\tar.exe`，而随包 Python 的 `zipfile` 又受 MAX_PATH 260 限制——这份 zip 最深相对路径
  232 字符，解到 `%APPDATA%\Bosom Friend\kernel-runtime` 之后最深 289 字符，而 Windows 长路径支持默认关闭，
  Python 与 libuv 都只在"进程 longPathAware **且** `LongPathsEnabled=1`"时才越过 260。
  新增纯 Node 解压器 `desktop/electron/kernel-unzip.cjs`（ZIP64 + 逐条 CRC + zip-slip 防护 + 显式 `\\?\` 前缀），
  它不依赖 PATH、不依赖随包 Python、也不依赖注册表开关；解压阶梯改为"长路径可用时 tar 优先，不可用时自带解压器优先"，
  安装器（`resources\runtime\node.exe` + `resources\kernel-unzip.cjs`）与主进程共用同一份实现。
- **启动失败的原因不再被丢掉**（DEF-056）：`execFile` 的失败消息首行是整行命令行、原因在 stderr 行里，
  而取首行与脱敏两处叠加把唯一有用的一行扔掉了。现在取 stderr 末行（异常落点），完整事实写
  `%APPDATA%\Bosom Friend\kernel-extract.log`（解压计划、每步来源与真实原因、长路径探测结果），错误框保持脱敏。

### Added

- **现场修复包**（`qa/repair-kit/` + 生成器 `qa/make-repair-kit.ps1`）：打不开的机器不必重装，
  双击一次即完成"提权开启 Windows 长路径支持 + 用自带解压器展开运行时"，跑完自动启动应用。
- 启动阶段每一步的成败判据从"子进程退出码"改成"运行时入口 `runtime/bin-desktop.mjs` 是否在位"——
  退出码 0 但入口缺失（长路径被截断、磁盘写满）不再被当成成功。

### Changed

- 首次启动解压内置运行时显示真实进度（已解压 N/M 个文件），不再整段走不确定态扫光。
- `qa/probes/verify-kernel-extract.mjs` 验收从 22 项扩到 44 项（含 233 字符条目 → 290 字符绝对路径的真解与回读、
  退出码 0 但入口缺失不算成功、损坏 zip 的可读原因、CLI 契约、修复包不变量）。

## [0.2.42] - 2026-09-13

> 安装包已构建并装机实测：`products/bosom-friend/desktop/release/0.2.42/BosomFriend-Setup-0.2.42.exe`
> （946.8 MB，SHA256 `D717EABC…`）。安装版启动页、真实大模型 AI 业务、首次使用走查、升级与卸载实测
> 见 `qa/reports/release-0.2.42-20260913.md`。

### Added

- **启动页启动进度条**：启动页现在显示真实阶段（检查运行环境 → 清理旧版运行时残留 → 校验内核运行时 →
  启动内核服务 → 加载产品界面）、真实百分比与已用时。百分比只在真实里程碑推进，
  测不出长度的阶段（解压、内核握手、等待前端）走"扫光"不确定态并冻结百分比——
  不用时间假装进度，用户可以区分"在动"与"卡死"。
  主进程同时保留最近 40 次里程碑留痕（`status.progressLog`），用户报"卡在某一步"时能直接看出走到了哪。
- **低配机型自动适配**（新增 `desktop/electron/perf-profile.cjs`）：按逻辑核心数（≤4）与物理内存（≤8GB）
  判定低配档，判定输入、档位与理由落盘 `<userData>/perf-profile.json`，并随环境变量传给内核子进程与服务端：
  - 内核子进程加 `--max-old-space-size` 上限（按内存 35%，夹在 768MB~2048MB），避免低内存机器一路吃到换页；
  - 备份轮转保留份数 30 → 10；接待引擎默认轮询间隔 10 → 20 分钟；
  - 前端关闭重特效（弹窗模糊、长动画，`html[data-perf="low"]`）；
  - 启动等待上限 90 → 240 秒、慢机器提示阈值 80 → 240 秒，并在启动页如实标注"低配模式"。
  可用 `BF_PERF_PROFILE=low|standard` 强制档位（现场排查用），未探测到时一律标准档。
- 内核握手等待预算（标准 120 秒 / 低配 300 秒，可用 `BF_KERNEL_HANDSHAKE_TIMEOUT_MS` 覆盖）
  与产品服务等待上限（`BF_STARTUP_WAIT_SECONDS`）。

### Fixed

- **旧版内核运行时残留清理会卡死启动页**（DEF-037）：清理走的是同步 `fs.rmSync`，而一份运行时约
  417MB / 23 万个文件，实测能堆到 8 份共 8.9GB；机械盘上删除期间主进程事件循环被占满，
  窗口显示与 IPC 全部停摆，表现就是低配机器上启动页一动不动。改为异步 `fs.promises.rm` 并逐步上报进度。
- **内核握手没有超时**（DEF-036）：子进程活着但不回应（运行时被安全软件卡住、解压不完整、协议不匹配）时，
  未加界的等待会让启动页永远停在"等待初始化握手"，用户既进不去也看不到原因。现在按预算如实报错，
  保留"重试启动 / 完全退出"两条路，并仍会尝试接入已在服务的产品页。
- **不确定态下进度显示自相矛盾**（DEF-038，本轮自测截图查出）：不确定态曾把进度条拉满并冻结百分比文字，
  于是界面上出现"6%"配一条满格条纹。现在填充长度永远等于真实进度，不确定只叠一条扫光，百分比文字始终真实。
- **卸载并非真的无残留**（DEF-042）：卸载钩子只删 `kernel-runtime*` 与几个具名缓存，
  实测应用跑过之后仍留 127 个 Chromium profile 文件（Local Storage / IndexedDB / Service Worker /
  Preferences 等），"卸载无残留"这句验收准则当时并不成立。现在整个 `%APPDATA%\Bosom Friend`
  目录一起清掉（用户数据 `%USERPROFILE%\.bosom-friend` 不受影响）；复测残留为 0。
- **承诺了一个做不到的兜底**（DEF-040）：安装器解压完会删掉 `resources/kernel-runtime.zip`（省 417MB），
  所以主进程里"缺入口就自解压"的兜底永远走不到，注释与文案却都写着它能兜底——用户遇到
  `%APPDATA%\Bosom Friend\kernel-runtime` 丢失时只剩一句"内核运行时缺失"，唯一出路是重装。
  现在注释改为真实契约，缺 zip 时直接告诉用户「请重新运行安装包完成修复安装」。

### Changed

- GPU 崩溃留痕：连续两次崩溃后下次启动自动退回软件渲染（此前只有 `BF_DISABLE_GPU=1` 手动开关）；
  硬件加速稳定运行 5 分钟后清除留痕，偶发崩溃不会永久降级。
- 门禁新增三项：「启动页进度条」（`qa/probes/verify-splash-progress.mjs`，两种真实场景）、
  「性能档位判定」（`qa/probes/verify-perf-profile.mjs`）、「内核握手超时」（`qa/probes/verify-kernel-handshake-timeout.mjs`）。

## [0.2.41] - 2026-09-11

> 09-13 出货的 0.2.41 安装包还包含 09-12 ~ 09-13 的 BUG 清剿（此前只记在提交与 QA 报告里，此处补齐）。

### Fixed（09-12 ~ 09-13 清剿）

- **要求二 R3「无源不显示」——9 处伪造 0 清零**：采集层 `worker.py` 的 `int(x or 0)`、
  落库 `platform-sync.ts` 的 7 个 0 与 `?? 0`、`routes-channels.ts` 建发布流的 engagement 全 0、
  `platform-login.ts` 建账号的 fans/following/work/income 全 0、作品分析无采样行回一组 0。
  真实数据验证：抖音 15 条作品同步后伪造 `viewCount` 由 15/15 降到 0/15。
- **接口假成功——9 处「回 code 0 但什么都没做」**：`login/mail`、`login/phone`、
  收藏的 POST/DELETE、`contact/feedback`、`writeStoredLlm`，
  以及发布任务的 `publish-now` / `retry` / `publish-at` / `DELETE`。
- **装机版 AI 内容生成完全不可用**：内核入口指向不存在的路径。
- **内核业务工具引用不存在的数据集合**：静态检查抓不到，新增真跑验收并接入门禁。
- 平台范围收敛为国内 10 家 / 9 家可作频道；B 站扫码登录从零补上；国外平台全部移除。
- 交付链：随包浏览器补齐 playwright 1169（此前 6 个平台启动即失败）；
  构建脚本改为按内容同步 pnpm `.pnpm` 副本；卸载清内核运行时残留（曾堆 8 份 / 8.9GB）；
  启动回收平台任务目录（曾堆 4108 个目录只增不减）。
- 抖音单作品真实播放量接通；作品分析接口不再伪造 0。

### Fixed

- **图片分辨率回退成正方形像素档，与视频不一致**（DEF-029）：图片档位回到 720p/1080p，
  成品像素由「档位 + 画幅」派生（1080p + 3:4 → 1080x1440，+ 9:16 → 1080x1920），
  生成时把画面比例写进提示词并在落盘前裁剪缩放到成品像素。此前定价接口给的是
  `512x512…2048x2048`（全是正方形），生成端还写死 `size=1024x1024`——用户选的比例从未作用到成品。
  实测（真机生成）：`1080p + 9:16` → `ai-img-ddcae155.png` 正好 1080x1920。
- **裁剪谎报成功**（DEF-030）：源图不可解码时 PowerShell 仍打印 `OK`，调用方会拿到一个
  并不存在的成品路径（图片整张丢失）。现在整段 `try/catch` + 校验产物真的落盘，失败保留原图。
- **频道里的快手点了没反应**（DEF-033）：worker 对所有平台固定传同一套登录参数、从不传 `handle`，
  而只导出 `*_setup` 的平台默认 `handle=False`（"没有 cookie 就直接返回失败"）——
  快手在产品路径下必然登录不了；alipay/weibo 的 `*_cookie_gen` 又没有 `cdp_url`，固定传会 TypeError。
  改为按函数签名传参。实测三张二维码均为真图：快手 125x125 / 视频号 470x470 / 闲鱼 148x148。
- **模型配置可能被一次空提交整份清空**（DEF-034，P0）：`PUT ai/user-llm` 的两条写入路径
  都会无条件接受清空（实测发生过：`providers` 变 `[]`、只剩图片/视频残留）。现在已有服务时
  清空必须显式 `allowEmptyProviders` / `clear`，否则报错且不落盘；每次写入留审计行到
  `<dataRoot>/logs/llm-config-audit.log`（动作/服务数/是否清空/UA/时间），事后可回溯发起方。
- **qa-all 的门禁链整条失效**（DEF-035）：`qa-guard` / `qa-guard2` 把 playwright 安装路径
  写死，依赖树一变就 `MODULE_NOT_FOUND`，且失效方式看起来像"没跑"。新增 `qa/browser.mjs`
  按"谁装了就用谁"解析；修后 `qa-guard` 23/23 PASS。同时修掉一条腐烂断言
  （免责声明的同意状态已改记服务端，旧断言查 localStorage 会恒红）。

### Added

- **频道平台新增快手 / 视频号 / 闲鱼**（DEF-031）：白名单 = 小红书 / 抖音 / 快手 / 视频号 / 闲鱼。
  快手与视频号由引擎模块自动判能力；闲鱼作为计划平台先以 `coming_soon` 出现，登录适配器
  （`uploader/xianyu_uploader`）落地后自动转 `available`。连接能力与发布能力**分开报告**，
  没接通发布的平台不会出现在内容创作的目标平台里。
- **模型配置写入审计**：见上（DEF-034）。
- 闲鱼扫码登录适配器：登录走 `passport.goofish.com` 二维码；二维码画在跨域 canvas 上、
  `toDataURL()` 被浏览器以"画布被污染"拒绝，改用元素截图转 data URL。

### Changed

- **设置 → 自定义大模型按参考版式重排**：不再预建/预填任何默认服务，服务区只放
  「Agnes AI 国内站」官网按钮；删掉独立的「图片与视频模型」区块——所有模型都进服务目录，
  每行标明用途（对话 / 图片 / 视频），客户有多少图片、视频模型就往目录里加多少行；
  服务端据此支持 `image/video: { providerId, model }`，由模型所属服务提供接口地址与密钥；
  「获取可用模型」改为可搜索的勾选清单弹窗；模型目录支持逐个模型设置显示名称。
- **删掉设置 → 系统与更新里的「本地数据管理」**：7 个"清空 XX"按钮与一键全清对普通用户无用，
  且是设置页里最大的误操作面；后端 `v2/data/cleanup` 保留。
- 视觉指纹对比失败时，门禁报告直接给出"哪一段骨架变了"，不再只报一个路由名。
- **平台目录不再宣称产品未接入的能力**：`/api/v2/channels/platforms` 现在同时报告两件事——
  「引擎能做什么」（源码扫描出的 auth/publish）与「产品是否把它当频道开放」（新增 `channel` 字段）。
  此前接口把引擎全量能力（11 个平台）当成产品能力下发，而产品实际只接通 5 个。
  白名单的唯一定义移到服务端（`PRODUCT_CHANNEL_PLATFORMS`），前端删掉自己那份副本
  （两份清单必然漂移）。
- **Ant 颜色对比度补全**（qa-guard2 的无障碍从 22/25 到 24/25，全部路由 A11Y 绿）：
  `.ant-tag-cyan`（账号页规则表 3.39）、`.ant-list-empty-text`（监控页空态 1.78）、
  `.ant-btn-link`（链接型按钮用的品牌紫 #8b7cf6 白底只有 3.32，取同一支更深的 #6d28d9）——
  与 `globals.css` 里已有的 tabs / danger / 标签修复是同一批，补齐漏掉的选择器。
- **监控页两个 Ant Select 补可访问名称**（`选择账号` / `选择作品`）：同页其它筛选下拉早就有
  `aria-label`，这两个漏了。
- 删除过时的验收脚本 `frontend-settings-cleanup-verify.mjs`：它验证的是本版从设置页移除的
  「本地数据管理」区块，留着就是一条永远不可能通过的断言（后端 `v2/data/cleanup` 保留）。


## [0.2.40] - 2026-09-10

### Changed

- **模型配置的唯一权威被门禁钉住**：`qa/verify-llm-config.mjs` 新增一步，扫描打包主进程
  （`desktop/electron/*.cjs`）——出现 `zhiyin-model-config` / `userModelConfig` / `AGNES_*_API_KEY`
  任一即判红。历史那份"主进程 electron-store → 注入 AGNES_*"的副本只活在**不进产物**的旧桌面壳里
  （旧壳的 IPC 也已无任何渲染端调用方），密钥的真实注入路径只有服务端 `kernel-client` 一条。
- **两个运行时的 cordis 补丁对齐并加一致性门禁**：dev/web 层（`bundle/app`）与桌面层（`bundle/desktop`）
  挂的是同一个产品服务插件，却用了两个实例 id（`bosom-friend-server-api` / `bosom-server-api`），
  配置也各写一遍；两个运行时不会同时加载，漂移平时看不出来。现在 id 统一，
  并新增门禁检查项「cordis 补丁一致性」（`qa/verify-cordis-patches.mjs`）：
  两层共同插件的 id 与共享配置必须逐项相同，只有声明过的桌面独有键（`frontendDist`）可以不同。
- **客户端壳不再启用「账号 store 双栈」**：`LayoutBody` 此前会初始化 electron 侧的账号 store
  （IPC + electron DB），它与 Web 侧 store（HTTP API）是两套数据源、status 语义相反；
  而且 `init()` 会起一个 10~30 分钟一轮的账号有效性轮询循环，整个应用生命周期都在跑。
  全仓确认那份 store 的数据只剩**未挂路由**的 `views/publish` 老发布页在读之后，去掉了初始化与登出清理，
  产物里 `timeingCheckAccount` / `PubAccountDetModule` / `icpGetAccountList` 等标记**全部 0 命中**
  （相关 chunk 1,502,614 → 1,501,046 字节），活跃页面继续走 Web 侧 store。
- **发布弹窗合并为一个宿主**：此前「内容创作 / 账号日历 / AI 批量工具条」各自挂载一份 `<PublishDialog>`，
  并各管一套开关状态与账号列表——同一个弹窗实现了三遍，行为还会因入口不同而分叉。
  现在只保留布局壳里的一个 `PublishDialogHost`（`WebAppLayout`），状态收进 `store/publishDialogHost`，
  三个入口只调 `openPublishDialog({ accounts, defaultAccountIds, onPubSuccess, ... })`；
  日历「新建作品」预设发布时间走宿主的命令式句柄（`publishDialogHandle()`）。
  E2E 套件新增两条用例把「同一时刻只可能出现一个发布弹窗」钉住（内容创作入口 + 账号日历入口）。
- **接待功能合并为两处**：账号页此前有「接待规则 / 接待记录 / 评论接待 / 私信接待」四个页签，
  与「全局监控」的评论/私信客户列表重复。现在账号页只保留**接待规则**（配置面），
  评论/私信的真实待办处理与人工回复搬到全局监控新增的「待办处理」区（与回复记录同一页）；
  账号页不再提供第二套执行入口。
- **打包安装期准备内核运行时**：`build/installer.nsh` 在安装阶段解压 kernel-runtime.zip
  （417MB / 约 23 万个文件），首次启动直接命中 `runtime\bin-desktop.mjs`。
  此前自定义 NSIS 钩子文件名不被 electron-builder 识别（只认默认 installer.nsh），
  解压全部压到首次启动，低配机械盘上启动页要等十几分钟。
- **随包引擎裁剪开发期浏览器 profile**：`build-engine-portable.ps1` 排除
  cookies / logs / db（实测 cookies 一项 860MB / 6431 个文件；robocopy 的 /XD 对裸目录名不生效，
  已改为复制后按名字显式删除），安装包与安装占用同步下降约 860MB。
- **设置 → 自定义大模型 支持多服务 / 多模型，并按「列表 + 编辑」重排版式**：
  此前整页只有一张表单、只能配一个提供方，换一个模型就要把原来的覆盖掉。现在：
  上面是「我的模型服务」列表（每个服务显示名称 / 接口 / 当前模型 / 模型数量与状态徽标，
  可「添加模型服务」「设为当前」「删除」两步确认），下面是选中服务的编辑区
  （接口地址 / 你的 API Key / 你的模型名称 + 自动获取可用模型 + 模型标签）；
  一个服务可保存多个模型，点标签即切换当前对话模型，保存后立即生效、无需重启；
  图片 / 视频模型收进「图片与视频模型（选填）」分组；Agnes 领取入口收成编辑区内一行提示。
  0.2.31 版式与文案基线不变（门禁 DESIGN_0231 5/5 PASS）。
- **前端设计回到 0.2.31 参考基线**：设置 → 自定义大模型 不再使用 DSH 的模型模块版式
  （提供方卡片 / 「添加提供方」/ 模型目录），恢复 0.2.31 的「AI 模型服务」版式——
  状态徽标 + 说明，单张「使用你自己的 AI 钥匙」卡片（三步引导 → Agnes 领取入口 →
  API 接口地址 / 你的 API Key / 你的模型名称 + 自动获取可用模型 → 图片模型 / 视频模型（选填）→
  清除 / 保存并使用我的钥匙），卡片底部钥匙安全说明，页面底部两条常见问题。
  删除 `tabs/llm-models/` 三份 DSH 样式表（`ModelsSection.module.css` / `tokens.css` / `polish.css`）。
- **设置模块视觉打磨**：标题图标块 + 带图标的状态徽标；字段提示与占位文案统一；
  API Key 支持显隐；选填模型分组改为可折叠卡片（含「已配置」标签与展开箭头）；
  操作行加分隔线；错误 / 成功改为内联提示条；设置页签选中态改为品牌色底 + 悬停反馈。
- **内容创作平台与「添加频道」平台对齐**：新增 `CHANNEL_PLATFORMS`（小红书 / 抖音）
  作为唯一平台白名单，`useTaskPlatforms()`、频道管理侧栏、连接频道列表共用它。
  内容创作的目标平台不再出现「引擎有定义但没接通授权」的平台；已连接账号的平台排在前面。
  取代 0.2.39 的「只列出已连接账号的平台」。

### Fixed

- **启动不再把浏览器里的模型配置副本整份回灌服务端**：此前每次启动都 `PUT ai/user-llm`，
  一次局部同步就会冲掉设置页配好的多服务配置（DEF-028）；每次 AI 请求还额外带上这份副本，
  服务端于是两套配置相争。现在服务端 `llm-user.json` 是唯一权威：启动只在服务端**还没有任何配置**时
  迁移一次（读服务端返回的信封 `data.providers`，并在失败时什么都不做），请求不再带 `llm`；
  浏览器副本只剩"回填密钥输入框"这一个用途。
- **内容创作按刷新不再回到首页**：`buildPlanUrl` 改写地址时只写 `pathname?query`，把当前 hash 路由整段丢掉，
  于是刷新（或重开窗口）后落回首页、用户得重新点一遍。现在改写 URL 时原样带上当前 hash（DEF-027）。
- **数据中心「已更新 N/M 条作品数据」不再把全 0 占位算作已更新**：此前只要作品对上了 `workId` 就计入，
  平台本次只回了 0（占位、没采到真值）的那些也被算成"已更新"，用户看到的是 15/15 而其实只有 12 条有真值。
  现在 `updatedCount` 只算含至少一个非 0 指标的作品，另有 `zeroOnlyCount` 如实报出占位数，
  页面文案同步为「已更新 12/15 条作品数据（另有 3 条平台本次只回了 0，未采到真值）」（DEF-020）。
- **任务评分读接口不再多包一层 `data.data`**：`GET /agent/tasks/:id/rating` 现在在 `data` 里直接回
  `rating`/`comment`，并对不存在的任务如实回 `18100 task not found`（此前静默回 null）（DEF-018）。
- **全局监控的两个按钮不再难以分辨，也不再「静默无效」**：此前「刷新」与「立即轮询」用同一个图标紧挨着；
  引擎正在跑一轮时点「立即轮询」，服务端直接早退、接口照样回 `code 0`，页面没有任何提示——看起来就是点了没用。
  现在：刷新改为「刷新数据」（只重读状态/账号/回复，不碰平台）；「立即轮询」换成闪电图标，
  触发接口如实回报 `triggered`，进行中再点会明确说「接待引擎正在跑这一轮，无需重复触发」；
  触发成功后页面自动盯盘，本轮跑完（真实采集 40~90 秒）自动刷新数据并提示「本轮轮询已完成，结果已刷新」。
- **内容创作不再被临时素材组顶成空组**：默认素材组此前既没有排序也没有标记，而新建素材组会被插到队首、
  前端在没有有效选中项时又默认取列表第一项——任何后建的组（实测：验收脚本建的「持久化素材组」）
  都会让用户打开内容创作时看到「该分组暂无媒体资源」，增删改查（含批量删除）全部无从下手。
  现在默认素材组恒排第一并在列表里带 `isDefault`，前端优先落到它；`qa/smoke-all.mjs` 自建的临时组
  跑完即清理，不再往真实数据根里留痕。
- **「停止生成」在收尾阶段不再被覆盖回「已完成」**：正文流完、封面/发布动作卡还在生成时点停止，
  此前 `abort` 先把任务落库为 `aborted`，收尾代码又拿生成开始时的状态快照把终态写回 `completed`
  （DEF-001 同族，窄窗可复现：实测停止后立刻读是 `aborted`，几百毫秒后变 `completed` 并挂上「去发布」动作卡）。
  现在正文、动作卡与终态一律以当下的控制位为准：停止后落库为 `aborted`、正文如实标注
  「（已中断，以上为已生成的部分。）」、不再给出动作卡。
- **`abort` 接口如实回报这次停止有没有落到生成中**：返回 `data.interrupted`；生成已经跑完时回 `false`，
  调用方（含验收脚本）据此区分「真的中断了」和「停晚了」，不用靠猜。门禁的中断断言同步改用这个字段判定，
  并补上「收尾阶段停止不被覆盖」三项回归（DEF-023 的时序假红一并消除）。
- **播放量不再被说成「平台未提供」**：同批 15 条作品 09-02 有真实播放量（13016/10329/…），09-10 全 0——
  平台本次 `work_list` 返回的 `play_count` 就是 0，服务端却用「全 0」倒推平台未提供。新增
  `metricAvailabilityReason`（`available` / `not-collected-this-sync` / `no-signal`），页面按语义提示
  「本次未采到…可重新同步，不做估算」或「平台本次未返回，也没有其它互动指标可对照」。自检 A17 同步重写为可判红的断言。
- **账号数据不再「看着刷新了其实没有」**：`GET .../analytics` 改纯读（此前每次读取都改写 `lastStatsTime` 并触发采集，
  造成「假新鲜度」）；新增 `POST .../analytics/refresh` 作为真实采集触发口，能同步判定的失败一律 `code 50000` 回真原因
  （如「视频号账号数据采集尚未接入」「抖音账号 Cookie 格式损坏，请重新扫码登录」，旧代码这里是 `code 0` 且异常被 `.catch(()=>{})` 吞掉）；
  只有真实采集成功才推进 `lastStatsTime`，并新增 `lastStatsAttemptTime` / `lastStatsError` 落痕。前端不再按 `code===0` 判成功：
  completed / started / in_flight / throttled 分别如实提示。
- **智能体任务接口不再对不存在的任务静默成功**：`abort` / `rating` 与 `share` 同规则返回 `18100 task not found`（此前回 `code 0`，调用方无法区分「已中断」与「什么都没发生」）。
- **落盘编码损坏修复 12 处并加防复发断言**：根因是**测试工具**（会话内 PowerShell 5.1 的 `Invoke-WebRequest -Body <字符串>` 以 ASCII 编码请求体，中文全变 `?`），
  不是产品写入端缺陷；数据按会话日志证据还原（非占位文案），并在 A12/A13/L2-C3/L4-2 四处中文往返断言加 `assertNoAsciiFallback`，回读出现连续 `?` 即判红。
- **低配屏幕窗口被裁**：窗口初始尺寸改为按系统可用工作区夹取（最小 1024×640），
  1366×768 或 125% 缩放的笔记本不再把底部按钮挤出屏幕。
- **老显卡白屏无出路**：新增 `BF_DISABLE_GPU=1` 显式退回软件渲染，并记录 GPU 进程崩溃原因。
- **启动即拉起 Python 守护与一个完整 Chrome**：改为默认懒加载（`BF_WARM_ENGINE=1` 才预热），
  降低低配机器的启动峰值内存与 CPU。
- **没装 Chrome 的机器整条链路不可用**：引擎在 `LOCAL_CHROME_PATH` 不存在时回退随包 Chromium
  （worker.py 三处 + interactions.py 一处统一判断），不再把 executable_path 指向不存在的文件。
- **多模型配置会被一次局部同步冲掉**（实测复现）：应用每次启动都会把浏览器本地那份单配置
  PUT 回服务端，旧逻辑直接重写 `llm-user.json`，把 `providers[]` / `activeProviderId`
  整段丢掉——设置页里配的第二个服务下次启动就消失。现在服务端把这类单配置提交当作
  「更新当前生效服务」合并进列表（其余服务原样保留），模型列表也按当前模型重排；
  提供方列表为空时按 baseUrl 匹配顶层镜像补回该服务的密钥，旧数据升级不必重填钥匙。
- **填完模型名点保存没反应**（本轮实测命中）：模型名输入框失焦会重排页面，
  把「保存并使用我的钥匙」按钮顶走，落点落空。模型标签改为随输入实时派生，
  不再有失焦重排，一次点击即可保存。
- **桌面端启动页可能永远停住（用户实测截图）**：另一个实例（或开发版）已占用 31280 时，
  新实例的内核必然 `listen EADDRINUSE`，旧逻辑在握手失败后不再尝试加载产品页，
  用户只能看到"启动时间较长…"的启动页。现在：
  启动前先探测产品页是否已在服务，已服务则**直接接入既有实例**不再起内核；
  握手失败也仍然尝试加载产品页；两条路都失败时启动页显示真实原因，并给出「重试启动 / 完全退出」。
- **桌面壳回退到 0.2.31 的完整能力**（此前源码里的 main.cjs 是精简重写，丢了这些）：
  托盘菜单（打开窗口 / 完全退出）、退出时清理整棵后代进程树、错误信息脱敏、
  快捷方式图标校正、随包 ffmpeg 路径、开发态引擎路径。
  同时保留按版本分目录的内核运行时（`kernel-runtime-<版本>`，升级必然换新运行时）
  与随包引擎 `pyvenv.cfg` 自动改写。
- **发布失败提示登录失效时，账号随即标记为"需重新登录"**：此前平台返回
  "抖音登录已失效，请重新扫码登录"只写进发布记录的错误行，账号页仍显示"在线"，
  用户要翻记录才知道该重扫。现在与平台同步路径共用 `loginState`/`loginNote` 字段，
  失败原因命中登录失效特征词时账号立即显示需要重新授权。
- **账号登录失效在界面上可见**：`loginState=invalid` 时，账号页徽标显示「需重新登录」（含平台返回的原因）
  并保留「重新授权」入口，频道管理行同样显示；此前该字段只有服务端在写、界面完全不读，
  账号"看着在线、发不出去"。
- **删除账号前自动留快照**：`DELETE v2/channels/accounts/:id` 会级联清掉该账号的发布记录与统计，
  现在删除前先把 `accounts.json` / 发布记录 / 统计 / 分组复制到
  `backups/pre-delete-account-<时间戳>/`；账号库被写成空数组时另在
  `account-save-diag.log` 记录调用栈，便于追溯误删。
- **32 位 Windows 给出明确提示**：`process.arch === 'ia32'` 时直接弹窗说明"需要 64 位 Windows"，
  不再让用户对着启动页干等；README 增加「运行环境」章节写明 64 位要求。
- **删除分组会误删默认分组、目标分组反而留下**（全链路自检实测命中）：前端 `http.delete`
  把参数放在 JSON 体（`{ids:[...]}`），服务端 `DELETE v2/channels/account-groups` 只读查询串，
  `ids` 为空时过滤条件退化成"保留全部非默认分组"——于是默认分组被删掉、被删分组仍在，
  账号 `groupId` 指向已不存在的分组成为孤儿。现在两种来源都读、`ids` 为空一律不删、
  默认分组永不删除，并把被删分组里的账号回落到默认分组。
- **服务端 `tsc -b` 编译失败**（`api.ts:500` `noUncheckedIndexedAccess` 下的数组下标未收窄），
  导致 `pnpm --filter @deepseek-ai/dsh-bosom-friend-server build` 直接失败、改动无法落到 lib；
  已改为先取局部变量再判空。
- **「清除」把内核模型路由一并清空**：提交空 `providers[]`，服务端除清空
  `llm-user.json` 外还会把 `settings.yaml` 的 `llm-pi-ai.providers` 写成 `{}`
  并移除本产品的密钥引用（此前单配置清除路径不写内核文档，留下失效路由）。
- 保存仍提交 `providers[] + activeProviderId`：当前生效提供方取表单内容，
  其它已保存的提供方原样回传（密钥留空由服务端按 id 保留），因此从 DSH 版式切回单表单
  不会丢配置；保存后照旧立刻用 `/models` 探活一次。

### Removed

- **「接待记录」整条死链路**：`GET/DELETE v2/customer-reception/logs`、
  `POST v2/customer-reception/handle`、`reception-logs.json` 与账号页页签一并删除。
  唯一写入方 handle 没有任何调用方，页签恒为空；真实接待结果一直由
  `reception-replies.json`（全局监控按客户收纳）承载。
- **两个把依赖路径写死的验收脚本**：`qa/acceptance/verify-batch-delete.mjs` 与
  `verify-dashboard-metric-honesty.mjs` 直接 `import` `node_modules/.pnpm/playwright-core@1.61.1/...`，
  依赖树一变就 `MODULE_NOT_FOUND`（门禁连红两轮）。覆盖按层重新落位——批量删除语义与指标口径进
  `server/test/functional/`，页面可见性进 `qa/e2e/specs/{content-crud,dashboard-honesty}.spec.ts`；
  脚本与门禁里对应的两条检查项一并删除。

### Added

- **自检加强：未配置大模型不再假绿**。C1 / L2-C1 / L3-C / L4-4 四处守卫补上
  「还没有配置大模型 API」「未接入任何大模型」等固定提示文案——此前这些项会把
  “请先配置大模型”的提示当成真实回复而判 PASS。
- **备份轮转失败不再弄死启动**：`security.ts` 的轮转此前是无保护的 `rmSync`——外部安全守卫拦批量删除、
  杀软占用或目录被锁时异常会一路冒到插件 `apply()`，启动直接失败（契约却写着"失败只记录不阻断"）。
  现在删不掉就**保留那一份**并在 `security.json` 里如实记 `backupPruned` / `backupPruneError`；
  用真实目录占用注入写进功能测试，负向对照下会复现 `EPERM ... backups\<ts>`。
- **服务端功能测试（vitest，进程内驱动真实路由表）**：`server/vitest.config.ts` + `server/test/functional/`，
  用导出的 `buildRoutes`/`matchRoute` 直接跑真实路由——不起 HTTP、不起内核、不开浏览器，
  覆盖评分接口契约（DEF-018）、统计口径（DEF-020）、素材/草稿批量删除语义、上传票据三种寻址、
  接待引擎 `triggered` 回报、路由表不变量（重复注册 / 路径形态 / kind 必填）。
  当前 4 个文件 23 个用例、约 1.3 秒，带 v8 覆盖率（HTML 落 `server/coverage/`；现状约 14% 语句覆盖，
  缺口集中在 `platform-login` / `platform-sync` / `reception-replies` / `routes-channels`）；
  已接入门禁检查项「服务端功能测试」。
- **断点调试工具链**：`.vscode/launch.json` 五套配置（功能测试全部 / 当前文件 / watch、E2E 有头、
  E2E Playwright Inspector）——断点直接停在 `server/src/*.ts` 源码上（vitest 经 sourcemap 映射），
  E2E 失败用 `npx playwright show-trace test-results\<用例>\trace.zip` 逐步回放；
  `qa/e2e` 增加 `test:ui` / `test:debug` / `trace` 脚本；写法定在《功能测试与Debug手册》。
- **重复代码分析（jscpd，产品范围）**：`qa/jscpd.product.json` + 一条命令产出
  `qa/reports/duplication/jscpd-report.json`——首次全量扫描 665 文件 / 72 处克隆 / 1437 行重复（1.14%），
  其中跨文件克隆 37 处（频道列表三处同构、日期选择器两套、发布参数两处、桌面/移动发布内容等），
  作为"功能去重"的下一批候选清单。
- `qa/e2e/`：**Playwright Test 端到端套件**（三大核心 CRUD + 关键不变量：内容创作素材组增改删与批量删除、
  AI 智能体任务增删改查、全局监控刷新/立即轮询语义、刷新不丢路由）。靶子自建自删、失败留 trace 与截图，
  已接入门禁检查项「专业 E2E 套件」（`6 passed`）。
- `qa/acceptance/verify-abort-timing-matrix.mjs`：**中断时序矩阵**。修一个时间窗不够——把「停止生成」
  从「刚登记 / 首个增量 / 正文停顿 300ms / 收尾窗口 450ms / 生成已结束」五个时间点各停一次，
  每点固定三条不变量：终态落定后不得再翻转（高频轮询状态序列，任何覆盖都会留下 `aborted → completed` 痕迹）、
  `interrupted=true` 必须落 `aborted` 且不挂动作卡、`interrupted=false`（停晚了）必须如实落 `completed` 且不谎称已中断。
  已接入门禁；旧写法下第 3 个时间点必判红（实测 `状态序列=aborted → completed`，checks=24 pass=20 fail=4）。
- `qa/acceptance/verify-multi-model.mjs`：多服务 / 多模型门禁（界面添加 → 保存 → 切换当前 →
  同服务多模型切换 → 删除 → 配置复原），登记进 `TEST_TIERS.json` 的 functional 层。
- `qa/acceptance/verify-design-0231.mjs`：0.2.31 版式回归 + 「内容创作平台 = 添加频道平台」
  对齐检查（只走真实前端页面，附四张截图）；登记进 `TEST_TIERS.json` 的 functional 层。

## [0.2.39] - 2026-09-09

### Changed

- **内容创作的目标平台与「我的频道」对齐**：`useTaskPlatforms()` 改为只列出用户已连接账号的平台
  （引擎支持但未连账号的平台不再出现，避免"选了也发不出去"）；尚未加载账号列表时回退为全部任务平台。
- **只有一个工作组时不再显示方案标签栏**：`PlanTabBar` 在方案数 ≤1 时返回空，
  页面不再出现没有可切换对象的横条。

### Data

- 素材组由 2 个合并为 1 个（`mg-persist` → 名称「默认素材组」），
  `draft-generations.json`(11) / `media.json`(62) / `promotions.json`(11) 中的组引用全部重指，
  合并前已备份到 `~/.bosom-friend/bosom-friend/backups/manual-20260909-before-group-merge`。

## [0.2.38] - 2026-09-09

### Fixed

- **平台图标显示为竖排文字**：`utils/assetPath.ts` 的 `resolveAsset()` 对已带部署基址的
  根绝对路径（Vite 产出的 `/bosom-friend/assets/logo.png`）又拼了一次基址，得到
  `/bosom-friend/bosom-friend/assets/...`，图片加载失败后浏览器渲染 alt 文本（平台名竖排）。
  改为根绝对路径相对站点根解析。实测内容创作页平台选择器 10 个图标全部加载（broken=0），
  胶囊高度 124px → 28px。
- 该缺陷此前不可见：安装版没有平台引擎时平台清单为空，选择器根本不渲染图标；
  0.2.36 随包内置引擎后清单恢复为 11 个平台才暴露出来。

## [0.2.37] - 2026-09-09

### Fixed

- 随包引擎 `pyvenv.cfg` 带 BOM 导致主进程改写 `home` 失败：`build-engine-portable.ps1`
  改为无 BOM 写入，`main.cjs` 正则加 `\uFEFF?` 容错。实测全新安装启动后
  `home` 自动指向 `resources/engine/python-base`，随包 python 3.12.10 可导入 patchright。

## [0.2.36] - 2026-09-09

### Added

- **APP 智能体规则（模型可见系统提示）**：新增 `server/src/agent-rules.ts` 作为单一事实源，
  十节结构（身份与目标 / 最高原则 / 能力边界 / 工具使用规则 / 标准业务流程 / 输出契约 /
  失败与异常处理 / 合规与风控 / 自检清单 / 红线），每次对话随系统提示下发；
  新增 `qa/verify-agent-rules.mjs` 结构门禁。
- **随包内置 Python 平台引擎**：`desktop/build-engine-portable.ps1` 组装 worker.py + .venv +
  social-auto-upload + 便携 Python 3.12 + patchright chromium-1208（19,993 文件 / 1,896.9 MB），
  electron-builder 经 extraResources 复制到 `resources/engine`；主进程注入
  `BF_ENGINE_ROOT` / `BF_ENGINE_VENDOR_ROOT` / `PLAYWRIGHT_BROWSERS_PATH`，
  并改写 `.venv/pyvenv.cfg` 的 home 指向随包 python-base。

### Changed

- **内核工具只读化（12 → 10）**：删除 `bosom_content_save_draft`、`bosom_content_delete_draft`；
  `bosom_content_generate_script` 去掉 `save` 参数与落库分支，只返回文本。
  业务写入一律由前端执行器完成（"必须在前端一步步操作"）。
- 新增 `desktop/rebuild-kernel-and-installer.ps1`：固化"构建 → 同步 lib → 组装引擎 →
  重打 runtime zip → 重建安装包"流程，避免再出现"改了代码但安装包没变"。

## [0.2.35] - 2026-09-09

### Fixed

- **前端长期显示旧版本**：服务端写死 `appVersion: '0.13.9'` → 新增 `resolveAppVersion()`，
  优先 `BOSOM_FRIEND_VERSION`（桌面壳注入 `app.getVersion()`），回退 desktop/package.json；
  `http.ts` 版本为空时不再注入。
- **升级后仍跑旧内核运行时**：解压目录由固定 `kernel-runtime-v3` 改为按版本
  `kernel-runtime-<version>`，升级必然解压新运行时。

## [0.2.34] - 2026-09-09

### Fixed

- **安装版窗口白屏**：打包内前端引用 `/assets/*`，服务器只在 `/bosom-friend/` 下提供前端 →
  用 `base: '/bosom-friend/'` 的 dist 重建。
- **真实发布 100% 失败**：`engine/worker.py` 回读作品列表未解包 `(works, complete)` 元组，
  `max(...)` 对 list 调 `.get()` 抛 `'list' object has no attribute 'get'`。
- **抖音发布动作卡永不出现**：`generateAgentVideo` 等待上限 180s 小于实测出片 4m07s → 改为 360s。

### Verification

- S 级前端监考（一次用户动作 → AI 全自动 → 真实发布 → 自动同步）：
  小红书 `6aa0fce70000000026015874`、抖音 `7683421642705489186`，均 PASS。

## [0.13.9] - 2026-09-03

### Fixed

- 以 0.13.6 稳定版 stage 为基线重新整理全部源码与运行时产物，不沿用旧安装包的半成品状态。
- TypeScript 6 构建配置：移除已弃用 `esModuleInterop=false`/`baseUrl`，路径改用相对 `paths`，前端 typecheck 通过。
- LLM 流式调用：HTTP 错误、网络错误、超时不再被 `Promise.race` 丢弃，失败会返回可读原因。
- 发布成功后的数据回读：Web、插件、桌面三条发布路径都会设置“数据中心自动同步账号”，不再只在桌面 IPC 分支触发。
- 生成记录删除：同步清理对应草稿和素材；从素材库单独删除时保护仍被生成记录引用的媒体，历史记录不会断图/断视频。
- 知识库、热榜/笔记搜索、视频 URL、生成状态三态、设置模型全字段清除、智能体会话截图等 0.13.7/0.13.8 修复全部重新验证并进入本次基线。
- `BrowserControlTab` 使用真实 Ipc 判定（排除网页注入的 shim），浏览器控制不会在 Web 壳误显示为可用。
- 提示词画廊静态资源由 Web 模块合并到 Electron 构建目录，三个示例视频在生产包可访问。
- 产品直接依赖 `sharp` 升级到 `0.35.x`。
- 桌面窗口关闭默认询问是否退出并停止服务，退出时同步清理 Node/Python/Chrome/平台 worker 进程树。
- 后端插件卸载时停止 7×24 接待定时器，并清理登录守护、互动、同步和发布 worker，避免进程残留。

### Security

- 用户大模型 Key 仍不进入普通 JSON 备份轮转；本次重新确认 `security.ts` 的排除逻辑。

### Verification

- `tsc --noEmit`（Electron/Web）PASS。
- `vite build --mode=test` PASS。
- 前端 8 核心页面烟雾检查 PASS，`pageErrors=0`。
- 静态资源 404 审计：`count=0`。
- 数据一致性：`missingFromMedia=0`、`noMediaSuccess=0`、`failedTextSuccess=0`。
- 契约审计：`frontendCalls=87/backendRoutes=158/unmatched=0`。
- 静默安装：退出码 0，安装后服务 HTTP 200，页面版本 `v0.13.9`。

## [Unreleased]

### Added

- 0.2.0 安装包 BosomFriend-Setup-0.2.0.exe（335.9MB，SHA256 7B43060C…）：
  纯正 .exe、官方内核封闭运行时随包、首次启动自动解压；
- 干净室验收（方案二）全流程通过：静默安装→全新数据根启动（页面显示内核已连接）→静默卸载→无残留目录/快捷方式/进程。
- 官方内核工具包 dsh-bosom-friend-kernel（无 UI）+ 并行内核入口 bin-kernel.ts（绞杀式迁移，旧入口不动）；
- 内核握手冒烟（官方 dsh-sdk-client ↔ dsh-sdk-jsonrpc-server）与工具注册冒烟；
- 8 个内核工具：存活探针、平台账号列表、待接待列表、素材列表、数据看板、登录状态汇总、草稿保存、作品汇总（与前端同一份数据，原子落盘）；
- 内核会话端到端冒烟（免真实 Key，官方模拟模型服务器）：客户端→内核→官方适配器→模型→流式回传，回合 completed；
- 真实模型冒烟：用户自己的 Agnes 网关经官方 llm-pi-ai 适配器接入内核，真实回复“真实模型正常”；
- 真实模型驱动内核工具：Agnes 2.5 Flash 实际调用 bosom_kernel_ping 工具并回传结果（全对话自动化的能力底子）；
- 生产适配层：server kernel-client 改用官方 HarnessClient 流式订阅，BYOK 经环境变量传入内核，真实模型冒烟通过；
- 内核补丁层内置 Agnes provider（静态模型目录，无密钥）；
- 桌面主进程内核桥（M2）：主进程经官方 dsh-sdk-client 启动内核、preload 暴露 window.bosomKernel、页面显示内核握手状态；握手冒烟通过；
- 合并双开发线为唯一 0.2.0 主线（M1）：桌面壳/进程生命周期/原子存储并入，单测通过；
- 安装包只读保护、路由黄金基线（155 条）、源码哈希基线（945 文件）。

### Changed

- 门禁“禁止直连模型接口”改为忽略注释行，只统计真实调用（当前 2 处）。
- 适配层 assistantTextOf 按实测线型（assistant/chunk 的 text-delta 块）修正。
- 内核运行时改为编译产物启动（kernel/launcher 提供 build 脚本；lib 为 gitignore 构建产物）。
- 存储层升级：schema 信封 + fsync 原子写 + 旧平铺格式自动迁移；删除生成记录的三处一致过滤抽为纯函数并单测。
- 内核工具数据访问统一到共享产品数据店（与前端/服务端同一实现），不再各自读文件；
- 修复纯 Node 加载 TS 参数属性的兼容问题：数据店直接打进内核产物；初始化握手增加有界重试应对路由注册微时序。
- 内核工具增至 10 个：新增草稿列表、草稿删除（删除时同步清理挂靠的推广与素材，三处一致单测通过）。
- 内核工具增至 11 个：新增 bosom_content_generate_script（经官方 ctx.llm 流式生成，可存草稿；真实模型端到端调用验证 KERNEL_GENERATE_OK）。
- 长任务队列（M5a）：状态机 queued/running/success/failed/cancelled、有界重试、重启恢复，共享数据店持久化；单测 JOB_QUEUE_OK；
- 内核工具增至 12 个：新增 bosom_job_list（智能体可查询任务状态与最近错误）。
- 任务执行器（M5b）：单线程认领→处理器→状态机推进，未注册处理器如实失败；单测 JOB_RUNNER_OK。
- Electron 桌面端到端冒烟通过（M6a）：真实窗口页面显示“已连接 deepseek-harness-sdk-runtime v0.0.1”；
- 内核运行时改用随包 Node（Electron 自带 Node 与 DSH 原生加载器 ABI 不匹配，已定位并绕过）；桌面脚本改为外部文件以符合严格 CSP。

### Security

- 用户模型密钥仅存于本机 .env（已被 .gitignore 忽略），不进入任何提交或仓库文件。

## [0.1.0] - 未发布

### Added

- 工程化流程与可追溯体系规范 v1.0 落地（Phase 0：目录、模板、一键门禁）。
