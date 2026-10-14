/**
 * KernelHealthBanner - 内核掉线横幅
 *
 * 产品页与全部业务接口都由内核子进程托管。内核死后界面不会崩，只会持续弹
 * 「网络连接失败，请检查网络后重试」——用户既看不到原因，也没有恢复入口（DEF-083）。
 *
 * 主进程每 10 秒探活一次，判定掉线后经 bosom-kernel:health 通知这里，并已自动尝试过
 * 一次重启；本横幅负责把状态讲清楚，并给出两个可用动作：重启内核、打开日志目录。
 */
'use client'

import { useEffect, useState } from 'react'

/** 主进程推送的健康状态。 */
interface KernelHealth {
  ok: boolean
  at?: number
  trigger?: string
  error?: string
}

/** preload 暴露的内核桥；浏览器态不存在。 */
interface KernelBridge {
  restart?: () => Promise<{ ok?: boolean, error?: string }>
  onHealth?: (callback: (payload: KernelHealth) => void) => () => void
}

/** preload 暴露的日志桥。 */
interface LogBridge {
  openFolder?: () => Promise<{ ok?: boolean, dir?: string }>
}

/** @returns 当前窗口可用的桌面桥（浏览器态为 undefined）。 */
function desktopBridge(): { kernel?: KernelBridge, log?: LogBridge } {
  if (typeof window === 'undefined')
    return {}
  const scope = window as unknown as { bosomKernel?: KernelBridge, bosomLog?: LogBridge }
  return { kernel: scope.bosomKernel, log: scope.bosomLog }
}

export function KernelHealthBanner() {
  const [down, setDown] = useState(false)
  const [busy, setBusy] = useState(false)
  const [detail, setDetail] = useState('')

  useEffect(() => {
    const bridge = desktopBridge().kernel
    if (!bridge?.onHealth)
      return
    return bridge.onHealth((payload) => {
      if (payload?.ok) {
        setDown(false)
        setBusy(false)
        setDetail('')
        return
      }
      setDown(true)
      setBusy(false)
      setDetail(typeof payload?.error === 'string' ? payload.error : '')
    })
  }, [])

  if (!down)
    return null

  const restart = async () => {
    const bridge = desktopBridge().kernel
    if (!bridge?.restart)
      return
    setBusy(true)
    try {
      const result = await bridge.restart()
      // 重启成功后主进程还会推一条 health {ok:true}；这里同时按返回值自清，
      // 避免那条事件丢失时横幅永远挂着（用户会以为重启没生效）。
      if (result?.ok === true) {
        setDown(false)
        setDetail('')
        return
      }
      if (result?.ok === false)
        setDetail(typeof result.error === 'string' ? result.error : '')
    }
    catch (error) {
      setDetail(error instanceof Error ? error.message : String(error))
    }
    finally {
      setBusy(false)
    }
  }

  const openLogs = () => {
    void desktopBridge().log?.openFolder?.()
  }

  return (
    <div className="fixed inset-x-0 top-0 z-[60] flex flex-wrap items-center justify-center gap-3 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-destructive backdrop-blur">
      <span className="font-medium">本地服务（内核）已停止：现在的「网络连接失败」就是它引起的</span>
      {detail !== '' && <span className="max-w-[42rem] truncate opacity-80">{detail}</span>}
      <button
        type="button"
        onClick={() => { void restart() }}
        disabled={busy}
        className="rounded-md border border-destructive/50 bg-background px-2.5 py-1 font-medium text-destructive transition hover:bg-destructive/10 disabled:opacity-60"
      >
        {busy ? '正在重启…' : '重启内核'}
      </button>
      <button
        type="button"
        onClick={openLogs}
        className="rounded-md border border-border bg-background px-2.5 py-1 font-medium text-foreground transition hover:bg-muted"
      >
        打开日志目录
      </button>
    </div>
  )
}

export default KernelHealthBanner
