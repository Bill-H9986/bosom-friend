/**
 * Minimal secure preload bridge.
 *
 * The renderer receives only the documented application status API. It does not receive
 * raw `ipcRenderer`, filesystem, child_process, or Electron internals.
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('bosomFriend', {
  getStatus: () => ipcRenderer.invoke('bosom-friend:status'),
  platform: process.platform,
})
