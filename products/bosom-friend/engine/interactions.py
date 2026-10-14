"""Bosom Friend 平台互动引擎（评论 / 私信 的 列表与回复）。

业务原则：一切平台动作都必须发生在真实平台页面上，由已登录账号的浏览器会话完成；
本模块不伪造任何平台结果，所有“已回复”均以平台页面确认（输入框清空 / 消息落屏 /
出现回复线程）为准。

来源：本文件把 Electron 主进程中已成熟、已实测的页面驱动逻辑
（electron/main/reply/commentPageDriver.ts、
electron/main/plat/platforms/xhs/xhsCommentPageDriver.ts、
electron/main/dm/douyinImPageDriver.ts、
electron/main/plat/xhsImSender.ts、
electron/plat/xiaohongshu/index.ts 的 IM 端点）
原样移植为 Patchright（真实 Chrome + 已登录 storage_state）实现，
选择器与节奏保持一致，避免闭门造车。

用法（由 worker.py 调用）:
    python interactions.py run <taskDir>
taskDir 内含 input.json:
    {
      "op": "comments_list" | "comment_reply" | "dm_list" | "dm_reply",
      "platform": "xhs" | "douyin",
      "storageFile": "<storage_state.json>",
      "workId": "...", "workTitle": "...", "createTime": "...",
      "commentKey": "...", "commentText": "...", "username": "...",
      "replyText": "...", "sessionId": "...", "peerName": "..."
    }
执行结果写入 taskDir/state.json:
    { "status": "done" | "failed", "data": {...}, "error": "...", "finishedAt": "..." }
"""

import asyncio
import json
import random
import re
import sys
import time
from pathlib import Path

ENGINE_DIR = Path(__file__).resolve().parent
VENDOR_DIR = ENGINE_DIR / "social-auto-upload"
sys.path.insert(0, str(VENDOR_DIR))

DOUYIN_COMMENT_PAGE = (
    "https://creator.douyin.com/creator-micro/interactive/comment"
    "?item_id={item_id}&enter_from=content_manage_v2"
)
DOUYIN_CHAT_URL = "https://creator.douyin.com/creator-micro/data/following/chat"
XHS_EXPLORE_URL = "https://www.xiaohongshu.com/explore"
XHS_CHAT_URL = "https://www.xiaohongshu.com/chat/"
XHS_IM_CHATS_URL = "https://edith.xiaohongshu.com/api/im/web/v3/chats?limit=100&complete=true&page=0&source=pc"
XHS_IM_HISTORY_URL = (
    "https://edith.xiaohongshu.com/api/im/web/messages/history?chat_user_id={sid}&last_id=0&start_id=0&limit=30"
)


def _launch_kwargs() -> dict:
    from conf import LOCAL_CHROME_PATH  # noqa: PLC0415

    kwargs = {
        "headless": True,
        "args": [
            "--disable-blink-features=AutomationControlled",
            "--no-first-run",
            "--no-default-browser-check",
            "--lang=zh-CN",
        ],
    }
    if LOCAL_CHROME_PATH and Path(LOCAL_CHROME_PATH).exists():
        kwargs["executable_path"] = LOCAL_CHROME_PATH
    else:
        kwargs["channel"] = "chromium"
    return kwargs


def _shared_cdp(task_dir: Path) -> str | None:
    """读取登录守护进程写下的共享 Chrome CDP 端口，复用同一真实浏览器会话。"""
    root = task_dir.parent.parent
    cdp_file = root / "shared-cdp.json"
    if not cdp_file.is_file():
        return None
    try:
        payload = json.loads(cdp_file.read_text(encoding="utf-8"))
        port = int(payload.get("port") or 0)
        if port <= 0:
            return None
        return f"http://127.0.0.1:{port}"
    except Exception:
        return None


async def _open_browser(storage_file: Path, task_dir: Path):
    """以已登录 storage_state 打开真实 Chrome，注入上游 stealth 脚本。"""
    from patchright.async_api import async_playwright  # noqa: PLC0415
    from utils.base_social_media import set_init_script  # noqa: PLC0415

    pw = await async_playwright().start()
    cdp_url = _shared_cdp(task_dir)
    shared = cdp_url is not None
    if shared:
        try:
            browser = await pw.chromium.connect_over_cdp(cdp_url)
            context = browser.contexts[0] if browser.contexts else await browser.new_context()
            try:
                cookies = json.loads(storage_file.read_text(encoding="utf-8")).get("cookies", [])
                if cookies:
                    await context.add_cookies(cookies)
            except Exception:
                pass
        except Exception:
            shared = False
            browser = await pw.chromium.launch(**_launch_kwargs())
            context = await browser.new_context(
                storage_state=str(storage_file),
                viewport={"width": 1440, "height": 900},
            )
    else:
        browser = await pw.chromium.launch(**_launch_kwargs())
        context = await browser.new_context(
            storage_state=str(storage_file),
            viewport={"width": 1440, "height": 900},
        )
    context = await set_init_script(context)
    return pw, browser, context, shared


def _js(page, expression: str):
    """页面内执行表达式并取回返回值（吞掉瞬时刷新错误）。"""
    try:
        return page.evaluate(expression)
    except Exception:
        return None


async def _wait_for(page, expression: str, timeout_ms: int, interval_ms: int = 400):
    """轮询页面表达式直到为真，返回命中的真值（用于确认信号）；超时返回 None。"""
    deadline = time.time() + timeout_ms / 1000
    while time.time() < deadline:
        try:
            value = await page.evaluate(expression)
            if value:
                return value
        except Exception:
            pass
        await asyncio.sleep(interval_ms / 1000)
    return None


async def _block_douyin_messages_redirect(page) -> None:
    """抖音创作者页加载后会被 JS 强制跳转到 www.douyin.com/messages（部分账号 404）。

    与 Electron 的 Fetch 204 守卫一致：拦截该导航，保持评论页/私信页不被弹走。
    """

    async def handler(route) -> None:
        try:
            await route.fulfill(status=204, body="")
        except Exception:
            await route.continue_()

    await page.route("**www.douyin.com/messages**", handler)


# ============================== 抖音评论 =====================================

DOUYIN_EXTRACT_COMMENTS_EXPR = r"""(() => {
  const norm = (s = '') => String(s).replace(/\s+/g, ' ').trim();
  const TIME_RE = /(发布于\d{4}年\d{1,2}月\d{1,2}日(?:\s+\d{1,2}:\d{2})?|\d{4}年\d{1,2}月\d{1,2}日(?:\s+\d{1,2}:\d{2})?|\d+分钟前|\d+小时前|\d+天前|刚刚)/;
  const out = [];
  const seen = new Set();
  const rows = [];
  for (const el of document.querySelectorAll('div, li')) {
    if (!(el instanceof HTMLElement) || el.offsetParent === null) continue;
    const t = norm(el.textContent || '');
    if (!t || t.length < 10 || t.length > 1500) continue;
    if (!TIME_RE.test(t) || !/(回复|删除|举报)/.test(t)) continue;
    if ((t.match(new RegExp(TIME_RE.source, 'g')) || []).length !== 1) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    rows.push(el);
  }
  const picked = rows.filter((el) => !rows.some((o) => o !== el && o.contains(el)));
  for (const row of picked) {
    const t = norm(row.textContent || '');
    const hasReply = /(查看\d+条回复|收起)/.test(t);
    let clean = t.replace(/\s*(?:查看\d+条回复|收起|没有更多评论|暂无更多评论|点击刷新)\s*$/, '');
    const tm = clean.match(TIME_RE);
    if (!tm || typeof tm.index !== 'number') continue;
    let username = clean.slice(0, tm.index).replace(/作者$/, '').trim();
    username = username
      .replace(/^(?:评论管理|发送|全部评论|全部人群|最新发布|选择作品|筛选|排序|清空)+/g, '')
      .replace(/^[~·\-—\s]+/, '')
      .trim()
      .slice(-40);
    let rest = clean.slice(tm.index + tm[0].length).trim();
    rest = rest.replace(/\s*\d*\s*(?:回复\s*删除\s*举报|删除\s*举报|回复\s*删除|回复\s*举报|回复|删除|举报)\s*$/, '').trim();
    if (!rest) continue;
    out.push({ username, commentText: rest.slice(0, 2000), hasReply });
  }
  return JSON.stringify(out);
})()"""

