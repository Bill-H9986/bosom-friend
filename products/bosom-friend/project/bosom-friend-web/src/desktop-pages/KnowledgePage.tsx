/**
 * KnowledgePage - 内置知识库（Obsidian 兼容）
 *
 * 三栏布局：
 *   左：目录树 + 全库搜索
 *   中：Markdown 编辑器 / 预览（支持 [[双向链接]]）
 *   右：反向链接
 */
'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BookOpen,
  ChevronRight,
  FilePlus,
  FileText,
  Folder,
  Save,
  Search,
  Trash2,
} from 'lucide-react'
import { PageShell } from '@web/app/layout/PageShell'
import KnowledgeDistillPanel from '@web/desktop-pages/KnowledgeDistillPanel'
import { Button } from '@web/components/ui/button'
import { Input } from '@web/components/ui/input'
import { cn } from '@web/utils/className'
import http from '@web/utils/request'
import { confirm } from '@web/utils/ui/confirm'
import { toast } from '@web/utils/ui/toast'

interface KbNode {
  name: string
  path: string
  type: 'folder' | 'note'
  /** 是否为内置种子文档（不可删除） */
  protected?: boolean
  children?: KbNode[]
}

interface KbHit {
  path: string
  name: string
  snippet: string
}

const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
  const first = String(args[0] ?? '')
  const second = args[1] ?? ''
  switch (channel) {
    case 'KB_LIST_TREE':
      return (await http.get<{ list: KbNode[] }>('knowledge/tree', undefined, true))?.data?.list
    case 'KB_GET_VAULT':
      return (await http.get<{ path: string; builtIn: boolean }>('knowledge/vault', undefined, true))?.data
    case 'KB_READ':
      return (await http.get<{ path: string; name: string; content: string; protected?: boolean }>(`knowledge/notes/${encodeURIComponent(first)}`, undefined, true))?.data
    case 'KB_WRITE':
      return (await http.put<{ path: string }>(`knowledge/notes/${encodeURIComponent(first)}`, { content: String(second ?? '') }, true))?.data
    case 'KB_CREATE':
      return (await http.post<{ path: string; name: string }>('knowledge/notes', {
        name: first.replace(/\.md$/i, ''),
        folder: String(second ?? ''),
      }, true))?.data
    case 'KB_DELETE':
      return (await http.delete<{ ok: boolean }>(`knowledge/notes/${encodeURIComponent(first)}`, undefined, true))?.data
    case 'KB_CHOOSE_VAULT':
      return (await http.post<{ path: string; builtIn: boolean }>('knowledge/choose-vault', {}, true))?.data
    case 'KB_SEARCH':
      return (await http.post<{ hits: KbHit[] }>('knowledge/search', { query: first }, true))?.data?.hits
    case 'KB_BACKLINKS':
      return (await http.post<{ hits: KbHit[] }>('knowledge/backlinks', { path: first }, true))?.data?.hits
    default:
      return null
  }
}

function flattenNotes(nodes: KbNode[]): KbNode[] {
  const out: KbNode[] = []
  for (const node of nodes) {
    if (node.type === 'note') out.push(node)
    if (node.children) out.push(...flattenNotes(node.children))
  }
  return out
}

