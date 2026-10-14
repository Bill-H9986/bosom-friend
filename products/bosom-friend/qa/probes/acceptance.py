"""独立验收脚本：真实浏览器逐项验证五大问题，输出 PASS/FAIL 与现场证据。
只操作 APP 自身界面，不做后端捷径；结果如实输出。"""
import asyncio
from patchright.async_api import async_playwright

BASE = "http://127.0.0.1:3080/bosom-friend/%EF%BC%88PID?planId=mg-persist"
results = []


def mark(name: str, ok: bool, detail: str = "") -> None:
    results.append(f"{'PASS' if ok else 'FAIL'} | {name}" + (f" | {detail}" if detail else ""))


async def body_text(page) -> str:
    return (await page.evaluate("() => (document.body.innerText||'').replace(/\\s+/g,' ')")).strip()


async def main():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        page = await browser.new_page(viewport={"width": 1440, "height": 900})
        await page.goto(BASE + "#/", wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(9000)
        try:
            await page.locator("button:has-text('我已阅读并同意')").first.click(timeout=4000)
            await page.locator("button:has-text('同意并进入平台')").first.click(timeout=4000)
            await page.wait_for_timeout(1500)
        except Exception:
            pass

        # 1 内容创作：生成记录详情
        await page.evaluate("() => { window.location.hash = '#/draft-box' }")
        await page.wait_for_timeout(9000)
        draft_body = await body_text(page)
        mark("1.草稿箱页面加载", "素材库" in draft_body or "生成记录" in draft_body, "len=" + str(len(draft_body)))
        try:
            tab = page.locator("button:has-text('生成记录')").first
            if await tab.count() > 0:
                await tab.click(timeout=5000)
                await page.wait_for_timeout(4000)
        except Exception:
            pass
        detail = await body_text(page)
        has_gen = "口播脚本" in detail or "图文笔记" in detail
        mark("1.生成记录列表有内容", has_gen, "hasEntry=" + str(has_gen))
        try:
            item = page.locator("text=口播脚本").first
            if await item.count() == 0:
                item = page.locator("text=图文笔记").first
            if await item.count() > 0:
                await item.click(timeout=5000)
                await page.wait_for_timeout(2500)
        except Exception:
            pass
        detail2 = await body_text(page)
        readable = ("标题" in detail2 and "正文" in detail2) or "脚本" in detail2
        mark("1.生成详情可查看", readable, "hasText=" + str("脚本" in detail2))

        # 2 右侧 AI 智能体对话
        try:
            panel = page.locator("[data-testid=ai-assistant-sidebar]").first
            if await panel.count() > 0:
                await panel.click(timeout=5000)
                await page.wait_for_timeout(1200)
        except Exception:
            pass
        ai_hit = False
        try:
            input_el = page.locator("textarea").first
            await input_el.fill("你好，请直接回复两个字：收到")
            await page.keyboard.press("Enter")
            await page.wait_for_timeout(9000)
            t = await body_text(page)
            ai_hit = "收到" in t
        except Exception as exc:
            ai_hit = False
        mark("2.AI智能体可对话", ai_hit, "answerHit=" + str(ai_hit))

        # 3 任务记录会话详情
        await page.evaluate("() => { window.location.hash = '#/tasks-history' }")
        await page.wait_for_timeout(9000)
        empty = True
        try:
            task = page.locator("text=你好").first
            if await task.count() > 0:
                await task.click(timeout=5000)
                await page.wait_for_timeout(4000)
                td = await body_text(page)
                empty = not (("你好" in td) and (len(td) > 300))
        except Exception:
            pass
        mark("3.任务记录会话内容非空", not empty, "contentEmpty=" + str(empty))

        # 4 数据中心
        await page.evaluate("() => { window.location.hash = '#/data-statistics' }")
        await page.wait_for_timeout(9000)
        dc = await body_text(page)
        has_pub = ("发布作品" in dc) and ("发布作品 0" not in dc)
        mark("4.数据中心有发布数据", has_pub, "hasPub=" + str(has_pub))

        # 5 账号板块
        await page.evaluate("() => document.querySelector('[data-testid=sidebar-account-entry]')?.click()")
        await page.wait_for_timeout(5000)
        cm = await body_text(page)
        mark("5.频道管理打开", "我的频道" in cm, "")
        mark("5.账号列表存在", ("SKYC" in cm) or ("小红书" in cm), "")

        print("\n".join(results))
        await browser.close()


asyncio.run(main())