DOUYIN_READY_EXPR = r"""(() => {
  if (document.querySelectorAll('.operations-WFV7Am').length > 0) return true;
  const norm = (s = '') => String(s).replace(/\s+/g, ' ').trim();
  if ([...document.querySelectorAll('button')].some(el => norm(el.textContent || '') === '选择作品')) return true;
  if (document.querySelector('.douyin-creator-interactive-tabs-pane-active, .empty-refresh-Mt1Apg, .loading-CwwynV')) return true;
  return [...document.querySelectorAll('[role="combobox"]')]
    .some(el => /(全部评论|最新发布)/.test(norm(el.textContent || '')));
})()"""

DOUYIN_SCROLL_MORE_EXPR = r"""(() => {
  const tryScroll = (el) => {
    if (!el) return false;
    const before = el.scrollTop;
    el.scrollTop = el.scrollHeight;
    return el.scrollTop !== before;
  };
  if (tryScroll(document.scrollingElement)) return 'ok';
  if (tryScroll(document.body)) return 'ok';
  let best = null;
  for (const el of document.querySelectorAll('div')) {
    if (el instanceof HTMLElement && el.scrollHeight > el.clientHeight + 200) {
      if (!best || el.scrollHeight > best.scrollHeight) best = el;
    }
  }
  if (best) { best.scrollTop = best.scrollHeight; return 'ok'; }
  return null;
})()"""


async def _douyin_select_work(page, work_id: str, work_title: str, create_time: str) -> bool:
    clicked = await _js(
        page,
        r"""(() => {
          const norm = (s = '') => String(s).replace(/\s+/g, ' ').trim();
          const btn = [...document.querySelectorAll('button')]
            .find(el => el instanceof HTMLElement && el.offsetParent !== null && norm(el.textContent || '') === '选择作品');
          if (!btn) return null;
          btn.click();
          return 'ok';
        })()""",
    )
    if clicked != "ok":
        return False
    sheet_ready = await _wait_for(
        page,
        r"""(() => {
          const sheet = [...document.querySelectorAll('.douyin-creator-interactive-sidesheet-body')]
            .find(el => el instanceof HTMLElement && el.offsetParent !== null);
          return !!sheet;
        })()""",
        10000,
        400,
    )
    if not sheet_ready:
        return False
    title = (work_title or "").replace(r"\s+", "").strip()[:15]
    wanted_time = (create_time or "").replace(r"\s+", "")
    picked = await _js(
        page,
        """(() => {
          const norm = (s = '') => String(s).replace(/\\s+/g, ' ').trim();
          const compact = (s = '') => norm(s).replace(/\\s+/g, '');
          const wantedTime = PLACEHOLDER_TIME;
          const wanted = PLACEHOLDER_TITLE;
          const cards = [...document.querySelectorAll('.douyin-creator-interactive-sidesheet-body *')]
            .filter(el => el instanceof HTMLElement && el.offsetParent !== null)
            .filter(el => {
              const t = compact(el.textContent || '');
              return t.includes('发布于') && (wantedTime ? t.includes(wantedTime) : wanted ? t.includes(wanted) : true);
            })
            .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
          const card = cards[0];
          if (!card) return null;
          card.click();
          return 'ok';
        })()""".replace("PLACEHOLDER_TIME", json.dumps(wanted_time)).replace("PLACEHOLDER_TITLE", json.dumps(title)),
    )
    if picked != "ok":
        return False
    await asyncio.sleep(2)
    return await _wait_for(page, DOUYIN_READY_EXPR, 12000, 500)


async def douyin_comments_list(page, work_id: str, work_title: str, create_time: str) -> dict:
    captured: list[dict] = []

    def _on_response(resp):
        if "creator/comment/list" in resp.url:
            captured.append(resp)

    page.on("response", _on_response)
    await page.goto(DOUYIN_COMMENT_PAGE.format(item_id=work_id), wait_until="domcontentloaded", timeout=90000)
    await asyncio.sleep(4)
    ready = await _wait_for(page, DOUYIN_READY_EXPR, 15000, 500)
    if not ready:
        selected = await _douyin_select_work(page, work_id, work_title, create_time)
        if not selected:
            return {"ok": False, "comments": [], "message": "评论管理页加载超时"}
    for _ in range(10):
        before = await page.evaluate("document.querySelectorAll('.container-sXKyMs').length")
        await _js(page, DOUYIN_SCROLL_MORE_EXPR)
        await asyncio.sleep(random.uniform(1.5, 2.5))
        after = await page.evaluate("document.querySelectorAll('.container-sXKyMs').length")
        if after == before:
            break
    page.remove_listener("response", _on_response)
    api_comments: dict[str, dict] = {}
    for response in captured:
        try:
            data = await response.json()
        except Exception:
            continue
        for raw in data.get("comment_info_list") or []:
            comment_id = str(raw.get("comment_id") or "")
            text = str(raw.get("text") or "").strip()
            if not comment_id or not text:
                continue
            user = raw.get("user_info") or {}
            api_comments[comment_id] = {
                "key": f"cid:{comment_id}",
                "username": str(user.get("screen_name") or ""),
                "commentText": text,
                "hasReply": int(raw.get("reply_count") or 0) > 0,
            }
    if api_comments:
        return {"ok": True, "comments": list(api_comments.values())}
    raw = await _js(page, DOUYIN_EXTRACT_COMMENTS_EXPR)
    rows = []
    try:
        rows = json.loads(raw or "[]")
    except (TypeError, ValueError):
        rows = []
    comments = [
        {
            "key": f"text:{row.get('commentText') or ''}",
            "username": row.get("username") or "",
            "commentText": row.get("commentText") or "",
            "hasReply": bool(row.get("hasReply")),
        }
        for row in rows
        if isinstance(row, dict) and row.get("commentText")
    ]
    return {"ok": True, "comments": comments}


