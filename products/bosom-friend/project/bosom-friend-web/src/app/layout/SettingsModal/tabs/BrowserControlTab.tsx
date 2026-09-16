/**
 * BrowserControlTab - 浏览器控制（自动化引擎）
 *
 * 支持谷歌浏览器（Chrome）与微软 Edge 双浏览器：
 *   - 检测本机安装路径 / 版本；
 *   - 选择默认自动化引擎（内置浏览器 / Chrome / Edge）；
 *   - 启动独立环境的自动化实例（每个实例独立账号数据，防关联）；
 *   - 管理运行中的实例（打开平台页面 / 关闭）。
 */
'use client'

import {
  Cpu,
  ExternalLink,
  Globe,
  Loader2,
  Monitor,
  Power,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@web/components/ui/badge'
import { Button } from '@web/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@web/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@web/components/ui/table'
import { cn } from '@web/utils/className'
import { toast } from '@web/utils/ui/toast'

const PLATFORM_NAME: Record<string, string> = {
  douyin: '抖音',
  xhs: '小红书',
  wxSph: '微信视频号',
}

const PLATFORM_URL: Record<string, string> = {
  douyin: 'https://creator.douyin.com/',
  xhs: 'https://creator.xiaohongshu.com/',
  wxSph: 'https://channels.weixin.qq.com/',
}

const ENGINE_LABEL: Record<ZhiyinAutomationEngine, string> = {
  embedded: '内置浏览器',
  chrome: '谷歌浏览器',
  edge: '微软 Edge',
}

function useDesktopIpc() {
  const ipc = typeof window !== 'undefined' ? window.ipcRenderer : undefined
  return !!ipc && typeof (ipc as { invoke?: unknown }).invoke === 'function' && (ipc as { __zyShim?: unknown }).__zyShim !== true
}

export function BrowserControlTab() {
  const isDesktop = useDesktopIpc()
  const [browsers, setBrowsers] = useState<ZhiyinBrowserInfo[]>([])
  const [instances, setInstances] = useState<ZhiyinBrowserInstance[]>([])
  const [defaultEngine, setDefaultEngine] =
    useState<ZhiyinAutomationEngine>('embedded')
  const [loading, setLoading] = useState(false)
  const [acting, setActing] = useState('')

  const refresh = useCallback(async () => {
    if (!isDesktop) return
    setLoading(true)
    try {
      const state = await window.ipcRenderer.invoke('zhiyin:browser:getState')
      setBrowsers(state.browsers || [])
      setInstances(state.instances || [])
      setDefaultEngine(state.defaultEngine || 'embedded')
    } catch {
      toast.error('读取浏览器状态失败')
    } finally {
      setLoading(false)
    }
  }, [isDesktop])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const setEngine = async (engine: ZhiyinAutomationEngine) => {
    if (!isDesktop || acting) return
    setActing(`engine-${engine}`)
    try {
      await window.ipcRenderer.invoke(
        'zhiyin:browser:setDefaultEngine',
        engine,
      )
      setDefaultEngine(engine)
      toast.success(`默认引擎已切换为「${ENGINE_LABEL[engine]}」`)
    } catch {
      toast.error('切换默认引擎失败')
    } finally {
      setActing('')
    }
  }

  const launch = async (kind: 'chrome' | 'edge') => {
    if (!isDesktop || acting) return
    setActing(`launch-${kind}`)
    try {
      const instance = await window.ipcRenderer.invoke(
        'zhiyin:browser:launch',
        kind,
        'douyin',
      )
      if (instance?.status === 'error') {
        toast.error(instance.error || '启动失败')
      } else {
        toast.success(
          `已启动${kind === 'chrome' ? '谷歌' : '微软 Edge'}自动化实例`,
        )
        await refresh()
      }
    } catch (e) {
      toast.error((e as Error).message || '启动实例失败')
    } finally {
      setActing('')
    }
  }

  const openPage = async (id: string, url?: string) => {
    if (!isDesktop || acting) return
    setActing(`open-${id}`)
    try {
      const r = await window.ipcRenderer.invoke(
        'zhiyin:browser:openUrl',
        id,
        url || 'https://creator.douyin.com/',
      )
      if (!r?.ok) toast.error('打开页面失败')
    } catch {
      toast.error('打开页面失败')
    } finally {
      setActing('')
    }
  }

  const closeInstance = async (id: string) => {
    if (!isDesktop || acting) return
    setActing(`close-${id}`)
    try {
      await window.ipcRenderer.invoke('zhiyin:browser:close', id)
      await refresh()
      toast.success('实例已关闭')
    } catch {
      toast.error('关闭实例失败')
    } finally {
      setActing('')
    }
  }

  if (!isDesktop) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-20 text-center text-sm text-muted-foreground">
        <Monitor className="h-8 w-8 opacity-50" />
        浏览器控制仅桌面端可用
      </div>
    )
  }

  return (
    <div className="w-full space-y-6">
      {/* 引擎说明 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Cpu className="h-4 w-4" />
            自动化引擎
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm leading-6 text-muted-foreground">
            Bosom Friend支持用内置浏览器或本机
            谷歌浏览器 / 微软 Edge 运行平台自动化。外部浏览器每个实例使用独立账号环境（独立数据目录），
            多账号互不关联，登录态持久保存，无需重复扫码。
          </p>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(ENGINE_LABEL) as ZhiyinAutomationEngine[]).map(
              (engine) => (
                <button
                  key={engine}
                  type="button"
                  disabled={!!acting}
                  onClick={() => setEngine(engine)}
                  className={cn(
                    'inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors',
                    defaultEngine === engine
                      ? 'border-brand-cyan/60 bg-brand-cyan/10 text-foreground'
                      : 'border-border text-muted-foreground hover:border-brand-cyan/40',
                  )}
                >
                  {engine === 'chrome' && <Globe className="h-4 w-4" />}
                  {engine === 'edge' && (
                    <span className="text-base leading-none">Ｅ</span>
                  )}
                  {engine === 'embedded' && <Monitor className="h-4 w-4" />}
                  {ENGINE_LABEL[engine]}
                  {defaultEngine === engine && (
                    <Badge variant="secondary" className="ml-1">
                      当前默认
                    </Badge>
                  )}
                  {acting === `engine-${engine}` && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  )}
                </button>
              ),
            )}
          </div>
        </CardContent>
      </Card>

      {/* 检测到的浏览器 */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-base">本机浏览器</CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
            disabled={loading}
          >
            <RefreshCw
              className={cn('h-3.5 w-3.5', loading && 'animate-spin')}
            />
            重新检测
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {browsers.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
              <Monitor className="h-8 w-8 opacity-50" />
              未检测到可用的谷歌或微软 Edge 浏览器
            </div>
          )}
          {browsers.map((browser) => (
            <div
              key={browser.kind}
              className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex items-center gap-3">
                {browser.kind === 'chrome' ? (
                  <Globe className="h-5 w-5 shrink-0" />
                ) : (
                  <span className="text-xl leading-none">Ｅ</span>
                )}
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    {browser.name}
                    {browser.version && (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        版本 {browser.version}
                      </span>
                    )}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {browser.exePath}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {defaultEngine !== browser.kind && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!!acting}
                    onClick={() => setEngine(browser.kind)}
                  >
                    设为默认
                  </Button>
                )}
                <Button
                  size="sm"
                  disabled={!!acting}
                  onClick={() => launch(browser.kind)}
                >
                  <Power className="h-3.5 w-3.5" />
                  启动实例
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* 运行中的实例 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">自动化实例</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {instances.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
              <Monitor className="h-8 w-8 opacity-50" />
              暂无运行中的实例，点击上方「启动实例」创建
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>实例</TableHead>
                  <TableHead>浏览器</TableHead>
                  <TableHead>调试端口</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {instances.map((instance) => (
                  <TableRow key={instance.id}>
                    <TableCell className="font-mono text-xs">
                      {instance.id}
                    </TableCell>
                    <TableCell>{instance.name}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {instance.port}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          instance.status === 'running'
                            ? 'default'
                            : instance.status === 'error'
                              ? 'destructive'
                              : 'secondary'
                        }
                      >
                        {instance.status === 'running'
                          ? '运行中'
                          : instance.status === 'starting'
                            ? '启动中'
                            : instance.status === 'error'
                              ? '启动失败'
                              : '已关闭'}
                      </Badge>
                      {instance.error && (
                        <p className="mt-1 max-w-56 text-xs text-destructive">
                          {instance.error}
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1.5">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={
                            !!acting || instance.status !== 'running'
                          }
                          onClick={() =>
                            openPage(
                              instance.id,
                              instance.openUrl ||
                                PLATFORM_URL.douyin,
                            )
                          }
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                          打开页面
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!!acting}
                          onClick={() => closeInstance(instance.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          关闭
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
