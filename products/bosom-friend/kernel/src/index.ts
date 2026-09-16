/**
 * Bosom Friend 内核工具包：在官方 DSH 运行时上注册产品业务工具，不提供任何 UI。
 * 组合方式：dsh-base（基础）→ 本包 cordis.patch.yml（挂 dsh-sdk-jsonrpc-server + 本插件），
 * 由 launcher/src/bin-kernel.ts 启动；前端经官方 SDK 客户端 DeepSeekHarness 驱动。
 * 保持命名导出（无 default export），使 Loader 的 unwrapExports 保留 name/inject/apply。
 *
 * 当前已迁入 5 个工具：存活探针 + 4 个只读业务工具（账号列表/待接待/素材列表/数据看板）。
 * 其余写操作与发布类工具按 REQ/AC 逐条迁移，S 级前端验收通过一条再切一条。
 *
 * @module @deepseek-ai/dsh-bosom-friend-kernel
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'
import { asRecords, num, openProductStore, readUserLlm, resolveDataRoot, str } from './data.ts'
import { JobQueue } from './jobs.ts'

export const name = 'bosom-friend-kernel'
/** 工具注册依赖官方工具运行时；业务工具经 ctx.tools.register 挂载。 */
export const inject = ['tools', 'llm']

/** 把 limit 参数归一化为 1..50 的整数。 */
function limitOf(value: unknown): number {
  const parsed = Number.parseInt(str(value), 10)
  if (!Number.isFinite(parsed)) return 20
  return Math.min(Math.max(parsed, 1), 50)
}

/**
 * 注册内核工具。只读工具直接投影产品数据；写操作工具（发布、回复等）后续按
 * “前端页面发起 → 内核执行 → 前端可见结果”的 S 级链路迁入。
 * @param ctx - Cordis 上下文（工具运行时服务由 inject 注入）。
 */
