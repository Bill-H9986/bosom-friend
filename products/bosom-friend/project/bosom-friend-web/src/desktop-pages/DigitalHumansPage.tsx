/**
 * DigitalHumansPage - 我的数字人（固定 AI 形象库）
 *
 * 一条带货 IP 靠"同一份形象素材 + 同一种念法"立住，所以这里只管两件事：把素材固定下来、把念法固定下来。
 * 素材可以是一张正面半身照，也可以是一段正面人像视频（视频由后端抽出形象帧、另留一段参考视频）；
 * 念法是一句写进厂商提示词的声音人设，成片里那一声由厂商在出片时按它念。
 * 所以这一页没有音色可选、也没有试听——摆出来的是「念法人设 + 一句照着念的样板」。
 */
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Bot, Copy, Eye, Loader2, Trash2, Upload, X } from 'lucide-react'
import { PageShell } from '@web/app/layout/PageShell'
import { Button } from '@web/components/ui/button'
import { Input } from '@web/components/ui/input'
import { Label } from '@web/components/ui/label'
import { toast } from '@web/utils/ui/toast'
import { confirm } from '@web/utils/ui/confirm'
import { cn } from '@web/utils/className'
import { uploadToOss } from '@web/api/materials/material.api'
import {
  createDigitalHuman,
  deleteDigitalHuman,
  listDigitalHumans,
  listPersonas,
} from '@web/api/longVideo/longVideo.api'
import type { DigitalHuman, DigitalHumanPersona } from '@web/api/longVideo/longVideo.api'

/**
 * 素材选择框接受的视频扩展名。
 *
 * 与后端决定"要不要抽帧"的那份清单一致；浏览器对 .mkv / .avi 报的 MIME 常常是空串，
 * 所以判断类型时除了 video/ 前缀还要看扩展名，否则用户选得出文件却被前端挡回来。
 */
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v']

/**
 * 卡片上的念法一行。
 *
 * 新数据按 persona id 查目录里的展示名；老数据没有 persona，就如实标注「旧版形象」，
 * 并把库里存的旧音色 id 原样带出来——它能折成哪条念法由服务端决定，
 * 前端再抄一份对照表就会与服务端漂移。
 *
 * @param human - 一条数字人形象。
 * @param personas - 念法目录。
 * @returns 直接展示给用户的一行文字。
 */
function personaLabel(human: DigitalHuman, personas: DigitalHumanPersona[]): string {
  const found = personas.find(item => item.id === human.persona)
  if (found !== undefined) return found.name
  if (human.persona !== undefined && human.persona !== '') return '旧版形象'
  return human.voice !== undefined && human.voice !== '' ? '旧版形象 · 原音色 ' + human.voice : '旧版形象'
}

/** 由「内容创作」页以弹窗形式内嵌时传 true：不套自己的页面母版。 */
export interface DigitalHumansPageProps {
  embedded?: boolean
}

