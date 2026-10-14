/**
 * LongVideoPage - 长视频创作
 *
 * @deprecated 待删（ADR-005 呈现层改造方案 v1.0 的 D3）。2026-10-11 第三次全仓引用复核：
 * 本文件没有任何路由指向它（electron `router/index.tsx` 把 /long-video 重定向到 /draft-box），
 * 也没有任何代码 import 它——全仓命中的只有文档、QA 报告与它自己的注释。
 * 长视频能力已由「内容创作」页的 `LongVideoTaskBar` + 分段编排承担。
 * **保留不删**：按总纲 v2.0 第 10.1 节第 3 条「未拍板前一律降级不删」，删除需产品负责人拍板。
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
  ImagePlus,
  ListChecks,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  Square,
  Trash2,
  UserRound,
  Wand2,
  XCircle,
} from 'lucide-react'
import { PageShell } from '@web/app/layout/PageShell'
import { Button, buttonVariants } from '@web/components/ui/button'
import { Checkbox } from '@web/components/ui/checkbox'
import { Label } from '@web/components/ui/label'
import { Switch } from '@web/components/ui/switch'
import { Textarea } from '@web/components/ui/textarea'
import { confirm } from '@web/utils/ui/confirm'
import { toast } from '@web/utils/ui/toast'
import { cn } from '@web/utils/className'
import { MAX_LONG_VIDEO_TOPIC_CHARS, briefCharsHint, topicLengthHint } from '@web/components/draft-box/components/AiBatchGenerateBar/utils/constants'
import { uploadToOss } from '@web/api/materials/material.api'
import {
  deleteLongVideoTask,
  deleteLongVideoTasks,
  enhanceLongVideoTopic,
  extendLongVideoScript,
  getLongVideoTask,
  getScriptRequirement,
  listDigitalHumans,
  listLongVideoTasks,
  listProducers,
  redoLongVideoShot,
  resumeLongVideoTask,
  startLongVideo,
  stopLongVideoTask,
} from '@web/api/longVideo/longVideo.api'
import type { DigitalHuman, LongVideoEstimate, LongVideoProducerInfo, LongVideoTask } from '@web/api/longVideo/longVideo.api'
import type { ScriptRequirement } from '@web/api/longVideo/longVideo.api'

/**
 * 目标成片时长档位（秒）——**这一档是"长视频"**，与「内容创作」板块的短视频分工明确：
 * 短视频在内容创作里做（单条最长 60 秒，见 AiBatchGenerateBar 的 SHORT_VIDEO_MAX_SECONDS），
 * 这里只做需要"分段生成再拼成整条"的长片。两边档位不重叠，用户一眼看得出该去哪里做。
 */
const DURATIONS = [90, 120, 300]

/**
 * 本板块的时长下限（秒）：低于它就该去内容创作做短视频。
 * 后端也按这个下限夹紧一次，避免旧链接/旧数据把短视频档位带进来。
 */
const MIN_LONG_VIDEO_SECONDS = 90

/**
 * 成片分辨率：**1080p 竖屏**。
 *
 * 长视频默认走 1080p 而不是 720p：片子更长、更值得清晰度，而平台二次压缩后 720p 会糊；
 * 档位表本来就支持 1080x1920（见 image-ratio 的 RATIO_TIERS），此前只是这里写死了 720p。
 */
const LONG_VIDEO_RESOLUTION = '1080p'
/** 画幅档位：短视频竖屏为默认。 */
const RATIOS = ['9:16', '16:9', '1:1']

/** 轮询间隔：一条长片要串行跑好几镜，间隔太密只是白刷接口。 */
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

/** 节拍的展示名：让分镜预览看得出每一镜在整条片里承担什么。 */
const BEAT_TEXT: Record<string, string> = { hook: '钩子', pain: '痛点', product: '卖点', cta: '号召' }

/** 镜头类型的展示名（分镜预览里用；数字人/产品镜必须一眼分得出来）。 */
const SHOT_KIND_TEXT: Record<string, string> = {
  'talking-head': '口播',
  product: '产品',
  scene: '空镜',
  'text-card': '文字卡',
}

