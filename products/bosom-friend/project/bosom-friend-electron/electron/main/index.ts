import { app, BrowserWindow, shell, ipcMain, nativeTheme, crashReporter } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { update } from './update';
import { SystemTray } from '../tray/systemTray';
import { views } from './views';
import App from './app';
import { getAssetPath } from '../util/index';
import windowOperate from '../util/windowOperate';
import { logger } from '../global/log';
import { SplashWindow } from './splash';
import dotenv from 'dotenv';
import { registerContextMenuListener } from '@electron-uikit/contextmenu';
import { openDshLab, registerDshIpc } from './dsh-agent';
import { dialog } from 'electron';
import { ensureDouyinAutoWindow } from './plat/autoDouyinWindow';
import { AppControlMcpServer } from './app-control/mcp-server';
import { sessionMonitor } from './safety/sessionWatchdog';
import { startXhsWarmup } from './plat/xhsWarmup';
import { workStatsSync } from './plat/workStatsSync';
import { browserControlManager } from './browserControl/manager';
import { startZhiyinKernelHost } from './zhiyin-kernel-host';
import type { HarnessRuntime } from '../../../bosom-friend-harness/src/index';
import { getBackendBase, getAutoLoginToken } from './config/backendBase';
import { isBundledBackend, startBundledBackend, stopBundledBackend } from './backend/backendLauncher';
import { registerUserModelConfigIpc } from './config/userModelConfig';

const platform = process.platform;
dotenv.config();

// 连接本地崩溃处理器：子进程（渲染/GPU/网络服务）崩溃时不再处于
// "crashpad not connected" 状态，避免异常退出把整个 APP 带走。
crashReporter.start({ uploadToServer: false, compress: true });

// 全局异常兜底：隐藏平台窗口的渲染崩溃、CDP 交互中断等异常不允许带走整个主进程。
// Node 15+ 对未处理的 Promise 拒绝默认直接终止进程，这里统一记录并继续运行。
process.on('uncaughtException', (error) => {
  // 管道/连接断裂属于宿主环境正常事件（CDP 连接断开、终端关闭等），
  // 写日志本身又会走 console transport 触发下一次 EPIPE，必须直接静默，否则刷屏死循环
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'EPIPE' || code === 'ECONNRESET' || code === 'ECONNREFUSED') {
    return;
  }
  logger.error('[global] 未捕获异常（已拦截，继续运行）:', error);
});
process.on('unhandledRejection', (reason) => {
  logger.error('[global] 未处理的 Promise 拒绝（已拦截，继续运行）:', reason);
});

// 子进程退出只记录原因（渲染进程崩溃由各窗口的 render-process-gone 自愈），绝不终止主进程
app.on('child-process-gone', (_event, details) => {
  logger.warn('[global] 子进程退出:', details.type, details.reason, details.exitCode);
});

// 开启渲染进程日志输出到控制台，便于本地排查
app.commandLine.appendSwitch('enable-logging');
app.commandLine.appendSwitch('remote-debugging-port', '9222');
// 允许静音视频自动播放（主页精选示例依赖自动播放）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.APP_ROOT = path.join(__dirname, '../..');

export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron');
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist');
export const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

dialog.showErrorBox = (title, content) => {
  console.error(`Error: ${title}\n${content}`);
};

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST;

// Disable GPU Acceleration for Windows 7
if (os.release().startsWith('6.1')) app.disableHardwareAcceleration();
// Set application name for Windows 10+ notifications
if (process.platform === 'win32') app.setAppUserModelId(app.getName());

// 单例锁：防止多实例残留，避免安装器因多个知音进程“无法关闭”
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win: BrowserWindow | null = null;
let splashWindow: SplashWindow | null = null;
let appControlMcp: AppControlMcpServer | null = null;
let zhiyinKernel: HarnessRuntime | null = null;
let quitting = false;
const preload = path.join(__dirname, '../preload/index.mjs');
const indexHtml = path.join(RENDERER_DIST, 'index.html');

