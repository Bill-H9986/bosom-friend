# -*- coding: utf-8 -*-
"""按原文取 item_contribution_top 的 item_id（只读）。

page.evaluate 把响应当 JavaScript 值交回来，19 位 aweme_id 超出 double 精度会被四舍五入
（7682660673825869000 结尾三个 0 就是被抹掉的低位）。必须取响应原文，再用 Python 的
int 精确解析，否则会把播放量挂到错误的作品上。

用法：
  products/bosom-friend/engine/.venv/Scripts/python.exe products/bosom-friend/qa/probes/douyin-item-id-precision.py
"""
import json
import sys
from pathlib import Path

from patchright.sync_api import sync_playwright

HOME = Path.home() / ".bosom-friend" / "bosom-friend"
SYNC_ROOT = HOME / "platform-login" / "sync"


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
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, channel="chrome")
        context = browser.new_context(storage_state=str(storage))
        page = context.new_page()
        page.goto("https://creator.douyin.com/creator-micro/content/manage", wait_until="domcontentloaded", timeout=90_000)
        page.wait_for_timeout(9000)

        raw = page.evaluate("""async () => {
          const res = await fetch('/janus/douyin/creator/data/overview/item_contribution_top?dimension=1&recent_days=7', { credentials: 'include' });
          return await res.text();
        }""")
        print("=== raw text (exact) ===")
        print(raw[:600])
        body = json.loads(raw)
        for entry in body.get("items") or []:
            print("exact item_id = " + str(entry["item_id"]) + " (" + str(len(str(entry["item_id"]))) + " digits) value=" + str(entry["metric_value"]))

        # 作品列表也按原文取，确认这条作品在不在账号自己的作品列表里
        raw_list = page.evaluate("""async () => {
          const res = await fetch('/janus/douyin/creator/pc/work_list?status=0&count=50&max_cursor=0', { credentials: 'include' });
          return await res.text();
        }""")
        listing = json.loads(raw_list)
        awemes = listing.get("aweme_list") or []
        print("")
        print("work_list items = " + str(len(awemes)) + " has_more=" + str(listing.get("has_more")) + " max_cursor=" + str(listing.get("max_cursor")))
        ids = [str(a.get("aweme_id")) for a in awemes]
        print("ids = " + json.dumps(ids))
        target = str((body.get("items") or [{}])[0].get("item_id")) if body.get("items") else ""
        print("target in work_list: " + str(target in ids))
        browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
