/**
 * 内置知识库 ↔ 知音内核桥：让“用户看到的知识库”就是“AI 决策用的知识库”。
 *
 * 方向一（启动）：把内置库用户文档全部导入内核，AI 检索即时可见；
 * 方向二（编辑）：用户在知识库增删改，实时同步回内核；
 * 规则热更：06-平台发布规则.json 修改后立即生效于内核发布校验。
 *
 * 自动目录（运行逻辑/短板/提示词/账号数据/微调数据/自进化/自动工作日志）
 * 由系统单向写出，不反向导入，避免与内核原始条目重复。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { getKernelRuntime } from '../zhiyin/runtime';
import type {
  HarnessDataStore,
  KnowledgeEntry,
  PlatformPublishRule,
} from '../../../../bosom-friend-harness/src/index';

const PLATFORM_RULES_FILE = '06-平台发布规则.json';
const AUTO_DIRS = new Set([
  '运行逻辑',
  '短板',
  '提示词',
  '账号数据',
  '微调数据',
  '自进化',
  '自动工作日志',
]);
const MAX_NOTE_BYTES = 512 * 1024;

function normalize(relPath: string): string {
  return relPath.replace(/\\/g, '/');
}

function isAutoManaged(relPath: string): boolean {
  return AUTO_DIRS.has(normalize(relPath).split('/')[0] ?? '');
}

function toEntry(relPath: string, title: string, content: string): KnowledgeEntry {
  const now = new Date().toISOString();
  return {
    id: `vault:${normalize(relPath)}`,
    title,
    content,
    category: 'system',
    locked: false,
    createdAt: now,
    updatedAt: now,
  };
}

async function readNote(
  vaultRoot: string,
  relPath: string,
): Promise<{ title: string; content: string } | null> {
  if (isAutoManaged(relPath))
    return null;
  const root = path.resolve(vaultRoot);
  const abs = path.resolve(root, relPath);
  if (!abs.startsWith(`${root}${path.sep}`))
    return null;
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat?.isFile() || stat.size > MAX_NOTE_BYTES)
    return null;
  const content = await fs.readFile(abs, 'utf8');
  const title = path.basename(abs).replace(/\.(md|json)$/i, '');
  return { title, content };
}

function applyPlatformRules(store: HarnessDataStore, content: string): void {
  try {
    const parsed = JSON.parse(content) as Record<string, PlatformPublishRule>;
    if (parsed && typeof parsed === 'object')
      store.setPlatformRules(parsed);
  }
  catch {
    // 规则文件损坏时保留旧规则，不让发布链路中断
  }
}

/** 启动时：把内置知识库的用户文档导入内核（自动目录除外），并装载平台发布规则 */
export async function importVaultToKernel(
  vaultRoot: string,
): Promise<{ imported: number; skippedAuto: number }> {
  const runtime = getKernelRuntime();
  if (!runtime)
    return { imported: 0, skippedAuto: 0 };

  const entries: KnowledgeEntry[] = [];
  let skippedAuto = 0;
  const walk = async (dir: string, rel: string): Promise<void> => {
    const items = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const item of items) {
      if (item.name.startsWith('.'))
        continue;
      const relPath = rel ? `${rel}/${item.name}` : item.name;
      if (item.isDirectory()) {
        if (AUTO_DIRS.has(item.name)) {
          skippedAuto += 1;
          continue;
        }
        await walk(path.join(dir, item.name), relPath);
        continue;
      }
      if (!/\.(md|json)$/i.test(item.name))
        continue;
      const note = await readNote(vaultRoot, relPath);
      if (!note)
        continue;
      entries.push(toEntry(relPath, note.title, note.content));
      if (normalize(relPath) === PLATFORM_RULES_FILE)
        applyPlatformRules(runtime.store, note.content);
    }
  };
  await walk(vaultRoot, '');

  runtime.store.seedKnowledge(entries);
  void runtime.store.persist();
  return { imported: entries.length, skippedAuto };
}

/** 用户在知识库新建/修改笔记后，实时同步进内核（含平台发布规则热更新） */
export async function syncVaultNoteToKernel(
  vaultRoot: string,
  relPath: string,
): Promise<void> {
  const runtime = getKernelRuntime();
  if (!runtime)
    return;
  const note = await readNote(vaultRoot, relPath);
  if (!note)
    return;
  if (normalize(relPath) === PLATFORM_RULES_FILE)
    applyPlatformRules(runtime.store, note.content);
  runtime.store.seedKnowledge([toEntry(relPath, note.title, note.content)]);
  void runtime.store.persist();
}

/** 用户在知识库删除/重命名笔记后，从内核移除对应条目 */
export function removeVaultNoteFromKernel(relPath: string): void {
  const runtime = getKernelRuntime();
  if (!runtime || isAutoManaged(relPath))
    return;
  runtime.store.removeKnowledge(`vault:${normalize(relPath)}`);
  void runtime.store.persist();
}