def _douyin_find_expr(comment_text: str, username: str, with_username: bool) -> str:
    wanted = re.sub(r"\s+", " ", comment_text or "").strip()[:80]
    wanted_user = (re.sub(r"\s+", " ", username or "").strip()) if with_username else ""
    return r"""(() => {
    const norm = (s = '') => String(s).replace(/\s+/g, ' ').trim();
    const wanted = PLACEHOLDER_WANTED;
    const wantedUser = PLACEHOLDER_USER;
    for (const el of document.querySelectorAll('[data-zhiyin-comment]')) el.removeAttribute('data-zhiyin-comment');
    const leaves = [...document.querySelectorAll('div,span,p')]
      .filter(el => el instanceof HTMLElement && el.offsetParent !== null);
    const exact = [];
    const prefix = [];
    for (const leaf of leaves) {
      const t = norm(leaf.textContent || '');
      if (!t || t.length > 300) continue;
      if (t === wanted) exact.push(leaf);
      else if (t.length > wanted.length && t.startsWith(wanted) && wanted.length >= 6) prefix.push(leaf);
    }
    const tryMatch = (candidate) => {
      let row = candidate;
      for (let i = 0; i < 10 && row; i++) {
        const rowText = norm(row.textContent || '');
        if (
          rowText.length > 0
          && rowText.length < 1500
          && /(\d{4}年|分钟前|小时前|天前|刚刚)/.test(rowText)
          && /(回复|删除|举报)/.test(rowText)
        ) {
          const rect = row.getBoundingClientRect();
          if (rect.width >= 240) {
            if (wantedUser && !rowText.includes(wantedUser)) return null;
            row.setAttribute('data-zhiyin-comment', '1');
            return row;
          }
        }
        row = row.parentElement;
      }
      return null;
    };
    for (const c of exact) { if (tryMatch(c)) return 'ok'; }
    for (const c of prefix) { if (tryMatch(c)) return 'ok'; }
    return null;
  })()""".replace("PLACEHOLDER_WANTED", json.dumps(wanted)).replace("PLACEHOLDER_USER", json.dumps(wanted_user))


DOUYIN_REPLY_INPUT_FINDER = r"""[...document.querySelectorAll('[contenteditable="true"]')]
  .find(el => el instanceof HTMLElement && el.offsetParent !== null && (el.getAttribute('placeholder') || '').startsWith('回复'))"""

DOUYIN_ALREADY_REPLIED_EXPR = r"""(() => {
  const row = document.querySelector('[data-zhiyin-comment="1"]');
  if (!row) return 'no_marker';
  const norm = (s = '') => String(s).replace(/\s+/g, ' ').trim();
  const t = norm(row.textContent || '');
  if (/(?:查看|展开)?(?:全部)?[1-9]\d*条回复/.test(t) || t.includes('收起')) return 'replied';
  return 'open';
})()"""

DOUYIN_CLICK_REPLY_EXPR = r"""(() => {
  const row = document.querySelector('[data-zhiyin-comment="1"]');
  if (!row) return null;
  const norm = (s = '') => String(s).replace(/\s+/g, ' ').trim();
  const cands = [...row.querySelectorAll('*')]
    .filter(el => el instanceof HTMLElement && el.offsetParent !== null);
  let btn = cands
    .filter(el => norm(el.textContent || '') === '回复' && el.children.length <= 2)
    .sort((a, b) => a.children.length - b.children.length)[0];
  if (!btn) {
    btn = cands.find(el => el.children.length === 0 && norm(el.textContent || '') === '回复');
  }
  if (!btn) return null;
  btn.click();
  return 'ok';
})()"""


def _douyin_input_ready_expr() -> str:
    return f"(() => {{ return !!({DOUYIN_REPLY_INPUT_FINDER}); }})()"


DOUYIN_FOCUS_INPUT_EXPR = r"""(() => {
  const el = (""" + DOUYIN_REPLY_INPUT_FINDER + r""");
  if (!el) return false;
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  el.focus();
  return true;
})()"""

DOUYIN_SEND_STATE_EXPR = r"""(() => {
  const input = (""" + DOUYIN_REPLY_INPUT_FINDER + r""");
  if (!input) return null;
  const norm = (s = '') => String(s).replace(/\s+/g, ' ').trim();
  let n = input;
  for (let i = 0; i < 6 && n; i++) {
    const btns = [...n.querySelectorAll('button')]
      .filter(b => norm(b.textContent || '') === '发送');
    if (btns.length) {
      const enabled = btns.find(b => !(
        b.disabled
        || b.getAttribute('disabled') !== null
        || b.getAttribute('aria-disabled') === 'true'
      ));
      if (enabled) return 'ok';
      n = n.parentElement;
      continue;
    }
    n = n.parentElement;
  }
  return null;
})()"""

DOUYIN_CLICK_SEND_EXPR = r"""(() => {
  const input = (""" + DOUYIN_REPLY_INPUT_FINDER + r""");
  if (!input) return null;
  const norm = (s = '') => String(s).replace(/\s+/g, ' ').trim();
  let n = input;
  for (let i = 0; i < 6 && n; i++) {
    const btns = [...n.querySelectorAll('button')]
      .filter(b => norm(b.textContent || '') === '发送');
    if (btns.length) {
      const enabled = btns.find(b => !(
        b.disabled
        || b.getAttribute('disabled') !== null
        || b.getAttribute('aria-disabled') === 'true'
      ));
      if (enabled) {
        enabled.click();
        return 'ok';
      }
      n = n.parentElement;
      continue;
    }
    n = n.parentElement;
  }
  return null;
})()"""

DOUYIN_REPLY_CONFIRM_EXPR = r"""(() => {
  const norm = (s = '') => String(s).replace(/\s+/g, ' ').trim();
  const input = (""" + DOUYIN_REPLY_INPUT_FINDER + r""");
  if (input) {
    const t = norm(input.textContent || '');
    if (!t) return 'input_cleared';
  }
  const toast = [...document.querySelectorAll('[role="alert"], div, span')]
    .filter(el => el instanceof HTMLElement && el.offsetParent !== null)
    .map(el => norm(el.textContent || ''))
    .some(t => t.includes('回复成功') || t.includes('发送成功'));
  if (toast) return 'toast';
  const ops = document.querySelector('[data-zhiyin-comment="1"]');
  if (ops) {
    let row = ops;
    for (let i = 0; i < 3 && row; i++) {
      const t = norm(row.textContent || '');
      if (/(?:查看|展开)?(?:全部)?[1-9]\d*条回复/.test(t) || t.includes('收起')) return 'thread';
      row = row.parentElement;
    }
  }
  return null;
})()"""


