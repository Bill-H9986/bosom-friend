/**
 * LongVideoPage - 长视频创作
 *
 * 厂商单次只生成 4~12 秒，所以长视频一律由后端通用工作流分段生成再拼接。
 * 本页做三件事：选内容形式（数字人口播 / 场景呈现）、把卖点写清楚（可一键增强成创作要求）、
 * 盯住生成过程（按真实段数显示进度、每段真实秒数、已用时间与剩余预估）。
 *
 * 进度一律来自后端的真实段数，不做按时间推算的假进度条；生成记录读后端任务表，
 * 刷新页面或换个页面回来都还能看到进行中的任务，不必守在这一页干等。
 * @module @web/desktop-pages/LongVideoPage
 */
'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  CheckCircle2,
  Clapperboard,
  Clock3,
  History,
  ListChecks,
  Loader2,
  Plus,
  Sparkles,
  UserRound,
  Wand2,
  XCircle,
} from 'lucide-react'
import { PageShell } from '@web/app/layout/PageShell'
import { Button } from '@web/components/ui/button'
import { Label } from '@web/components/ui/label'
import { Switch } from '@web/components/ui/switch'
import { Textarea } from '@web/components/ui/textarea'
import { toast } from '@web/utils/ui/toast'
import { cn } from '@web/utils/className'
import {
  enhanceLongVideoTopic,
  getLongVideoTask,
  listDigitalHumans,
  listLongVideoTasks,
  listProducers,
  startLongVideo,
} from '@web/api/longVideo/longVideo.api'
import type { DigitalHuman, LongVideoProducerInfo, LongVideoTask } from '@web/api/longVideo/longVideo.api'

/** 目标成片时长档位；后端会按厂商 4~12 秒上限切成若干段。 */
const DURATIONS = [15, 30, 60, 90, 120]
/** 画幅档位：短视频竖屏为默认。 */
const RATIOS = ['9:16', '16:9', '1:1']

/** 轮询间隔：一条 30 秒成片要串行跑好几段，间隔太密只是白刷接口。 */
const POLL_INTERVAL_MS = 4000

/**
 * 一段生成的耗时预算（分钟）：只用来给"还剩多久"的量级，不是承诺。
 * 真实进度以段数为准——厂商排队慢了，预估会跟着变长而不是假装快到了。
 */
const SEGMENT_MINUTES_MIN = 1
const SEGMENT_MINUTES_MAX = 5

/** 生成记录里展示的条数。 */
const HISTORY_LIMIT = 6

/** 状态徽标文案。 */
const STATUS_TEXT: Record<string, string> = { generating: '生成中', success: '已完成', failed: '生成失败' }

/** 生成阶段文案：写稿与逐段生成是两件不同的事，等的人有权知道卡在哪一步。 */
function phaseText(task: LongVideoTask): string {
  if (task.status !== 'generating') return STATUS_TEXT[task.status] ?? ''
  if (task.totalSegments === 0) return '正在写稿并切段…'
  return '正在逐段生成并自动拼接…'
}

/**
 * 剩余时间预估：按还没跑的段数乘以每段耗时区间。
 * @param task - 当前任务。
 * @returns 量级文案；段数未知（还在写稿）时给写稿本身的量级。
 */
function etaText(task: LongVideoTask): string {
  if (task.status !== 'generating') return ''
  if (task.totalSegments === 0) return '写稿约 10~30 秒'
  const left = Math.max(0, task.totalSegments - task.doneSegments)
  if (left === 0) return '正在拼接成片，约 10~30 秒'
  return '剩余约 ' + String(left * SEGMENT_MINUTES_MIN) + '~' + String(left * SEGMENT_MINUTES_MAX) + ' 分钟（每段一次厂商生成）'
}

/** 把秒数写成"分 秒"；不足一分钟只写秒。 */
function durationText(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  if (seconds < 60) return String(Math.round(seconds)) + ' 秒'
  return String(Math.floor(seconds / 60)) + ' 分 ' + String(Math.round(seconds % 60)) + ' 秒'
}

