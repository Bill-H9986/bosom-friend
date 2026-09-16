import { PlatType } from '@web/app/config/platConfig'

/**
 * 桌面端本地登录支持的平台。
 * 抖音 / 小红书 / 微信视频号在桌面端通过应用内登录窗口（创作者后台扫码/网页授权）直连，
 * 不依赖后端 OAuth 开发者凭据与浏览器插件，个人账号可直接使用。
 */
export const DESKTOP_LOGIN_PLATFORMS: readonly PlatType[] = [
  PlatType.Douyin,
  PlatType.Xhs,
]

const desktopLoginPlatformSet = new Set<PlatType>(DESKTOP_LOGIN_PLATFORMS)

/** 当前是否为桌面端（存在 Electron IPC 桥接） */
export function isDesktopEnv() {
  // 浏览器模式由后端注入 ipcRenderer 垫片（__zyShim=true），不算桌面端
  return typeof window !== 'undefined'
    && !!window.ipcRenderer
    && !(window.ipcRenderer as unknown as { __zyShim?: boolean }).__zyShim
}

/** 平台是否支持桌面端本地登录 */
export function isDesktopLoginPlatform(platform: PlatType) {
  return desktopLoginPlatformSet.has(platform)
}

/**
 * 删除桌面端本地账号。返回 true 表示已从本地数据库删除，
 * false 表示非桌面端或删除失败（调用方应回退到后端接口）。
 */
export async function deleteDesktopAccount(id: string): Promise<boolean> {
  if (!isDesktopEnv()) {
    return false
  }

  try {
    await window.ipcRenderer.invoke('ICP_ACCOUNTS_DELETE', [Number(id)])
    return true
  }
  catch {
    return false
  }
}

/**
 * 删除桌面端本地账号分组。返回 true 表示已删除，
 * false 表示非桌面端或删除失败（调用方应回退到后端接口）。
 */
export async function deleteDesktopAccountGroup(id: string): Promise<boolean> {
  if (!isDesktopEnv()) {
    return false
  }

  try {
    await window.ipcRenderer.invoke('ICP_ACCOUNTS_GROUP_DELETE', Number(id))
    return true
  }
  catch {
    return false
  }
}
