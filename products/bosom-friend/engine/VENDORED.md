# Vendored: social-auto-upload

- Upstream: https://github.com/dreammis/social-auto-upload
- Commit: `1c66b7db4b30585bbb40c58eb0aa572ffa3cce97` (shallow clone, 2026-08)
- License: MIT (kept in `social-auto-upload/LICENSE`)
- Purpose: Bosom Friend 的平台真实登录/发布引擎。只复用其成熟逻辑，不自己实现平台自动化。

## Used surface

- `myUtils/login.py`：抖音（douyin_cookie_gen）、视频号（get_tencent_cookie）、
  快手（get_ks_cookie）、小红书（xiaohongshu_cookie_gen）的官方页面扫码登录 +
  Playwright storage_state cookie 落盘。
- `myUtils/auth.py`：登录后 cookie 有效性复核（各平台创作者后台访问判定）。
- `utils/base_social_media.py` + `utils/stealth.min.js`：反自动化指纹初始化。
- `uploader/xhs_uploader/main.py`：被 `myUtils/auth.py` 间接引用的签名工具。

## 本地新增（上游没有的模块）

- `uploader/xianyu_uploader/`：闲鱼（goofish.com）适配器，产品自己写、不是上游代码。
  登录走 `passport.goofish.com/mini_login.htm` 的二维码；二维码画在跨域 canvas 上，
  `toDataURL()` 会被浏览器以"画布被污染"拒绝，因此用**元素截图**取 PNG 再转 data URL。
  **只有登录，没有发布**：模块里 `PUBLISH_URL` 是从未被引用的常量，也没有任何
  upload/publish 函数，`sau_cli.py` 同样没有注册 xianyu 子命令。因此闲鱼在产品里
  保持 `coming_soon`、不作为频道开放——登进去也发不出去。
  上游同步时**不要删这个目录**（它是新增文件，不会被上游覆盖）。

## 本地修改（改动上游代码 —— 每次同步上游后必须重新施加）