export function apply(ctx: Context): void {
  const dataRoot = resolveDataRoot()
  const store = openProductStore(dataRoot)

  ctx.tools.register(defineTool({
    name: 'bosom_kernel_ping',
    description: '检查 Bosom Friend 官方 DSH 内核运行时是否存活，返回运行信息。',
    parameters: {
      message: {
        type: 'string',
        required: true,
        description: '要回显的一段文字',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          now: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `内核存活：${value.ok ? '是' : '否'}；回显：${value.message}；时间：${value.now}` },
      ],
    },
    timeoutMs: 5000,
    execute: async (args) => ({
      ok: true,
      message: args.message,
      now: new Date().toISOString(),
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'bosom_platform_list_accounts',
    description: '列出已绑定的平台账号（含平台、昵称、粉丝数、状态与登录态；登录态 invalid 表示需要重新扫码），数据来自产品数据根。',
    parameters: {
      limit: {
        type: 'string',
        required: true,
        description: '最多返回多少条（1–50）',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'number', required: true },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                platform: { type: 'string', required: true },
                nickname: { type: 'string', required: true },
                uid: { type: 'string', required: true },
                fansCount: { type: 'number', required: true },
                status: { type: 'number', required: true },
                /** 平台侧登录态：valid=可用，invalid=需重新扫码；缺失表示尚未判定。 */
                loginState: { type: 'string', required: true },
                /** 登录失效时平台返回的原因原文（无则为空串）。 */
                loginNote: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `共 ${value.count} 个平台账号：\n` + value.items
            .map((a) => `- ${a.platform} ${a.nickname}（粉丝 ${a.fansCount}，状态 ${a.status}${a.loginState === 'invalid' ? '，登录已失效：' + (a.loginNote || '需重新扫码') : ''}）`)
            .join('\n'),
        },
      ],
    },
    timeoutMs: 10000,
    execute: async (args) => {
      const limit = limitOf(args.limit)
      const rows = asRecords(store.files.accounts.load())
      return {
        count: rows.length,
        items: rows.slice(0, limit).map((a) => ({
          id: str(a.id),
          platform: str(a.type),
          nickname: str(a.nickname),
          uid: str(a.uid),
          fansCount: num(a.fansCount),
          status: num(a.status),
          loginState: str(a.loginState),
          loginNote: str(a.loginNote),
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'bosom_reception_list_pending',
    description: '列出 7×24 自动接待当前待处理的评论/私信（含来源平台、内容、匹配规则与拟回复）。',
    parameters: {
      limit: {
        type: 'string',
        required: true,
        description: '最多返回多少条（1–50）',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'number', required: true },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                platform: { type: 'string', required: true },
                accountId: { type: 'string', required: true },
                text: { type: 'string', required: true },
                matched: { type: 'boolean', required: true },
                ruleName: { type: 'string', required: true },
                reply: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `共 ${value.count} 条待接待：\n` + value.items.map((p) => `- [${p.platform}/${p.kind}] ${p.text} → 规则 ${p.ruleName || '无'}，拟回复：${p.reply || '无'}`).join('\n') },
      ],
    },
    timeoutMs: 10000,
    execute: async (args) => {
      const limit = limitOf(args.limit)
      const rows = asRecords(store.files.receptionPending.load())
      return {
        count: rows.length,
        items: rows.slice(0, limit).map((p) => ({
          id: str(p.id),
          kind: str(p.kind),
          platform: str(p.platform),
          accountId: str(p.accountId),
          text: str(p.commentText) || str(p.peerName) || str(p.username),
          matched: p.matched === true,
          ruleName: str(p.ruleName),
          reply: str(p.reply),
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'bosom_material_list',
    description: '列出素材库中的图片/视频素材（含类型、标题、使用次数与创建时间）。',
    parameters: {
      limit: {
        type: 'string',
        required: true,
        description: '最多返回多少条（1–50）',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'number', required: true },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                type: { type: 'string', required: true },
                title: { type: 'string', required: true },
                useCount: { type: 'number', required: true },
                createdAt: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `共 ${value.count} 个素材：\n` + value.items.map((m) => `- [${m.type}] ${m.title}（使用 ${m.useCount} 次，${m.createdAt}）`).join('\n') },
      ],
    },
    timeoutMs: 10000,
    execute: async (args) => {
      const limit = limitOf(args.limit)
      // 素材住在 contents 里，靠 kind 区分；store.files 没有 materials 这个文件，
      // 直接 load 会抛「Cannot read properties of undefined (reading 'load')」。
      const rows = asRecords(store.files.contents.load()).filter(item => item.kind === 'asset')
      return {
        count: rows.length,
        items: rows.slice(0, limit).map((m) => ({
          id: str(m._id),
          type: str(m.type),
          title: str(m.title),
          useCount: num(m.useCount),
          createdAt: str(m.createdAt),
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'bosom_data_dashboard',
    description: '汇总数据中心概况：账号数、素材数、待接待数、发布记录数与数据指标行数，并给出最近 3 条发布记录。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accounts: { type: 'number', required: true },
          materials: { type: 'number', required: true },
          pendingReception: { type: 'number', required: true },
          publishRecords: { type: 'number', required: true },
          metricRows: { type: 'number', required: true },
          recentPublishes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string', required: true },
                platform: { type: 'string', required: true },
                status: { type: 'number', required: true },
                publishTime: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `数据中心：账号 ${value.accounts}、素材 ${value.materials}、待接待 ${value.pendingReception}、发布记录 ${value.publishRecords}、指标行 ${value.metricRows}。\n最近发布：\n` + value.recentPublishes.map((r) => `- ${r.platform}《${r.title}》状态 ${r.status}（${r.publishTime}）`).join('\n'),
        },
      ],
    },
    timeoutMs: 10000,
    execute: async () => {
      const records = asRecords(store.files.records.load())
      return {
        accounts: asRecords(store.files.accounts.load()).length,
        materials: asRecords(store.files.contents.load()).filter(item => item.kind === 'asset').length,
        pendingReception: asRecords(store.files.receptionPending.load()).length,
        publishRecords: records.length,
        metricRows: asRecords(store.files.metrics.load()).length,
        recentPublishes: records.slice(-3).reverse().map((r) => ({
          title: str(r.title),
          platform: str(r.accountType),
          status: num(r.status),
          publishTime: str(r.publishTime),
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'bosom_platform_login_status',
    description: '汇总平台账号登录状态：已绑定账号数、各平台数量分布。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          bound: { type: 'number', required: true },
          platforms: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                platform: { type: 'string', required: true },
                count: { type: 'number', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `已绑定 ${value.bound} 个平台账号：` + (value.platforms.map((p) => `${p.platform}×${p.count}`).join('、') || '无') },
      ],
    },
    timeoutMs: 10000,
    execute: async () => {
      const rows = asRecords(store.files.accounts.load())
      const byPlatform = new Map<string, number>()
      for (const row of rows) {
        const platform = str(row.type) || 'unknown'
        byPlatform.set(platform, (byPlatform.get(platform) ?? 0) + 1)
      }
      return {
        bound: rows.length,
        platforms: [...byPlatform.entries()].map(([platform, count]) => ({ platform, count })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'bosom_platform_sync_works',
    description: '按平台账号汇总本地已发布作品（来自产品发布记录；不伪造未同步的远端数据）。',
    parameters: {
      limit: {
        type: 'string',
        required: true,
        description: '最多返回多少条（1–50）',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'number', required: true },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                platform: { type: 'string', required: true },
                title: { type: 'string', required: true },
                status: { type: 'number', required: true },
                publishTime: { type: 'string', required: true },
                workId: { type: 'string', required: true },
                workLink: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `本地发布记录共 ${value.count} 条：\n` + value.items.map((w) => `- [${w.platform}]《${w.title}》状态 ${w.status}（${w.publishTime}，作品 ID：${w.workId || '无'}）`).join('\n') },
      ],
    },
    timeoutMs: 10000,
    execute: async (args) => {
      const limit = limitOf(args.limit)
      const rows = asRecords(store.files.records.load())
      return {
        count: rows.length,
        items: rows.slice(-limit).reverse().map((r) => ({
          platform: str(r.accountType),
          title: str(r.title),
          status: num(r.status),
          publishTime: str(r.publishTime),
          workId: str(r.platformWorkId),
          workLink: str(r.workLink),
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'bosom_content_list_drafts',
    description: '列出草稿箱中的生成记录（含状态、标题与创建时间）。',
    parameters: {
      limit: {
        type: 'string',
        required: true,
        description: '最多返回多少条（1–50）',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'number', required: true },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                status: { type: 'string', required: true },
                title: { type: 'string', required: true },
                createdAt: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `共 ${value.count} 条草稿：\n` + value.items.map((d) => `- [${d.status}] ${d.title || '未命名'}（${d.createdAt}）`).join('\n') },
      ],
    },
    timeoutMs: 10000,
    execute: async (args) => {
      const limit = limitOf(args.limit)
      const rows = store.files.generations.load()
      return {
        count: rows.length,
        items: rows.slice(-limit).reverse().map((d) => ({
          id: str(d.id),
          status: str(d.status),
          title: str(d.response?.title),
          createdAt: str(d.createdAt),
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'bosom_content_generate_script',
    description: '通过官方内核 LLM 能力生成内容脚本并返回文本（只读工具，不写产品数据；落库与发布由前端执行器完成）。',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: '创作需求',
      },
      kind: {
        type: 'string',
        required: true,
        description: 'video 或 image-text',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', required: true },
          content: { type: 'string', required: true },
          model: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `已生成《${value.title}》\n${value.content}` },
      ],
    },
    timeoutMs: 60000,
    execute: async (args) => {
      const user = readUserLlm(dataRoot)
      const model = user.model !== '' ? user.model : 'agnes-2.5-flash'
      let text = ''
      try {
        for await (const chunk of ctx.llm.stream({
          provider: 'agnes',
          model,
          messages: [{
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: args.prompt }],
            source: { kind: 'user' },
          }],
          maxTokens: 2000,
        })) {
          if (chunk.type === 'text-delta') text += chunk.text
          if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
            throw new Error('模型请求失败')
          }
        }
      } catch (error) {
        throw new Error('大模型调用失败：' + (error instanceof Error ? error.message : String(error)))
      }
      if (text.trim() === '') throw new Error('大模型未返回任何内容，请检查 API 配置')
      const firstLine = text.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? ''
      const title = firstLine.replace(/^#+\s*/, '').slice(0, 30) || 'AI 生成内容'
      return { title, content: text, model }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'bosom_job_list',
    description: '列出产品长任务（登录/发布/同步/客服等）的状态、重试次数与最近错误。',
    parameters: {
      limit: {
        type: 'string',
        required: true,
        description: '最多返回多少条（1–50）',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'number', required: true },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                status: { type: 'string', required: true },
                attempt: { type: 'number', required: true },
                updatedAt: { type: 'string', required: true },
                lastError: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `共 ${value.count} 个任务：\n` + value.items.map((j) => `- [${j.status}] ${j.kind}（第 ${j.attempt} 次，${j.updatedAt}）${j.lastError !== '' ? ' 错误：' + j.lastError : ''}`).join('\n') },
      ],
    },
    timeoutMs: 10000,
    execute: async (args) => {
      const limit = limitOf(args.limit)
      const rows = new JobQueue(dataRoot).list()
      return {
        count: rows.length,
        items: rows.slice(-limit).reverse().map((job) => ({
          id: str(job.id),
          kind: str(job.kind),
          status: str(job.status),
          attempt: num(job.attempt),
          updatedAt: str(job.updatedAt),
          lastError: str(job.lastError),
        })),
      }
    },
  }))
}
