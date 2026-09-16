/**
 * 平台引擎子进程追踪与整树停止。
 *
 * worker/后台任务全部以 detached 方式运行，父服务退出时不会自动带走进程。
 * 本模块记录 PID，服务插件 dispose 时用 taskkill /T /F 清理整棵进程树，
 * 避免用户关闭 APP 后仍残留 node/python/chrome。
 * @module @deepseek-ai/dsh-bosom-friend-server/platform-processes
 */

import { spawnSync, type ChildProcess } from 'node:child_process'

const livePids = new Set<number>()

/** 登记一个子进程；退出时自动从清单移除。 */
export function trackChild<T extends ChildProcess>(child: T): T {
  if (child.pid !== undefined)
    livePids.add(child.pid)
  child.once('exit', () => {
    if (child.pid !== undefined)
      livePids.delete(child.pid)
  })
  return child
}

/** 停止所有已登记的平台引擎子进程（含其进程树）。 */
export function stopTrackedChildren(): void {
  for (const pid of [...livePids]) {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 8000,
      })
    }
    catch {
      // 进程可能已退出
    }
    livePids.delete(pid)
  }
  livePids.clear()
}