- **`uploader/douyin_uploader/main.py` · `DouYinNote.upload_note_content()`（2026-10-14）**：
  新品发布页**默认停在「发布视频」页签**，「发布图文」页签要等渲染（约数秒）才出现。
  上一版在 +1 秒就判定"没有入口、跳过切换"，随后把图片塞进**视频输入框**（accept=video/*，
  DOM 层"成功"但页面毫无反应）→ 卡进「等图片上传完成」**无限循环**，直到 17 分钟子进程超时
  （2026-10-14 00:33 现场：`pub-3xfr7ol2` 卡 3 分钟无进展、人工止损）。
  探针实证（`engine/_douyin_upload_probe.py`）：先点「发布图文」页签后，页面同时存在两个
  file input——视频（隐藏）+ 图片（可见，accept 含 image）；对图片输入 set_files 后 URL
  **立即进入** `/creator-micro/content/post/image`。改动：① 先 `wait_for`（20 秒）页签再点击，
  真旧版才跳过；② 上传选择器**只认 `input[accept*='image']`**（含 CDP 兜底）；③ 等进入
  编辑页由 `while True` 改为 **120 × 1 秒有界**，超时留截图并如实失败；④ 点「发布」的重试
  有节流（≥5 秒一次）且总时长 150 秒有界，超时留证据并抛错（旧：0.5 秒连点到子进程超时）。
  **同步上游时若被覆盖**：按上述四点补回，否则抖音图文发布会在上传环节空转。

- **`uploader/xiaohongshu_uploader/main.py` · `_click_and_wait_xhs_publish()`（2026-10-13）**：
  原文判定发布成功只认「匹配到发布接口 POST 且 HTTP 200」，**不读响应体**。小红书 Web 接口在
  风控/校验失败时同样返回 HTTP 200，只把结果写在响应体里（`success:false` / `code≠0`），
  于是「被平台拒发」会被记成「已发布」。**现场证据（2026-10-13 晚）**：引擎日志两次报
  「🥳 图文发布成功，小人开心收工」，22-61 分钟后创作者中心「笔记管理」全部页签（含审核中/未通过）
  仍无这两条笔记的任何痕迹；可见浏览器直查确认账号总作品数没变。
  改动：① 发布接口响应（URL / HTTP 状态 / 响应体前 600 字）落 `xiaohongshu_logger.info`，
  作为事后对质的结构化凭据；② 新增 `XhsPublishRejected` 与 `_xhs_publish_response_verdict()`，
  `success:false` 或 `code≠0` 即抛错终止（穿透内层 `except Exception` 与重试/兜底，避免
  把拒发记成成功，也避免继续点「发布」重复提交）；响应体不可判读时保持旧行为（HTTP 200 通过），
  但响应已落日志。**同步上游时若被覆盖**：把这两段补回，否则小红书「假成功」会复发。

- **`uploader/douyin_uploader/main.py` · `upload_note_content()`（2026-10-13）**：
  原文是无条件 `await page.get_by_text("发布图文", exact=True).click()`。
  **抖音已改版：上传页不再有「发布图文」这个 tab**（直接上传图片即进图文表单），
  于是这行找不到元素 → **等 30 秒超时 → 整条发布失败**（2026-10-13 09:31 现场：
  `Locator.click: Timeout 30000ms exceeded. waiting for get_by_text("发布图文", exact=True)`）。
  改成**可选**：`count() > 0` 才点（兼容老版页面），否则打一行日志直接继续上传。
  **现场证据**：`engine/_douyin_dryrun.py`（官方诊断脚本，严禁点发布）同期跑通、exit=0，
  其截图显示图文表单已就绪且页面上没有"发布图文"字样。
  **同步上游时若被覆盖**：把这段改回"可选"，否则发布会在最后一跳超时失败。

## Local configuration

- `conf.py` 按上游约定从 `conf.example.py` 创建，`LOCAL_CHROME_HEADLESS=True`（无头模式，不弹多余浏览器窗口）、
  `LOCAL_CHROME_PATH=""`（统一使用 Playwright 自带 Chromium）。
- 本地补丁（2026-08-31）：`uploader/xiaohongshu_uploader/main.py` 与
  `uploader/tencent_uploader/main.py` 的登录函数补上 `cdp_url` 参数，
  与上游 douyin/kuaishou 登录函数一致，用于全平台链接真实 Chrome（新版无头）对抗风控。
- 本地补丁（2026-09-12）：`uploader/bilibili_uploader/runtime.py` 的
  `get_biliup_runtime_root()` 支持 `BF_BILIUP_ROOT` 覆盖。biliup 二进制随安装包分发
  （`resources/engine/tools/biliup`），由桌面壳注入该变量；否则首次 B 站发布会去
  GitHub release 现下，实测要 225 秒。
- B 站扫码登录**不在**这个目录里：上游 `bilibili_uploader` 只有 biliup CLI 包装、
  没有登录函数，产品按 B 站 passport 接口补在 `../bilibili_login.py`。
- 本地补丁（2026-09-29，抖音发布链路，全部在 `uploader/douyin_uploader/main.py`）：
  1. **填写改用一次性插入**：正文与话题用 `keyboard.insert_text()` 而不是逐字 `type()`。
     逐字输入中文时，抖音的异步联想与输入法候选会把字符勾进输入框、甚至打乱顺序
     （实测标签被打散成 `#无 人#免 费#人 社…` 这种碎片）；一次性插入等价于整段粘贴。
     话题仍逐个插入 + 空格确认，只取前 5 个（平台习惯上限）。
  2. **封面一律用发布页的「AI 智能推荐封面」**，不上传产品自生成的图
     （那是图文笔记排版图，上面还印着平台名，当视频封面既不对味也难看）。
     流程：等推荐封面生成 → 点选应用 → 再等一次（横封面 4:3 生成更慢）→ 截图留证。
     少了"点选应用"这步，竖/横封面位都是空的，平台发文助手会警告「横/竖双封面缺失」。
  3. **遇到验证码弹窗即暂停一切自动操作，等真人完成**。不再点「获取验证码」
     （会触发平台「验证码发送太频繁」）、不重试发布、不刷新页面（会清空用户已输入的内容），
     只轮询弹窗是否消失；消失即自动继续。等待上限 600 秒。
  4. **阶段与现场证据**：`_stage()` 把当前步骤写进 `BOSOM_TASK_DIR/state.json` 的 `stage`
     （前端据此显示实时进度）；`_capture_evidence()` 把截图存到
     `engine/social-auto-upload/evidence/`（30 秒节流）。
  5. **登录失效早发现**：打开上传页后检测登录页元素，被重定向即报
     「抖音登录已失效（上传页被重定向到登录页）」，而不是一路走到点发布才失败。
  6. **话题与位置的候选选择先精确匹配再退到包含**：只用「包含」时，输入「江苏」
     会命中「江苏中烟小厂基地单元」这类别的词，位置就标到无关地点去了。

## Runtime notes

- 上游登录函数把账号记录写入 `db/database.db` 的 `user_info` 表
  （`userName` 为传入的会话 id），cookie 落盘于 `cookiesFile/<uuid>.json`。
  `../worker.py` 只创建表结构并读取结果，不改动登录逻辑。
- Python 依赖安装于 `../.venv`；登录用 `playwright install chromium`，发布用
  patchright 的 Chrome for Testing 145（v1208），两者浏览器均落在系统 ms-playwright 缓存。
