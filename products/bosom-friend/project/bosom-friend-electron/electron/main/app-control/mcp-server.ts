/*
 * 知音 AI 内容创作营销系统 - APP 控制 MCP 服务
 *
 * 在本地（127.0.0.1:3457）暴露一个轻量 MCP（HTTP/JSON-RPC）服务，
 * 供后端 Agent 调用，实现对桌面端 APP 的控制：
 *   - appNavigateTo   ：跳转到指定功能页
 *   - appGetCurrentPage：读取当前所在页面
 *   - appGetAppState  ：读取 APP 运行状态摘要
 *   - appOpenAiChat   ：唤起右侧 AI 助手面板（可带预填问题）
 *
 * 安全说明：仅绑定回环地址，且只接受 JSON-RPC 白名单方法，不暴露文件系统。
 */
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { app, type BrowserWindow } from 'electron';
import { getKernelRuntime } from '../zhiyin-kernel-host';

export const APP_CONTROL_MCP_PORT = 3457;
export const APP_CONTROL_MCP_URL = `http://127.0.0.1:${APP_CONTROL_MCP_PORT}/mcp`;

/** 功能页路由映射：Agent 可使用中文/拼音/英文别名 */
const PAGE_ROUTES: Record<string, string> = {
  home: '/',
  '首页': '/',
  'draft-box': '/draft-box',
  'draftbox': '/draft-box',
  '内容创作': '/draft-box',
  'ai-interaction': '/ai-interaction',
  'ai互动': '/ai-interaction',
  'tasks-history': '/tasks-history',
  '任务记录': '/tasks-history',
  '我的任务': '/tasks-history',
  'knowledge': '/knowledge',
  '知识库': '/knowledge',
  'accounts': '/accounts',
  '账号管理': '/accounts',
  'settings': '/settings',
  '设置': '/settings',
  'hot-content': '/hot-content',
  '热点内容': '/hot-content',
};

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

async function materializeMedia(args: Record<string, unknown>): Promise<{
  mediaPath?: string;
  mediaPaths?: string[];
}> {
  const single = typeof args.mediaUrl === 'string' && args.mediaUrl.trim()
    ? [args.mediaUrl.trim()]
    : [];
  const urls = Array.isArray(args.mediaUrls)
    ? (args.mediaUrls as unknown[]).filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    : single;
  if (urls.length === 0) {
    return {
      mediaPath: typeof args.mediaPath === 'string' ? args.mediaPath : undefined,
      mediaPaths: Array.isArray(args.mediaPaths)
        ? (args.mediaPaths as unknown[]).filter((item): item is string => typeof item === 'string')
        : undefined,
    };
  }

  const dir = path.join(app.getPath('userData'), 'tmp-agent-media');
  await fsp.mkdir(dir, { recursive: true });
  const mediaType = String(args.mediaType || 'image');
  const results: string[] = [];
  for (const url of urls) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    }
    catch {
      throw new Error(`素材 URL 无效：${url}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`不支持下载素材协议：${parsed.protocol}`);
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`下载素材失败（${response.status}）：${url}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
    const ext = path.extname(parsed.pathname) || (mediaType === 'video' ? '.mp4' : '.png');
    const filePath = path.join(dir, `agent-media-${hash}${ext}`);
    await fsp.writeFile(filePath, buffer);
    results.push(filePath);
  }
  return {
    mediaPath: results[0],
    mediaPaths: results,
  };
}

