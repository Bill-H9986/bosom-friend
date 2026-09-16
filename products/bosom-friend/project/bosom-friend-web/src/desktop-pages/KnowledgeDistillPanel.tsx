/**
 * KnowledgeDistillPanel - 知识库「蒸馏」页签
 *
 * 展示知识库被模型真正用上的证据与可导出的微调数据集：
 *  - 注入统计：命中过知识注入的生成次数、平均评分；
 *  - 注入预览：输入一句话，看这次会命中哪些笔记（可验证检索是否真的有效）；
 *  - 样本列表：指令 → 输出，带来源笔记、模型与评分；
 *  - 导出 JSONL：OpenAI 微调兼容的 messages 结构 + 元数据，可直接用于微调 / 少样本。
 */
'use client'

import { useCallback, useEffect, useState } from 'react'
import { Download, Eye, Sparkles, Star } from 'lucide-react'
import { Button } from '@web/components/ui/button'
import { Input } from '@web/components/ui/input'
import { cn } from '@web/utils/className'
import http from '@web/utils/request'
import { toast } from '@web/utils/ui/toast'

interface DistillStats {
  total: number
  success: number
  injected: number
  rated: number
  avgRating: number
  notes: number
  injectedCount: number
  taskBreakdown: { task: string, count: number }[]
}

interface DistillSample {
  id: string
  task: string
  instruction: string
  output: string
  model: string
  knowledgePaths: string[]
  rating: number
  createdAt: string
}

interface InjectPreview {
  paths: string[]
  chars: number
  block: string
}

const TASK_LABEL: Record<string, string> = {
  video: '短视频脚本',
  'image-text': '图文笔记',
  chat: '对话',
}

/** 后端基址与本地访客 token 由 index.html 注入，导出走原生 fetch 以拿到文件流。 */
function apiBase(): string {
  return (window as unknown as { __BACKEND_BASE_URL__?: string }).__BACKEND_BASE_URL__ || '/bosom-friend/api'
}

function authToken(): string {
  return (window as unknown as { __ZHIYIN_AUTH_TOKEN__?: string }).__ZHIYIN_AUTH_TOKEN__ || ''
}

