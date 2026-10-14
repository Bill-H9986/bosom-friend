/**
 * KnowledgeAutoLog - 知识库自动记录
 *
 * 在关键业务事件（应用启动 / 发布成功 / 评论回复 / 私信回复）时，
 * 自动把一条带时间戳的记录追加到库内 `自动工作日志/YYYY-MM-DD.md`，
 * 无需人工录入（自动记录，而非被动记录）。
 */
import { app } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { store } from '../../global/store';

const VAULT_KEY = 'zhiyin-knowledge-vault';

export async function appendAutoLog(category: string, content: string): Promise<string> {
  try {
    const saved = store.get(VAULT_KEY) as string | undefined;
    const vault = saved || path.join(app.getPath('userData'), '知音知识库');
    const dir = path.join(vault, '自动工作日志');
    await fs.mkdir(dir, { recursive: true });

    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const file = path.join(dir, `${y}-${m}-${d}.md`);
    const line = `- ${hh}:${mm}:${ss} 【${category}】${content}\n`;
    await fs.appendFile(file, line, 'utf-8');
    return file;
  }
  catch (e) {
    console.error('[kb-auto-log] 写入失败', e);
    return '';
  }
}
