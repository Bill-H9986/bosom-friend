import { contextBridge, ipcRenderer } from 'electron';
import { exposeUIKit } from '@electron-uikit/core/preload';

try {
  exposeUIKit();
} catch (e) {
  console.error(e);
}

// 后端地址运行时配置：主进程经 additionalArguments 注入，
// 内测者可在 %APPDATA%/<应用数据目录>/backend-config.json 配置 apiBaseUrl 后重启生效
function resolveBackendBaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--zhiyin-backend-url='));
  return arg ? arg.split('=')[1] : 'http://127.0.0.1:3080/bosom-friend/api';
}
function resolveAuthToken(): string {
  const arg = process.argv.find((a) => a.startsWith('--zhiyin-auth-token='));
  return arg ? arg.split('=')[1] : '';
}
contextBridge.exposeInMainWorld('__BACKEND_BASE_URL__', resolveBackendBaseUrl());
contextBridge.exposeInMainWorld('__ZHIYIN_AUTH_TOKEN__', resolveAuthToken());

// --------- Expose some API to the Renderer process ---------
contextBridge.exposeInMainWorld('ipcRenderer', {
  on(...args: Parameters<typeof ipcRenderer.on>) {
    const [channel, listener] = args;
    return ipcRenderer.on(channel, (event, ...args) =>
      listener(event, ...args),
    );
  },
  off(...args: Parameters<typeof ipcRenderer.off>) {
    const [channel, ...omit] = args;
    return ipcRenderer.off(channel, ...omit);
  },
  send(...args: Parameters<typeof ipcRenderer.send>) {
    const [channel, ...omit] = args;
    return ipcRenderer.send(channel, ...omit);
  },
  invoke(...args: Parameters<typeof ipcRenderer.invoke>) {
    const [channel, ...omit] = args;
    return ipcRenderer.invoke(channel, ...omit);
  },

  // electron-store ------------------------------
  setStoreValue: (key: string, value: any) => {
    ipcRenderer.invoke('setStore', key, value);
  },
  getStoreValue(key: string) {
    return ipcRenderer.invoke('getStore', key);
  },
});

// --------- 知音 Harness：三大核心统一驱动入口 ---------
contextBridge.exposeInMainWorld('zhiyinHarness', {
  invoke(action: string, input?: unknown) {
    return ipcRenderer.invoke('zhiyin:harness:invoke', { action, input });
  },
  runWorkflow(
    domain: 'content' | 'platform' | 'automation',
    input: Record<string, unknown>,
    sessionId?: string,
  ) {
    return ipcRenderer.invoke('zhiyin:harness:workflow', {
      domain,
      sessionId,
      input,
    });
  },
  chat(sessionId: string, message: string) {
    ipcRenderer.send('zhiyin:harness:chat', { sessionId, message });
  },
  /** 平台驱动/页面提交一条新互动（评论/私信），进入 7×24 自动接待队列 */
  submitInteraction(item: {
    kind: 'comment' | 'dm';
    platform: string;
    accountId: number;
    content: string;
    sourceId: string;
    workId?: string;
    commentId?: string;
    title?: string;
    peerName?: string;
  }) {
    return ipcRenderer.invoke('zhiyin:harness:invoke', {
      action: 'automation.submit',
      input: item,
    });
  },
  automationStatus() {
    return ipcRenderer.invoke('zhiyin:harness:invoke', {
      action: 'automation.status',
    });
  },
  onEvent(listener: (event: any) => void) {
    const handler = (_event: Electron.IpcRendererEvent, payload: any) =>
      listener(payload);
    ipcRenderer.on('zhiyin:harness:event', handler);
    return () => ipcRenderer.off('zhiyin:harness:event', handler);
  },
});

// --------- 大模型配置：用户自填 Agnes 国内站 Key，密钥仅存本机 ---------
contextBridge.exposeInMainWorld('zhiyinModel', {
  get() {
    return ipcRenderer.invoke('zhiyin:model:get');
  },
  save(input: Record<string, unknown>) {
    return ipcRenderer.invoke('zhiyin:model:save', input);
  },
  clear() {
    return ipcRenderer.invoke('zhiyin:model:clear');
  },
  openApplyPage() {
    return ipcRenderer.invoke('zhiyin:model:open-apply');
  },
});

// --------- Preload scripts loading ---------
function domReady(
  condition: DocumentReadyState[] = ['complete', 'interactive'],
) {
  return new Promise((resolve) => {
    if (condition.includes(document.readyState)) {
      resolve(true);
    } else {
      document.addEventListener('readystatechange', () => {
        if (condition.includes(document.readyState)) {
          resolve(true);
        }
      });
    }
  });
}

const safeDOM = {
  append(parent: HTMLElement, child: HTMLElement) {
    if (!Array.from(parent.children).find((e) => e === child)) {
      return parent.appendChild(child);
    }
  },
  remove(parent: HTMLElement, child: HTMLElement) {
    if (Array.from(parent.children).find((e) => e === child)) {
      return parent.removeChild(child);
    }
  },
};

/**
 * https://tobiasahlin.com/spinkit
 * https://connoratherton.com/loaders
 * https://projects.lukehaas.me/css-loaders
 * https://matejkustec.github.io/SpinThatShit
 */
function useLoading() {
  const className = `loaders-css__square-spin`;
  const styleContent = `
@keyframes square-spin {
  25% { transform: perspective(100px) rotateX(180deg) rotateY(0); }
  50% { transform: perspective(100px) rotateX(180deg) rotateY(180deg); }
  75% { transform: perspective(100px) rotateX(0) rotateY(180deg); }
  100% { transform: perspective(100px) rotateX(0) rotateY(0); }
}
.${className} > div {
  animation-fill-mode: both;
  width: 50px;
  height: 50px;
  background: #fff;
  animation: square-spin 3s 0s cubic-bezier(0.09, 0.57, 0.49, 0.9) infinite;
}
.app-loading-wrap {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #282c34;
  z-index: 9;
}
    `;
  const oStyle = document.createElement('style');
  const oDiv = document.createElement('div');

  oStyle.id = 'app-loading-style';
  oStyle.innerHTML = styleContent;
  oDiv.className = 'app-loading-wrap';
  oDiv.innerHTML = `<div class="${className}"><div></div></div>`;

  return {
    appendLoading() {
      safeDOM.append(document.head, oStyle);
      safeDOM.append(document.body, oDiv);
    },
    removeLoading() {
      safeDOM.remove(document.head, oStyle);
      safeDOM.remove(document.body, oDiv);
    },
  };
}

// ----------------------------------------------------------------------

const { appendLoading, removeLoading } = useLoading();
domReady().then(appendLoading);

window.onmessage = (ev) => {
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  ev.data.payload === 'removeLoading' && removeLoading();
};

// [slim] 兜底缩短：正常流程渲染层会主动发 removeLoading，此处仅防卡死
setTimeout(removeLoading, 1500);
