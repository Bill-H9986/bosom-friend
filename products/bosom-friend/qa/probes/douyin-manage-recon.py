# -*- coding: utf-8 -*-
"""抖音作品数据入口侦察（只读）：看清 content/manage 页上有哪些「数据/分析」入口，
以及点进去之后到底调哪个接口拿到单作品真实播放量。不发布、不改数据。

用法：
  products/bosom-friend/engine/.venv/Scripts/python.exe products/bosom-friend/qa/probes/douyin-manage-recon.py
"""
import json
import re
import sys
from pathlib import Path

from patchright.sync_api import sync_playwright

HOME = Path.home() / ".bosom-friend" / "bosom-friend"
SYNC_ROOT = HOME / "platform-login" / "sync"
OUT = Path(__file__).with_name("douyin-manage-recon.json")


def find_storage():
    if not SYNC_ROOT.exists():
        return None
    for item in sorted(SYNC_ROOT.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        file = item / "storage.json"
        if not file.exists():
            continue
        try:
            payload = json.loads(file.read_text(encoding="utf-8"))
        except Exception:
            continue
        if any("douyin" in str(c.get("domain", "")) for c in payload.get("cookies") or []):
            return file
    return None


def main() -> int:
    storage = find_storage()
    if storage is None:
        print("NO_DOUYIN_STORAGE")
        return 1
    print("storage: " + storage.parent.name)

    urls = []
    bodies = {}
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, channel="chrome")
        context = browser.new_context(storage_state=str(storage))
        page = context.new_page()

        def on_response(response):
            url = response.url
            if any(skip in url for skip in ("/log/", "slardar", "volces", "monitor_browser", ".png", ".jpg", ".css", ".js")):
                return
            if "/janus/" not in url and "/web/api/" not in url and "/aweme/" not in url:
                return
            urls.append(url)
            try:
                bodies[url] = response.json()
            except Exception:
                bodies[url] = None

        page.on("response", on_response)
        page.goto("https://creator.douyin.com/creator-micro/content/manage", wait_until="domcontentloaded", timeout=90_000)
        page.wait_for_timeout(10000)

        info = bodies.get("https://creator.douyin.com/aweme/v1/creator/user/info/", {}) or {}
        print("has_data_mgmt_perm=" + str(info.get("has_data_mgmt_perm")))
        print("permissions=" + json.dumps(info.get("permissions"), ensure_ascii=False)[:400])

        report = page.evaluate("""() => {
          const text = document.body.innerText.replace(/\s+/g, ' ').slice(0, 1200);
          const links = [...document.querySelectorAll('a')].map(a => (a.innerText || '').trim() + ' -> ' + a.getAttribute('href')).filter(s => s.length > 4).slice(0, 40);
          const buttons = [...document.querySelectorAll('button, [role=button], .semi-button')].map(b => (b.innerText || '').trim()).filter(s => s.length > 0).slice(0, 40);
          const rows = [...document.querySelectorAll('[class*=work], [class*=item], [class*=card]')].length;
          return { text, links, buttons, rows };
        }""")
        print("")
        print("=== page text ===")
        print(report["text"])
        print("")
        print("=== links ===")
        for line in report["links"]:
            print("  " + line)
        print("=== buttons ===")
        print("  " + " | ".join(report["buttons"]))

        # 点第一个作品的「数据」入口，抓点进去之后的接口。
        clicked = False
        for label in ("数据", "作品数据", "数据分析", "查看数据"):
            try:
                target = page.locator("text=" + label).first
                if target.count() > 0:
                    before = len(urls)
                    target.click(timeout=5000)
                    page.wait_for_timeout(8000)
                    print("")
                    print("clicked '" + label + "', new responses: " + str(len(urls) - before))
                    for url in urls[before:]:
                        print("  " + url[:180])
                    clicked = True
                    break
            except Exception as exc:
                print("click '" + label + "' failed: " + str(exc)[:100])
        if not clicked:
            print("no data entry clicked")

        print("")
        print("current url: " + page.url)
        browser.close()

    interesting = []
    for url, body in bodies.items():
        numbers = []

        def walk(node, prefix="", depth=0):
            if depth > 6:
                return
            if isinstance(node, dict):
                for key, value in node.items():
                    path = prefix + "." + key if prefix else key
                    if isinstance(value, (int, float)) and not isinstance(value, bool) and re.search(r"play|view|vv|show|exposure|digg|comment|share|collect|statistic", key, re.I):
                        numbers.append((path, value))
                    walk(value, path, depth + 1)
            elif isinstance(node, list):
                for index, value in enumerate(node[:2]):
                    walk(value, prefix + "[" + str(index) + "]", depth + 1)

        walk(body)
        if numbers:
            interesting.append({"url": url[:200], "metrics": numbers[:20]})

    OUT.write_text(json.dumps({"urls": urls, "interesting": interesting}, ensure_ascii=False, indent=2), encoding="utf-8")
    print("")
    print("=== responses with metric-looking fields ===")
    for item in interesting:
        print("  " + item["url"])
        print("      " + json.dumps(item["metrics"], ensure_ascii=False)[:400])
    print("saved: " + str(OUT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
