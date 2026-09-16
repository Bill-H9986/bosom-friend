/**
 * 浏览器控制中心 —— 实例管理与引擎配置
 *
 * 能力：
 *   - 检测本机 Chrome / Edge；
 *   - 启动独立 Profile 的自动化实例（CDP 可连接）；
 *   - 关闭实例、查看状态；
 *   - 配置默认自动化引擎（内置浏览器 / Chrome / Edge）。
 *
 * 风控对齐：每个账号一个独立用户数据目录，物理隔离 Cookie 与登录态，
 * 多实例错峰使用，避免同指纹关联（参考影刀 RPA / AdsPower 方案）。
 */
import { app } from 'electron';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { store } from '../../global/store';
import { appendAutoLog } from '../knowledge/autoLog';
import { logger } from '../../global/log';
import {
  detectBrowsers,
  type BrowserKind,
  type DetectedBrowser,
} from './detect';
import {
  killBrowserProcess,
  launchBrowser,
  type LaunchedBrowser,
} from './launcher';
import { openUrl as cdpOpenUrl, getTargets } from './cdp';

export type AutomationEngine = 'embedded' | BrowserKind;

export interface BrowserInstance {
  id: string;
  kind: BrowserKind;
  name: string;
  exePath: string;
  port: number;
  profileDir: string;
  openUrl?: string;
  pid?: number;
  startedAt: number;
  status: 'starting' | 'running' | 'stopped' | 'error';
  error?: string;
}

/** 各平台自动化默认落地页 */
export const PLATFORM_AUTO_URLS: Record<string, string> = {
  douyin: 'https://creator.douyin.com/',
  xhs: 'https://creator.xiaohongshu.com/',
};

const ENGINE_STORE_KEY = 'zhiyin-browser-engine';
const PORT_START = 9333;
const PORT_END = 9666;

class BrowserControlManager {
  private instances = new Map<string, BrowserInstance & { child?: LaunchedBrowser }>();
  private browsersCache: DetectedBrowser[] = [];

  /** 探测本机浏览器（带 30s 缓存，避免每次调用都跑注册表） */
  async detectBrowsers(force = false): Promise<DetectedBrowser[]> {
    if (force || this.browsersCache.length === 0) {
      this.browsersCache = await detectBrowsers();
    }
    return this.browsersCache;
  }

  getDefaultEngine(): AutomationEngine {
    const saved = store.get(ENGINE_STORE_KEY) as AutomationEngine | undefined;
    return saved === 'chrome' || saved === 'edge' || saved === 'embedded'
      ? saved
      : 'embedded';
  }

  setDefaultEngine(engine: AutomationEngine): void {
    store.set(ENGINE_STORE_KEY, engine);
    void appendAutoLog(
      '浏览器控制',
      `默认自动化引擎已切换为：${
        engine === 'embedded'
          ? '内置浏览器'
          : engine === 'chrome'
            ? '谷歌浏览器'
            : '微软 Edge 浏览器'
      }`,
    );
  }

  listInstances(): BrowserInstance[] {
    return Array.from(this.instances.values()).map(({ child, ...info }) => ({
      ...info,
      pid: info.pid ?? child?.pid,
    }));
  }

  async getState(): Promise<{
    browsers: DetectedBrowser[];
    instances: BrowserInstance[];
    defaultEngine: AutomationEngine;
  }> {
    const [browsers, instances] = await Promise.all([
      this.detectBrowsers(),
      Promise.resolve(this.listInstances()),
    ]);
    return {
      browsers,
      instances,
      defaultEngine: this.getDefaultEngine(),
    };
  }

  async launchInstance(
    kind: BrowserKind,
    platform = 'douyin',
  ): Promise<BrowserInstance> {
    const browsers = await this.detectBrowsers();
    const target = browsers.find((b) => b.kind === kind);
    if (!target) {
      throw new Error(`未检测到${kind === 'chrome' ? '谷歌' : '微软 Edge'}浏览器`);
    }

    const id = `${kind}-${Date.now().toString(36)}-${crypto
      .randomUUID()
      .slice(0, 6)}`;
    const port = await this.allocatePort();
    const profileDir = path.join(
      app.getPath('userData'),
      'browserProfiles',
      id,
    );
    fs.mkdirSync(profileDir, { recursive: true });

    const openUrl = PLATFORM_AUTO_URLS[platform] || PLATFORM_AUTO_URLS.douyin;
    const record: BrowserInstance & { child?: LaunchedBrowser } = {
      id,
      kind,
      name: target.name,
      exePath: target.exePath,
      port,
      profileDir,
      openUrl,
      startedAt: Date.now(),
      status: 'starting',
    };
    this.instances.set(id, record);

    try {
      const launched = await launchBrowser({
        exePath: target.exePath,
        port,
        profileDir,
        openUrl,
        visible: true,
      });
      record.child = launched;
      record.pid = launched.pid;
      record.status = 'running';
      void appendAutoLog(
        '浏览器控制',
        `已启动 ${target.name} 自动化实例（端口 ${port}，独立环境 ${id}），打开 ${openUrl}`,
      );
    } catch (e) {
      record.status = 'error';
      record.error = (e as Error).message;
      logger.error('[browser-control] 启动实例失败:', e);
      void appendAutoLog(
        '浏览器控制',
        `启动 ${target.name} 自动化实例失败：${(e as Error).message}`,
      );
    }
    return this.toPublic(record);
  }

  async openUrlInInstance(id: string, url: string): Promise<boolean> {
    const record = this.instances.get(id);
    if (!record || !record.pid) return false;
    try {
      await cdpOpenUrl(record.port, url);
      return true;
    } catch (e) {
      logger.error('[browser-control] 打开页面失败:', e);
      return false;
    }
  }

  async closeInstance(id: string): Promise<boolean> {
    const record = this.instances.get(id);
    if (!record) return false;
    if (record.child?.pid) {
      await killBrowserProcess(record.child.child);
    }
    record.status = 'stopped';
    void appendAutoLog(
      '浏览器控制',
      `已关闭 ${record.name} 自动化实例（${record.port}）`,
    );
    this.instances.delete(id);
    return true;
  }

  /** 实例是否仍可连接（CDP 存活检测） */
  async isAlive(id: string): Promise<boolean> {
    const record = this.instances.get(id);
    if (!record) return false;
    const targets = await getTargets(record.port);
    return targets.length > 0;
  }

  /** 关闭全部实例（应用退出时调用） */
  async closeAll(): Promise<void> {
    const ids = Array.from(this.instances.keys());
    await Promise.all(ids.map((id) => this.closeInstance(id)));
  }

  private async allocatePort(): Promise<number> {
    for (let p = PORT_START; p <= PORT_END; p++) {
      if (await this.isPortFree(p)) return p;
    }
    throw new Error('没有可用调试端口（9333-9666 已被占用）');
  }

  private isPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = net.createConnection({ port, host: '127.0.0.1' });
      sock.once('connect', () => {
        sock.destroy();
        resolve(false);
      });
      sock.once('error', () => resolve(true));
      sock.setTimeout(800);
      sock.once('timeout', () => {
        sock.destroy();
        resolve(false);
      });
    });
  }

  private toPublic(
    record: BrowserInstance & { child?: LaunchedBrowser },
  ): BrowserInstance {
    const { child, ...info } = record;
    return { ...info, pid: info.pid ?? child?.pid };
  }
}

export const browserControlManager = new BrowserControlManager();
