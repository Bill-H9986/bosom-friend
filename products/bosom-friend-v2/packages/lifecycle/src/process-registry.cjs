/**
 * Owned child-process registry.
 *
 * This registry only knows PIDs created by the product. It never enumerates processes by
 * name and never issues an unowned-wide termination command.
 */

const { execFile } = require('child_process')

class ProcessRegistry {
  constructor() {
    this.children = new Map()
  }

  register(child) {
    if (!child || !child.pid) {
      return child
    }
    this.children.set(child.pid, child)
    child.once('exit', () => {
      this.children.delete(child.pid)
    })
    return child
  }

  pids() {
    return [...this.children.keys()]
  }

  async stopAll(gracefulMs = 1800) {
    const children = [...this.children.values()]
    for (const child of children) {
      try {
        child.kill()
      }
      catch {
        // Already exited.
      }
    }

    await Promise.all(children.map(child => this._waitExit(child, gracefulMs)))

    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        this._killExactPidTree(child.pid)
      }
    }
    this.children.clear()
  }

  _waitExit(child, timeoutMs) {
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

  _killExactPidTree(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
      return
    execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 8000,
      stdio: 'ignore',
    }, () => {})
  }
}

module.exports = { ProcessRegistry }
