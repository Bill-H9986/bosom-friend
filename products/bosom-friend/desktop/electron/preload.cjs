
/**
 * Minimal secure preload bridge.
 *
 * The renderer receives only the documented application status API. It does not receive
 * raw `ipcRenderer`, filesystem, child_process, or Electron internals.
 */

const { contextBridge, ipcRenderer } = require('electron')

// 产品版本由桌面壳注入：前端"设置 → 版本"展示此值，绝不使用前端写死的回退版本号。
const appVersion = ipcRenderer.sendSync('bosom-friend:version')
contextBridge.exposeInMainWorld('__APP_VERSION__', typeof appVersion === 'string' ? appVersion : '')

contextBridge.exposeInMainWorld('bosomFriend', {
  getStatus: () => ipcRenderer.invoke('bosom-friend:status'),
  quit: () => ipcRenderer.invoke('bosom-friend:quit'),
  platform: process.platform,
})

contextBridge.exposeInMainWorld('bosomKernel', {
  getStatus: () => ipcRenderer.invoke('bosom-kernel:status'),
  retry: () => ipcRenderer.invoke('bosom-kernel:retry'),
  /** 内核掉线后由界面主动重启内核（不必退出整个 App）。 */
  restart: () => ipcRenderer.invoke('bosom-kernel:restart'),
  /** 内核健康状态变化：{ ok, at, trigger, error }。 */
  onHealth: (callback) => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('bosom-kernel:health', handler)
    return () => ipcRenderer.removeListener('bosom-kernel:health', handler)
  },
  onHandshake: (callback) => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('bosom-kernel:handshake', handler)
    return () => ipcRenderer.removeListener('bosom-kernel:handshake', handler)
  },
  onEvent: (callback) => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('bosom-kernel:event', handler)
    return () => ipcRenderer.removeListener('bosom-kernel:event', handler)
  },
  onProgress: (callback) => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('bosom-kernel:progress', handler)
    return () => ipcRenderer.removeListener('bosom-kernel:progress', handler)
  },
})

// 运行日志出口：设置页用它显示日志位置、一键打开目录（现场支持时用户自助取证）。
contextBridge.exposeInMainWorld('bosomLog', {
  path: () => ipcRenderer.invoke('bosom-log:path'),
  openFolder: () => ipcRenderer.invoke('bosom-log:open'),
})

// 更新检查（最小版）：设置页用它检查新版本、改清单地址、打开下载页。
// 只读清单与打开浏览器，产品自身不下载、不安装任何远端内容。
contextBridge.exposeInMainWorld('bosomUpdate', {
  check: () => ipcRenderer.invoke('bosom-update:check'),
  getManifestUrl: () => ipcRenderer.invoke('bosom-update:get-manifest-url'),
  setManifestUrl: (url) => ipcRenderer.invoke('bosom-update:set-manifest-url', url),
  openDownload: (url) => ipcRenderer.invoke('bosom-update:open-download', url),
})