async function createWindow() {
  // 秒开模式（默认开启）：不建 splash，主窗加载完直接显示
  // 需要传统启动窗时设 ZHIYIN_INSTANT_START=0 回退
  if (!INSTANT_START) {
    splashWindow = new SplashWindow();
    splashWindow.create();
  }

  // 创建主窗口但先不显示（splash 加载即有提示作用，去掉人为等待）
  win = new BrowserWindow({
    title: 'Bosom Friend v' + app.getVersion(),
      icon: path.join(getAssetPath('logo-256.png')),
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    titleBarStyle: 'hidden',
    show: false,
    titleBarOverlay:
      platform === 'win32'
        ? undefined
        : {
            color: 'rgba(0,0,0,0)',
            height: 64,
            symbolColor: '#595959',
          },
    webPreferences: {
      preload,
      webviewTag: true,
      webSecurity: true,
      nodeIntegration: false,
      contextIsolation: true,
      // 后端地址运行时注入（内测者可用 backend-config.json 指向共享服务器）；
      // 登录 token 注入：打包版无开发模式模拟账号，用主进程持久化的登录态自动登录
      additionalArguments: [
        '--zhiyin-backend-url=' + getBackendBase(),
        '--zhiyin-auth-token=' + getAutoLoginToken(),
      ],
    },
  });

  // 禁用后台节流：避免窗口未聚焦时示例视频被省电策略暂停
  win.webContents.setBackgroundThrottling(false);

  // 主窗口渲染崩溃自愈：直接重载页面，绝不让主窗口关闭触发 window-all-closed 退出
  win.webContents.on('render-process-gone', (_event, details) => {
    logger.error('[main-window] 渲染进程退出，自动重载:', details.reason);
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      try {
        win.webContents.reload();
      }
      catch (e) {
        logger.error('[main-window] 重载失败:', e);
      }
    }
  });

  // 主窗口关闭即退出整个应用（避免隐藏的自动化/养号窗口让进程残留，导致安装器无法关闭）
  win.on('closed', () => {
    if (quitting) return
    quitting = true
    logger.log('[app-lifecycle] 主窗口关闭，退出应用')
    app.quit()
  });

  // 强制使用非黑暗模式
  nativeTheme.themeSource = 'light';

  try {
    const tray = new SystemTray(win);
    tray.create();
  } catch (error) {
    logger.error('系统托盘启动失败', error);
  }

  // 等待主窗口加载完成
  if (VITE_DEV_SERVER_URL) {
    await win.loadURL(VITE_DEV_SERVER_URL);
  } else {
    await win.loadFile(indexHtml);
  }

  // 内容已加载：立即显示主窗口（零人为延迟），按需关闭启动窗
  win?.show();
  if (process.env.ZHIYIN_DEVTOOLS === '1') {
    win?.webContents.openDevTools({ mode: 'right' });
  }
  if (splashWindow) {
    splashWindow.close();
    splashWindow = null;
  }

  // 隐藏菜单栏
  win.setMenu(null);

  // Test actively push message to the Electron-Renderer
  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', new Date().toLocaleString());
  });

  // Make all links open with the browser, not with the application
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) shell.openExternal(url);
    return { action: 'deny' };
  });

  return win;
}