const TOOLS: McpTool[] = [
  {
    name: 'appNavigateTo',
    description: '跳转到知音桌面端的指定功能页。page 支持：首页、内容创作、AI互动、任务记录、我的任务、知识库、账号管理、设置、热点内容（也支持英文别名）。',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'string', description: '目标页面名称，如：内容创作、AI互动、任务记录、知识库、账号管理、设置' },
      },
      required: ['page'],
    },
  },
  {
    name: 'appGetCurrentPage',
    description: '读取知音桌面端当前所在页面（路由与页面标题）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'appGetAppState',
    description: '读取知音桌面端运行状态摘要：当前页面、窗口标题、页面标题。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'appListAccounts',
    description: '读取知音 APP 本地已登录平台账号列表（platform 可选过滤），用于确定发布/回复目标账号。',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', description: '可选平台：douyin/xhs' },
      },
    },
  },
  {
    name: 'appOpenAiChat',
    description: '唤起右侧 AI 助手面板并聚焦输入框，可附带预填问题。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '预填到输入框的问题（可选）' },
      },
    },
  },
  {
    name: 'appPublish',
    description: '把内容发布到指定平台账号（高风险操作，桌面直连自动化）：platform=douyin/xhs，accountId=账号ID，title=标题，desc=文案，mediaType=image/video/text，mediaUrl=素材地址，mediaUrls=素材地址数组，mediaPath=本地素材路径。',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', description: '目标平台：douyin/xhs' },
        accountId: { type: 'number', description: '平台账号 ID（账号管理中可见）' },
        title: { type: 'string', description: '发布标题' },
        desc: { type: 'string', description: '发布文案' },
        mediaType: { type: 'string', enum: ['image', 'video', 'text'], description: '素材类型' },
        mediaUrl: { type: 'string', description: '素材预览地址' },
        mediaUrls: { type: 'array', items: { type: 'string' }, description: '多素材地址（可选，自动下载后发布）' },
        mediaPath: { type: 'string', description: '本地素材路径' },
      },
      required: ['platform', 'accountId', 'title'],
    },
  },
  {
    name: 'appAgentChat',
    description: '向知音中枢 Agent（AgnesAI 驱动）发送自然语言指令并等待执行完成；Agent 会自主调用创作、发布、采集、回复等工具完成全自动任务。',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '自然语言指令，如：把这篇图文发布到小红书账号1' },
      },
      required: ['message'],
    },
  },
  {
    name: 'appEvolve',
    description: '触发知音 AI 自进化：复盘最近的运行事件，自动沉淀运行逻辑、短板、提示词与账号数据经验到知识库。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'appCurate',
    description: '运行知音技能库维护（Hermes Curator）：自动归档久未使用的技能，可选让 AI 合并重复/过时技能。',
    inputSchema: {
      type: 'object',
      properties: {
        consolidate: { type: 'boolean', description: '是否让 AI 合并与修补重复技能（默认 false，仅自动归档）' },
      },
    },
  },
  {
    name: 'appBrowser',
    description: '直接调用知音浏览器工具（browser.pages/open/evaluate/click/type/waitFor/text/screenshot/launch），参数见 params。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: '浏览器工具动作（不含 browser. 前缀）' },
        params: { type: 'object', description: '工具参数，如 {engine,url} / {expression} / {selector,text}' },
      },
      required: ['action'],
    },
  },
  {
    name: 'appExportDataset',
    description: '导出模型微调数据集（ChatML JSONL），用于对 AI 模型进行微调。',
    inputSchema: { type: 'object', properties: {} },
  },
];

function jsonRpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function jsonRpcResult(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}

function textContent(text: string) {
  return { content: [{ type: 'text', text }] };
}

export class AppControlMcpServer {
  private server: Server | null = null;

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  start(): void {
    if (this.server) return;
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    this.server.listen(APP_CONTROL_MCP_PORT, '127.0.0.1', () => {
      console.log(`[app-control-mcp] 知音 APP 控制服务已启动: ${APP_CONTROL_MCP_URL}`);
    });
    this.server.on('error', (error) => {
      console.error('[app-control-mcp] 服务异常:', error);
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  private async handleRequest(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<void> {
    const url = req.url ?? '';

    // GET /mcp：SSE 长连接（部分 MCP 客户端会先探测），保持简单心跳
    if (req.method === 'GET' && url.startsWith('/mcp')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      const timer = setInterval(() => res.write(': keepalive\n\n'), 15000);
      req.on('close', () => clearInterval(timer));
      return;
    }

    if (req.method !== 'POST' || !url.startsWith('/mcp')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(jsonRpcError(null, -32601, 'Not found')));
      return;
    }

    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1024 * 1024) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(jsonRpcError(null, -32600, 'Request too large')));
        return;
      }
    }