/** 把 ISO 时间写成 M-D HH:mm，生成记录里够用且不占地方。 */
function shortTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return String(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

export default function LongVideoPage() {
  const navigate = useNavigate()
  const [producers, setProducers] = useState<LongVideoProducerInfo[]>([])
  const [humans, setHumans] = useState<DigitalHuman[]>([])
  const [producer, setProducer] = useState('digital-human')
  const [humanId, setHumanId] = useState('')
  const [topic, setTopic] = useState('')
  const [targetSeconds, setTargetSeconds] = useState(30)
  const [aspectRatio, setAspectRatio] = useState('9:16')
  const [withSubtitles, setWithSubtitles] = useState(true)
  const [starting, setStarting] = useState(false)
  const [enhancing, setEnhancing] = useState(false)
  const [task, setTask] = useState<LongVideoTask | null>(null)
  const [history, setHistory] = useState<LongVideoTask[]>([])
  // 已用时间：只从任务自己的 createdAt 算，不另外记"点了按钮的时刻"，刷新后依然准。
  const [nowTick, setNowTick] = useState(0)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    void (async () => {
      const [producerRes, humanRes, taskRes] = await Promise.all([
        listProducers(),
        listDigitalHumans(),
        listLongVideoTasks(),
      ])
      const list = producerRes?.data?.list ?? []
      setProducers(list)
      if (list.length > 0 && !list.some(item => item.kind === producer))
        setProducer(list[0]!.kind)
      const owned = humanRes?.data?.list ?? []
      setHumans(owned)
      if (owned.length > 0) setHumanId(current => (current !== '' ? current : owned[0]!.id))
      // 生成记录先落地：进页面就能看到最近几条与仍在跑的那条，不必从零开始等。
      const recent = taskRes?.data?.list ?? []
      setHistory(recent)
      const running = recent.find(item => item.status === 'generating') ?? recent[0]
      if (running !== undefined) resume(running)
    })()
    // 只在首次进入时读一次：之后用户的选择与本地任务优先。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 停掉轮询计时器（任务收尾、组件卸载都要停，否则会一直打接口）。 */
  const stopPolling = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => stopPolling, [stopPolling])

  /** 刷新生成记录；失败保留原列表，不把已有记录清空成"暂无"。 */
  const refreshHistory = useCallback(async () => {
    const res = await listLongVideoTasks()
    const list = res?.data?.list
    if (Array.isArray(list)) setHistory(list)
  }, [])

  /** 按真实段数轮询进度；任务到终态就停，并把这一条并入生成记录。 */
  const poll = useCallback((taskId: string) => {
    stopPolling()
    const tick = async () => {
      const res = await getLongVideoTask(taskId)
      const next = res?.data
      if (next === undefined) {
        // 任务不存在或接口失败：把原因说清楚后停止轮询，不无限重试。
        toast.error('读不到任务进度，可能是任务已被清理，请刷新页面重试')
        void refreshHistory()
        return
      }
      setTask(next)
      setHistory(current => (current.some(item => item.id === next.id)
        ? current.map(item => (item.id === next.id ? next : item))
        : [next, ...current]))
      if (next.status === 'generating') {
        timerRef.current = window.setTimeout(() => void tick(), POLL_INTERVAL_MS)
        return
      }
      if (next.status === 'failed') toast.error(next.errorMessage || '生成失败')
      else toast.success('成片已生成，可在草稿箱发布')
    }
    void tick()
  }, [stopPolling, refreshHistory])

  /** 接续一条已有任务：把它的参数回填进表单，并继续按真实进度轮询。 */
  const resume = useCallback((item: LongVideoTask) => {
    setTask(item)
    setTopic(item.topic)
    setTargetSeconds(item.targetSeconds)
    setAspectRatio(item.aspectRatio)
    setWithSubtitles(item.withSubtitles !== false)
    setProducer(item.producer)
    if (item.producerRef !== undefined) setHumanId(item.producerRef)
    if (item.status === 'generating') poll(item.id)
    else stopPolling()
  }, [poll, stopPolling])

  /**
   * 提示词增强：把大白话交给大模型整理成创作要求。
   *
   * 只用返回的文本覆盖输入框，不自动开始生成——用户看清增强结果、确认后才去生成。
   */
  const handleEnhance = useCallback(async () => {
    if (topic.trim() === '') { toast.warning('先写清楚要讲的产品与卖点，再让 AI 帮你理顺'); return }
    setEnhancing(true)
    try {
      const res = await enhanceLongVideoTopic(topic.trim())
      if (res?.code !== 0) { toast.error(res?.message || '提示词增强失败'); return }
      const enhanced = res?.data?.topic ?? ''
      if (enhanced === '') { toast.error('没有拿到增强结果，请再试一次'); return }
      setTopic(enhanced)
      toast.success('已增强成专业创作要求，可以直接生成，也可以再改')
    }
    finally {
      setEnhancing(false)
    }
  }, [topic])

  const handleStart = useCallback(async () => {
    if (topic.trim() === '') { toast.warning('先写清楚要讲的产品与卖点'); return }
    if (producer === 'digital-human' && humanId === '') {
      toast.warning('还没有数字人形象，先去「我的数字人」创建一个')
      return
    }
    setStarting(true)
    try {
      const res = await startLongVideo({
        producer,
        ...(producer === 'digital-human' ? { producerRef: humanId } : {}),
        topic: topic.trim(),
        targetSeconds,
        aspectRatio,
        withSubtitles,
      })
      if (res?.code !== 0) { toast.error(res?.message || '创建任务失败'); return }
      const taskId = res?.data?.taskId ?? ''
      setTask({
        id: taskId,
        producer,
        topic: topic.trim(),
        targetSeconds,
        resolution: '720p',
        aspectRatio,
        withSubtitles,
        status: 'generating',
        doneSegments: 0,
        totalSegments: 0,
        segments: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      await refreshHistory()
      poll(taskId)
    }
    finally {
      setStarting(false)
    }
  }, [topic, producer, humanId, targetSeconds, aspectRatio, withSubtitles, poll, refreshHistory])

  const human = humans.find(item => item.id === humanId)
  const generating = task?.status === 'generating'
  const producerInfo = producers.find(item => item.kind === producer)

  // 生成中每秒走一格：等的人能看到"时间在走"，而不是只有一个不动的转圈。
  useEffect(() => {
    if (!generating) return undefined
    const timer = window.setInterval(() => setNowTick(value => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [generating])

  const elapsedSeconds = useMemo(() => {
    void nowTick
    if (task === null) return 0
    const started = new Date(task.createdAt).getTime()
    if (Number.isNaN(started)) return 0
    return Math.max(0, Math.round((Date.now() - started) / 1000))
  }, [task, nowTick])

  const progressPercent = task !== null && task.totalSegments > 0
    ? Math.round((task.doneSegments / task.totalSegments) * 100)
    : 0
  // 已生成的成片时长：累计各段真实秒数，用来对照"目标多少秒"。
  const producedSeconds = task === null
    ? 0
    : task.segments.reduce((sum, segment) => sum + (segment.audioSeconds > 0 ? segment.audioSeconds : 0), 0)

  return (
    <PageShell title="长视频创作" contentClassName="p-4 md:p-6">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <p className="text-sm text-muted-foreground">
          厂商单次只出 4~12 秒，长视频由系统自动分段生成再拼接成整条——你只需要给出产品和卖点。
          生成过程分"写稿切段"和"逐段生成"两步，你在下面能看到真实进度、每段真实时长与已经等了多久。
        </p>

        {/* 内容形式 */}
        <section>
          <h2 className="mb-3 text-sm font-medium">内容形式</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {producers.map(item => (
              <button
                key={item.kind}
                type="button"
                data-testid={`long-video-producer-${item.kind}`}
                disabled={generating}
                onClick={() => setProducer(item.kind)}
                className={cn(
                  'flex items-start gap-3 rounded-xl border p-3 text-left transition-colors disabled:opacity-60',
                  producer === item.kind ? 'border-primary bg-primary/5' : 'hover:border-primary/40',
                )}
              >
                {item.kind === 'digital-human'
                  ? <UserRound className="mt-0.5 h-5 w-5 flex-none text-primary" />
                  : <Clapperboard className="mt-0.5 h-5 w-5 flex-none text-primary" />}
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{item.name}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{item.description}</span>
                </span>
              </button>
            ))}
          </div>
        </section>

        {/* 数字人选择（仅数字人口播需要） */}
        {producer === 'digital-human' && (
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-medium">选择数字人</h2>
              <Button variant="ghost" size="sm" onClick={() => navigate('/digital-humans')}>
                <Plus className="mr-1 h-3.5 w-3.5" />新建数字人
              </Button>
            </div>
            {humans.length === 0
              ? (
                  <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
                    还没有数字人形象，先去「我的数字人」上传一张正面半身照——那里也能试听音色再选。
                  </div>
                )
              : (
                  <div className="flex flex-wrap gap-3">
                    {humans.map(item => (
                      <button
                        key={item.id}
                        type="button"
                        data-testid={`long-video-human-${item.id}`}
                        disabled={generating}
                        onClick={() => setHumanId(item.id)}
                        className={cn(
                          'flex w-32 flex-col items-center gap-2 rounded-xl border p-2 transition-colors disabled:opacity-60',
                          humanId === item.id ? 'border-primary bg-primary/5' : 'hover:border-primary/40',
                        )}
                      >
                        <img src={item.avatarUrl} alt={item.name} className="h-28 w-24 rounded-md object-cover" />
                        <span className="truncate text-xs">{item.name}</span>
                      </button>
                    ))}
                  </div>
                )}
          </section>
        )}

        {/* 卖点与参数 */}
        <section className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor="lv-topic">产品与卖点</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="long-video-enhance"
                disabled={enhancing || generating}
                onClick={() => void handleEnhance()}
              >
                {enhancing
                  ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  : <Wand2 className="mr-1 h-3.5 w-3.5" />}
                {enhancing ? '增强中…' : '专业提示词增强'}
              </Button>
            </div>
            <Textarea
              id="lv-topic"
              data-testid="long-video-topic"
              value={topic}
              rows={3}
              maxLength={200}
              disabled={generating}
              placeholder="例如：秋冬保湿面霜，主打干皮救急，今天直播间直降一百"
              onChange={event => setTopic(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              写得越具体，稿子和画面越贴合。一句话也能用：点「专业提示词增强」会补上人群、场景、痛点与行动号召，
              不会替你编造成分或功效；增强结果会回填到上面，你可以再改。
            </p>
          </div>

          <div className="flex flex-wrap gap-6">
            <div className="flex flex-col gap-1.5">
              <Label>目标时长</Label>
              <div className="flex flex-wrap gap-2">
                {DURATIONS.map(seconds => (
                  <Button
                    key={seconds}
                    type="button"
                    size="sm"
                    variant={targetSeconds === seconds ? 'default' : 'outline'}
                    disabled={generating}
                    data-testid={`long-video-duration-${seconds}`}
                    onClick={() => setTargetSeconds(seconds)}
                  >
                    {seconds} 秒
                  </Button>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>画幅</Label>
              <div className="flex flex-wrap gap-2">
                {RATIOS.map(ratio => (
                  <Button
                    key={ratio}
                    type="button"
                    size="sm"
                    variant={aspectRatio === ratio ? 'default' : 'outline'}
                    disabled={generating}
                    data-testid={`long-video-ratio-${ratio.replace(':', '-')}`}
                    onClick={() => setAspectRatio(ratio)}
                  >
                    {ratio}
                  </Button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Switch
              id="lv-subs"
              data-testid="long-video-subtitles"
              checked={withSubtitles}
              disabled={generating}
              onCheckedChange={setWithSubtitles}
            />
            <Label htmlFor="lv-subs" className="cursor-pointer">
              烧字幕（把口播文本压进画面，静音刷到也看得懂）
            </Label>
          </div>

          <div>
            <Button
              data-testid="long-video-start"
              disabled={starting || generating}
              onClick={() => void handleStart()}
            >
              {starting || generating
                ? <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                : <Sparkles className="mr-1 h-4 w-4" />}
              {generating ? '生成中…' : '开始生成'}
            </Button>
          </div>
        </section>

        {/* 进度与成片 */}
        {task !== null && (
          <section className="rounded-xl border bg-card p-4" data-testid="long-video-progress">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-sm font-medium">
                {task.status === 'generating' && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
                {task.status === 'success' && <CheckCircle2 className="h-4 w-4 text-primary" />}
                {task.status === 'failed' && <XCircle className="h-4 w-4 text-destructive" />}
                {STATUS_TEXT[task.status] ?? ''}
                <span className="text-xs font-normal text-muted-foreground" data-testid="long-video-phase">
                  {phaseText(task)}
                </span>
              </h2>
              <span className="text-xs text-muted-foreground tabular-nums" data-testid="long-video-progress-count">
                {task.totalSegments > 0 ? `${task.doneSegments} / ${task.totalSegments} 段` : '正在写稿…'}
              </span>
            </div>

            <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span className="flex items-center gap-1" data-testid="long-video-elapsed">
                <Clock3 className="h-3.5 w-3.5" />
                已用 {durationText(elapsedSeconds) || '不到 1 秒'}
              </span>
              {generating && <span data-testid="long-video-eta">{etaText(task)}</span>}
              {task.scriptChars !== undefined && task.scriptChars > 0 && (
                <span data-testid="long-video-script-chars">稿件 {task.scriptChars} 字</span>
              )}
              {producedSeconds > 0 && (
                <span data-testid="long-video-produced">
                  已生成 {producedSeconds.toFixed(1)} 秒 / 目标 {task.targetSeconds} 秒
                </span>
              )}
            </div>

            {task.totalSegments > 0 && (
              <div className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-[width] duration-500"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            )}

            {task.segments.length > 0 && (
              <ol className="mb-3 flex max-h-72 flex-col gap-1.5 overflow-y-auto">
                {task.segments.map((segment, index) => (
                  <li key={segment.index} className="flex items-start gap-2 text-xs">
                    <span className={cn(
                      'mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-full text-[10px]',
                      index < task.doneSegments ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                    )}
                    >
                      {index + 1}
                    </span>
                    <span className="min-w-0 flex-1 text-muted-foreground">{segment.text}</span>
                    <span className="flex-none tabular-nums text-muted-foreground">
                      {index < task.doneSegments ? (segment.audioSeconds > 0 ? `${segment.audioSeconds.toFixed(1)}s` : '—') : '等待中'}
                    </span>
                  </li>
                ))}
              </ol>
            )}

            {task.status === 'failed' && (
              <p className="text-sm text-destructive" data-testid="long-video-error">{task.errorMessage}</p>
            )}

            {task.status === 'success' && task.videoUrl !== undefined && (
              <div className="flex flex-col gap-3">
                <video
                  src={task.videoUrl}
                  controls
                  playsInline
                  data-testid="long-video-result"
                  className="max-h-[420px] w-auto self-start rounded-lg border bg-black"
                />
                <div className="flex gap-2">
                  <Button data-testid="long-video-go-draft" onClick={() => navigate('/draft-box')}>
                    去草稿箱发布
                  </Button>
                  <Button variant="outline" onClick={() => { stopPolling(); setTask(null) }}>
                    再做一条
                  </Button>
                </div>
              </div>
            )}

            {generating && (
              <p className="text-xs text-muted-foreground">
                每段要跑一次厂商生成（约 {SEGMENT_MINUTES_MIN}~{SEGMENT_MINUTES_MAX} 分钟），
                {producerInfo?.name ?? ''}的成片会自动拼接成整条。
                可以先去忙别的：任务在后端继续跑，这一页的「生成记录」随时能回来接着看。
              </p>
            )}
          </section>
        )}

        {/* 生成记录 */}
        <section data-testid="long-video-history">
          <div className="mb-3 flex items-center gap-2">
            <History className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-medium">生成记录</h2>
            <span className="text-xs text-muted-foreground">最近 {HISTORY_LIMIT} 条，进行中的也在里面</span>
          </div>
          {history.length === 0
            ? (
                <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
                  还没有长视频记录。填好产品与卖点，点「开始生成」，这里会出现第一条。
                </div>
              )
            : (
                <ul className="flex flex-col gap-2">
                  {history.slice(0, HISTORY_LIMIT).map(item => (
                    <li
                      key={item.id}
                      data-testid={`long-video-history-item-${item.id}`}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border bg-card px-3 py-2"
                    >
                      <span
                        className={cn(
                          'flex flex-none items-center gap-1 rounded px-1.5 py-0.5 text-[11px]',
                          item.status === 'success' ? 'bg-primary/10 text-primary' : '',
                          item.status === 'generating' ? 'bg-muted text-foreground' : '',
                          item.status === 'failed' ? 'bg-destructive/10 text-destructive' : '',
                        )}
                      >
                        {item.status === 'generating' && <Loader2 className="h-3 w-3 animate-spin" />}
                        {item.status === 'success' && <CheckCircle2 className="h-3 w-3" />}
                        {item.status === 'failed' && <XCircle className="h-3 w-3" />}
                        {STATUS_TEXT[item.status] ?? item.status}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm" title={item.topic}>{item.topic}</span>
                      <span className="flex-none text-xs text-muted-foreground tabular-nums">
                        {item.producer === 'scene' ? '场景呈现' : '数字人口播'} · 目标 {item.targetSeconds} 秒
                        {item.status === 'generating' && item.totalSegments > 0
                          ? ` · ${item.doneSegments}/${item.totalSegments} 段`
                          : ''}
                        {item.scriptChars !== undefined && item.scriptChars > 0 ? ` · ${item.scriptChars} 字` : ''}
                      </span>
                      <span className="flex-none text-xs text-muted-foreground">{shortTime(item.createdAt)}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="flex-none"
                        data-testid={`long-video-history-open-${item.id}`}
                        onClick={() => resume(item)}
                      >
                        <ListChecks className="mr-1 h-3.5 w-3.5" />
                        {item.status === 'generating' ? '看进度' : '查看'}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
        </section>
      </div>
    </PageShell>
  )
}
