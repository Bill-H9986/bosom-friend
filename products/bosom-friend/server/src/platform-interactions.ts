/**
 * 平台互动引擎适配器：DSH 后端与真实浏览器互动 worker（interactions.py）之间的桥。
 *
 * 业务红线：评论/私信的“读取与回复”必须发生在真实平台页面上；本模块只做
 * 任务目录、storage_state（账号 cookie）重建与状态读取，绝不伪造平台结果。
 * 平台风控 / 未登录 / IP 风险等真实原因一律原样透传到前端。
 * @module @deepseek-ai/dsh-bosom-friend-server/platform-interactions
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Deps } from './api.ts'
import { enginePythonExe, engineRoot } from './engine-root.ts'
import { nowIso, uid } from './store-helper.ts'
import { trackChild } from './platform-processes.ts'

/** 互动 worker 状态文件契约（interactions.py state.json）。 */
export interface InteractionState {
  taskId?: string
  status?: 'starting' | 'done' | 'failed'
  op?: 'comments_list' | 'comment_reply' | 'dm_list' | 'dm_reply' | 'conversation'
  platform?: string
  data?: unknown
  error?: string
  startedAt?: string
  finishedAt?: string
}

function engineDir(): string {
  return engineRoot()
}

function pythonExe(): string {
  return enginePythonExe()
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

/** 互动任务输入（与 interactions.py input.json 对齐）。 */
export interface InteractionInput {
  op: 'comments_list' | 'comment_reply' | 'dm_list' | 'dm_reply' | 'conversation'
  platform: string
  accountId: string
  /** conversation 专用：dm 读整段会话，comment 读该作品的评论线程。 */
  kind?: 'comment' | 'dm'
  workId?: string
  workTitle?: string
  createTime?: string
  commentKey?: string
  commentText?: string
  username?: string
  sessionId?: string
  peerName?: string
  replyText?: string
}

export interface InteractionStartOk {
  ok: true
  taskId: string
}

export interface InteractionStartFail {
  ok: false
  error: string
}

/**
 * 拉起真实互动 worker：把账号 loginCookie 重建为 Playwright storage_state，
 * 由真实 Chrome 在平台页面上执行列表/回复。
 */
export function startPlatformInteraction(
  deps: Deps,
  taskId: string,
  input: InteractionInput,
): InteractionStartOk | InteractionStartFail {
  if (!existsSync(pythonExe()) || !existsSync(join(engineDir(), 'worker.py'))) {
    return { ok: false, error: '平台互动引擎未安装（Python 环境缺失）' }
  }
  const accounts = deps.store.files.accounts.load()
  const account = accounts.find(a => a.id === input.accountId)
  if (account === undefined || typeof account.loginCookie !== 'string' || account.loginCookie === '') {
    return { ok: false, error: '账号未完成真实登录（缺少平台 cookie），请先在「渠道」中扫码登录该账号' }
  }
  const taskDir = join(deps.dataRoot, 'platform-login', 'interact', taskId)
  mkdirSync(taskDir, { recursive: true })
  const storageFile = join(taskDir, 'storage.json')
  let cookies: unknown
  try {
    cookies = JSON.parse(account.loginCookie)
  } catch {
    cookies = []
  }
  writeFileSync(storageFile, JSON.stringify({ cookies: Array.isArray(cookies) ? cookies : [], origins: [] }), 'utf8')
  writeFileSync(join(taskDir, 'input.json'), JSON.stringify({
    op: input.op,
    platform: input.platform,
    kind: input.kind ?? '',
    storageFile,
    workId: input.workId ?? '',
    workTitle: input.workTitle ?? '',
    createTime: input.createTime ?? '',
    commentKey: input.commentKey ?? '',
    commentText: input.commentText ?? '',
    username: input.username ?? '',
    sessionId: input.sessionId ?? '',
    peerName: input.peerName ?? '',
    replyText: input.replyText ?? '',
  }), 'utf8')

  const child = trackChild(spawn(pythonExe(), [join(engineDir(), 'worker.py'), 'interact', taskId, taskDir], {
    cwd: engineDir(),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }))
  child.unref()
  writeFileSync(join(taskDir, 'state.json'), JSON.stringify({ taskId, status: 'starting', startedAt: nowIso() } satisfies InteractionState), 'utf8')
  return { ok: true, taskId }
}

/** 读取互动任务结果（前端轮询）。 */
export function getInteractionState(deps: Deps, taskId: string): InteractionState | undefined {
  const file = join(deps.dataRoot, 'platform-login', 'interact', taskId, 'state.json')
  const state = readJson<InteractionState>(file)
  if (state?.status === 'starting') {
    const startedAt = state.startedAt ? Date.parse(state.startedAt) : 0
    if (Number.isNaN(startedAt) || Date.now() - startedAt > 8 * 60_000) {
      const failed: InteractionState = {
        ...state,
        status: 'failed',
        error: '互动任务已超时，请重新发起',
        finishedAt: nowIso(),
      }
      try {
        writeFileSync(file, JSON.stringify(failed, null, 2), 'utf8')
      } catch {
        // 状态写失败仅影响下次轮询，仍返回失败结果
      }
      return failed
    }
  }
  return state
}

/** 生成互动任务 id（与发布任务同前缀族，便于工作日志检索）。 */
export function newInteractionTaskId(): string {
  return uid('inter')
}
