# -*- coding: utf-8 -*-
"""确认分析接口给出的 item_id 是不是本账号真实作品（只读）。

比对两个作品列表接口：/aweme/v1/creator/item/list/（worker 现在用的）与
/janus/.../pc/work_list（页面用的），看它们各自枚举到哪些作品、是否包含分析接口那条。

用法：
  products/bosom-friend/engine/.venv/Scripts/python.exe products/bosom-friend/qa/probes/douyin-item-membership.py
"""
import json
import sys
from pathlib import Path

from patchright.sync_api import sync_playwright

HOME = Path.home() / ".bosom-friend" / "bosom-friend"
SYNC_ROOT = HOME / "platform-login" / "sync"
TARGET = "7682660673825869119"


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

        # 旧接口分页到底
        ids = []
        cursor = 0
        for _ in range(20):
            raw = page.evaluate("""async (cursor) => {
              const res = await fetch('/aweme/v1/creator/item/list/?cursor=' + cursor + '&count=20', { credentials: 'include' });
              return await res.text();
            }""", cursor)
            try:
                body = json.loads(raw)
            except Exception:
                print("parse failed: " + raw[:150])
                break
            items = body.get("item_info_list") or []
            for item in items:
                ids.append(str(item.get("item_id_plain") or item.get("item_id") or ""))
            print("cursor=" + str(cursor) + " items=" + str(len(items)) + " has_more=" + str(body.get("has_more")) + " next=" + str(body.get("next_cursor") or body.get("max_cursor")))
            if not body.get("has_more"):
                break
            next_cursor = body.get("next_cursor") or body.get("max_cursor")
            if not next_cursor or int(next_cursor) == cursor:
                break
            cursor = int(next_cursor)

        print("")
        print("item/list total ids = " + str(len(ids)))
        print("ids = " + json.dumps(ids))
        print("TARGET in item/list: " + str(TARGET in ids))

        raw = page.evaluate("""async () => {
          const res = await fetch('/janus/douyin/creator/pc/work_list?status=0&count=50&max_cursor=0', { credentials: 'include' });
          return await res.text();
        }""")
        listing = json.loads(raw)
        page_ids = [str(a.get("aweme_id")) for a in (listing.get("aweme_list") or [])]
        print("work_list total ids = " + str(len(page_ids)) + " TARGET in work_list: " + str(TARGET in page_ids))
        print("only in item/list: " + json.dumps(sorted(set(ids) - set(page_ids))))
        print("only in work_list: " + json.dumps(sorted(set(page_ids) - set(ids))))
        browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
