# -*- coding: utf-8 -*-
"""抖音「内容数据」页接口侦察（只读）：抓全 URL 与原始响应体，并点开一条作品看详情接口。

用法：
  products/bosom-friend/engine/.venv/Scripts/python.exe products/bosom-friend/qa/probes/douyin-content-data-recon.py
"""
import json
import sys
from pathlib import Path

from patchright.sync_api import sync_playwright

HOME = Path.home() / ".bosom-friend" / "bosom-friend"
SYNC_ROOT = HOME / "platform-login" / "sync"
OUT = Path(__file__).with_name("douyin-content-data-recon.json")


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

    seen = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, channel="chrome")
        context = browser.new_context(storage_state=str(storage))
        page = context.new_page()

        def on_response(response):
            url = response.url
            if "/janus/" not in url and "/aweme/v1/creator/" not in url:
                return
            entry = {"url": url, "status": response.status}
            try:
                entry["body"] = response.json()
            except Exception:
                try:
                    entry["raw"] = response.text()[:800]
                except Exception:
                    entry["raw"] = None
            seen.append(entry)

        page.on("response", on_response)
        page.goto("https://creator.douyin.com/creator-micro/data-center/content", wait_until="domcontentloaded", timeout=90_000)
        page.wait_for_timeout(12000)
        page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        page.wait_for_timeout(3000)

        text = page.evaluate("() => document.body.innerText")
        Path(OUT.with_suffix(".txt")).write_text(text, encoding="utf-8")
        print("page text saved, length=" + str(len(text)))

        markup = page.evaluate("""() => {
          const out = [];
          for (const el of document.querySelectorAll('[class*=card], [class*=item], [class*=row], [class*=list]')) {
            const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
            if (t.length > 10 && t.length < 400) out.push(el.className.slice(0, 60) + ' || ' + t);
            if (out.length > 25) break;
          }
          return out;
        }""")
        print("=== candidate rows ===")
        for line in markup:
            print("  " + line)

        before = len(seen)
        clicked = page.evaluate("""() => {
          const all = [...document.querySelectorAll('*')].filter(e => (e.innerText || '').trim() === '详情' || (e.innerText || '').trim() === '数据详情');
          if (all.length === 0) return false;
          all[0].click();
          return true;
        }""")
        page.wait_for_timeout(9000)
        print("clicked detail entry: " + str(clicked) + " newResponses=" + str(len(seen) - before))
        for entry in seen[before:]:
            print("  " + entry["url"][:200])
        browser.close()

    OUT.write_text(json.dumps(seen, ensure_ascii=False, indent=2)[:400000], encoding="utf-8")
    print("")
    print("=== all janus/creator responses (url -> top keys) ===")
    for entry in seen:
        body = entry.get("body")
        keys = list(body.keys())[:14] if isinstance(body, dict) else str(entry.get("raw"))[:120]
        print("  [" + str(entry["status"]) + "] " + entry["url"].split("?")[0].replace("https://creator.douyin.com", "") + " -> " + json.dumps(keys, ensure_ascii=False)[:200])
    print("saved: " + str(OUT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