async def douyin_comment_reply(
    page,
    work_id: str,
    work_title: str,
    comment_text: str,
    username: str,
    reply_text: str,
) -> dict:
    captured: list[dict] = []

    async def _on_response(resp):
        if "creator/comment/reply" in resp.url:
            try:
                captured.append(
                    {
                        "status": resp.status,
                        "body": (await resp.text())[:2000],
                    }
                )
            except Exception:
                pass

    page.on("response", _on_response)
    await page.goto(DOUYIN_COMMENT_PAGE.format(item_id=work_id), wait_until="domcontentloaded", timeout=90000)
    await asyncio.sleep(4)
    ready = await _wait_for(page, DOUYIN_READY_EXPR, 15000, 500)
    if not ready:
        selected = await _douyin_select_work(page, work_id, work_title, "")
        if not selected:
            return {"ok": False, "status": "open_failed", "message": "评论管理页加载超时"}

    found = await _js(page, _douyin_find_expr(comment_text, username, True))
    if found != "ok":
        found = await _js(page, _douyin_find_expr(comment_text, username, False))
    if found != "ok":
        for _ in range(6):
            await _js(page, DOUYIN_SCROLL_MORE_EXPR)
            await asyncio.sleep(random.uniform(1.2, 2.2))
            found = await _js(page, _douyin_find_expr(comment_text, username, True))
            if found != "ok":
                found = await _js(page, _douyin_find_expr(comment_text, username, False))
            if found == "ok":
                break
    if found != "ok":
        return {"ok": False, "status": "comment_not_found", "message": "页面滚动后仍未找到该评论"}

    replied = await _js(page, DOUYIN_ALREADY_REPLIED_EXPR)
    if replied == "replied":
        return {"ok": False, "status": "already_replied", "message": "该评论已有回复"}

    opened = await _wait_for(page, _douyin_input_ready_expr(), 3000, 300)
    if not opened:
        await _js(page, DOUYIN_CLICK_REPLY_EXPR)
        opened = await _wait_for(page, _douyin_input_ready_expr(), 10000, 300)
    if not opened:
        return {"ok": False, "status": "reply_open_failed", "message": "回复输入框未出现"}

    focused = await _js(page, DOUYIN_FOCUS_INPUT_EXPR)
    if not focused:
        return {"ok": False, "status": "reply_open_failed", "message": "回复输入框聚焦失败"}
    await asyncio.sleep(0.4)
    # 清空残留
    await page.keyboard.press("Control+a")
    await page.keyboard.press("Delete")
    await asyncio.sleep(0.3)
    for seg in _chunks(reply_text, 18):
        await page.keyboard.type(seg, delay=random.randint(60, 160))
    await asyncio.sleep(0.4)
    await _js(
        page,
        r"""(() => { const el = document.activeElement; if (el) el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()""",
    )
    probe = reply_text[:6]
    verified = await page.evaluate(
        f"(() => {{ const input = ({DOUYIN_REPLY_INPUT_FINDER}); if (!input) return false; "
        f"return (input.textContent || '').includes({json.dumps(probe)}); }})()"
    )
    if not verified:
        return {"ok": False, "status": "reply_open_failed", "message": "回复文本未成功输入"}

    send_ready = await _wait_for(page, DOUYIN_SEND_STATE_EXPR, 10000, 300)
    if not send_ready:
        return {"ok": False, "status": "send_failed", "message": "回复发送按钮未启用"}
    clicked = await _js(page, DOUYIN_CLICK_SEND_EXPR)
    if clicked != "ok":
        return {"ok": False, "status": "send_failed", "message": "回复发送按钮点击失败"}
    # 以平台评论回复接口的真实响应为最终判据（页面输入框清空不等于平台受理）。
    deadline = time.time() + 12
    while time.time() < deadline and not captured:
        await asyncio.sleep(0.5)
    page.remove_listener("response", _on_response)
    if captured:
        payload = None
        try:
            payload = json.loads(captured[0].get("body") or "{}")
        except (TypeError, ValueError):
            payload = None
        code = (payload or {}).get("status_code")
        status_msg = str((payload or {}).get("status_msg") or "")
        if code == 0:
            return {"ok": True, "status": "replied", "message": "平台已受理回复（status_code=0）"}
        if code is not None:
            return {
                "ok": False,
                "status": "platform_rejected",
                "message": f"平台拒绝回复：{status_msg or f'code {code}'}（作品/账号受限，非本应用故障）",
            }
    confirmed = await _wait_for(page, DOUYIN_REPLY_CONFIRM_EXPR, 10000, 400)
    failure_toast = await _js(
        page,
        r"""(() => {
          const norm = (s = '') => String(s).replace(/\s+/g, ' ').trim();
          const texts = [...document.querySelectorAll('[role="alert"], div, span')]
            .filter(el => el instanceof HTMLElement && el.offsetParent !== null)
            .map(el => norm(el.textContent || ''))
            .filter(t => t && t.length < 80);
          const bad = texts.find(t => /(无法评论|评论失败|发送失败|违规|风控|频繁|权限)/.test(t));
          return bad || '';
        })()""",
    )
    if failure_toast:
        return {"ok": False, "status": "platform_rejected", "message": f"平台拒绝回复：{failure_toast}"}
    if not confirmed:
        return {"ok": True, "status": "sent_unconfirmed", "message": "已点击发送但页面未确认"}
    return {"ok": True, "status": "replied", "message": f"平台已确认回复（{confirmed}）"}


# ============================== 小红书评论 ===================================

XHS_PROFILE_LINK_EXPR = r"""(() => {
  const a = Array.from(document.querySelectorAll('a')).find(x => (x.innerText||'').trim()==='我' && /user\/profile\//.test(x.href));
  return a ? a.href : '';
})()"""

XHS_NOTE_LIST_RE = re.compile(r"/user/profile/[0-9a-f]+/([0-9a-f]{24})\?xsec_token=([A-Za-z0-9_=\-]+)&amp;xsec_source=pc_user")


async def _xhs_own_notes(page) -> dict:
    await page.goto(XHS_EXPLORE_URL, wait_until="domcontentloaded", timeout=90000)
    await asyncio.sleep(7)
    me_href = await _js(page, XHS_PROFILE_LINK_EXPR) or ""
    if not me_href:
        return {"userId": "", "notes": []}
    await page.goto(me_href, wait_until="domcontentloaded", timeout=90000)
    note_ids: list[str] = []
    tokens: dict[str, str] = {}
    for _ in range(4):
        await asyncio.sleep(4)
        html = await page.evaluate("document.documentElement.outerHTML")
        for match in XHS_NOTE_LIST_RE.finditer(html):
            note_id, token = match.group(1), match.group(2)
            if note_id not in note_ids:
                note_ids.append(note_id)
            tokens[note_id] = token
        if note_ids:
            break
    user_id = re.search(r"profile/([0-9a-f]+)", me_href)
    return {
        "userId": user_id.group(1) if user_id else "",
        "notes": [{"noteId": n, "xsecToken": tokens.get(n, "")} for n in note_ids],
    }


def _xhs_note_url(user_id: str, note: dict) -> str:
    return (
        f"https://www.xiaohongshu.com/user/profile/{user_id}/{note['noteId']}"
        f"?xsec_token={note['xsecToken']}&xsec_source=pc_user"
    )


XHS_COMMENT_ROWS_EXPR = r"""(() => {
  const rows = Array.from(document.querySelectorAll('.comment-item')).map(el => {
    const lines = (el.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
    const author = lines[0] || '';
    const timeIdx = lines.findIndex(l => /^\d|天前|昨天|周/.test(l) && l.length < 24);
    const content = lines.slice(1, timeIdx > 1 ? timeIdx : 2).join(' ').trim();
    return { author, content };
  });
  return JSON.stringify(rows);
})()"""


