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
  /**
   * 更新检查桥（桌面壳 preload 暴露）。只发现新版本 + 打开下载页，不下载、不静默安装。
   * 网页部署下不存在 —— 设置页据此判断"是不是桌面壳"。
   */
  /**
   * 更新检查桥的返回契约。**这里是它唯一的家**——设置页从这个声明派生类型，不再自己写一份。
   *
   * 为什么强调：这份契约曾经在三处各写一遍（主进程 `electron/main/update.ts`、本文件、
   * 设置页里的本地副本），然后互相漂移——界面读 `url` 与 `'ahead'`，主进程两个都不给，
   * 于是「打开下载页」永远是灰的、`'ahead'` 分支是死代码（而类型检查是对的，只是没人跑它）。
   *
   * 与主进程的 `UpdateCheckResult` 必须逐字一致：那条边界是 IPC，类型检查覆盖不到另一半，
   * 改一边就要改另一边。reason 的取值里**没有** `update-available`——主进程从不发它
   * （有更新时给的是 `update: true` 加 `newVersion`）。
   */
  bosomUpdate?: {
    check: () => Promise<{
      update: boolean
      currentVersion: string
      newVersion?: string
      url?: string
      notes?: string
      force?: boolean
      reason?: 'dev' | 'up-to-date' | 'ahead' | 'rollout' | 'error'
      message?: string
    }>
    getManifestUrl: () => Promise<string>
    setManifestUrl: (url: string) => Promise<{ ok: boolean, error?: string, manifestUrl?: string }>
    openDownload: (url: string) => Promise<{ ok: boolean, error?: string }>
  }
}

/** Vite define 注入的 Web 构建版本号（纯网页部署回退值；桌面端以注入的 __APP_VERSION__ 为准）。 */
declare const __WEB_BUILD_VERSION__: string

/**
 * A1 只读观测钩子（隔离取证构建专用）。由取证脚本经 addInitScript 注入；
 * 未注入时为 undefined，业务代码里的 `?.()` 调用自然成为空操作。
 * 仅记录测试内容与布尔状态，不含凭证/账号敏感字段。
 */
declare var __BF_B1_TRACE__: ((record: Record<string, unknown>) => void) | undefined

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
