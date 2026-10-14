/**
 * KnowledgeService - 内置知识库服务（Obsidian 兼容）
 *
 * 知识库随应用内置（种子库随安装包分发），默认存放在应用数据目录
 * （userData/知音知识库），首次启动自动从种子库初始化，因此用户下载
 * 软件即可直接使用，无需单独下载知识库或依赖本地 Obsidian。
 * 文件格式与 Obsidian 完全兼容（.md + [[双向链接]]），
 * 同时支持用户挂载任意外部 Obsidian 库目录。
 */
import { Injectable } from '../core/decorators';
import { app, dialog, BrowserWindow } from 'electron';
import fs from 'fs/promises';
import { readdirSync } from 'node:fs';
import path from 'path';
import { store } from '../../global/store';

const VAULT_KEY = 'zhiyin-knowledge-vault';
const VAULT_DIR_NAME = '知音知识库';
const SEED_DIR_NAME = 'knowledge-seed';

export interface KbNode {
  name: string;
  /** 相对库根的路径（文件夹用 / 分隔，笔记含 .md 后缀） */
  path: string;
  type: 'folder' | 'note';
  /** 是否为内置种子文档（不可删除/重命名） */
  protected?: boolean;
  children?: KbNode[];
}

export interface KbSearchHit {
  path: string;
  name: string;
  snippet: string;
}

function defaultVaultPath(): string {
  return path.join(app.getPath('userData'), VAULT_DIR_NAME);
}

/** 随包种子库目录：打包后位于 resources/knowledge-seed，开发时位于项目 resources/ */
function seedVaultPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, SEED_DIR_NAME);
  }
  return path.join(app.getAppPath(), 'resources', SEED_DIR_NAME);
}

/** 首次启动：若内置库目录不存在或为空，从随包种子库初始化 */
export async function ensureSeedInitialized(targetDir: string): Promise<void> {
  try {
    await fs.mkdir(targetDir, { recursive: true });
    const existing = await fs.readdir(targetDir);
    if (existing.length > 0) {
      return;
    }

    const seedDir = seedVaultPath();
    await fs.access(seedDir);
    await fs.cp(seedDir, targetDir, { recursive: true });
  }
  catch (e) {
    console.error('[knowledge] 内置知识库种子初始化失败', e);
  }
}

/** 是否为内置种子文档（用于防止删除/重命名） */
function isSeedFilePath(relPath: string): boolean {
  try {
    const candidates = [
      seedVaultPath(),
      path.join(process.cwd(), 'resources', SEED_DIR_NAME),
      path.join(app.getAppPath(), 'resources', SEED_DIR_NAME),
    ];
    const entries: Array<{ isFile(): boolean, name: string }> = [];
    for (const dir of candidates) {
      try {
        entries.push(...readdirSync(dir, { withFileTypes: true }));
      }
      catch {
        // 尝试下一个候选目录
      }
    }
    if (entries.length === 0) {
      console.warn('[knowledge] 未找到内置种子目录，候选:', candidates);
      return false;
    }
    return entries.some(entry =>
      entry.isFile()
      && entry.name.endsWith('.md')
      && (relPath === entry.name || relPath.endsWith(`/${entry.name}`)),
    );
  }
  catch (e) {
    console.error('[knowledge] 判断种子文档失败:', e);
    return false;
  }
}

@Injectable()
export class KnowledgeService {
  getVaultPath(): string {
    const saved = store.get(VAULT_KEY) as string | undefined;
    return saved || defaultVaultPath();
  }

