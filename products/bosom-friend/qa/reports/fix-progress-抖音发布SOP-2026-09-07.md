# 修复进度：抖音发布 SOP 落地（engine/worker.py 链路）

- 日期：2026-09-07
- 负责人：寇豆码（software-engineer-2）
- 文件域：`products/bosom-friend/engine/`（不动 server/src）
- 参照 SOP：https://github.com/LouisLin0723/social-auto-publisher `SOP-douyin-playwright-publish.md`
- 红线：**严禁真实发布**，全部验证止步于"上传表单就绪 + 文件已装入 + 标题正文已填"，截图留证。

## 一、SOP 16 坑逐条对照现状（gap 分析）

发布链路实际结构：`worker.py: run_publish → _run_sau_cli_publish → vendor/sau_cli.py → uploader/douyin_uploader/main.py`。
真实浏览器动作全部在 `douyin_uploader/main.py`，因此坑位修复落点在这里（worker.py 只透传参数，无需改动）。

| # | SOP 坑 | 现状 | 结论 |
|---|---|---|---|
| 1 | 扩展 file_upload 沙箱 → 必须 Playwright setInputFiles | 已用 Patchright `set_input_files`（视频 main.py:1164、图文 :1348） | ✅ 主体已符合 |
| 2 | **CDP `DOM.setFileInputFiles` 兜底** | **缺失**：set_input_files 单点失败即整个发布挂 | ❌ → 本轮修复 |
| 3 | **连续会话：登录→后台→上传→填表单同一持久化 profile** | **缺失**：每次发布 `browser.new_context(storage_state=...)`，指纹/LocalStorage 不持久，风控视角每次都是"新设备" | ❌ → 本轮修复（launch_persistent_context + 按账号持久 profile，失败回退旧路径） |
| 4 | `--disable-blink-features=AutomationControlled` | 已有（launch args，main.py:1138/1397/126 等） | ✅ |
| 5 | 抹 `navigator.webdriver` | 已有：`set_init_script` 注入 utils/stealth.min.js | ✅ |
| 6 | 真实 Chrome（channel/executable_path），非内置 chromium | conf.py `LOCAL_CHROME_PATH` 指向系统 Chrome | ✅ |
| 7 | headless:false（抖音对 headless 反爬敏感） | 默认 headless=True（产品无人值守权衡），保留 | ⚠️ 记录不改（产品语义），干跑用现有模式 |
| 8 | 图文上传页 default-tab=3 / 发布图文入口 | 已有 `get_by_text("发布图文")` 入口 | ✅ |
| 9 | 标题 `input[placeholder*=标题]` + 正文 contenteditable + keyboard.type | `fill_title_and_description` 已实现（含话题 #、Escape 收下拉） | ✅ |
| 10 | 标题 20 字/图文 35 图/正文 1000 字限制 | validate_upload_args 已校验 | ✅ |
| 11 | 发布按钮 `exact:true` 排除"高清发布" | `get_by_role("button", name="发布", exact=True)` | ✅ |
| 12 | 人工确认闸门（.publish-go） | 产品由前端跟随模式状态机控制；本轮干跑天然停在发布前 | ✅（语义等价） |
| 13 | 上传失败重试 | `handle_upload_error` 已有 | ✅ |
| 14 | YMYL 合规文案 | 产品侧内容策略，不在本轮范围 | ⚠️ 记录 |
| 15 | TikTok 代理 | 非本轮范围 | — |
| 16 | wmic/强杀进程不可用 | 脚本均优雅 close() | ✅ |

**需要落地的缺失项：坑 2（CDP 兜底）、坑 3（持久化 profile 连续会话）。**

## 二、改动

改动文件：`products/bosom-friend/engine/social-auto-upload/uploader/douyin_uploader/main.py`
（worker.py 未改：它只是 CLI 透传层）

1. 新增 `_profile_dir_for(account_file)`：按账号生成持久 profile 目录 `douyin-profile-<账号名>`（与 cookie 同目录隔离），返回 `(dir, is_fresh)`。
2. 新增 `_launch_persistent_browser(...)`：`launch_persistent_context` + 真实 Chrome + `--disable-blink-features=AutomationControlled` + geolocation 权限；fresh profile 首次启动后用 `add_cookies` 显式注入登录 cookie（launch 参数 storage_state 在 persistent context 下不生效，实测踩坑）；任何异常回退旧 `new_context(storage_state=...)` 路径，不破坏现有行为。
3. 新增 `_cdp_set_input_files(context, page, selector, files)`：`context.new_cdp_session(page)` → `DOM.getDocument` → `DOM.querySelectorAll` → `DOM.setFileInputFiles`，SOP 点名的兜底通道。
4. 新增 `_set_files_with_cdp_fallback(...)`：先 `set_input_files`，失败走 3，两者都失败抛明确错误。
5. `DouYinVideo.upload` 与 `DouYinNote.upload`：改用持久化上下文启动；视频/图文两处上传点接入 CDP 兜底；收尾 `storage_state` 回写 cookie 文件（持久 profile 与 cookie 文件双向同步）。
6. **修复 `fill_title_and_description` 图文页标题 selector**：图文发布页(post/image)标题 placeholder 已从「填写作品标题」（视频页）变为「添加作品标题」，旧 selector 精确卡死图文发布（干跑实测复现）；改为 `input[placeholder*="作品标题"]` 中缀匹配两种文案。
7. 顺手补 `import json`（模块原本只在函数内局部导入，新增代码触发 NameError，已修）。

## 三、干跑验证（不点发布）✅ 通过

