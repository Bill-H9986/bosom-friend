/**
 * 浏览器控制 IPC —— 检测 / 启动 / 关闭 / 配置
 */
import { Controller, Icp } from '../core/decorators';
import { browserControlManager } from './manager';
import type { AutomationEngine } from './manager';

@Controller()
export class BrowserControlController {
  /** 检测本机 Chrome / Edge */
  @Icp('zhiyin:browser:detect')
  async detect() {
    return browserControlManager.detectBrowsers(true);
  }

  /** 获取浏览器控制中心完整状态 */
  @Icp('zhiyin:browser:getState')
  async getState() {
    return browserControlManager.getState();
  }

  /** 启动指定浏览器的自动化实例 */
  @Icp('zhiyin:browser:launch')
  async launch(
    _event: Electron.IpcMainInvokeEvent,
    kind: 'chrome' | 'edge',
    platform?: string,
  ) {
    return browserControlManager.launchInstance(kind, platform);
  }

  /** 在实例中打开页面 */
  @Icp('zhiyin:browser:openUrl')
  async openUrl(
    _event: Electron.IpcMainInvokeEvent,
    id: string,
    url: string,
  ) {
    const ok = await browserControlManager.openUrlInInstance(id, url);
    return { ok };
  }

  /** 关闭实例 */
  @Icp('zhiyin:browser:close')
  async close(_event: Electron.IpcMainInvokeEvent, id: string) {
    const ok = await browserControlManager.closeInstance(id);
    return { ok };
  }

  /** 实例存活检测 */
  @Icp('zhiyin:browser:isAlive')
  async isAlive(_event: Electron.IpcMainInvokeEvent, id: string) {
    return browserControlManager.isAlive(id);
  }

  /** 设置默认自动化引擎 */
  @Icp('zhiyin:browser:setDefaultEngine')
  async setDefaultEngine(
    _event: Electron.IpcMainInvokeEvent,
    engine: AutomationEngine,
  ) {
    browserControlManager.setDefaultEngine(engine);
    return { ok: true };
  }
}
