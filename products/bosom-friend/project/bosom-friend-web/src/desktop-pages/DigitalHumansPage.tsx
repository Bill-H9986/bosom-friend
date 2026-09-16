/**
 * DigitalHumansPage - 我的数字人（固定 AI 形象库）
 *
 * 一条带货 IP 靠"同一个形象 + 同一个声音"立住，所以这里只管两件事：
 * 把形象图固定下来、把音色固定下来。之后每次出片都由长视频工作流复用这一份配置。
 */
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Bot, Loader2, PauseCircle, PlayCircle, Trash2, Upload } from 'lucide-react'
import { PageShell } from '@web/app/layout/PageShell'
import { Button } from '@web/components/ui/button'
import { Input } from '@web/components/ui/input'
import { Label } from '@web/components/ui/label'
import { toast } from '@web/utils/ui/toast'
import { confirm } from '@web/utils/ui/confirm'
import { cn } from '@web/utils/className'
import { uploadToOss } from '@web/api/materials/material.api'
import {
  VOICE_PREVIEW_TEXT,
  createDigitalHuman,
  deleteDigitalHuman,
  listDigitalHumans,
  listVoices,
  voicePreviewUrl,
} from '@web/api/longVideo/longVideo.api'
import type { DigitalHuman, VoiceOption } from '@web/api/longVideo/longVideo.api'

