/**
 * 外部浏览器启动器 —— Chrome / Edge 自动化实例
 *
 * 对齐竞品（影刀 RPA / AdsPower / 腾讯云插件）的浏览器实例隔离方案：
 *   - 每个自动化实例使用独立的 --user-data-dir，账号 Cookie / 登录态物理隔离，
 *     避免多账号串号触发平台风控；
 *   - 通过 --remote-debugging-port 开放 CDP，主进程用同一套协议控制页面；
 *   - 可选 --load-extension 加载解压版扩展（未来对接官方 MV3 引擎）。
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface LaunchOptions {
  exePath: string;
  port: number;
  profileDir: string;
  /** 启动后打开的 URL（如抖音创作者中心） */
  openUrl?: string;
  /** 是否显示浏览器窗口；false 走 --headless=new（适合无需扫码的纯自动化） */
  visible?: boolean;
  /** 解压版扩展目录（可选，--load-extension） */
  extensionDir?: string;
}

export interface LaunchedBrowser {
  pid: number;
  port: number;
  profileDir: string;
  exePath: string;
  child: ChildProcess;
}

const WAIT_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 300;

/** 轮询等待 CDP 调试端口就绪 */
export function waitForCdp(
  port: number,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const check = async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (res.ok) {
          resolve(true);
          return;
        }
      } catch {
        // 浏览器尚未就绪
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(check, POLL_INTERVAL_MS);
    };
    void check();
  });
}

/** 启动外部浏览器实例（独立 Profile + CDP 端口） */
export function launchBrowser(opts: LaunchOptions): Promise<LaunchedBrowser> {
  const args = [
    `--remote-debugging-port=${opts.port}`,
    `--user-data-dir=${opts.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--disable-features=Translate,OptimizationHints,MediaRouter',
    '--window-size=1280,800',
  ];
  if (opts.visible === false) {
    args.push('--headless=new');
  }
  if (
    opts.extensionDir &&
    fs.existsSync(path.join(opts.extensionDir, 'manifest.json'))
  ) {
    args.push(`--disable-extensions-except=${opts.extensionDir}`);
    args.push(`--load-extension=${opts.extensionDir}`);
  }
  if (opts.openUrl) args.push(opts.openUrl);

  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(opts.exePath, args, {
        stdio: 'ignore',
        windowsHide: opts.visible === false,
      });
    } catch (e) {
      reject(new Error(`启动浏览器失败: ${(e as Error).message}`));
      return;
    }
    child.once('error', (err) => {
      reject(new Error(`启动浏览器失败: ${err.message}`));
    });
    void waitForCdp(opts.port).then((ok) => {
      if (ok) {
        resolve({
          pid: child.pid as number,
          port: opts.port,
          profileDir: opts.profileDir,
          exePath: opts.exePath,
          child,
        });
      } else {
        try {
          child.kill();
        } catch {
          // 忽略清理失败
        }
        reject(
          new Error(
            `浏览器调试端口 ${opts.port} 等待超时，请确认端口未被其他程序占用`,
          ),
        );
      }
    });
  });
}

/** 结束浏览器实例（Windows 下强制结束进程树，仅限本模块自己启动的实例） */
export function killBrowserProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    const pid = child.pid;
    if (!pid) {
      resolve();
      return;
    }
    execFile(
      'taskkill',
      ['/pid', String(pid), '/T', '/F'],
      { windowsHide: true },
      () => resolve(),
    );
    // 兜底：taskkill 失败时直接 kill
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 已退出则忽略
      }
    }, 5000);
  });
}
