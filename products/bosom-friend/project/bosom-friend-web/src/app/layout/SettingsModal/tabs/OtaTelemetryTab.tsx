/**
 * OtaTelemetryTab - 系统与升级（面向普通用户重写）
 *
 * 普通人视角三段式：
 *   1) 当前版本卡：大版本号 + 「已是最新版本」徽标 + 一句人话说明；
 *   2) 产品信息卡：名称 / 当前版本 / 运行方式 / 数据存在哪；
 *   3) 常见问题：更新方式、数据安全（details 折叠，两句话解释）。
 * 桌面端（真实 IPC）才展开「高级」折叠区：更新服务器地址 / 检查更新 / 遥测开关。
 */
'use client'

import { CheckCircle2, ChevronDown, DownloadCloud, Fingerprint, Info, Loader2, RefreshCw, Save, ShieldCheck, UploadCloud, Lock } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import Image from '@web/next-shims/image'
import { Badge } from '@web/components/ui/badge'
import { Button } from '@web/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@web/components/ui/card'
import { Input } from '@web/components/ui/input'
import { Switch } from '@web/components/ui/switch'
import http from '@web/utils/request'
import { toast } from '@web/utils/ui/toast'
import logo from '@web/assets/images/logo.png'

interface UpdateCheckResult {
  update?: boolean
  reason?: 'dev' | 'up-to-date' | 'rollout' | 'error'
  currentVersion?: string
  newVersion?: string
  force?: boolean
  notes?: string
  message?: string
}

interface TelemetryState {
  enabled: boolean
  deviceId: string
  reportUrl: string
  queueSize: number
}

const APP_VERSION = (typeof window !== 'undefined' && window.__APP_VERSION__) ? 'v' + window.__APP_VERSION__ : __WEB_BUILD_VERSION__

/** 真实桌面端（有 invoke 的 IPC）才是可交互的桌面壳；网页 shim 无 invoke，不展示桌面功能。 */
function useRealDesktopIpc() {
  const ipc = typeof window !== 'undefined' ? window.ipcRenderer : undefined
  return !!ipc && typeof (ipc as { invoke?: unknown }).invoke === 'function' && (ipc as { __zyShim?: unknown }).__zyShim !== true
}