export default function KnowledgePage() {
  const [tree, setTree] = useState<KbNode[]>([])
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set(['']))
  const [currentPath, setCurrentPath] = useState<string | null>(null)
  const [currentName, setCurrentName] = useState('')
  const [currentProtected, setCurrentProtected] = useState(false)
  const [content, setContent] = useState('')
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [backlinks, setBacklinks] = useState<KbHit[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [searchHits, setSearchHits] = useState<KbHit[]>([])
  const [vaultPath, setVaultPath] = useState('')
  const [vaultBuiltIn, setVaultBuiltIn] = useState(true)
  const [tab, setTab] = useState<'notes' | 'distill'>('notes')
  const [newNoteOpen, setNewNoteOpen] = useState(false)
  const [newNoteName, setNewNoteName] = useState('')
  const [saved, setSaved] = useState(true)
  const saveTimer = useRef<number | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Web 后端知识库已接入：知识库不再依赖 Electron IPC，Web 壳同样可用。
  const isDesktop = true

  const loadTree = useCallback(async () => {
    const nodes = await invoke('KB_LIST_TREE') as KbNode[]
    setTree(nodes || [])
  }, [])

  const loadVault = useCallback(async () => {
    const res = await invoke('KB_GET_VAULT') as { path: string, builtIn: boolean } | undefined
    setVaultPath(res?.path || '')
    setVaultBuiltIn(res?.builtIn ?? true)
  }, [])

  useEffect(() => {
    if (!isDesktop) return
    loadTree()
    loadVault()
  }, [isDesktop, loadTree, loadVault])

  const saveNote = useCallback(async (force = false) => {
    if (!currentPath || !force && saveTimer.current) return
    if (!currentPath) return
    await invoke('KB_WRITE', currentPath, content)
    setSaved(true)
    const hits = await invoke('KB_BACKLINKS', currentPath) as KbHit[]
    setBacklinks(hits || [])
    loadTree()
  }, [currentPath, content, loadTree])

  // 输入停止 800ms 后自动保存
  useEffect(() => {
    if (!currentPath || saved) return
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void saveNote(true)
    }, 800)
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
    }
  }, [content, currentPath, saved, saveNote])

  const openNote = useCallback(async (node: KbNode) => {
    const res = await invoke('KB_READ', node.path) as { path: string, content: string }
    if (!res) return
    setCurrentPath(node.path)
    setCurrentName(node.name)
    setCurrentProtected(!!node.protected)
    setContent(res.content)
    setSaved(true)
    setMode('edit')
    const hits = await invoke('KB_BACKLINKS', node.path) as KbHit[]
    setBacklinks(hits || [])
  }, [])

  const handleContentChange = useCallback((value: string) => {
    setContent(value)
    setSaved(false)
  }, [])

  const createNote = useCallback(async () => {
    const name = newNoteName.trim()
    if (!name) return
    const folder = currentPath?.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/')) : ''
    const rel = folder ? `${folder}/${name}.md` : `${name}.md`
    const created = await invoke('KB_CREATE', name, folder) as { path?: string } | undefined
    setNewNoteOpen(false)
    setNewNoteName('')
    await loadTree()
    const nodes = flattenNotes(tree)
    const target = nodes.find(n => n.path === (created?.path ?? rel)) || { name, path: created?.path ?? rel, type: 'note' as const }
    await openNote(target)
  }, [newNoteName, currentPath, loadTree, tree, openNote])

  const deleteNote = useCallback(async () => {
    if (!currentPath) return
    if (currentProtected) {
      toast.warning('内置文档不可删除')
      return
    }
    await invoke('KB_DELETE', currentPath)
    setCurrentPath(null)
    setCurrentName('')
    setCurrentProtected(false)
    setContent('')
    setBacklinks([])
    await loadTree()
  }, [currentPath, currentProtected, loadTree])

  const chooseVault = useCallback(async () => {
    const res = await invoke('KB_CHOOSE_VAULT') as { path?: string; builtIn?: boolean } | undefined
    setVaultPath(res?.path || '')
    setVaultBuiltIn(res?.builtIn ?? true)
    await loadTree()
  }, [loadTree])

  const runSearch = useCallback(async (query: string) => {
    setSearchQuery(query)
    if (!query.trim()) {
      setSearchHits([])
      return
    }
    const hits = await invoke('KB_SEARCH', query) as KbHit[]
    setSearchHits(hits || [])
  }, [])

  const openByName = useCallback(async (name: string) => {
    const nodes = flattenNotes(tree)
    const match = nodes.find(n => n.name === name)
    if (match) {
      await openNote(match)
    }
    else {
      const created = await invoke('KB_CREATE', name, '') as { path?: string } | undefined
      const rel = created?.path || `${name}.md`
      await loadTree()
      await openNote({ name, path: rel, type: 'note' })
    }
  }, [tree, loadTree, openNote])

  const handleDeleteClick = useCallback(async () => {
    const confirmed = await confirm({
      title: '删除笔记',
      content: `确定删除笔记「${currentName}」吗？此操作不可恢复。`,
      okType: 'destructive',
      okText: '删除',
    })
    if (confirmed)
      void deleteNote()
  }, [currentName, deleteNote])

  const previewContent = useMemo(
    () => content.replace(/\[\[([^\]]+)\]\]/g, (_, name: string) => `[${name}](wiki://${encodeURIComponent(name.trim())})`),
    [content],
  )

  // Ctrl+S 保存
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        void saveNote(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [saveNote])

  const toggleFolder = (path: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const renderNode = (node: KbNode) => {
    if (node.type === 'folder') {
      const open = expandedFolders.has(node.path)
      return (
        <div key={node.path}>
          <button
            type="button"
            onClick={() => toggleFolder(node.path)}
            className="flex h-8 w-full items-center gap-1.5 rounded-lg px-2 text-sm text-foreground/80 hover:bg-accent cursor-pointer"
          >
            <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
            <Folder className="size-3.5 shrink-0 text-primary" />
            <span className="truncate">{node.name}</span>
          </button>
          {open && node.children && (
            <div className="ml-3 border-l border-border/60 pl-1.5">
              {node.children.map(renderNode)}
            </div>
          )}
        </div>
      )
    }
    return (
      <button
        key={node.path}
        type="button"
        onClick={() => openNote(node)}
        className={cn(
          'flex h-8 w-full items-center gap-1.5 rounded-lg px-2 pl-7 text-sm cursor-pointer transition-colors',
          currentPath === node.path
            ? 'bg-primary/10 font-medium text-primary'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
      >
        <FileText className="size-3.5 shrink-0" />
        <span className="truncate">{node.name}</span>
      </button>
    )
  }

  if (!isDesktop) {
    return (
      <PageShell>
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          知识库仅在桌面端可用
        </div>
      </PageShell>
    )
  }

  return (
    <PageShell
      tabs={[{ key: 'notes', label: '笔记' }, { key: 'distill', label: '蒸馏' }]}
      activeTab={tab}
      onTabChange={key => setTab(key === 'distill' ? 'distill' : 'notes')}
      actions={(
        <>
          <Button variant="outline" size="sm" className="h-8 cursor-pointer text-sm" onClick={chooseVault}>
            <Folder className="size-4" />
            挂载外部库
          </Button>
          <Button size="sm" className="h-8 cursor-pointer text-sm" onClick={() => setNewNoteOpen(true)}>
            <FilePlus className="size-4" />
            新建笔记
          </Button>
        </>
      )}
      contentClassName="p-0"
    >
      {tab === 'distill' ? <KnowledgeDistillPanel /> : (
      <div className="flex h-full min-h-0">
        {/* 左：目录树 + 搜索 */}
        <aside className="flex w-60 shrink-0 flex-col border-r border-border/60 bg-background/60">
          <div className="p-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={e => runSearch(e.target.value)}
                placeholder="搜索笔记…"
                className="bg-background pl-8 text-sm"
              />
            </div>
            {newNoteOpen && (
              <div className="mt-2 flex gap-1.5">
                <Input
                  autoFocus
                  value={newNoteName}
                  onChange={e => setNewNoteName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') void createNote() }}
                  placeholder="笔记名称"
                  className="text-sm"
                />
                <Button size="sm" className="h-8 cursor-pointer" onClick={() => void createNote()}>
                  创建
                </Button>
              </div>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {searchQuery.trim()
              ? searchHits.map(hit => (
                  <button
                    key={hit.path}
                    type="button"
                    onClick={() => openByName(hit.name)}
                    className="mb-1 w-full rounded-xl border border-border/60 bg-card px-2.5 py-2 text-left text-sm transition-all duration-300 ease-apple-out hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-lg hover:shadow-primary/10 cursor-pointer"
                  >
                    <span className="block truncate font-medium text-foreground">{hit.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{hit.snippet}</span>
                  </button>
                ))
              : tree.map(renderNode)}
            {!searchQuery.trim() && tree.length === 0 && (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                暂无笔记，点击右上角「新建笔记」
              </p>
            )}
          </div>
          <div className="border-t border-border/60 px-3 py-2">
            <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground" title={vaultPath}>
              <BookOpen className="size-3.5 shrink-0 text-primary" />
              {vaultBuiltIn
                ? <span className="truncate">内置知识库 · 随应用保存，越用越聪明</span>
                : <span className="truncate">外部库 · {vaultPath || '未选择库目录'}</span>}
            </p>
          </div>
        </aside>

        {/* 中：编辑器 / 预览 */}
        <section className="flex min-w-0 flex-1 flex-col">
          {currentPath ? (
            <>
              <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border/60 px-4">
                <div className="flex min-w-0 items-center gap-2">
                  <FileText className="size-4 shrink-0 text-primary" />
                  <span className="truncate text-sm font-medium text-foreground">{currentName}</span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <div className="flex items-center rounded-lg bg-muted p-0.5">
                    {(['edit', 'preview'] as const).map(m => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setMode(m)}
                        className={cn(
                          'rounded-md px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer',
                          mode === m ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {m === 'edit' ? '编辑' : '预览'}
                      </button>
                    ))}
                  </div>
                  <Button
                    size="sm"
                    className="h-8 cursor-pointer text-sm"
                    disabled={saved}
                    onClick={() => void saveNote(true)}
                  >
                    <Save className="size-3.5" />
                    {saved ? '已保存' : '保存'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 cursor-pointer text-muted-foreground hover:text-destructive"
                    onClick={() => void handleDeleteClick()}
                    title={currentProtected ? '内置文档不可删除' : '删除笔记'}
                    disabled={currentProtected}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {mode === 'edit' ? (
                  <textarea
                    ref={textareaRef}
                    value={content}
                    onChange={e => handleContentChange(e.target.value)}
                    spellCheck={false}
                    className="h-full w-full resize-none bg-background p-4 font-mono text-sm leading-6 text-foreground outline-none"
                  />
                ) : (
                  <article className="prose-sm max-w-none p-4">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        a: ({ href, children }) => (
                          <a
                            href={href}
                            onClick={(e) => {
                              if (href?.startsWith('wiki://')) {
                                e.preventDefault()
                                void openByName(decodeURIComponent(href.slice(7)))
                              }
                            }}
                            className="cursor-pointer text-primary underline underline-offset-4"
                          >
                            {children}
                          </a>
                        ),
                      }}
                    >
                      {previewContent}
                    </ReactMarkdown>
                  </article>
                )}
              </div>
            </>
          ) : (
            <div className="flex h-full items-center justify-center px-4">
              <div className="text-center">
                <BookOpen className="mx-auto mb-3 size-10 text-primary/40" />
                <p className="text-sm text-muted-foreground">从左侧选择一篇笔记，或新建一篇开始记录</p>
              </div>
            </div>
          )}
        </section>

        {/* 右：反向链接 */}
        <aside className="hidden w-56 shrink-0 flex-col border-l border-border/60 bg-background/60 lg:flex">
          <div className="border-b border-border/60 px-3 py-2.5">
            <h3 className="section-title text-sm">反向链接</h3>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {backlinks.length === 0 ? (
              <p className="px-2 py-4 text-xs text-muted-foreground">暂无其他笔记链接到当前笔记</p>
            ) : (
              backlinks.map(hit => (
                <button
                  key={hit.path}
                  type="button"
                  onClick={() => openByName(hit.name)}
                  className="mb-1.5 w-full rounded-lg border border-border/50 bg-card px-2.5 py-2 text-left text-sm hover:border-primary/40 cursor-pointer"
                >
                  <span className="block truncate font-medium text-foreground">{hit.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{hit.snippet}</span>
                </button>
              ))
            )}
          </div>
        </aside>
      </div>
      )}
    </PageShell>
  )
}
