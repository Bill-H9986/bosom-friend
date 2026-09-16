// 0 态测试重置：用户主动删除数据后，清空业务数据并保留大模型配置/默认种子。
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const root = join(homedir(), '.bosom-friend', 'bosom-friend')
const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupRoot = join(process.cwd(), 'products', 'bosom-friend', 'qa', 'zero-state-backups', timestamp)
mkdirSync(backupRoot, { recursive: true })

const files = [
  'accounts.json',
  'publish-records.json',
  'metrics.json',
  'draft-generations.json',
  'agent-tasks.json',
  'contents.json',
]

for (const name of files) {
  const source = join(root, name)
  if (existsSync(source))
    copyFileSync(source, join(backupRoot, name))
  writeFileSync(source, '[]', 'utf8')
}

console.log('zero-state reset complete')
console.log('backup:', backupRoot)
