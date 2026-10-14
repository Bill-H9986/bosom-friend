/**
 * RemoteAccessTab - 设置 → 远程访问
 *
 * 把这台机器当成服务器：手机或别的电脑（同一 Wi-Fi 或外网）也能用这个 App。
 *
 * 三件事各自"怎么才生效"不一样，界面上必须分开说清楚，否则用户会以为点了开关就通了：
 *   ① 访问令牌：随时生效。开了远程访问之后，非本机请求必须带令牌；本机不受影响。
 *   ② 局域网可达：要重启运行时（监听地址是启动时定的）。
 *   ③ 外网可达：隧道进程，随时开关。
 *
 * 危险也必须在界面上说出来：地址给谁，谁就能看到这台机器的内容、并花这台机器配置的模型额度。
 */
'use client'

import { CheckCircle2, Copy, Loader2, RefreshCw, ShieldAlert, Wifi } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@web/components/ui/button'
import { Input } from '@web/components/ui/input'
import { Label } from '@web/components/ui/label'
import { Switch } from '@web/components/ui/switch'
import http from '@web/utils/request'
import { toast } from '@web/utils/ui/toast'

/** 远程访问状态（服务端 GET remote-access 的返回）。 */
interface RemoteAccessState {
  enabled: boolean
  token: string
  bindAll: boolean
  tunnelCommand: string
  port: number
  /** 当前实际监听地址：0.0.0.0 才代表局域网可达。 */
  bindHost: string
  lanUrls: Array<{ url: string, urlWithToken: string }>
  tunnel: { running: boolean, url: string, urlWithToken: string, provider: string, error: string, log: string[] }
  /** 本机有没有探测到 cloudflared。 */
  cloudflared: boolean
}

/**
 * 复制到剪贴板。
 *
 * @param text - 要复制的文本。
 */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success('已复制')
  }
  catch {
    // 非安全上下文（http 页面）里浏览器会拒绝剪贴板 API：如实提示手动复制，不假装成功。
    toast.warning('复制失败，请手动选中复制')
  }
}

