"""Bosom Friend 平台登录 worker（进程边界的薄胶水层）。

复用 vendored 的 social-auto-upload（MIT）成熟登录逻辑：

1. Playwright 打开平台官方创作者页面；
2. 抓取页面真实登录二维码转交 Web UI 展示；
3. 等待用户手机扫码完成真实登录；
4. 落盘 Playwright storage_state cookie 并调用上游 check_cookie 复核有效性。

本文件不包含任何平台登录业务逻辑，只负责：命令行参数、状态文件、
二维码 URL 归一化/取图、上游 SQLite 结果读取与账号资料尽力采集。

用法:
    python worker.py login <platform> <sessionId> <stateDir>
    platform: xhs | douyin | ks | tencent | xianyu
"""

import asyncio
import base64
import inspect
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import psutil

ENGINE_DIR = Path(__file__).resolve().parent
VENDOR_DIR = ENGINE_DIR / "social-auto-upload"
sys.path.insert(0, str(VENDOR_DIR))

try:
    import requests
except ImportError:  # vendored 依赖缺失时给出可读错误
    requests = None  # type: ignore[assignment]

PLATFORM_KIND = {
    "xhs": 1,
    "tencent": 2,
    "douyin": 3,
    "ks": 4,
    "baijiahao": 5,
    "alipay": 6,
    "weibo": 7,
    "hupu": 8,
    "youtube": 9,
    "bilibili": 10,
    "tiktok": 11,
    "xianyu": 12,
}
PLATFORM_ORIGIN = {
    "xhs": "https://creator.xiaohongshu.com",
    "douyin": "https://creator.douyin.com",
    "ks": "https://cp.kuaishou.com",
    "tencent": "https://channels.weixin.qq.com",
    "xianyu": "https://www.goofish.com",
}

DOUYIN_WORK_LIST_MARKER = "/janus/douyin/creator/pc/work_list"
DOUYIN_ITEM_LIST_URL = "https://creator.douyin.com/aweme/v1/creator/item/list/?cursor=0"
DOUYIN_SYNC_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"
# 抖音单作品真实播放量接口（创作者中心「投稿分析」）。作品列表接口的 statistics.play_count
# 是 0 占位：同一批作品里点赞 37、分享 55，播放量不可能是 0；创作者中心页面自己在「播放」
# 一栏显示的都是「-」。这个接口按 dimension 返回每篇投稿近 N 天的 metric_value，
# english_metric_name 明确写着 play_cnt。实测只接受 recent_days=7，其他取值回 status_code=5。
DOUYIN_ITEM_ANALYTICS_URL = "https://creator.douyin.com/janus/douyin/creator/data/overview/item_contribution_top"
DOUYIN_ANALYTICS_PLAY_DIMENSION = 1
DOUYIN_ANALYTICS_RECENT_DAYS = 7
XHS_NOTE_MANAGE_URL = "https://creator.xiaohongshu.com/new/note-manager"
def load_modern_login(platform: str):
    """按引擎平台 key 自动加载登录函数（cookie_gen -> setup），不再逐平台 if/else。"""
    module_paths = {
        "xhs": "uploader.xiaohongshu_uploader.main",
        "douyin": "uploader.douyin_uploader.main",
        "ks": "uploader.ks_uploader.main",
        "tencent": "uploader.tencent_uploader.main",
        "baijiahao": "uploader.baijiahao_uploader.main",
        "alipay": "uploader.alipay_uploader.main",
        "weibo": "uploader.weibo_uploader.main",
        "hupu": "uploader.hupu_uploader.main",
        "youtube": "uploader.youtube_uploader.main",
        "tiktok": "uploader.tk_uploader.main_chrome",
        "xianyu": "uploader.xianyu_uploader.main",
        # bilibili_uploader 只有 biliup CLI 包装、没有登录函数；扫码登录由本项目
        # 按 B 站 passport 接口补在 engine/bilibili_login.py（上游 sau_cli 要求用户自己开终端跑）。
        "bilibili": "bilibili_login",
    }
    module_name = module_paths.get(platform)
    if not module_name:
        return None
    import importlib
    module = importlib.import_module(module_name)
    for name in dir(module):
        if name.endswith("_cookie_gen") and callable(getattr(module, name)):
            return getattr(module, name)
    for name in dir(module):
        if name.endswith("_setup") and callable(getattr(module, name)):
            return getattr(module, name)
    return None


_shared_cdp: str | None = None
_shared_chrome: subprocess.Popen | None = None


def _wait_tcp_ready(port: str, timeout_s: float = 8.0) -> bool:
    """确认 CDP 端口真正开始监听（避免 DevToolsActivePort 写入后的启动竞态）。"""
    import socket
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", int(port)), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.2)
    return False


def _free_tcp_port() -> int:
    """取一个本机空闲端口，专用于共享 Chrome 的远程调试。"""
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _kill_shared_chrome(profile_dir: Path) -> None:
    """只清理绑定本共享 profile 的 Chrome 进程树，不影响用户日常 Chrome。"""
    profile_marker = str(profile_dir.resolve()).lower().replace("\\", "/")
    for proc in psutil.process_iter(["pid", "name", "cmdline"]):
        try:
            if (proc.info.get("name") or "").lower() != "chrome.exe":
                continue
            cmdline = " ".join(proc.info.get("cmdline") or [])
            if profile_marker not in cmdline.lower().replace("\\", "/"):
                continue
            for child in proc.children(recursive=True):
                try:
                    child.kill()
                except psutil.Error:
                    pass
            proc.kill()
            try:
                proc.wait(timeout=5)
            except psutil.Error:
                pass
        except (psutil.Error, OSError):
            continue


def restart_shared_chrome(state_root: Path) -> str | None:
    """共享 Chrome 失联时清理绑定共享 profile 的全部 Chrome 并重启。"""
    global _shared_cdp, _shared_chrome
    _kill_shared_chrome(state_root / "shared-chrome-profile")
    _shared_cdp = None
    _shared_chrome = None
    return ensure_shared_chrome(state_root)


