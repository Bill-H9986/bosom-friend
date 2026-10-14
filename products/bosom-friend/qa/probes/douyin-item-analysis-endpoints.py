# -*- coding: utf-8 -*-
"""抖音单作品分析接口族探测（只读 GET/POST，带真实 Cookie）。

已知：/janus/douyin/creator/data/item_analysis/involved_vertical 是真实存在的接口。
本脚本把同族的候选路径逐个打一遍，用「404 还是有业务响应」判断端点是否存在，
并把真正返回数据的那个打印出来。不发布、不改数据。

用法：
  products/bosom-friend/engine/.venv/Scripts/python.exe products/bosom-friend/qa/probes/douyin-item-analysis-endpoints.py
"""
import json
import sys
from pathlib import Path

from patchright.sync_api import sync_playwright

HOME = Path.home() / ".bosom-friend" / "bosom-friend"
SYNC_ROOT = HOME / "platform-login" / "sync"
SYNC_ROOT_ALT = HOME / "platform-login" / "sync"

CANDIDATES = [
    "/janus/douyin/creator/data/item_analysis/involved_vertical",
    "/janus/douyin/creator/data/item_analysis/overview?item_id={item}",
    "/janus/douyin/creator/data/item_analysis/detail?item_id={item}",
    "/janus/douyin/creator/data/item_analysis/trend?item_id={item}",
    "/janus/douyin/creator/data/item_analysis/base?item_id={item}",
    "/janus/douyin/creator/data/item_analysis/source?item_id={item}",
    "/janus/douyin/creator/data/item_analysis/audience?item_id={item}",
    "/janus/douyin/creator/data/item_analysis/video?item_id={item}",
    "/janus/douyin/creator/data/item_analysis/content?item_id={item}",
    "/janus/douyin/creator/data/item_analysis/item?item_id={item}",
    "/janus/douyin/creator/data/item_analysis/stat?item_id={item}",
    "/janus/douyin/creator/data/item_analysis/play?item_id={item}",
    "/janus/douyin/creator/data/item/list?count=10&cursor=0",
    "/janus/douyin/creator/data/content/item/list?count=10&cursor=0",
    "/janus/douyin/creator/data/overview/item_contribution_top?dimension=1&recent_days=7",
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
    print("storage: " + storage.parent.name)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, channel="chrome")
        context = browser.new_context(storage_state=str(storage))
        page = context.new_page()
        page.goto("https://creator.douyin.com/creator-micro/content/manage", wait_until="domcontentloaded", timeout=90_000)
        page.wait_for_timeout(9000)

        item_id = page.evaluate("""async () => {
          const res = await fetch('/janus/douyin/creator/pc/work_list?status=0&count=1&max_cursor=0', { credentials: 'include' });
          const data = await res.json();
          const first = (data.aweme_list || [])[0] || {};
          return String(first.aweme_id || '');
        }""")
        print("sample item_id=" + item_id)

        results = []
        for path in CANDIDATES:
            url = path.replace("{item}", item_id)
            outcome = page.evaluate("""async (url) => {
              try {
                const res = await fetch(url, { credentials: 'include' });
                const text = await res.text();
                let parsed = null;
                try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
                return { http: res.status, keys: parsed ? Object.keys(parsed).slice(0, 18) : null, status_code: parsed ? parsed.status_code : null, status_msg: parsed ? String(parsed.status_msg || '').slice(0, 80) : null, head: text.slice(0, 160) };
              } catch (e) { return { error: String(e).slice(0, 120) }; }
            }""", url)
            results.append({"path": url, **outcome})
            flag = "EXISTS" if outcome.get("status_code") is not None else ("HTTP" + str(outcome.get("http")) if outcome.get("http") else "ERR")
            print(flag + " " + url.split("?")[0].replace("/janus/douyin/creator/data", "") + " -> " + json.dumps(outcome, ensure_ascii=False)[:260])
        browser.close()

    Path(__file__).with_name("douyin-item-analysis-endpoints.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