    let payload: { method?: string; id?: unknown; params?: Record<string, unknown> };
    try {
      payload = JSON.parse(body || '{}');
    }
    catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(jsonRpcError(null, -32700, 'Parse error')));
      return;
    }

    const method = payload.method ?? '';
    const id = payload.id;
    const params = payload.params ?? {};

    try {
      switch (method) {
        case 'initialize': {
          const result = {
            protocolVersion: '2025-03-26',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: '知音APP控制', version: '1.0.0' },
          };
          this.writeJson(res, 200, jsonRpcResult(id, result));
          return;
        }
        case 'notifications/initialized':
          res.writeHead(202);
          res.end();
          return;
        case 'tools/list': {
          const result = { tools: TOOLS };
          this.writeJson(res, 200, jsonRpcResult(id, result));
          return;
        }
        case 'tools/call': {
          const toolName = String(params.name ?? '');
          const args = (params.arguments ?? {}) as Record<string, unknown>;
          const toolResult = await this.callTool(toolName, args);
          this.writeJson(res, 200, jsonRpcResult(id, toolResult));
          return;
        }
        case 'ping':
          this.writeJson(res, 200, jsonRpcResult(id, {}));
          return;
        default:
          this.writeJson(res, 200, jsonRpcError(id, -32601, `Method not found: ${method}`));
      }
    }
    catch (error) {
      console.error('[app-control-mcp] 调用失败:', error);
      this.writeJson(res, 500, jsonRpcError(id, -32603, String(error instanceof Error ? error.message : error)));
    }
  }

  private writeJson(res: import('node:http').ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'appNavigateTo': {
        const page = String(args.page ?? '').trim();
        const route = PAGE_ROUTES[page] ?? PAGE_ROUTES[page.toLowerCase()];
        if (!route) {
          return { ...textContent(`未知页面：${page}。可选页面：首页、内容创作、AI互动、任务记录、知识库、账号管理、设置、热点内容`), isError: true };
        }
        await this.runInRenderer(`window.location.hash = ${JSON.stringify(route)}; true`);
        return textContent(`已跳转到「${page}」（${route}）`);
      }
      case 'appGetCurrentPage':
        return textContent(JSON.stringify(await this.readRendererState()));
      case 'appGetAppState': {
        const state = await this.readRendererState();
        const win = this.getWindow();
        return textContent(JSON.stringify({
          ...state,
          windowTitle: win?.getTitle() ?? '',
          appName: '知音AI内容创作营销系统',
        }));
      }
      case 'appOpenAiChat': {
        const prompt = String(args.prompt ?? '').trim();
        // 与前端统一指令契约保持一致：detail 载荷为 { message }
        const payload = JSON.stringify({ message: prompt });
        await this.runInRenderer(`window.dispatchEvent(new CustomEvent('zhiyin:open-ai-chat', { detail: ${payload} })); true`);
        return textContent(prompt ? `已唤起 AI 助手面板并预填问题。` : '已唤起 AI 助手面板。');
      }
      case 'appListAccounts': {
        const kernel = getKernelRuntime();
        if (!kernel) {
          return { ...textContent('知音内核未启动'), isError: true };
        }
        const result = await kernel.invoke('accounts.list', {
          platform: args.platform ? String(args.platform) : undefined,
        });
        return textContent(JSON.stringify(result));
      }
      case 'appPublish': {
        const kernel = getKernelRuntime();
        if (!kernel) {
          return { ...textContent('知音内核未启动'), isError: true };
        }
        const media = await materializeMedia(args);
        const result = (await kernel.invoke('content.publish', {
          platform: String(args.platform ?? ''),
          accountId: Number(args.accountId ?? 0),
          title: String(args.title ?? ''),
          desc: args.desc ? String(args.desc) : undefined,
          mediaType: (args.mediaType as string) || 'image',
          mediaPath: media.mediaPath,
          mediaPaths: media.mediaPaths,
          mediaUrl: args.mediaUrl ? String(args.mediaUrl) : undefined,
        })) as Record<string, unknown> | null;
        return textContent(JSON.stringify({
          ...(result ?? {}),
          downloadedPaths: media.mediaPaths,
        }));
      }
      case 'appAgentChat': {
        const kernel = getKernelRuntime();
        if (!kernel) {
          return { ...textContent('知音内核未启动'), isError: true };
        }
        const message = String(args.message ?? '').trim();
        if (!message) {
          return { ...textContent('message 不能为空'), isError: true };
        }
        // 记忆强制前置注入：把用户长期记忆带进本轮对话，根治「AI 失忆/反复询问已说过的事」
        // （模型不再依赖自觉调用 recallMemory 才能想起）
        let memoryNote = '';
        try {
          const memos = kernel.evolution.listMemory('user').slice(-3);
          if (memos.length > 0) {
            memoryNote = '\n\n【用户长期记忆（直接采用，不要反问、不要编造）】\n'
              + memos.map((m: any) => '- ' + String(m.content ?? '')).join('\n');
          }
        }
        catch {
          // 记忆读取失败不影响对话
        }
        const result = await kernel.chat(`mcp-${Date.now()}`, message + memoryNote);
        return textContent(JSON.stringify(result));
      }
      case 'appEvolve': {
        const kernel = getKernelRuntime();
        if (!kernel) {
          return { ...textContent('知音内核未启动'), isError: true };
        }
        const result = await kernel.evolution.analyze();
        const learned = result.learned.map((entry) => entry.title);
        return textContent(JSON.stringify({
          digested: result.digested,
          learnedCount: result.learned.length,
          learned,
        }));
      }
      case 'appCurate': {
        const kernel = getKernelRuntime();
        if (!kernel) {
          return { ...textContent('知音内核未启动'), isError: true };
        }
        const result = await kernel.invoke('evolution.curate', {
          consolidate: args.consolidate === true,
        });
        return textContent(JSON.stringify(result));
      }
      case 'appBrowser': {
        const kernel = getKernelRuntime();
        if (!kernel) {
          return { ...textContent('知音内核未启动'), isError: true };
        }
        const action = String(args.action ?? '');
        if (!/^(pages|open|evaluate|click|type|waitFor|text|screenshot|launch)$/.test(action)) {
          return { ...textContent('未知浏览器动作'), isError: true };
        }
        const result = await kernel.invoke(`browser.${action}`, args.params || {});
        return textContent(JSON.stringify(result));
      }
      case 'appExportDataset': {
        const kernel = getKernelRuntime();
        if (!kernel) {
          return { ...textContent('知音内核未启动'), isError: true };
        }
        const samples = kernel.evolution.exportFineTuneDataset();
        const dir = path.join(app.getPath('userData'), '知音知识库', '微调数据');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `dataset-${Date.now()}.jsonl`);
        const lines = samples.map((sample) => JSON.stringify(sample)).join('\n');
        fs.writeFileSync(file, `${lines}\n`, 'utf8');
        return textContent(JSON.stringify({ sampleCount: samples.length, file }));
      }
      default:
        return { ...textContent(`未知工具：${name}`), isError: true };
    }
  }

  private async runInRenderer(script: string): Promise<void> {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) {
      throw new Error('知音桌面端窗口不可用');
    }
    await win.webContents.executeJavaScript(script, true);
  }

  private async readRendererState(): Promise<Record<string, string>> {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) {
      return { error: '知音桌面端窗口不可用' };
    }
    const state = await win.webContents.executeJavaScript(
      `(() => {
        const title = document.querySelector('.page-title')?.textContent?.trim() || '';
        return { hash: window.location.hash || '', pageTitle: title };
      })()`,
      true,
    ) as Record<string, string>;
    return state;
  }
}
