/*
 * @Author: nevin
 * @Date: 2025-01-18 20:27:42
 * @LastEditTime: 2025-01-20 10:34:52
 * @LastEditors: nevin
 * @Description:
 */
import { app, Tray, Menu, BrowserWindow } from 'electron';
import { getAssetPath } from '../util/index.js';

export class SystemTray {
  private tray: Tray | null = null;

  constructor(private mainWindow: BrowserWindow) {}

  create(): Tray {
    if (this.tray) return this.tray;

    // 托盘图标用 PNG（sharp 生成的 ico 兼容性差，Electron 原生支持 PNG）
    const icoPath = getAssetPath('logo-32.png');
    this.tray = new Tray(icoPath);
    this.setupTrayMenu();
    this.setupTrayEvents();

    return this.tray;
  }

  // 设置托盘菜单
  private setupTrayMenu() {
    if (!this.tray) return;

    const contextMenu = Menu.buildFromTemplate([
      {
        label: '显示',
        click: () => this.mainWindow.show(),
      },
      {
        label: '最小化',
        click: () => this.mainWindow.hide(),
      },
      {
        type: 'separator',
      },
      {
        label: '退出',
        click: () => app.quit(),
      },
    ]);

    this.tray.setToolTip('Bosom Friend');
    this.tray.setContextMenu(contextMenu);
  }

  // 设置托盘事件
  private setupTrayEvents() {
    if (!this.tray) return;

    this.tray.on('click', () => {
      const win = this.mainWindow;
      if (win) {
        win.show();
        win.focus();
      }
    });
  }

  // 销毁托盘
  destroy() {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}
