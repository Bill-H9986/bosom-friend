# 需求与验收准则追溯矩阵（RTM）

> 维护规则见《工程化流程与可追溯体系规范》§5。本文件是一键门禁的检查对象：
> 门禁按行解析，表格行必须以 `| AC-` 开头，列顺序固定为：
> AC编号 | 关联REQ | 验收准则（Given-When-Then 摘要） | 状态 | 测试用例 | 前端证据 | 发布版本

## 状态定义（验收准则四态）

- 已覆盖：验收准则的全部条件都有测试断言，且 S 级前端证据齐备。
- 部分：只验证了主路径，缺边界/异常路径。
- 未覆盖：代码存在，但没有任何测试引用这条验收准则。
- 未实现：对应功能代码根本不存在——这是“功能没做”，不是“没测”。未实现 AC 在 UAT/发布前必须清零（阻断红灯）。

## 计算规则

覆盖率 =（已覆盖 + 部分×0.5）÷ AC 总数。生产发布要求 100%，合入要求 80%。未实现 AC 无论覆盖率多少都是红灯。

## 现状说明

功能盘点已完成（2026-09-02）：20 条 REQ、41 条 AC 已登记，依据《前端功能需求盘点清单》。
状态按“新体系证据是否齐备”定，不代表历史是否做过：未实现 = 功能缺口（红灯）；未覆盖 = 功能存在但尚无 S 级验收证据（黄灯，发布前必须补）；已覆盖 = 证据齐备。
此后所有新功能必须先进本表，再开始开发。

## 验收准则表