async def xhs_comments_list(page, work_id: str) -> dict:
    if work_id:
        target_url = f"https://www.xiaohongshu.com/explore/{work_id}"
    else:
        target_url = "https://www.xiaohongshu.com/"
    await page.goto(target_url, wait_until="domcontentloaded", timeout=90000)
    await asyncio.sleep(6)
    body_text = await page.evaluate("(document.body ? document.body.innerText : '').slice(0, 400)") or ""
    if "IP存在风险" in body_text or "安全限制" in body_text:
        return {
            "ok": False,
            "comments": [],
            "message": "小红书平台风控：当前网络 IP 存在风险（安全限制 300012/300031），评论读取被平台拒绝，请切换网络环境后在平台重试",
        }
    if work_id:
        for _ in range(3):
            await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            await asyncio.sleep(2)
        raw = await _js(page, XHS_COMMENT_ROWS_EXPR)
        try:
            rows = json.loads(raw or "[]")
        except (TypeError, ValueError):
            rows = []
        comments = [
            {
                "key": f"{work_id}:{row.get('author') or ''}:{row.get('content') or ''}",
                "workId": work_id,
                "username": (row.get("author") or "").strip(),
                "commentText": (row.get("content") or "").strip(),
                "hasReply": False,
            }
            for row in rows
            if isinstance(row, dict) and (row.get("content") or "").strip()
        ]
        return {"ok": True, "comments": comments}
    own = await _xhs_own_notes(page)
    if not own["notes"]:
        return {"ok": False, "comments": [], "message": "未读取到自己的小红书笔记（登录态可能失效）"}
    target_notes = [n for n in own["notes"] if n["noteId"] == work_id]
    if not target_notes:
        target_notes = own["notes"][:10]
    comments: list[dict] = []
    for note in target_notes:
        try:
            await page.goto(_xhs_note_url(own["userId"], note), wait_until="domcontentloaded", timeout=90000)
            await asyncio.sleep(4)
            for _ in range(2):
                await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                await asyncio.sleep(2)
            raw = await _js(page, XHS_COMMENT_ROWS_EXPR)
            rows = json.loads(raw or "[]")
            for row in rows:
                content = (row.get("content") or "").strip()
                author = (row.get("author") or "").strip()
                if content:
                    comments.append(
                        {
                            "key": f"{note['noteId']}:{author}:{content}",
                            "workId": note["noteId"],
                            "username": author,
                            "commentText": content,
                            "hasReply": False,
                        }
                    )
        except Exception:
            continue
    return {"ok": True, "comments": comments}


def _xhs_dom_reply_expr(comment_text: str, reply_text: str) -> str:
    return r"""(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const text = PLACEHOLDER_TEXT;
    const reply = PLACEHOLDER_REPLY;
    const row = Array.from(document.querySelectorAll('.comment-item')).find(el => (el.innerText || '').includes(text));
    if (!row) return { ok: false, error: '未找到目标评论' };
    row.scrollIntoView({ block: 'center', behavior: 'instant' });
    await sleep(300);
    const btn = row.querySelector('.reply') || Array.from(row.querySelectorAll('*')).find(e => e.children.length === 0 && (e.innerText || '').trim() === '回复');
    if (!btn) return { ok: false, error: '评论内未找到回复按钮' };
    btn.click();
    await sleep(800);
    const input = document.querySelector('p.content-input') || document.querySelector('[contenteditable="true"]') || document.querySelector('textarea') || document.querySelector('input[type="text"]');
    if (!input) return { ok: false, error: '未找到回复输入框' };
    input.focus();
    document.execCommand('insertText', false, reply);
    await sleep(400);
    const send = document.querySelector('button.btn.submit')
      || Array.from(document.querySelectorAll('button')).find(e => /^(发送|发布)$/.test((e.innerText || '').trim()));
    if (!send) return { ok: false, error: '未找到发送按钮' };
    if (send.disabled) send.disabled = false;
    send.click();
    await sleep(1200);
    const cleared = input && !(input.textContent || input.value || '').trim();
    return { ok: true, detail: cleared ? '输入框已清空' : '已点击发送' };
  })()""".replace("PLACEHOLDER_TEXT", json.dumps(comment_text)).replace("PLACEHOLDER_REPLY", json.dumps(reply_text))


async def xhs_comment_reply(page, work_id: str, comment_text: str, reply_text: str) -> dict:
    own = await _xhs_own_notes(page)
    note = next((n for n in own["notes"] if n["noteId"] == work_id and n["xsecToken"]), None)
    if note is None:
        return {"ok": False, "status": "comment_not_found", "message": "主页笔记列表中未找到该笔记"}
    await page.goto(_xhs_note_url(own["userId"], note), wait_until="domcontentloaded", timeout=90000)
    await asyncio.sleep(4)
    await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
    await asyncio.sleep(2)
    try:
        result = await page.evaluate(_xhs_dom_reply_expr(comment_text, reply_text))
    except Exception as exc:
        return {"ok": False, "status": "error", "message": f"页面回复操作失败: {exc}"}
    if not result or not result.get("ok"):
        return {"ok": False, "status": "error", "message": (result or {}).get("error", "页面回复操作失败")}
    return {"ok": True, "status": "replied", "message": f"平台已提交回复（{result.get('detail', '')}）"}


# ============================== 私信 =========================================


def _cookie_header(storage_file: Path) -> str:
    try:
        state = json.loads(storage_file.read_text(encoding="utf-8"))
        cookies = state.get("cookies") or []
        return "; ".join(
            f"{item.get('name')}={item.get('value')}" for item in cookies
            if isinstance(item, dict) and item.get("name")
        )
    except (OSError, ValueError):
        return ""


async def xhs_dm_list(context, storage_file: Path) -> dict:
    """小红书官方 IM 端点（edith，无需签名）读取会话与最近消息。"""
    cookie_header = _cookie_header(storage_file)
    try:
        response = await context.request.get(
            XHS_IM_CHATS_URL,
            headers={
                "Referer": "https://www.xiaohongshu.com/",
                "Origin": "https://www.xiaohongshu.com",
                "Cookie": cookie_header,
            },
        )
        data = await response.json()
    except Exception as exc:
        return {"ok": False, "conversations": [], "message": f"IM 会话接口失败: {exc}"}
    code = (data or {}).get("code") if isinstance(data, dict) else None
    if code not in (None, 0):
        message = str((data or {}).get("msg") or code)
        return {"ok": False, "conversations": [], "message": f"平台风控/未登录（{code}）：{message}"}
    raw = ((data or {}).get("data") or {}).get("chats") or []
    conversations = []
    for item in raw:
        session_id = str(item.get("chat_user_id") or item.get("user_id") or "")
        if not session_id:
            continue
        info = item.get("info") or {}
        conversations.append(
            {
                "sessionId": session_id,
                "peerName": info.get("nickname") or info.get("user_name") or "",
                "unread": int(item.get("unread_count") or 0),
                "lastText": _xhs_im_last_text(item),
            }
        )
    return {"ok": True, "conversations": conversations}


def _xhs_im_last_text(item: dict) -> str:
    content = item.get("content") or item.get("last_msg") or ""
    if not content:
        return ""
    if isinstance(content, str):
        try:
            parsed = json.loads(content)
            return str(parsed.get("content") or parsed.get("front_chain") or "")
        except (TypeError, ValueError):
            return content
    return str(content)


