# -*- coding: utf-8 -*-
"""确认 item_contribution_top 里的 item_id 到底是哪种作品（只读）。

用法：
  products/bosom-friend/engine/.venv/Scripts/python.exe products/bosom-friend/qa/probes/douyin-item-identity.py
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

        paths = [
            "/aweme/v1/creator/item/detail/?item_id=" + TARGET,
            "/web/api/creator/item/detail?item_id=" + TARGET,
            "/janus/douyin/creator/pc/item/detail?item_id=" + TARGET,
            "/aweme/v1/creator/item/list/?item_ids=" + TARGET,
            "/janus/douyin/creator/pc/work_list?status=0&count=50&max_cursor=0&item_ids=" + TARGET,
        ]
        for path in paths:
            raw = page.evaluate("""async (url) => {
              const res = await fetch(url, { credentials: 'include' });
              return await res.text();
            }""", path)
            print("[" + path.split("?")[0] + "] " + raw[:300])
            print("")

        # 在创作者中心直接搜这条作品
        found = page.evaluate("""async (target) => {
          for (const status of [0, 1, 2, 3, 6]) {
            const res = await fetch('/janus/douyin/creator/pc/work_list?status=' + status + '&count=50&max_cursor=0', { credentials: 'include' });
            const text = await res.text();
            if (text.includes(target)) return { status, hit: true, length: text.length };
          }
          return { hit: false };
        }""", TARGET)
        print("search across status filters -> " + json.dumps(found, ensure_ascii=False))

        # 公开网页上看这条作品存不存在
        public_view = context.new_page()
        try:
            public_view.goto("https://www.douyin.com/video/" + TARGET, wait_until="domcontentloaded", timeout=60_000)
            public_view.wait_for_timeout(6000)
            text = public_view.evaluate("() => document.body.innerText")
            print("")
            print("=== public page text (first 400) ===")
            print(text[:400])
        except Exception as exc:
            print("public page failed: " + str(exc)[:150])
        browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
