/**
 * 用户数据生命周期迁移：老版本数据目录 → 当前统一数据目录。
 *
 * 背景：产品早期叫 aiToEarn，后来改名为知音，Electron 默认按应用名
 * 生成用户数据目录，导致旧数据留在 %APPDATA%\aiToEarn，新版本读的是
 * %APPDATA%\zhiyin，表现就是“数据还在但用不了”。
 *
 * 规则（安全第一）：
 * - 只补缺：目标位置已存在的内容绝不覆盖；
 * - 只复制：绝不删除旧目录；
 * - 只执行一次：完成后写标记文件，之后启动直接跳过。
 */
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { store } from '../../global/store';
import { logger } from '../../global/log';

const LEGACY_DIR_NAMES = ['aiToEarn', 'AiToEarn', '知音'];
const MIGRATION_MARKER = '.zhiyin-userdata-migrated';

const MIGRATABLE_FILES = [
  'database.sqlite',
  'database.sqlite-wal',
  'database.sqlite-shm',
  'zhiyin-harness.json',
  'backend-config.json',
];

const MIGRATABLE_DIRS = [
  '知音素材库',
  '知音知识库',
  'backend-data',
  'backups',
];

/** 旧版 electron-store 中需要延续的配置键 */
const LEGACY_CONFIG_KEYS = [
  'store-user',
  'zhiyin-custom-llm',
  'zhiyin-model-config',
  'zhiyin-update-url',
  'zhiyin-vault-dir',
];

function copyIfMissing(source: string, target: string): boolean {
  if (fs.existsSync(target) || !fs.existsSync(source))
    return false;
  try {
    fs.cpSync(source, target, { recursive: true, force: false });
    return true;
  }
  catch (error) {
    logger.warn(`[user-data] 迁移失败（跳过）：${source}`, error);
    return false;
  }
}

/** 把旧版配置键合并进当前存储（只补缺，不覆盖现有值） */
function mergeLegacyConfig(legacyDir: string): boolean {
  const configPath = path.join(legacyDir, 'config.json');
  if (!fs.existsSync(configPath))
    return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    let merged = false;
    for (const key of LEGACY_CONFIG_KEYS) {
      if (parsed[key] !== undefined && store.get(key) === undefined) {
        store.set(key, parsed[key]);
        merged = true;
      }
    }
    return merged;
  }
  catch (error) {
    logger.warn('[user-data] 解析旧版配置失败（跳过）:', error);
    return false;
  }
}

export function runUserDataMigration(): void {
  const userData = app.getPath('userData');
  const marker = path.join(userData, MIGRATION_MARKER);
  if (fs.existsSync(marker))
    return;

  const appDataRoot = app.getPath('appData');
  let sourceName = 'none';
  for (const name of LEGACY_DIR_NAMES) {
    const legacyDir = path.join(appDataRoot, name);
    if (path.resolve(legacyDir) === path.resolve(userData) || !fs.existsSync(legacyDir))
      continue;

    let migrated = false;
    for (const file of MIGRATABLE_FILES) {
      if (copyIfMissing(path.join(legacyDir, file), path.join(userData, file)))
        migrated = true;
    }
    for (const dir of MIGRATABLE_DIRS) {
      if (copyIfMissing(path.join(legacyDir, dir), path.join(userData, dir)))
        migrated = true;
    }
    if (mergeLegacyConfig(legacyDir))
      migrated = true;

    if (migrated) {
      sourceName = name;
      logger.log(`[user-data] 已从旧数据目录无缝迁移：${legacyDir} → ${userData}`);
      break;
    }
  }

  try {
    fs.writeFileSync(marker, `from=${sourceName}\n`, 'utf8');
  }
  catch (error) {
    logger.warn('[user-data] 写入迁移标记失败:', error);
  }
}
