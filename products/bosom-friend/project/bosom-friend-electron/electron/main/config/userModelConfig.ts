/**
 * 用户级大模型配置（Agnes 国内站 · OpenAI 兼容接口）
 *
 * 设计原则：
 * - 知音不内置任何默认 API Key，Key 只能由用户本人到 Agnes 国内站开放平台申请后填写。
 * - 密钥只保存在本机用户目录（electron-store），绝不随仓库或安装包分发。
 * - 主进程启动时把用户配置注入 AGNES_* 环境变量，知音内核与随包后端共用同一份配置。
 * - 对外（渲染进程）只回传“是否已配置”，不回传明文 Key。
 */
import { ipcMain, shell } from 'electron';
import { store } from '../../global/store';
import { restartAiService } from '../backend/backendLauncher';

export const MODEL_STORE_KEY = 'zhiyin-model-config';

/** 旧版「自定义大模型」多厂商配置键（0.9.1 之前），升级时自动迁移到新配置 */
const LEGACY_STORE_KEY = 'zhiyin-custom-llm';

/** Agnes 国内站 API 申请入口（用户自行注册并创建 Key） */
export const AGNES_APPLY_URL = 'https://platform.agnes-ai.cn/';

/** Agnes 国内站 API 接口地址 */
export const AGNES_DEFAULT_BASE_URL = 'https://api.agnes-ai.cn/v1';

/** Agnes 国内站三通道默认模型 */
export const AGNES_DEFAULT_MODEL = {
  chat: 'agnes-2.5-flash',
  image: 'agnes-image-2.1-flash',
  video: 'agnes-video-v2.0',
} as const;

export interface UserModelChannel {
  apiKey: string;
  model: string;
}

export interface UserModelConfig {
  baseUrl: string;
  chat: UserModelChannel;
  image: UserModelChannel;
  video: UserModelChannel;
}

/** 渲染进程可见的安全视图：只含是否已配置，不含明文 Key */
export interface UserModelPublicConfig {
  baseUrl: string;
  chat: { hasApiKey: boolean; model: string };
  image: { hasApiKey: boolean; model: string };
  video: { hasApiKey: boolean; model: string };
}

export interface UserModelSaveInput {
  baseUrl?: string;
  chat?: { apiKey?: string; model?: string };
  image?: { apiKey?: string; model?: string };
  video?: { apiKey?: string; model?: string };
}

function normalizeChannel(
  value: unknown,
  defaultModel: string,
): UserModelChannel {
  const v = (value ?? {}) as Partial<UserModelChannel>;
  return {
    apiKey: typeof v.apiKey === 'string' ? v.apiKey.trim() : '',
    model:
      typeof v.model === 'string' && v.model.trim()
        ? v.model.trim()
        : defaultModel,
  };
}

function normalize(value: unknown): UserModelConfig {
  const v = (value ?? {}) as Partial<UserModelConfig>;
  return {
    baseUrl:
      typeof v.baseUrl === 'string' && v.baseUrl.trim()
        ? v.baseUrl.trim().replace(/\/+$/, '')
        : AGNES_DEFAULT_BASE_URL,
    chat: normalizeChannel(v.chat, AGNES_DEFAULT_MODEL.chat),
    image: normalizeChannel(v.image, AGNES_DEFAULT_MODEL.image),
    video: normalizeChannel(v.video, AGNES_DEFAULT_MODEL.video),
  };
}

export function loadUserModelConfig(): UserModelConfig {
  const current = store.get(MODEL_STORE_KEY);
  if (current !== undefined && current !== null)
    return normalize(current);
  return migrateLegacyConfig() ?? normalize(undefined);
}

/**
 * 老版本升级无缝衔接：把旧版保存的激活厂商配置迁移到新结构。
 * 只迁移一次（新配置存在时不再处理），旧数据保留不删除。
 */
function migrateLegacyConfig(): UserModelConfig | null {
  try {
    const legacy = store.get(LEGACY_STORE_KEY);
    if (!legacy || typeof legacy !== 'object')
      return null;
    const providers = Array.isArray((legacy as { providers?: unknown }).providers)
      ? ((legacy as { providers: unknown[] }).providers)
      : [];
    const activeProviderId = (legacy as { activeProviderId?: string }).activeProviderId;
    const active = providers.find(
      p => p && (p as { id?: string }).id === activeProviderId && (p as { enabled?: boolean }).enabled,
    ) || providers.find(p => p && (p as { enabled?: boolean }).enabled);
    if (!active)
      return null;

    const pick = (channel: unknown, defaultModel: string): UserModelChannel => {
      const c = (channel ?? {}) as { apiKey?: string; model?: string };
      return {
        apiKey: typeof c.apiKey === 'string' ? c.apiKey.trim() : '',
        model: typeof c.model === 'string' && c.model.trim() ? c.model.trim() : defaultModel,
      };
    };
    const chat = (active as { chat?: unknown }).chat;
    const migrated = normalize({
      baseUrl: typeof (chat as { baseUrl?: string } | undefined)?.baseUrl === 'string'
        ? (chat as { baseUrl: string }).baseUrl
        : undefined,
      chat: pick(chat, AGNES_DEFAULT_MODEL.chat),
      image: pick((active as { image?: unknown }).image, AGNES_DEFAULT_MODEL.image),
      video: pick((active as { video?: unknown }).video, AGNES_DEFAULT_MODEL.video),
    });
    store.set(MODEL_STORE_KEY, migrated);
    return migrated;
  }
  catch (error) {
    console.warn('[model-config] 迁移旧版大模型配置失败:', error);
    return null;
  }
}

