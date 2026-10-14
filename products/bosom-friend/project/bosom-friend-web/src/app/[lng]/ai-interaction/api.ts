'use client'

import http from '@web/utils/request'

export interface NoteSearchOptions {
  noteTypes?: Array<{ Value: number; Label: string }>
  bloggerProps?: Array<{ Value: number; Label: string }>
  noteTags?: Array<{ Id: string; Name: string; Children?: Array<{ Id: string; Name: string }> }>
  sortOptions?: Array<{ Value: number; Label: string }>
}

export interface SampleNote {
  NoteIdKey: string
  Title: string
  CoverImage?: string
  NoteType: string
  NoteTypeDesc: string
  Tags: string[]
  PublishTime: string
  BloggerNickName: string
  BloggerSmallAvatar?: string
  BloggerUrl?: string
  BloggerProp: string
  CountDesc: string
  LikedCountDesc: string
  FavoritesCountDesc: string
  CommentsCountDesc: string
  ShareCountDesc: string
  FansGroup: string
  DateCode: string
  CommentCount?: number
  Comments?: NoteComment[]
  /** AI 全网采集的原文链接（查看原文直接打开） */
  SourceUrl?: string
  SourceSnippet?: string
  /** 是否为 AI 全网采集结果 */
  CollectedByAgent?: boolean
}

export interface AgentCollectedResult {
  insight: string
  items: SampleNote[]
  collectedAt: string
  source: 'agent'
}

export interface NoteSearchResult {
  list: SampleNote[]
  total: number
  page: number
  pageSize: number
  isSample?: boolean
  maxExportCount?: number
}

export interface NoteComment {
  CommentId: string
  Content: string
  NickName: string
  CreatedAt: string
  LikedCount: number
  IsTop?: boolean
}

export interface SearchFilters {
  keyword: string
  page: number
  pageSize: number
  sorttype: number
  starttime?: string
  endtime?: string
  days: number
  notetags: string[]
  childtags: string[]
  notetype?: number
  notbloggerprops?: number[]
}

function unwrap<T>(res: { code?: string | number; data: T; message?: string } | null): T {
  if (!res || res.code !== 0)
    throw new Error(res?.message || 'Request failed')
  return res.data
}

export async function getNoteSearchOptions(): Promise<NoteSearchOptions> {
  const res = await http.post<NoteSearchOptions>('v2/statistics/note-comment-search/options', undefined, true)
  return unwrap(res)
}

export async function searchNotes(filters: Partial<SearchFilters>): Promise<NoteSearchResult> {
  const res = await http.post<NoteSearchResult>(
    'v2/statistics/note-comment-search/search',
    {
      keyword: filters.keyword ?? '',
      page: filters.page ?? 1,
      pageSize: filters.pageSize ?? 20,
      sorttype: filters.sorttype ?? 1,
      starttime: filters.starttime,
      endtime: filters.endtime,
      days: filters.days ?? -1,
      notetags: filters.notetags ?? [],
      childtags: filters.childtags ?? [],
      ...(filters.notetype !== undefined ? { notetype: filters.notetype } : {}),
      ...(filters.notbloggerprops?.length ? { notbloggerprops: filters.notbloggerprops } : {}),
    },
    true,
  )
  return unwrap(res)
}

/** AI 全网自动采集：harness 编排（热榜 + 全网搜索）→ AgnesAI 分析整理 */
export async function agentCollectNotes(keyword: string): Promise<AgentCollectedResult> {
  const res = await http.post<AgentCollectedResult>(
    'v2/statistics/note-comment-search/agent-collect',
    { keyword },
    true,
  )
  return unwrap(res)
}

export async function getNoteSimpleInfo(noteId: string): Promise<Record<string, unknown>> {
  const res = await http.post<Record<string, unknown>>('v2/statistics/note-comment-search/note-simple-info', { noteid: noteId }, true)
  return unwrap(res)
}

export async function getNoteAnalyse(noteId: string): Promise<Record<string, unknown>> {
  const res = await http.post<Record<string, unknown>>('v2/statistics/note-comment-search/note-analyse', { noteId }, true)
  return unwrap(res)
}

export async function getNoteHotWords(noteId: string): Promise<Record<string, unknown>> {
  const res = await http.post<Record<string, unknown>>('v2/statistics/note-comment-search/note-hot-words', { noteId }, true)
  return unwrap(res)
}

export async function getCommentMentStats(noteId: string): Promise<Record<string, unknown>> {
  const res = await http.post<Record<string, unknown>>('v2/statistics/note-comment-search/comment-ment-stat', { noteId }, true)
  return unwrap(res)
}

export async function getNoteComments(noteId: string, page = 1, pageSize = 20): Promise<{ list: NoteComment[]; total: number }> {
  const res = await http.post<{ list: NoteComment[]; total: number }>(
    'v2/statistics/note-comment-search/note-comments',
    { noteIdKey: noteId, page, pageSize },
    true,
  )
  return unwrap(res)
}

export async function resolveNoteUrl(noteId: string): Promise<string> {
  const res = await http.post<{ url?: string }>('v2/statistics/note-comment-search/xhs-url', { noteId }, true)
  const data = unwrap(res)
  return data?.url || ''
}

export async function createExport(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await http.post<Record<string, unknown>>('v2/statistics/note-comment-search/export', body, true)
  return unwrap(res)
}
