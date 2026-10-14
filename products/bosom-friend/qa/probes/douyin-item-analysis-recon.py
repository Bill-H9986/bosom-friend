# -*- coding: utf-8 -*-
"""抖音数据中心「投稿分析/投稿列表」接口侦察（只读）：点开两个标签页，抓它们调的接口与响应体。

用法：
  products/bosom-friend/engine/.venv/Scripts/python.exe products/bosom-friend/qa/probes/douyin-item-analysis-recon.py
"""
import json
import sys
from pathlib import Path

from patchright.sync_api import sync_playwright

HOME = Path.home() / ".bosom-friend" / "bosom-friend"
SYNC_ROOT = HOME / "platform-login" / "sync"
OUT = Path(__file__).with_name("douyin-item-analysis-recon.json")


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

    log = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, channel="chrome")
        context = browser.new_context(storage_state=str(storage))
        page = context.new_page()

        def on_response(response):
            url = response.url
            if "/janus/" not in url:
                return
            entry = {"url": url, "status": response.status}
            try:
                entry["body"] = response.json()
            except Exception:
                entry["body"] = None
            log.append(entry)

        page.on("response", on_response)
        page.goto("https://creator.douyin.com/creator-micro/data-center/content", wait_until="domcontentloaded", timeout=90_000)
        page.wait_for_timeout(10000)

        for label in ("投稿分析", "投稿列表"):
            before = len(log)
            clicked = page.evaluate("""(label) => {
              const all = [...document.querySelectorAll('*')].filter(e => e.children.length === 0 && (e.innerText || '').trim() === label);
              if (all.length === 0) return false;
              all[0].click();
              return true;
            }""", label)
            page.wait_for_timeout(9000)
            print("clicked " + label + ": " + str(clicked) + " new=" + str(len(log) - before))
            for entry in log[before:]:
                print("   " + entry["url"][:230])

        print("")
        print("current url: " + page.url)
        text = page.evaluate("() => document.body.innerText")
        Path(OUT.with_suffix(".txt")).write_text(text, encoding="utf-8")
        browser.close()

    OUT.write_text(json.dumps(log, ensure_ascii=False, indent=2)[:500000], encoding="utf-8")
    print("")
    print("=== all janus responses ===")
    for entry in log:
        body = entry["body"]
        keys = list(body.keys())[:16] if isinstance(body, dict) else type(body).__name__
        print("  [" + str(entry["status"]) + "] " + entry["url"].split("?")[0].replace("https://creator.douyin.com", ""))
        print("        " + json.dumps(keys, ensure_ascii=False)[:260])
    print("saved: " + str(OUT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
