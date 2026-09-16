const { app, BrowserWindow, Menu, Tray, Notification, dialog } = require('electron')
const { spawn, execFile, execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const http = require('http')

const appRoot = path.resolve(__dirname, '..', '..', '..', '..')
const nodeExe = path.join(appRoot, 'runtime', 'node', 'node.exe')
const launcher = path.join(appRoot, 'products', 'bosom-friend', 'launcher', 'lib', 'types', 'bin.js')
const linkDir = path.join(appRoot, 'products', 'bosom-friend', 'launcher', 'config', 'node_modules', '@deepseek-ai')
const appUrl = 'http://127.0.0.1:3080/bosom-friend/'
const pidFile = path.join(appRoot, 'bosom-friend.pid')
const icon = path.join(appRoot, 'bosom-friend.ico')

let serviceChild = null
let mainWindow = null
let tray = null
let quitting = false

function ping(callback) {
  const req = http.get(appUrl, { timeout: 2000 }, (res) => {
    res.resume()
    callback(res.statusCode === 200)
  })
  req.on('error', () => callback(false))
  req.on('timeout', () => { req.destroy(); callback(false) })
}

function ensureLinks(callback) {
  if (fs.existsSync(linkDir)) return callback(true)
  const proc = spawn(nodeExe, [path.join(appRoot, 'products', 'bosom-friend', 'launcher', 'scripts', 'setup-fallback.mjs')], {
    cwd: appRoot,
    windowsHide: true,
    stdio: 'ignore',
  })
  proc.on('exit', () => callback(true))
}

function startService(callback) {
  ping((ready) => {
    if (ready) return callback(true)
    serviceChild = spawn(nodeExe, [launcher, '--port', '3080', '--no-open'], {
      cwd: appRoot,
      windowsHide: true,
      stdio: 'ignore',
    })
    try { fs.writeFileSync(pidFile, String(serviceChild.pid), 'ascii') } catch {}
    let tries = 0
    const timer = setInterval(() => {
      tries += 1
      ping((readyNow) => {
        if (readyNow) { clearInterval(timer); callback(true) }
        else if (tries >= 60) { clearInterval(timer); callback(false) }
      })
    }, 1000)
  })
}

function killPidTree(pid) {
  if (!pid || !/^\d+$/.test(String(pid))) return
  try {
    execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
      windowsHide: true,
      timeout: 8000,
      stdio: 'ignore',
    })
  } catch {}
}

function stopService() {
  const pids = new Set()
  try {
    const pid = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : ''
    if (pid !== '' && /^\d+$/.test(pid)) pids.add(pid)
  } catch {}
  if (serviceChild && serviceChild.pid) pids.add(serviceChild.pid)
  for (const pid of pids) killPidTree(pid)

  // 同步执行：Electron 退出前必须等到所有 service/node/python/chrome 进程清理完成，
  // 否则 taskkill 还在排队时 app.quit() 已经返回，残留进程会继续占有 3080 与平台 Chrome。
  const rootJson = JSON.stringify(appRoot)
  const selfPidJson = JSON.stringify(String(process.pid))
  const psScript = [
    '$root = ' + rootJson,
    '$selfPid = ' + selfPidJson,
    'Get-CimInstance Win32_Process | Where-Object {',
    '  $_.ProcessId -ne $selfPid',
    '  -and $_.Name -in @(\'node.exe\',\'pythonw.exe\',\'python.exe\',\'chrome.exe\',\'electron.exe\',\'BosomFriendDesktop.exe\',\'BosomFriend.exe\')',
    '  -and ($_.CommandLine -like "*$root*" -or $_.ExecutablePath -like "*$root*" -or $_.CommandLine -match \'worker\\.py daemon\')',
    '} | ForEach-Object {',
    '  & taskkill.exe /PID $_.ProcessId /T /F 2>$null | Out-Null',
    '}',
  ].join('\n')
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
      windowsHide: true,
      timeout: 20000,
      stdio: 'ignore',
    })
  } catch {}
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function hideWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide()
}

function quitAndStopService() {
  if (quitting) return
  quitting = true
  stopService()
  setTimeout(() => app.quit(), 200)
}

function createTray() {
  if (tray) return tray
  try {
    tray = new Tray(icon)
    tray.setToolTip('Bosom Friend')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 Bosom Friend', click: () => showWindow() },
      { label: '隐藏到托盘', click: () => hideWindow() },
      { type: 'separator' },
      { label: '关闭服务并退出', click: () => quitAndStopService() },
    ]))
    tray.on('click', () => showWindow())
    return tray
  } catch {
    tray = null
    return null
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'Bosom Friend',
    icon,
    autoHideMenuBar: true,
    backgroundColor: '#0f1117',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  Menu.setApplicationMenu(null)
  mainWindow.loadURL(appUrl)

  mainWindow.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['退出并停止服务', '取消'],
      defaultId: 0,
      title: '关闭 Bosom Friend',
      message: '关闭窗口是否同时退出后台服务？',
      detail: '选择“退出并停止服务”会关闭窗口并清理后台 Node/Python/Chrome 进程；选择“取消”则保持窗口继续运行。',
    }).then(({ response }) => {
      if (response === 0) quitAndStopService()
    }).catch(() => {})
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.whenReady().then(() => {
    createTray()
    ensureLinks(() => {
      startService((ok) => {
        if (!ok) {
          dialog.showErrorBox('Bosom Friend', '服务启动失败，请检查安装完整性后重新安装。')
          quitAndStopService()
          return
        }
        createWindow()
      })
    })
  })
  app.on('before-quit', () => {
    quitting = true
    stopService()
  })
  app.on('window-all-closed', () => {
    if (quitting) app.quit()
  })
}