/**
 * 保存用户配置。Key 字段留空时保留原 Key（避免每次编辑都要重复粘贴），
 * 需要彻底移除请调用 clearUserModelConfig。
 *
 * 字段约定：
 * - 字段缺省（undefined）：保留已保存的值；
 * - 空字符串：显式清空该通道 Key（例如关闭“单独配置图像/视频”）；
 * - 非空字符串：覆盖为新 Key。
 */
export function saveUserModelConfig(input: UserModelSaveInput): UserModelConfig {
  const current = loadUserModelConfig();
  const next = normalize({
    baseUrl: input.baseUrl ?? current.baseUrl,
    chat: {
      apiKey: input.chat?.apiKey ?? current.chat.apiKey,
      model: input.chat?.model ?? current.chat.model,
    },
    image: {
      apiKey: input.image?.apiKey ?? current.image.apiKey,
      model: input.image?.model ?? current.image.model,
    },
    video: {
      apiKey: input.video?.apiKey ?? current.video.apiKey,
      model: input.video?.model ?? current.video.model,
    },
  });
  store.set(MODEL_STORE_KEY, next);
  return next;
}

export function clearUserModelConfig(): void {
  store.delete(MODEL_STORE_KEY);
}

/** 清除注入的 AGNES_* 环境变量（清除密钥时调用，避免旧 Key 残留继续生效） */
function clearModelConfigEnv(): void {
  for (const key of [
    'AGNES_BASE_URL',
    'AGNES_TEXT_API_KEY',
    'AGNES_TEXT_MODEL',
    'AGNES_IMAGE_API_KEY',
    'AGNES_IMAGE_MODEL',
    'AGNES_VIDEO_API_KEY',
    'AGNES_VIDEO_MODEL',
  ]) {
    delete process.env[key];
  }
}

export function publicUserModelConfig(): UserModelPublicConfig {
  const cfg = loadUserModelConfig();
  const view = (channel: UserModelChannel) => ({
    hasApiKey: Boolean(channel.apiKey),
    model: channel.model,
  });
  return {
    baseUrl: cfg.baseUrl,
    chat: view(cfg.chat),
    image: view(cfg.image),
    video: view(cfg.video),
  };
}

/**
 * 把用户配置注入进程环境（知音内核与随包后端子进程共用）。
 * 只写非空值、不删除环境变量：打包版无任何内置密钥，用户配置即唯一来源；
 * 开发机可继续用本地 .env 覆盖未填写项。
 *
 * 兜底规则：图像/视频未单独配置 Key 时，回退使用全局（文本）Key；
 * 三通道都单独配置时，各走各的 Key，互不影响。
 */
export function applyUserModelConfigToEnv(): void {
  const cfg = loadUserModelConfig();
  const set = (key: string, value: string) => {
    if (value)
      process.env[key] = value;
  };
  set('AGNES_BASE_URL', cfg.baseUrl);
  set('AGNES_TEXT_API_KEY', cfg.chat.apiKey);
  set('AGNES_TEXT_MODEL', cfg.chat.model);
  set('AGNES_IMAGE_API_KEY', cfg.image.apiKey || cfg.chat.apiKey);
  set('AGNES_IMAGE_MODEL', cfg.image.model);
  set('AGNES_VIDEO_API_KEY', cfg.video.apiKey || cfg.chat.apiKey);
  set('AGNES_VIDEO_MODEL', cfg.video.model);
}

/** 注册模型配置 IPC：读取/保存/清除/打开 Agnes 申请入口 */
export function registerUserModelConfigIpc(): void {
  ipcMain.handle('zhiyin:model:get', () => publicUserModelConfig());
  ipcMain.handle('zhiyin:model:save', async (_event, input: UserModelSaveInput) => {
    saveUserModelConfig(input ?? {});
    // 保存即生效：立即注入环境变量，并同步内核 LLM 配置（AI 接待/创作/自动回复热切换），
    // 同时热重启 AI 服务（Claude Agent 对话、内容创作图片/视频生成全部使用新配置）。
    applyUserModelConfigToEnv();
    try {
      // 延迟 require 避免与 zhiyin-kernel-host 的静态循环依赖；
      // 主进程为 CJS，用 require（不用动态 import）规避 Node20 的 ESM 翻译崩溃
      const kernelHost = require('../zhiyin-kernel-host') as typeof import('../zhiyin-kernel-host');
      kernelHost.getKernelRuntime()?.reloadLlmConfig();
    }
    catch (error) {
      console.warn('[model-config] 内核 LLM 配置热更新失败:', error);
    }
    void restartAiService();
    return { config: publicUserModelConfig(), needsRestart: false };
  });
  ipcMain.handle('zhiyin:model:clear', () => {
    clearUserModelConfig();
    clearModelConfigEnv();
    void restartAiService();
    return publicUserModelConfig();
  });
  ipcMain.handle('zhiyin:model:open-apply', () => {
    void shell.openExternal(AGNES_APPLY_URL);
  });
}