async def xhs_dm_reply(page, session_id: str, content: str) -> dict:
    """打开官方聊天页，在真实输入框注入文本并回车，以输入框清空/消息落屏为成功信号。"""
    if not session_id or not (content or "").strip():
        return {"ok": False, "status": "error", "message": "会话或内容为空"}
    await page.goto(XHS_CHAT_URL + session_id, wait_until="domcontentloaded", timeout=90000)
    input_ready = await _wait_for(
        page,
        r"""(() => {
          const el = document.querySelector('.xhs-im-input-bar-editor[contenteditable]')
            || document.querySelector('.xhs-im-input-bar-editor')
            || document.querySelector('[contenteditable]');
          return !!el;
        })()""",
        50000,
        1000,
    )
    if not input_ready:
        return {"ok": False, "status": "open_failed", "message": "聊天输入框未就绪（页面可能未登录或结构变更）"}
    await asyncio.sleep(random.uniform(2, 6))
    await page.evaluate(
        r"""(() => {
          const el = document.querySelector('.xhs-im-input-bar-editor[contenteditable]')
            || document.querySelector('.xhs-im-input-bar-editor')
            || document.querySelector('[contenteditable]');
          el.scrollIntoView({ block: 'center' });
          el.focus();
        })()"""
    )
    await asyncio.sleep(0.4)
    for seg in _chunks(content, 10):
        await page.keyboard.type(seg, delay=random.randint(60, 140))
    await asyncio.sleep(0.4)
    await page.keyboard.press("Enter")
    for _ in range(15):
        await asyncio.sleep(0.8)
        state = await page.evaluate(
            r"""(() => {
              const input = document.querySelector('.xhs-im-input-bar-editor[contenteditable]')
                || document.querySelector('.xhs-im-input-bar-editor')
                || document.querySelector('[contenteditable]');
              const editorCleared = !input || !((input.innerText || input.textContent || '').trim());
              const bubbles = document.querySelectorAll('.chat-item[data-message-id] .chat-item__bubble, .chat-item__bubble');
              const last = bubbles.length ? (bubbles[bubbles.length - 1].innerText || bubbles[bubbles.length - 1].textContent || '').trim() : '';
              const fallbackEls = document.querySelectorAll('[class*=bubble]');
              const fallback = fallbackEls.length ? (fallbackEls[fallbackEls.length - 1].innerText || '').trim() : '';
              return JSON.stringify({ editorCleared, last, fallback });
            })()"""
        )
        try:
            state_obj = json.loads(state or "{}")
        except (TypeError, ValueError):
            state_obj = {}
        if state_obj.get("editorCleared"):
            return {"ok": True, "status": "sent", "message": "平台输入框已清空（发送成功）"}
        if content.strip() and content.strip() in state_obj.get("last", ""):
            return {"ok": True, "status": "sent", "message": "平台消息已落屏（发送成功）"}
        if content.strip() and content.strip() in state_obj.get("fallback", ""):
            return {"ok": True, "status": "sent", "message": "平台消息已落屏（发送成功）"}
    return {"ok": False, "status": "sent_unconfirmed", "message": "发送验证超时（输入框未清空且消息未落屏）"}


DOUYIN_CHAT_READY_EXPR = r"""(() => {
  return document.querySelectorAll("li.semi-list-item").length > 0 ||
    !!document.querySelector("[class*='item-header-name']");
})()"""

DOUYIN_LIST_CONVERSATIONS_EXPR = r"""(() => {
  const norm = (s = '') => String(s).replace(/\s+/g, ' ').trim();
  const out = [];
  const names = [...document.querySelectorAll("[class*='item-header-name']")];
  for (const name of names) {
    const n = norm(name.textContent || '');
    if (!n) continue;
    let item = name;
    for (let i = 0; i < 8 && item && item !== document.body; i++) {
      const c = typeof item.className === 'string' ? item.className : '';
      if (item.tagName === 'LI' || /semi-list-item/.test(c)) break;
      item = item.parentElement;
    }
    const content = item ? item.querySelector("[class*='text-']") : null;
    const timeEl = item ? item.querySelector("[class*='item-header-time'], [class*='time-']") : null;
    const timeText = timeEl ? norm(timeEl.textContent || '') : '';
    let lastText = content ? norm(content.textContent || '') : '';
    if (!lastText && item) {
      let rest = norm(item.textContent || '');
      if (timeText) rest = rest.replace(timeText, '');
      rest = rest.replace(n, '');
      lastText = rest.slice(0, 160);
    }
    out.push({
      peerName: n,
      lastText,
      time: timeText,
    });
  }
  return JSON.stringify(out);
})()"""


async def _douyin_open_chat_page(page) -> bool:
    current = await page.evaluate("location.href") or ""
    if "/data/following/chat" not in current:
        await page.goto(DOUYIN_CHAT_URL, wait_until="domcontentloaded", timeout=90000)
    ready = await _wait_for(page, DOUYIN_CHAT_READY_EXPR, 15000, 500)
    if not ready:
        # 页面被 204 守卫拦截或加载竞争时重载一次（与 Electron 相同 URL 的韧性策略）
        await page.goto(DOUYIN_CHAT_URL, wait_until="domcontentloaded", timeout=90000)
        ready = await _wait_for(page, DOUYIN_CHAT_READY_EXPR, 20000, 500)
    return bool(ready)


async def douyin_dm_list(page) -> dict:
    try:
        ready = await _douyin_open_chat_page(page)
    except Exception as exc:
        return {"ok": False, "conversations": [], "message": f"私信页加载失败: {exc}"}
    if not ready:
        return {"ok": False, "conversations": [], "message": "抖音私信管理页未加载（会话可能失效，请重新登录）"}
    raw = await _js(page, DOUYIN_LIST_CONVERSATIONS_EXPR)
    try:
        rows = json.loads(raw or "[]")
    except (TypeError, ValueError):
        rows = []
    conversations = [
        {
            "sessionId": f"name:{row.get('peerName') or ''}",
            "peerName": row.get("peerName") or "",
            "lastText": row.get("lastText") or "",
            "time": row.get("time") or "",
        }
        for row in rows
        if isinstance(row, dict) and row.get("peerName")
    ]
    return {"ok": True, "conversations": conversations}


DOUYIN_OPEN_CONVERSATION_EXPR_TMPL = r"""(() => {
  for (const el of document.querySelectorAll('[data-zhiyin-dm]')) el.removeAttribute('data-zhiyin-dm');
  const norm = (s = '') => String(s).replace(/\s+/g, ' ').trim();
  const wanted = PLACEHOLDER_PEER;
  const target = [...document.querySelectorAll("[class*='item-header-name']")].find(el => {
    const n = norm(el.textContent || '');
    return n === wanted || n.includes(wanted) || wanted.includes(n);
  });
  if (!target) return null;
  let item = target;
  for (let i = 0; i < 8 && item && item !== document.body; i++) {
    if (item.tagName === 'LI') break;
    item = item.parentElement;
  }
  const clickable = item && item.tagName === 'LI' ? item : target;
  clickable.scrollIntoView({ block: 'center', behavior: 'instant' });
  clickable.setAttribute('data-zhiyin-dm', '1');
  return 'OK_CLICKED';
})()"""


DOUYIN_EXTRACT_MESSAGES_EXPR = r"""(() => {
  const norm = (s = '') => String(s).replace(/\s+/g, ' ').trim();
  const out = [];
  const nodes = [...document.querySelectorAll("[class*='message'], [class*='msg'], [class*='bubble']")];
  for (const el of nodes) {
    // 只取最内层气泡，避免整段会话容器被当成一条消息
    if (el.querySelector("[class*='message'], [class*='msg'], [class*='bubble']")) continue;
    const text = norm(el.innerText || '');
    if (!text || text.length > 2000) continue;
    const own = (el.className || '') + ' ' + ((el.parentElement && el.parentElement.className) || '');
    out.push({ text, from: /self|right|mine|from-me|is-me|out-/i.test(own) ? 'me' : 'customer' });
  }
  return JSON.stringify(out);
})()"""