def ensure_shared_chrome(state_root: Path) -> str | None:
    """守护进程全程复用的真实 Chrome（新版无头 + 显式远程调试端口），只启动一次。"""
    global _shared_cdp, _shared_chrome
    if _shared_cdp:
        return _shared_cdp
    profile_dir = state_root / "shared-chrome-profile"
    profile_dir.mkdir(parents=True, exist_ok=True)
    # 旧守护进程异常退出可能留下绑定同 profile 的 Chrome；先清理再重启，
    # 避免 DevToolsActivePort 丢失后每次登录另起独立浏览器。
    _kill_shared_chrome(profile_dir)
    # 上次异常退出可能残留 Singleton 锁/端口文件，先清理避免 Chrome 启动即退出
    for stale in list(profile_dir.glob("Singleton*")) + [profile_dir / "DevToolsActivePort", profile_dir / "shared-cdp.json"]:
        try:
            stale.unlink()
        except OSError:
            pass
    chrome_exe = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
    if not chrome_exe.exists():
        chrome_exe = Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe")
    if not chrome_exe.exists():
        return None
    cdp_port = _free_tcp_port()
    _shared_chrome = subprocess.Popen(
        [
            str(chrome_exe),
            f"--user-data-dir={profile_dir}",
            f"--remote-debugging-port={cdp_port}",
            "--headless=new",
            "--disable-blink-features=AutomationControlled",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-gpu",
            "--disable-background-networking",
            "--window-size=1440,900",
            "--lang=zh-CN",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    # 显式端口启动后不再依赖 DevToolsActivePort 文件，直接等待端口真正监听。
    for _ in range(100):
        if _shared_chrome.poll() is not None:
            return None
        if _wait_tcp_ready(str(cdp_port), 0.5):
            _shared_cdp = "http://127.0.0.1:" + str(cdp_port)
            try:
                (profile_dir / "shared-cdp.json").write_text(json.dumps({"port": cdp_port, "pid": _shared_chrome.pid}), encoding="utf-8")
            except OSError:
                pass
            return _shared_cdp
        time.sleep(0.25)
    return None

# 登录成功后的账号资料采集：多个候选选择器逐一尝试，失败不影响登录结果。
PROFILE_TARGETS = {
    "douyin": {
        "url": "https://creator.douyin.com/",
        "names": ['[class*="account-name"]', '[class*="accountName"]', '[class*="user-name"]', '[class*="userName"]'],
        "avatars": ['[class*="account-avatar"] img', '[class*="accountAvatar"] img', '[class*="avatar"] img'],
    },
    "xhs": {
        "url": "https://creator.xiaohongshu.com/",
        "names": ['[class*="account-name"]', '[class*="accountName"]', '[class*="user-name"]', '[class*="userName"]', '[class*="name"]'],
        "avatars": ['[class*="avatar"] img', '[class*="account-avatar"] img'],
    },
    "ks": {
        "url": "https://cp.kuaishou.com/",
        "names": ['[class*="account-name"]', '[class*="accountName"]', '[class*="user-name"]', '[class*="userName"]', '[class*="name"]'],
        "avatars": ['[class*="avatar"] img'],
    },
    "tencent": {
        "url": "https://channels.weixin.qq.com/platform",
        "names": ['[class*="account-name"]', '[class*="accountName"]', '[class*="user-name"]', '[class*="userName"]'],
        "avatars": ['[class*="avatar"] img'],
    },
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _local_qr_file(src: str) -> str | None:
    """本地二维码图片 → data URL；不是本地文件或读不出来时返回 None。"""
    if src.startswith(("http://", "https://", "//", "blob:", "data:")):
        return None
    try:
        path = Path(src)
        if not path.is_file():
            return None
        data = path.read_bytes()
    except OSError:
        return None
    if not data:
        return None
    mime = "image/jpeg" if path.suffix.lower() in (".jpg", ".jpeg") else "image/png"
    return f"data:{mime};base64," + base64.b64encode(data).decode("ascii")


def normalize_qr(src: str | None, platform: str) -> str | None:
    """把上游页面里的二维码 src 归一化成 Web UI 可渲染的 data URL。"""
    if not src or not isinstance(src, str):
        return None
    if src.startswith("data:image/"):
        return src
    # 支付宝/百家号/微博/虎扑的登录函数只把二维码落成本地 PNG，
    # 回调里的 image_data_url 恒为空串。不读本地文件，这四个平台
    # 永远出不来二维码，界面只会显示「未获取到平台二维码」。
    local = _local_qr_file(src)
    if local is not None:
        return local
    if src.startswith("blob:"):
        # blob 作用域在引擎浏览器进程内，Web UI 无法引用；留给错误提示，避免静默失败。
        return None
    if src.startswith("//"):
        target = "https:" + src
    elif src.startswith("http://") or src.startswith("https://"):
        target = src
    else:
        target = PLATFORM_ORIGIN.get(platform, "") + ("" if src.startswith("/") else "/") + src
    if requests is not None:
        try:
            resp = requests.get(target, timeout=10)
            if resp.ok and resp.content:
                mime = resp.headers.get("content-type", "image/png").split(";")[0]
                return f"data:{mime};base64," + base64.b64encode(resp.content).decode("ascii")
        except Exception:
            pass
    return target


def read_state(state_dir: Path) -> dict:
    try:
        return json.loads((state_dir / "state.json").read_text(encoding="utf-8"))
    except Exception:
        return {}


DOUYIN_PROFILE_URL = "https://creator.douyin.com/web/api/media/user/info/"
DOUYIN_PROFILE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"
XHS_PROFILE_URL = "https://creator.xiaohongshu.com/api/galaxy/creator/home/personal_info"
XHS_PROFILE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"


def _storage_cookie_pairs(storage_file: Path) -> list[str]:
    """把 storage_state 的 cookie 拼成请求头键值对；含控制字符的条目直接丢弃。"""
    try:
        storage = json.loads(storage_file.read_text(encoding="utf-8"))
    except Exception:
        return []
    cookies = storage.get("cookies", []) if isinstance(storage, dict) else []
    pairs: list[str] = []
    for cookie in cookies:
        name = str(cookie.get("name") or "")
        value = str(cookie.get("value") or "")
        if name and value and not any(ord(ch) < 32 or ord(ch) == 127 for ch in name + value):
            pairs.append(f"{name}={value}")
    return pairs


def fetch_douyin_profile(storage_file: Path) -> dict:
    """用登录后的浏览器会话调用抖音创作者用户信息接口，补昵称/头像/Uid/粉丝数。"""
    if requests is None:
        return {}
    try:
        pairs = _storage_cookie_pairs(storage_file)
        if not pairs:
            return {}
        response = requests.get(
            DOUYIN_PROFILE_URL,
            headers={
                "Cookie": "; ".join(pairs),
                "User-Agent": DOUYIN_PROFILE_UA,
                "Accept": "application/json, text/plain, */*",
                "Referer": "https://creator.douyin.com/",
            },
            timeout=15,
        )
        data = response.json()
        if not isinstance(data, dict) or data.get("status_code") != 0:
            return {}
        user = data.get("user") or {}
        avatar_thumb = user.get("avatar_thumb") or {}
        avatar_urls = avatar_thumb.get("url_list") or []
        return {
            "platformUid": str(user.get("unique_id") or user.get("uid") or ""),
            "nickname": str(user.get("nickname") or ""),
            "avatar": str(avatar_urls[0]) if avatar_urls else "",
            "fansCount": int(user.get("follower_count") or 0),
        }
    except Exception:
        return {}


def fetch_xhs_profile(storage_file: Path) -> dict:
    """用登录后的浏览器会话调用小红书创作者主页资料接口，补昵称/头像/粉丝数。

    /api/galaxy/creator/home/personal_info 只认创作者 cookie，无需签名参数，
    data.fans_count 是账号当前粉丝数（与创作者后台显示一致），也是 fansCount 实时化的来源。
    """
    if requests is None:
        return {}
    try:
        pairs = _storage_cookie_pairs(storage_file)
        if not pairs:
            return {}
        response = requests.get(
            XHS_PROFILE_URL,
            headers={
                "Cookie": "; ".join(pairs),
                "User-Agent": XHS_PROFILE_UA,
                "Accept": "application/json, text/plain, */*",
                "Referer": "https://creator.xiaohongshu.com/",
            },
            timeout=15,
        )
        payload = response.json()
        data = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(data, dict):
            return {}
        # 不返回 platformUid：服务端 xhs 账号身份取自登录 cookie 的 x-user-id-creator，
        # 这里若填小红书号会让同一账号下次登录匹配不上而新建重复账号。
        return {
            "nickname": str(data.get("name") or ""),
            "avatar": str(data.get("avatar") or ""),
            "fansCount": int(data.get("fans_count") or 0),
        }
    except Exception:
        return {}


def fetch_platform_profile(platform: str, storage_file: Path) -> dict:
    """按平台分发账号资料采集；未接入的平台返回空字典，由调用方决定回退策略。"""
    if platform == "douyin":
        return fetch_douyin_profile(storage_file)
    if platform == "xhs":
        return fetch_xhs_profile(storage_file)
    return {}


def write_state(state_dir: Path, **fields: object) -> None:
    state_dir.mkdir(parents=True, exist_ok=True)
    current = read_state(state_dir)
    current.update(fields)
    tmp = state_dir / "state.json.tmp"
    tmp.write_text(json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(state_dir / "state.json")


def ensure_local_media(media_files: list[str], task_dir: Path) -> list[str]:
    """把 http(s) 媒体下载到任务目录；本地绝对路径原样返回。"""
    result: list[str] = []
    for index, item in enumerate(media_files):
        if item.startswith("http://") or item.startswith("https://"):
            if requests is None:
                raise RuntimeError("缺少 requests，无法下载远端媒体")
            resp = requests.get(item, timeout=120)
            resp.raise_for_status()
            suffix = Path(item.split("?", 1)[0]).suffix or ".bin"
            target = task_dir / f"media_{index}{suffix}"
            target.write_bytes(resp.content)
            result.append(str(target))
        else:
            result.append(item)
    return result


async def run_login(platform: str, state_dir: Path, cdp_url: str | None = None, engine_root: Path | None = None) -> bool:
    """主维护线登录：回调收二维码，持续检测登录态，成功后 storage_state 直接落盘。"""
    storage_file = state_dir / "storage.json"
    write_state(state_dir, platform=platform, status="starting", startedAt=now_iso())

    def on_qrcode(payload) -> None:
        qr_src = ""
        if isinstance(payload, dict):
            # 各平台交二维码的方式不统一：有的给 data URL 或页面 src，
            # 有的只把二维码存成 PNG 并给出 image_path（image_data_url 恒为空串）。
            qr_src = str(payload.get("image_data_url") or payload.get("image_path") or "")
        qr = normalize_qr(qr_src, platform)
        if qr:
            write_state(state_dir, status="pending", qrUrl=qr, qrAt=now_iso())
        else:
            write_state(state_dir, status="failed", error="未获取到平台二维码，请重试", finishedAt=now_iso())

    func = load_modern_login(platform)
    if func is None:
        write_state(state_dir, status="failed", error=f"不支持的登录平台: {platform}", finishedAt=now_iso())
        return False

    # 全平台统一按「最严风控」标准：链接本机真实 Chrome（新版无头），
    # 指纹真实，扫码后通过率显著高于内置 Chrome for Testing。
    chrome_proc: subprocess.Popen | None = None
    if cdp_url is None:
        profile_dir = state_dir / "chrome-profile"
        profile_dir.mkdir(parents=True, exist_ok=True)
        chrome_exe = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
        if not chrome_exe.exists():
            chrome_exe = Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe")
        if chrome_exe.exists():
            chrome_proc = subprocess.Popen(
                [
                    str(chrome_exe),
                    f"--user-data-dir={profile_dir}",
                    "--remote-debugging-port=0",
                    "--headless=new",
                    "--disable-blink-features=AutomationControlled",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--disable-gpu",
                    "--disable-background-networking",
                    "about:blank",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            port_file = profile_dir / "DevToolsActivePort"
            for _ in range(80):
                if chrome_proc.poll() is not None:
                    break
                if port_file.exists():
                    try:
                        lines = port_file.read_text(encoding="utf-8").splitlines()
                        if lines and lines[0].strip().isdigit():
                            cdp_url = "http://127.0.0.1:" + lines[0].strip()
                            break
                    except OSError:
                        pass
                time.sleep(0.25)

    def cleanup_chrome() -> None:
        if chrome_proc is not None and chrome_proc.poll() is None:
            try:
                chrome_proc.terminate()
            except OSError:
                pass

    def login_kwargs(headless: bool) -> dict:
        """按登录函数的真实签名决定传哪些参数。

        各平台登录入口的签名并不统一，历史上这里固定传一套参数，结果：
        - 只导出 *_setup 的平台（快手等）默认 handle=False，worker 又不传 handle，
          于是「没有 cookie 就直接返回 cookie 失效」，扫码流程根本不会启动；
        - alipay/weibo 的 *_cookie_gen 没有 cdp_url 参数，固定传它会直接 TypeError。

        这里按签名传：handle 一律 True（worker 的语义就是「现在开始登录」），
        headless / cdp_url 只在函数真的收这两个参数时才给。
        """
        params = inspect.signature(func).parameters
        kwargs: dict = {}
        # 扫描二维码的平台才收 qrcode_callback。YouTube / TikTok 的登录入口
        # 没有这个参数，硬塞会直接 TypeError: unexpected keyword argument。
        if "qrcode_callback" in params:
            kwargs["qrcode_callback"] = on_qrcode
        if "handle" in params:
            kwargs["handle"] = True
        if "headless" in params:
            kwargs["headless"] = headless
        if "cdp_url" in params:
            # 固定 None：每次登录都用全新档案，不挂共享 Chrome——共享档案已登录时
            # 登录页会被重定向走，二维码出不来（见下面的说明）。
            kwargs["cdp_url"] = None
        return kwargs

    def build_coro(target_cdp: str | None):
        if platform == "douyin":
            # 抖音扫码后经常触发短信/密码二次验证：必须让用户能直接看到并操作验证页，
            # 因此抖音登录不使用共享无头浏览器，单独弹一个真实 Chrome 窗口。
            return func(str(storage_file), **login_kwargs(False))
        # 小红书（含其他二维码平台）：每次登录必须使用独立的全新 Chrome 档案，
        # 不得复用共享档案——共享档案若已登录，登录页会被重定向到创作首页，
        # 二维码无法稳定出现，导致“授权失败/二维码加载超时”。
        return func(str(storage_file), **login_kwargs(True))

    try:
        try:
            result = await asyncio.wait_for(build_coro(cdp_url), timeout=600)
        except Exception as exc:
            msg = str(exc)
            if cdp_url is not None and engine_root is not None and ("ECONNREFUSED" in msg or "connect_over_cdp" in msg):
                # 共享浏览器失联：重启一次再试；失败则回退本会话独立浏览器
                fresh_cdp = restart_shared_chrome(engine_root)
                result = await asyncio.wait_for(build_coro(fresh_cdp), timeout=600)
            else:
                raise
    except asyncio.TimeoutError:
        write_state(state_dir, status="failed", error="等待扫码超时，请重新发起登录", finishedAt=now_iso())
        cleanup_chrome()
        return False
    except Exception as exc:
        write_state(state_dir, status="failed", error=f"平台登录引擎异常: {exc}", finishedAt=now_iso())
        cleanup_chrome()
        return False
    cleanup_chrome()

    if not isinstance(result, dict) or result.get("success") is not True:
        detail = result.get("message") if isinstance(result, dict) else "平台登录失败"
        write_state(state_dir, status="failed", error=f"平台登录失败: {detail}", finishedAt=now_iso())
        return False
    if not storage_file.exists():
        write_state(state_dir, status="failed", error="登录会话未落盘，请重新发起登录", finishedAt=now_iso())
        return False

    try:
        storage = json.loads(storage_file.read_text(encoding="utf-8"))
        cookies = storage.get("cookies", []) if isinstance(storage, dict) else []
        if not cookies:
            raise ValueError("storage_state 无 cookie")
        profile = result.get("user_info") if isinstance(result, dict) else None
        if not isinstance(profile, dict):
            profile = await asyncio.to_thread(fetch_platform_profile, platform, storage_file)
        write_state(
            state_dir,
            status="done",
            cookieFile=str(storage_file),
            loginCookie=json.dumps(cookies, ensure_ascii=False),
            nickname=str(profile.get("nickname") or "") if profile else "",
            avatar=str(profile.get("avatar") or "") if profile else "",
            platformUid=str(profile.get("platformUid") or "") if profile else "",
            fansCount=int(profile.get("fansCount") or 0) if profile else 0,
            finishedAt=now_iso(),
        )
        return True
    except Exception as exc:
        write_state(state_dir, status="failed", error=f"处理登录 cookie 失败: {exc}", finishedAt=now_iso())
        return False


async def capture_profile(platform: str, storage_file: Path) -> dict:
    """登录成功后尽力采集账号资料；失败不影响登录结果。

    抖音/小红书走各自的创作者资料接口（同时给出粉丝数），其余平台回退到创作者主页 DOM 扫描。
    """
    if platform in ("douyin", "xhs"):
        return await asyncio.to_thread(fetch_platform_profile, platform, storage_file)
    target = PROFILE_TARGETS.get(platform)
    if target is None:
        return {}
    from playwright.async_api import async_playwright

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        try:
            context = await browser.new_context(storage_state=str(storage_file))
            page = await context.new_page()
            await page.goto(target["url"], timeout=25000, wait_until="domcontentloaded")
            await page.wait_for_timeout(1000)
            # 一次页面内扫描候选选择器，避免逐个 locator 轮询拖慢登录完成
            data = await page.evaluate(
                """(names, avatars) => {
                  const pick = (sels) => {
                    for (const sel of sels) {
                      const el = document.querySelector(sel);
                      if (el) return el;
                    }
                    return null;
                  };
                  const nameEl = pick(names);
                  const avatarEl = pick(avatars);
                  return {
                    nickname: nameEl ? (nameEl.innerText || '').trim().slice(0, 40) : '',
                    avatar: avatarEl ? (avatarEl.getAttribute('src') || '') : '',
                  };
                }""",
                target["names"],
                target["avatars"],
            )
            return {
                "nickname": str(data.get("nickname") or ""),
                "avatar": str(data.get("avatar") or ""),
            }
        finally:
            await browser.close()


CLI_PLATFORM_MAP = {
    "xhs": "xiaohongshu",
    "douyin": "douyin",
    "ks": "kuaishou",
    "tencent": "tencent",
    "bilibili": "bilibili",
    "baijiahao": "baijiahao",
    "alipay": "alipay",
    "weibo": "weibo",
    "hupu": "hupu",
    "youtube": "youtube",
}


def _run_sau_cli_publish(task_dir: Path, inp: dict) -> int:
    """统一发布执行器：调用开源引擎的通用 sau CLI，产品层不再维护平台 if/else。"""
    platform = str(inp.get("platform") or "")
    cli_platform = CLI_PLATFORM_MAP.get(platform)
    if not cli_platform:
        raise ValueError(f"该平台暂未接入统一发布引擎: {platform}")

    title = str(inp.get("title") or "")
    desc = str(inp.get("desc") or "")
    topics = [str(t) for t in (inp.get("topics") or [])]
    media = ensure_local_media([str(m) for m in (inp.get("mediaFiles") or [])], task_dir)
    is_image_text = inp.get("type") == "ImageText" or inp.get("isImageText") is True
    cover = str(inp.get("thumbnailPath") or "") or None
    is_draft = inp.get("isDraft") is True
    if not media:
        raise ValueError("发布任务没有媒体文件")

    account_dir = VENDOR_DIR / "cookies"
    account_dir.mkdir(parents=True, exist_ok=True)
    account_name = "task-" + str(task_dir.name).replace("\\", "_").replace("/", "_")
    account_file = account_dir / f"{cli_platform}_{account_name}.json"
    storage_file = Path(str(inp.get("storageFile") or task_dir / "storage.json"))
    import shutil
    shutil.copyfile(storage_file, account_file)

    action = "upload-note" if is_image_text else "upload-video"
    args = [
        sys.executable,
        str(VENDOR_DIR / "sau_cli.py"),
        cli_platform,
        action,
        "--account",
        account_name,
        "--title",
        title,
    ]
    if is_image_text:
        args += ["--images", *media]
    else:
        args += ["--file", media[0]]
        if cover:
            args += ["--thumbnail", cover]
    if desc:
        args += ["--note" if is_image_text else "--desc", desc]
    if topics:
        args += ["--tags", ",".join(topics)]
    if cli_platform == "bilibili":
        args += ["--tid", str(inp.get("tid") or 249)]
    if cli_platform == "youtube":
        args += ["--visibility", str(inp.get("visibility") or "public")]
    if is_draft and cli_platform == "tencent":
        args += ["--draft"]
    args += ["--headless"]

    result = subprocess.run(
        args,
        cwd=str(VENDOR_DIR),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=1800,
    )
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "统一发布引擎失败").strip())
    return 0


def run_publish(task_dir: Path) -> int:
    """执行真实发布：统一调用开源引擎的 sau CLI，按平台清单自动选择执行器。"""

    input_file = task_dir / "input.json"
    try:
        inp = json.loads(input_file.read_text(encoding="utf-8"))
    except Exception as exc:
        write_state(task_dir, status="failed", error=f"读取发布任务失败: {exc}", finishedAt=now_iso())
        return 1

    write_state(task_dir, status="uploading", uploadingAt=now_iso())
    try:
        _run_sau_cli_publish(task_dir, inp)
        # 平台成功页只在 URL 上“确认成功”，不提供作品 ID；这里用同一 cookie
        # 立即回读创作者作品列表，取最新作品 ID/链接作为真实发布凭证。
        platform = str(inp.get("platform") or "")
        storage_file = task_dir / "storage.json"
        works: list[dict] = []
        if platform == "xhs":
            works, _complete = asyncio.run(_sync_xhs_works(storage_file))
        elif platform == "douyin":
            works, _complete = asyncio.run(_sync_douyin_works(storage_file))
        newest = max(works, key=lambda w: str(w.get("publishTime") or ""), default=None) if works else None
        work_id = str((newest or {}).get("dataId") or "")
        work_link = str((newest or {}).get("workLink") or "")
        if work_id == "":
            write_state(
                task_dir,
                status="failed",
                error="平台发布后未取回作品 ID，无法确认真实发布；请检查账号后重试",
                finishedAt=now_iso(),
            )
            return 1
        write_state(
            task_dir,
            status="done",
            platformWorkId=work_id,
            workLink=work_link,
            finishedAt=now_iso(),
        )
        return 0
    except Exception as exc:
        write_state(task_dir, status="failed", error=f"平台发布失败: {exc}", finishedAt=now_iso())
        return 1


def _parse_douyin_time(value) -> str:
    if isinstance(value, (int, float)) and value > 1_000_000_000:
        return datetime.fromtimestamp(float(value), tz=timezone.utc).isoformat()
    text = str(value or "")
    match = re.search(r"(\d{4})年(\d{1,2})月(\d{1,2})日\s+(\d{1,2}):(\d{2})", text)
    if match:
        y, mo, d, h, mi = (int(part) for part in match.groups())
        return datetime(y, mo, d, h, mi, tzinfo=timezone.utc).isoformat()
    return text


def _first_url(value) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        for key in ("url_list", "urlList", "uri"):
            item = value.get(key)
            if isinstance(item, list) and item:
                return str(item[0])
            if isinstance(item, str):
                return item
    return ""


def _count_or_none(*values: object) -> int | None:
    """取第一个有值的计数，都没有就返回 None：这次没采到，不要冒充 0。"""
    for value in values:
        if value is None or value == "":
            continue
        try:
            return int(value)
        except (TypeError, ValueError):
            continue
    return None


def _positive_or_none(value: object) -> int | None:
    """只认正数：平台把「不告诉你」写成 0 时，这个 0 不携带信息，按未采集处理。"""
    count = _count_or_none(value)
    return count if count else None


def _counts_or_drop(**counts: int | None) -> dict:
    """丢掉没采到的计数，让它们整键缺省。

    平台列表接口常常不返回播放量。写成 0 会让界面把「没采到」显示成「播放 0」，
    用户看到的就是一个编造的数字。
    """
    return {key: value for key, value in counts.items() if value is not None}


def _normalize_douyin_work(raw: dict, work_id: str) -> dict | None:
    if not work_id:
        return None
    stats = raw.get("statistics") or {}
    images = raw.get("images") or []
    publish_time = _parse_douyin_time(raw.get("create_time") or raw.get("createTime"))
    return {
        "dataId": work_id,
        "platform": "douyin",
        "title": str(raw.get("desc") or raw.get("title") or "").strip()[:80],
        "coverUrl": _first_url(raw.get("cover") or raw.get("cover_image_url") or ""),
        "workLink": "https://www.douyin.com/video/" + work_id,
        "publishTime": publish_time,
        "type": "ImageText" if images else "VIDEO",
        **_counts_or_drop(
            # 抖音创作者中心 item/list 对播放量一律回 0 占位：同一批作品里点赞/分享都有真值，
            # 55 次分享不可能 0 播放。这个 0 不携带信息，按未采集处理；非 0 才是真值。
            viewCount=_positive_or_none(stats.get("play_count")),
            likeCount=_count_or_none(stats.get("digg_count")),
            commentCount=_count_or_none(raw.get("comment_count"), stats.get("comment_count")),
            shareCount=_count_or_none(stats.get("share_count")),
            favoriteCount=_count_or_none(stats.get("collect_count")),
        ),
    }


async def _douyin_item_play_counts(
    page, recent_days: int = DOUYIN_ANALYTICS_RECENT_DAYS
) -> dict[str, int]:
    """按作品取创作者中心的真实播放量。

    返回 {aweme_id: 播放量}；只有这个接口确实给出指标的作品才在里面，其余保持未采集。
    取响应原文再用 json 解析（不是交给 JavaScript 值回传）：19 位 aweme_id 超过 double
    精度，经 JS 往返会被四舍五入（实测 7682660673825869119 变成 7682660673825869000），
    那样会把播放量挂到不存在的作品上。
    """
    url = (
        DOUYIN_ITEM_ANALYTICS_URL
        + "?dimension="
        + str(DOUYIN_ANALYTICS_PLAY_DIMENSION)
        + "&recent_days="
        + str(recent_days)
    )
    raw = await page.evaluate(
        """async (url) => {
             const res = await fetch(url, { credentials: 'include' });
             return await res.text();
           }""",
        url,
    )
    return _parse_douyin_play_counts(raw)


def _parse_douyin_play_counts(raw: object) -> dict[str, int]:
    """把投稿分析接口的响应原文解析成 {aweme_id: 播放量}。

    只认 status_code=0；其他状态（含 recent_days 取值不合法时的 5）一律返回空，
    宁可显示「未采集」，也不拿一个来路不明的数字冒充真实播放量。
    """
    if not isinstance(raw, str):
        return {}
    try:
        body = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    if not isinstance(body, dict) or body.get("status_code") != 0:
        return {}
    counts: dict[str, int] = {}
    for entry in body.get("items") or []:
        if not isinstance(entry, dict):
            continue
        item_id = str(entry.get("item_id") or "")
        value = entry.get("metric_value")
        if item_id == "" or not isinstance(value, (int, float)) or isinstance(value, bool):
            continue
        counts[item_id] = int(value)
    return counts


def _normalize_xhs_work(raw: dict, work_id: str) -> dict | None:
    if not work_id:
        return None
    interact = raw.get("interact_info") or raw
    raw_time_value = raw.get("visible_time") or raw.get("time") or raw.get("create_time") or raw.get("last_update_time") or 0
    if isinstance(raw_time_value, str):
        text = raw_time_value.strip()
        publish_time = ""
        try:
            if text.endswith("Z"):
                text = text[:-1] + "+00:00"
            if " " in text and "T" not in text:
                text = text.replace(" ", "T", 1)
            if not re.search(r"[+-]\d{2}:\d{2}$", text):
                text += "+00:00"
            publish_time = datetime.fromisoformat(text).isoformat()
        except ValueError:
            publish_time = ""
    else:
        raw_time = int(raw_time_value or 0)
        if raw_time > 1_000_000_000_000:
            raw_time = raw_time // 1000
        publish_time = datetime.fromtimestamp(raw_time, tz=timezone.utc).isoformat() if raw_time > 0 else ""
    cover = ""
    images = raw.get("images_list") or []
    if images:
        first_image = images[0]
        cover = _first_url(first_image.get("url") or "") if isinstance(first_image, dict) else str(first_image)
    if not cover:
        cover = _first_url(raw.get("cover") or "")
    return {
        "dataId": work_id,
        "platform": "xhs",
        "title": str(raw.get("display_title") or raw.get("title") or "").strip()[:80],
        "coverUrl": cover,
        "workLink": "https://www.xiaohongshu.com/explore/" + work_id,
        "publishTime": publish_time,
        "type": "ImageText",
        **_counts_or_drop(
            viewCount=_count_or_none(interact.get("view_count"), interact.get("viewed_count")),
            likeCount=_count_or_none(interact.get("likes"), interact.get("liked_count"), interact.get("like_count")),
            commentCount=_count_or_none(interact.get("comments_count"), interact.get("comment_count")),
            shareCount=_count_or_none(interact.get("shared_count"), interact.get("share_count")),
            favoriteCount=_count_or_none(interact.get("collected_count"), interact.get("collect_count")),
        ),
    }


def _payload_has_more(payload: object) -> bool:
    """从平台列表响应里读分页标记；任一常见字段为真即表示本次没拿全列表。"""
    if not isinstance(payload, dict):
        return False
    for key in ("has_more", "hasMore", "has_more_note"):
        if payload.get(key) is True:
            return True
    data = payload.get("data")
    if isinstance(data, dict):
        for key in ("has_more", "hasMore"):
            if data.get(key) is True:
                return True
    return False


def _is_xhs_note_list_url(url: str) -> bool:
    return "note" in url.lower() and (
        "creator.xiaohongshu.com" in url or "edith.xiaohongshu.com" in url
    )


def _shared_cdp(task_dir: Path) -> str | None:
    """读取登录守护进程写下的共享 Chrome CDP 端口，供同步任务复用。"""
    cdp_file = task_dir.parent.parent / "shared-cdp.json"
    if not cdp_file.exists():
        return None
    try:
        payload = json.loads(cdp_file.read_text(encoding="utf-8"))
        port = int(payload.get("port") or 0)
        return f"http://127.0.0.1:{port}" if port > 0 else None
    except Exception:
        return None


def _launch_kwargs() -> dict:
    """同步与发布共用的真实 Chrome 启动参数（与 interactions.py 保持一致）。"""
    from conf import LOCAL_CHROME_PATH  # noqa: PLC0415

    kwargs = {
        "headless": True,
        "args": [
            "--disable-blink-features=AutomationControlled",
            "--no-first-run",
            "--no-default-browser-check",
            "--lang=zh-CN",
        ],
    }
    if LOCAL_CHROME_PATH and Path(LOCAL_CHROME_PATH).exists():
        kwargs["executable_path"] = LOCAL_CHROME_PATH
    else:
        kwargs["channel"] = "chromium"
    return kwargs


async def _sync_xhs_works(storage_file: Path, cdp_url: str | None = None) -> tuple[list[dict], bool]:
    """用已登录 storage_state 打开小红书笔记管理页并捕获真实列表响应。

    返回 (作品列表, 是否拿全列表)；只有拿全时服务端才允许对账标记平台侧已删除的作品。
    """
    from patchright.async_api import async_playwright
    from utils.base_social_media import set_init_script
    from conf import LOCAL_CHROME_PATH

    captured: list[object] = []
    works: dict[str, dict] = {}
    complete = True
    async with async_playwright() as pw:
        shared = cdp_url is not None
        if shared:
            try:
                browser = await pw.chromium.connect_over_cdp(cdp_url)
                context = browser.contexts[0] if browser.contexts else await browser.new_context()
                cookies = json.loads(storage_file.read_text(encoding="utf-8")).get("cookies", [])
                if cookies:
                    await context.add_cookies(cookies)
            except Exception:
                shared = False
                browser = await pw.chromium.launch(**_launch_kwargs())
                context = await browser.new_context(storage_state=str(storage_file))
        else:
            launch_kwargs = {
                "headless": True,
                "args": ["--disable-blink-features=AutomationControlled", "--lang=zh-CN"],
            }
            if LOCAL_CHROME_PATH and Path(LOCAL_CHROME_PATH).exists():
                launch_kwargs["executable_path"] = LOCAL_CHROME_PATH
            else:
                launch_kwargs["channel"] = "chromium"
            browser = await pw.chromium.launch(**launch_kwargs)
            context = await browser.new_context(storage_state=str(storage_file))
        try:
            context = await set_init_script(context)
            page = await context.new_page()

            async def on_response(response) -> None:
                if _is_xhs_note_list_url(response.url):
                    captured.append(response)

            page.on("response", on_response)
            await page.goto(XHS_NOTE_MANAGE_URL, wait_until="domcontentloaded", timeout=90_000)
            await page.wait_for_timeout(9000)
            for _ in range(3):
                await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                await page.wait_for_timeout(2500)

            for response in captured:
                try:
                    data = await response.json()
                except Exception:
                    continue
                if _payload_has_more(data):
                    complete = False
                notes = data.get("data", {}).get("notes") if isinstance(data.get("data"), dict) else data.get("notes")
                if not isinstance(notes, list):
                    notes = data.get("data", {}).get("note_list") if isinstance(data.get("data"), dict) else []
                for raw in notes:
                    work_id = str(raw.get("note_id") or raw.get("id") or "")
                    item = _normalize_xhs_work(raw, work_id)
                    if item:
                        works[work_id] = item
        finally:
            if not shared:
                await browser.close()
    return (
        sorted(works.values(), key=lambda item: item.get("publishTime") or "", reverse=True),
        complete and bool(works),
        {},
    )


async def _sync_douyin_works(storage_file: Path, cdp_url: str | None = None) -> tuple[list[dict], bool]:
    """用已登录 storage_state 打开抖音作品管理页并捕获真实 work_list 接口。

    返回 (作品列表, 是否拿全列表)；只有拿全时服务端才允许对账标记平台侧已删除的作品。
    """
    from patchright.async_api import async_playwright
    from utils.base_social_media import set_init_script
    from conf import LOCAL_CHROME_PATH

    captured: list[object] = []
    works: dict[str, dict] = {}
    complete = True
    async with async_playwright() as pw:
        shared = cdp_url is not None
        if shared:
            try:
                browser = await pw.chromium.connect_over_cdp(cdp_url)
                context = browser.contexts[0] if browser.contexts else await browser.new_context()
                cookies = json.loads(storage_file.read_text(encoding="utf-8")).get("cookies", [])
                if cookies:
                    await context.add_cookies(cookies)
            except Exception:
                shared = False
                browser = await pw.chromium.launch(**_launch_kwargs())
                context = await browser.new_context(storage_state=str(storage_file))
        else:
            launch_kwargs = {
                "headless": True,
                "args": [
                    "--disable-blink-features=AutomationControlled",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--lang=zh-CN",
                ],
            }
            if LOCAL_CHROME_PATH and Path(LOCAL_CHROME_PATH).exists():
                launch_kwargs["executable_path"] = LOCAL_CHROME_PATH
            else:
                launch_kwargs["channel"] = "chromium"
            browser = await pw.chromium.launch(**launch_kwargs)
            context = await browser.new_context(storage_state=str(storage_file))
        try:
            context = await set_init_script(context)
            page = await context.new_page()

            async def on_response(response) -> None:
                if DOUYIN_WORK_LIST_MARKER in response.url:
                    captured.append(response)

            page.on("response", on_response)
            await page.goto(
                "https://creator.douyin.com/creator-micro/content/manage",
                wait_until="domcontentloaded",
                timeout=90_000,
            )
            await page.wait_for_timeout(8000)
            for _ in range(3):
                await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                await page.wait_for_timeout(3000)

            # 登录失效检测：页面出现登录框且未抓到任何作品时，明确报错而不是静默返回 0 条。
            if not works:
                body_text = await page.evaluate("document.body.innerText")
                if "扫码登录" in body_text or "验证码登录" in body_text:
                    raise RuntimeError("抖音登录已失效，请重新扫码登录")

            for response in captured:
                try:
                    data = await response.json()
                except Exception:
                    continue
                if _payload_has_more(data):
                    complete = False
                for raw in data.get("aweme_list") or data.get("item_info_list") or []:
                    work_id = str(raw.get("aweme_id") or raw.get("item_id") or raw.get("item_id_plain") or "")
                    item = _normalize_douyin_work(raw, work_id)
                    if item:
                        works[work_id] = item

            # 兜底/补全：旧版作品列表接口分页拉取，直到 has_more=false 才算拿全。
            # 首屏只有 5~20 条且 has_more=true，不翻页就拿不到完整列表，对账会误判。
            try:
                cursor = 0
                paged = False
                for _ in range(50):
                    response = await page.request.get(
                        DOUYIN_ITEM_LIST_URL + "&count=20&cursor=" + str(cursor),
                        headers={
                            "User-Agent": DOUYIN_SYNC_UA,
                            "Accept": "application/json, text/plain, */*",
                            "Referer": "https://creator.douyin.com/creator-micro/home",
                        },
                        timeout=30_000,
                    )
                    data = await response.json()
                    if data.get("status_code") == 8:
                        raise RuntimeError("抖音登录已失效，请重新扫码登录")
                    for raw in data.get("item_info_list") or []:
                        work_id = str(raw.get("item_id_plain") or raw.get("item_id") or "")
                        item = _normalize_douyin_work(raw, work_id)
                        if item:
                            works.setdefault(work_id, item)
                    if not data.get("has_more"):
                        paged = True
                        break
                    next_cursor = data.get("next_cursor") or data.get("max_cursor")
                    if not next_cursor or int(next_cursor) == cursor:
                        break
                    cursor = int(next_cursor)
                # 翻到末页才算完整列表；否则保持不完整，禁止对账删除。
                complete = paged and bool(works)
            except RuntimeError:
                raise
            except Exception:
                pass

            # 真实播放量：作品列表接口的 play_count 是 0 占位，只有投稿分析接口带真值。
            # 匹配不上的分析条目只记数上报，绝不凭分析接口的 id 造一条作品记录。
            analytics = {"recentDays": DOUYIN_ANALYTICS_RECENT_DAYS, "items": 0, "matched": 0, "unmatched": 0}
            try:
                play_counts = await _douyin_item_play_counts(page)
            except Exception:
                play_counts = {}
            analytics["items"] = len(play_counts)
            for work_id, play_count in play_counts.items():
                work = works.get(work_id)
                if work is None:
                    analytics["unmatched"] += 1
                    continue
                work["viewCount"] = play_count
                analytics["matched"] += 1
        finally:
            if not shared:
                await browser.close()

    return (
        sorted(works.values(), key=lambda item: item.get("publishTime") or "", reverse=True),
        complete and bool(works),
        analytics,
    )


def run_sync(task_dir: Path) -> int:
    storage_file = task_dir / "storage.json"
    if not storage_file.exists():
        write_state(task_dir, status="failed", error="同步任务缺少 storage.json", finishedAt=now_iso())
        return 1
    try:
        inp = json.loads((task_dir / "input.json").read_text(encoding="utf-8"))
    except Exception:
        inp = {}
    platform = str(inp.get("platform") or "douyin")
    write_state(task_dir, status="starting", startedAt=now_iso())
    try:
        cdp_url = _shared_cdp(task_dir)
        if platform == "xhs":
            works, complete, analytics = asyncio.run(_sync_xhs_works(storage_file, cdp_url))
        else:
            works, complete, analytics = asyncio.run(_sync_douyin_works(storage_file, cdp_url))
        # 同一份登录态顺带采集账号资料，让粉丝数随每次同步刷新到当前值，
        # 而不是停在登录时点（服务端 platform-sync 负责回写 accounts.json）。
        profile = fetch_platform_profile(platform, storage_file)
        write_state(
            task_dir,
            status="done",
            platform=platform,
            works=works,
            workCount=len(works),
            complete=complete,
            analytics=analytics,
            profile=profile,
            finishedAt=now_iso(),
        )
        return 0
    except Exception as exc:
        write_state(task_dir, status="failed", error=f"{platform}数据同步失败: {exc}", finishedAt=now_iso())
        return 1


def run_cover(task_dir: Path) -> int:
    """生成内容卡片（AI 标题 + 品牌渐变底），供图文/视频素材使用。
    支持 input.json:
      {cards: [{title, subtitle}], outFiles: [paths]}  多张独立卡片
      或 {title, subtitle, outFiles: [paths]}            单内容多张（页码区分）
    """
    from PIL import Image, ImageDraw, ImageFont

    input_file = task_dir / "input.json"
    try:
        inp = json.loads(input_file.read_text(encoding="utf-8"))
    except Exception as exc:
        write_state(task_dir, status="failed", error=f"读取封面任务失败: {exc}", finishedAt=now_iso())
        return 1

    out_files = [str(p) for p in (inp.get("outFiles") or [])]
    raw_cards = inp.get("cards")
    if isinstance(raw_cards, list) and raw_cards:
        cards = [
            {
                "title": str(c.get("title") or "").strip() or "内容卡片",
                "subtitle": str(c.get("subtitle") or "").strip(),
            }
            for c in raw_cards
            if isinstance(c, dict)
        ]
    else:
        title = str(inp.get("title") or "").strip()
        cards = [
            {"title": title or "内容卡片", "subtitle": str(inp.get("subtitle") or "").strip()}
            for _ in range(max(1, min(len(out_files), 4)))
        ]
    if not cards or not out_files:
        write_state(task_dir, status="failed", error="封面任务缺少卡片内容或输出路径", finishedAt=now_iso())
        return 1

    font_candidates = [
        Path("C:/Windows/Fonts/msyh.ttc"),
        Path("C:/Windows/Fonts/msyhbd.ttc"),
        Path("C:/Windows/Fonts/simhei.ttf"),
    ]
    title_font = None
    sub_font = None
    for candidate in font_candidates:
        if candidate.exists():
            try:
                title_font = ImageFont.truetype(str(candidate), 96)
                sub_font = ImageFont.truetype(str(candidate), 44)
                break
            except Exception:
                continue
    if title_font is None:
        title_font = ImageFont.load_default()
        sub_font = ImageFont.load_default()

    width, height = 1242, 1660
    try:
        for index, (card, out_file) in enumerate(zip(cards, out_files)):
            title = card["title"]
            subtitle = card["subtitle"]
            image = Image.new("RGB", (width, height))
            draw = ImageDraw.Draw(image)
            # 品牌渐变（紫→青，对角）
            for y in range(height):
                ratio = y / height
                color = (
                    int(43 + (34 - 43) * ratio),
                    int(37 + (211 - 37) * ratio),
                    int(125 + (238 - 125) * ratio),
                )
                draw.line([(0, y), (width, y)], fill=color)
            # 品牌角标
            draw.text((84, 84), "Bosom Friend", font=sub_font, fill=(255, 255, 255))
            draw.text((84, 148), "AI 创作 · 小红书笔记", font=sub_font, fill=(255, 255, 255))
            # 标题：按 12 字/行折行，居中
            lines: list[str] = []
            for i in range(0, len(title), 12):
                lines.append(title[i:i + 12])
            line_height = 130
            total_height = line_height * len(lines)
            start_y = (height - total_height) // 2 - 40
            for i, line in enumerate(lines):
                bbox = draw.textbbox((0, 0), line, font=title_font)
                line_w = bbox[2] - bbox[0]
                draw.text(((width - line_w) // 2, start_y + i * line_height), line, font=title_font, fill=(255, 255, 255))
            if subtitle:
                sub_bbox = draw.textbbox((0, 0), subtitle, font=sub_font)
                draw.text(((width - (sub_bbox[2] - sub_bbox[0])) // 2, start_y + total_height + 120), subtitle, font=sub_font, fill=(255, 255, 255))
            # 底部页码/编号（多封面时区分）
            if len(out_files) > 1:
                draw.text((width - 220, height - 120), f"{index + 1}/{len(out_files)}", font=sub_font, fill=(255, 255, 255))
            image.save(out_file, "PNG")
        write_state(task_dir, status="done", finishedAt=now_iso())
        return 0
    except Exception as exc:
        write_state(task_dir, status="failed", error=f"封面生成失败: {exc}", finishedAt=now_iso())
        return 1


def run_profile(platform: str, storage_file: Path, out_dir: Path) -> int:
    """登录成功后后台补传账号资料（不影响登录上屏速度）。"""
    try:
        profile = asyncio.run(capture_profile(platform, storage_file))
    except Exception:
        profile = {}
    nickname = str(profile.get("nickname") or "")
    avatar = str(profile.get("avatar") or "")
    fields: dict = {
        "status": "done" if nickname or avatar else "empty",
        "nickname": nickname,
        "avatar": avatar,
        "finishedAt": now_iso(),
    }
    # 只有创作者资料接口给出的粉丝数才落盘：DOM 兜底路径没有粉丝数，
    # 写入 0 会把登录时的真实值抹掉。
    if "fansCount" in profile:
        fields["fansCount"] = int(profile.get("fansCount") or 0)
    write_state(out_dir, **fields)
    return 0


def run_daemon(jobs_dir: Path) -> int:
    """常驻守护：预加载登录模块，并发消费登录任务，避免每次冷启动重依赖与串行排队。"""
    import threading

    # 单实例接管（成熟方案 psutil）：清掉所有旧守护实例（含其浏览器进程树），
    # 避免旧进程拿死端口抢任务导致 connect_over_cdp ECONNREFUSED
    import psutil

    me = os.getpid()
    my_ancestors = {p.pid for p in psutil.Process(me).parents()}
    for proc in psutil.process_iter(["pid", "cmdline"]):
        try:
            cmd = " ".join(proc.info.get("cmdline") or [])
            if proc.info.get("pid") == me:
                continue
            if proc.info.get("pid") in my_ancestors:
                continue
            if "worker.py" in cmd and "daemon" in cmd:
                marks = cmd.split("daemon", 1)[1].strip()
                if not jobs_dir.name in marks and str(jobs_dir) not in cmd:
                    continue
                try:
                    for child in proc.children(recursive=True):
                        try:
                            child.kill()
                        except psutil.Error:
                            pass
                    proc.kill()
                    proc.wait(timeout=3)
                except psutil.Error:
                    pass
        except (psutil.Error, OSError):
            continue

    for platform in ("xhs", "douyin", "ks", "tencent"):
        try:
            load_modern_login(platform)
        except Exception:
            pass
    jobs_dir.mkdir(parents=True, exist_ok=True)
    daemon_started_at = time.time()

    threads: dict[str, threading.Thread] = {}
    shared_cdp = ensure_shared_chrome(jobs_dir.parent)

    def consume(job: dict, job_file: Path) -> None:
        try:
            platform = str(job.get("platform") or "")
            state_dir = Path(str(job.get("stateDir") or "")).resolve()
            if platform and state_dir.is_dir():
                asyncio.run(run_login(platform, state_dir, shared_cdp, jobs_dir.parent))
        except Exception:
            pass
        finally:
            try:
                job_file.unlink()
            except OSError:
                pass

    while True:
        try:
            job_files = sorted(jobs_dir.glob("job-*.json"), key=lambda p: p.stat().st_mtime)
            for job_file in job_files:
                # 守护进程重启后旧登录任务一律不续跑（会话已随旧进程失效），
                # 只处理重启之后新发起的任务，避免多个过期二维码抢占浏览器。
                if job_file.stat().st_mtime < daemon_started_at - 5:
                    try:
                        job_file.unlink()
                    except OSError:
                        pass
                    continue
                try:
                    job = json.loads(job_file.read_text(encoding="utf-8"))
                except Exception:
                    try:
                        job_file.unlink()
                    except OSError:
                        pass
                    continue
                job_id = str(job.get("id") or job_file.stem)
                active = threads.get(job_id)
                if active is not None and active.is_alive():
                    continue
                thread = threading.Thread(target=consume, args=(job, job_file), daemon=True)
                threads[job_id] = thread
                thread.start()
        except Exception:
            pass
        import time as _time
        _time.sleep(0.3)


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[1] == "daemon":
        if len(argv) != 3:
            return 2
        return run_daemon(Path(argv[2]).resolve())
    if len(argv) >= 2 and argv[1] == "sync":
        if len(argv) != 4:
            print("usage: python worker.py sync <taskId> <taskDir>", file=sys.stderr)
            return 2
        task_dir = Path(argv[3]).resolve()
        task_dir.mkdir(parents=True, exist_ok=True)
        try:
            log = open(task_dir / "worker.log", "w", encoding="utf-8")
            sys.stdout = log
            sys.stderr = log
        except OSError:
            pass
        return run_sync(task_dir)
    if len(argv) >= 2 and argv[1] == "profile":
        if len(argv) != 6:
            return 2
        return run_profile(argv[3], Path(argv[4]).resolve(), Path(argv[5]).resolve())
    if len(argv) >= 2 and argv[1] == "publish":
        if len(argv) != 4:
            print("usage: python worker.py publish <taskId> <taskDir>", file=sys.stderr)
            return 2
        task_dir = Path(argv[3]).resolve()
        task_dir.mkdir(parents=True, exist_ok=True)
        try:
            log = open(task_dir / "worker.log", "w", encoding="utf-8")
            sys.stdout = log
            sys.stderr = log
        except OSError:
            pass
        return run_publish(task_dir)
    if len(argv) >= 2 and argv[1] == "cover":
        if len(argv) != 4:
            print("usage: python worker.py cover <taskId> <taskDir>", file=sys.stderr)
            return 2
        task_dir = Path(argv[3]).resolve()
        task_dir.mkdir(parents=True, exist_ok=True)
        try:
            log = open(task_dir / "worker.log", "w", encoding="utf-8")
            sys.stdout = log
            sys.stderr = log
        except OSError:
            pass
        return run_cover(task_dir)
    if len(argv) >= 2 and argv[1] == "interact":
        # 平台互动（评论/私信 列表与回复）：真实浏览器 + 登录态，业务在 interactions.py。
        if len(argv) != 4:
            print("usage: python worker.py interact <taskId> <taskDir>", file=sys.stderr)
            return 2
        task_dir = Path(argv[3]).resolve()
        task_dir.mkdir(parents=True, exist_ok=True)
        try:
            log = open(task_dir / "worker.log", "w", encoding="utf-8")
            sys.stdout = log
            sys.stderr = log
        except OSError:
            pass
        from interactions import main as interactions_main

        return interactions_main(["interactions.py", "run", str(task_dir)])
    if len(argv) != 5 or argv[1] != "login":
        print("usage: python worker.py login <platform> <sessionId> <stateDir>", file=sys.stderr)
        return 2
    _, _, platform, session_id, state_dir_arg = argv

    state_dir = Path(state_dir_arg).resolve()
    state_dir.mkdir(parents=True, exist_ok=True)
    try:
        log = open(state_dir / "worker.log", "w", encoding="utf-8")
        sys.stdout = log
        sys.stderr = log
    except OSError:
        pass

    write_state(
        state_dir,
        sessionId=session_id,
        platform=platform,
        status="starting",
        startedAt=now_iso(),
    )
    try:
        ok = asyncio.run(run_login(platform, state_dir))
        return 0 if ok else 1
    except Exception as exc:
        write_state(state_dir, status="failed", error=f"平台登录引擎异常: {exc}", finishedAt=now_iso())
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
