/**
 * 抖音/小红书在 Electron 桌面端走本地创作者页直连（内核 CDP 页面驱动），
 * 不依赖浏览器插件；浏览器环境仍保留插件发布流程。
 */
export function shouldUseDesktopPublish(platform: string | undefined, isDesktop: boolean): boolean {
  return isDesktop && (platform === 'douyin' || platform === 'xhs')
}