async def _douyin_open_conversation(page, peer_name: str):
    """打开抖音某个私信会话，返回 (iframe, 错误信息)。"""
    try:
        ready = await _douyin_open_chat_page(page)
    except Exception as exc:
        return None, f"私信页加载失败: {exc}"
    if not ready:
        return None, "抖音私信管理页未加载"
    # 滚动到会话行并用真实鼠标事件点击（Semi 列表 JS click 不触发打开）
    point = await _js(
        page,
        DOUYIN_OPEN_CONVERSATION_EXPR_TMPL.replace("PLACEHOLDER_PEER", json.dumps(peer_name)),
    )
    if point != "OK_CLICKED":
        return None, f"未找到会话：{peer_name}"
    coords = await page.evaluate(
        r"""(() => {
          const el = document.querySelector('[data-zhiyin-dm="1"]');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return JSON.stringify({ x: Math.round(r.x + 90), y: Math.round(r.y + r.height / 2) });
        })()"""
    )
    if coords:
        try:
            pt = json.loads(coords)
        except (TypeError, ValueError):
            pt = None
        if pt:
            await page.mouse.click(pt["x"], pt["y"])
    # 会话聊天在 summon.bytedance.com 内嵌 iframe 中渲染（新版创作者私信）
    for _ in range(20):
        await asyncio.sleep(1)
        for frame in page.frames:
            if "summon.bytedance.com" in (frame.url or ""):
                try:
                    has_input = await frame.evaluate(
                        "!!(document.querySelector(\"[contenteditable='true']\") || document.querySelector('textarea'))"
                    )
                except Exception:
                    has_input = False
                if has_input:
                    return frame, None
    return None, "私信会话聊天面板未打开（该会话可能需在新版聊天窗口处理）"


async def douyin_dm_history(page, peer_name: str) -> dict:
    """打开会话并读取消息气泡，供「查看原对话」展示。"""
    if not peer_name:
        return {"ok": False, "messages": [], "message": "缺少会话对象"}
    im_frame, error = await _douyin_open_conversation(page, peer_name)
    if im_frame is None:
        return {"ok": False, "messages": [], "message": error or "会话未打开"}
    # 向上滚动加载历史消息，再抽取气泡
    for _ in range(6):
        await im_frame.evaluate(
            r"""(() => {
              const box = [...document.querySelectorAll('div')].find(el => el.scrollHeight > el.clientHeight + 200 && el.clientHeight > 200);
              if (!box) return 'no_box';
              box.scrollTop = 0;
              return 'ok';
            })()"""
        )
        await asyncio.sleep(random.uniform(0.6, 1.1))
    raw = await im_frame.evaluate(DOUYIN_EXTRACT_MESSAGES_EXPR)
    try:
        rows = json.loads(raw or "[]")
    except (TypeError, ValueError):
        rows = []
    messages = [
        {"from": row.get("from") or "customer", "text": row.get("text") or "", "time": ""}
        for row in rows
        if isinstance(row, dict) and row.get("text")
    ]
    if not messages:
        return {"ok": False, "messages": [], "message": "未在会话面板中读到消息（平台可能改版）"}
    return {"ok": True, "messages": messages}


async def xhs_dm_history(context, storage_file: Path, session_id: str) -> dict:
    """小红书官方 IM 历史端点读取整段会话（无需签名）。"""
    if not session_id:
        return {"ok": False, "messages": [], "message": "缺少会话 id"}
    cookie_header = _cookie_header(storage_file)
    try:
        response = await context.request.get(
            XHS_IM_HISTORY_URL.format(sid=session_id),
            headers={
                "Referer": "https://www.xiaohongshu.com/",
                "Origin": "https://www.xiaohongshu.com",
                "Cookie": cookie_header,
            },
        )
        data = await response.json()
    except Exception as exc:
        return {"ok": False, "messages": [], "message": f"IM 历史接口失败: {exc}"}
    code = (data or {}).get("code") if isinstance(data, dict) else None
    if code not in (None, 0):
        message = str((data or {}).get("msg") or code)
        return {"ok": False, "messages": [], "message": f"平台风控/未登录（{code}）：{message}"}
    raw = ((data or {}).get("data") or {}).get("messages") or []
    messages = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        text = _xhs_im_last_text(item)
        if not text:
            continue
        sender = str(item.get("sender_id") or item.get("from_user_id") or item.get("user_id") or "")
        if sender == "":
            who = "unknown"
        else:
            who = "me" if sender != session_id else "customer"
        messages.append({
            "from": who,
            "text": text,
            "time": str(item.get("created_at") or item.get("time") or ""),
        })
    messages.reverse()
    if not messages:
        return {"ok": False, "messages": [], "message": "平台上没有读到该会话的消息"}
    return {"ok": True, "messages": messages}


async def douyin_dm_reply(page, peer_name: str, content: str) -> dict:
    if not peer_name or not (content or "").strip():
        return {"ok": False, "status": "error", "message": "会话或内容为空"}
    im_frame, error = await _douyin_open_conversation(page, peer_name)
    if im_frame is None:
        return {"ok": False, "status": "open_failed", "message": error or "会话未打开"}
    await asyncio.sleep(random.uniform(0.8, 1.5))
    await im_frame.evaluate(
        r"""(() => {
          const el = document.querySelector("[contenteditable='true']");
          el.scrollIntoView({ block: 'center' });
          el.focus();
          return document.activeElement === el;
        })()"""
    )
    await asyncio.sleep(0.4)
    for seg in _chunks(content, 10):
        await page.keyboard.type(seg, delay=random.randint(60, 160))
    await asyncio.sleep(0.5)
    await im_frame.evaluate(
        r"""(() => {
          const el = document.querySelector("[contenteditable='true']");
          if (!el) return 'no_input';
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '' }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return 'ok';
        })()""",
    )
    await asyncio.sleep(0.6)
    probe = content[:6]
    verified = await im_frame.evaluate(
        f"(() => {{ const el = document.querySelector(\"[contenteditable='true']\"); "
        f"return !!el && (el.textContent || '').includes({json.dumps(probe)}); }})()"
    )
    if not verified:
        return {"ok": False, "status": "input_failed", "message": "私信文本输入失败"}
    btn_state = await im_frame.evaluate(
        r"""(() => {
          const btn = document.querySelector("button.semi-button-primary.chat-btn")
            || [...document.querySelectorAll('button')].find(b => /^(发送|发 送)$/.test((b.innerText || '').trim()));
          if (!btn) return 'no_btn';
          return btn.disabled ? 'disabled' : 'ok';
        })()""",
    )
    if btn_state != "ok":
        return {"ok": False, "status": "send_click_failed", "message": "发送按钮未启用"}
    clicked = await im_frame.evaluate(
        r"""(() => {
          const btn = document.querySelector("button.semi-button-primary.chat-btn")
            || [...document.querySelectorAll('button')].find(b => /^(发送|发 送)$/.test((b.innerText || '').trim()));
          if (!btn) return null;
          btn.click();
          return 'ok';
        })()""",
    )
    if clicked != "ok":
        return {"ok": False, "status": "send_click_failed", "message": "发送按钮点击失败"}
    confirmed = False
    for _ in range(16):
        await asyncio.sleep(0.5)
        try:
            confirmed = await im_frame.evaluate(
                r"""(() => {
                  const el = document.querySelector("[contenteditable='true']");
                  return !!el && !((el.textContent || '').trim());
                })()"""
            )
        except Exception:
            confirmed = False
        if confirmed:
            break
    failure_toast = await im_frame.evaluate(
        r"""(() => {
          const norm = (s = '') => String(s).replace(/\s+/g, ' ').trim();
          const texts = [...document.querySelectorAll('[role="alert"], div, span')]
            .filter(el => el instanceof HTMLElement && el.offsetParent !== null)
            .map(el => norm(el.textContent || ''))
            .filter(t => t && t.length < 80);
          const bad = texts.find(t => /(发送失败|消息失败|违规|风控|频繁|权限|未关注)/.test(t));
          return bad || '';
        })()""",
    )
    if failure_toast:
        return {"ok": False, "status": "platform_rejected", "message": f"平台拒绝发送私信：{failure_toast}"}
    if not confirmed:
        return {"ok": True, "status": "sent_unconfirmed", "message": "已点击发送但平台未确认"}
    return {"ok": True, "status": "sent", "message": "平台已发送（输入框清空）"}


