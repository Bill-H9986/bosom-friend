# -*- coding: utf-8 -*-
"""抖音内容管理页的作品指标列侦察（只读）：看页面上到底显示了哪些指标、数字是多少，
用来判断「播放量」在界面上有没有真值，以及它是从哪个接口来的。不发布、不改数据。

用法：
  products/bosom-friend/engine/.venv/Scripts/python.exe products/bosom-friend/qa/probes/douyin-manage-metrics-recon.py
"""
import json
import sys
from pathlib import Path

from patchright.sync_api import sync_playwright

HOME = Path.home() / ".bosom-friend" / "bosom-friend"
SYNC_ROOT = HOME / "platform-login" / "sync"
BASE = Path(__file__).with_name("douyin-manage-metrics-recon")


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

    captures = {}
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, channel="chrome")
        context = browser.new_context(storage_state=str(storage))
        page = context.new_page()

        def on_response(response):
            url = response.url
            if "work_list" not in url and "item/list" not in url:
                return
            try:
                captures[url] = response.json()
            except Exception:
                pass

        page.on("response", on_response)
        page.goto("https://creator.douyin.com/creator-micro/content/manage", wait_until="domcontentloaded", timeout=90_000)
        page.wait_for_timeout(12000)

        text = page.evaluate("() => document.body.innerText")
        (BASE.with_suffix(".txt")).write_text(text, encoding="utf-8")
        print("page text length=" + str(len(text)))

        dom = page.evaluate("""() => {
          const cards = [...document.querySelectorAll('[class*=work-card], [class*=content-card], [class*=item-card]')];
          const rows = cards.length > 0 ? cards : [...document.querySelectorAll('[class*=card]')].slice(0, 3);
          return rows.slice(0, 2).map(el => {
            const metrics = [...el.querySelectorAll('*')].filter(e => e.children.length === 0 && (e.innerText || '').trim() !== '')
              .map(e => (e.innerText || '').trim());
            return { className: el.className.slice(0, 80), leaves: metrics.slice(0, 40) };
          });
        }""")
        (BASE.with_suffix(".dom.json")).write_text(json.dumps(dom, ensure_ascii=False, indent=2), encoding="utf-8")
        print("=== first work card leaves ===")
        for card in dom:
            print("  class=" + card["className"])
            print("  leaves=" + json.dumps(card["leaves"], ensure_ascii=False)[:600])
        browser.close()

    for url, body in captures.items():
        clean = url.split("?")[0]
        items = body.get("aweme_list") or body.get("item_info_list") or []
        print("")
        print("=== " + clean + " items=" + str(len(items)))
        for raw in items[:3]:
            stats = raw.get("statistics") or {}
            print("   item=" + str(raw.get("aweme_id") or raw.get("item_id")) + " statistics=" + json.dumps(stats, ensure_ascii=False))
            print("   top_keys=" + json.dumps(list(raw.keys())[:30], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
