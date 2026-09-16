'use client'

import {
  Download,
  Heart,
  Loader2,
  MessageCircle,
  MessageCircleMore,
  RotateCcw,
  Search,
  Sparkles,
  Star,
} from 'lucide-react'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import DateRangePicker from '@web/components/ui/date-range-picker'
import { useTransClient } from '@web/app/i18n/client'
import { PageShell } from '@web/app/layout/PageShell'
import { Avatar, AvatarFallback, AvatarImage } from '@web/components/ui/avatar'
import { Badge } from '@web/components/ui/badge'
import { Button } from '@web/components/ui/button'
import { EmptyState } from '@web/components/common/EmptyState'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/dialog'
import { Input } from '@web/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@web/components/ui/select'
import { Skeleton } from '@web/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@web/components/ui/tabs'
import { cn } from '@web/utils/className'
import { toast } from '@web/utils/ui/toast'
import {
  agentCollectNotes,
  getCommentMentStats,
  getNoteAnalyse,
  getNoteComments,
  getNoteHotWords,
  getNoteSearchOptions,
  getNoteSimpleInfo,
  resolveNoteUrl,
  searchNotes,
} from './api'
import type { NoteComment, NoteSearchOptions, SampleNote } from './api'
import { HotContentClient } from '../hot-content/HotContentClient'
import { getHotContentFeed } from '../hot-content/api'

/**
 * 本地默认筛选项：后端筛选项接口不可用时兜底，保证页面可用（免费平台无积分逻辑）
 */
const FALLBACK_OPTIONS: NoteSearchOptions = {
  noteTypes: [
    { Value: 1, Label: '视频笔记' },
    { Value: 2, Label: '图文笔记' },
  ],
  bloggerProps: [
    { Value: 1, Label: '达人' },
    { Value: 2, Label: '品牌号' },
    { Value: 3, Label: '素人' },
  ],
  sortOptions: [
    { Value: 1, Label: '互动量最高' },
    { Value: 2, Label: '点赞最多' },
    { Value: 3, Label: '收藏最多' },
    { Value: 4, Label: '评论最多' },
    { Value: 5, Label: '分享最多' },
    { Value: 6, Label: '最新发布' },
  ],
  noteTags: [
    {
      Id: 'tag-food',
      Name: '美食',
      Children: [
        { Id: 'tag-food-1', Name: '探店打卡' },
        { Id: 'tag-food-2', Name: '家常菜谱' },
        { Id: 'tag-food-3', Name: '零食测评' },
      ],
    },
    {
      Id: 'tag-travel',
      Name: '旅行',
      Children: [
        { Id: 'tag-travel-1', Name: '旅行攻略' },
        { Id: 'tag-travel-2', Name: '周边游' },
      ],
    },
    {
      Id: 'tag-fashion',
      Name: '时尚穿搭',
      Children: [
        { Id: 'tag-fashion-1', Name: '日常穿搭' },
        { Id: 'tag-fashion-2', Name: '平价好物' },
      ],
    },
    {
      Id: 'tag-beauty',
      Name: '护肤美妆',
      Children: [
        { Id: 'tag-beauty-1', Name: '护肤心得' },
        { Id: 'tag-beauty-2', Name: '彩妆教程' },
      ],
    },
    { Id: 'tag-home', Name: '家居生活' },
    { Id: 'tag-digital', Name: '数码科技' },
    { Id: 'tag-pet', Name: '宠物' },
    { Id: 'tag-baby', Name: '母婴育儿' },
    { Id: 'tag-fitness', Name: '健身运动' },
    { Id: 'tag-career', Name: '职场成长' },
    { Id: 'tag-emotion', Name: '情感心理' },
    { Id: 'tag-movie', Name: '影视综艺' },
  ],
}

