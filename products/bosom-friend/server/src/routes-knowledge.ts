/**
 * Knowledge base Web backend.
 *
 * Replaces the old Electron IPC-only knowledge store with a real HTTP CRUD
 * backed by `knowledge.json`. The frontend now stays fully usable in the Web
 * shell and in the packaged app.
 */
import type { RouteDef, Deps } from './api.ts'
import { writeOk, writeFail } from './http.ts'

interface KnowledgeNote {
  name: string
  content: string
  protected?: boolean
}

interface KnowledgeState {
  notes: Record<string, KnowledgeNote>
  vault: { path: string; builtIn: boolean }
}

interface KbNode {
  name: string
  path: string
  type: 'folder' | 'note'
  protected?: boolean
  children?: KbNode[]
}

function cleanRelPath(value: string): string {
  return decodeURIComponent(value).replace(/^\/+|\/+$/g, '').replace(/\\/g, '/')
}

function safeNoteName(value: string): string {
  return (value ?? '').trim().replace(/\.md$/i, '').replace(/[/\\]/g, '').slice(0, 80)
}

function noteKey(folder: string, name: string): string {
  const dir = cleanRelPath(folder).replace(/\.md$/i, '')
  return dir === '' ? `${name}.md` : `${dir}/${name}.md`
}

function noteNameFromKey(key: string): string {
  return key.split('/').pop()?.replace(/\.md$/i, '') ?? key
}

function buildTree(state: KnowledgeState): KbNode[] {
  return Object.entries(state.notes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, note]) => ({
      name: note.name || noteNameFromKey(path),
      path,
      type: 'note' as const,
      ...(note.protected === undefined ? {} : { protected: note.protected }),
    }))
}

function snippet(content: string, query: string): string {
  const index = content.indexOf(query)
  const start = Math.max(0, index - 20)
  return content.slice(start, start + 80).replace(/\s+/g, ' ').trim()
}

export function appendKnowledgeRoutes(deps: Deps, routes: RouteDef[]): void {
  const state = (): KnowledgeState => deps.store.files.knowledge.load()
  const save = (): void => deps.store.files.knowledge.save(state())

  routes.push(
    {
      m: 'GET',
      p: 'knowledge/tree',
      h: ({ res }) => {
        writeOk(res, { list: buildTree(state()) })
      },
    },
    {
      m: 'GET',
      p: 'knowledge/vault',
      h: ({ res }) => {
        const vault = state().vault
        writeOk(res, { path: vault.path, builtIn: vault.builtIn })
      },
    },
    {
      m: 'POST',
      p: 'knowledge/notes',
      h: ({ res, body }) => {
        const params = (body ?? {}) as { name?: unknown; folder?: unknown }
        const name = safeNoteName(typeof params.name === 'string' ? params.name : '')
        if (name === '') {
          writeFail(res, '笔记名称不能为空', 40000)
          return
        }
        const key = noteKey(typeof params.folder === 'string' ? params.folder : '', name)
        const current = state()
        if (!current.notes[key]) {
          current.notes[key] = {
            name,
            content: `# ${name}\n\n`,
          }
          save()
        }
        writeOk(res, { path: key, name })
      },
    },
    {
      m: 'GET',
      p: 'knowledge/notes/:path',
      h: ({ res, params }) => {
        const key = cleanRelPath(params.path ?? '')
        const note = state().notes[key]
        if (!note) {
          writeFail(res, '笔记不存在', 40404)
          return
        }
        writeOk(res, { path: key, name: note.name, content: note.content, protected: note.protected === true })
      },
    },
    {
      m: 'PUT',
      p: 'knowledge/notes/:path',
      h: ({ res, params, body }) => {
        const key = cleanRelPath(params.path ?? '')
        const current = state()
        const note = current.notes[key]
        if (!note) {
          writeFail(res, '笔记不存在', 40404)
          return
        }
        const content = (body as { content?: unknown })?.content
        if (typeof content !== 'string') {
          writeFail(res, '内容必须是字符串', 40000)
          return
        }
        note.content = content
        save()
        writeOk(res, { path: key, name: note.name })
      },
    },
    {
      m: 'DELETE',
      p: 'knowledge/notes/:path',
      h: ({ res, params }) => {
        const key = cleanRelPath(params.path ?? '')
        const current = state()
        const note = current.notes[key]
        if (!note) {
          writeFail(res, '笔记不存在', 40404)
          return
        }
        if (note.protected) {
          writeFail(res, '内置文档不可删除', 40300)
          return
        }
        delete current.notes[key]
        save()
        writeOk(res, { ok: true })
      },
    },
    {
      m: 'POST',
      p: 'knowledge/search',
      h: ({ res, body }) => {
        const query = typeof (body as { query?: unknown })?.query === 'string'
          ? String((body as { query?: unknown }).query).trim()
          : ''
        if (query === '') {
          writeOk(res, { hits: [] })
          return
        }
        const hits = Object.entries(state().notes)
          .filter(([, note]) => note.name.includes(query) || note.content.includes(query))
          .map(([path, note]) => ({
            path,
            name: note.name || noteNameFromKey(path),
            snippet: snippet(note.content, query),
          }))
        writeOk(res, { hits })
      },
    },
    {
      m: 'POST',
      p: 'knowledge/backlinks',
      h: ({ res, body }) => {
        const targetName = noteNameFromKey(cleanRelPath(typeof (body as { path?: unknown })?.path === 'string' ? String((body as { path?: unknown }).path) : ''))
        const hits = Object.entries(state().notes)
          .filter(([, note]) => note.content.includes(`[[${targetName}]]`))
          .map(([path, note]) => ({
            path,
            name: note.name || noteNameFromKey(path),
            snippet: note.content.slice(0, 80).replace(/\s+/g, ' ').trim(),
          }))
        writeOk(res, { hits })
      },
    },
    {
      m: 'POST',
      p: 'knowledge/choose-vault',
      h: ({ res }) => {
        writeOk(res, { path: '', builtIn: true })
      },
    },
  )
}
