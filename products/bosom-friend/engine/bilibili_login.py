# -*- coding: utf-8 -*-
"""B 站扫码登录：直接调官方 passport 接口，不依赖 biliup。

上游 social-auto-upload 的 bilibili_uploader 只有 biliup CLI 包装、没有登录函数，
sau_cli 也明确要求用户自己在终端跑 `sau bilibili login`（biliup 在终端里画二维码）。
产品要把二维码交给 Web UI 展示，所以这里走 B 站公开的扫码接口，并把结果按
Playwright storage_state 结构落盘，与其它平台的登录产物保持一致。

放在 engine 根目录而不是 vendored 的 social-auto-upload/ 里：后者整体被 .gitignore
忽略且会随上游同步覆盖，产品自己的实现不能住在那里。
"""
from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
import segno

GENERATE_URL = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate"
POLL_URL = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll"
NAV_URL = "https://api.bilibili.com/x/web-interface/nav"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

# poll 返回的 data.code：0 登录成功；86101 未扫码；86090 已扫码待确认；86038 二维码已过期。
POLL_OK = 0
POLL_EXPIRED = 86038


def _qrcode_path(account_file: str) -> Path:
    account_path = Path(account_file)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return account_path.with_name(f"{account_path.stem}_login_qrcode_{stamp}.png")


def _build_login_result(success, status, message, account_file, user_info=None):
    return {
        "success": bool(success),
        "status": status,
        "message": message,
        "account_file": str(account_file),
        "user_info": user_info or {},
        "finishedAt": datetime.now(timezone.utc).isoformat(),
    }


def _storage_cookies(session: requests.Session) -> list:
    cookies = []
    for cookie in session.cookies:
        cookies.append({
            "name": cookie.name,
            "value": cookie.value,
            "domain": cookie.domain or ".bilibili.com",
            "path": cookie.path or "/",
            "expires": float(cookie.expires) if cookie.expires else -1,
            "httpOnly": False,
            "secure": bool(cookie.secure),
            "sameSite": "Lax",
        })
    return cookies


def _fetch_user_info(session: requests.Session) -> dict:
    """尽力取昵称/头像/粉丝数；取不到就返回空，不改变登录结论。"""
    try:
        payload = session.get(NAV_URL, timeout=15).json()
    except Exception:
        return {}
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict) or not data.get("isLogin"):
        return {}
    return {
        "nickname": str(data.get("uname") or ""),
        "avatar": str(data.get("face") or ""),
        "platformUid": str(data.get("mid") or ""),
        "fansCount": int(data.get("follower") or 0),
    }


async def bilibili_cookie_gen(
    account_file,
    qrcode_callback=None,
    poll_interval: float = 2,
    max_checks: int = 150,
    headless: bool = True,
):
    """扫码登录 B 站，把登录态写入 account_file（Playwright storage_state 结构）。"""
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT, "Referer": "https://www.bilibili.com/"})

    try:
        payload = session.get(GENERATE_URL, timeout=20).json()
    except Exception as exc:
        return _build_login_result(False, "failed", f"获取 B 站二维码失败: {exc}", account_file)
    if payload.get("code") != 0:
        return _build_login_result(False, "failed", f"获取 B 站二维码失败: {payload.get('message')}", account_file)

    data = payload.get("data") or {}
    qr_url = str(data.get("url") or "")
    qrcode_key = str(data.get("qrcode_key") or "")
    if not qr_url or not qrcode_key:
        return _build_login_result(False, "failed", "B 站二维码响应缺少 url/qrcode_key", account_file)

    qrcode_path = _qrcode_path(str(account_file))
    qrcode_path.parent.mkdir(parents=True, exist_ok=True)
    segno.make(qr_url, error="m").save(str(qrcode_path), scale=6, border=2)
    if qrcode_callback:
        qrcode_callback({"image_path": str(qrcode_path), "image_data_url": ""})

    deadline = time.time() + max(30.0, poll_interval * max_checks)
    while time.time() < deadline:
        await asyncio.sleep(poll_interval)
        try:
            body = session.get(POLL_URL, params={"qrcode_key": qrcode_key}, timeout=20).json()
        except Exception:
            continue
        inner = body.get("data") or {}
        status = inner.get("code")
        if status == POLL_OK:
            cookies = _storage_cookies(session)
            if not cookies:
                return _build_login_result(False, "failed", "B 站登录成功但没拿到 cookie", account_file)
            account_path = Path(account_file)
            account_path.parent.mkdir(parents=True, exist_ok=True)
            account_path.write_text(
                json.dumps({"cookies": cookies, "origins": []}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            return _build_login_result(True, "logged_in", "登录成功", account_file, user_info=_fetch_user_info(session))
        if status == POLL_EXPIRED:
            return _build_login_result(False, "expired", "二维码已过期，请重新获取", account_file)

    return _build_login_result(False, "timeout", "等待扫码超时，请重新发起登录", account_file)