export function RemoteAccessTab() {
  const [state, setState] = useState<RemoteAccessState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [tunnelCommand, setTunnelCommand] = useState('')

  const load = useCallback(async () => {
    const res = await http.get<RemoteAccessState>('remote-access', undefined, true)
    if (res?.code === 0) {
      setState(res.data)
      setTunnelCommand(current => (current === '' ? res.data.tunnelCommand : current))
    }
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  /**
   * 改配置。
   *
   * @param patch - 要改的字段。
   * @param tag - 正在处理哪一项（按钮转圈用）。
   */
  const save = useCallback(async (patch: Record<string, unknown>, tag: string) => {
    setBusy(tag)
    try {
      const res = await http.post<RemoteAccessState>('remote-access', patch, true)
      if (res?.code !== 0) { toast.error(res?.message || '保存失败'); return }
      setState(res.data)
      toast.success('已保存')
    }
    finally {
      setBusy('')
    }
  }, [])

  /**
   * 起停隧道。
   *
   * @param action - start 或 stop。
   */
  const tunnel = useCallback(async (action: 'start' | 'stop') => {
    setBusy(action)
    try {
      const res = await http.post<RemoteAccessState>('remote-access/tunnel/' + action, undefined, true)
      if (res?.code !== 0) { toast.error(res?.message || '隧道操作失败'); return }
      setState(res.data)
      toast.success(action === 'start' ? '隧道已启动' : '隧道已停止')
    }
    finally {
      setBusy('')
    }
  }, [])

  if (loading) {
    return (
      <div className="mx-auto flex w-full max-w-2xl items-center gap-2 px-6 py-16 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        正在读取远程访问配置…
      </div>
    )
  }
  if (state === null) {
    return <div className="mx-auto w-full max-w-2xl px-6 py-16 text-sm text-muted-foreground">读不到远程访问配置，请稍后重试。</div>
  }

  const lanReady = state.bindHost === '0.0.0.0'

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 pb-14 pt-10">
      <div className="flex items-start gap-3.5">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-cyan/15 text-brand-cyan">
          <Wifi className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-lg font-semibold tracking-tight text-foreground">远程访问</h3>
          <p className="mt-1.5 text-sm leading-7 text-muted-foreground">
            把这台机器当成服务器：手机或别的电脑也能用这个 App。默认只允许本机访问——
            这里装着你的内容与模型额度，对外开口子之前请先看清下面三段的区别。
          </p>
        </div>
      </div>

      <section className="rounded-xl border bg-card p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">允许远程访问</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              打开后，非本机请求必须带下面的访问令牌；本机（127.0.0.1）不受影响，照常免令牌使用。
            </p>
          </div>
          <Switch
            data-testid="remote-enabled"
            checked={state.enabled}
            disabled={busy !== ''}
            onCheckedChange={checked => void save({ enabled: checked }, 'enabled')}
          />
        </div>

        <div className="mt-4 flex flex-col gap-1.5 border-t border-border/60 pt-4">
          <Label>访问令牌</Label>
          <div className="flex items-center gap-2">
            <Input
              readOnly
              value={state.token}
              data-testid="remote-token"
              className="font-mono text-xs"
              onFocus={event => event.target.select()}
            />
            <Button type="button" variant="outline" size="sm" className="flex-none" onClick={() => void copyText(state.token)}>
              <Copy className="mr-1 h-3.5 w-3.5" />复制
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="flex-none"
              data-testid="remote-token-rotate"
              disabled={busy !== ''}
              onClick={() => void save({ rotateToken: true }, 'token')}
            >
              <RefreshCw className="mr-1 h-3.5 w-3.5" />重置
            </Button>
          </div>
          <p className="text-[11px] leading-5 text-muted-foreground">
            令牌就是门钥匙：重置之后，之前发出去的地址全部失效（本机不受影响）。
          </p>
        </div>

        <div className="mt-4 flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2.5 text-[11px] leading-5 text-amber-700">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>地址给了谁，谁就能看到这台机器的内容、并用这里配置的模型额度生成。只发给你信任的人。</span>
        </div>
      </section>

      <section className="rounded-xl border bg-card p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">局域网访问（同一 Wi-Fi / 同一网段）</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              要让同网段的设备连上，服务必须监听全部网卡（0.0.0.0）。监听地址在启动时确定，
              所以这个开关保存后需要重启一次才生效。
            </p>
          </div>
          <Switch
            data-testid="remote-bind-all"
            checked={state.bindAll}
            disabled={busy !== ''}
            onCheckedChange={checked => void save({ bindAll: checked }, 'bindAll')}
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className={lanReady ? 'text-primary' : 'text-muted-foreground'} data-testid="remote-bind-state">
            {lanReady ? '当前已监听全部网卡（局域网可达）' : '当前只监听本机（局域网连不上）'}
          </span>
          {state.bindAll !== lanReady && <span className="text-amber-700">· 已改设置，重启运行时后生效</span>}
        </div>

        {state.lanUrls.length === 0
          ? <p className="mt-3 text-xs text-muted-foreground">这台机器没有可用的局域网地址（没连网线也没连 Wi-Fi）。</p>
          : (
              <ul className="mt-3 flex flex-col gap-2">
                {state.lanUrls.map(item => (
                  <li key={item.url} className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 px-3 py-2">
                    <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground" data-testid="remote-lan-url">
                      {item.urlWithToken}
                    </code>
                    <Button type="button" variant="ghost" size="sm" className="flex-none" onClick={() => void copyText(item.urlWithToken)}>
                      <Copy className="mr-1 h-3.5 w-3.5" />复制带令牌的地址
                    </Button>
                  </li>
                ))}
              </ul>
            )}

        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-muted-foreground">重启运行时怎么做？</summary>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-muted/60 p-2.5 text-[11px] leading-5 text-foreground/80">
            {'开发端：powershell -File products/bosom-friend/launcher/scripts/dev-web.ps1' + String.fromCharCode(10) + '装机版：退出并重新打开 App'}
          </pre>
        </details>
      </section>

      <section className="rounded-xl border bg-card p-4">
        <p className="text-sm font-medium">外网访问（隧道）</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          隧道是在本机起一个进程，把外网连回本机端口，再给你一个公网地址——不需要公网 IP、也不用改路由器。
          {state.cloudflared
            ? '这台机器已经装了 cloudflared，直接点「启动隧道」即可。'
            : '本机没探测到 cloudflared：装一个（developers.cloudflare.com 有下载），或者在下面填自己的隧道命令（ngrok / frp / ssh -R 都行），命令里用 {port} 代表本机端口。'}
        </p>

        <div className="mt-3 flex flex-col gap-1.5">
          <Label htmlFor="remote-tunnel-cmd">隧道命令（可选）</Label>
          <Input
            id="remote-tunnel-cmd"
            data-testid="remote-tunnel-command"
            value={tunnelCommand}
            placeholder="留空用内置 cloudflared；例如 ngrok http {port}"
            onChange={event => setTunnelCommand(event.target.value)}
            onBlur={() => { if (tunnelCommand !== state.tunnelCommand) void save({ tunnelCommand }, 'command') }}
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            data-testid="remote-tunnel-start"
            disabled={busy !== '' || !state.enabled || state.tunnel.running}
            onClick={() => void tunnel('start')}
          >
            {busy === 'start' ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Wifi className="mr-1 h-3.5 w-3.5" />}
            启动隧道
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="remote-tunnel-stop"
            disabled={busy !== '' || !state.tunnel.running}
            onClick={() => void tunnel('stop')}
          >
            停止隧道
          </Button>
          {!state.enabled && <span className="text-xs text-muted-foreground">先打开上面的「允许远程访问」</span>}
        </div>

        <div className="mt-3 rounded-lg bg-muted/50 px-3 py-2.5 text-xs" data-testid="remote-tunnel-state">
          {state.tunnel.running
            ? (
                <div className="flex flex-wrap items-center gap-2">
                  <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
                  <span>{state.tunnel.provider}运行中{state.tunnel.url === '' ? '（还没解析出公网地址，看下面的输出）' : ''}</span>
                  {state.tunnel.urlWithToken !== '' && (
                    <>
                      <code className="min-w-0 flex-1 truncate font-mono text-[11px]">{state.tunnel.urlWithToken}</code>
                      <Button type="button" variant="ghost" size="sm" className="flex-none" onClick={() => void copyText(state.tunnel.urlWithToken)}>
                        <Copy className="mr-1 h-3.5 w-3.5" />复制
                      </Button>
                    </>
                  )}
                </div>
              )
            : <span className="text-muted-foreground">隧道未运行{state.tunnel.error !== '' ? '：' + state.tunnel.error : ''}</span>}
        </div>

        {state.tunnel.log.length > 0 && (
          <pre className="mt-2 max-h-32 overflow-auto rounded-lg bg-muted/60 p-2.5 text-[10px] leading-4 text-muted-foreground">
            {state.tunnel.log.join(String.fromCharCode(10))}
          </pre>
        )}
      </section>
    </div>
  )
}

export default RemoteAccessTab
