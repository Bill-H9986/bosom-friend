# -*- coding: utf-8 -*-
"""抖音图文上传页探针（2026-10-14 现场）：新版 UI 下 set_input_files 命中的元素失效，
导致「等图片上传完成」无限循环。本脚本只做**只读探测 + 上传尝试定位**：
列出页面上所有 file input 的结构与可见性，再逐个尝试 set_input_files / CDP，
观察 URL 是否进入 post/image。**绝不点击发布**。

用法：
    .venv/Scripts/python.exe _douyin_upload_probe.py <account_cookie.json> <out_prefix> <图片...>
"""
import asyncio
import json
import sys
from pathlib import Path

ENGINE_ROOT = Path(__file__).resolve().parent
VENDOR = ENGINE_ROOT / "social-auto-upload"
sys.path.insert(0, str(VENDOR))
sys.path.insert(0, str(ENGINE_ROOT))

from patchright.async_api import async_playwright  # noqa: E402
from uploader.douyin_uploader.main import _launch_persistent_browser  # noqa: E402
from utils.base_social_media import set_init_script  # noqa: E402

UPLOAD_PAGE = "https://creator.douyin.com/creator-micro/content/upload"


async def main() -> int:
    storage = Path(sys.argv[1]).resolve()
    out_prefix = Path(sys.argv[2]).resolve()
    images = [str(Path(p).resolve()) for p in sys.argv[3:]]
    result: dict = {}

    async with async_playwright() as pw:
        ctx = await _launch_persistent_browser(pw, str(storage), True)
        browser = None
        if ctx is None:
            browser = await pw.chromium.launch(
                headless=True,
                channel="chromium",
                args=["--no-sandbox", "--disable-blink-features=AutomationControlled"],
            )
            ctx = await browser.new_context(storage_state=str(storage), permissions=["geolocation"])
        ctx = await set_init_script(ctx)
        try:
            page = await ctx.new_page()
            await page.goto(UPLOAD_PAGE, wait_until="domcontentloaded", timeout=90_000)
            await page.wait_for_timeout(8_000)
            result["url"] = page.url
            result["bodyHead"] = (await page.evaluate("() => document.body ? document.body.innerText.slice(0, 400) : ''"))
            result["fileInputs"] = await page.evaluate(
                """() => Array.from(document.querySelectorAll('input[type=file]')).map((e, i) => {
                    const path = [];
                    let n = e;
                    while (n && n.nodeType === 1 && path.length < 6) { path.unshift(n.tagName.toLowerCase() + (n.className ? '.' + String(n.className).split(' ').join('.') : '')); n = n.parentElement; }
                    return {
                        i,
                        accept: e.getAttribute('accept') || '',
                        multiple: !!e.multiple,
                        hidden: e.hidden || e.style.display === 'none',
                        visible: !!(e.offsetWidth || e.offsetHeight),
                        parentPath: path.join(' > ').slice(0, 300),
                    };
                })"""
            )
            result["iframes"] = await page.evaluate("() => Array.from(document.querySelectorAll('iframe')).map(f => f.src).slice(0, 10)")
            await page.screenshot(path=str(out_prefix.with_suffix(".png")), full_page=True)

            # ① 先点「发布图文」页签（等它渲染出来再点；不复用 main.py 的 +1s 立即判定）。
            tab = page.get_by_text("发布图文", exact=True)
            try:
                await tab.first.wait_for(state="visible", timeout=20_000)
                await tab.first.click()
                result["tabClick"] = "ok"
            except Exception as exc:
                result["tabClick"] = "fail: " + str(exc)[:160]
            await page.wait_for_timeout(2_500)
            result["urlAfterTab"] = page.url
            result["fileInputsAfterTab"] = await page.evaluate(
                """() => Array.from(document.querySelectorAll('input[type=file]')).map((e, i) => ({
                    i,
                    accept: (e.getAttribute('accept') || '').slice(0, 60),
                    multiple: !!e.multiple,
                    visible: !!(e.offsetWidth || e.offsetHeight),
                    parentCls: (e.parentElement && e.parentElement.className ? String(e.parentElement.className) : '').slice(0, 80),
                }))"""
            )
            try:
                await page.screenshot(path=str(out_prefix.with_name(out_prefix.stem + "-aftertab.png")), full_page=True)
            except Exception:
                pass

            # ② 逐个 input 尝试 set_input_files，观察 URL 是否进入 post/image。
            attempts = []
            count = await page.locator("input[type=file]").count()
            for index in range(count):
                locator = page.locator("input[type=file]").nth(index)
                accept = await locator.get_attribute("accept") or ""
                if "image" not in accept:
                    continue
                try:
                    await locator.set_input_files(images, timeout=8_000)
                    outcome = "set_input_files_ok"
                except Exception as exc:
                    outcome = "set_input_files_fail: " + str(exc)[:120]
                moved = False
                try:
                    await page.wait_for_url("**/creator-micro/content/post/image**", timeout=6_000)
                    moved = True
                except Exception:
                    moved = False
                attempts.append({"index": index, "outcome": outcome, "enteredPostImage": moved, "url": page.url})
                if moved:
                    break
            # 一次都没动：再用 CDP 直接对图片输入下发一次。
            if not any(a["enteredPostImage"] for a in attempts):
                from uploader.douyin_uploader.main import _cdp_set_input_files

                ok = await _cdp_set_input_files(ctx, page, "input[accept*='image']", images)
                moved = False
                try:
                    await page.wait_for_url("**/creator-micro/content/post/image**", timeout=8_000)
                    moved = True
                except Exception:
                    moved = False
                attempts.append({"index": -1, "outcome": "cdp-image=" + str(ok), "enteredPostImage": moved, "url": page.url})
            result["attempts"] = attempts
            result["finalUrl"] = page.url
            try:
                await page.screenshot(path=str(out_prefix.with_name(out_prefix.stem + "-after.png")), full_page=True)
            except Exception:
                pass
        finally:
            print("PROBE_RESULT " + json.dumps(result, ensure_ascii=False))
            await asyncio.sleep(0.5)
            await ctx.close()
            if browser is not None:
                await browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
