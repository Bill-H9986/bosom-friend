# -*- coding: utf-8 -*-
"""确认 item_contribution_top 的取数上限与是否存在「全部作品播放量」列表接口（只读）。

用法：
  products/bosom-friend/engine/.venv/Scripts/python.exe products/bosom-friend/qa/probes/douyin-play-count-limit-recon.py
"""
import json
import sys
from pathlib import Path

from patchright.sync_api import sync_playwright

HOME = Path.home() / ".bosom-friend" / "bosom-friend"
SYNC_ROOT = HOME / "platform-login" / "sync"
OUT = Path(__file__).with_name("douyin-play-count-limit-recon.json")

PATHS = [
    "/janus/douyin/creator/data/overview/item_contribution_top?dimension=1&recent_days=7",
    "/janus/douyin/creator/data/overview/item_contribution_top?dimension=1&recent_days=7&count=50",
    "/janus/douyin/creator/data/overview/item_contribution_top?dimension=1&recent_days=7&limit=50",
    "/janus/douyin/creator/data/overview/item_contribution_top?dimension=1&recent_days=7&page_size=50",
    "/janus/douyin/creator/data/overview/item_contribution_top?dimension=1&recent_days=7&top_n=50",
    "/janus/douyin/creator/data/item/list?recent_days=7",
    "/janus/douyin/creator/data/item/data?recent_days=7",
    "/janus/douyin/creator/data/content/item?recent_days=7",
    "/janus/douyin/creator/data/overview/item?recent_days=7",
    "/janus/douyin/creator/data/overview/item_list?recent_days=7",
    "/janus/douyin/creator/data/overview/item_contribution?dimension=1&recent_days=7",
    "/janus/douyin/creator/data/overview/item_contribution_list?dimension=1&recent_days=7",
    "/janus/douyin/creator/data/overview/dashboard",
    "/janus/douyin/creator/data/overview/dashboard/item",
]


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
    dump = {}
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, channel="chrome")
        context = browser.new_context(storage_state=str(storage))
        page = context.new_page()
        page.goto("https://creator.douyin.com/creator-micro/content/manage", wait_until="domcontentloaded", timeout=90_000)
        page.wait_for_timeout(9000)
        for path in PATHS:
            body = page.evaluate("""async (url) => {
              const res = await fetch(url, { credentials: 'include' });
              const text = await res.text();
              try { return JSON.parse(text); } catch (e) { return { parse_error: text.slice(0, 120) }; }
            }""", path)
            dump[path] = body
            status = body.get("status_code")
            items = body.get("items")
            print("[" + str(status) + "] " + path.replace("/janus/douyin/creator/data/", ""))
            if isinstance(items, list):
                print("      items=" + str(len(items)) + " " + json.dumps(items[:3], ensure_ascii=False)[:200])
            else:
                print("      keys=" + json.dumps(list(body.keys())[:14], ensure_ascii=False) + " msg=" + str(body.get("status_msg"))[:40])
        browser.close()
    OUT.write_text(json.dumps(dump, ensure_ascii=False, indent=2), encoding="utf-8")
    print("saved: " + str(OUT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
