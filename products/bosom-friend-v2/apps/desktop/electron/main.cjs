/**
 * Bosom Friend 0.2.0 desktop main process.
 *
 * This is the only product lifecycle owner. It never opens an external browser, never
 * disables Electron sandboxing, and never kills processes by name.
 */

const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron')
const path = require('path')
const { spawn, execFile } = require('child_process')

let mainWindow = null
let quitting = false
let startedAt = Date.now()

/** Exact child PIDs owned by this product instance. */
const managedChildren = new Map()

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function killExactPidTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0)
    return
  execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    timeout: 8000,
    stdio: 'ignore',
  }, () => {})
}

/**
 * Track a child process owned by the desktop app.
 * On exit the exact PID is forgotten; nothing scans process names.
 */
function registerManagedChild(child) {
  if (!child || !child.pid) {
    return child
  }
  managedChildren.set(child.pid, child)
  child.once('exit', () => {
    managedChildren.delete(child.pid)
  })
  return child
}

/**
 * Stop all owned children. Graceful first, exact PID tree only after a bounded timeout.
 * This function never enumerates processes, never matches process names, and never
 * touches processes outside the owned PID set.
 */
async function stopManagedChildren() {
  const children = [...managedChildren.values()]
  for (const child of children) {
    try {
      child.kill()
    }
    catch {
      // Ignore already-exited children.
    }
  }

  await Promise.all(children.map(child => waitForExit(child, 1800)))

  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      killExactPidTree(child.pid)
    }
  }
  managedChildren.clear()
}

async function quitAndStop() {
  if (quitting)
    return
  quitting = true
  await stopManagedChildren()
  app.quit()
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }
  if (mainWindow.isMinimized())
    mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'Bosom Friend',
    backgroundColor: '#0f1117',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  Menu.setApplicationMenu(null)
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  mainWindow.once('ready-to-show', () => mainWindow.show())

  mainWindow.on('close', (event) => {
    if (quitting)
      return
    event.preventDefault()
    dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['退出', '取消'],
      defaultId: 0,
      title: '退出 Bosom Friend',
      message: '确定退出 Bosom Friend 吗？',
      detail: '退出会停止本程序启动的全部后台服务，不会删除你的账号和数据。',
    }).then(({ response }) => {
      if (response === 0)
        void quitAndStop()
    }).catch(() => {})
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.setAppUserModelId('com.bosomfriend.desktop')

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}
else {
  app.on('second-instance', () => focusMainWindow())

  app.whenReady().then(() => {
    ipcMain.handle('bosom-friend:status', () => ({
      version: app.getVersion(),
      startedAt,
      managedChildPids: [...managedChildren.keys()],
    }))
    createWindow()
  })

  app.on('before-quit', (event) => {
    if (quitting)
      return
    event.preventDefault()
    void quitAndStop()
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}

// The shell intentionally does not launch any sidecar until a typed manifest is explicitly
// configured. Keep this file free of implicit process creation.
