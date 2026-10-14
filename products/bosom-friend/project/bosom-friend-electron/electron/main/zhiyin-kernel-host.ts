/**
 * 知音内核 · Electron 宿主桥
 *
 * 内核本体在 project/bosom-friend-harness（零旧代码依赖），
 * 本文件只负责：装配实例、注册 IPC、把事件转发给渲染进程。
 */
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { ipcMain, type BrowserWindow } from 'electron';
import {
  createHarness,
  HarnessDataStore,
  type HarnessRuntime,
} from '../../../bosom-friend-harness/src/index';
import { buildPlatformAdapters } from './zhiyin/adapters';
import { getKernelRuntime as getRuntime, setKernelRuntime } from './zhiyin/runtime';
import { buildBrowserBridge } from './zhiyin/browser-bridge';
import { importVaultToKernel } from './knowledge/kernel-sync';
import { ensureSeedInitialized } from './knowledge/service';
import { applyUserModelConfigToEnv } from './config/userModelConfig';
import type { AgentEvent, KnowledgeEntry } from '../../../bosom-friend-harness/src/index';

export const ZHIYIN_EVENT_CHANNEL = 'zhiyin:harness:event';

export interface KernelHostOptions {
  dataDir: string;
  libraryDir: string;
  getWindow: () => BrowserWindow | null;
}

/** 内置知识库分类目录：运行逻辑 / 短板 / 提示词 / 账号数据 / 自进化 */
const EVOLUTION_DIRS: Record<string, string> = {
  runtime: '运行逻辑',
  shortfall: '短板',
  prompt: '提示词',
  account: '账号数据',
  evolution: '自进化',
};

function knowledgeRoot(dataDir: string): string {
  return path.join(dataDir, '知音知识库');
}

/** 自进化分析产出新知识后，同步写入 APP 内置知识库对应分类目录 */
async function syncEvolutionKnowledge(dataDir: string, event: AgentEvent): Promise<void> {
  const entries = ((event.data ?? {}) as { entries?: KnowledgeEntry[] }).entries;
  if (!Array.isArray(entries) || entries.length === 0)
    return;
  try {
    for (const entry of entries) {
      const dir = path.join(knowledgeRoot(dataDir), EVOLUTION_DIRS[entry.category] ?? '自进化');
      await fsp.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${entry.id}.md`);
      const body = [
        `# ${entry.title}`,
        '',
        `> 分类：${EVOLUTION_DIRS[entry.category] ?? entry.category} · 由 AI 自进化沉淀`,
        '',
        entry.content,
        '',
        `- 更新时间：${new Date().toLocaleString('zh-CN')}`,
        '',
      ].join('\n');
      await fsp.writeFile(file, body, 'utf8');
    }
  }
  catch (error) {
    console.warn('[kernel-host] 同步自进化知识失败:', error);
  }
}

/** 把内核的技能库与长期记忆快照同步到内置知识库《自进化》目录，供用户查看 AI 沉淀 */
async function syncSelfEvolution(dataDir: string): Promise<void> {
  const runtime = getKernelRuntime();
  if (!runtime)
    return;
  const dir = path.join(knowledgeRoot(dataDir), '自进化');
  try {
    await fsp.mkdir(dir, { recursive: true });

    const skills = runtime.store.listSkills().filter((s) => s.state !== 'archived');
    const skillBody = skills
      .map((s) => [
        `### ${s.name}`,
        '',
        `- 描述：${s.description}`,
        `- 领域：${s.domain}`,
        `- 使用 ${s.useCount} 次 · 评分 ${s.score} · 状态：${s.state === 'stale' ? '闲置待清理' : '正常'}`,
        '',
        '步骤：',
        '',
        s.instructions,
        '',
      ].join('\n'))
      .join('\n');
    const skillsMd = [
      '# 技能库（AI 自进化沉淀）',
      '',
      '> 由知音内核自动维护：复杂任务成功后，AI 会把可复用流程保存为技能，之后同类任务直接复用并持续改进（对齐 Hermes Skills）。',
      '',
      `## 当前技能（${skills.length} 个）`,
      '',
      skillBody || '暂无技能沉淀。',
      '',
    ].join('\n');
    await fsp.writeFile(path.join(dir, '技能库.md'), skillsMd, 'utf8');

    const memories = runtime.store.listMemory();
    const agentItems = memories.filter((m) => m.kind === 'agent');
    const userItems = memories.filter((m) => m.kind === 'user');
    const section = (title: string, items: typeof memories) => [
      `## ${title}（${items.length} 条）`,
      '',
      ...(items.length
        ? items.map((m) => `- ${m.content}`)
        : ['暂无。']),
      '',
    ].join('\n');
    const memoryMd = [
      '# 长期记忆（AI 自进化沉淀）',
      '',
      '> 由知音内核自动维护：运行事实与用户画像分别沉淀（对齐 Hermes MEMORY.md / USER.md），有字数上限，满了 AI 会先合并旧记忆。',
      '',
      section('运行事实', agentItems),
      section('用户画像', userItems),
    ].join('\n');
    await fsp.writeFile(path.join(dir, '长期记忆.md'), memoryMd, 'utf8');
  }
  catch (error) {
    console.warn('[kernel-host] 同步技能/记忆失败:', error);
  }
}

