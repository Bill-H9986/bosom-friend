# -*- coding: utf-8 -*-
"""抖音单作品分析接口侦察（只读）。

目的：弄清创作者中心「作品数据」页到底从哪个接口拿到单作品真实播放量。
列表接口 (/janus/.../work_list) 的 statistics.play_count 一律回 0 占位，
这个 0 不携带信息，所以必须找到真正带播放量的那个接口。

只读：打开页面、抓响应、打印字段，不点发布、不改账号数据、不打印 cookie。
用法：
  products/bosom-friend/engine/.venv/Scripts/python.exe products/bosom-friend/qa/probes/douyin-analysis-recon.py
"""
import json
import sys
from pathlib import Path

from patchright.sync_api import sync_playwright

HOME = Path.home() / ".bosom-friend" / "bosom-friend"
SYNC_ROOT = HOME / "platform-login" / "sync"
OUT = Path(__file__).with_name("douyin-analysis-recon.json")

INTERESTING = ("play", "view", "vv", "show", "exposure", "impression", "digg", "comment", "share", "collect", "fans", "statistic")

DATA_PAGES = [
    "https://creator.douyin.com/creator-micro/data/content/video",
    "https://creator.douyin.com/creator-micro/data/following/content",
]


def find_storage() -> Path | None:
    if not SYNC_ROOT.exists():
        return None
    dirs = sorted(SYNC_ROOT.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)
    for item in dirs:
        file = item / "storage.json"
        if not file.exists():
            continue
        try:
            payload = json.loads(file.read_text(encoding="utf-8"))
        except Exception:
            continue
        cookies = payload.get("cookies") or []
        if any("douyin" in str(c.get("domain", "")) for c in cookies):
            return file
    return None


def walk_numbers(node, prefix="", depth=0, found=None):
    """收集所有「名字像指标、值是非零数字」的字段路径。"""
    if found is None:
        found = []
    if depth > 5:
        return found
    if isinstance(node, dict):
        for key, value in node.items():
            path = prefix + "." + key if prefix else key
            low = key.lower()
            if isinstance(value, (int, float)) and not isinstance(value, bool) and any(t in low for t in INTERESTING):
                found.append({"path": path, "value": value})
            walk_numbers(value, path, depth + 1, found)
    elif isinstance(node, list):
        for index, value in enumerate(node[:3]):
            walk_numbers(value, prefix + "[" + str(index) + "]", depth + 1, found)
    return found


def main() -> int:
    storage = find_storage()
    if storage is None:
        print("NO_DOUYIN_STORAGE")
        return 1
    print("storage: " + storage.parent.name)

    captured = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, channel="chrome")
        context = browser.new_context(storage_state=str(storage))
        page = context.new_page()

        def on_response(response):
            url = response.url
            if "/janus/" not in url and "/web/api/" not in url and "/aweme/" not in url:
                return
            if any(skip in url for skip in ("/log/", "monitor", "slardar", "volces", "verify")):
                return
            try:
                body = response.json()
            except Exception:
                return
            captured.append({"url": url, "body": body})

        page.on("response", on_response)
        for target in DATA_PAGES:
            print("visit " + target)
            try:
                page.goto(target, wait_until="domcontentloaded", timeout=90_000)
            except Exception as exc:
                print("  goto failed: " + str(exc)[:120])
                continue
            page.wait_for_timeout(9000)
            for _ in range(2):
                page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                page.wait_for_timeout(2500)
        browser.close()

    print("captured responses: " + str(len(captured)))
    summary = []
    for entry in captured:
        numbers = walk_numbers(entry["body"])
        nonzero_metric = [n for n in numbers if n["value"] > 0]
        summary.append({
            "url": entry["url"][:200],
            "topKeys": list(entry["body"].keys())[:20] if isinstance(entry["body"], dict) else None,
            "metricPaths": sorted({n["path"].split("[")[0] for n in numbers})[:40],
            "hasNonZeroMetric": len(nonzero_metric) > 0,
            "sampleNonZero": nonzero_metric[:8],
        })

    OUT.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    for item in summary:
        mark = "REAL" if item["hasNonZeroMetric"] else "----"
        print("")
        print(mark + " " + item["url"])
        print("     topKeys: " + str(item["topKeys"]))
        print("     metrics: " + str(item["metricPaths"]))
        if item["hasNonZeroMetric"]:
            print("     nonzero: " + json.dumps(item["sampleNonZero"], ensure_ascii=False)[:400])
    print("")
    print("saved: " + str(OUT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
