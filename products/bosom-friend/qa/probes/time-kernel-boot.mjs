#!/usr/bin/env node
/** 计时内核冷启动：从启动内核入口到 31280 可用。 */
import { spawn } from 'node:child_process'
import http from 'node:http'

const root = 'C:/Users/Jay/AppData/Local/Programs/Bosom Friend/resources'
const env = {
  ...process.env,
  BF_KERNEL_ROOT: root + '/kernel-runtime',
  BF_FRONTEND_DIST: root + '/frontend-dist',
}
delete env.BOSOM_FRIEND_HOME
const started = Date.now()
const child = spawn(root + '/runtime/node.exe', [root + '/kernel-runtime/runtime/bin-desktop.mjs'], {
  env,
  stdio: 'ignore',
  windowsHide: true,
})
const timer = setInterval(() => {
  const req = http.get('http://127.0.0.1:31280/bosom-friend/', (res) => {
    res.resume()
    if (res.statusCode === 200) {
      clearInterval(timer)
      console.log('KERNEL_BOOT_MS=' + (Date.now() - started))
      child.kill()
      process.exit(0)
    }
  })
  req.on('error', () => {})
  req.setTimeout(2000, () => req.destroy())
}, 500)
setTimeout(() => {
  clearInterval(timer)
  console.log('KERNEL_BOOT_MS=TIMEOUT')
  child.kill()
  process.exit(1)
}, 90000)