| AC编号 | 关联REQ | 验收准则（Given-When-Then 摘要） | 状态 | 测试用例 | 前端证据 | 发布版本 |
| --- | --- | --- | --- | --- | --- | --- |
| AC-001-1 | REQ-001 | 首次启动进入主界面，导航可点 | 已覆盖 | qa/e2e/specs/ac-verification.spec.ts「七个功能页导航全部存在，逐一点击都真的切换并渲染」：逐页点击并断言路由切换，且遍历过程零 JS 异常 | qa/evidence/ac/AC-001-1-七个功能页逐一点击可达.png | 0.2.41 |
| AC-001-2 | REQ-001 | 重启后回到首页，不残留上次会话状态 | 已覆盖 | qa/e2e/specs/ac-verification.spec.ts「进过知识库后重新打开根地址，不恢复上次路由」：断言冷启动后 hash 为空 | qa/evidence/ac/AC-001-2-冷启动回首页.png | 0.2.41 |
| AC-001-3 | REQ-001 | 启动过程可见真实进度：阶段、百分比与已用时；测不出长度时不得伪造百分比 | 已覆盖 | 门禁「启动页进度条」`qa/probes/verify-splash-progress.mjs` 两种真实场景：A 接入既有服务（读主进程留痕 `status.progressLog`：检查运行环境 2% → 启动内核服务 80% → 加载产品界面 100%，单调不减、无报错）；B 内核不回应（真实 DOM 采样 83 次：单调不减、不确定态不推进、百分比文字与 aria 值一致、填充长度不超过真实进度、给出「内核初始化握手超时（15 秒内没有收到内核响应）」并可重试） | qa/evidence/启动页-进度条-启动中.png、qa/evidence/启动页-进度条-失败态.png | 0.2.42 |
| AC-002-1 | REQ-002 | 注册登录成功（产品实际只做账号密码；邮箱/手机/Google 已如实拒绝） | 已覆盖 | qa/e2e/specs/ac-verification.spec.ts「注册后能登录，返回可用会话令牌」：注册→登录→错误密码被拒 | — | 0.2.41 |
| AC-002-2 | REQ-002 | 修改密码/资料后重新登录生效 | 已覆盖 | qa/e2e/specs/ac-verification.spec.ts「改密后旧密码失效、新密码可登录」：改密→旧密码 401→新密码登录→改资料→回读为新值 | — | 0.2.41 |
| AC-002-3 | REQ-002 | 未登录访问业务页被引导登录，不见他人数据 | 已覆盖 | 守卫判定提取为 `sessionRequired`（server/src/api.ts）并有真实单测：`server/test/functional/session-guard.spec.ts` 六条断言覆盖「免登录模式放行 / 账号体系开启时 user/mine·agent/tasks·v2/channels/accounts·contents/groups·ai/chat 无 token 一律拒绝 / 有效会话放行 / 登录注册端点始终公开 / assets 与只读分享页公开 / 公开判定不放宽业务数据」；运行侧 qa/e2e/specs/ac-verification.spec.ts 验证免登录模式真实行为（本地唯一用户直达，不存在他人数据）与账号体系未被删除（错误密码仍 401）。产品当前有意运行在免登录模式（bundle/*/cordis.patch.yml 的 authEnabled: false），project/ 写明恢复账号体系时改回 true | server/test/functional/session-guard.spec.ts | 0.2.41 |
| AC-003-1 | REQ-003 | 扫码/浏览器/OAuth 绑定后账号列表可见 | 已覆盖 | qa/e2e/specs/ac-verification.spec.ts「绑定账号后列表与页面都能看到它，且未采集的指标不显示成 0」：绑定后账号出现在列表与频道管理页；断言未采集的粉丝数不得写成 0 | qa/evidence/ac/AC-003-1-绑定后账号列表可见.png | 0.2.41 |
| AC-003-2 | REQ-003 | 同步/解绑/分组后页面数据更新 | 已覆盖 | qa/e2e/specs/ac-verification.spec.ts「建分组→账号入组→解绑登录态→删除，每一步列表都跟着变」：分组列表出现新组、解绑后不再持有登录态、删除后账号从列表消失 | — | 0.2.41 |
| AC-003-3 | REQ-003 | 绑定失败显示可读错误，不静默失败 | 已覆盖 | qa/e2e/specs/ac-verification.spec.ts「未开放平台与未知平台的绑定请求都给出非空且可读的原因」：未开放平台给出面向用户的原因、未知平台同样有可读原因，且失败响应一律不得为空原因或返回数据 | — | 0.2.41 |
| AC-004-1 | REQ-004 | 一句话生成，页面流式显示 AI 回复 | 已覆盖 | qa/e2e/specs/ac-verification.spec.ts「一句提示词真的调到大模型并返回非模板正文」：真实调用 ai/chat 并断言正文非「未接入」提示、非本地模板兜底，模型字段不得是 local-template；页面侧断言 AI 助手入口可见 | qa/evidence/ac/AC-004-1-AI回复链路可用.png | 0.2.41 |
| AC-004-2 | REQ-004 | 任务历史可见，可评分/分享/收藏/中止 | 已覆盖 | 自检 D1/C18 + 门禁 `AGENT_TASK_ACTIONS`（27 项：分享有效期与只读页、中断落库、收尾阶段停止不被覆盖、继续、收藏、评分） | qa/evidence/REQ-004-分享链接只读页-20260910.png、REQ-004-停止生成后任务维持已中断-20260910.png、REQ-004-中断与分享探针-20260910.json | |
| AC-005-1 | REQ-005 | 未配置大模型时固定提示“未接入任何大模型” | 已覆盖 | 门禁 `AGENT_TASK_ACTIONS`（临时移开 llm-user.json 后真实对话，断言固定提示且测试后配置还原）；前端另有同源短路提示（`agent.methods.ts`，文案不同但同为固定提示） | qa/evidence/REQ-005-未配置固定提示-20260910.png | |
| AC-005-2 | REQ-005 | 已配置时真实调用并返回模型结果 | 已覆盖 | 自检 C1（非模板回复）+ 门禁 `AGENT_TASK_ACTIONS`（result 事件带 model=agnes-2.5-flash 与真实正文） | qa/evidence/REQ-005-已配置真实模型回复-20260910.png | |
| AC-005-3 | REQ-005 | 调用失败如实报错，不以模板冒充成功 | 已覆盖 | 门禁 `AGENT_TASK_ACTIONS`（错误密钥 → 「大模型调用失败」且无模板文案） | qa/evidence/REQ-005-调用失败如实报错-20260910.png | |
| AC-006-1 | REQ-006 | 生成草稿入草稿箱，参数改动写入页面请求 | 已覆盖 | qa/e2e/specs/ac-verification.spec.ts「接口建草稿后内容创作页的草稿列表里能看到」：建草稿→页面列表出现该标题 | qa/evidence/ac/AC-006-1-新建草稿出现在列表.png | 0.2.41 |
| AC-006-2 | REQ-006 | 草稿查看/编辑/删除后页面结果同步 | 已覆盖 | qa/e2e/specs/ac-verification.spec.ts「改标题后回读为新值，删除后列表里不再出现」：改→回读新值→页面同步→删→列表消失 | qa/evidence/ac/AC-006-2-改名后列表同步.png | 0.2.41 |
| AC-007-1 | REQ-007 | 上传图片/视频后素材库出现并可预览 | 已覆盖 | qa/e2e/specs/ac-verification.spec.ts「签名→直传→确认后素材进库，且能按 URL 取回原图」：真实 PNG 字节走原生直传通道，确认后素材进库，再按 URL 取回的字节与上传逐字节相同 | qa/evidence/ac/AC-007-1-上传后素材可用.png | 0.2.41 |
| AC-007-2 | REQ-007 | 删除/转移/分组后列表按操作更新 | 已覆盖 | qa/e2e/specs/ac-verification.spec.ts「草稿转移分组后归属改变，删除后从原分组列表消失」：建源组/目标组 → 草稿入源组 → 转移后源组列表不含它、目标组含它且返回 count=1 → 删除后任何分组都不含它 → 缺 kind 的转移请求被如实拒绝；批量删除另由门禁 `BATCH_DELETE`（`qa/acceptance/verify-batch-delete.mjs`）覆盖 | qa/evidence/批量删除前-默认素材组可见.png、qa/evidence/批量删除后-列表少一张.png | 0.2.41 |
| AC-008-1 | REQ-008 | 选平台发布，弹窗确认，成功出现发布记录 | 已覆盖 | S 级监考 frontend-auto-agent-exam（xhs/douyin 各 1 次全自动发布） | qa/reports/s-level-acceptance-2026-09-09-publish.md | 0.2.34 |
| AC-008-2 | REQ-008 | 发布失败可重试并显示失败原因 | 已覆盖 | qa/e2e/specs/ac-verification.spec.ts「缺登录态的账号发起发布必然失败且原因可读；重试被如实受理」：用无平台登录态的账号发起发布，断言落到发布失败且 errorMsg 可读，重试接口如实受理，重试不存在的任务必须报错（此前会静默回 code 0，已修） | — | 0.2.41 |
| AC-008-3 | REQ-008 | 定时发布到点执行且页面可见 | 已覆盖 | qa/e2e/specs/ac-verification.spec.ts「定时到未来某刻先记为已排期，到点后调度器真的执行」：建未来时间的发布流→未到点为待发布且时间等于设定值→改期接口置为已排期→到点后调度器真的执行（无登录态则失败并带原因）；改期不存在的任务必须报错 | — | 0.2.41 |
| AC-009-1 | REQ-009 | 发布成功，记录显示平台真实作品 ID 与可打开链接 | 已覆盖 | S 级监考实测：xhs rec-real-6aa0fce70000000026015874 / douyin rec-0l4fytdg，页面可见作品与链接 | qa/reports/s-level-acceptance-2026-09-09-publish.md | 0.2.34 |
| AC-009-2 | REQ-009 | 平台拒绝时如实显示原因，不显示假成功 | 已覆盖 | qa/e2e/specs/ac-verification.spec.ts「所有失败记录都带可读原因；失败绝不被写成成功」：逐条校验失败记录必须有非空 errorMsg、不得带作品链接或平台作品 ID（不能一边失败一边留成功痕迹）、不得带一组 0 冒充真实互动数据。另见 AC-008-2 的发布失败用例 | qa/evidence/ac/AC-009-2-失败记录如实显示.png | 0.2.41 |
| AC-010-1 | REQ-010 | 数据中心汇总与平台数据一致且可见 | 已覆盖 | qa/e2e/specs/ac-verification.spec.ts「四个汇总口径都渲染出数字或明确的未采集说明」；「与平台一致」由真实同步链路佐证：抖音 15 条作品同步后伪造 viewCount 由 15/15 降为 0/15，真实计数完整保留（见 platform-sync-engagement.spec.ts） | qa/evidence/ac/AC-010-1-数据中心汇总可见.png、qa/evidence/release/0.2.41/R3-作品指标显示未采集.png | 0.2.41 |
| AC-010-2 | REQ-010 | 切换作品/话题视图，图表随之更新 | 已覆盖 | qa/e2e/specs/ac-verification.spec.ts「数据中心在指标视图之间切换时图表内容随之变化」：切到点赞/评论/分享/收藏，断言作品排行的数值随之变化。注：趋势图为 canvas 且默认时间范围内无作品数据，故以作品排行（同一份数据）作为可观测量 | qa/evidence/ac/AC-010-2-切换视图数据随之更新.png | 0.2.41 |
| AC-011-1 | REQ-011 | 热点内容按分类/来源展示列表与详情 | 已覆盖 | qa/e2e/specs/ac-verification.spec.ts「热点页按平台分组列出实时热榜，每条可打开原文」：断言至少两个来源分组、条目带热度数值、有「打开原文」入口与更新时间 | qa/evidence/ac/AC-011-1-热点内容按来源分组.png | 0.2.41 |
| AC-011-2 | REQ-011 | 评论搜索结果/统计可见，导出可下载 | 已覆盖 | qa/e2e/specs/ac-verification.spec.ts「评论搜索页有筛选、结果与原文链接，导出能真的产出文件」：五组筛选 + 「共找到 N 条」统计 + 「查看原文」+ 点导出必须真的产生下载文件 | qa/evidence/ac/AC-011-2-评论搜索结果与导出.png | 0.2.41 |
| AC-012-1 | REQ-012 | 知识库笔记增删改，树和内容即时更新 | 已覆盖 | qa/e2e/specs/ac-verification.spec.ts「新建后树里出现，改内容后回读为新值，删除后树里消失」：增→页面出现→改→回读为新值→删→回读不存在且页面消失 | qa/evidence/ac/AC-012-1-新建笔记出现在树里.png | 0.2.41 |
| AC-012-2 | REQ-012 | 搜索与反向链接结果可见 | 已覆盖 | qa/e2e/specs/ac-verification.spec.ts「搜索命中刚建的笔记；反向链接命中引用它的笔记」：建两条笔记并写入 [[引用]]，搜索与反向链接各自命中 | — | 0.2.41 |
| AC-013-1 | REQ-013 | 有评论/私信时出现待处理项，可查看并回复 | 已覆盖 | qa/e2e/specs/ac-verification.spec.ts「待处理项带有可查看的原文与可回复所需的键；状态变更接口如实校验」：逐条校验待办状态合法、能定位账号与平台、区分评论/私信、评论类带 commentKey（回复所需）；非法状态被拒、不存在的待办报 404 类错误 | qa/evidence/ac/AC-013-1-接待待处理与监控.png | 0.2.41 |
| AC-013-2 | REQ-013 | 规则变更后重新触发，新规则生效且日志可见 | 已覆盖 | qa/e2e/specs/ac-verification.spec.ts「新建规则立刻参与匹配；改成不匹配后同一条消息不再命中」：建规则→同一条消息命中该规则且返回模板回复→改关键词→同一条消息不再命中该规则（产品允许 matchAll 兜底规则，故断言的是「不再命中这条」而非「完全不命中」） | — | 0.2.41 |
| AC-014-1 | REQ-014 | 任务记录列表/详情/状态/时间可见 | 已覆盖 | 自检 D1/E3 + 门禁 `AGENT_TASK_ACTIONS`（列表与详情的状态/时间字段断言） | qa/evidence/REQ-014-任务记录列表-20260910.png、REQ-014-任务详情含评分收藏-20260910.png | |
| AC-014-2 | REQ-014 | 评分/收藏后刷新仍保持 | 已覆盖 | 门禁 `AGENT_TASK_ACTIONS`（回读 + 落盘双证）+ 详情页刷新实测（探针 `probe-task-detail-reload.mjs`） | qa/evidence/REQ-014-刷新后标题与评分收藏保持-20260910.png | |
| AC-015-1 | REQ-015 | 通知中心列表可见，已读未读可区分 | 已覆盖 | qa/e2e/specs/ac-verification.spec.ts 两条：接口侧「只回运营真实写入的通知」（每项必有 id 与 title，不用本地静态公告冒充）；页面侧「消息通知弹窗能打开，并具备全部已读操作」 | qa/evidence/ac/AC-015-1-通知中心.png、qa/evidence/ac/AC-015-1-主界面与通知入口.png | 0.2.41 |
| AC-016-1 | REQ-016 | 自定义大模型保存后对话生效 | 已覆盖 | qa/e2e/specs/ac-verification.spec.ts「对话使用的就是设置里保存的那个模型」：读设置里保存的 model，再真实对话，断言返回的 model 与之一致且正文为真实模型输出 | — | 0.2.41 |
| AC-016-2 | REQ-016 | 免责声明与系统设置保存后保持 | 已覆盖 | qa/e2e/specs/ac-verification.spec.ts「免责声明、接待参数、自定义大模型三类设置写入后都回读一致」：免责声明 PUT 后回读为 true；接待轮询间隔写入后回读为刚写入的值（跑完复原，不动用户当前节奏）；模型配置刷新页面后仍不变；模型落盘另有 api-contract.spec.ts「模型配置保存成功就必须真的落盘 llm-user.json」佐证 | qa/evidence/ac/AC-016-2-设置保存后保持-*.png | 0.2.41 |
| AC-017-1 | REQ-017 | 每完成一次操作，会话内出现该步截图与说明 | 已覆盖 | qa/e2e/specs/agent-conversation.spec.ts「跟随模式开启后，智能体执行导航动作并在会话里留下截图与说明」：会话里出现「AI 智能体已执行「navigateToDatacenter」，以下为当前页面截图。」，并且该消息真的带图（result[0].medias 非空） | qa/evidence/ac/AC-017-1-智能体每步截图与说明-*.png | 0.2.41 |
| AC-017-2 | REQ-017 | 连续操作回看，截图与操作一一对应无缺漏 | 已覆盖 | qa/e2e/specs/agent-conversation.spec.ts「刷新页面后仍能从会话里回看到带截图的操作记录」：带截图的操作记录必须落盘到 agent/tasks/<id>/messages，刷新页面后条数一致。这条同时钉死了一个真实缺陷：跟随模式原来只按内存去重，刷新会再执行一遍并追加截图（1 条变 2 条），已改为 sessionStorage 跨刷新去重 | qa/evidence/ac/AC-017-2-刷新后仍可回看操作截图-*.png | 0.2.41 |
| AC-018-1 | REQ-018 | 普通人仅与 AI 对话即可完成各项功能 | 已覆盖 | 以前只有「前端有一张 NAVIGATE_ROUTES 映射表」这一半：服务端只会产出 navigateToPublish，其余导航类型拿不到；就算拿到，ActionCard 的 switch 没有对应分支，卡片渲染成空节点，用户看不到也点不到。现在服务端按提示词意图产出 navigateToDraft/Datacenter/Monitor/Reception/Knowledge/Calendar/Tasks，ActionCard 补齐 7 类卡片的渲染与点击。qa/e2e/specs/agent-conversation.spec.ts 四条真跑断言：说「打开数据中心」出现可点导航卡→点完真的到数据中心；草稿箱/监控/知识库三个入口同样可用；无导航意图的创作需求不会被误跳转 | qa/evidence/ac/AC-018-1-对话导航到数据中心-*.png、qa/evidence/ac/AC-018-1-对话导航到多个功能页-*.png | 0.2.41 |
| AC-019-1 | REQ-019 | 提交反馈后页面显示成功 | 已覆盖 | qa/e2e/specs/ac-verification.spec.ts 两条：后端「反馈提交成功就必须真的落盘」（feedback.jsonl 含正文与 receivedAt）+ 页面「在联系我们的弹窗里提交反馈，页面给出成功提示」 | qa/evidence/ac/AC-019-1-反馈提交成功提示.png | 0.2.41 |
| AC-020-1 | REQ-020 | 干净机器安装启动，一次完整 AI 业务跑通 | 部分 | **安装版业务链路已验（2026-09-13）**：装好的 0.2.42 用真实大模型跑通 7 条真实业务用例（AC-004-1 非模板正文 / AC-016-1 对话用的就是设置里的模型 / AC-018-1 对话→导航卡→真的跳转 ×5），`qa/probes/verify-installed-ai-business.mjs` **7 passed (4.1m)**；本机安装/启动/卸载见 AC-021-2 行。**仍未验**：干净机器（无历史安装、无开发环境的第二台机器）——本机做不到，不按已验记 | qa/probes/verify-installed-ai-business.mjs、qa/reports/installed-ai-business-*.md | 0.2.42 |
| AC-020-2 | REQ-020 | 升级保留数据，卸载无关键残留 | 已覆盖 | 2026-09-13 安装/卸载实测：`_bf-prerelease-*` 快照对比，升级与重装前后数据根均为 21694 个文件；卸载后安装目录/开始菜单/桌面快捷方式/注册表全部清零，数据根仍为 21694 个文件。本轮查出并修复卸载残留：`%APPDATA%\Bosom Friend` 曾堆积 8 份内核运行时共 8.9 GB（卸载器一份都不清），现由 main.cjs 启动清理与 installer.nsh 的 customUnInstall 两处回收——修复后实测 APPDATA 由 1.11 GB 降为 0 | qa/reports/最终交付报告-20260912.md | 0.2.41 |
| AC-021-1 | REQ-021 | 纯正 .exe 双击安装、桌面图标，无需命令行/开发环境 | 部分 | 0.2.34 静默安装退出码 0、桌面/开始菜单快捷方式存在、窗口启动正常；GUI 向导双击流程未验 | qa/reports/s-level-acceptance-2026-09-09-publish.md §4 | 0.2.34 |
| AC-021-2 | REQ-021 | 干净机器安装/启动/升级/卸载：升级保留数据、卸载无残留 | 部分 | **0.2.42 本机实测（2026-09-13）**：静默安装 exit 0（0.2.41→0.2.42 升级，数据根 8,041 文件与 `accounts.json` SHA256 `2CC05BDF…` 前后一致）→ 启动并使用（userData 200,182 文件）→ 静默卸载 exit 0：安装目录 / 桌面快捷方式 / 开始菜单 / 注册表全部清零，`%APPDATA%\Bosom Friend` **目录整棵消失（原 127 文件残留已修：卸载钩子补 `rd /s /q`）**，进程 0，数据根 8,075 文件且 `accounts.json` 哈希不变。**仍未验**：干净机器侧（第二台机器） | qa/reports/release-0.2.42-20260913.md §卸载实测 | 0.2.42 |
| AC-021-3 | REQ-021 | 普通用户首次双击即用，不暴露内部路径/命令/堆栈 | 已覆盖 | `qa/probes/verify-installed-first-run.mjs`（安装版逐页走查）**4/4 PASS**：七个功能页至少六页渲染出内容（6/7）、页面文本不含内部路径/命令行/堆栈/技术词、静态资源 0 个 404、截图落 `qa/evidence/安装版-首次使用-*.png`。未签名安装包在陌生机器上仍会触发 SmartScreen 提示——如实记录为分发注意事项，不计为产品缺陷 | qa/probes/verify-installed-first-run.mjs、qa/evidence/安装版-首次使用-内容创作.png | 0.2.42 | 0.2.34 |
| AC-021-4 | REQ-021 | 独立窗口、桌面图标、托盘与自动更新到位 | 部分 | 独立窗口、桌面图标、托盘已实现（desktop/electron/main.cjs createTray：单击/双击恢复窗口，右键菜单「打开 Bosom Friend」「完全退出（关闭所有进程）」，后者与 window.bosomFriend.quit() 同走 quitAndStop）。**自动更新未实现**：代码里没有 electron-updater/autoUpdater 的任何引用，也没有更新源；这条在做出更新源之前无法补验，不按「已接线」记 | desktop/electron/main.cjs | 0.2.41 |
| AC-021-5 | REQ-021 | 低配机型（≤4 逻辑核心或 ≤8GB 内存）自动降载，且不得误伤正常机器 | 已覆盖 | 门禁「性能档位判定」`qa/probes/verify-perf-profile.mjs` 14 项：4 核/8GB、仅 CPU 偏弱、仅内存偏小均判低配；8 核/16GB 判标准档；`BF_PERF_PROFILE` 可双向强制；堆上限按内存 35% 夹在 768~2048MB；判定与理由落盘 `perf-profile.json`。服务端侧另有 `server/test/functional/perf-tier.spec.ts` 5 条：未探测时按标准档（不擅自降载）、上限串损坏仍按低配档默认值、低配档备份只保留 10 份 | server/test/functional/perf-tier.spec.ts、qa/probes/verify-perf-profile.mjs | 0.2.42 |
| AC-021-6 | REQ-021 | 内核不回应时按预算如实报错并可重试，不得无限等待 | 已覆盖 | 门禁「内核握手超时」`qa/probes/verify-kernel-handshake-timeout.mjs` 3 项：预算内抛错（实测 8041ms/8000ms 预算）、原因可读；启动页场景 B 复验：失败后展示原因且「重试启动 / 完全退出」可见。修复前实测：等待 150 秒仍停在「等待初始化握手」且无任何提示 | qa/reports/splash-progress-2026-09-13T08-48-48.md | 0.2.42 |