export default function KnowledgeDistillPanel() {
  const [stats, setStats] = useState<DistillStats | null>(null)
  const [samples, setSamples] = useState<DistillSample[]>([])
  const [task, setTask] = useState('')
  const [query, setQuery] = useState('')
  const [preview, setPreview] = useState<InjectPreview | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const statsRes = await http.get<DistillStats>('knowledge/distill/stats', undefined, true)
    setStats(statsRes?.data ?? null)
    const listRes = await http.get<{ list: DistillSample[] }>('knowledge/distill/dataset', { task, limit: 50 }, true)
    setSamples(listRes?.data?.list ?? [])
  }, [task])

  useEffect(() => { void load() }, [load])

  const runPreview = useCallback(async () => {
    if (query.trim() === '') {
      toast.error('先输入一句话，再看会命中哪些笔记')
      return
    }
    const res = await http.post<InjectPreview>('knowledge/inject-preview', { query }, true)
    setPreview(res?.data ?? null)
  }, [query])

  const rate = useCallback(async (id: string, rating: number) => {
    await http.post('knowledge/distill/rate', { id, rating }, true)
    await load()
  }, [load])

  const exportJsonl = useCallback(async () => {
    setBusy(true)
    try {
      const url = apiBase() + '/knowledge/distill/export' + (task === '' ? '' : '?task=' + encodeURIComponent(task))
      const response = await fetch(url, { headers: { authorization: 'Bearer ' + authToken() } })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      const blob = await response.blob()
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = 'bosom-friend-distill' + (task === '' ? '' : '-' + task) + '.jsonl'
      link.click()
      URL.revokeObjectURL(link.href)
      toast.success('已导出 ' + samples.length + ' 条微调样本')
    }
    catch (error) {
      toast.error('导出失败：' + (error instanceof Error ? error.message : String(error)))
    }
    finally { setBusy(false) }
  }, [task, samples.length])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-4">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" />
          <span className="text-sm font-medium text-foreground">知识蒸馏</span>
          <span className="text-xs text-muted-foreground">知识库被模型用上的证据，以及可直接微调的样本</span>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={task}
            onChange={e => setTask(e.target.value)}
            className="h-8 rounded-lg border border-border/60 bg-background px-2 text-xs text-foreground cursor-pointer"
          >
            <option value="">全部任务</option>
            <option value="video">短视频脚本</option>
            <option value="image-text">图文笔记</option>
            <option value="chat">对话</option>
          </select>
          <Button size="sm" className="h-8 cursor-pointer text-sm" disabled={busy} onClick={() => void exportJsonl()}>
            <Download className="size-3.5" />
            导出 JSONL
          </Button>
        </div>
      </header>

      <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-5">
        {[
          // stats 为 null = 还没取到数据（未加载或请求失败），此时显示 0
          // 等于告诉用户「一个样本都没有」。与下面「平均评分」一致用 — 表示无结论。
          { label: '蒸馏样本', value: stats === null ? '—' : stats.total },
          { label: '成功样本', value: stats === null ? '—' : stats.success },
          { label: '命中知识注入', value: stats === null ? '—' : stats.injectedCount },
          { label: '知识笔记', value: stats === null ? '—' : stats.notes },
          { label: '平均评分', value: stats === null || stats.avgRating === 0 ? '—' : stats.avgRating.toFixed(1) },
        ].map(item => (
          <div key={item.label} className="rounded-xl border border-border/60 bg-card px-3 py-2">
            <p className="text-lg font-semibold text-foreground">{item.value}</p>
            <p className="text-xs text-muted-foreground">{item.label}</p>
          </div>
        ))}
      </div>

      <section className="mb-3 rounded-xl border border-border/60 bg-card p-3">
        <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-foreground">
          <Eye className="size-3.5 text-primary" />
          注入预览：这句话会命中哪些知识笔记
        </p>
        <div className="flex gap-2">
          <Input
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void runPreview() }}
            placeholder="例如：写一条重庆夜景的抖音口播脚本"
            className="text-sm"
          />
          <Button size="sm" className="h-8 shrink-0 cursor-pointer text-sm" onClick={() => void runPreview()}>
            预览
          </Button>
        </div>
        {preview !== null && (
          <div className="mt-2 text-xs text-muted-foreground">
            {preview.paths.length === 0
              ? <p>没有命中任何笔记——写一条相关笔记后，生成时就会自动带上它。</p>
              : (
                  <>
                    <p className="mb-1">命中 {preview.paths.length} 篇（{preview.chars} 字）：{preview.paths.join('、')}</p>
                    <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted/60 p-2 text-[11px] leading-5 text-foreground/80">{preview.block}</pre>
                  </>
                )}
          </div>
        )}
      </section>

      <section className="flex min-h-0 flex-1 flex-col gap-2">
        {samples.length === 0 && (
          <p className="rounded-xl border border-dashed border-border/60 px-3 py-8 text-center text-xs text-muted-foreground">
            还没有蒸馏样本。去「内容创作」生成一次草稿，或和 AI 助手聊一句，这里就会出现可微调的「指令 → 输出」记录。
          </p>
        )}
        {samples.map(sample => (
          <article key={sample.id} className="rounded-xl border border-border/60 bg-card p-3">
            <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="rounded-md bg-primary/10 px-1.5 py-0.5 font-medium text-primary">{TASK_LABEL[sample.task] ?? sample.task}</span>
              <span>{sample.model}</span>
              <span>{sample.createdAt.slice(0, 16).replace('T', ' ')}</span>
              {sample.knowledgePaths.length > 0
                ? <span className="rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-emerald-600">注入 {sample.knowledgePaths.length} 篇知识</span>
                : <span>未命中知识</span>}
              <span className="ml-auto flex items-center gap-0.5">
                {[1, 2, 3, 4, 5].map(star => (
                  <button
                    key={star}
                    type="button"
                    onClick={() => void rate(sample.id, sample.rating === star ? 0 : star)}
                    className="cursor-pointer"
                    aria-label={`评 ${star} 分`}
                  >
                    <Star className={cn('size-3.5', star <= sample.rating ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/50')} />
                  </button>
                ))}
              </span>
            </div>
            <p className="mb-1 line-clamp-2 text-sm text-foreground">{sample.instruction}</p>
            <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted/60 p-2 text-[11px] leading-5 text-foreground/80">{sample.output || '（无输出）'}</pre>
            {sample.knowledgePaths.length > 0 && (
              <p className="mt-1 truncate text-[11px] text-muted-foreground">来源笔记：{sample.knowledgePaths.join('、')}</p>
            )}
          </article>
        ))}
      </section>
    </div>
  )
}
