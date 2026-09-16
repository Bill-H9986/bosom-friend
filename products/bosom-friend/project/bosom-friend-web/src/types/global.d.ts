declare module 'blueimp-md5' {
  export default function md5(value: string, key?: string, raw?: boolean): string
}

declare module 'qrcode' {
  export function toDataURL(text: string, options?: Record<string, unknown>): Promise<string>
  export function toCanvas(canvas: HTMLCanvasElement, text: string, options?: Record<string, unknown>): Promise<unknown>
  export function toString(text: string, options?: Record<string, unknown>): Promise<string>
  const qrcode: { toDataURL: typeof toDataURL, toCanvas: typeof toCanvas, toString: typeof toString }
  export default qrcode
}

declare module '*.cjs' {
  const value: Record<string, unknown>
  export default value
  export const HREFLANG_MAP: Record<string, string>
}

// [compat] 旧渲染层在 nodeIntegration 下直接使用 Electron 注入的 window.ipcRenderer。
// 提供最小结构化类型使历史代码通过全仓类型门禁；新代码一律走 preload 暴露 API。
/* eslint-disable @typescript-eslint/no-explicit-any */
interface Window {
  ipcRenderer: {
    send(channel: string, ...args: any[]): void
    invoke(channel: string, ...args: any[]): Promise<any>
    getStoreValue(key: string, defaultValue?: any): any
    setStoreValue(key: string, value: any): void
    sendSync(channel: string, ...args: any[]): any
    on(channel: string, listener: (event: any, ...args: any[]) => void): void
    once(channel: string, listener: (event: any, ...args: any[]) => void): void
    off(channel: string, listener: (...args: any[]) => void): void
    removeListener(channel: string, listener: (...args: any[]) => void): void
    removeAllListeners(channel: string): void
  }
  /** 由后端 SPA 注入的当前系统版本号（设置页「系统与更新」展示）。 */
  __APP_VERSION__?: string
}

/** Vite define 注入的 Web 构建版本号（纯网页部署回退值；桌面端以注入的 __APP_VERSION__ 为准）。 */
declare const __WEB_BUILD_VERSION__: string

declare module 'react-transition-group' {
  import * as React from 'react'
  export const Transition: React.FC<any>
  export const CSSTransition: React.FC<any>
  export const SwitchTransition: React.FC<any>
  export const TransitionGroup: React.FC<any>
  export class TransitionGroupClass extends React.Component<any> {}
}

// [mirror] 以下与 project/bosom-friend-electron/src/vite-env.d.ts 保持一致（单一事实源在该文件）。
// web 编译程序不含该文件，故此处镜像最小必要集；两端类型若演进需同步。
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

interface Window {
  /** Bosom Friend Harness 内核桥：三大核心统一驱动入口 */
  zhiyinHarness?: {
    invoke: (action: string, input?: unknown) => Promise<unknown>
    chat?: (sessionId: string, message: string) => void
    automationStatus?: () => Promise<unknown>
    onEvent?: (listener: (event: any) => void) => () => void
    [key: string]: any
  }
}
