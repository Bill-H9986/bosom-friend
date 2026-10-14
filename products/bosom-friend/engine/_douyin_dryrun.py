# -*- coding: utf-8 -*-
"""抖音发布 SOP 干跑验证：跑到「上传表单就绪 + 图片已装入 + 标题正文已填」即停，
**严禁点击发布**（本轮用户未授权外部发布副作用）。截图留证后优雅退出。

用法：
    .venv/Scripts/python.exe _douyin_dryrun.py <storage.json> <out_prefix> [图片1 图片2 ...]
"""
import asyncio
import json
import sys
from datetime import datetime
from pathlib import Path

ENGINE_ROOT = Path(__file__).resolve().parent
VENDOR = ENGINE_ROOT / "social-auto-upload"
sys.path.insert(0, str(VENDOR))

from patchright.async_api import async_playwright  # noqa: E402
from uploader.douyin_uploader.main import (  # noqa: E402
    DouYinNote,
    _launch_persistent_browser,
    _set_files_with_cdp_fallback,
)
from utils.base_social_media import set_init_script  # noqa: E402

UPLOAD_PAGE = "https://creator.douyin.com/creator-micro/content/upload"


async def main() -> int:
    storage = Path(sys.argv[1]).resolve()
    out_prefix = Path(sys.argv[2]).resolve()
    images = [Path(p).resolve() for p in sys.argv[3:]]
    title = "人社局无人机装调检修招工了！"
    note = "低空经济发展带动装调检修岗位需求，零基础也能系统学习，关注岗位信息即可了解详情。"
    tags = ["无人机", "技能科普"]

    up = DouYinNote(
        image_paths=[str(p) for p in images],
        note=note,
        tags=tags,
        publish_date=0,
        account_file=str(storage),
        title=title,
    )

    async with async_playwright() as pw:
        ctx = await _launch_persistent_browser(pw, str(storage), True)
        used_fallback = False
        browser = None
        if ctx is None:
            used_fallback = True
            browser = await pw.chromium.launch(
                headless=True,
                channel="chromium",
                args=["--no-sandbox", "--disable-blink-features=AutomationControlled"],
            )
            ctx = await browser.new_context(
                storage_state=str(storage),
                permissions=["geolocation"],
            )
        ctx = await set_init_script(ctx)
        result: dict = {"usedFallback": used_fallback}
        try:
            page = await ctx.new_page()
            await page.goto(UPLOAD_PAGE, wait_until="domcontentloaded", timeout=90000)
            await page.wait_for_url(UPLOAD_PAGE, timeout=90000)

            # 诊断：登录态核对（cookie 是否真的注入并生效）
            from uploader.douyin_uploader.main import _has_douyin_login_cookie, _verify_douyin_login
            nav_cookies = await ctx.cookies()
            login_ok, login_profile = await _verify_douyin_login(page, ctx)
            result["loginCheck"] = {
                "cookieCount": len(nav_cookies),
                "hasSess": _has_douyin_login_cookie(nav_cookies),
                "verified": login_ok,
                "profile": login_profile,
                "url": page.url[:90],
            }

            # 反检测核验：navigator.webdriver 必须为 falsy
            result["navigatorWebdriver"] = await page.evaluate("() => navigator.webdriver")

            # 切到图文 tab 并上传图片（含 CDP 兜底）
            diag_tab = page.get_by_text("发布图文", exact=True)
            try:
                await diag_tab.click(timeout=15000)
            except Exception:
                # 诊断：截图 + 抓页面可见文本与 URL，弄清页面到底渲染成了什么
                await page.screenshot(path=str(out_prefix.with_name(out_prefix.stem + "-diag-tab.png")), full_page=True)
                result["diag"] = {
                    "url": page.url,
                    "bodyText": (await page.evaluate("() => document.body ? document.body.innerText.slice(0, 600) : ''")),
                }
                raise
            await page.wait_for_timeout(1000)
            await _set_files_with_cdp_fallback(
                page.context,
                page,
                page.locator("div[class^='container'] input[accept*='image']"),
                "div[class^='container'] input[type=file]",
                [str(p) for p in images],
            )
            result["filesLoaded"] = True

            # 等进入图文发布页
            entered = False
            for _ in range(150):
                try:
                    await page.wait_for_url("**/creator-micro/content/post/image?**", timeout=3000)
                    entered = True
                    break
                except Exception:
                    await asyncio.sleep(1)
            result["enteredPostImage"] = entered
            if not entered:
                raise RuntimeError("未进入图文发布页")

            await asyncio.sleep(1)
            try:
                await up.fill_title_and_description(page, title, note, tags)
            except Exception:
                # 诊断：截图 + 列出页面所有输入框 placeholder 与 contenteditable，弄清图文页表单结构
                await page.screenshot(path=str(out_prefix.with_name(out_prefix.stem + "-diag-form.png")), full_page=True)
                result["diagForm"] = await page.evaluate(
                    """() => ({
                        inputs: Array.from(document.querySelectorAll('input,textarea')).map(e => ({
                            tag: e.tagName, placeholder: e.placeholder || '', visible: !!(e.offsetWidth || e.offsetHeight),
                        })),
                        editables: Array.from(document.querySelectorAll('[contenteditable="true"]')).map(e => ({
                            cls: (e.className || '').toString().slice(0, 80), ph: e.getAttribute('data-placeholder') || '', text: (e.innerText || '').slice(0, 40),
                        })),
                    })"""
                )
                raise

            # 表单就绪核验
            title_value = await page.locator('input[placeholder*="作品标题"]').input_value()
            body_text = await page.locator('div.zone-container[contenteditable="true"]').inner_text()
            publish_btn = page.get_by_role("button", name="发布", exact=True)
            result["formReady"] = {
                "url": page.url,
                "titleFilled": title_value,
                "bodyHead": body_text.replace("\n", " ")[:60],
                "publishBtnVisible": bool(await publish_btn.count()),
                "imageCount": await page.locator("img[src*='douyinpic']").count(),
            }
            await page.screenshot(path=str(out_prefix.with_suffix(".png")), full_page=True)
        finally:
            # 干跑红线：绝不点发布。优雅退出，不强杀进程。
            print("DRYRUN_RESULT " + json.dumps(result, ensure_ascii=False))
            await asyncio.sleep(1)
            await ctx.close()
            if browser is not None:
                await browser.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
