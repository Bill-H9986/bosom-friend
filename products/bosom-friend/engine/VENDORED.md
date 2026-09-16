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

## Runtime notes

- 上游登录函数把账号记录写入 `db/database.db` 的 `user_info` 表
  （`userName` 为传入的会话 id），cookie 落盘于 `cookiesFile/<uuid>.json`。
  `../worker.py` 只创建表结构并读取结果，不改动登录逻辑。
- Python 依赖安装于 `../.venv`；登录用 `playwright install chromium`，发布用
  patchright 的 Chrome for Testing 145（v1208），两者浏览器均落在系统 ms-playwright 缓存。