  async chooseVault(): Promise<string> {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return this.getVaultPath();
    const result = await dialog.showOpenDialog(win, {
      title: '选择 Obsidian 库文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return this.getVaultPath();
    const dir = result.filePaths[0];
    store.set(VAULT_KEY, dir);
    return dir;
  }

  private async ensureVault(): Promise<string> {
    const dir = this.getVaultPath();
    await ensureSeedInitialized(dir);
    return dir;
  }

  /** 安全解析相对路径，防止越出库根 */
  private safeResolve(root: string, relPath: string): string {
    const abs = path.resolve(root, relPath);
    if (!abs.startsWith(path.resolve(root))) {
      throw new Error('非法路径');
    }
    return abs;
  }

  async listTree(): Promise<KbNode[]> {
    const root = await this.ensureVault();
    return this.walk(root, '');
  }

  private async walk(dir: string, rel: string): Promise<KbNode[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const nodes: KbNode[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        nodes.push({
          name: entry.name,
          path: relPath,
          type: 'folder',
          children: await this.walk(path.join(dir, entry.name), relPath),
        });
      }
      else if (entry.name.endsWith('.md')) {
        nodes.push({
          name: entry.name.replace(/\.md$/, ''),
          path: relPath,
          type: 'note',
          protected: isSeedFilePath(relPath),
        });
      }
    }
    nodes.sort((a, b) =>
      a.type === b.type
        ? a.name.localeCompare(b.name, 'zh-CN')
        : a.type === 'folder' ? -1 : 1,
    );
    return nodes;
  }

  async readNote(relPath: string): Promise<{ path: string, content: string }> {
    const root = await this.ensureVault();
    const abs = this.safeResolve(root, relPath);
    const content = await fs.readFile(abs, 'utf-8');
    return { path: relPath, content };
  }

  async writeNote(relPath: string, content: string): Promise<boolean> {
    const root = await this.ensureVault();
    const abs = this.safeResolve(root, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf-8');
    return true;
  }

  async createNote(relPath: string, content = ''): Promise<string> {
    const root = await this.ensureVault();
    const normalized = relPath.endsWith('.md') ? relPath : `${relPath}.md`;
    const abs = this.safeResolve(root, normalized);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf-8');
    return normalized;
  }

  async deleteNote(relPath: string): Promise<boolean> {
    if (isSeedFilePath(relPath)) {
      throw new Error('内置文档不可删除');
    }
    const root = await this.ensureVault();
    const abs = this.safeResolve(root, relPath);
    await fs.unlink(abs);
    return true;
  }

  async renameNote(oldPath: string, newPath: string): Promise<string> {
    if (isSeedFilePath(oldPath)) {
      throw new Error('内置文档不可重命名');
    }
    const root = await this.ensureVault();
    const from = this.safeResolve(root, oldPath);
    const to = this.safeResolve(root, newPath.endsWith('.md') ? newPath : `${newPath}.md`);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.rename(from, to);
    return to.slice(root.length + 1);
  }

  /** 全库搜索（标题 + 正文片段） */
  async searchNotes(query: string): Promise<KbSearchHit[]> {
    const root = await this.ensureVault();
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const hits: KbSearchHit[] = [];
    const walk = async (dir: string, rel: string) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(abs, relPath);
        }
        else if (entry.name.endsWith('.md')) {
          const content = await fs.readFile(abs, 'utf-8');
          const lower = content.toLowerCase();
          const idx = lower.indexOf(q);
          if (idx >= 0) {
            const start = Math.max(0, idx - 24);
            hits.push({
              path: relPath,
              name: entry.name.replace(/\.md$/, ''),
              snippet: content.slice(start, start + 72).replace(/\n+/g, ' '),
            });
          }
        }
      }
    };
    await walk(root, '');
    return hits;
  }

  /** 反向链接：扫描全库引用当前笔记的 [[名称]] */
  async getBacklinks(relPath: string): Promise<KbSearchHit[]> {
    const root = await this.ensureVault();
    const targetName = path.basename(relPath).replace(/\.md$/, '');
    const hits: KbSearchHit[] = [];
    const walk = async (dir: string, rel: string) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const relPath2 = rel ? `${rel}/${entry.name}` : entry.name;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(abs, relPath2);
        }
        else if (entry.name.endsWith('.md') && relPath2 !== relPath) {
          const content = await fs.readFile(abs, 'utf-8');
          const pattern = new RegExp(`\\[\\[\\s*${escapeRegExp(targetName)}\\s*\\]\\]`);
          if (pattern.test(content)) {
            const idx = content.search(pattern);
            const start = Math.max(0, idx - 24);
            hits.push({
              path: relPath2,
              name: entry.name.replace(/\.md$/, ''),
              snippet: content.slice(start, start + 72).replace(/\n+/g, ' '),
            });
          }
        }
      }
    };
    await walk(root, '');
    return hits;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