export default function DigitalHumansPage() {
  const [humans, setHumans] = useState<DigitalHuman[]>([])
  const [voices, setVoices] = useState<VoiceOption[]>([])
  const [defaultVoice, setDefaultVoice] = useState('')
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [voice, setVoice] = useState('')
  const [avatarUrl, setAvatarUrl] = useState('')
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)
  // 试听：同时只响一个音色，换一个就把上一个停掉，避免两条声音叠在一起。
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [previewing, setPreviewing] = useState('')
  const [previewError, setPreviewError] = useState('')
  const [previewed, setPreviewed] = useState<string[]>([])

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const [humanRes, voiceRes] = await Promise.all([listDigitalHumans(), listVoices()])
      setHumans(humanRes?.data?.list ?? [])
      const list = voiceRes?.data?.list ?? []
      setVoices(list)
      const fallback = voiceRes?.data?.defaultVoice ?? ''
      setDefaultVoice(fallback)
      setVoice(current => (current !== '' ? current : fallback))
    }
    catch {
      toast.error('读取数字人列表失败')
    }
    finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  /** 离开页面必须停掉试听：音频是全局单例，不停会继续响在别的页面上。 */
  useEffect(() => () => {
    audioRef.current?.pause()
    audioRef.current = null
  }, [])

  /**
   * 试听音色：同一个按钮再点一次是停止试听。
   *
   * 试听要连微软语音服务（首次约 1~3 秒），所以按钮上给"合成中"的状态，
   * 失败时把真实原因写在音色下面——不静默失败，也不拿别的音色顶替。
   */
  const handlePreview = useCallback((voiceId: string) => {
    if (audioRef.current !== null) {
      audioRef.current.pause()
      audioRef.current = null
    }
    setPreviewError('')
    if (previewing === voiceId) {
      setPreviewing('')
      return
    }
    const audio = new Audio(voicePreviewUrl(voiceId, VOICE_PREVIEW_TEXT))
    audioRef.current = audio
    setPreviewing(voiceId)
    const done = () => {
      setPreviewing(current => (current === voiceId ? '' : current))
      setPreviewed(current => (current.includes(voiceId) ? current : [...current, voiceId]))
    }
    audio.onended = done
    // 试听失败也记成"听过一次"：用户已经拿到了按钮的真实反馈，不再重复拦他创建。
    audio.onerror = () => {
      done()
      setPreviewError('这个音色试听合成失败，可能是语音服务暂时不可达，换一个音色或稍后再试')
    }
    void audio.play().catch(() => {
      done()
      setPreviewError('这个音色试听合成失败，可能是语音服务暂时不可达，换一个音色或稍后再试')
    })
  }, [previewing])

  /** 选图后立即上传，拿到素材 URL 才算选好——只留本地 objectURL 生成时会读不到。 */
  const handlePick = useCallback(async (files: FileList | null) => {
    const file = files?.[0]
    if (file === undefined) return
    if (!file.type.startsWith('image/')) {
      toast.warning('数字人形象需要一张图片（建议正面半身照）')
      return
    }
    setUploading(true)
    try {
      const url = await uploadToOss(file)
      setAvatarUrl(url)
      toast.success('形象图已就绪')
    }
    catch (error) {
      toast.error('形象图上传失败：' + (error instanceof Error ? error.message : '未知错误'))
    }
    finally {
      setUploading(false)
    }
  }, [])

  const handleCreate = useCallback(async () => {
    if (name.trim() === '') { toast.warning('先给数字人起个名字'); return }
    if (avatarUrl === '') { toast.warning('先上传一张形象图'); return }
    // 音色一旦定下来就跟着这条 IP 长期复用，先听再选，别靠"温柔/活泼"这几个字猜。
    if (previewed.length === 0) { toast.warning('先点音色右边的「试听」，听一条再定声音'); return }
    setSaving(true)
    try {
      const res = await createDigitalHuman({ name: name.trim(), avatarUrl, voice })
      if (res?.code !== 0) { toast.error(res?.message || '创建失败'); return }
      toast.success('数字人已创建')
      setName('')
      setAvatarUrl('')
      if (fileRef.current) fileRef.current.value = ''
      await reload()
    }
    finally {
      setSaving(false)
    }
  }, [name, avatarUrl, voice, previewed, reload])

  const handleDelete = useCallback(async (human: DigitalHuman) => {
    const ok = await confirm({
      title: '删除数字人',
      content: `删除后「${human.name}」不再出现在长视频创作里，已生成的成片不受影响。`,
      okText: '删除',
      cancelText: '取消',
    })
    if (ok !== true) return
    const res = await deleteDigitalHuman(human.id)
    if (res?.code !== 0) { toast.error(res?.message || '删除失败'); return }
    toast.success('已删除')
    await reload()
  }, [reload])

  return (
    <PageShell title="我的数字人" contentClassName="p-4 md:p-6">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <p className="text-sm text-muted-foreground">
          上传一张正面半身照，选一个音色，就是一个固定的带货 IP。之后每次做长视频，都是同一个人、同一个声音。
          音色可以先试听：每条声音点开都是同一句带货口播，听两三条就知道哪条合适。
        </p>

        {/* 新建 */}
        <section className="rounded-xl border bg-card p-4">
          <h2 className="mb-4 text-sm font-medium">新建数字人</h2>
          <div className="grid gap-4 md:grid-cols-[160px_1fr]">
            <div className="flex flex-col items-center gap-2">
              <button
                type="button"
                data-testid="digital-human-pick-avatar"
                onClick={() => fileRef.current?.click()}
                className={cn(
                  'flex h-40 w-32 items-center justify-center overflow-hidden rounded-lg border-2 border-dashed text-xs text-muted-foreground transition-colors',
                  avatarUrl === '' ? 'hover:border-primary/60' : 'border-solid',
                )}
              >
                {uploading
                  ? <Loader2 className="h-5 w-5 animate-spin" />
                  : avatarUrl === ''
                    ? <span className="flex flex-col items-center gap-1"><Upload className="h-5 w-5" />上传形象图</span>
                    : <img src={avatarUrl} alt="数字人形象" className="h-full w-full object-cover" />}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                data-testid="digital-human-avatar-input"
                onChange={event => void handlePick(event.target.files)}
              />
              <span className="text-[11px] text-muted-foreground">建议正面半身照</span>
            </div>

            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="dh-name">名字</Label>
                <Input
                  id="dh-name"
                  data-testid="digital-human-name"
                  value={name}
                  maxLength={30}
                  placeholder="例如：雅姐"
                  onChange={event => setName(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <Label>音色</Label>
                  <span className="text-[11px] text-muted-foreground">
                    先听再选：点一下就是这条声音念你的带货文案，同一个声音后面每条片都用它。
                  </span>
                </div>
                <div
                  role="radiogroup"
                  aria-label="音色"
                  data-testid="digital-human-voice"
                  className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-md border border-input p-1"
                >
                  {voices.map((item) => {
                    const active = (voice === '' ? defaultVoice : voice) === item.id
                    const playing = previewing === item.id
                    return (
                      <div
                        key={item.id}
                        data-testid={'digital-human-voice-option-' + item.id}
                        className={cn(
                          'flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors',
                          active ? 'bg-primary/10' : 'hover:bg-muted',
                        )}
                      >
                        <button
                          type="button"
                          role="radio"
                          aria-checked={active}
                          data-testid={'digital-human-voice-pick-' + item.id}
                          onClick={() => setVoice(item.id)}
                          className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm"
                        >
                          <span className={cn('h-3 w-3 flex-none rounded-full border', active ? 'border-primary bg-primary' : 'border-muted-foreground/50')} aria-hidden />
                          <span className="truncate">{item.name}</span>
                          {item.id === defaultVoice && (
                            <span className="flex-none rounded bg-muted px-1 text-[10px] text-muted-foreground">推荐</span>
                          )}
                          {previewed.includes(item.id) && !playing && (
                            <span className="flex-none text-[10px] text-muted-foreground">已试听</span>
                          )}
                        </button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="flex-none"
                          data-testid={'digital-human-voice-preview-' + item.id}
                          aria-label={(playing ? '停止试听 ' : '试听 ') + item.name}
                          onClick={() => handlePreview(item.id)}
                        >
                          {playing
                            ? <PauseCircle className="h-4 w-4" />
                            : <PlayCircle className="h-4 w-4" />}
                          <span className="ml-1 text-xs">{playing ? '停止' : '试听'}</span>
                        </Button>
                      </div>
                    )
                  })}
                </div>
                {previewError !== '' && (
                  <p className="text-xs text-destructive" data-testid="digital-human-voice-preview-error">{previewError}</p>
                )}
              </div>
              <div>
                <Button
                  data-testid="digital-human-create"
                  disabled={saving || uploading}
                  onClick={() => void handleCreate()}
                >
                  {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
                  创建数字人
                </Button>
              </div>
            </div>
          </div>
        </section>

        {/* 列表 */}
        <section>
          <h2 className="mb-3 text-sm font-medium">已有数字人（{humans.length}）</h2>
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
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {humans.map(human => (
                      <div key={human.id} data-testid={`digital-human-card-${human.id}`} className="flex gap-3 rounded-xl border bg-card p-3">
                        <img src={human.avatarUrl} alt={human.name} className="h-20 w-16 flex-none rounded-md object-cover" />
                        <div className="flex min-w-0 flex-1 flex-col justify-between">
                          <div>
                            <p className="truncate text-sm font-medium">{human.name}</p>
                            <p className="mt-0.5 truncate text-xs text-muted-foreground">
                              {voices.find(item => item.id === human.voice)?.name ?? human.voice}
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              data-testid={`digital-human-voice-play-${human.id}`}
                              // 已有形象也要能听：换了电脑或过了一阵子，用户的判断依据只剩这一句样音。
                              onClick={() => handlePreview(human.voice)}
                            >
                              {previewing === human.voice
                                ? <PauseCircle className="mr-1 h-3.5 w-3.5" />
                                : <PlayCircle className="mr-1 h-3.5 w-3.5" />}
                              {previewing === human.voice ? '停止' : '试听'}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="w-fit text-destructive"
                              data-testid={`digital-human-delete-${human.id}`}
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
      </div>
    </PageShell>
  )
}