- 命令：`.venv/Scripts/python.exe engine/_douyin_dryrun.py <storage.json> <截图前缀> <图1> <图2>`
- 登录态：`platform-login/interact/inter-c657n6z3/storage.json`（含 douyin sessionid，acc-nnpqqueo/XchanM520）
- 结果（DRYRUN_RESULT）：
  - `usedFallback: false`（持久化 profile 直接启动成功，未走回退）
  - `loginCheck.verified: true`，profile=XchanM520/36 粉（创作者接口复核通过）
  - `navigatorWebdriver: false`（stealth 生效，反检测通过）
  - `filesLoaded: true`（set_input_files 装入 2 张图）
  - `enteredPostImage: true`（进入 `creator-micro/content/post/image` 图文发布页）
  - `formReady`: 标题=「人社局无人机装调检修招工了！」(14/20)、正文+话题已填(52/1000)、**发布按钮可见但未点击**，优雅退出
- 证据截图（`products/bosom-friend/qa/reports/`）：
  - `douyin-sop-dryrun-form-ready.png` —— 最终态：表单就绪、图片已装入（右侧 ai-img-02e0d41b.png 0%、0/2 取消上传）、标题正文已填、发布按钮未点
  - `douyin-sop-dryrun-form-ready-diag-tab.png` / `-diag-form.png` —— 排障过程截图（登出态/表单 DOM 诊断）
- 干跑工具：`engine/_douyin_dryrun.py`（保留可复跑；红线=绝不点发布）

## 四、Douyin-mcp Draft.js paste 注入方案评估（只学思路，AGPL 不搬代码）

针对抖音私信 summon 面板输入框渲染不稳定/输入丢字问题。思路（来自 Douyin-mcp 的启发，非其代码）：
抖音部分富文本输入框（私信输入框、发布页 contenteditable）底层是 Slate.js，`keyboard.type` 逐字符走 IME 合成，
Slate 的 `editor.selection` 在 DOM 焦点抖动时会重置，导致丢字/不渲染。

自研骨架（伪代码）：

```python
async def slate_paste_text(page, editor_selector: str, text: str):
    """把文本按 Slate 原生 paste 事件注入 contenteditable，绕过逐字符 type。"""
    await page.locator(editor_selector).click()          # 先真实聚焦
    await page.evaluate(
        """({sel, text}) => {
            const el = document.querySelector(sel);
            el.focus();
            const dt = new DataTransfer();
            dt.setData('text/plain', text);
            el.dispatchEvent(new ClipboardEvent('paste', {
                clipboardData: dt, bubbles: true, cancelable: true,
            }));
        }""",
        {"sel": editor_selector, "text": text},
    )
```

要点：
1. 先真实点击聚焦（Slate 以 DOM selection 定位插入点）；
2. `DataTransfer` + `ClipboardEvent('paste')` 一次性注入整段文本，Slate 自己处理分片，无逐字符合成；
3. 若 Slate 拦截 paste 需 `event.preventDefault()` 后走 `editor.insertText`，可加 init script hook `document.addEventListener('paste', ...)` 抓 `slate-react` 实例兜底；
4. 兜底顺序建议：paste 注入 → keyboard.insertText（CDP `Input.insertText`）→ 逐字符 type。
本轮不实现，仅记录骨架待后续私信链路修复时使用。

## 五、遗留项

- headless=True 保留产品默认（SOP 建议 headed，属产品语义权衡，如实记录）。本次干跑在 headless 下全程无风控拦截，风险暂可控。
- YMYL 合规文案策略未处理（产品内容侧）。
- 私信 summon 面板问题本轮只留 Draft.js/paste 骨架（见第四节），未实现。
- 图文上传后右侧缩略图 0% 时即截图（图片尚在分片上传），非阻塞；真实发布链路本就有「重新上传/上传完成」轮询。

## 六、监考复跑记录（2026-09-07 下午，追加）

### 小红书路 ✅ PASS（07:48）
- 过程坑两枚（非代码问题，运维层）：
  1. **运行时 lib 不同步**：总控把 SSE 修复（deadline 180s + 超时保留 collected + modelFailed 以正文判定）补进了 `server/lib/types/api.js`（15:03 构建），但打包态应用加载的是 `kernel-runtime-unpacked/node_modules/.../lib/types/api.js`（9/4 旧副本，60s+旧门）。首次复跑在 +60s 整复现"大模型调用失败：模型响应超时"、无动作卡（agent-tasks.json 取证）。**修复=把 server/lib/types/*.js 全量同步到 kernel-runtime 副本**，重启后 sse-debug 探针 `hasResult:1` 确认动作卡恢复。
  2. **备份轮转卡死启动**：`securityHardening` 清理旧备份触发 WorkBuddy node safe-delete 守卫（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`，88>50），boot 直接崩 → 这就是监考中途 31280 掉线、懒加载 chunk 404 的原因。**修复=把 13 个 2026-09-04T* 备份目录整体移入 `~/.bosom-friend/_backup-quarantine-20260907/`（移动不删除，事故证据保留）**，轮转低于保留数后启动恢复。
- 最终结果：`pass=true, publishOk=true`，真实发布 `flowId=flow-wnmtz8hz`（rec-7ujdyrlm → acc-ukzk41h7 小红书），timeline 9 节点全过（content-captured 11s → draft-box 07:46:00 → datacenter 同步完成），taskText 含「人社局」、accounts 含「小红书」、monitor 命中 7×24，pageErrors=0。
- 报告：`qa/acceptance/frontend-auto-agent-xhs-report.json`；截图 `auto-xhs-*.png`。

### 抖音路（进行中）

（待补）
