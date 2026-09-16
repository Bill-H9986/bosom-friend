
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