function Chip({ active, onClick, children }: {
  active?: boolean
  onClick?: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'btn btn-sm rounded-full',
        active
          ? 'btn-secondary border-primary/50 text-primary'
          : 'btn-outline text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

function NoteDetailDialog({ note, onClose, onReplied, initialTab = 'overview' }: {
  note: SampleNote
  onClose: () => void
  onReplied: () => void
  initialTab?: 'overview' | 'comments'
}) {
  const { t } = useTransClient('noteCommentSearch')
  const [tab, setTab] = useState<'overview' | 'comments'>(initialTab)
  const [simpleInfo, setSimpleInfo] = useState<Record<string, unknown>>({})
  const [analyse, setAnalyse] = useState<Record<string, unknown>>({})
  const [hotWords, setHotWords] = useState<Array<{ word: string; heat: number }>>([])
  const [mentStats, setMentStats] = useState<Array<{ value: string; label: string; count: number }>>([])
  const [comments, setComments] = useState<NoteComment[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    setTab('overview')
    Promise.allSettled([
      getNoteSimpleInfo(note.NoteIdKey),
      getNoteAnalyse(note.NoteIdKey),
      getNoteHotWords(note.NoteIdKey),
      getCommentMentStats(note.NoteIdKey),
      getNoteComments(note.NoteIdKey),
    ]).then((results) => {
      if (results[0].status === 'fulfilled')
        setSimpleInfo(results[0].value)
      if (results[1].status === 'fulfilled')
        setAnalyse(results[1].value)
      if (results[2].status === 'fulfilled') {
        const data = results[2].value as { list?: Array<{ word: string; heat: number }> }
        setHotWords(data.list || [])
      }
      if (results[3].status === 'fulfilled') {
        const data = results[3].value as { list?: Array<{ value: string; label: string; count: number }> }
        setMentStats(data.list || [])
      }
      if (results[4].status === 'fulfilled') {
        const data = results[4].value as { list: NoteComment[] }
        setComments(data.list || [])
      }
      setLoading(false)
    })
  }, [note.NoteIdKey])

  const openOriginal = useCallback(async () => {
    try {
      const url = await resolveNoteUrl(note.NoteIdKey)
      if (url)
        window.open(url, '_blank', 'noopener,noreferrer')
      else
        toast.error(t('feedback.originalUnavailable'))
    }
    catch {
      toast.error(t('feedback.originalFailed'))
    }
  }, [note.NoteIdKey, t])

  const trend = (analyse.trend as Array<{ date: string; likes: number; favorites: number; comments: number; shares: number }>) || []
  const maxTrend = Math.max(1, ...trend.map(item => item.likes))

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-h-[90vh] w-[95vw] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircleMore className="size-5 text-brand-cyan" />
            {t('detail.panelTitle')}
          </DialogTitle>
          <DialogDescription className="line-clamp-2">
            {note.Title || t('results.untitled')}
            {' '}
            ·
            {' '}
            {note.BloggerNickName}
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(value) => setTab(value as 'overview' | 'comments')}>
          <TabsList>
            <TabsTrigger value="overview">{t('detail.tabs.overview')}</TabsTrigger>
            <TabsTrigger value="comments">{t('detail.tabs.comments')}</TabsTrigger>
          </TabsList>

          <div className="mt-4">
            {tab === 'overview' && (
              <div className="grid gap-4 lg:grid-cols-2">
                <section className="panel">
                  <h3 className="mb-3 text-sm font-semibold text-foreground">{t('detail.cards.noteInfo.title')}</h3>
                  {loading
                    ? <Skeleton className="h-32 w-full" />
                    : (
                        <div className="space-y-2 text-sm">
                          <InfoRow label={t('detail.cards.noteInfo.published')} value={note.PublishTime} />
                          <InfoRow label={t('detail.cards.noteInfo.noteType')} value={note.NoteTypeDesc} />
                          <InfoRow label={t('detail.cards.noteInfo.accountType')} value={String(simpleInfo.BlogLevelName ?? note.BloggerProp)} />
                          <InfoRow label={t('detail.cards.noteInfo.fans')} value={String(simpleInfo.Fans ?? '—')} />
                          <InfoRow label={t('detail.cards.noteInfo.noteCount')} value={String(simpleInfo.NoteCount ?? '—')} />
                          <div>
                            <span className="text-muted-foreground">{t('detail.cards.noteInfo.tags')}：</span>
                            <div className="mt-1 flex flex-wrap gap-1.5">
                              {note.Tags.length > 0
                                ? note.Tags.map(tag => <Badge key={tag} variant="secondary">{tag}</Badge>)
                                : <span className="text-muted-foreground">{t('detail.cards.noteInfo.empty')}</span>}
                            </div>
                          </div>
                        </div>
                      )}
                </section>

                <section className="panel">
                  <h3 className="mb-3 text-sm font-semibold text-foreground">{t('detail.cards.hotWords.title')}</h3>
                  {loading
                    ? <Skeleton className="h-32 w-full" />
                    : hotWords.length > 0
                      ? (
                          <div className="flex flex-wrap gap-2">
                            {hotWords.map(item => (
                              <Badge key={item.word} className="cursor-default" variant="outline">
                                {item.word}
                                <span className="ml-1 text-xs text-muted-foreground">{item.heat}</span>
                              </Badge>
                            ))}
                          </div>
                        )
                      : <p className="text-sm text-muted-foreground">{t('detail.cards.hotWords.empty')}</p>}
                </section>

                <section className="panel lg:col-span-2">
                  <h3 className="mb-3 text-sm font-semibold text-foreground">{t('detail.cards.trend.title')}</h3>
                  {loading
                    ? <Skeleton className="h-40 w-full" />
                    : trend.length > 0
                      ? (
                          <div className="space-y-2">
                            {trend.map(item => (
                              <div key={item.date} className="grid grid-cols-[90px_minmax(0,1fr)_96px] items-center gap-3 text-xs">
                                <span className="tabular-nums text-muted-foreground">{item.date.slice(5)}</span>
                                <div className="h-2 overflow-hidden rounded-full bg-muted">
                                  <div className="h-full rounded-full bg-primary" style={{ width: `${(item.likes / maxTrend) * 100}%` }} />
                                </div>
                                <span className="text-right tabular-nums text-foreground">赞 {item.likes}</span>
                              </div>
                            ))}
                          </div>
                        )
                      : <p className="text-sm text-muted-foreground">{t('detail.cards.trend.empty')}</p>}
                </section>

                <section className="panel lg:col-span-2">
                  <h3 className="mb-3 text-sm font-semibold text-foreground">{t('detail.cards.commentMent.title')}</h3>
                  {loading
                    ? <Skeleton className="h-24 w-full" />
                    : (
                        <div className="flex flex-wrap gap-2">
                          {mentStats.map(item => (
                            <Badge key={item.value} variant="secondary">
                              {item.label} {item.count}
                            </Badge>
                          ))}
                        </div>
                      )}
                </section>
              </div>
            )}

            {tab === 'comments' && (
              <div className="panel">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-foreground">{t('detail.cards.commentList.title')}</h3>
                  <Button variant="outline" size="sm" className="h-7 cursor-pointer text-xs" onClick={openOriginal}>
                    {t('results.openOriginal')}
                  </Button>
                </div>
                {loading
                  ? <Skeleton className="h-32 w-full" />
                  : comments.length > 0
                    ? (
                        <div className="flex flex-col gap-3">
                          {comments.map(comment => (
                            <div key={comment.CommentId} className="rounded-md bg-muted/40 p-3">
                              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <span className="font-medium text-foreground">{comment.NickName || t('detail.comments.authorUnknown')}</span>
                                <span>{comment.CreatedAt}</span>
                              </div>
                              <p className="mt-1 text-sm leading-6 text-foreground">{comment.Content}</p>
                              <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                                <Heart className="size-3" />
                                {comment.LikedCount}
                              </p>
                            </div>
                          ))}
                        </div>
                      )
                    : <p className="py-8 text-center text-sm text-muted-foreground">{t('detail.comments.empty')}</p>}
              </div>
            )}
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate font-medium text-foreground">{value}</span>
    </div>
  )
}