/** 生成阶段文案：写稿与逐镜生成是两件不同的事，等的人有权知道卡在哪一步。 */
function phaseText(task: LongVideoTask): string {
  if (task.status !== 'generating') return STATUS_TEXT[task.status] ?? ''
  if (task.totalSegments === 0) return '正在写稿并排分镜…'
  return '正在逐镜生成并自动拼接…'
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
  return '剩余约 ' + String(left * SEGMENT_MINUTES_MIN) + '~' + String(left * SEGMENT_MINUTES_MAX) + ' 分钟（每镜一次厂商生成）'
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
  // 「这个形式要不要选数字人」由后端给（LongVideoProducerInfo.needsHuman）：
  // 2026-09-24 修——此前只在"数字人口播"下渲染选择器，走动 VLOG/口播短视频/开箱测评/步骤教程
  // 四种形式因此既选不了形象、也不会带上 producerRef，一提交就撞后端那句"数字人形象已被删除"。
  // 位置必须在 producer 之后：它按 producer 查名单，写在前面会踩 TDZ（实测页面直接白屏报
  // "Cannot access 'producer' before initialization"）。
  const needsHuman = producers.find(item => item.kind === producer)?.needsHuman === true
  const [humanId, setHumanId] = useState('')
  const [topic, setTopic] = useState('')
  // 默认 90 秒：本板块的时长下限（短视频请到「内容创作」）。
  const [targetSeconds, setTargetSeconds] = useState(MIN_LONG_VIDEO_SECONDS)
  const [aspectRatio, setAspectRatio] = useState('9:16')
  const [withSubtitles, setWithSubtitles] = useState(true)
  const [starting, setStarting] = useState(false)
  const [enhancing, setEnhancing] = useState(false)
  // 可选的产品图（甲方案）：传了产品镜就以真实产品为主体，不传就走"不含任何文字"的纯描述。
  const [productImageUrl, setProductImageUrl] = useState('')
  // 起任务前算给你看的预估：几镜、大约多久。点了之后不用干等一个"不知道要多久"。
  const [estimate, setEstimate] = useState<LongVideoEstimate | null>(null)
  const [uploadingProduct, setUploadingProduct] = useState(false)
  /**
   * 点了入口、还没拿到文件的那一小段：把"点了没反应"变成看得见的状态。
   * 选择框弹出会让窗口失焦（blur），选完或取消会让窗口重新聚焦（focus）——两个事件都收掉提示；
   * 浏览器要是根本没弹框，提示就留在页面上，用户看到的是"点击收到了，框没弹出来"，而不是一片沉默。
   */
  const [awaitingPicker, setAwaitingPicker] = useState(false)
  const [redoingShot, setRedoingShot] = useState<number | null>(null)
  const [resuming, setResuming] = useState(false)
  const [stopping, setStopping] = useState(false)
  /** 当前档位的稿件字数门槛：点生成之前就摆出来，不让人被拒两次才明白（DEF-108）。 */
  const [scriptNeed, setScriptNeed] = useState<ScriptRequirement | null>(null)
  /** 卖点字数与门槛的对照提示：填的时候就看得到差多少，不必提交后才知道（DEF-108）。 */
  const briefHint = useMemo(() => briefCharsHint(topic.length, scriptNeed), [topic, scriptNeed])
  /** 正在补写稿件的那一条任务 id（按钮转圈用）。 */
  const [extendingId, setExtendingId] = useState('')
  /** 正在删除的那条生成记录（按钮转圈用）。 */
  const [deletingId, setDeletingId] = useState('')
  /** 批量管理模式：勾选多条一次删掉。 */
  const [batchMode, setBatchMode] = useState(false)
  const [batchSelected, setBatchSelected] = useState<string[]>([])
  const [batchDeleting, setBatchDeleting] = useState(false)
  /**
   * 生成记录是否展开全部。
   *
   * 默认只显示最近几条（这一页的重点是"再做一条"），但记录是**可删的**——
   * 只给前 6 条的话，攒到十几条之后老的那些既看不见也删不掉（实测用户有 14 条）。
   */
  const [showAllRecords, setShowAllRecords] = useState(false)
  const productInputRef = useRef<HTMLInputElement | null>(null)
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

  /**
   * 轮询的保活截止时间。
   *
   * 起任务与续跑都是"回执先到、状态后变"：回执之后紧接着读一次，拿到的可能仍是**上一个终态**
   * （实测续跑时读到的是 failed）。没有这个保活窗口，轮询会在第一次读到旧状态时就停，
   * 用户必须手动刷新页面才能看到进度。
   */
  const pollHoldUntilRef = useRef(0)

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

  /**
   * 删除一条生成记录。
   *
   * 二次确认后才删，且**删的是记录不是成片**：成片已经作为草稿进了内容库
   * （用户要发布的就是它），所以这一步不会让草稿里的视频失效。
   * 生成中的记录服务端会拒绝——后台的编排还在逐镜写回，删了只会看到"删掉了还在跑"。
   */
  /** 退出批量模式：把勾选一起清掉，不留"看不见的选中"。 */
  const exitBatch = useCallback(() => {
    setBatchMode(false)
    setBatchSelected([])
  }, [])

  /**
   * 批量删除勾选的记录。
   *
   * 生成中的那几条删不掉（服务端会跳过），这里如实把"删了几条、跳了几条"报出来，
   * 而不是一句"已删除"把跳过的那几条盖过去。
   */
  const handleBatchDelete = useCallback(async () => {
    if (batchSelected.length === 0) return
    const ok = await confirm({
      title: '批量删除生成记录',
      content: '只删掉选中的 ' + String(batchSelected.length) + ' 条记录（以及它们没用的中间文件），已经进草稿箱的成片不受影响。删除后不能恢复。',
      okText: '删除',
      cancelText: '取消',
    })
    if (ok !== true) return
    setBatchDeleting(true)
    try {
      const res = await deleteLongVideoTasks(batchSelected)
      if (res?.code !== 0) { toast.error(res?.message || '批量删除失败'); return }
      const { removed, skippedGenerating } = res.data
      // 正在看的这条也在里面：一起收起来，不然面板还停在一条已经不存在的任务上。
      if (task !== null && batchSelected.includes(task.id)) {
        stopPolling()
        setTask(null)
      }
      await refreshHistory()
      exitBatch()
      toast.success(skippedGenerating > 0
        ? '已删除 ' + String(removed) + ' 条；有 ' + String(skippedGenerating) + ' 条还在生成中，等它跑完再删'
        : '已删除 ' + String(removed) + ' 条记录')
    }
    finally {
      setBatchDeleting(false)
    }
  }, [batchSelected, exitBatch, refreshHistory, stopPolling, task])

  const handleDeleteRecord = useCallback(async (item: LongVideoTask) => {
    const ok = await confirm({
      title: '删除生成记录',
      content: '只删掉这一条记录（以及它没用的中间文件），已经进草稿箱的成片不受影响。删除后不能恢复。',
      okText: '删除',
      cancelText: '取消',
    })
    if (ok !== true) return
    setDeletingId(item.id)
    try {
      const res = await deleteLongVideoTask(item.id)
      if (res?.code !== 0) { toast.error(res?.message || '删除失败'); return }
      // 这一条正是面板上正在看的那条：一起收起来，不然面板还停在一条已经不存在的任务上。
      if (task?.id === item.id) {
        stopPolling()
        setTask(null)
      }
      await refreshHistory()
      toast.success('已删除这条记录')
    }
    finally {
      setDeletingId('')
    }
  }, [refreshHistory, stopPolling, task?.id])

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
      // 保活窗口内即使读到终态也继续轮询：那多半是回执后的旧状态，不是真的停下来了。
      if (next.status === 'generating' || Date.now() < pollHoldUntilRef.current) {
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

  /** 选产品图后立即上传：拿到素材 URL 才算选好——只留本地 objectURL，生成时后端读不到。 */
  const handlePickProductImage = useCallback(async (files: FileList | null) => {
    const file = files?.[0]
    if (file === undefined) return
    if (!file.type.startsWith('image/')) {
      toast.warning('产品图需要一张图片（建议正面清晰的产品照片）')
      return
    }
    setUploadingProduct(true)
    try {
      const url = await uploadToOss(file)
      setProductImageUrl(url)
      toast.success('产品图已就绪：产品镜会以它为主体')
    }
    catch (error) {
      toast.error('产品图上传失败：' + (error instanceof Error ? error.message : '未知错误'))
    }
    finally {
      setUploadingProduct(false)
    }
  }, [])

  /**
   * 目标时长 / 内容形式变了就重算字数门槛。
   *
   * 数字人没选定时不发请求：后端要靠 producerRef 才能定下这条内容形式的语速口径，
   * 拿默认口径算出来的数会被用户当成承诺（"按它写的还是被拒"）。
   */
  useEffect(() => {
    if (needsHuman && humanId === '') { setScriptNeed(null); return undefined }
    let cancelled = false
    void (async () => {
      const res = await getScriptRequirement({
        producer,
        ...(humanId !== '' ? { producerRef: humanId } : {}),
        ...(productImageUrl !== '' ? { productImageUrl } : {}),
        targetSeconds,
      })
      if (cancelled) return
      setScriptNeed(res?.code === 0 ? (res.data ?? null) : null)
    })()
    return () => { cancelled = true }
  }, [producer, needsHuman, humanId, productImageUrl, targetSeconds])

  /**
   * 一键补写：只扩写稿件并落盘，不出片。
   *
   * 补写会换掉稿件内容，所以结果直接回填到记录里让用户先看；满意了再点「继续生成」——
   * 那条路径按已定稿的稿件排分镜，不会把刚补的字再重写一遍。
   */
  const handleExtendScript = useCallback(async (taskId: string) => {
    setExtendingId(taskId)
    try {
      const res = await extendLongVideoScript(taskId)
      if (res?.code !== 0) { toast.error(res?.message || '补写失败'); return }
      const chars = res?.data?.chars ?? 0
      const required = res?.data?.required ?? 0
      toast.success('已补写到 ' + String(chars) + ' 字（门槛 ' + String(required) + ' 字），确认无误后点「继续生成」')
      await refreshHistory()
      const fresh = await getLongVideoTask(taskId)
      if (fresh?.code === 0 && fresh.data !== undefined) setTask(fresh.data)
    }
    finally {
      setExtendingId('')
    }
  }, [refreshHistory])
  /**
   * 重做某一镜：只重跑这一镜，然后把整条重新拼一遍。
   *
   * 为什么要重拼：成片是各镜按顺序拼出来的，换了其中一镜就必须重新拼接——
   * 界面上因此如实提示"要等一会儿"，不假装点一下就换好了。
   */
  const handleRedoShot = useCallback(async (index: number) => {
    if (task === null) return
    setRedoingShot(index)
    try {
      const res = await redoLongVideoShot(task.id, index)
      if (res?.code !== 0) { toast.error(res?.message || '重做这一镜失败'); return }
      toast.success('这一镜已重做，正在重新拼接整条')
      poll(task.id)
    }
    finally {
      setRedoingShot(null)
    }
  }, [task, poll])

  /**
   * 从断点继续：只跑还没跑成的镜。
   *
   * 与"重做某一镜"的区别：重做是某一镜不满意要换一版，续跑是这条片还没跑完——
   * 已跑成的镜原样保留，厂商调用只花在没跑成的那几镜上。
   */
  const handleResume = useCallback(async () => {
    if (task === null) return
    setResuming(true)
    try {
      const res = await resumeLongVideoTask(task.id)
      if (res?.code !== 0) { toast.error(res?.message || '继续生成失败'); return }
      const remaining = res?.data?.remaining ?? 0
      setEstimate(res?.data?.estimate ?? null)
      toast.success('已从断点继续：还要生成 ' + String(remaining) + ' 镜，已跑成的镜原样保留')
      // 续跑是异步回执：本地状态先回到"生成中"，并给轮询一个保活窗口，
      // 否则紧接着读到的旧状态会让进度面板停在失败态不动。
      pollHoldUntilRef.current = Date.now() + POLL_INTERVAL_MS * 3
      setTask(previous => previous === null ? previous : { ...previous, status: 'generating', errorMessage: '' })
      poll(task.id)
    }
    finally {
      setResuming(false)
    }
  }, [task, poll])

  /**
   * 停止正在生成的任务。
   *
   * 停止是为了**不再花额度**，不是为了作废这条片：已经跑成的镜留在记录里，
   * 所以停完随时能走「从断点继续」。
   */
  const handleStopTask = useCallback(async (item: LongVideoTask) => {
    setStopping(true)
    try {
      const res = await stopLongVideoTask(item.id)
      if (res?.code !== 0) { toast.error(res?.message || '停止失败'); return }
      toast.success('已停止：已经跑成的镜保留着，随时可以「从断点继续」')
      await refreshHistory()
      if (task !== null && task.id === item.id) poll(item.id)
    }
    finally {
      setStopping(false)
    }
  }, [task, poll, refreshHistory])

  const handleStart = useCallback(async () => {
    if (topic.trim() === '') { toast.warning('先写清楚要讲的产品与卖点'); return }
    if (needsHuman && humanId === '') {
      toast.warning('这个内容形式要出镜：先在下面选一个数字人形象（没有就去「我的数字人」建一个）')
      return
    }
    setStarting(true)
    try {
      const res = await startLongVideo({
        producer,
        ...(needsHuman ? { producerRef: humanId } : {}),
        topic: topic.trim(),
        // 本板块只做长片：旧链接/旧状态带来的短视频档位在这里就地抬到下限，不给后端送短时长。
        targetSeconds: Math.max(MIN_LONG_VIDEO_SECONDS, targetSeconds),
        aspectRatio,
        withSubtitles,
        resolution: LONG_VIDEO_RESOLUTION,
        // 可选：传了产品图，产品镜就以真实产品为主体（不传则退化为纯描述）。
        ...(productImageUrl !== '' ? { productImageUrl } : {}),
      })
      if (res?.code !== 0) { toast.error(res?.message || '创建任务失败'); return }
      const taskId = res?.data?.taskId ?? ''
      setEstimate(res?.data?.estimate ?? null)
      setTask({
        id: taskId,
        producer,
        topic: topic.trim(),
        targetSeconds,
        aspectRatio,
        withSubtitles,
        resolution: LONG_VIDEO_RESOLUTION,
        status: 'generating',
        doneSegments: 0,
        totalSegments: 0,
        segments: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      await refreshHistory()
      // 起任务同样有"回执先到"的窗口：给轮询一点保活时间，避免读到旧状态就停。
      pollHoldUntilRef.current = Date.now() + POLL_INTERVAL_MS * 3
      poll(taskId)
    }
    finally {
      setStarting(false)
    }
  }, [topic, producer, needsHuman, humanId, targetSeconds, aspectRatio, withSubtitles, productImageUrl, poll, refreshHistory])

  const human = humans.find(item => item.id === humanId)
  const generating = task?.status === 'generating'
  /**
   * 这条片已经跑成几镜（有落盘成片的镜数）。
   *
   * 用它而不是 doneSegments：中断收尾之后 doneSegments 仍是中断前的口径，
   * 而"能不能接着跑"取决于盘上真的有几镜成片。两者不同时以文件为准。
   */
  const generatedShots = task === null ? 0 : Object.keys(task.shotFiles ?? {}).length
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
  // 母时钟量到的成片时长：逐镜还没跑完时它就是这条片的最终长度（配音驱动时间轴），
  // 比"累计已跑成镜数"更早、也更准地告诉用户"按这版稿子成片约多少秒"。
  const voicedSeconds = task?.voicedSeconds ?? 0

  return (
    <PageShell title="长视频创作">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          给出产品和卖点，剩下的交给系统：厂商单次只出 4~12 秒，长片自动分段生成再拼成整条。
          下面能看到真实进度、每一镜的真实时长与已等时间。几十秒的短视频请到「内容创作」做。
        </p>

        {/* 内容形式 */}
        <section className="rounded-2xl border bg-card p-5">
          <h2 className="mb-4 text-sm font-medium">内容形式</h2>
          {/* 三列而不是两列：七个选项排成三行而不是四行，卡片描述在一列 282px 的宽度下
              最多折三行（实测），区块高度从 466px 降到 398px，末行也不会只剩一个选项。 */}
          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
            {producers.map(item => (
              <button
                key={item.kind}
                type="button"
                data-testid={`long-video-producer-${item.kind}`}
                disabled={generating}
                onClick={() => setProducer(item.kind)}
                className={cn(
                  'flex items-start gap-3 rounded-xl border p-4 text-left transition-colors disabled:opacity-60',
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

        {/* 数字人选择（要出镜的形式都要：名单由后端的 needsHuman 决定） */}
        {needsHuman && (
          <section className="rounded-2xl border bg-card p-5">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-medium">选择数字人</h2>
                <p className="mt-1 text-xs text-muted-foreground">全片只有这一张脸：口播镜用它出镜，其余镜头不出现人物。</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => navigate('/digital-humans')}>
                <Plus className="mr-1 h-3.5 w-3.5" />新建数字人
              </Button>
            </div>
            {humans.length === 0
              ? (
                  <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
                    还没有数字人形象，先去「我的数字人」上传一张正面半身照或一段正面人像视频，并在那里选好念法。
                  </div>
                )
              : (
                  <div className="flex flex-wrap gap-4">
                    {humans.map(item => (
                      <button
                        key={item.id}
                        type="button"
                        data-testid={`long-video-human-${item.id}`}
                        disabled={generating}
                        onClick={() => setHumanId(item.id)}
                        className={cn(
                          'flex w-32 flex-col items-center gap-2 rounded-xl border p-2.5 transition-colors disabled:opacity-60',
                          humanId === item.id ? 'border-primary bg-primary/5' : 'hover:border-primary/40',
                        )}
                      >
                        <img src={item.avatarUrl} alt={item.name} className="h-28 w-24 rounded-lg object-cover" />
                        <span className="truncate text-xs">{item.name}</span>
                      </button>
                    ))}
                  </div>
                )}
          </section>
        )}

        {/* 卖点与参数 */}
        <section className="rounded-2xl border bg-card p-5">
          {/* ① 产品与卖点 */}
          <div className="flex flex-col gap-2">
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
              rows={4}
              maxLength={MAX_LONG_VIDEO_TOPIC_CHARS}
              disabled={generating}
              placeholder="例如：秋冬保湿面霜，主打干皮救急，今天直播间直降一百"
              onChange={event => setTopic(event.target.value)}
            />
            <p className="text-[11px] leading-5 text-muted-foreground">
              写得越具体越贴合。一句话也能用：点「专业提示词增强」会补上人群、场景、痛点与行动号召，
              不会替你编造成分或功效，结果回填到上面可以再改。
            </p>
            {topicLengthHint(topic.length) !== '' && (
              <p className="text-[11px] leading-5 text-amber-600" data-testid="long-video-topic-length">
                {topicLengthHint(topic.length)}
              </p>
            )}
          </div>

          {/* ② 参考素材（可选）：只放产品本身 */}
          <div className="mt-6 border-t border-border/60 pt-5">
            {/*
              可选产品图：不传也能出片，传了产品镜就会以真实产品为主体。刻意不做成必填。
              **只放产品本身**这条说明不是客套：画面拿它当首帧，放人像就会在成片里出现另一个人
              （用户实测踩过——产品图位放的是另一位数字人的形象照，整条片子每隔几镜换一张脸）。
            */}
            <div className="flex flex-wrap items-center gap-2">
              {/*
                选图入口 = 一个铺满按钮的透明 <input type="file">，用户点到的**就是**输入框本身。
                三层失败面因此全部消失：

                ① 不再有"按钮 + JS 去 click 隐藏输入框"——脚本合成点击依赖引用、文档归属与浏览器的
                   用户激活判定，任一不成立就是静默失败（用户实测："点了没反应，选择框都不弹"）；
                ② 不再依赖 <label> 的点击转发（那是浏览器行为，但中转环节仍然多一层）；
                ③ 输入框可见（只是透明），不落进"浏览器拒绝为 display:none / clip 元素开框"的灰区。

                按钮外观由下面的 <span> 负责；挡住它的 input 只负责收点击、被键盘聚焦与读屏识别。
                生成中/上传中把 input 直接 disabled，并把原因**写成看得见的文字**——上一版只放在
                title 里，鼠标不悬停就看不到，用户看到的仍然是"点了没反应"。
              */}
              <span className="relative inline-flex">
                <span
                  aria-hidden="true"
                  className={cn(
                    buttonVariants({ variant: 'outline', size: 'sm' }),
                    (uploadingProduct || generating) && 'opacity-50',
                  )}
                >
                  {uploadingProduct
                    ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    : <ImagePlus className="mr-1 h-3.5 w-3.5" />}
                  {productImageUrl === '' ? '加产品图（可选）' : '换一张产品图'}
                </span>
                <input
                  id="lv-product-image"
                  ref={productInputRef}
                  type="file"
                  accept="image/*"
                  disabled={uploadingProduct || generating}
                  title={uploadingProduct ? '产品图上传中…' : (generating ? '正在生成，等这一条跑完再换产品图' : '选一张产品照片（只放产品本身）')}
                  // 视觉层是 aria-hidden 的装饰 <span>，所以名字必须给到输入框本身：
                  // 从 <label> 换成覆盖式 input 会丢掉关联，读屏软件只会念出浏览器的默认名"选择文件"。
                  aria-label={productImageUrl === '' ? '加产品图（可选）' : '换一张产品图'}
                  data-testid="long-video-product-image-pick"
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
                  onClick={() => setAwaitingPicker(true)}
                  onChange={(event) => {
                    setAwaitingPicker(false)
                    void handlePickProductImage(event.target.files)
                  }}
                />
              </span>
              <span className="text-[11px] text-muted-foreground">
                {awaitingPicker
                  ? '已在等系统选择框…如果一直没弹出来，刷新页面后重试'
                  : uploadingProduct
                    ? '产品图上传中…'
                    : (generating
                        ? '正在生成，等这一条跑完再换产品图'
                        : '只放产品本身，别放人像——画面会拿它当首帧。不传也能生成。')}
              </span>
              {productImageUrl !== '' && (
                <>
                  <img
                    src={productImageUrl}
                    alt="产品图"
                    data-testid="long-video-product-image-preview"
                    className="h-10 w-10 rounded-md border object-cover"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-testid="long-video-product-image-clear"
                    disabled={generating}
                    onClick={() => {
                      setProductImageUrl('')
                      if (productInputRef.current) productInputRef.current.value = ''
                    }}
                  >
                    移除
                  </Button>
                </>
              )}
            </div>
          </div>

          {/* ③ 生成参数 */}
          <div className="mt-7 space-y-6 border-t border-border/60 pt-6">
            <div className="flex flex-wrap gap-x-10 gap-y-5">
              <div className="flex flex-col gap-2">
                <Label>目标时长</Label>
                {scriptNeed !== null && (
                  <span className="text-xs text-muted-foreground" data-testid="long-video-script-need">
                    这条片要 {scriptNeed.requiredChars} 字口播稿（{scriptNeed.charsPerSecond} 字/秒 × {scriptNeed.targetSeconds} 秒，约 {scriptNeed.shots} 镜）；
                    不够时后端会自动补写 3 轮，仍不够就停在这一步、不花厂商额度
                  </span>
                )}
                {briefHint.text !== '' && (
                  <span
                    className={cn('text-xs', briefHint.meets ? 'text-muted-foreground' : 'text-amber-600')}
                    data-testid="long-video-brief-hint"
                  >
                    {briefHint.text}
                  </span>
                )}
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
                      {seconds >= 60 && seconds % 60 === 0 ? `${seconds / 60} 分钟` : `${seconds} 秒`}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="flex flex-col gap-2">
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

            {/*
              画面字幕单独占一行：它是"开关 + 一句说明"，与上面两组"选一个档位"不是同一类控件。
              挤在档位按钮底下时，标签紧贴按钮（用户报障截图），既看不清归属也点不准。
            */}
            <div className="flex flex-col gap-2 border-t border-border/40 pt-4">
              <Label htmlFor="lv-subs" className="cursor-pointer">画面字幕</Label>
              <div className="flex items-center gap-2.5">
                <Switch
                  id="lv-subs"
                  data-testid="long-video-subtitles"
                  checked={withSubtitles}
                  disabled={generating}
                  onCheckedChange={setWithSubtitles}
                />
                <span className="text-xs text-muted-foreground">把口播文本压进画面，静音刷到也看得懂</span>
              </div>
            </div>
          </div>

          {/* ④ 预估 + 开始生成 */}
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-5">
            {/* 预估：点了之前就知道要跑几镜、大约等多久（量级，不是承诺）。 */}
            {estimate !== null && !generating
              ? (
                  <p className="text-xs text-muted-foreground" data-testid="long-video-estimate">
                    预计 {estimate.shots} 镜、调用厂商 {estimate.callsMin} 次，约 {estimate.minutesMin}~
                    {estimate.minutesMax} 分钟（量级预估，真实进度以逐镜回报为准）。
                  </p>
                )
              : <span className="text-xs text-muted-foreground">一次生成一整条：写稿 → 排分镜 → 逐镜生成 → 拼接</span>}
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
                <span data-testid="long-video-script-chars">稿件 {task.scriptChars} 字（不含标点）</span>
              )}
              {voicedSeconds > 0 && (
                <span data-testid="long-video-voiced">
                  按这版稿子成片约 {voicedSeconds.toFixed(1)} 秒 / 目标 {task.targetSeconds} 秒
                </span>
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

            {/* 分镜预览：每一镜的类型、内容与真实时长，并可单独重做（不必整条重跑）。 */}
            {task.segments.length > 0 && (
              <ol className="mb-3 flex max-h-80 flex-col gap-1.5 overflow-y-auto" data-testid="long-video-shots">
                {task.segments.map((segment, index) => {
                  const shot = task.shots?.find(item => item.index === index)
                  const done = index < task.doneSegments
                  const failed = shot?.status === 'failed'
                  return (
                    <li key={segment.index} className="flex items-start gap-2 text-xs">
                      <span className={cn(
                        'mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-full text-[10px]',
                        done ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                      )}
                      >
                        {index + 1}
                      </span>
                      {shot !== undefined && (
                        <span
                          data-testid={`long-video-shot-kind-${index}`}
                          className={cn(
                            'mt-0.5 flex-none rounded px-1 text-[10px]',
                            shot.kind === 'product' ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground',
                          )}
                        >
                          {SHOT_KIND_TEXT[shot.kind] ?? shot.kind}
                        </span>
                      )}
                      {/* 节拍：让用户看得出这一镜在整条片里承担什么（钩子/痛点/卖点/号召）。 */}
                      {shot?.beat !== undefined && (
                        <span
                          data-testid={`long-video-shot-beat-${index}`}
                          className="mt-0.5 flex-none rounded bg-muted px-1 text-[10px] text-muted-foreground"
                        >
                          {BEAT_TEXT[shot.beat] ?? shot.beat}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 text-muted-foreground">
                        {segment.text !== '' ? segment.text : (shot?.visual ?? '')}
                      </span>
                      <span className="flex-none tabular-nums text-muted-foreground">
                        {done ? (segment.audioSeconds > 0 ? `${segment.audioSeconds.toFixed(1)}s` : '—') : '等待中'}
                      </span>
                      {/* 只有跑完的镜才给重做：还没生成的重做没有意义。 */}
                      {done && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-5 flex-none px-1 text-[11px]"
                          data-testid={`long-video-shot-redo-${index}`}
                          disabled={redoingShot !== null || generating}
                          onClick={() => void handleRedoShot(index)}
                        >
                          {redoingShot === index
                            ? <Loader2 className="h-3 w-3 animate-spin" />
                            : <RefreshCw className="h-3 w-3" />}
                          <span className="ml-0.5">重做</span>
                        </Button>
                      )}
                      {failed && shot?.errorMessage !== undefined && (
                        <span className="flex-none text-destructive">{shot.errorMessage}</span>
                      )}
                    </li>
                  )
                })}
              </ol>
            )}

            {task.status === 'failed' && (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-destructive" data-testid="long-video-error">{task.errorMessage}</p>
                {/*
                  稿件字数不足：这一步一分钱额度都没花，缺的只是字。
                  把"写了多少 / 差多少"如实摆出来，并给一键补写；补完确认再继续生成。
                */}
                {task.errorCode === 'script-too-short' && (
                  <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-muted/30 p-3">
                    <span className="text-xs text-muted-foreground" data-testid="long-video-script-gap">
                      当前稿件 {task.scriptChars ?? 0} 字（不含标点），目标 {task.targetSeconds} 秒
                    </span>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        data-testid="long-video-extend-script"
                        disabled={extendingId === task.id}
                        onClick={() => void handleExtendScript(task.id)}
                      >
                        {extendingId === task.id ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Wand2 className="mr-1 h-3 w-3" />}
                        补写稿件（把卖点写细）
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        data-testid="long-video-resume-script"
                        disabled={resuming}
                        onClick={() => void handleResume()}
                      >
                        {resuming ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Play className="mr-1 h-3 w-3" />}
                        按现有稿件继续生成
                      </Button>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      补写只改稿件、不出片；稿件达标后点右边那条才会开始逐镜生成。
                    </span>
                  </div>
                )}
                {/* 已经花掉的厂商调用不能白花：有跑成的镜就给"从断点继续"这条出口。 */}
                {generatedShots > 0 && (
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      data-testid="long-video-resume"
                      disabled={resuming}
                      onClick={() => void handleResume()}
                    >
                      {resuming ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Play className="mr-1 h-3 w-3" />}
                      从断点继续（已生成 {generatedShots} 镜）
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      只重跑没跑成的镜，已生成的 {generatedShots} 镜原样保留
                    </span>
                  </div>
                )}
              </div>
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
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  每段要跑一次厂商生成（约 {SEGMENT_MINUTES_MIN}~{SEGMENT_MINUTES_MAX} 分钟），
                  {producerInfo?.name ?? ''}的成片会自动拼接成整条。
                  可以先去忙别的：任务在后端继续跑，这一页的「生成记录」随时能回来接着看。
                </p>
                {/* 停止：一镜要 1~5 分钟，选题写错了就该有个出口，而不是眼看着额度被跑完。 */}
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="long-video-stop"
                  disabled={stopping}
                  title="停止后不再向厂商下单；已经跑成的镜保留着，可以「从断点继续」"
                  onClick={() => void handleStopTask(task)}
                >
                  {stopping
                    ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    : <Square className="mr-1 h-3.5 w-3.5" />}
                  停止生成
                </Button>
              </div>
            )}
          </section>
        )}

        {/* 生成记录 */}
        <section data-testid="long-video-history">
          <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-2">
            <History className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-medium">生成记录</h2>
            <span className="text-xs text-muted-foreground">
              {history.length > HISTORY_LIMIT
                ? '共 ' + String(history.length) + ' 条，进行中的也在里面'
                : '最近 ' + String(HISTORY_LIMIT) + ' 条，进行中的也在里面'}
            </span>
            {history.length > 0 && (
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {batchMode
                  ? (
                      <>
                        <span className="text-xs text-muted-foreground" data-testid="long-video-batch-count">
                          已选 {batchSelected.length} 条
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          data-testid="long-video-batch-all"
                          onClick={() => {
                            const deletable = history.filter(item => item.status !== 'generating').map(item => item.id)
                            setBatchSelected(current => (current.length === deletable.length ? [] : deletable))
                          }}
                        >
                          全选可删的
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          data-testid="long-video-batch-delete"
                          disabled={batchSelected.length === 0 || batchDeleting}
                          onClick={() => void handleBatchDelete()}
                        >
                          {batchDeleting
                            ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                            : <Trash2 className="mr-1 h-3.5 w-3.5" />}
                          删除选中
                        </Button>
                        <Button type="button" variant="ghost" size="sm" onClick={exitBatch}>取消</Button>
                      </>
                    )
                  : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        data-testid="long-video-batch-enter"
                        onClick={() => setBatchMode(true)}
                      >
                        批量管理
                      </Button>
                    )}
              </div>
            )}
          </div>
          {history.length === 0
            ? (
                <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
                  还没有长视频记录。填好产品与卖点，点「开始生成」，这里会出现第一条。
                </div>
              )
            : (
                <ul className="flex flex-col gap-2">
                  {(showAllRecords ? history : history.slice(0, HISTORY_LIMIT)).map(item => (
                    <li
                      key={item.id}
                      data-testid={`long-video-history-item-${item.id}`}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border bg-card px-3 py-2"
                    >
                      {batchMode && (
                        <Checkbox
                          data-testid={`long-video-history-select-${item.id}`}
                          className="flex-none"
                          disabled={item.status === 'generating'}
                          title={item.status === 'generating' ? '生成中的记录不能删' : '选中这一条'}
                          checked={batchSelected.includes(item.id)}
                          onCheckedChange={checked => {
                            setBatchSelected(current => (checked === true
                              ? [...current, item.id]
                              : current.filter(id => id !== item.id)))
                          }}
                        />
                      )}
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
                      {!batchMode && item.status === 'generating' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="flex-none text-muted-foreground hover:text-foreground"
                        data-testid={'long-video-history-stop-' + item.id}
                        disabled={stopping}
                        title="停止生成：已经跑成的镜保留着，之后可以「从断点继续」"
                        onClick={() => void handleStopTask(item)}
                      >
                        {stopping
                          ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                          : <Square className="mr-1 h-3.5 w-3.5" />}
                        停止
                      </Button>
                      )}
                      {!batchMode && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="flex-none text-muted-foreground hover:text-destructive"
                        data-testid={`long-video-history-delete-${item.id}`}
                        disabled={item.status === 'generating' || deletingId === item.id}
                        title={item.status === 'generating' ? '生成中不能删，等它跑完' : '删除这条记录'}
                        onClick={() => void handleDeleteRecord(item)}
                      >
                        {deletingId === item.id
                          ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                          : <Trash2 className="mr-1 h-3.5 w-3.5" />}
                        删除
                      </Button>
                      )}
                    </li>
                  ))}
                  {history.length > HISTORY_LIMIT && (
                    <li>
                      <button
                        type="button"
                        data-testid="long-video-history-toggle"
                        className="w-full cursor-pointer rounded-xl border border-dashed px-3 py-2 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                        onClick={() => setShowAllRecords(value => !value)}
                      >
                        {showAllRecords
                          ? '收起，只看最近 ' + String(HISTORY_LIMIT) + ' 条'
                          : '展开全部 ' + String(history.length) + ' 条（每条都能删）'}
                      </button>
                    </li>
                  )}
                </ul>
              )}
        </section>
      </div>
    </PageShell>
  )
}
