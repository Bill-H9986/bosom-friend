# -*- coding: utf-8 -*-
"""抖音单作品真实播放量接口族探测（只读）。

已确认：/janus/douyin/creator/data/overview/item_contribution_top?dimension=1&recent_days=7
返回 english_metric_name=play_cnt、metric_name=播放量，items[].metric_value 是真实播放量。
本脚本把 dimension / recent_days 组合与单作品接口一起打一遍，确定能拿到「按作品播放量」的最全口径。

用法：
  products/bosom-friend/engine/.venv/Scripts/python.exe products/bosom-friend/qa/probes/douyin-play-count-recon.py
"""
import json
import sys
from pathlib import Path

from patchright.sync_api import sync_playwright

HOME = Path.home() / ".bosom-friend" / "bosom-friend"
SYNC_ROOT = HOME / "platform-login" / "sync"
OUT = Path(__file__).with_name("douyin-play-count-recon.json")


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

        for dimension in (1, 2, 3, 4, 5, 6, 7, 8):
            for days in (7, 30, 90):
                key = "dim" + str(dimension) + "_d" + str(days)
                body = page.evaluate("""async (args) => {
                  const res = await fetch('/janus/douyin/creator/data/overview/item_contribution_top?dimension=' + args.d + '&recent_days=' + args.n, { credentials: 'include' });
                  return await res.json();
                }""", {"d": dimension, "n": days})
                items = body.get("items") or []
                dump[key] = body
                if body.get("status_code") == 0 and items:
                    print(key + " | metric=" + str(body.get("english_metric_name")) + " items=" + str(len(items)) + " " + json.dumps(items[:3], ensure_ascii=False))
                elif body.get("status_code") == 0:
                    print(key + " | metric=" + str(body.get("english_metric_name")) + " items=0")

        # 那条有真实播放量的作品，单独问它的分析详情
        play_item = None
        for key, body in dump.items():
            for entry in body.get("items") or []:
                if entry.get("metric_value"):
                    play_item = str(entry["item_id"])
                    break
            if play_item:
                break
        print("")
        print("play item = " + str(play_item))
        if play_item:
            for path in (
                "/janus/douyin/creator/data/item_analysis/overview?item_id=" + play_item,
                "/janus/douyin/creator/data/item_analysis/trend?item_id=" + play_item,
                "/janus/douyin/creator/data/item_analysis/detail?item_id=" + play_item,
                "/janus/douyin/creator/data/item_analysis/base?item_id=" + play_item,
                "/janus/douyin/creator/data/item_analysis/source?item_id=" + play_item,
                "/janus/douyin/creator/data/item_analysis/play_trend?item_id=" + play_item,
                "/janus/douyin/creator/data/item_analysis/metric?item_id=" + play_item,
                "/janus/douyin/creator/data/item_analysis/statistics?item_id=" + play_item,
                "/janus/douyin/creator/data/item/detail?item_id=" + play_item,
                "/janus/douyin/creator/data/item/overview?item_id=" + play_item,
            ):
                body = page.evaluate("""async (url) => {
                  const res = await fetch(url, { credentials: 'include' });
                  return await res.json();
                }""", path)
                dump[path] = body
                print("  " + path.split("?")[0].split("/data/")[-1] + " -> " + json.dumps(body, ensure_ascii=False)[:300])
        browser.close()
    OUT.write_text(json.dumps(dump, ensure_ascii=False, indent=2), encoding="utf-8")
    print("saved: " + str(OUT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