export function AiInteractionClient() {
  const { ready, t } = useTransClient('noteCommentSearch')
  const [activeTab, setActiveTab] = useState<'hot' | 'comment'>('hot')
  const [options, setOptions] = useState<NoteSearchOptions>({})
  const [keyword, setKeyword] = useState('')
  const [noteType, setNoteType] = useState<number>(0)
  const [bloggerProps, setBloggerProps] = useState<number[]>([])
  const [tags, setTags] = useState<string[]>([])
  const [childTags, setChildTags] = useState<string[]>([])
  const [days, setDays] = useState(7)
  const [startDate, setStartDate] = useState<string | null>(null)
  const [endDate, setEndDate] = useState<string | null>(null)
  const [sortType, setSortType] = useState(1)
  const [notes, setNotes] = useState<SampleNote[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const [selectedNote, setSelectedNote] = useState<SampleNote | null>(null)
  const [detailTab, setDetailTab] = useState<'overview' | 'comments'>('overview')
  const [exporting, setExporting] = useState(false)
  const [agentInsight, setAgentInsight] = useState('')
  const [collectingAgent, setCollectingAgent] = useState(false)
  const autoSearchedRef = useRef(false)

  useEffect(() => {
    if (ready) {
      getNoteSearchOptions()
        .then((opts) => {
          setOptions({
            ...FALLBACK_OPTIONS,
            ...opts,
            noteTypes: opts.noteTypes?.length ? opts.noteTypes : FALLBACK_OPTIONS.noteTypes,
            bloggerProps: opts.bloggerProps?.length ? opts.bloggerProps : FALLBACK_OPTIONS.bloggerProps,
            sortOptions: opts.sortOptions?.length ? opts.sortOptions : FALLBACK_OPTIONS.sortOptions,
          })
        })
        .catch(() => {
          // 筛选项接口不可用时使用本地默认项，不打断用户操作
          setOptions(FALLBACK_OPTIONS)
        })
    }
  }, [ready, t])

  const doSearch = useCallback(async (page = 1, overrideKeyword?: string) => {
    const kw = (overrideKeyword ?? keyword).trim()
    if (!kw) {
      toast.error(t('feedback.keywordRequired'))
      return
    }
    setLoading(true)
    try {
      const result = await searchNotes({
          keyword: kw,
        page,
        pageSize: 20,
        sorttype: sortType,
        days,
        starttime: days === -1 && startDate ? startDate : undefined,
        endtime: days === -1 && endDate ? endDate : undefined,
        notetags: tags,
        childtags: childTags,
        notetype: noteType || undefined,
        notbloggerprops: bloggerProps,
      })
        setNotes(result.list)
        setTotal(result.total)
        setSearched(true)
        // AI 全网采集：harness 自动收集热榜/全网内容，AgnesAI 分析整理后并入结果
        setCollectingAgent(true)
      agentCollectNotes(kw)
          .then((collected) => {
            if (collected.items?.length) {
              setNotes(prev => {
                const existing = new Set((prev || []).map(note => note.NoteIdKey))
                const agentItems = collected.items.filter(note => !existing.has(note.NoteIdKey))
                return [...(prev || []), ...agentItems]
              })
              setTotal(prev => prev + collected.items.length)
            }
            setAgentInsight(collected.insight || '')
          })
          .catch(() => {
            // AI 采集失败不影响本地搜索结果
          })
          .finally(() => setCollectingAgent(false))
      }
    catch {
      toast.error(t('feedback.searchFailed'))
    }
    finally {
      setLoading(false)
    }
  }, [bloggerProps, childTags, days, endDate, keyword, noteType, sortType, startDate, t, tags])

  // 进入「评论搜索」时自动用当前全网第一热点词触发搜索，避免页面空白
  useEffect(() => {
    if (!ready || activeTab !== 'comment' || autoSearchedRef.current)
      return
    autoSearchedRef.current = true
    getHotContentFeed('weibo:hot', 1)
      .then((feed) => {
        const hotTitle = feed?.items?.[0]?.title
        if (!hotTitle)
          return
        setKeyword(hotTitle)
        doSearch(1, hotTitle)
      })
      .catch(() => {
        // 热榜获取失败时保持空态，用户可手动输入搜索
      })
  }, [activeTab, doSearch, ready])

  const resetFilters = useCallback(() => {
    setKeyword('')
    setNoteType(0)
    setBloggerProps([])
    setTags([])
    setChildTags([])
    setDays(7)
    setStartDate(null)
    setEndDate(null)
    setSortType(1)
      setNotes([])
      setTotal(0)
      setSearched(false)
      setAgentInsight('')
      setCollectingAgent(false)
    }, [])

  const toggleTag = useCallback((id: string) => {
    setTags(prev => prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id])
    setChildTags([])
  }, [])

  const toggleChildTag = useCallback((id: string) => {
    setChildTags(prev => prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id])
  }, [])

  const selectedTagNames = useMemo(() => {
    const names = tags
      .map(id => options.noteTags?.find(tag => tag.Id === id)?.Name)
      .filter(Boolean)
    const children = childTags
      .map(id => options.noteTags?.flatMap(tag => tag.Children || []).find(child => child.Id === id)?.Name)
      .filter(Boolean)
    return [...names, ...children].join('、')
  }, [childTags, options.noteTags, tags])

  const activeChildTags = useMemo(
    () => options.noteTags?.filter(tag => tags.includes(tag.Id)).flatMap(tag => tag.Children || []) || [],
    [options.noteTags, tags],
  )

  /** 时间范围展示文案：与官网一致，始终显示当前生效区间 */
  const rangeText = useMemo(() => {
    const formatDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    if (days === -1)
      return `${startDate || '开始日期'} — ${endDate || '结束日期'}`
    const now = new Date()
    return `${formatDate(new Date(now.getTime() - days * 86400000))} — ${formatDate(now)}`
  }, [days, endDate, startDate])

  /** 客户端二次筛选：内容形式 + 笔记分类（对本地记录与 AI 采集结果统一生效） */
  const displayNotes = useMemo(() => {
    let list = notes
    if (noteType) {
      list = list.filter(note => note.NoteType === (noteType === 1 ? 'video' : 'image'))
    }
    const selectedTags = new Set([...tags, ...childTags])
    if (selectedTags.size > 0) {
      list = list.filter(note => (note.Tags || []).some(tag => selectedTags.has(tag)))
    }
    return list
  }, [childTags, noteType, notes, tags])

  /** 导出当前筛选条件下的搜索结果（最多 200 条）为 CSV，Excel 可直接打开 */
  const handleExport = useCallback(async () => {
    if (!searched || displayNotes.length === 0) {
      toast.error(t('feedback.keywordRequired'))
      return
    }
    setExporting(true)
    try {
      const rows = displayNotes
      const urls = await Promise.all(rows.map(note =>
        note.SourceUrl
          ? Promise.resolve(note.SourceUrl)
          : resolveNoteUrl(note.NoteIdKey).catch(() => ''),
      ))
      const esc = (value: string | number) => {
        const text = String(value ?? '')
        return `"${text.replace(/"/g, '""')}"`
      }
      const header = ['笔记内容', '发布者', '发布时间', '互动量', '点赞', '收藏', '评论', '分享', '原文链接']
      const lines = rows.map((note, index) => [
        note.Title || t('results.untitled'),
        note.BloggerNickName,
        note.PublishTime,
        note.CountDesc,
        note.LikedCountDesc,
        note.FavoritesCountDesc,
        note.CommentsCountDesc,
        note.ShareCountDesc,
        urls[index] || '',
      ].map(esc).join(','))
      const csv = `\uFEFF${header.map(esc).join(',')}\n${lines.join('\n')}`
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      const now = new Date()
      const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
      link.download = `Bosom Friend-评论搜索结果-${stamp}.csv`
      link.click()
      URL.revokeObjectURL(link.href)
      toast.success(t('export.feedback.created'))
    }
    catch {
      toast.error(t('export.feedback.createFailed'))
    }
    finally {
      setExporting(false)
    }
  }, [displayNotes, searched, t])

  /** 打开笔记原文链接 */
  /** 打开笔记原文链接：AI 采集结果直接用采集到的真实链接 */
  const openOriginal = useCallback(async (note: SampleNote) => {
    if (note.CollectedByAgent && !note.SourceUrl) {
      toast.warning('AI 采集结果暂无原文链接，暂无法打开')
      return
    }
    if (note.SourceUrl) {
      window.open(note.SourceUrl, '_blank', 'noopener,noreferrer')
      return
    }
    try {
      const url = await resolveNoteUrl(note.NoteIdKey)
      if (url)
        window.open(url, '_blank', 'noopener,noreferrer')
      else
        toast.error(t('feedback.originalUnavailable'))
    }
    catch {
      toast.error(t('feedback.originalFailed'))
    }
  }, [t])

  if (!ready)
    return <div className="min-h-full bg-muted/40" />

  return (
    <PageShell
      tabs={[
        { key: 'hot', label: '热点内容' },
        { key: 'comment', label: t('tabs.commentSearch') },
      ]}
      activeTab={activeTab}
      onTabChange={key => setActiveTab(key as 'hot' | 'comment')}
      contentClassName="bg-muted/40"
    >
      {activeTab === 'hot' && <HotContentClient />}
      {activeTab === 'comment' && (
      <div className="mx-auto w-full max-w-[1600px]">
        {/* 搜索栏 */}
        <div className="sticky top-0 z-20 mb-0">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                data-testid="xhs-data-note-comment-search-components-search-filters-input-1"
                value={keyword}
                onChange={event => setKeyword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter')
                    doSearch(1)
                }}
                placeholder={t('filters.keywordPlaceholder')}
                className="h-9 border-transparent bg-muted/60 pl-9 text-sm shadow-none hover:bg-muted focus-visible:bg-background"
              />
            </div>
            <div className="flex shrink-0 items-center justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('filters.reset')}
                className="size-8 cursor-pointer text-muted-foreground shadow-none"
                onClick={resetFilters}
              >
                <RotateCcw className="size-3.5" aria-hidden />
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={loading}
                className="h-8 cursor-pointer bg-gradient-back px-4 text-sm text-gradient-foreground shadow-sm shadow-primary/20 hover:shadow-md hover:shadow-primary/25"
                onClick={() => doSearch(1)}
              >
                {loading ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
                {t('filters.searchNote')}
              </Button>
            </div>
          </div>
        </div>

        {/* 筛选面板 */}
        <div className="panel">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="w-16 shrink-0 font-medium text-muted-foreground">{t('filters.contentFormat')}</span>
              <Chip active={noteType === 0} onClick={() => setNoteType(0)}>{t('filters.all')}</Chip>
              {(options.noteTypes || []).filter(item => item.Value !== 0).map(item => (
                <Chip key={item.Value} active={noteType === item.Value} onClick={() => setNoteType(item.Value)}>
                  {item.Label}
                </Chip>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="w-16 shrink-0 font-medium text-muted-foreground">{t('filters.authorType')}</span>
              {(options.bloggerProps || []).map(item => (
                <Chip
                  key={item.Value}
                  active={bloggerProps.includes(item.Value)}
                  onClick={() => setBloggerProps(prev => prev.includes(item.Value) ? prev.filter(v => v !== item.Value) : [...prev, item.Value])}
                >
                  {item.Label}
                </Chip>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="w-16 shrink-0 font-medium text-muted-foreground">{t('filters.noteCategory')}</span>
              {(options.noteTags || []).map(tag => (
                <Chip key={tag.Id} active={tags.includes(tag.Id)} onClick={() => toggleTag(tag.Id)}>
                  {tag.Name}
                </Chip>
              ))}
              {selectedTagNames && (
                <span className="ml-1 max-w-56 truncate text-muted-foreground">{selectedTagNames}</span>
              )}
            </div>
            {activeChildTags.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 pl-16 text-xs">
                <span className="text-muted-foreground">{t('filters.childCategoryTitle')}</span>
                {activeChildTags.map(child => (
                  <Chip key={child.Id} active={childTags.includes(child.Id)} onClick={() => toggleChildTag(child.Id)}>
                    {child.Name}
                  </Chip>
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="w-16 shrink-0 font-medium text-muted-foreground">{t('filters.dateRange')}</span>
              <Chip active={days === 7} onClick={() => setDays(7)}>{t('filters.quickDays.7')}</Chip>
              <Chip active={days === 15} onClick={() => setDays(15)}>{t('filters.quickDays.15')}</Chip>
              <Chip active={days === 30} onClick={() => setDays(30)}>{t('filters.quickDays.30')}</Chip>
              <Chip active={days === -1} onClick={() => setDays(-1)}>{t('filters.customDate')}</Chip>
              <span className="ml-1 tabular-nums text-muted-foreground">{rangeText}</span>
              {days === -1 && (
                <DateRangePicker
                  startDate={startDate}
                  endDate={endDate}
                  onStartChange={setStartDate}
                  onEndChange={setEndDate}
                />
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="w-16 shrink-0 font-medium text-muted-foreground">{t('filters.sort')}</span>
              <Select value={String(sortType)} onValueChange={value => setSortType(Number(value))}>
                <SelectTrigger className="h-8 w-44 shadow-none">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(options.sortOptions || []).map(item => (
                    <SelectItem key={item.Value} value={String(item.Value)}>
                      {item.Label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={exporting}
                className="ml-auto h-8 cursor-pointer shadow-none"
                onClick={handleExport}
              >
                {exporting ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <Download className="mr-1 size-3.5" />}
                导出 Excel
              </Button>
            </div>
          </div>
        </div>

        {/* AI 全网采集洞察 */}
        {(agentInsight || collectingAgent) && (
          <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-brand-cyan/20 bg-brand-cyan/5 px-4 py-3">
            <Sparkles className="mt-0.5 size-4 shrink-0 text-brand-cyan" aria-hidden />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Bosom Friend AI 全网采集洞察</p>
              {collectingAgent && !agentInsight
                ? (
                    <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Loader2 className="size-3 animate-spin" />
                      正在自动采集全网热点与相关内容并分析整理…
                    </p>
                  )
                : (
                    <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{agentInsight}</p>
                  )}
            </div>
          </div>
        )}

        {/* 结果区 */}
        <div className="mt-4 rounded-xl border border-border/60 bg-card shadow-sm">
          {!searched
            ? (
                <div className="flex min-h-[45vh] flex-col items-center justify-center gap-3 text-center">
                  <Search className="size-10 text-muted-foreground/40" />
                  <p className="text-sm text-muted-foreground">{t('results.pending')}</p>
                </div>
              )
            : loading
              ? (
                  <div className="p-4">
                    <Skeleton className="h-8 w-40" />
                    <div className="mt-3 flex flex-col gap-2">
                      {Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-14 w-full" />)}
                    </div>
                  </div>
                )
              : displayNotes.length === 0
                ? (
                    <EmptyState
                      icon={<Search className="h-6 w-6" />}
                      title={t('results.empty')}
                    />
                  )
                : (
                    <div className="overflow-x-auto">
                        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                          <div className="flex items-center gap-2 text-sm">
                            <span className="font-medium text-foreground">{t('results.title')}</span>
                            <span className="text-muted-foreground">{t('results.summary', { count: displayNotes.length })}</span>
                          </div>
                      </div>
                      <table className="w-full min-w-[1080px] text-left text-sm">
                        <thead>
                          <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
                            <th className="px-4 py-2.5 font-medium">{t('results.columns.note')}</th>
                            <th className="px-3 py-2.5 font-medium">{t('results.columns.author')}</th>
                            <th className="px-3 py-2.5 font-medium">{t('results.columns.publishTime')}</th>
                            <th className="px-3 py-2.5 text-right font-medium">{t('results.columns.interaction')}</th>
                            <th className="px-3 py-2.5 text-right font-medium">{t('results.columns.likes')}</th>
                            <th className="px-3 py-2.5 text-right font-medium">{t('results.columns.favorites')}</th>
                            <th className="px-3 py-2.5 text-right font-medium">{t('results.columns.comments')}</th>
                            <th className="px-3 py-2.5 text-right font-medium">{t('results.columns.shares')}</th>
                            <th className="px-4 py-2.5 text-right font-medium">{t('results.columns.actions')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {displayNotes.map(note => (
                            <Fragment key={note.NoteIdKey}>
                              <tr className="border-b border-border/60 transition-colors hover:bg-muted/20">
                                <td className="px-4 py-3">
                                  <div className="flex min-w-0 items-center gap-3">
                                    <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground">
                                      {note.CoverImage
                                        ? <img src={note.CoverImage} alt={note.Title} className="size-full object-cover" />
                                        : note.NoteType === 'video' ? <MessageCircle className="size-4" /> : <Star className="size-4" />}
                                    </div>
                                    <div className="min-w-0">
                                      <p className="max-w-52 truncate font-medium text-foreground">{note.Title || t('results.untitled')}</p>
                                    <div className="mt-0.5 flex min-w-0 items-center gap-1">
                                      <Badge variant="secondary" className="shrink-0 text-[10px]">{note.NoteTypeDesc}</Badge>
                                      {note.CollectedByAgent && (
                                        <Badge variant="outline" className="shrink-0 border-brand-cyan/30 text-[10px] text-brand-cyan">
                                          AI 采集
                                        </Badge>
                                      )}
                                      <span className="truncate text-xs text-muted-foreground">{note.Tags.join(' / ')}</span>
                                    </div>
                                    </div>
                                  </div>
                                </td>
                                <td className="px-3 py-3">
                                  <div className="flex items-center gap-2">
                                    <Avatar className="size-6">
                                      {note.BloggerSmallAvatar && <AvatarImage src={note.BloggerSmallAvatar} alt={note.BloggerNickName} />}
                                      <AvatarFallback className="text-[10px]">{note.BloggerNickName.slice(0, 1)}</AvatarFallback>
                                    </Avatar>
                                    <div className="min-w-0">
                                      <p className="max-w-28 truncate text-foreground">{note.BloggerNickName}</p>
                                      <p className="truncate text-xs text-muted-foreground">{note.BloggerProp}</p>
                                    </div>
                                  </div>
                                </td>
                                <td className="whitespace-nowrap px-3 py-3 text-xs tabular-nums text-muted-foreground">{note.PublishTime}</td>
                                <td className="px-3 py-3 text-right font-semibold tabular-nums text-foreground">{note.CountDesc}</td>
                                <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">{note.LikedCountDesc}</td>
                                <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">{note.FavoritesCountDesc}</td>
                                <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">{note.CommentsCountDesc}</td>
                                <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">{note.ShareCountDesc}</td>
                                <td className="px-4 py-3 text-right">
                                  <div className="flex items-center justify-end gap-1">
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-7 cursor-pointer text-xs"
                                      onClick={() => {
                                        setDetailTab('overview')
                                        setSelectedNote(note)
                                      }}
                                    >
                                      {t('results.openDetail')}
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-7 cursor-pointer text-xs text-brand-cyan"
                                      onClick={() => openOriginal(note)}
                                    >
                                      {t('results.openOriginal')}
                                    </Button>
                                  </div>
                                </td>
                              </tr>
                              {note.Comments && note.Comments.length > 0 && (
                                <tr className="border-b border-border/60 bg-muted/15">
                                  <td colSpan={9} className="px-4 py-2">
                                    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground">
                                      {note.Comments.slice(0, 2).map(comment => (
                                        <span key={comment.CommentId} className="flex min-w-0 items-center gap-1.5">
                                          <MessageCircle className="size-3 shrink-0" />
                                          <span className="max-w-[28rem] truncate">{comment.Content}</span>
                                          <span className="shrink-0 tabular-nums">{comment.CreatedAt}</span>
                                        </span>
                                      ))}
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-6 cursor-pointer px-1.5 text-xs text-brand-cyan"
                                        onClick={() => {
                                          setDetailTab('comments')
                                          setSelectedNote(note)
                                        }}
                                      >
                                        {t('results.viewMoreComments')}
                                      </Button>
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
        </div>
      </div>
      )}

      {selectedNote && (
        <NoteDetailDialog
          note={selectedNote}
          onClose={() => setSelectedNote(null)}
          onReplied={() => setSelectedNote(null)}
          initialTab={detailTab}
        />
      )}
    </PageShell>
  )
}