// 秒开模式：默认开启（原实现仅声明未接线）；设 ZHIYIN_INSTANT_START=0 回退传统启动窗
const INSTANT_START = process.env.ZHIYIN_INSTANT_START !== '0';
app.whenReady().then(async () => {
  try {
    registerContextMenuListener();

    // 遥测：恢复本地队列并启动定时上报

    // 创建应用实例,挂载功能
    new App();

    // 注册自定义大模型配置 IPC（设置 → 自定义大模型）：读取/保存/清除/申请入口。
    // 此前遗漏挂载导致设置页保存 Key 实际不生效（IPC 无 handler），是「自定义大模型
    // 配置不全局生效」的根因之一；现在与内核启动同链路注册。
    registerUserModelConfigIpc();

    // 启动知音 Harness Agent 工具系统（独立内核：AI 是大脑，工具是身体，
    // 三大核心共用一套数据；旧模块仅作为未来的传输适配器）
    // 内核后台异步启动：不再阻塞窗口创建（首屏提速），完成后回填运行时引用
    void startZhiyinKernelHost({
      dataDir: app.getPath('userData'),
      libraryDir: path.join(app.getPath('userData'), '知音素材库'),
      getWindow: () => win,
    }).then((k) => { zhiyinKernel = k; })
      .catch((e) => logger.error('[startup] 内核启动失败:', e));

    // 打包版：随包后端在后台启动（不阻塞窗口），前端先显示界面，
    // 避免慢机器冷启动时空白 5 分钟；后端就绪后通知渲染层重试初始化。
    const backendReadyPromise = (async () => {
      if (!VITE_DEV_SERVER_URL && isBundledBackend()) {
        const ok = await startBundledBackend();
        logger.info('[startup] 随包后端就绪:', ok);
        return ok;
      }
      return false;
    })();

    // 立即创建窗口，不等后端
    const bWin = await createWindow();

    // 后端就绪后广播给渲染层，让它重拉用户信息 / 账号初始化
    void backendReadyPromise.then((ok) => {
      if (ok && bWin && !bWin.isDestroyed()) {
        bWin.webContents.send('zhiyin:backend:ready');
      }
    });

    // 启动本地 APP 控制 MCP 服务（供后端 Agent 调用，控制桌面端页面跳转等）
    appControlMcp = new AppControlMcpServer(() => win);
    appControlMcp.start();

    // 挂载其他功能
    update(bWin);
    views(bWin);
    windowOperate.init(bWin);

    // DSH内核实验室：注册IPC + 快捷键 Ctrl+Shift+D 唤起
    registerDshIpc();
    win?.webContents.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'd') {
        e.preventDefault();
        openDshLab();
      }
    });

    // 抖音自动化窗口：隐藏常驻，供评论/私信页面驱动复用
    setTimeout(() => {
      void ensureDouyinAutoWindow();
      // 会话监测：纯后台零弹窗——失效仅标记离线，登录弹窗只允许用户手动触发
      sessionMonitor.start();
      // 小红书养号器：隐藏窗口低频率模拟真人浏览，帮助会话风控评分恢复
      startXhsWarmup();
      // 作品数据自动同步：定时采集平台真实互动数据，保持数据概览持续真实
      workStatsSync.start();
      // 官方扩展引擎已停用：多分区加载扩展会与主进程 cookie/网络原生层并发竞争，
      // 触发 electron.exe 主进程空指针崩溃（RVA 0x1869279）。当前发布/互动/私信链路
      // 已由 bosom-friend-harness 内核 + CDP 页面驱动完整覆盖，不再依赖该扩展。
    }, 3000);
  } catch (error) {
    logger.error('Failed to start application:', error);
    app.quit();
  }
});

/**
 * Quit when all windows are closed, except on macOS. There, it's common
 */
app.on('window-all-closed', () => {
  logger.log('[app-lifecycle] window-all-closed 触发，即将退出');
  win = null;
  zhiyinKernel?.stop();
  zhiyinKernel = null;
  appControlMcp?.stop();
  appControlMcp = null;
  void browserControlManager.closeAll();
  if (process.platform !== 'darwin') app.quit();
});

// 应用退出前清理外部浏览器自动化实例（独立 Profile，避免残留进程占端口）
app.on('before-quit', () => {
  stopBundledBackend();
  void browserControlManager.closeAll();
  // 强制退出兜底：后端子进程可能拖住主进程，导致安装器无法关闭
  setTimeout(() => {
    process.exit(0);
  }, 1500);
});

// 处理第二个实例
app.on('second-instance', () => {
  if (win) {
    // Focus on the main window if the user tried to open another
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

// 处理激活
app.on('activate', () => {
  const allWindows = BrowserWindow.getAllWindows();
  if (allWindows.length) {
    allWindows[0].focus();
  } else {
    createWindow();
  }
});

// 打开新窗口
ipcMain.handle('open-win', (_, arg) => {
  const childWindow = new BrowserWindow({
    webPreferences: {
      preload,
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  if (VITE_DEV_SERVER_URL) {
    childWindow.loadURL(`${VITE_DEV_SERVER_URL}#${arg}`);
  } else {
    childWindow.loadFile(indexHtml, { hash: arg });
  }
});