export default function DigitalHumansPage({ embedded = false }: DigitalHumansPageProps = {}) {
  const [humans, setHumans] = useState<DigitalHuman[]>([])
  const [personas, setPersonas] = useState<DigitalHumanPersona[]>([])
  const [defaultPersona, setDefaultPersona] = useState('')
  /** 参考台词样板：照着它写稿，语气才与念法描述对得上。 */
  const [sampleText, setSampleText] = useState('')
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [persona, setPersona] = useState('')
  const [avatarUrl, setAvatarUrl] = useState('')
  /** 正在查看形象的哪一个数字人；null = 没打开预览。 */
  const [preview, setPreview] = useState<DigitalHuman | null>(null)
  const [uploading, setUploading] = useState(false)
  /** 素材上传进度（0~100）：视频是几十兆的包，只转圈看不出还要等多久。 */
  const [uploadPercent, setUploadPercent] = useState(0)
  /** 本地预览地址：视频素材没有可显示的图片，留一份本地地址让用户就地看一眼选的是什么。 */
  const [previewUrl, setPreviewUrl] = useState('')
  const previewUrlRef = useRef('')
  /** 点了素材入口、还没拿到文件的那一小段：把"点了没反应"变成看得见的状态（与长视频产品图同一口径）。 */
  const [awaitingPicker, setAwaitingPicker] = useState(false)
  const [saving, setSaving] = useState(false)
  /** 创建失败的原因（服务端原文，例如视频太短）：留在创建按钮下面，不随提示条一起消失。 */
  const [createError, setCreateError] = useState('')
  const fileRef = useRef<HTMLInputElement | null>(null)

  /** 换素材时释放上一份本地预览地址；objectURL 不释放会一直占着那个文件的内存。 */
  const setLocalPreview = useCallback((url: string) => {
    if (previewUrlRef.current !== '') URL.revokeObjectURL(previewUrlRef.current)
    previewUrlRef.current = url
    setPreviewUrl(url)
  }, [])

  useEffect(() => () => {
    if (previewUrlRef.current !== '') URL.revokeObjectURL(previewUrlRef.current)
  }, [])

  // 没选过时跟随后端给的默认念法。放在所有回调之前：下面的 handleCreate 依赖它。
  const selectedPersona = persona === '' ? defaultPersona : persona

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const [humanRes, personaRes] = await Promise.all([listDigitalHumans(), listPersonas()])
      setHumans(humanRes?.data?.list ?? [])
      setPersonas(personaRes?.data?.list ?? [])
      const fallback = personaRes?.data?.defaultPersona ?? ''
      setDefaultPersona(fallback)
      setPersona(current => (current !== '' ? current : fallback))
      setSampleText(personaRes?.data?.sampleText ?? '')
    }
    catch {
      toast.error('读取数字人列表失败')
    }
    finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  useEffect(() => {
    if (!awaitingPicker) return undefined
    const dismiss = (): void => setAwaitingPicker(false)
    window.addEventListener('blur', dismiss)
    window.addEventListener('focus', dismiss)
    return () => {
      window.removeEventListener('blur', dismiss)
      window.removeEventListener('focus', dismiss)
    }
  }, [awaitingPicker])

  /** 选素材后立即上传，拿到素材 URL 才算选好——只留本地 objectURL 生成时会读不到。 */
  const handlePick = useCallback(async (files: FileList | null) => {
    const file = files?.[0]
    if (file === undefined) return
    const fileName = file.name.toLowerCase()
    const isImage = file.type.startsWith('image/')
    const isVideo = file.type.startsWith('video/') || VIDEO_EXTENSIONS.some(ext => fileName.endsWith(ext))
    if (!isImage && !isVideo) {
      toast.warning('形象素材需要一张正面半身照，或一段 2~12 秒的正面人像视频')
      return
    }
    setUploading(true)
    setUploadPercent(0)
    setCreateError('')
    try {
      const url = await uploadToOss(file, percent => setUploadPercent(percent))
      setAvatarUrl(url)
      setLocalPreview(isVideo ? URL.createObjectURL(file) : '')
      toast.success(isVideo ? '视频素材已就绪，创建时由服务端抽出形象帧' : '形象照已就绪')
    }
    catch (error) {
      toast.error('形象素材上传失败：' + (error instanceof Error ? error.message : '未知错误'))
    }
    finally {
      setUploading(false)
      setUploadPercent(0)
    }
  }, [setLocalPreview])

  const handleCreate = useCallback(async () => {
    if (name.trim() === '') { toast.warning('先给数字人起个名字'); return }
    if (avatarUrl === '') { toast.warning('先上传一张正面半身照，或一段 2~12 秒的正面人像视频'); return }
    setSaving(true)
    setCreateError('')
    try {
      const res = await createDigitalHuman({
        name: name.trim(),
        avatarUrl,
        persona: selectedPersona,
      })
      // 视频建形象时服务端的失败原因是可读的中文（视频太短 / 抽不到帧），原样显示，不另造一句话。
      if (res?.code !== 0) {
        const message = res?.message || '创建失败'
        setCreateError(message)
        toast.error(message)
        return
      }
      toast.success('数字人已创建')
      setName('')
      setAvatarUrl('')
      setLocalPreview('')
      if (fileRef.current) fileRef.current.value = ''
      await reload()
    }
    finally {
      setSaving(false)
    }
  }, [name, avatarUrl, selectedPersona, reload, setLocalPreview])

  const handleDelete = useCallback(async (human: DigitalHuman) => {
    const ok = await confirm({
      title: '删除数字人',
      content: '删除后「' + human.name + '」不再出现在长视频创作里，已生成的成片不受影响。',
      okText: '删除',
      cancelText: '取消',
    })
    if (ok !== true) return
    const res = await deleteDigitalHuman(human.id)
    if (res?.code !== 0) { toast.error(res?.message || '删除失败'); return }
    toast.success('已删除')
    await reload()
  }, [reload])

  /** 复制参考样句：用户拿它当写稿的语气样板，省得照着屏幕敲一遍。 */
  const handleCopySample = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(sampleText)
      toast.success('样句已复制，照着它写你的口播稿')
    }
    catch {
      toast.error('复制失败，请手动选中这句话复制')
    }
  }, [sampleText])

  const content = (
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          上传一张正面半身照，或一段 2~12 秒的正面人像视频，再选一种念法，就是一个固定的带货 IP——之后每次做长视频，
          都是同一个人、同一种语气。声音由厂商在出片时按你选的念法念，念法写在提示词里，不必试听。
        </p>

        {/* 新建 */}
        <section className="rounded-2xl border bg-card p-5 md:p-6">
          <div className="mb-5">
            <h2 className="text-sm font-medium">新建数字人</h2>
            <p className="mt-1 text-xs text-muted-foreground">形象素材 + 念法，两项都定下来就是一个固定的带货 IP。</p>
          </div>
          <div className="grid gap-5 lg:grid-cols-[176px_1fr] lg:gap-7">
            <div className="flex flex-col items-center gap-2">
              {/*
                选素材入口 = 铺满整块虚线框的透明 <input type="file">（与长视频页的产品图同一口径）：
                用户点到的就是输入框本身，既不走"按钮 + JS 去 click 隐藏输入框"，也不依赖 <label> 转发。
              */}
              <span className="relative inline-flex">
                <span
                  aria-hidden="true"
                  className={cn(
                    'flex h-44 w-36 items-center justify-center overflow-hidden rounded-xl border-2 border-dashed text-xs text-muted-foreground transition-colors',
                    avatarUrl === '' ? 'border-border' : 'border-solid',
                    uploading && 'opacity-60',
                  )}
                >
                  {uploading
                    ? (
                        <span className="flex flex-col items-center gap-1">
                          <Loader2 className="h-5 w-5 animate-spin" />
                          {uploadPercent > 0 ? String(uploadPercent) + '%' : '上传中…'}
                        </span>
                      )
                    : previewUrl !== ''
                      ? <video src={previewUrl} muted playsInline className="h-full w-full object-cover" />
                      : avatarUrl === ''
                        ? <span className="flex flex-col items-center gap-1"><Upload className="h-5 w-5" />上传照片或视频</span>
                        : <img src={avatarUrl} alt="数字人形象" className="h-full w-full object-cover" />}
                </span>
                <input
                  id="dh-avatar"
                  ref={fileRef}
                  type="file"
                  accept="image/*,video/*,.mkv,.avi,.m4v"
                  disabled={uploading}
                  title={uploading ? '素材上传中…' : '选一张正面半身照，或一段 2~12 秒的正面人像视频'}
                  aria-label={avatarUrl === '' ? '上传数字人形象素材' : '换一份数字人形象素材'}
                  data-testid="digital-human-pick-avatar"
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
                  onClick={() => setAwaitingPicker(true)}
                  onChange={(event) => {
                    setAwaitingPicker(false)
                    void handlePick(event.target.files)
                  }}
                />
              </span>
              <span className="text-center text-[11px] text-muted-foreground">
                {awaitingPicker
                  ? '已在等系统选择框…如果一直没弹出来，刷新页面后重试'
                  : '照片：正面半身照；视频：2~12 秒正面人像'}
              </span>
            </div>

            <div className="flex flex-col">
              <div className="flex flex-col gap-2">
                <Label htmlFor="dh-name">名字</Label>
                <Input
                  id="dh-name"
                  data-testid="digital-human-name"
                  value={name}
                  maxLength={30}
                  placeholder="例如：雅姐"
                  className="max-w-sm"
                  onChange={event => setName(event.target.value)}
                />
              </div>

              {/* 念法：厂商按这段描述念，所以是"选一个人设"，不是"挑一条音色"，也就没有试听这一步。 */}
              <div className="mt-6 flex flex-col gap-2 border-t border-border/60 pt-5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <Label>念法</Label>
                  <span className="text-[11px] text-muted-foreground">同一张脸念起来什么样：直播吆喝与成分讲解不该是同一种语气</span>
                </div>
                {personas.length === 0
                  ? (
                      <p className="rounded-lg bg-muted/50 px-2.5 py-1.5 text-[11px] leading-5 text-muted-foreground" data-testid="digital-human-persona-empty">
                        念法目录没读出来：现在创建会按服务端的默认念法出声，稍后刷新页面可以再选。
                      </p>
                    )
                  : (
                      /* 两列而不是三列：表单区固定 658px，三列时每列只有 214px，一句念法说明会被折成三行。 */
                      <div className="grid gap-2 sm:grid-cols-2" data-testid="digital-human-personas">
                        {personas.map(item => (
                          <button
                            key={item.id}
                            type="button"
                            data-testid={'digital-human-persona-' + item.id}
                            aria-pressed={selectedPersona === item.id}
                            onClick={() => setPersona(item.id)}
                            className={cn(
                              'rounded-xl border px-3 py-2 text-left transition-colors',
                              selectedPersona === item.id
                                ? 'border-primary bg-primary/5'
                                : 'hover:border-primary/40',
                            )}
                          >
                            <span className="flex items-center gap-2">
                              <span className="text-xs font-medium text-foreground">{item.name}</span>
                              {item.id === defaultPersona && (
                                <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">推荐</span>
                              )}
                            </span>
                            <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">{item.summary}</span>
                          </button>
                        ))}
                      </div>
                    )}
                {sampleText !== '' && (
                  <p className="flex flex-wrap items-center gap-1 rounded-lg bg-muted/50 px-2.5 py-1.5 text-[11px] leading-5 text-muted-foreground" data-testid="digital-human-sample-text">
                    <span className="font-medium text-foreground">照这样念：</span>
                    {sampleText}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-5 px-1 text-[11px]"
                      data-testid="digital-human-sample-copy"
                      onClick={() => void handleCopySample()}
                    >
                      <Copy className="mr-1 h-3 w-3" />复制
                    </Button>
                  </p>
                )}
              </div>

              <div className="mt-6 flex flex-col gap-2 border-t border-border/60 pt-5">
                <div className="flex items-center gap-3">
                  <Button
                    data-testid="digital-human-create"
                    disabled={saving || uploading}
                    onClick={() => void handleCreate()}
                  >
                    {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
                    创建数字人
                  </Button>
                  <span className="text-[11px] text-muted-foreground">创建后念法随形象长期复用</span>
                </div>
                {createError !== '' && (
                  <p className="text-xs text-destructive" data-testid="digital-human-create-error">{createError}</p>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* 列表 */}
        <section>
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-medium">已有数字人（{humans.length}）</h2>
            <span className="text-[11px] text-muted-foreground">卡片上写的是它出片时用的念法</span>
          </div>
          {loading
            ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />加载中…</div>
            : humans.length === 0
              ? (
                  <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-12 text-sm text-muted-foreground">
                    <Bot className="h-6 w-6" />
                    还没有数字人，先在上面创建一个
                  </div>
                )
              : (
                  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    {humans.map(human => (
                      <div key={human.id} data-testid={'digital-human-card-' + human.id} className="flex gap-4 rounded-2xl border bg-card p-4">
                        {/* 形象图点开就能看大图：形象是这条 IP 的锚，用户得看清自己固定下来的是哪张脸。 */}
                        <button
                          type="button"
                          className="group relative h-24 w-20 flex-none cursor-pointer overflow-hidden rounded-lg"
                          data-testid={'digital-human-view-' + human.id}
                          title="查看数字人形象"
                          onClick={() => setPreview(human)}
                        >
                          <img src={human.avatarUrl} alt={human.name} className="h-24 w-20 object-cover" />
                          <span className="absolute inset-0 hidden items-center justify-center bg-black/45 text-[11px] text-white group-hover:flex">查看形象</span>
                        </button>
                        <div className="flex min-w-0 flex-1 flex-col justify-between">
                          <div>
                            <div className="flex items-center gap-1.5">
                              <p className="truncate text-sm font-medium">{human.name}</p>
                              {human.sourceVideoUrl !== undefined && (
                                <span
                                  className="flex-none rounded bg-muted px-1 text-[10px] text-muted-foreground"
                                  data-testid={'digital-human-video-badge-' + human.id}
                                >
                                  视频形象
                                </span>
                              )}
                            </div>
                            <p
                              className="mt-0.5 truncate text-xs text-muted-foreground"
                              data-testid={'digital-human-card-persona-' + human.id}
                            >
                              {personaLabel(human, personas)}
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="w-fit"
                              data-testid={'digital-human-view-btn-' + human.id}
                              onClick={() => setPreview(human)}
                            >
                              <Eye className="mr-1 h-3.5 w-3.5" />查看形象
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="w-fit text-destructive"
                              data-testid={'digital-human-delete-' + human.id}
                              onClick={() => void handleDelete(human)}
                            >
                              <Trash2 className="mr-1 h-3.5 w-3.5" />删除
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
        </section>
        {/* 形象预览：这张脸出片时到底是什么样（视频形象连参考视频一起看）。 */}
        {preview !== null && (
          <div
            className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/70 p-4"
            data-testid="digital-human-preview"
            onClick={() => setPreview(null)}
          >
            <div
              className="w-full max-w-lg rounded-2xl border bg-card p-4 shadow-xl"
              onClick={event => event.stopPropagation()}
            >
              <div className="mb-3 flex items-center justify-between gap-2">
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  {preview.name}
                  {preview.sourceVideoUrl !== undefined && (
                    <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">视频形象</span>
                  )}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="digital-human-preview-close"
                  onClick={() => setPreview(null)}
                >
                  <X className="mr-1 h-3.5 w-3.5" />关闭
                </Button>
              </div>
              {preview.sourceVideoUrl !== undefined
                ? (
                    <video
                      src={preview.sourceVideoUrl}
                      poster={preview.avatarUrl}
                      controls
                      autoPlay
                      loop
                      muted
                      playsInline
                      data-testid="digital-human-preview-video"
                      className="max-h-[60vh] w-full rounded-lg bg-black object-contain"
                    />
                  )
                : (
                    <img
                      src={preview.avatarUrl}
                      alt={preview.name}
                      data-testid="digital-human-preview-image"
                      className="max-h-[60vh] w-full rounded-lg bg-muted object-contain"
                    />
                  )}
              <div className="mt-3 flex items-start gap-3">
                <img
                  src={preview.avatarUrl}
                  alt={preview.name}
                  className="h-20 w-16 flex-none rounded-lg object-cover"
                />
                <div className="min-w-0 text-xs text-muted-foreground">
                  <p data-testid="digital-human-preview-persona">{personaLabel(preview, personas)}</p>
                  <p className="mt-0.5">
                    {preview.sourceVideoUrl !== undefined
                      ? '视频形象：出片时按这段参考视频延续动作与说话方式（需要 agnes-video-2.5）'
                      : '照片形象：出片时按这张形象图出镜'}
                  </p>
                  <p className="mt-0.5">创建于 {new Date(preview.createdAt).toLocaleString()}</p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
  )
  // 嵌入时只出内容：它现在是「内容创作」页里的一段（弹窗），不再是独立板块。
  if (embedded) return content
  return <PageShell title="我的数字人">{content}</PageShell>
}
