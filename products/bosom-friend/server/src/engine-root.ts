/**
 * 平台 Python 引擎路径解析。
 *
 * 源码态与打包态目录深度不同：源码在 server/src，编译产物在 server/lib/types；
 * 打包态由 Electron 主进程通过 BF_ENGINE_ROOT / BF_ENGINE_VENDOR_ROOT 注入资源目录。
 * @module @deepseek-ai/dsh-bosom-friend-server/engine-root
 */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))

/** 返回 engine 根目录（包含 worker.py 与 .venv）；不存在返回空串。 */
export function engineRoot(): string {
  const envRoot = process.env.BF_ENGINE_ROOT?.trim()
  if (envRoot !== undefined && envRoot !== '')
    return resolve(envRoot)
  const candidates = [
    join(MODULE_DIR, '../../../engine'),
    join(MODULE_DIR, '../../engine'),
    join(process.cwd(), 'products', 'bosom-friend', 'engine'),
  ]
  return candidates.find((candidate) => existsSync(join(candidate, 'worker.py'))) ?? ''
}

/** 返回 social-auto-upload vendored 目录；不存在返回空串。 */
export function engineVendorRoot(): string {
  const envRoot = process.env.BF_ENGINE_VENDOR_ROOT?.trim()
  if (envRoot !== undefined && envRoot !== '')
    return resolve(envRoot)
  const root = engineRoot()
  if (root === '')
    return ''
  const vendor = join(root, 'social-auto-upload')
  return existsSync(join(vendor, 'uploader')) ? vendor : ''
}

/** 返回平台 worker 使用的 Python 可执行文件；不存在返回空串。 */
export function enginePythonExe(): string {
  const root = engineRoot()
  if (root === '')
    return ''
  if (process.platform !== 'win32')
    return join(root, '.venv', 'bin', 'python')
  const windowed = join(root, '.venv', 'Scripts', 'pythonw.exe')
  return existsSync(windowed)
    ? windowed
    : join(root, '.venv', 'Scripts', 'python.exe')
}