# ============================== 通用 =========================================


def _chunks(text: str, size: int):
    for i in range(0, len(text), size):
        yield text[i : i + size]


async def run_task(task_dir: Path) -> int:
    input_file = task_dir / "input.json"
    state_file = task_dir / "state.json"

    def write_state(payload: dict) -> None:
        state_file.write_text(
            json.dumps({"finishedAt": time.strftime("%Y-%m-%dT%H:%M:%S+08:00"), **payload}, ensure_ascii=False),
            encoding="utf-8",
        )

    try:
        inp = json.loads(input_file.read_text(encoding="utf-8"))
    except Exception as exc:
        write_state({"status": "failed", "error": f"读取互动任务失败: {exc}"})
        return 1

    op = inp.get("op") or ""
    platform = inp.get("platform") or ""
    storage_file = Path(str(inp.get("storageFile") or ""))
    if not storage_file.is_file():
        write_state({"status": "failed", "error": "缺少平台登录态文件（账号未登录或 cookie 已失效）"})
        return 1

    pw = None
    browser = None
    try:
        pw, browser, context, shared = await _open_browser(storage_file, task_dir)
        page = await context.new_page()
        if platform == "douyin":
            await _block_douyin_messages_redirect(page)

        data: dict
        if op == "comments_list":
            if platform == "douyin":
                data = await douyin_comments_list(page, str(inp.get("workId") or ""), str(inp.get("workTitle") or ""), str(inp.get("createTime") or ""))
            elif platform == "xhs":
                data = await xhs_comments_list(page, str(inp.get("workId") or ""))
            else:
                write_state({"status": "failed", "error": f"不支持的平台: {platform}"})
                return 1
        elif op == "comment_reply":
            if platform == "douyin":
                data = await douyin_comment_reply(
                    page,
                    str(inp.get("workId") or ""),
                    str(inp.get("workTitle") or ""),
                    str(inp.get("commentText") or ""),
                    str(inp.get("username") or ""),
                    str(inp.get("replyText") or ""),
                )
            elif platform == "xhs":
                data = await xhs_comment_reply(page, str(inp.get("workId") or ""), str(inp.get("commentText") or ""), str(inp.get("replyText") or ""))
            else:
                write_state({"status": "failed", "error": f"不支持的平台: {platform}"})
                return 1
        elif op == "dm_list":
            if platform == "xhs":
                data = await xhs_dm_list(context, storage_file)
            elif platform == "douyin":
                data = await douyin_dm_list(page)
            else:
                write_state({"status": "failed", "error": f"不支持的平台: {platform}"})
                return 1
        elif op == "dm_reply":
            if platform == "xhs":
                data = await xhs_dm_reply(page, str(inp.get("sessionId") or ""), str(inp.get("replyText") or ""))
            elif platform == "douyin":
                data = await douyin_dm_reply(page, str(inp.get("peerName") or ""), str(inp.get("replyText") or ""))
            else:
                write_state({"status": "failed", "error": f"不支持的平台: {platform}"})
                return 1
        elif op == "conversation":
            # 「查看原对话」：私信读整段会话，评论读该作品下的评论线程（含本条与平台回复计数）。
            kind = str(inp.get("kind") or "dm")
            if kind == "dm":
                if platform == "xhs":
                    data = await xhs_dm_history(context, storage_file, str(inp.get("sessionId") or ""))
                elif platform == "douyin":
                    data = await douyin_dm_history(page, str(inp.get("peerName") or ""))
                else:
                    write_state({"status": "failed", "error": f"不支持的平台: {platform}"})
                    return 1
                data["kind"] = "dm"
            elif kind == "comment":
                work_id = str(inp.get("workId") or "")
                work_title = str(inp.get("workTitle") or "")
                if platform == "douyin":
                    listed = await douyin_comments_list(page, work_id, work_title, str(inp.get("createTime") or ""))
                elif platform == "xhs":
                    listed = await xhs_comments_list(page, work_id)
                else:
                    write_state({"status": "failed", "error": f"不支持的平台: {platform}"})
                    return 1
                comments = listed.get("comments") or []
                wanted_key = str(inp.get("commentKey") or "")
                wanted_text = str(inp.get("commentText") or "").strip()
                matched = next(
                    (row for row in comments if wanted_key and str(row.get("key") or "") == wanted_key),
                    None,
                )
                if matched is None and wanted_text:
                    matched = next(
                        (row for row in comments if str(row.get("commentText") or "").strip() == wanted_text),
                        None,
                    )
                data = {
                    "ok": bool(listed.get("ok")),
                    "kind": "comment",
                    "workId": work_id,
                    "workTitle": work_title,
                    "comment": matched or {"commentText": wanted_text, "username": str(inp.get("username") or ""), "key": wanted_key},
                    "comments": comments,
                    "messages": [],
                    "message": str(listed.get("message") or ("未在该作品的评论列表中找到这条评论" if matched is None else "")),
                }
            else:
                write_state({"status": "failed", "error": f"不支持的会话类型: {kind}"})
                return 1
        else:
            write_state({"status": "failed", "error": f"未知操作: {op}"})
            return 1

        write_state({"status": "done", "op": op, "platform": platform, "data": data})
        return 0
    except Exception as exc:
        write_state({"status": "failed", "error": f"平台互动引擎异常: {exc}"})
        return 1
    finally:
        if browser is not None and not locals().get("shared", False):
            try:
                await browser.close()
            except Exception:
                pass
        if pw is not None:
            try:
                await pw.stop()
            except Exception:
                pass


def main(argv: list[str]) -> int:
    if len(argv) != 3 or argv[1] != "run":
        print("用法: python interactions.py run <taskDir>", file=sys.stderr)
        return 2
    return asyncio.run(run_task(Path(argv[2]).resolve()))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
