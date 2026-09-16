/// <reference types="vite/client" />
declare module 'virtual:svg-icons-register';
declare module 'swiper/css';
declare module 'swiper/css/navigation';
declare module 'swiper/css/pagination';

interface Window {
  /** 性能档位：由服务端 index.html 注入（'low' 时前端关闭重特效）。 */
  __BF_PERF_TIER__?: string;
  // expose in the `electron/preload/index.ts`
  ipcRenderer: import('electron').IpcRenderer & {
    setStoreValue: (key: string, value: any) => void;
    getStoreValue: (key: string) => any;
  };
  /** 大模型配置桥：用户自填 Agnes 国内站 Key（密钥仅存本机） */
  zhiyinModel: {
    get: () => Promise<{
      baseUrl: string
      chat: { hasApiKey: boolean, model: string }
      image: { hasApiKey: boolean, model: string }
      video: { hasApiKey: boolean, model: string }
    }>
    save: (input: {
      baseUrl?: string
      chat?: { apiKey?: string, model?: string }
      image?: { apiKey?: string, model?: string }
      video?: { apiKey?: string, model?: string }
    }) => Promise<{ config: unknown, needsRestart: boolean }>
    clear: () => Promise<unknown>
    openApplyPage: () => Promise<void>
  }
  /** Bosom Friend Harness 内核桥：三大核心统一驱动入口 */
  zhiyinHarness: {
    invoke: (action: string, input?: unknown) => Promise<unknown>
    runWorkflow: (
      domain: 'content' | 'platform' | 'automation',
      input: Record<string, unknown>,
      sessionId?: string,
    ) => Promise<unknown>
    chat: (sessionId: string, message: string) => void
    submitInteraction: (item: {
      kind: 'comment' | 'dm'
      platform: string
      accountId: number
      content: string
      sourceId: string
      workId?: string
      commentId?: string
      title?: string
      peerName?: string
    }) => Promise<unknown>
    automationStatus: () => Promise<unknown>
    onEvent: (listener: (event: any) => void) => () => void
  }
}

/** 浏览器控制中心共享类型（主进程 browserControl 模块与渲染进程一致） */
interface ZhiyinBrowserInfo {
  kind: 'chrome' | 'edge'
  name: string
  exePath: string
  version?: string
}

interface ZhiyinBrowserInstance {
  id: string
  kind: 'chrome' | 'edge'
  name: string
  exePath: string
  port: number
  profileDir: string
  openUrl?: string
  pid?: number
  startedAt: number
  status: 'starting' | 'running' | 'stopped' | 'error'
  error?: string
}

type ZhiyinAutomationEngine = 'embedded' | 'chrome' | 'edge'
