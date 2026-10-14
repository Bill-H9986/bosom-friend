# -*- coding: utf-8 -*-
"""抖音数据中心作品数据接口侦察（只读）。

上一轮已确认：作品列表接口 (/janus/douyin/creator/pc/work_list) 的 play_count 恒为 0 占位。
数据中心 (/creator-micro/data-center/*) 才是真正带播放量的地方，本脚本把它的接口全抓下来，
找出「能按作品拿到真实播放量」的那一个。不发布、不改数据。

用法：
  products/bosom-friend/engine/.venv/Scripts/python.exe products/bosom-friend/qa/probes/douyin-datacenter-recon.py
"""
import json
import re
import sys
from pathlib import Path

from patchright.sync_api import sync_playwright

HOME = Path.home() / ".bosom-friend" / "bosom-friend"
SYNC_ROOT = HOME / "platform-login" / "sync"
OUT = Path(__file__).with_name("douyin-datacenter-recon.json")

PAGES = [
    "https://creator.douyin.com/creator-micro/data-center/operation",
    "https://creator.douyin.com/creator-micro/data-center/content",
    "https://creator.douyin.com/creator-micro/data-center/content/video",
    "https://creator.douyin.com/creator-micro/data-center/fans",
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


def metrics_of(body):
    found = []

    def walk(node, prefix="", depth=0):
        if depth > 7:
            return
        if isinstance(node, dict):
            for key, value in node.items():
                path = prefix + "." + key if prefix else key
                if isinstance(value, (int, float)) and not isinstance(value, bool) and re.search(r"play|view|vv|show|exposure|digg|comment|share|collect|finish|statistic", key, re.I):
                    found.append([path.split("[")[0], value])
                walk(value, path, depth + 1)
        elif isinstance(node, list):
            for index, value in enumerate(node[:2]):
                walk(value, prefix + "[" + str(index) + "]", depth + 1)

    walk(body)
    return found


def main() -> int:
    storage = find_storage()
    if storage is None:
        print("NO_DOUYIN_STORAGE")
        return 1
    print("storage: " + storage.parent.name)

    records = {}
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, channel="chrome")
        context = browser.new_context(storage_state=str(storage))
        page = context.new_page()

        def on_response(response):
            url = response.url
            if "/janus/" not in url and "/web/api/" not in url and "/aweme/v1/creator/" not in url:
                return
            if any(skip in url for skip in ("/log/", "slardar", "volces", "monitor")):
                return
            try:
                records[response.url] = response.json()
            except Exception:
                pass

        page.on("response", on_response)
        for target in PAGES:
            try:
                page.goto(target, wait_until="domcontentloaded", timeout=90_000)
            except Exception as exc:
                print("goto failed " + target + " : " + str(exc)[:100])
                continue
            page.wait_for_timeout(9000)
            for _ in range(2):
                page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                page.wait_for_timeout(2000)
            print("visited " + target + " -> " + page.url)
        browser.close()

    summary = []
    for url, body in records.items():
        metrics = metrics_of(body)
        nonzero = [m for m in metrics if isinstance(m[1], (int, float)) and m[1] > 0]
        summary.append({
            "url": url.split("?")[0],
            "metricKeys": sorted({m[0] for m in metrics})[:30],
            "hasPositive": len(nonzero) > 0,
            "positiveSample": nonzero[:10],
        })

    summary.sort(key=lambda item: (not item["hasPositive"], item["url"]))
    OUT.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    for item in summary:
        mark = "REAL" if item["hasPositive"] else "----"
        print("")
        print(mark + " " + item["url"])
        print("      keys: " + json.dumps(item["metricKeys"], ensure_ascii=False)[:300])
        if item["hasPositive"]:
            print("      positive: " + json.dumps(item["positiveSample"], ensure_ascii=False)[:300])
    print("")
    print("saved: " + str(OUT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
