/**
 * 浏览器检测 —— Chrome / Edge 安装路径探测
 *
 * 探测顺序：
 *   1) Windows 注册表 App Paths（HKLM / HKCU）
 *   2) 常见安装目录（Program Files / Program Files(x86) / LocalAppData）
 *
 * 对齐竞品（腾讯云插件、影刀 RPA）：Chrome 与 Edge 同为 Chromium 内核，
 * 扩展机制与 CDP 协议完全通用，同一套自动化引擎可无缝运行在两个浏览器上。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type BrowserKind = 'chrome' | 'edge';

export interface DetectedBrowser {
  kind: BrowserKind;
  /** 展示名 */
  name: string;
  exePath: string;
  /** 产品版本（尽力获取，失败为空） */
  version?: string;
}

const BROWSER_META: Record<BrowserKind, { name: string; exe: string }> = {
  chrome: { name: '谷歌浏览器（Chrome）', exe: 'chrome.exe' },
  edge: { name: '微软 Edge 浏览器', exe: 'msedge.exe' },
};

function commonPaths(kind: BrowserKind): string[] {
  const pf = process.env.ProgramFiles;
  const pf86 = process.env['ProgramFiles(x86)'];
  const lad = process.env.LOCALAPPDATA;
  if (kind === 'chrome') {
    return [
      pf ? path.join(pf, 'Google/Chrome/Application/chrome.exe') : '',
      pf86 ? path.join(pf86, 'Google/Chrome/Application/chrome.exe') : '',
      lad ? path.join(lad, 'Google/Chrome/Application/chrome.exe') : '',
    ].filter(Boolean);
  }
  return [
    pf86 ? path.join(pf86, 'Microsoft/Edge/Application/msedge.exe') : '',
    pf ? path.join(pf, 'Microsoft/Edge/Application/msedge.exe') : '',
  ].filter(Boolean);
}

/** 通过注册表 App Paths 读取浏览器可执行文件路径 */
async function queryRegistryAppPath(exe: string): Promise<string | null> {
  const keys = [
    `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
    `HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
  ];
  const query = (key: string) =>
    execFileAsync('reg', ['query', key, '/ve'], { windowsHide: true })
      .then(({ stdout }) => {
        const m = stdout.match(/REG_SZ\s+(.+)/);
        return m ? m[1].trim() : null;
      })
      .catch(() => null);
  return query(keys[0]).then((p) => (p ? p : query(keys[1])));
}

/** 读取 exe 文件版本号（异步尽力而为） */
async function readVersion(exePath: string): Promise<string | undefined> {
  try {
    const safePath = exePath.replace(/'/g, "''");
    const { stdout } = await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `(Get-Item -LiteralPath '${safePath}').VersionInfo.ProductVersion`,
      ],
      { timeout: 5000, windowsHide: true },
    );
    const v = stdout.trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}

export async function detectBrowser(
  kind: BrowserKind,
): Promise<DetectedBrowser | null> {
  const meta = BROWSER_META[kind];
  let exePath: string | null = await queryRegistryAppPath(meta.exe);
  if (!exePath || !fs.existsSync(exePath)) {
    exePath = commonPaths(kind).find((p) => fs.existsSync(p)) || null;
  }
  if (!exePath) return null;
  const version = await readVersion(exePath);
  return { kind, name: meta.name, exePath, version };
}

export async function detectBrowsers(): Promise<DetectedBrowser[]> {
  const [chrome, edge] = await Promise.all([
    detectBrowser('chrome'),
    detectBrowser('edge'),
  ]);
  return [chrome, edge].filter(Boolean) as DetectedBrowser[];
}
