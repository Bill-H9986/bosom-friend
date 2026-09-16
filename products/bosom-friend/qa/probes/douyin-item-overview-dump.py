# -*- coding: utf-8 -*-
"""打印抖音 /janus/douyin/creator/data/item_analysis/overview 的完整响应（只读）。

用法：
  products/bosom-friend/engine/.venv/Scripts/python.exe products/bosom-friend/qa/probes/douyin-item-overview-dump.py
"""
import json
import sys
from pathlib import Path

from patchright.sync_api import sync_playwright

HOME = Path.home() / ".bosom-friend" / "bosom-friend"
SYNC_ROOT = HOME / "platform-login" / "sync"
OUT = Path(__file__).with_name("douyin-item-overview.json")


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

        ids = page.evaluate("""async () => {
          const res = await fetch('/janus/douyin/creator/pc/work_list?status=0&count=5&max_cursor=0', { credentials: 'include' });
          const data = await res.json();
          return (data.aweme_list || []).map(x => String(x.aweme_id || ''));
        }""")
        print("sample ids: " + json.dumps(ids))

        dump = {}
        for item_id in ids[:3]:
            body = page.evaluate("""async (itemId) => {
              const res = await fetch('/janus/douyin/creator/data/item_analysis/overview?item_id=' + itemId, { credentials: 'include' });
              return await res.json();
            }""", item_id)
            dump[item_id] = body
            print("")
            print("=== item " + item_id + " ===")
            print(json.dumps(body, ensure_ascii=False, indent=2)[:2500])

        top = page.evaluate("""async () => {
          const res = await fetch('/janus/douyin/creator/data/overview/item_contribution_top?dimension=1&recent_days=7', { credentials: 'include' });
          return await res.json();
        }""")
        dump["_contribution_top"] = top
        print("")
        print("=== item_contribution_top ===")
        print(json.dumps(top, ensure_ascii=False, indent=2)[:1500])
        browser.close()

    OUT.write_text(json.dumps(dump, ensure_ascii=False, indent=2), encoding="utf-8")
    print("saved: " + str(OUT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