export function OtaTelemetryTab() {
  const isDesktop = useRealDesktopIpc()
  const [updateUrl, setUpdateUrl] = useState('')
  const [telemetry, setTelemetry] = useState<TelemetryState | null>(null)
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [checkResult, setCheckResult] = useState<UpdateCheckResult | null>(null)
  const [security, setSecurity] = useState<{ acl?: string; backupAt?: string; backupCount?: number; backupRoot?: string; integrity?: string } | null>(null)
  useEffect(() => {
    const probe = async () => {
      try {
        const base = (window as unknown as { __BACKEND_BASE_URL__?: string }).__BACKEND_BASE_URL__ || '/bosom-friend/api'
        const token = (window as unknown as { __ZHIYIN_AUTH_TOKEN__?: string }).__ZHIYIN_AUTH_TOKEN__ || ''
        const res = await fetch(base + '/user/security', { headers: { Authorization: 'Bearer ' + token } })
        const json = await res.json() as { code?: number; data?: typeof security }
        if (json.code === 0 && json.data) setSecurity(json.data)
      } catch { /* 忽略 */ }
    }
    void probe()
  }, [])
  const [downloadState, setDownloadState] = useState<'idle' | 'downloading' | 'downloaded'>('idle')
  const [downloadPercent, setDownloadPercent] = useState(0)

  const refresh = useCallback(async () => {
    if (!isDesktop) return
    try {
      const state = await window.ipcRenderer.invoke('zhiyin:telemetry:getState') as TelemetryState
      setTelemetry(state)
      const url = await window.ipcRenderer.getStoreValue('zhiyin-update-url') as string
      setUpdateUrl(url || '')
    } catch {
      // 主进程未就绪时忽略
    }
  }, [isDesktop])

  useEffect(() => { void refresh() }, [refresh])

  const saveUpdateUrl = async () => {
    if (!isDesktop || saving) return
    const url = updateUrl.trim()
    if (url && !/^https?:\/\//.test(url)) {
      toast.error('更新地址需以 http(s):// 开头')
      return
    }
    setSaving(true)
    try {
      await window.ipcRenderer.setStoreValue('zhiyin-update-url', url || '')
      toast.success('更新服务器地址已保存')
    } catch {
      toast.error('保存失败')
    } finally {
      setSaving(false)
    }
  }

  const checkUpdate = async () => {
    if (!isDesktop || checking) return
    setChecking(true)
    setCheckResult(null)
    try {
      const result = await window.ipcRenderer.invoke('zhiyin:update:check') as UpdateCheckResult
      setCheckResult(result)
      if (result?.update) {
        toast.success(result.force ? `发现新版本 v${result.newVersion}（强制更新）` : `发现新版本 v${result.newVersion}`)
      } else if (result?.reason === 'dev') {
        toast.info('开发模式下不支持在线升级，打包安装后可用')
      } else if (result?.reason === 'rollout') {
        toast.info('新版本正在灰度放量中，你的设备暂未入选')
      } else if (result?.reason === 'up-to-date') {
        toast.success('当前已是最新版本')
      } else if (result?.message) {
        toast.error(result.message)
      }
    } catch (e) {
      toast.error((e as Error).message || '检查更新失败')
    } finally {
      setChecking(false)
    }
  }

  const toggleTelemetry = async (enabled: boolean) => {
    if (!isDesktop) return
    try {
      await window.ipcRenderer.invoke('zhiyin:telemetry:setEnabled', enabled)
      setTelemetry(prev => (prev ? { ...prev, enabled } : prev))
      toast.success(enabled ? '已开启匿名使用数据采集' : '已关闭，本地缓冲已清理')
    } catch {
      toast.error('设置失败')
    }
  }

  useEffect(() => {
    const onProgress = (_e: unknown, info: { percent?: number }) => {
      setDownloadState('downloading')
      setDownloadPercent(Math.floor(info?.percent ?? 0))
    }
    const onDownloaded = () => {
      setDownloadState('downloaded')
      setDownloadPercent(100)
    }
    const onError = () => setDownloadState('idle')
    window.ipcRenderer?.on('download-progress', onProgress)
    window.ipcRenderer?.on('update-downloaded', onDownloaded)
    window.ipcRenderer?.on('update-error', onError)
    return () => {
      window.ipcRenderer?.off('download-progress', onProgress)
      window.ipcRenderer?.off('update-downloaded', onDownloaded)
      window.ipcRenderer?.off('update-error', onError)
    }
  }, [])

  const startDownload = async () => {
    setDownloadState('downloading')
    setDownloadPercent(0)
    try {
      await window.ipcRenderer.invoke('start-download')
    } catch {
      setDownloadState('idle')
    }
  }

  const installNow = async () => {
    await window.ipcRenderer.invoke('quit-and-install')
  }

  return (
    <div className="w-full space-y-5">
      {/* 1) 当前版本（普通用户第一眼） */}
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-8 text-center sm:flex-row sm:items-center sm:gap-6 sm:px-8 sm:py-7 sm:text-left">
          <Image src={logo} alt="Bosom Friend" width={64} height={64} className="shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
              <span className="text-lg font-semibold text-foreground">当前版本</span>
              <Badge variant="outline" className="border-emerald-500/40 text-emerald-700">
                <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                已是最新版本
              </Badge>
            </div>
            <p className="mt-1.5 font-[DIN,Suisseintl,sans-serif] text-2xl font-semibold tabular-nums text-foreground">{APP_VERSION}</p>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Bosom Friend 为你提供内容创作、多平台发布与 7×24 客户接待。当前为本地运行版本，
              有新版本时我们会第一时间在页面提示，无需你手动操作。
            </p>
          </div>
        </CardContent>
      </Card>

      {/* 1.5) 数据安全（自动加固，零操作） */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><Lock className="h-4 w-4 text-emerald-600" />数据安全（系统自动保障，无需任何操作）</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5 text-sm">
          <div className="flex gap-2"><span className="w-24 shrink-0 text-muted-foreground">访问范围</span><span className="text-foreground">仅本机（服务只绑定 127.0.0.1，其他设备无法访问）</span></div>
          <div className="flex gap-2"><span className="w-24 shrink-0 text-muted-foreground">数据出网</span><span className="text-foreground">零外发（无统计上报、无云端同步）</span></div>
          <div className="flex gap-2"><span className="w-24 shrink-0 text-muted-foreground">目录保护</span><span className="text-foreground">{security?.acl === 'tightened' ? '已完成：数据目录仅当前用户可读写（启动时自动收紧）' : '随系统账户受控（启动时自动尝试收紧）'}</span></div>
          <div className="flex gap-2"><span className="w-24 shrink-0 text-muted-foreground">自动备份</span><span className="text-foreground">{security?.backupAt ? `最近备份 ${String(security.backupAt).replace('T', ' ').slice(0, 19)} · 保留 ${security.backupCount ?? 0} 份` : '启动时自动快照'}</span></div>
          <div className="flex gap-2"><span className="w-24 shrink-0 text-muted-foreground">备份位置</span><span className="text-foreground">{security?.backupRoot || '~/.bosom-friend/bosom-friend/backups/（整体复制即完整备份）'}</span></div>
          <div className="flex gap-2"><span className="w-24 shrink-0 text-muted-foreground">数据完整性</span><span className="text-foreground">{security?.integrity === 'ok' ? '✅ 启动自检通过（全部数据可读）' : '自检进行中'}</span></div>
        </CardContent>
      </Card>

      {/* 2) 产品信息（只说人话） */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><Info className="h-4 w-4" />产品信息</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5 text-sm">
          <div className="flex gap-2"><span className="w-24 shrink-0 text-muted-foreground">产品名称</span><span className="text-foreground">Bosom Friend · AI 内容营销系统</span></div>
          <div className="flex gap-2"><span className="w-24 shrink-0 text-muted-foreground">当前版本</span><span className="text-foreground">{APP_VERSION}</span></div>
          <div className="flex gap-2"><span className="w-24 shrink-0 text-muted-foreground">使用方式</span><span className="text-foreground">网页版（本机服务，登录即用）</span></div>
          <div className="flex gap-2"><span className="w-24 shrink-0 text-muted-foreground">数据存放</span><span className="text-foreground">全部保存在你电脑本机的独立产品目录（~/.bosom-friend/），与开发系统 DSH 完全隔离，不上传任何服务器</span></div>
        </CardContent>
      </Card>

      {/* 3) 常见问题（两句话级别） */}
      <Card>
        <CardHeader className="pb-1">
          <CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4" />常见问题</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          <details className="group rounded-lg border px-4 py-3">
            <summary className="flex cursor-pointer items-center justify-between text-sm font-medium text-foreground">
              我的数据安全吗？
              <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
            </summary>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              安全。所有创作内容、账号与聊天记录都只保存在你电脑的本机目录里，
              「系统与升级」不会向任何服务器上传你的数据。
            </p>
          </details>
          <details className="group rounded-lg border px-4 py-3">
            <summary className="flex cursor-pointer items-center justify-between text-sm font-medium text-foreground">
              如何获取新版本？
              <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
            </summary>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              当前为本地运行版本，更新内容会随产品交付自动生效；如需重新部署，请参照部署文档操作。
            </p>
          </details>
        </CardContent>
      </Card>

      {/* 桌面端高级区：OTA 与遥测（普通用户看不到） */}
      {isDesktop && (
        <details className="group rounded-xl border border-dashed px-4 py-3">
          <summary className="flex cursor-pointer items-center justify-between text-sm font-medium text-foreground">
            开发者选项（桌面端：更新服务器 / 使用数据）
            <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
          </summary>
          <div className="mt-4 space-y-5">
            <div className="space-y-3">
              <p className="flex items-center gap-2 text-sm font-medium"><DownloadCloud className="h-4 w-4" />更新服务器与检查更新</p>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Input value={updateUrl} onChange={e => setUpdateUrl(e.target.value)} placeholder="https://你的服务端域名/updates/" className="flex-1" />
                <Button variant="outline" size="sm" onClick={() => void saveUpdateUrl()} disabled={saving}><Save className="h-3.5 w-3.5" />保存地址</Button>
                <Button size="sm" onClick={() => void checkUpdate()} disabled={checking}>{checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}立即检查更新</Button>
              </div>
              {checkResult && (
                <div className="rounded-lg border bg-muted/30 p-3 text-sm leading-6">
                  {checkResult.update ? (
                    <>
                      <p className="font-medium text-foreground">当前 v{checkResult.currentVersion} → 发现新版本 v{checkResult.newVersion}{checkResult.force && <Badge variant="destructive" className="ml-2">强制更新</Badge>}</p>
                      {checkResult.notes && <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{checkResult.notes}</p>}
                      <div className="mt-2 flex items-center gap-3">
                        {downloadState === 'downloaded' ? <Button size="sm" onClick={() => void installNow()}>现在安装</Button> : <Button size="sm" onClick={() => void startDownload()} disabled={downloadState === 'downloading'}>{downloadState === 'downloading' ? `下载中 ${downloadPercent}%` : '立即下载'}</Button>}
                      </div>
                    </>
                  ) : (<p className="text-muted-foreground">{checkResult.reason === 'dev' ? '开发模式下不支持在线升级，打包安装后可用' : checkResult.reason === 'rollout' ? '新版本正在灰度放量中，你的设备暂未入选' : checkResult.reason === 'up-to-date' ? `当前 v${checkResult.currentVersion} 已是最新版本` : checkResult.message || '未发现新版本'}</p>)}
                </div>
              )}
            </div>
            <div className="space-y-3">
              <p className="flex items-center gap-2 text-sm font-medium"><UploadCloud className="h-4 w-4" />使用数据与遥测</p>
              <div className="flex items-center justify-between gap-4">
                <p className="text-xs leading-5 text-muted-foreground">仅采集平台内操作（功能使用 / 页面访问 / 性能 / 错误 / 更新结果），全部脱敏后上报，不包含消息内容、账号信息等个人隐私；可随时关闭。</p>
                <Switch checked={telemetry?.enabled ?? true} onCheckedChange={v => void toggleTelemetry(v)} />
              </div>
              <div className="grid gap-3 rounded-lg border bg-muted/30 p-3 text-sm sm:grid-cols-2">
                <div className="flex items-center gap-2"><Fingerprint className="h-4 w-4 shrink-0 opacity-60" /><span className="text-muted-foreground">设备标识（匿名）</span></div>
                <code className="truncate font-mono text-xs text-foreground">{telemetry?.deviceId || '—'}</code>
                <div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 shrink-0 opacity-60" /><span className="text-muted-foreground">上报地址</span></div>
                <code className="truncate font-mono text-xs text-foreground">{telemetry?.reportUrl || '—'}</code>
              </div>
            </div>
          </div>
        </details>
      )}
    </div>
  )
}