/** 连续记录运行事件到内置知识库《运行逻辑/运行事件日志.md》，支撑 AI 复盘与微调 */
function summarizeEvent(event: AgentEvent): string {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const clip = (value: unknown, max = 160): string => {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    return text.length > max ? `${text.slice(0, max)}…` : text;
  };
  switch (event.type) {
    case 'agent.tool_call':
      // 只记工具名，不把整篇草稿/提示词正文写进日志
      return `工具调用：${clip(data.name ?? '未知工具', 80)}`;
    case 'agent.tool_result':
      return `工具结果：${clip(data.name ?? '工具', 80)} · ${clip(data.summary ?? (data.ok ? '成功' : '失败'), 120)}`;
    case 'agent.done':
      return `任务完成：${clip(data.content, 200)}`;
    case 'agent.error':
      return `任务失败：${clip(data.error, 200)}`;
    case 'interaction.created':
      return `接待互动：${clip(data.kind, 20)} · ${clip(data.platform, 20)} · ${clip(data.status, 20)}`;
    case 'work.updated':
      return '平台作品数据已同步';
    default:
      return clip(data, 200);
  }
}

async function appendRunEventLog(dataDir: string, event: AgentEvent): Promise<void> {
  try {
    const dir = path.join(knowledgeRoot(dataDir), '运行逻辑');
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, '运行事件日志.md');
    const line = `- ${new Date().toISOString()} [${event.type}] ${summarizeEvent(event)}\n`;
    if (fs.existsSync(file)) {
      const stat = await fsp.stat(file);
      if (stat.size > 512 * 1024)
        await fsp.rename(file, `${file}.old-${Date.now()}`);
    }
    await fsp.appendFile(file, line, 'utf8');
  }
  catch (error) {
    console.warn('[kernel-host] 记录运行事件失败:', error);
  }
}

/** 供旧轮询驱动与知识库桥读取当前内核（旧模块逐步迁移期间使用） */
export function getKernelRuntime(): HarnessRuntime | null {
  return getRuntime();
}

function registerZhiyinIpc(runtime: HarnessRuntime, dataDir: string): void {
  ipcMain.handle(
    'zhiyin:harness:invoke',
    async (_event, payload: { action: string; input?: unknown }) => {
      const result = await runtime.invoke(payload?.action || '', payload?.input || {});
      const action = payload?.action;
      if (
        action === 'skills.save'
        || action === 'skills.use'
        || action === 'memory.save'
        || action === 'evolution.curate'
      ) {
        void syncSelfEvolution(dataDir);
      }
      return result;
    },
  );

  ipcMain.handle(
    'zhiyin:harness:workflow',
    async (
      _event,
      payload: {
        domain: 'content' | 'platform' | 'automation';
        sessionId?: string;
        input: Record<string, unknown>;
      },
    ) => {
      const sessionId = payload?.sessionId || `workflow-${Date.now()}`;
      const input = payload?.input || { prompt: '', sessionId };
      return runtime.runWorkflow(payload?.domain || 'content', {
        prompt: input.prompt ? String(input.prompt) : '',
        sessionId,
        mediaType: input.mediaType as 'image' | 'video' | 'text' | undefined,
        platforms: Array.isArray(input.platforms)
          ? input.platforms.map(String)
          : undefined,
        ...input,
      }, sessionId);
    },
  );

  ipcMain.on(
    'zhiyin:harness:chat',
    (event, payload: { sessionId?: string; message: string }) => {
      const sessionId = payload?.sessionId || 'default-session';
      const message = payload?.message || '';
      if (!message.trim()) return;
      void runtime.chat(sessionId, message).then((result) => {
        event.sender.send(ZHIYIN_EVENT_CHANNEL, {
          type: result.ok ? 'agent.done' : 'agent.error',
          sessionId,
          data: result,
        });
      });
    },
  );
}

export async function startZhiyinKernelHost(
  options: KernelHostOptions,
): Promise<HarnessRuntime> {
  // 大模型 Key 全部来自用户配置（设置 → 自定义大模型），不再读取随包密钥文件。
  // 内核的 Agnes LLM 客户端（createHarness → loadLlmConfig）从环境变量读取，
  // 缺 Key 时 Agent 调用大模型会给出明确的“未配置”错误。
  applyUserModelConfigToEnv();
  const filePath = path.join(options.dataDir, 'zhiyin-harness.json');
  const store = new HarnessDataStore({ filePath });
  await store.load();
  const runtime = createHarness({
    store,
    libraryDir: options.libraryDir,
    adapters: buildPlatformAdapters(),
    browser: buildBrowserBridge(),
  });
  setKernelRuntime(runtime);
  // 内置知识库（用户可见、可编辑）与内核（AI 决策）打通：启动即导入全部用户文档与平台规则
  const builtInVault = knowledgeRoot(options.dataDir);
  await ensureSeedInitialized(builtInVault);
  await importVaultToKernel(builtInVault);
  registerZhiyinIpc(runtime, options.dataDir);
  runtime.onEvent((event) => {
    const win = options.getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(ZHIYIN_EVENT_CHANNEL, event);
    }
    if (event.type === 'evolution.learned') {
      void syncEvolutionKnowledge(options.dataDir, event);
    }
    else if (event.type === 'evolution.maintained') {
      void syncSelfEvolution(options.dataDir);
    }
    else if (
      event.type === 'agent.tool_call'
      || event.type === 'agent.tool_result'
      || event.type === 'agent.done'
      || event.type === 'agent.error'
      || event.type === 'interaction.created'
      || event.type === 'work.updated'
    ) {
      void appendRunEventLog(options.dataDir, event);
    }
  });
  runtime.start();
  return runtime;
}
